import { Mesh } from '../mesh/Mesh';

/**
 * CPU-side vertex buffer construction.
 *
 * Triangles are emitted corner by corner, which is what lets flat shading,
 * per-face materials and per-face selection work without splitting draws — a
 * corner carries its own normal, material and selection flag. Identical
 * corners are then merged into an index buffer, so a smooth-shaded mesh pays
 * for one vertex rather than one per face that meets there. See
 * `buildSurfaceBuffer` for what "identical" has to mean for that to be safe.
 */

export const SURFACE_STRIDE = 14; // pos(3) normal(3) uv(2) flags(1) matId(1) colour(3) diff(1)

/**
 * The interleaved surface vertex, in order.
 *
 * Shared by every program that draws from this buffer, and it has to be: the
 * stride is derived from the layout, so a program that only reads position and
 * normal must still be told about the attributes in between. Describing just
 * the ones a shader happens to use gives a stride short by the difference and
 * reads every vertex from the wrong offset.
 */
export const SURFACE_LAYOUT: { name: string; size: number }[] = [
  { name: 'aPos', size: 3 },
  { name: 'aNormal', size: 3 },
  { name: 'aUV', size: 2 },
  { name: 'aFlags', size: 1 },
  { name: 'aMatId', size: 1 },
  { name: 'aVColor', size: 3 },
  // Which way this face differs from the version being compared against.
  // Its own lane rather than a spare range of aFlags: a face can be both
  // selected and newly added, and packing two meanings into one number is how
  // you end up unable to show that.
  { name: 'aDiff', size: 1 },
];
export const LINE_STRIDE = 6; // pos(3) color(3)
export const POINT_STRIDE = 4; // pos(3) flags(1)
export const LINE_LAYOUT: { name: string; size: number }[] = [
  { name: 'aPos', size: 3 },
  { name: 'aColor', size: 3 },
];
export const POINT_LAYOUT: { name: string; size: number }[] = [
  { name: 'aPos', size: 3 },
  { name: 'aFlags', size: 1 },
];

export interface BufferData {
  data: Float32Array;
  count: number;
}

export interface SurfaceData extends BufferData {
  /** Triangle indices into `data`. */
  indices: Uint32Array;
  /** Corners before deduplication, for reporting how much it saved. */
  corners: number;
}

/**
 * Deduplicate face corners into a vertex buffer plus indices.
 *
 * Corners can only be shared when every attribute matches — position, normal,
 * texture coordinate, selection flag, material and vertex colour. That
 * condition is what makes indexing safe here at all: flat shading gives the
 * corners of one face a different normal from the next face's, per-face
 * materials give them a different id, and per-face selection a different flag,
 * so those corners simply do not merge and nothing is lost by trying.
 *
 * What does merge is the common case. A smooth-shaded subdivided mesh shares
 * one normal and one coordinate per vertex, so ninety thousand corners become
 * fifteen thousand vertices — six times less to upload, and the vertex shader
 * runs once per vertex instead of once per corner.
 *
 * Merging is on exact equality, never on a tolerance: a merged pair really is
 * the same corner written twice.
 */
class CornerIndex {
  /** Vertices already emitted for each mesh vertex. */
  private byVertex: number[][];
  private view: Float32Array;
  private count = 0;

  constructor(private stride: number, vertexCount: number, capacity: number) {
    this.byVertex = new Array(vertexCount);
    this.view = new Float32Array(capacity * stride);
  }

  /**
   * Index of this corner, adding it if it is new.
   *
   * Candidates are looked up by mesh vertex rather than by hashing the
   * attributes. Two corners can only ever merge if they are the same mesh
   * vertex to begin with, so the vertex index is a perfect bucket that costs
   * nothing to compute — and the list in each bucket is one entry for a smooth
   * surface and about six for a flat one, which is short enough that a linear
   * scan beats any hash of thirteen floats.
   */
  intern(src: Float32Array, vertex: number): number {
    const bucket = this.byVertex[vertex];
    if (bucket !== undefined) {
      outer: for (const i of bucket) {
        const at = i * this.stride;
        // Position and vertex colour are properties of the mesh vertex, so
        // they cannot differ between two corners of the same one; only the
        // face-dependent attributes are worth comparing.
        for (let k = 3; k < 10; k++) {
          if (this.view[at + k] !== src[k]) continue outer;
        }
        return i;
      }
    }
    const index = this.count++;
    const to = index * this.stride;
    // Copied by hand rather than through `subarray`, which would allocate a
    // view object for every corner in the mesh.
    for (let i = 0; i < this.stride; i++) this.view[to + i] = src[i];
    if (bucket !== undefined) bucket.push(index);
    else this.byVertex[vertex] = [index];
    return index;
  }

  get vertexCount(): number {
    return this.count;
  }

  data(): Float32Array {
    return this.view.subarray(0, this.count * this.stride);
  }
}

/**
 * Build the surface vertex buffer, deduplicated and indexed.
 *
 * Triangles are emitted corner by corner exactly as before; the difference is
 * that identical corners now collapse to one vertex.
 *
 * Always indexed, even when nothing merged. An index is four bytes against a
 * vertex's fifty-two, so the worst case — a genuine triangle soup where every
 * corner is unique — costs under eight per cent more memory, and drawing from
 * an ascending index list is no slower than drawing without one. Branching on
 * whether it paid would mean keeping two layouts alive and getting the
 * unindexed one's vertex order wrong exactly once.
 */
export function buildSurface(
  mesh: Mesh, selectedFaces: Set<number> | null, diffClasses?: Uint8Array | null,
): SurfaceData {
  const t = mesh.topology();
  const tris = mesh.triCount;
  const corners = tris * 3;
  const scratch = new Float32Array(SURFACE_STRIDE);
  const index = new CornerIndex(SURFACE_STRIDE, mesh.positions.length, corners);
  const indices = new Uint32Array(corners);
  let n = 0;

  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    if (loop.length < 3) continue;
    const smooth = mesh.isFaceSmooth(f);
    const fn = t.faceNormals[f];
    const flag = selectedFaces && selectedFaces.has(f) ? 1 : 0;
    const diff = diffClasses && f < diffClasses.length ? diffClasses[f] : 0;
    const mat = mesh.faceMaterial[f] ?? 0;
    const uv = mesh.uvFor(f);
    const vc = mesh.colors;
    for (let i = 1; i + 1 < loop.length; i++) {
      for (const corner of [0, i, i + 1]) {
        const v = loop[corner];
        const p = mesh.positions[v];
        // Shading normals, not geometric ones: a face marked flat must not
        // pull its neighbours' smooth normals around.
        const nrm = smooth ? t.shadingNormals[v] : fn;
        scratch[0] = p.x; scratch[1] = p.y; scratch[2] = p.z;
        scratch[3] = nrm.x; scratch[4] = nrm.y; scratch[5] = nrm.z;
        scratch[6] = uv ? uv[corner * 2] : 0;
        scratch[7] = uv ? uv[corner * 2 + 1] : 0;
        scratch[8] = flag;
        scratch[9] = mat;
        // White where nothing has been painted, so an unpainted mesh shades
        // exactly as it did before vertex colours existed.
        const ci = v * 3;
        const painted = vc && ci + 2 < vc.length;
        scratch[10] = painted ? vc[ci] : 1;
        scratch[11] = painted ? vc[ci + 1] : 1;
        scratch[12] = painted ? vc[ci + 2] : 1;
        scratch[13] = diff;
        indices[n++] = index.intern(scratch, v);
      }
    }
  }

  return {
    data: index.data(),
    count: index.vertexCount,
    indices: indices.subarray(0, n),
    corners,
  };
}

export function buildWire(
  mesh: Mesh,
  selectedEdges: Set<number> | null,
  base: readonly [number, number, number],
  selected: readonly [number, number, number],
): BufferData {
  const t = mesh.topology();
  const n = t.edges.length;
  const data = new Float32Array(n * 2 * LINE_STRIDE);
  let o = 0;
  for (let e = 0; e < n; e++) {
    const rec = t.edges[e];
    const c = selectedEdges && selectedEdges.has(e) ? selected : base;
    for (const v of [rec.a, rec.b]) {
      const p = mesh.positions[v];
      data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
      data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2];
    }
  }
  return { data, count: n * 2 };
}

export function buildPoints(mesh: Mesh, selectedVerts: Set<number> | null): BufferData {
  const n = mesh.positions.length;
  const data = new Float32Array(n * POINT_STRIDE);
  let o = 0;
  for (let v = 0; v < n; v++) {
    const p = mesh.positions[v];
    data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
    data[o++] = selectedVerts && selectedVerts.has(v) ? 1 : 0;
  }
  return { data, count: n };
}

/** Line segments for an object-mode wireframe overlay (no selection colouring). */
export function buildObjectWire(mesh: Mesh, color: readonly [number, number, number]): BufferData {
  return buildWire(mesh, null, color, color);
}
