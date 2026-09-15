import { AABB, Mat4, Vec3 } from '../core/math';
import type { SkinData } from './skin';

/**
 * The Culp Mixer's mesh kernel.
 *
 * Master data is an n-gon polygon soup (`positions` + `faces`), which keeps
 * serialization, import/export and undo snapshots trivial. Adjacency
 * (`Topology`) is derived on demand and cached against a revision counter, so
 * operators get half-edge-quality queries without paying to maintain a
 * half-edge structure through every edit.
 */

/** An undirected edge and the faces that use it. */
export interface EdgeRec {
  a: number;
  b: number;
  /** Indices of incident faces: 1 = boundary, 2 = manifold, >2 = non-manifold. */
  faces: number[];
}

export interface Topology {
  edges: EdgeRec[];
  /** edgeOfVertPair(a, b) -> edge index */
  edgeIndex: Map<number, number>;
  /** Per face, the edge index for corner i (the edge from corner i to i+1). */
  faceEdges: number[][];
  vertEdges: number[][];
  vertFaces: number[][];
  faceNormals: Vec3[];
  /**
   * Vertex normals for shading, which is not the same job as `vertNormals`.
   *
   * A face marked flat shades itself from its own normal, and — this is the
   * part that was missing — it must not drag its neighbours' smooth normals
   * around either. That is what "flat" means in every modelling application:
   * the face leaves the smoothing group.
   *
   * It showed up on models built from photographs. Those close over into a
   * thin lip at the silhouette, and the lip's faces stand perpendicular to the
   * surface they join. Averaged in, they swung the surface's own normals by up
   * to 43 degrees at the points where the outline steps in by a grid cell —
   * which drew a row of hard creases across the model, visible at a glancing
   * angle, on geometry that measured perfectly smooth.
   *
   * `vertNormals` stays as it was: bevel, sculpt, solidify and the ray tracer
   * want the geometric average over everything, and a wholly flat-shaded mesh
   * would otherwise have no vertex normals at all.
   */
  shadingNormals: Vec3[];
  faceCenters: Vec3[];
  vertNormals: Vec3[];
}

/**
 * Cut a loop that revisits a vertex into the simple loops it is made of.
 *
 * Walking the loop while remembering where each vertex was last seen: coming
 * back to one closes off everything since, which is lifted out as its own
 * loop. What is left continues. A loop with no repeats comes back untouched
 * and pays only for the walk.
 */
function splitPinchedLoop(
  loop: number[], uv: number[] | null,
): { loop: number[]; uv: number[] | null }[] {
  let repeated = false;
  const seenOnce = new Set<number>();
  for (const v of loop) {
    if (seenOnce.has(v)) { repeated = true; break; }
    seenOnce.add(v);
  }
  if (!repeated) return [{ loop, uv }];

  const out: { loop: number[]; uv: number[] | null }[] = [];
  const stack: number[] = [];
  const stackUV: number[] = [];
  const where = new Map<number, number>();
  for (let i = 0; i < loop.length; i++) {
    const v = loop[i];
    const seen = where.get(v);
    if (seen !== undefined) {
      // Everything since the earlier visit closes into its own loop — with the
      // repeated vertex itself at the head of it, because the pinch point
      // belongs to both halves. Leaving it out turns a triangle into an edge.
      const tail = stack.splice(seen + 1);
      const tailUV = uv ? stackUV.splice((seen + 1) * 2) : null;
      for (const gone of tail) where.delete(gone);
      const piece = [stack[seen], ...tail];
      const pieceUV = uv && tailUV
        ? [stackUV[seen * 2], stackUV[seen * 2 + 1], ...tailUV]
        : null;
      if (piece.length >= 3) out.push({ loop: piece, uv: pieceUV });
      continue;
    }
    where.set(v, stack.length);
    stack.push(v);
    if (uv) stackUV.push(uv[i * 2], uv[i * 2 + 1]);
  }
  if (stack.length >= 3) out.push({ loop: stack, uv: uv ? stackUV : null });
  return out;
}

/** Serial number for mesh identity; see `Mesh.id`. */
let meshCounter = 0;
function nextMeshId(): number {
  return ++meshCounter;
}

export class Mesh {
  positions: Vec3[];
  /** Polygon corner lists, CCW when viewed from the front face. */
  faces: number[][];
  /** Material slot index per face. */
  faceMaterial: number[];
  /** Per-object smooth shading flag; per-face override lives in `faceSmooth`. */
  shadeSmooth = false;
  faceSmooth: boolean[] | null = null;
  /**
   * Texture coordinates, stored per face corner as a flat [u0,v0,u1,v1,…] run.
   * A face with no coordinates holds null. Corner storage rather than per
   * vertex is what lets a seam carry two different UVs at the same point.
   */
  faceUV: (number[] | null)[] | null = null;
  /**
   * UV seams, keyed by vertex pair. Unwrapping cuts the surface along these.
   * Keyed by index pair rather than edge index because edge indices are
   * derived and renumber on every topology change.
   */
  seams: Set<string> | null = null;
  /**
   * Per-edge bevel weight in 0..1, keyed the same way as seams. A bevel
   * multiplies its width by this, so one operation can round a model's hard
   * corners heavily and its softer ones barely. Absent means 1.
   */
  edgeWeights: Map<string, number> | null = null;
  /**
   * Per-vertex sculpt mask, 0..1. A masked vertex is held in place, which is
   * how you sculpt a face without dragging the ear along with it. Null means
   * nothing is masked.
   */
  mask: Float32Array | null = null;
  /**
   * Bone weights, when this mesh is bound to an armature. Stored here rather
   * than on the rig because they belong to the geometry: subdividing has to
   * carry them, and swapping the rig should not throw them away.
   */
  skin: SkinData | null = null;
  /**
   * Per-vertex linear RGB, three floats each. Painted directly on the model
   * and multiplied into the material's base colour, which is the quickest way
   * to get colour onto something without unwrapping it first.
   */
  colors: Float32Array | null = null;

  private _topology: Topology | null = null;
  private _revision = 0;
  private readonly _id = nextMeshId();

  constructor(positions: Vec3[] = [], faces: number[][] = [], faceMaterial?: number[]) {
    this.positions = positions;
    this.faces = faces;
    this.faceMaterial = faceMaterial ?? new Array(faces.length).fill(0);
  }

  /**
   * Identity of this mesh object, distinct from every other one ever made.
   *
   * `revision` says whether *this* mesh has been edited, which is the right
   * question for a mesh being modelled in place — but it says nothing about
   * two different meshes. Every evaluated result comes back as a fresh Mesh at
   * revision 1, so a cache keyed on revision alone cannot tell the rest pose
   * from the posed one, or a boolean from the same boolean after its cutter
   * moved: it hands back the buffer it already had, and the viewport quietly
   * keeps showing geometry that is no longer there. Pairing this with the
   * revision answers both questions.
   */
  get id(): number {
    return this._id;
  }

  get revision(): number {
    return this._revision;
  }

  get vertCount(): number {
    return this.positions.length;
  }

  get faceCount(): number {
    return this.faces.length;
  }

  get edgeCount(): number {
    return this.topology().edges.length;
  }

  get triCount(): number {
    let n = 0;
    for (const f of this.faces) n += Math.max(0, f.length - 2);
    return n;
  }

  /** Invalidate derived adjacency. Call after any structural or positional edit. */
  markDirty(): void {
    this._topology = null;
    this._revision++;
    if (this.faceUV) {
      // Operators append and trim faces freely; keep the parallel array the
      // same length so indices never drift, and drop coordinates for any face
      // whose corner count no longer matches.
      while (this.faceUV.length < this.faces.length) this.faceUV.push(null);
      if (this.faceUV.length > this.faces.length) this.faceUV.length = this.faces.length;
      for (let f = 0; f < this.faces.length; f++) {
        const uv = this.faceUV[f];
        if (uv && uv.length !== this.faces[f].length * 2) this.faceUV[f] = null;
      }
    }
  }

  get hasUV(): boolean {
    if (!this.faceUV) return false;
    for (const uv of this.faceUV) if (uv) return true;
    return false;
  }

  /** Corner coordinates for a face, or null when it has none. */
  uvFor(f: number): number[] | null {
    const uv = this.faceUV?.[f];
    return uv && uv.length === this.faces[f].length * 2 ? uv : null;
  }

  setUV(f: number, uv: number[] | null): void {
    if (!this.faceUV) {
      if (uv === null) return;
      this.faceUV = new Array(this.faces.length).fill(null);
    }
    while (this.faceUV.length <= f) this.faceUV.push(null);
    this.faceUV[f] = uv;
  }

  /** Coordinates at one corner of a face, or null when it has none. */
  uvAt(f: number, corner: number): [number, number] | null {
    const uv = this.uvFor(f);
    return uv ? [uv[corner * 2], uv[corner * 2 + 1]] : null;
  }

  clearUV(): void {
    this.faceUV = null;
    this.markDirty();
  }

  /** Sculpt mask at a vertex; 0 when nothing has been masked. */
  maskAt(v: number): number {
    return this.mask && v < this.mask.length ? this.mask[v] : 0;
  }

  /** Vertex colour at a vertex; white when the mesh has none. */
  colorAt(v: number): [number, number, number] {
    if (!this.colors || v * 3 + 2 >= this.colors.length) return [1, 1, 1];
    return [this.colors[v * 3], this.colors[v * 3 + 1], this.colors[v * 3 + 2]];
  }

  /** The colour array, grown to the current vertex count. New vertices are white. */
  ensureColors(): Float32Array {
    if (!this.colors || this.colors.length !== this.positions.length * 3) {
      const next = new Float32Array(this.positions.length * 3).fill(1);
      if (this.colors) next.set(this.colors.subarray(0, Math.min(this.colors.length, next.length)));
      this.colors = next;
    }
    return this.colors;
  }

  /** The mask array, grown to the current vertex count and created if absent. */
  ensureMask(): Float32Array {
    if (!this.mask || this.mask.length !== this.positions.length) {
      const next = new Float32Array(this.positions.length);
      if (this.mask) next.set(this.mask.subarray(0, Math.min(this.mask.length, next.length)));
      this.mask = next;
    }
    return this.mask;
  }

  static seamKey(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  isSeam(a: number, b: number): boolean {
    return this.seams ? this.seams.has(Mesh.seamKey(a, b)) : false;
  }

  /** Bevel weight for an edge; 1 when none has been set. */
  bevelWeight(a: number, b: number): number {
    if (!this.edgeWeights) return 1;
    return this.edgeWeights.get(Mesh.seamKey(a, b)) ?? 1;
  }

  setBevelWeight(a: number, b: number, w: number): void {
    const k = Mesh.seamKey(a, b);
    if (w >= 1) {
      this.edgeWeights?.delete(k);
      return;
    }
    if (!this.edgeWeights) this.edgeWeights = new Map();
    this.edgeWeights.set(k, Math.max(0, w));
  }

  setSeam(a: number, b: number, on: boolean): void {
    if (!this.seams) {
      if (!on) return;
      this.seams = new Set();
    }
    const k = Mesh.seamKey(a, b);
    if (on) this.seams.add(k);
    else this.seams.delete(k);
  }

  clone(): Mesh {
    const m = new Mesh(
      this.positions.map((p) => p.clone()),
      this.faces.map((f) => f.slice()),
      this.faceMaterial.slice(),
    );
    m.shadeSmooth = this.shadeSmooth;
    m.faceSmooth = this.faceSmooth ? this.faceSmooth.slice() : null;
    m.faceUV = this.faceUV ? this.faceUV.map((u) => (u ? u.slice() : null)) : null;
    m.seams = this.seams ? new Set(this.seams) : null;
    m.edgeWeights = this.edgeWeights ? new Map(this.edgeWeights) : null;
    m.mask = this.mask ? this.mask.slice() : null;
    m.skin = this.skin ? { bones: this.skin.bones.slice(), weights: this.skin.weights.slice() } : null;
    m.colors = this.colors ? this.colors.slice() : null;
    return m;
  }

  isFaceSmooth(f: number): boolean {
    return this.faceSmooth ? this.faceSmooth[f] : this.shadeSmooth;
  }

  setAllSmooth(smooth: boolean): void {
    this.shadeSmooth = smooth;
    this.faceSmooth = null;
    this.markDirty();
  }

  transform(m: Mat4): void {
    for (let i = 0; i < this.positions.length; i++) {
      this.positions[i] = m.transformPoint(this.positions[i]);
    }
    this.markDirty();
  }

  bounds(): AABB {
    const b = new AABB();
    for (const p of this.positions) b.expand(p);
    return b;
  }

  centroid(): Vec3 {
    if (this.positions.length === 0) return new Vec3();
    const c = new Vec3();
    for (const p of this.positions) c.addInPlace(p);
    return c.scale(1 / this.positions.length);
  }

  /** Newell's method — correct for non-planar n-gons. */
  faceNormal(f: number): Vec3 {
    const loop = this.faces[f];
    const n = new Vec3();
    for (let i = 0; i < loop.length; i++) {
      const cur = this.positions[loop[i]];
      const nxt = this.positions[loop[(i + 1) % loop.length]];
      n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    return n.normalized();
  }

  faceCenter(f: number): Vec3 {
    const loop = this.faces[f];
    const c = new Vec3();
    for (const v of loop) c.addInPlace(this.positions[v]);
    return loop.length ? c.scale(1 / loop.length) : c;
  }

  faceArea(f: number): number {
    const loop = this.faces[f];
    if (loop.length < 3) return 0;
    const a = new Vec3();
    for (let i = 0; i < loop.length; i++) {
      const cur = this.positions[loop[i]];
      const nxt = this.positions[loop[(i + 1) % loop.length]];
      a.addInPlace(cur.cross(nxt));
    }
    return a.length() * 0.5;
  }

  edgeKey(a: number, b: number): number {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return lo * (this.positions.length + 1) + hi;
  }

  topology(): Topology {
    if (this._topology) return this._topology;

    const nv = this.positions.length;
    const edges: EdgeRec[] = [];
    const edgeIndex = new Map<number, number>();
    const faceEdges: number[][] = [];
    const vertEdges: number[][] = Array.from({ length: nv }, () => []);
    const vertFaces: number[][] = Array.from({ length: nv }, () => []);

    for (let f = 0; f < this.faces.length; f++) {
      const loop = this.faces[f];
      const fe: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (a === b) {
          fe.push(-1);
          continue;
        }
        const key = this.edgeKey(a, b);
        let ei = edgeIndex.get(key);
        if (ei === undefined) {
          ei = edges.length;
          edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
          edgeIndex.set(key, ei);
          vertEdges[a].push(ei);
          vertEdges[b].push(ei);
        }
        edges[ei].faces.push(f);
        fe.push(ei);
      }
      faceEdges.push(fe);
      for (const v of loop) if (!vertFaces[v].includes(f)) vertFaces[v].push(f);
    }

    const faceNormals: Vec3[] = [];
    const faceCenters: Vec3[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      faceNormals.push(this.faceNormal(f));
      faceCenters.push(this.faceCenter(f));
    }

    // Area-weighted vertex normals.
    const vertNormals: Vec3[] = Array.from({ length: nv }, () => new Vec3());
    const shadingNormals: Vec3[] = Array.from({ length: nv }, () => new Vec3());
    for (let f = 0; f < this.faces.length; f++) {
      const w = this.faceArea(f);
      const n = faceNormals[f].scale(w > 0 ? w : 1e-6);
      const smooth = this.isFaceSmooth(f);
      for (const v of this.faces[f]) {
        vertNormals[v].addInPlace(n);
        if (smooth) shadingNormals[v].addInPlace(n);
      }
    }
    for (let i = 0; i < nv; i++) {
      const l = vertNormals[i].length();
      vertNormals[i] = l > 1e-9 ? vertNormals[i].scale(1 / l) : new Vec3(0, 0, 1);
      const sl = shadingNormals[i].length();
      // A vertex with no smooth face around it never has its shading normal
      // read — every face touching it draws with its own — but falling back
      // keeps the array meaningful for anything that asks anyway.
      shadingNormals[i] = sl > 1e-9 ? shadingNormals[i].scale(1 / sl) : vertNormals[i];
    }

    this._topology = {
      edges, edgeIndex, faceEdges, vertEdges, vertFaces, faceNormals, faceCenters, vertNormals,
      shadingNormals,
    };
    return this._topology;
  }

  findEdge(a: number, b: number): number {
    const t = this.topology();
    const ei = t.edgeIndex.get(this.edgeKey(a, b));
    return ei === undefined ? -1 : ei;
  }

  edgeCenter(ei: number): Vec3 {
    const e = this.topology().edges[ei];
    return this.positions[e.a].add(this.positions[e.b]).scale(0.5);
  }

  isBoundaryEdge(ei: number): boolean {
    return this.topology().edges[ei].faces.length === 1;
  }

  /** Faces sharing an edge with `f`. */
  faceNeighbors(f: number): number[] {
    const t = this.topology();
    const out: number[] = [];
    for (const ei of t.faceEdges[f]) {
      if (ei < 0) continue;
      for (const nf of t.edges[ei].faces) if (nf !== f && !out.includes(nf)) out.push(nf);
    }
    return out;
  }

  /**
   * Fan-triangulate every face. Returns triangle corner indices plus, for each
   * triangle, the face it came from (used for picking and flat shading).
   */
  triangulate(): { indices: number[]; triFace: number[] } {
    const indices: number[] = [];
    const triFace: number[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const loop = this.faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        indices.push(loop[0], loop[i], loop[i + 1]);
        triFace.push(f);
      }
    }
    return { indices, triFace };
  }

  /**
   * Make every face loop a simple polygon, dropping what cannot be one.
   *
   * Removing repeated *neighbouring* corners is the easy half. The hard half
   * is a loop that comes back to a vertex it already visited somewhere in the
   * middle — `[a, X, c, X, e]` — which a weld produces whenever it merges two
   * corners of the same face. That is not a polygon at all; it is two polygons
   * pinched together at X. Left alone it triangulates into slivers with no
   * meaningful normal, and every operator downstream inherits the mess.
   *
   * So a pinched loop is cut at the pinch and both halves are kept. That is
   * what the surface actually is, and it means a merge can tidy geometry up
   * without quietly making it invalid.
   */
  cleanDegenerate(): void {
    const faces: number[][] = [];
    const mats: number[] = [];
    const smooth: boolean[] = [];
    const uvs: (number[] | null)[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const loop: number[] = [];
      const src = this.faces[f];
      const srcUV = this.uvFor(f);
      const uv: number[] = [];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (loop.length === 0 || loop[loop.length - 1] !== v) {
          loop.push(v);
          if (srcUV) uv.push(srcUV[i * 2], srcUV[i * 2 + 1]);
        }
      }
      while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
        loop.pop();
        uv.length = Math.max(0, uv.length - 2);
      }
      for (const piece of splitPinchedLoop(loop, uv.length === loop.length * 2 ? uv : null)) {
        if (piece.loop.length < 3) continue;
        faces.push(piece.loop);
        mats.push(this.faceMaterial[f] ?? 0);
        smooth.push(this.isFaceSmooth(f));
        uvs.push(srcUV && piece.uv ? piece.uv : null);
      }
    }
    this.faces = faces;
    this.faceMaterial = mats;
    if (this.faceSmooth) this.faceSmooth = smooth;
    if (this.faceUV) this.faceUV = uvs;
    this.markDirty();
  }

  /** Remove vertices no face references. Returns old->new index map (-1 = dropped). */
  removeLooseVertices(): number[] {
    const used = new Uint8Array(this.positions.length);
    for (const f of this.faces) for (const v of f) used[v] = 1;
    const map = new Array<number>(this.positions.length).fill(-1);
    const positions: Vec3[] = [];
    for (let i = 0; i < this.positions.length; i++) {
      if (used[i]) {
        map[i] = positions.length;
        positions.push(this.positions[i]);
      }
    }
    this.positions = positions;
    this.faces = this.faces.map((f) => f.map((v) => map[v]));
    this.markDirty();
    return map;
  }

  /** Append another mesh's geometry. Returns the vertex offset applied. */
  append(other: Mesh, materialOffset = 0): number {
    const off = this.positions.length;
    const faceOff = this.faces.length;
    for (const p of other.positions) this.positions.push(p.clone());
    for (const f of other.faces) this.faces.push(f.map((v) => v + off));
    for (const m of other.faceMaterial) this.faceMaterial.push(m + materialOffset);
    if (this.faceSmooth || other.faceSmooth) {
      const mine = this.faceSmooth ?? new Array(faceOff).fill(this.shadeSmooth);
      for (let f = 0; f < other.faces.length; f++) mine.push(other.isFaceSmooth(f));
      this.faceSmooth = mine;
    }
    if (this.faceUV || other.faceUV) {
      const mine = this.faceUV ?? new Array(faceOff).fill(null);
      for (let f = 0; f < other.faces.length; f++) {
        const uv = other.uvFor(f);
        mine.push(uv ? uv.slice() : null);
      }
      this.faceUV = mine;
    }
    this.markDirty();
    return off;
  }

  toJSON(): {
    positions: number[]; faces: number[][]; faceMaterial: number[];
    shadeSmooth: boolean; faceSmooth: boolean[] | null;
    faceUV?: (number[] | null)[] | null; seams?: string[] | null;
    edgeWeights?: [string, number][] | null;
    mask?: number[] | null;
    skin?: { bones: number[]; weights: number[] } | null;
    colors?: number[] | null;
  } {
    const positions: number[] = [];
    for (const p of this.positions) positions.push(p.x, p.y, p.z);
    return {
      positions,
      faces: this.faces.map((f) => f.slice()),
      faceMaterial: this.faceMaterial.slice(),
      shadeSmooth: this.shadeSmooth,
      faceSmooth: this.faceSmooth ? this.faceSmooth.slice() : null,
      faceUV: this.faceUV ? this.faceUV.map((u) => (u ? u.slice() : null)) : null,
      seams: this.seams ? [...this.seams] : null,
      edgeWeights: this.edgeWeights ? [...this.edgeWeights] : null,
      mask: this.mask ? [...this.mask] : null,
      skin: this.skin ? { bones: [...this.skin.bones], weights: [...this.skin.weights] } : null,
      colors: this.colors ? [...this.colors] : null,
    };
  }

  /**
   * Rebuild a mesh from a document, keeping only what is actually usable.
   *
   * Nothing else in the application produces this input. A file does, and a
   * file can be truncated by a full disk, half-synced by a cloud folder,
   * hand-edited, or written by a version that stores something differently —
   * and until this validated, any of those threw a raw TypeError out of the
   * loader and took the application down with it. Worse were the ones that
   * did *not* throw: a face listing two corners loaded happily and became
   * geometry every operator downstream had to cope with.
   *
   * So each field is checked against what it has to be, anything unusable is
   * dropped, and the result is always a mesh — possibly an empty one, which
   * is a scene you can still work in and save.
   */
  static fromJSON(d: ReturnType<Mesh['toJSON']>): Mesh {
    const raw = (d ?? {}) as Partial<ReturnType<Mesh['toJSON']>>;
    const positions: Vec3[] = [];
    const coords = Array.isArray(raw.positions) ? raw.positions : [];
    for (let i = 0; i + 2 < coords.length; i += 3) {
      const x = Number(coords[i]);
      const y = Number(coords[i + 1]);
      const z = Number(coords[i + 2]);
      // A vertex that is not a point cannot be repaired into one, and letting
      // a NaN through poisons every normal, bound and matrix it reaches.
      positions.push(new Vec3(
        Number.isFinite(x) ? x : 0,
        Number.isFinite(y) ? y : 0,
        Number.isFinite(z) ? z : 0,
      ));
    }

    // Faces are kept only where every corner is a real vertex and the loop is
    // a polygon; the parallel per-face arrays are filtered to match, or they
    // would silently shift by one for every face dropped.
    const keptFaces: number[][] = [];
    const keptFrom: number[] = [];
    const sourceFaces = Array.isArray(raw.faces) ? raw.faces : [];
    for (let f = 0; f < sourceFaces.length; f++) {
      const loop = sourceFaces[f];
      if (!Array.isArray(loop)) continue;
      const clean: number[] = [];
      for (const v of loop) {
        if (!Number.isInteger(v) || v < 0 || v >= positions.length) continue;
        // A corner repeated inside one loop is not a polygon either.
        if (clean.length && clean[clean.length - 1] === v) continue;
        if (clean.includes(v)) continue;
        clean.push(v);
      }
      if (clean.length < 3) continue;
      keptFaces.push(clean);
      keptFrom.push(f);
    }

    const pick = <T>(source: unknown, at: number, fallback: T): T => (
      Array.isArray(source) && at < source.length ? (source[at] as T) : fallback
    );

    const m = new Mesh(
      positions,
      keptFaces,
      keptFrom.map((f) => {
        const mat = pick(raw.faceMaterial, f, 0);
        return Number.isInteger(mat) && (mat as number) >= 0 ? (mat as number) : 0;
      }),
    );
    m.shadeSmooth = !!raw.shadeSmooth;
    m.faceSmooth = Array.isArray(raw.faceSmooth)
      ? keptFrom.map((f) => !!pick(raw.faceSmooth, f, false))
      : null;
    m.faceUV = Array.isArray(raw.faceUV)
      ? keptFrom.map((f, i) => {
        const uv = pick<number[] | null>(raw.faceUV, f, null);
        // Coordinates only survive if there are exactly two per corner of the
        // face as it was actually kept.
        if (!Array.isArray(uv) || uv.length !== keptFaces[i].length * 2) return null;
        return uv.every((c) => Number.isFinite(c)) ? uv.slice() : null;
      })
      : null;
    m.seams = Array.isArray(raw.seams) && raw.seams.length
      ? new Set(raw.seams.filter((k) => typeof k === 'string'))
      : null;
    m.edgeWeights = Array.isArray(raw.edgeWeights) && raw.edgeWeights.length
      ? new Map(raw.edgeWeights.filter(
        (e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]),
      ))
      : null;
    // Per-vertex arrays have to match the vertex count or they mean nothing.
    m.mask = Array.isArray(raw.mask) && raw.mask.length === positions.length
      ? Float32Array.from(raw.mask, (v) => (Number.isFinite(v) ? v : 0))
      : null;
    const skin = raw.skin;
    m.skin = skin && Array.isArray(skin.bones) && Array.isArray(skin.weights)
      && skin.bones.length === skin.weights.length
      ? {
        bones: Int32Array.from(skin.bones, (v) => (Number.isInteger(v) ? v : -1)),
        weights: Float32Array.from(skin.weights, (v) => (Number.isFinite(v) ? v : 0)),
      }
      : null;
    m.colors = Array.isArray(raw.colors) && raw.colors.length === positions.length * 3
      ? Float32Array.from(raw.colors, (v) => (Number.isFinite(v) ? v : 1))
      : null;
    return m;
  }
}
