import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Destructive mesh operators. Each takes a mesh plus a selection and edits it
 * in place, returning whatever the caller needs to re-derive selection state.
 *
 * Conventions:
 *  - operators never leave loose vertices behind unless documented;
 *  - existing face indices stay stable where possible, so a face selection
 *    survives the edit;
 *  - every operator calls `mesh.markDirty()` before returning.
 */

export interface BoundaryEdge {
  /** Edge index in the topology at call time. */
  ei: number;
  /** Directed as traversed by `face`'s corner loop. */
  a: number;
  b: number;
  face: number;
}

/** Edges of `faceSet` that have exactly one incident face inside the set. */
export function regionBoundary(mesh: Mesh, faceSet: Set<number>): BoundaryEdge[] {
  const t = mesh.topology();
  const out: BoundaryEdge[] = [];
  for (const f of faceSet) {
    const loop = mesh.faces[f];
    if (!loop) continue;
    for (let i = 0; i < loop.length; i++) {
      const ei = t.faceEdges[f][i];
      if (ei === undefined || ei < 0) continue;
      let inside = 0;
      for (const nf of t.edges[ei].faces) if (faceSet.has(nf)) inside++;
      if (inside === 1) out.push({ ei, a: loop[i], b: loop[(i + 1) % loop.length], face: f });
    }
  }
  return out;
}

/**
 * The face indices in `faces` that actually name a face on this mesh.
 *
 * A selection is a set of integers, and an integer only means something
 * against the mesh it was read from. Most of the time `pruneSelection` keeps
 * the two in step — but it runs *after* an operator, not before, so a
 * selection that outlived its mesh still arrives pointing at faces that are no
 * longer there: a file that stored one, an operator that shrank the mesh, an
 * evaluated mesh standing in for the original, a mesh swapped underneath by
 * undo.
 *
 * Every operator here therefore treats its indices as a request rather than a
 * promise. What exists is worked on; what does not is dropped. The alternative
 * is what these functions used to do, which was read past the end of an array
 * and throw a TypeError from four frames down — a crash rather than a
 * no-op, over a stale number.
 */
export function faceIndices(mesh: Mesh, faces: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const f of faces) {
    if (Number.isInteger(f) && f >= 0 && f < mesh.faces.length) out.add(f);
  }
  return out;
}

/** The vertex indices in `verts` that actually name a vertex on this mesh. */
export function vertIndices(mesh: Mesh, verts: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const v of verts) {
    if (Number.isInteger(v) && v >= 0 && v < mesh.positions.length) out.add(v);
  }
  return out;
}

/** Every vertex touched by the given faces. */
export function facesToVerts(mesh: Mesh, faces: Iterable<number>): Set<number> {
  const s = new Set<number>();
  for (const f of faces) for (const v of mesh.faces[f] ?? []) s.add(v);
  return s;
}

/**
 * A face loop with repeats and unusable indices taken out.
 *
 * Consecutive repeats (including the wrap from last to first) are simply the
 * same corner written twice and are dropped. A vertex that appears twice
 * non-consecutively is a pinch — the loop touches itself — and the larger
 * piece is the face worth keeping; splitting it properly is the caller's job
 * where the caller knows enough to do it, which dissolveFaces now does.
 *
 * Returns null when fewer than three distinct corners remain.
 */
function dedupeLoop(loop: number[], vertexCount: number): number[] | null {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of loop) {
    if (!Number.isInteger(v) || v < 0 || v >= vertexCount) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length >= 3 ? out : null;
}

/**
 * Add one face, refusing the degenerate shapes outright.
 *
 * A face that names the same vertex twice has no well-defined normal: the
 * cross product at the repeat is the zero vector, so lighting, the BVH and
 * every exporter get a direction of NaN or an arbitrary one. It triangulates
 * to slivers of zero area, which then survive every later operator and spread.
 * Nothing visibly breaks at the moment it is created, which is what makes it
 * dangerous — it is found much later, in somebody's export.
 *
 * Cleaning here rather than at each call site is deliberate: this is the one
 * place faces are made, so it is the one place the guarantee can be made to
 * hold for operators that have not been written yet.
 *
 * Returns -1 when nothing usable is left, which callers must treat as "no face
 * was added" rather than as an index.
 */
function pushFace(mesh: Mesh, loop: number[], likeFace: number, uv?: number[] | null): number {
  const clean = dedupeLoop(loop, mesh.positions.length);
  if (clean === null) return -1;
  loop = clean;
  const idx = mesh.faces.length;
  mesh.faces.push(loop);
  mesh.faceMaterial.push(mesh.faceMaterial[likeFace] ?? 0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(likeFace));
  if (uv !== undefined && mesh.faceUV) mesh.setUV(idx, uv);
  return idx;
}

/** Straight-line blend between two corners' coordinates. */
function lerpUV(a: [number, number] | null, b: [number, number] | null, t: number): [number, number] | null {
  if (!a || !b) return null;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function averageUV(list: ([number, number] | null)[]): [number, number] | null {
  let u = 0;
  let v = 0;
  for (const p of list) {
    if (!p) return null;
    u += p[0];
    v += p[1];
  }
  return list.length ? [u / list.length, v / list.length] : null;
}

/** Flatten a corner list into the packed run `setUV` expects. */
function packUV(list: ([number, number] | null)[]): number[] | null {
  const out: number[] = [];
  for (const p of list) {
    if (!p) return null;
    out.push(p[0], p[1]);
  }
  return out;
}

export interface RegionSplitResult {
  /** Original boundary vertex -> its freshly duplicated copy. */
  vertMap: Map<number, number>;
  /** Indices of the side-wall faces created around the region. */
  walls: number[];
  boundary: BoundaryEdge[];
  /** Vertices belonging to the (now detached) region after the split. */
  movedVerts: Set<number>;
}

/**
 * Detach `faceSet` from the rest of the mesh along its boundary, duplicating
 * only the boundary vertices and stitching a ring of quads between the old and
 * new boundary. This is the shared skeleton of extrude and inset — the two
 * differ purely in where the duplicated vertices are then moved.
 */
export function splitRegion(mesh: Mesh, region: Set<number>): RegionSplitResult {
  const faceSet = faceIndices(mesh, region);
  const boundary = regionBoundary(mesh, faceSet);
  // Snapshot the corner lists and coordinates before the region is remapped.
  const originalLoops = new Map<number, number[]>();
  const sourceUV = new Map<number, ([number, number] | null)[]>();
  if (mesh.faceUV) {
    for (const be of boundary) {
      if (originalLoops.has(be.face)) continue;
      const loop = mesh.faces[be.face];
      originalLoops.set(be.face, loop.slice());
      sourceUV.set(be.face, loop.map((_, i) => mesh.uvAt(be.face, i)));
    }
  }
  const vertMap = new Map<number, number>();
  for (const be of boundary) {
    for (const v of [be.a, be.b]) {
      if (!vertMap.has(v)) {
        vertMap.set(v, mesh.positions.length);
        mesh.positions.push(mesh.positions[v].clone());
      }
    }
  }

  for (const f of faceSet) {
    mesh.faces[f] = mesh.faces[f].map((v) => vertMap.get(v) ?? v);
  }

  const walls: number[] = [];
  for (const be of boundary) {
    const a2 = vertMap.get(be.a)!;
    const b2 = vertMap.get(be.b)!;
    // The wall inherits the boundary edge's coordinates on both rows, so a
    // textured extrusion keeps a seamless join at the base rather than
    // sampling whatever happens to be nearest.
    let uv: number[] | null | undefined;
    if (mesh.faceUV) {
      const src = originalLoops.get(be.face) ?? mesh.faces[be.face];
      const ia = src.indexOf(be.a);
      const ib = src.indexOf(be.b);
      const uvA = ia >= 0 ? sourceUV.get(be.face)?.[ia] ?? null : null;
      const uvB = ib >= 0 ? sourceUV.get(be.face)?.[ib] ?? null : null;
      uv = packUV([uvB, uvA, uvA, uvB]);
    }
    // -1 means the loop was degenerate and no face was added. Collecting it
    // would hand the caller an index that names no face, which later shows up
    // as a selection nothing can act on.
    const wall = pushFace(mesh, [b2, a2, be.a, be.b], be.face, uv);
    if (wall >= 0) walls.push(wall);
  }

  mesh.markDirty();
  return { vertMap, walls, boundary, movedVerts: facesToVerts(mesh, faceSet) };
}

export interface ExtrudeResult {
  movedVerts: Set<number>;
  walls: number[];
  normal: Vec3;
}

/** Extrude a region of faces. The region is left in place; move `movedVerts` to finish. */
export function extrudeFaces(mesh: Mesh, faces: Iterable<number>): ExtrudeResult {
  const faceSet = faceIndices(mesh, faces);
  if (faceSet.size === 0) return { movedVerts: new Set(), walls: [], normal: new Vec3(0, 0, 1) };

  const t = mesh.topology();
  const normal = new Vec3();
  for (const f of faceSet) normal.addInPlace(t.faceNormals[f]);
  const n = normal.lengthSq() > 1e-12 ? normal.normalized() : new Vec3(0, 0, 1);

  const res = splitRegion(mesh, faceSet);
  return { movedVerts: res.movedVerts, walls: res.walls, normal: n };
}

/** Extrude selected boundary edges into new quads. Returns the new vertices. */
export function extrudeEdges(mesh: Mesh, edges: Iterable<number>): Set<number> {
  const t = mesh.topology();
  const list = [...edges];
  const vertMap = new Map<number, number>();
  const moved = new Set<number>();
  for (const ei of list) {
    const e = t.edges[ei];
    if (!e) continue;
    for (const v of [e.a, e.b]) {
      if (!vertMap.has(v)) {
        const nv = mesh.positions.length;
        mesh.positions.push(mesh.positions[v].clone());
        vertMap.set(v, nv);
        moved.add(nv);
      }
    }
  }
  for (const ei of list) {
    const e = t.edges[ei];
    if (!e) continue;
    const a2 = vertMap.get(e.a)!;
    const b2 = vertMap.get(e.b)!;
    pushFace(mesh, [e.a, e.b, b2, a2], e.faces[0] ?? 0);
  }
  mesh.markDirty();
  return moved;
}

/**
 * Inset a face region: the region shrinks inward by `thickness` inside its own
 * plane and shifts by `depth` along the region normal, with a ring of new faces
 * filling the gap.
 */
export function insetFaces(
  mesh: Mesh, faces: Iterable<number>, thickness = 0.1, depth = 0,
): { movedVerts: Set<number>; ring: number[] } {
  const faceSet = faceIndices(mesh, faces);
  if (faceSet.size === 0) return { movedVerts: new Set(), ring: [] };

  const before = mesh.topology();
  const regionNormal = new Vec3();
  for (const f of faceSet) regionNormal.addInPlace(before.faceNormals[f]);
  const rn = regionNormal.lengthSq() > 1e-12 ? regionNormal.normalized() : new Vec3(0, 0, 1);

  // Inward direction per boundary vertex, computed before the topology changes:
  // average of the vectors toward the centers of the region faces around it.
  const inward = new Map<number, Vec3>();
  const boundary = regionBoundary(mesh, faceSet);
  const bverts = new Set<number>();
  for (const be of boundary) {
    bverts.add(be.a);
    bverts.add(be.b);
  }
  for (const v of bverts) {
    const dir = new Vec3();
    for (const f of before.vertFaces[v] ?? []) {
      if (!faceSet.has(f)) continue;
      const d = before.faceCenters[f].sub(mesh.positions[v]);
      if (d.lengthSq() > 1e-16) dir.addInPlace(d.normalized());
    }
    const flat = dir.sub(rn.scale(dir.dot(rn)));
    inward.set(v, flat.lengthSq() > 1e-16 ? flat.normalized() : new Vec3());
  }

  const res = splitRegion(mesh, faceSet);
  for (const [old, nv] of res.vertMap) {
    const dir = inward.get(old) ?? new Vec3();
    mesh.positions[nv] = mesh.positions[old].add(dir.scale(thickness)).add(rn.scale(depth));
  }
  // Interior vertices only need the depth offset.
  const boundaryCopies = new Set(res.vertMap.values());
  if (depth !== 0) {
    for (const v of res.movedVerts) {
      if (!boundaryCopies.has(v)) mesh.positions[v] = mesh.positions[v].add(rn.scale(depth));
    }
  }
  mesh.markDirty();
  return { movedVerts: res.movedVerts, ring: res.walls };
}

/** Inset each selected face on its own, without sharing boundaries. */
export function insetFacesIndividual(
  mesh: Mesh, faces: Iterable<number>, thickness = 0.1, depth = 0,
): { movedVerts: Set<number>; ring: number[] } {
  const moved = new Set<number>();
  const ring: number[] = [];
  for (const f of faceIndices(mesh, faces)) {
    const r = insetFaces(mesh, [f], thickness, depth);
    for (const v of r.movedVerts) moved.add(v);
    ring.push(...r.ring);
  }
  return { movedVerts: moved, ring };
}

/** Ring of quads crossed by walking perpendicular to `startEdge`. */
export function edgeRing(
  mesh: Mesh, startEdge: number,
): { edges: number[]; faces: number[]; cyclic: boolean } {
  const t = mesh.topology();
  const start = t.edges[startEdge];
  if (!start) return { edges: [], faces: [], cyclic: false };

  const edges = [startEdge];
  const faces: number[] = [];
  const seenEdge = new Set([startEdge]);
  const seenFace = new Set<number>();
  let cyclic = false;

  for (let dir = 0; dir < Math.min(2, start.faces.length); dir++) {
    let face: number | undefined = start.faces[dir];
    let edge = startEdge;
    while (face !== undefined && !seenFace.has(face) && mesh.faces[face].length === 4) {
      seenFace.add(face);
      faces.push(face);
      const i = t.faceEdges[face].indexOf(edge);
      if (i < 0) break;
      const opp: number = t.faceEdges[face][(i + 2) % 4];
      if (opp === undefined || opp < 0) break;
      if (opp === startEdge) {
        cyclic = true;
        break;
      }
      if (seenEdge.has(opp)) break;
      seenEdge.add(opp);
      if (dir === 0) edges.push(opp);
      else edges.unshift(opp);
      const nextFace: number | undefined = t.edges[opp].faces.find((x) => x !== face);
      edge = opp;
      face = nextFace;
    }
  }
  return { edges, faces, cyclic };
}

/**
 * Insert `cuts` edge loops across the quad ring containing `startEdge`.
 * `offset` in (-1, 1) slides a single cut along the ring, as Ctrl+R does.
 */
export function loopCut(
  mesh: Mesh, startEdge: number, cuts = 1, offset = 0,
): { newVerts: number[] } {
  const n = Math.max(1, Math.floor(cuts));
  const ring = edgeRing(mesh, startEdge);
  if (ring.faces.length === 0) return { newVerts: [] };

  const t = mesh.topology();
  const ringSet = new Set(ring.edges);
  const params: number[] = [];
  for (let k = 0; k < n; k++) {
    let p = (k + 1) / (n + 1);
    if (n === 1) p = 0.5 + 0.5 * Math.max(-0.999, Math.min(0.999, offset));
    params.push(p);
  }

  // Corner lists and coordinates captured before any face is rewritten.
  const ringLoops = new Map<number, number[]>();
  const ringUV = new Map<number, ([number, number] | null)[]>();
  if (mesh.faceUV) {
    for (const f of ring.faces) {
      ringLoops.set(f, mesh.faces[f].slice());
      ringUV.set(f, mesh.faces[f].map((_, i) => mesh.uvAt(f, i)));
    }
  }

  const edgeVerts = new Map<number, number[]>();
  const newVerts: number[] = [];
  for (const ei of ring.edges) {
    const e = t.edges[ei];
    const pa = mesh.positions[e.a];
    const pb = mesh.positions[e.b];
    const list: number[] = [];
    for (const p of params) {
      const idx = mesh.positions.length;
      mesh.positions.push(pa.lerp(pb, p));
      list.push(idx);
      newVerts.push(idx);
    }
    edgeVerts.set(ei, list);
  }

  const cornerVerts = (face: number, corner: number): number[] => {
    const ei = t.faceEdges[face][corner];
    const loop = mesh.faces[face];
    const list = edgeVerts.get(ei)!;
    const forward = loop[corner] === t.edges[ei].a;
    return forward ? list : list.slice().reverse();
  };

  const replaced: { face: number; loops: number[][]; uvs: (number[] | null)[] }[] = [];
  for (const f of ring.faces) {
    const fe = t.faceEdges[f];
    let i = -1;
    for (let k = 0; k < 4; k++) {
      if (ringSet.has(fe[k]) && ringSet.has(fe[(k + 2) % 4])) {
        i = k;
        break;
      }
    }
    if (i < 0) continue;
    const loop = mesh.faces[f];
    const A = [loop[i], ...cornerVerts(f, i), loop[(i + 1) % 4]];
    const C = [loop[(i + 2) % 4], ...cornerVerts(f, (i + 2) % 4), loop[(i + 3) % 4]];
    const loops: number[][] = [];
    for (let k = 0; k <= n; k++) {
      loops.push([A[k], A[k + 1], C[n - k], C[n + 1 - k]]);
    }

    // The cut runs across the face at the same parameters in UV space.
    const uvs: (number[] | null)[] = [];
    const src = ringUV.get(f);
    if (src) {
      const uA0 = src[i];
      const uA1 = src[(i + 1) % 4];
      const uC0 = src[(i + 2) % 4];
      const uC1 = src[(i + 3) % 4];
      const chainA = [uA0, ...params.map((p) => lerpUV(uA0, uA1, p)), uA1];
      const chainC = [uC0, ...params.map((p) => lerpUV(uC0, uC1, p)), uC1];
      for (let k = 0; k <= n; k++) {
        uvs.push(packUV([chainA[k], chainA[k + 1], chainC[n - k], chainC[n + 1 - k]]));
      }
    } else {
      for (let k = 0; k <= n; k++) uvs.push(null);
    }
    replaced.push({ face: f, loops, uvs });
  }

  for (const r of replaced) {
    mesh.faces[r.face] = r.loops[0];
    if (mesh.faceUV) mesh.setUV(r.face, r.uvs[0]);
    for (let k = 1; k < r.loops.length; k++) pushFace(mesh, r.loops[k], r.face, r.uvs[k]);
  }
  mesh.markDirty();
  return { newVerts };
}

/** Linear (non-smoothing) quad subdivision of the given faces. */
export function subdivideFaces(mesh: Mesh, faces: Iterable<number>): { newVerts: number[] } {
  const faceSet = faceIndices(mesh, faces);
  if (faceSet.size === 0) return { newVerts: [] };
  const t = mesh.topology();
  const newVerts: number[] = [];

  const sourceUV = new Map<number, ([number, number] | null)[]>();
  if (mesh.faceUV) {
    for (let f = 0; f < mesh.faces.length; f++) {
      sourceUV.set(f, mesh.faces[f].map((_, i) => mesh.uvAt(f, i)));
    }
  }
  // An edge midpoint has a different coordinate on each side of a seam, so it
  // is resolved per face rather than once per edge.
  const uvAtEdge = (face: number, corner: number, next: number): [number, number] | null => {
    const src = sourceUV.get(face);
    return src ? lerpUV(src[corner], src[next], 0.5) : null;
  };

  const edgePoint = new Map<number, number>();
  const touchedEdges = new Set<number>();
  for (const f of faceSet) for (const ei of t.faceEdges[f]) if (ei >= 0) touchedEdges.add(ei);
  for (const ei of touchedEdges) {
    const e = t.edges[ei];
    const idx = mesh.positions.length;
    mesh.positions.push(mesh.positions[e.a].lerp(mesh.positions[e.b], 0.5));
    edgePoint.set(ei, idx);
    newVerts.push(idx);
  }

  // Faces outside the selection that share a cut edge gain the midpoint as an
  // extra corner, so the mesh stays watertight (an n-gon "trifan" join).
  const outside = new Map<number, number[]>();
  for (const ei of touchedEdges) {
    for (const f of t.edges[ei].faces) {
      if (faceSet.has(f)) continue;
      const arr = outside.get(f) ?? [];
      arr.push(ei);
      outside.set(f, arr);
    }
  }

  const additions: number[][] = [];
  const additionUV: (number[] | null)[] = [];
  for (const f of faceSet) {
    const loop = mesh.faces[f];
    const center = mesh.faceCenter(f);
    const ci = mesh.positions.length;
    mesh.positions.push(center);
    newVerts.push(ci);
    const quads: number[][] = [];
    const quadUV: (number[] | null)[] = [];
    const src = sourceUV.get(f);
    const centreUV = src ? averageUV(src) : null;
    for (let i = 0; i < loop.length; i++) {
      const prevE = t.faceEdges[f][(i - 1 + loop.length) % loop.length];
      const nextE = t.faceEdges[f][i];
      quads.push([loop[i], edgePoint.get(nextE)!, ci, edgePoint.get(prevE)!]);
      quadUV.push(src ? packUV([
        src[i],
        uvAtEdge(f, i, (i + 1) % loop.length),
        centreUV,
        uvAtEdge(f, (i - 1 + loop.length) % loop.length, i),
      ]) : null);
    }
    mesh.faces[f] = quads[0];
    if (mesh.faceUV) mesh.setUV(f, quadUV[0]);
    for (let i = 1; i < quads.length; i++) {
      additions.push(quads[i]);
      additionUV.push(quadUV[i]);
    }
    for (let i = 1; i < quads.length; i++) {
      mesh.faceMaterial.push(mesh.faceMaterial[f] ?? 0);
      if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(f));
    }
  }
  for (let i = 0; i < additions.length; i++) {
    const idx = mesh.faces.length;
    mesh.faces.push(additions[i]);
    if (mesh.faceUV) mesh.setUV(idx, additionUV[i]);
  }

  for (const [f, eis] of outside) {
    const loop = mesh.faces[f];
    const src = sourceUV.get(f);
    const out: number[] = [];
    const outUV: ([number, number] | null)[] = [];
    for (let i = 0; i < loop.length; i++) {
      out.push(loop[i]);
      if (src) outUV.push(src[i]);
      const ei = t.faceEdges[f][i];
      if (eis.includes(ei)) {
        out.push(edgePoint.get(ei)!);
        if (src) outUV.push(uvAtEdge(f, i, (i + 1) % loop.length));
      }
    }
    mesh.faces[f] = out;
    if (mesh.faceUV) mesh.setUV(f, src ? packUV(outUV) : null);
  }

  mesh.markDirty();
  return { newVerts };
}

/** Catmull-Clark subdivision of the whole mesh (used by the Subsurf modifier). */
export function catmullClark(mesh: Mesh, levels = 1): Mesh {
  // Each level multiplies the mesh by four, so a file claiming a hundred
  // levels is a hang, not a model.
  const passes = Number.isFinite(levels) ? Math.max(0, Math.min(6, Math.floor(levels))) : 1;
  let cur = mesh;
  for (let l = 0; l < passes; l++) cur = catmullClarkOnce(cur);
  return cur;
}

function catmullClarkOnce(mesh: Mesh): Mesh {
  const t = mesh.topology();
  const nv = mesh.positions.length;
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const faceMaterial: number[] = [];
  const faceSmooth: boolean[] | null = mesh.faceSmooth ? [] : null;

  // Face points.
  const facePoint: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    facePoint.push(positions.length);
    positions.push(t.faceCenters[f].clone());
  }

  // Edge points.
  const edgePoint: number[] = [];
  for (let e = 0; e < t.edges.length; e++) {
    const rec = t.edges[e];
    const p = mesh.positions[rec.a].add(mesh.positions[rec.b]);
    if (rec.faces.length === 2) {
      const q = t.faceCenters[rec.faces[0]].add(t.faceCenters[rec.faces[1]]);
      positions.push(p.add(q).scale(0.25));
    } else {
      positions.push(p.scale(0.5));
    }
    edgePoint.push(positions.length - 1);
  }

  // Vertex points.
  const vertPoint: number[] = [];
  for (let v = 0; v < nv; v++) {
    const incidentF = t.vertFaces[v] ?? [];
    const incidentE = t.vertEdges[v] ?? [];
    const boundaryEdges = incidentE.filter((e) => t.edges[e].faces.length === 1);
    const P = mesh.positions[v];
    let np: Vec3;
    if (incidentF.length === 0) {
      np = P.clone();
    } else if (boundaryEdges.length >= 2) {
      // Cubic B-spline crease rule along the boundary.
      const m = new Vec3();
      let count = 0;
      for (const e of boundaryEdges) {
        const rec = t.edges[e];
        m.addInPlace(mesh.positions[rec.a === v ? rec.b : rec.a]);
        count++;
      }
      np = count > 0 ? P.scale(6).add(m).scale(1 / (6 + count)) : P.clone();
    } else {
      const n = incidentF.length;
      const F = new Vec3();
      for (const f of incidentF) F.addInPlace(t.faceCenters[f]);
      F.scaleInPlace(1 / n);
      const R = new Vec3();
      for (const e of incidentE) R.addInPlace(mesh.edgeCenter(e));
      R.scaleInPlace(1 / Math.max(1, incidentE.length));
      np = F.add(R.scale(2)).add(P.scale(n - 3)).scale(1 / n);
    }
    vertPoint.push(positions.length);
    positions.push(np);
  }

  // Coordinates subdivide linearly per face, which keeps seams put: a vertex
  // shared across a seam has a different coordinate in each face, and reading
  // them per face rather than per vertex is what preserves that.
  const carryUV = mesh.hasUV;
  const faceUV: (number[] | null)[] = [];

  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    const src = carryUV ? loop.map((_, i) => mesh.uvAt(f, i)) : null;
    const centre = src ? averageUV(src) : null;
    for (let i = 0; i < loop.length; i++) {
      const prevE = t.faceEdges[f][(i - 1 + loop.length) % loop.length];
      const nextE = t.faceEdges[f][i];
      if (prevE < 0 || nextE < 0) continue;
      faces.push([vertPoint[loop[i]], edgePoint[nextE], facePoint[f], edgePoint[prevE]]);
      faceMaterial.push(mesh.faceMaterial[f] ?? 0);
      if (faceSmooth) faceSmooth.push(mesh.isFaceSmooth(f));
      if (src) {
        const prev = (i - 1 + loop.length) % loop.length;
        const next = (i + 1) % loop.length;
        faceUV.push(packUV([
          src[i], lerpUV(src[i], src[next], 0.5), centre, lerpUV(src[prev], src[i], 0.5),
        ]));
      } else if (carryUV) {
        faceUV.push(null);
      }
    }
  }

  const out = new Mesh(positions, faces, faceMaterial);
  out.shadeSmooth = mesh.shadeSmooth;
  out.faceSmooth = faceSmooth;
  if (carryUV) out.faceUV = faceUV;
  if (mesh.seams) out.seams = new Set(mesh.seams);
  out.removeLooseVertices();
  return out;
}

/** Weld vertices closer than `dist`. Returns how many were removed. */
export function mergeByDistance(mesh: Mesh, verts: Iterable<number> | null, dist = 0.0001): number {
  const candidates = verts ? vertIndices(mesh, verts) : new Set(mesh.positions.map((_, i) => i));
  const cell = Math.max(dist, 1e-9);
  const buckets = new Map<string, number[]>();
  const remap = new Array<number>(mesh.positions.length).fill(-1);
  const key = (p: Vec3) =>
    `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;

  for (const v of candidates) {
    const p = mesh.positions[v];
    let target = -1;
    const bx = Math.floor(p.x / cell);
    const by = Math.floor(p.y / cell);
    const bz = Math.floor(p.z / cell);
    outer: for (let dx = -1; dx <= 1 && target < 0; dx++) {
      for (let dy = -1; dy <= 1 && target < 0; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${bx + dx},${by + dy},${bz + dz}`);
          if (!list) continue;
          for (const o of list) {
            if (mesh.positions[o].distanceTo(p) <= dist) {
              target = o;
              break outer;
            }
          }
        }
      }
    }
    if (target >= 0) {
      remap[v] = target;
    } else {
      const k = key(p);
      const list = buckets.get(k) ?? [];
      list.push(v);
      buckets.set(k, list);
    }
  }

  let removed = 0;
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) removed++;
  if (removed === 0) return 0;

  mesh.faces = mesh.faces.map((f) => f.map((v) => (remap[v] >= 0 ? remap[v] : v)));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  return removed;
}

/** Collapse the given vertices to a single point (Merge at Center). */
export function mergeVertices(mesh: Mesh, verts: Iterable<number>, at?: Vec3): number {
  const list = [...vertIndices(mesh, verts)];
  if (list.length < 2) return 0;
  const center = at ?? list
    .reduce((acc, v) => acc.addInPlace(mesh.positions[v]), new Vec3())
    .scale(1 / list.length);
  const keep = list[0];
  mesh.positions[keep] = center;
  const remap = new Map<number, number>();
  for (const v of list) remap.set(v, keep);
  mesh.faces = mesh.faces.map((f) => f.map((v) => remap.get(v) ?? v));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  return list.length - 1;
}

export function deleteFaces(mesh: Mesh, faces: Iterable<number>, keepVerts = false): void {
  const drop = faceIndices(mesh, faces);
  const kept: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    if (drop.has(f)) continue;
    kept.push(mesh.faces[f]);
    mats.push(mesh.faceMaterial[f] ?? 0);
    smooth.push(mesh.isFaceSmooth(f));
  }
  mesh.faces = kept;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  mesh.markDirty();
  if (!keepVerts) mesh.removeLooseVertices();
}

export function deleteVertices(mesh: Mesh, verts: Iterable<number>): void {
  const drop = vertIndices(mesh, verts);
  const doomed: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    if (mesh.faces[f].some((v) => drop.has(v))) doomed.push(f);
  }
  deleteFaces(mesh, doomed, true);
  const map = new Array<number>(mesh.positions.length).fill(-1);
  const positions: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    if (drop.has(i)) continue;
    map[i] = positions.length;
    positions.push(mesh.positions[i]);
  }
  mesh.positions = positions;
  mesh.faces = mesh.faces.map((f) => f.map((v) => map[v]).filter((v) => v >= 0));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
}

export function deleteEdges(mesh: Mesh, edges: Iterable<number>): void {
  const t = mesh.topology();
  const doomed = new Set<number>();
  for (const ei of edges) for (const f of t.edges[ei]?.faces ?? []) doomed.add(f);
  deleteFaces(mesh, doomed);
}

/** Merge a connected face region into a single n-gon (Dissolve Faces). */
export function dissolveFaces(mesh: Mesh, faces: Iterable<number>): number[] {
  const faceSet = faceIndices(mesh, faces);
  if (faceSet.size < 2) return [...faceSet];
  const boundary = regionBoundary(mesh, faceSet);
  if (boundary.length < 3) return [...faceSet];

  // Chain the directed boundary edges into loops.
  const nextOf = new Map<number, number[]>();
  for (const be of boundary) {
    const arr = nextOf.get(be.a) ?? [];
    arr.push(be.b);
    nextOf.set(be.a, arr);
  }
  const created: number[] = [];
  const used = new Set<string>();
  const template = [...faceSet][0];
  const emit = (ring: number[]): void => {
    if (ring.length < 3) return;
    const f = pushFace(mesh, ring, template);
    if (f >= 0) created.push(f);
  };
  for (const be of boundary) {
    if (used.has(`${be.a}>${be.b}`)) continue;
    const loop: number[] = [be.a];
    // Where each vertex sits in the loop so far, so a revisit is recognised
    // the moment it happens rather than discovered in the finished face.
    const at = new Map<number, number>([[be.a, 0]]);
    let cur = be.b;
    let guard = 0;
    used.add(`${be.a}>${be.b}`);
    while (cur !== be.a && guard++ < boundary.length + 2) {
      // The boundary of a dissolved region is not always a simple ring. Where
      // the region touches itself — a bridge one face wide, a hole that meets
      // the outer edge — the walk arrives back at a vertex it has already
      // passed through. Writing that vertex into the loop a second time made
      // a face that names a corner twice: no usable normal, zero-area slivers
      // after triangulation, and nothing wrong on screen until it turns up in
      // an export. It is also not what the geometry means. A figure-eight
      // boundary is two faces meeting at a point, so the closed piece is cut
      // off and kept as its own face, and the walk carries on with the rest.
      const seenAt = at.get(cur);
      if (seenAt !== undefined) {
        emit(loop.slice(seenAt));
        for (let i = seenAt; i < loop.length; i++) at.delete(loop[i]);
        loop.length = seenAt;
      }
      at.set(cur, loop.length);
      loop.push(cur);
      const outs = nextOf.get(cur);
      if (!outs || outs.length === 0) break;
      const nxt = outs.find((n) => !used.has(`${cur}>${n}`));
      if (nxt === undefined) break;
      used.add(`${cur}>${nxt}`);
      cur = nxt;
    }
    if (cur === be.a) emit(loop);
  }
  if (created.length === 0) return [...faceSet];
  deleteFaces(mesh, faceSet);
  mesh.markDirty();
  return created;
}

/** Build one n-gon (or a quad from two edges' worth of verts) from a vertex set. */
export function makeFace(mesh: Mesh, corners: number[]): number | null {
  // Ordering matters here, so the corners are filtered in place rather than
  // routed through the Set that `vertIndices` returns.
  const seen = new Set<number>();
  const verts = corners.filter((v) => {
    if (!Number.isInteger(v) || v < 0 || v >= mesh.positions.length || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  if (verts.length < 3) return null;
  const t = mesh.topology();
  // Order the vertices by walking existing edges when possible, else by angle.
  const set = new Set(verts);
  const ordered: number[] = [];
  const visited = new Set<number>();
  let cur = verts[0];
  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    ordered.push(cur);
    let nxt: number | undefined;
    for (const ei of t.vertEdges[cur] ?? []) {
      const e = t.edges[ei];
      const other = e.a === cur ? e.b : e.a;
      if (set.has(other) && !visited.has(other)) {
        nxt = other;
        break;
      }
    }
    cur = nxt as number;
  }
  if (ordered.length !== verts.length) {
    const center = verts
      .reduce((acc, v) => acc.addInPlace(mesh.positions[v]), new Vec3())
      .scale(1 / verts.length);
    let normal = new Vec3();
    for (let i = 0; i < verts.length; i++) {
      const p = mesh.positions[verts[i]].sub(center);
      const q = mesh.positions[verts[(i + 1) % verts.length]].sub(center);
      normal.addInPlace(p.cross(q));
    }
    if (normal.lengthSq() < 1e-16) normal = new Vec3(0, 0, 1);
    const u = normal.normalized().perpendicular();
    const v = normal.normalized().cross(u);
    ordered.length = 0;
    ordered.push(
      ...[...verts].sort((x, y) => {
        const px = mesh.positions[x].sub(center);
        const py = mesh.positions[y].sub(center);
        return Math.atan2(px.dot(v), px.dot(u)) - Math.atan2(py.dot(v), py.dot(u));
      }),
    );
  }
  const idx = mesh.faces.length;
  mesh.faces.push(ordered);
  mesh.faceMaterial.push(0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.shadeSmooth);
  mesh.markDirty();
  return idx;
}

export function flipNormals(mesh: Mesh, faces?: Iterable<number>): void {
  // Reversing the corner order has to reverse the coordinates with it.
  if (mesh.faceUV) {
    const list = faces ? [...faceIndices(mesh, faces)] : mesh.faces.map((_, f) => f);
    for (const f of list) {
      const uv = mesh.uvFor(f);
      if (!uv) continue;
      const pairs: [number, number][] = [];
      for (let i = 0; i < uv.length; i += 2) pairs.push([uv[i], uv[i + 1]]);
      pairs.reverse();
      mesh.setUV(f, packUV(pairs));
    }
  }
  const set = faces ? new Set(faces) : null;
  for (let f = 0; f < mesh.faces.length; f++) {
    if (!set || set.has(f)) mesh.faces[f] = mesh.faces[f].slice().reverse();
  }
  mesh.markDirty();
}

/** Make winding consistent across shells, then orient each shell outward. */
export function recalculateNormals(mesh: Mesh, inside = false): void {
  const t = mesh.topology();
  const visited = new Uint8Array(mesh.faces.length);
  const shells: number[][] = [];

  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (visited[seed]) continue;
    const shell: number[] = [];
    const stack = [seed];
    visited[seed] = 1;
    while (stack.length) {
      const f = stack.pop()!;
      shell.push(f);
      const loop = mesh.faces[f];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        // Look the edge up by its vertex pair rather than by corner position:
        // this face may already have been reversed, which permutes its corners
        // but not the cached topology.
        const ei = t.edgeIndex.get(mesh.edgeKey(a, b));
        if (ei === undefined) continue;
        for (const nf of t.edges[ei].faces) {
          if (nf === f || visited[nf]) continue;
          const nloop = mesh.faces[nf];
          const j = nloop.indexOf(a);
          // Consistent neighbours traverse the shared edge in the opposite order.
          const sameDir = j >= 0 && nloop[(j + 1) % nloop.length] === b;
          if (sameDir) mesh.faces[nf] = nloop.slice().reverse();
          visited[nf] = 1;
          stack.push(nf);
        }
      }
    }
    shells.push(shell);
  }

  for (const shell of shells) {
    let vol = 0;
    for (const f of shell) {
      const loop = mesh.faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        const a = mesh.positions[loop[0]];
        const b = mesh.positions[loop[i]];
        const c = mesh.positions[loop[i + 1]];
        vol += a.dot(b.cross(c)) / 6;
      }
    }
    const wantFlip = inside ? vol > 0 : vol < 0;
    if (wantFlip) for (const f of shell) mesh.faces[f] = mesh.faces[f].slice().reverse();
  }
  mesh.markDirty();
}

/** Laplacian smoothing of the given vertices (or all of them). */
export function smoothVertices(mesh: Mesh, verts: Iterable<number> | null, factor = 0.5, iterations = 1): void {
  // Smoothing means somewhere between leaving a vertex alone and moving it
  // onto the average of its neighbours. Values outside that are extrapolation
  // — moving it AWAY, past the average — and the error compounds every
  // iteration: a factor of 1e7 put a vertex at 1.6e13 within a few passes,
  // which poisons the bounds, the normals and the BVH of the whole mesh.
  //
  // Clamped rather than refused, because every route in has a different idea
  // of how to complain: a slider that has been dragged, a number typed into a
  // field, a value read out of a file somebody else wrote, a generated
  // program. A smooth that does nothing is recoverable; a mesh at 1e13 is not.
  const strength = Number.isFinite(factor) ? Math.min(1, Math.max(0, factor)) : 0;
  const passes = Number.isFinite(iterations) ? Math.min(64, Math.max(0, Math.floor(iterations))) : 1;
  const t0 = mesh.topology();
  const set = verts ? vertIndices(mesh, verts) : new Set(mesh.positions.map((_, i) => i));
  for (let it = 0; it < passes; it++) {
    const t = it === 0 ? t0 : mesh.topology();
    const next = mesh.positions.map((p) => p.clone());
    for (const v of set) {
      const nb = t.vertEdges[v] ?? [];
      if (nb.length === 0) continue;
      const avg = new Vec3();
      for (const ei of nb) {
        const e = t.edges[ei];
        avg.addInPlace(mesh.positions[e.a === v ? e.b : e.a]);
      }
      avg.scaleInPlace(1 / nb.length);
      next[v] = mesh.positions[v].lerp(avg, strength);
    }
    mesh.positions = next;
    mesh.markDirty();
  }
}

export function triangulateFaces(mesh: Mesh, faces?: Iterable<number>): void {
  const set = faces ? faceIndices(mesh, faces) : null;
  const out: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  const uvs: (number[] | null)[] = [];
  const carryUV = !!mesh.faceUV;
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    const src = carryUV ? loop.map((_, i) => mesh.uvAt(f, i)) : null;
    if ((set && !set.has(f)) || loop.length <= 3) {
      out.push(loop);
      mats.push(mesh.faceMaterial[f] ?? 0);
      smooth.push(mesh.isFaceSmooth(f));
      if (carryUV) uvs.push(src ? packUV(src) : null);
      continue;
    }
    // The fan matches Mesh.triangulate, so a triangle's coordinates are just
    // the same three corners.
    for (let i = 1; i + 1 < loop.length; i++) {
      out.push([loop[0], loop[i], loop[i + 1]]);
      mats.push(mesh.faceMaterial[f] ?? 0);
      smooth.push(mesh.isFaceSmooth(f));
      if (carryUV) uvs.push(src ? packUV([src[0], src[i], src[i + 1]]) : null);
    }
  }
  mesh.faces = out;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  if (carryUV) mesh.faceUV = uvs;
  mesh.markDirty();
}

/** Duplicate a face region into disconnected geometry. Returns the new faces and verts. */
export function duplicateFaces(
  mesh: Mesh, faces: Iterable<number>,
): { faces: number[]; verts: Set<number> } {
  const faceSet = [...faceIndices(mesh, faces)];
  const map = new Map<number, number>();
  const verts = new Set<number>();
  for (const f of faceSet) {
    for (const v of mesh.faces[f]) {
      if (!map.has(v)) {
        map.set(v, mesh.positions.length);
        verts.add(mesh.positions.length);
        mesh.positions.push(mesh.positions[v].clone());
      }
    }
  }
  const newFaces: number[] = [];
  for (const f of faceSet) {
    const uv = mesh.uvFor(f);
    const copy = pushFace(mesh, mesh.faces[f].map((v) => map.get(v)!), f, uv ? uv.slice() : null);
    if (copy >= 0) newFaces.push(copy);
  }
  mesh.markDirty();
  return { faces: newFaces, verts };
}

/** Move a set of vertices by a delta. */
export function translateVerts(mesh: Mesh, verts: Iterable<number>, delta: Vec3): void {
  for (const v of vertIndices(mesh, verts)) mesh.positions[v] = mesh.positions[v].add(delta);
  mesh.markDirty();
}
