import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';
import { TriangleBVH } from './bvh';

/**
 * Voxel remeshing.
 *
 * Sculpting stretches the topology it started with. Push a limb out of a
 * sphere and the polygons at the tip end up huge and the ones at the base
 * crowded; carry on and the brush has nothing left to move. Every sculpting
 * tool answers this the same way: throw the topology away and rebuild it at a
 * uniform density from the shape alone.
 *
 * The shape is sampled into a signed distance field — inside is negative,
 * outside positive — and the zero crossing is polygonised with marching cubes.
 * Nothing of the old topology survives, which is the point: an n-gon soup with
 * a pinched pole comes back as an even triangle mesh you can keep working.
 *
 * Two costs come with that, and they are the reason this is a command rather
 * than something that happens automatically: UVs are gone, because the surface
 * they were laid out on no longer exists, and hard edges are rounded to
 * whatever the voxel size can represent.
 */

export interface RemeshOptions {
  /** Cell size in the mesh's own units. Smaller keeps more detail. */
  voxelSize: number;
  /**
   * Rounds of Laplacian smoothing over the result. Marching cubes leaves a
   * faint stair pattern where the surface runs diagonally across the grid; a
   * couple of passes take it off without moving the silhouette.
   */
  smoothPasses?: number;
  /** Cap on the grid's longest side, so a small voxel size cannot hang. */
  maxResolution?: number;
}

/** Corner offsets, in the standard marching-cubes order. */
const CORNER: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/** The two corners each of the 12 edges joins. */
const EDGE_CORNERS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function buildEdgeTable(): Int32Array {
  const table = new Int32Array(256);
  for (let pattern = 0; pattern < 256; pattern++) {
    let bits = 0;
    for (let e = 0; e < 12; e++) {
      const [a, b] = EDGE_CORNERS[e];
      const inA = (pattern >> a) & 1;
      const inB = (pattern >> b) & 1;
      if (inA !== inB) bits |= 1 << e;
    }
    table[pattern] = bits;
  }
  return table;
}

/**
 * The classic 256-case triangle table, as a flat list of edge indices with -1
 * terminators.
 */
function buildTriTable(): Int8Array {
  // prettier-ignore
  const rows = TRI_ROWS;
  const out = new Int8Array(256 * 16).fill(-1);
  for (let i = 0; i < 256; i++) {
    const row = rows[i];
    for (let j = 0; j < row.length; j++) out[i * 16 + j] = row[j];
  }
  return out;
}

/**
 * A signed distance field sampled from a mesh.
 *
 * Sign comes from a parity test rather than from normals, so it works on a
 * mesh whose normals disagree with each other — which a sculpt often is.
 */
export class SignedDistanceField {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly origin: Vec3;
  readonly values: Float32Array;

  readonly step: Vec3;

  constructor(mesh: Mesh, readonly voxel: number, maxResolution = 320) {
    const bounds = mesh.bounds();
    // A margin of a few cells, so the surface never touches the grid wall and
    // marching cubes always has an outside to close against.
    const pad = voxel * 3;
    const lo = bounds.min.sub(new Vec3(pad, pad, pad));
    const hi = bounds.max.add(new Vec3(pad, pad, pad));
    const span = hi.sub(lo);
    const want = (v: number): number => Math.max(2, Math.ceil(v / voxel) + 1);
    let nx = want(span.x);
    let ny = want(span.y);
    let nz = want(span.z);
    const worst = Math.max(nx, ny, nz);
    if (worst > maxResolution) {
      const k = maxResolution / worst;
      nx = Math.max(2, Math.round(nx * k));
      ny = Math.max(2, Math.round(ny * k));
      nz = Math.max(2, Math.round(nz * k));
    }
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.origin = lo;
    // Spacing follows from the grid actually allocated, not from the requested
    // voxel size. Keeping the nominal size after the cap would leave the grid
    // short of the bounds and slice the far side off the model.
    this.step = new Vec3(span.x / (nx - 1), span.y / (ny - 1), span.z / (nz - 1));
    this.values = new Float32Array(nx * ny * nz);
    this.fill(mesh);
  }

  at(x: number, y: number, z: number): number {
    return this.values[(z * this.ny + y) * this.nx + x];
  }

  point(x: number, y: number, z: number): Vec3 {
    return new Vec3(
      this.origin.x + x * this.step.x,
      this.origin.y + y * this.step.y,
      this.origin.z + z * this.step.z,
    );
  }

  /**
   * Sample the field.
   *
   * The expensive part is the sign: an inside/outside test is a ray cast, and
   * doing one per grid point is hopeless at any useful resolution. Only cells
   * near the surface actually need a signed distance — everywhere else the
   * value is never interpolated, so all that matters is which side it is on.
   * So: measure distances in a narrow band, then flood the outside in from the
   * grid wall through everything the band does not block. Whatever the flood
   * cannot reach is enclosed, and therefore inside, without a single ray.
   */
  private fill(mesh: Mesh): void {
    const bvh = new TriangleBVH(mesh.positions, mesh.faces);
    const { nx, ny, nz } = this;
    const reach = Math.max(this.step.x, this.step.y, this.step.z);
    const band = reach * 2;
    const inBand = new Uint8Array(nx * ny * nz);

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = (z * ny + y) * nx + x;
          const d = bvh.distanceTo(this.point(x, y, z), band);
          if (d <= band) {
            inBand[i] = 1;
            this.values[i] = d;
          } else {
            this.values[i] = band;
          }
        }
      }
    }

    // Band cells still need their sign, and there is no way around a ray for
    // those — but there are far fewer of them than there are grid points.
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = (z * ny + y) * nx + x;
          if (inBand[i] && bvh.contains(this.point(x, y, z))) this.values[i] = -this.values[i];
        }
      }
    }

    // Flood the outside in from the wall. The padding guarantees the wall
    // itself is outside, and the band is thick enough that the flood cannot
    // leak through the surface.
    const seen = new Uint8Array(nx * ny * nz);
    const stack: number[] = [];
    const push = (x: number, y: number, z: number): void => {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      const i = (z * ny + y) * nx + x;
      if (seen[i] || inBand[i]) return;
      seen[i] = 1;
      stack.push(x, y, z);
    };
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        push(0, y, z);
        push(nx - 1, y, z);
      }
      for (let x = 0; x < nx; x++) {
        push(x, 0, z);
        push(x, ny - 1, z);
      }
    }
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        push(x, y, 0);
        push(x, y, nz - 1);
      }
    }
    while (stack.length > 0) {
      const z = stack.pop()!;
      const y = stack.pop()!;
      const x = stack.pop()!;
      push(x - 1, y, z);
      push(x + 1, y, z);
      push(x, y - 1, z);
      push(x, y + 1, z);
      push(x, y, z - 1);
      push(x, y, z + 1);
    }
    for (let i = 0; i < this.values.length; i++) {
      if (!inBand[i] && !seen[i]) this.values[i] = -band;
    }
  }
}

/**
 * Which of the 12 cube edges the surface crosses, per corner pattern. Derived
 * from the pattern rather than pasted in, so it is checkable.
 *
 * Built on first use: the tables it reads are declared further down, and a
 * module-level call would run before they exist.
 */
let edgeTable: Int32Array | null = null;
function edgeTableFor(): Int32Array {
  return (edgeTable ??= buildEdgeTable());
}

/** The triangles to emit per pattern, as edge indices. */
let triTable: Int8Array | null = null;
function triTableFor(): Int8Array {
  return (triTable ??= buildTriTable());
}

/** Rebuild a mesh at uniform density from its own shape. */
export function voxelRemesh(mesh: Mesh, options: RemeshOptions): Mesh {
  const voxel = Math.max(1e-4, options.voxelSize);
  const field = new SignedDistanceField(mesh, voxel, options.maxResolution ?? 320);
  const out = marchingCubes(field);
  const passes = options.smoothPasses ?? 2;
  for (let i = 0; i < passes; i++) laplacianSmooth(out, 0.5);
  out.shadeSmooth = true;
  out.markDirty();
  return out;
}

/**
 * Polygonise the zero crossing of a field.
 *
 * Vertices are shared between cells by keying each one on the grid edge it sits
 * on, so the result comes out welded rather than as a triangle soup that would
 * then need a merge-by-distance pass.
 */
export function marchingCubes(field: SignedDistanceField): Mesh {
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const vertexOnEdge = new Map<number, number>();
  const { nx, ny, nz } = field;

  // A grid edge is identified by its lower corner plus which axis it runs
  // along, which is unique across the whole grid.
  const edgeKey = (x: number, y: number, z: number, axis: number): number =>
    (((z * ny + y) * nx + x) * 3) + axis;

  const EDGE_TABLE = edgeTableFor();
  const TRI_TABLE = triTableFor();
  const cornerValues = new Float64Array(8);
  const edgeVerts = new Int32Array(12);

  for (let z = 0; z + 1 < nz; z++) {
    for (let y = 0; y + 1 < ny; y++) {
      for (let x = 0; x + 1 < nx; x++) {
        let pattern = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          const v = field.at(x + dx, y + dy, z + dz);
          cornerValues[c] = v;
          if (v < 0) pattern |= 1 << c;
        }
        const bits = EDGE_TABLE[pattern];
        if (bits === 0) continue;

        for (let e = 0; e < 12; e++) {
          if ((bits & (1 << e)) === 0) continue;
          const [ca, cb] = EDGE_CORNERS[e];
          const [ax, ay, az] = CORNER[ca];
          const [bx, by, bz] = CORNER[cb];
          // Normalise the edge to its lower corner and its axis, so both cells
          // sharing it compute the same key and reuse the same vertex.
          const lowX = Math.min(x + ax, x + bx);
          const lowY = Math.min(y + ay, y + by);
          const lowZ = Math.min(z + az, z + bz);
          const axis = ax !== bx ? 0 : ay !== by ? 1 : 2;
          const key = edgeKey(lowX, lowY, lowZ, axis);
          let vi = vertexOnEdge.get(key);
          if (vi === undefined) {
            const va = cornerValues[ca];
            const vb = cornerValues[cb];
            // Where along the edge the field actually crosses zero. Placing the
            // vertex there rather than at the midpoint is what makes the
            // surface smooth instead of blocky.
            const denom = vb - va;
            const t = Math.abs(denom) > 1e-12 ? -va / denom : 0.5;
            const pa = field.point(x + ax, y + ay, z + az);
            const pb = field.point(x + bx, y + by, z + bz);
            vi = positions.length;
            positions.push(pa.lerp(pb, Math.min(1, Math.max(0, t))));
            vertexOnEdge.set(key, vi);
          }
          edgeVerts[e] = vi;
        }

        for (let i = 0; i < 16 && TRI_TABLE[pattern * 16 + i] >= 0; i += 3) {
          const a = edgeVerts[TRI_TABLE[pattern * 16 + i]];
          const b = edgeVerts[TRI_TABLE[pattern * 16 + i + 1]];
          const c = edgeVerts[TRI_TABLE[pattern * 16 + i + 2]];
          if (a === b || b === c || a === c) continue;
          faces.push([a, c, b]);
        }
      }
    }
  }

  const out = new Mesh(positions, faces);
  out.cleanDegenerate();
  out.removeLooseVertices();
  return out;
}

/**
 * Move each vertex toward the average of its neighbours.
 *
 * Marching cubes leaves a faint stair pattern where the surface runs diagonally
 * across the grid. A couple of light passes take it off; more than that starts
 * shrinking the model.
 */
export function laplacianSmooth(mesh: Mesh, amount = 0.5): void {
  // Same clamp and the same reason as smoothVertices: past 1 this stops being
  // smoothing and becomes extrapolation away from the neighbour average, and
  // the error compounds. Nothing that reaches here — a slider, a typed field,
  // a file, a generated program — is worth trusting with an unbounded factor.
  const strength = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
  const t = mesh.topology();
  const next = mesh.positions.map((p) => p.clone());
  for (let v = 0; v < mesh.positions.length; v++) {
    const edges = t.vertEdges[v];
    if (!edges || edges.length === 0) continue;
    const sum = new Vec3();
    for (const ei of edges) {
      const e = t.edges[ei];
      sum.addInPlace(mesh.positions[e.a === v ? e.b : e.a]);
    }
    next[v] = mesh.positions[v].lerp(sum.scale(1 / edges.length), strength);
  }
  mesh.positions = next;
  mesh.markDirty();
}

/**
 * A voxel size that gives roughly `target` triangles for a mesh of this size.
 *
 * Asking for a cell size in scene units means nothing to most people; asking
 * for "about 50k triangles" does. Surface area scales as the square of the
 * cell, and marching cubes puts about two triangles in each surface cell, so
 * the size falls out of the area directly.
 */
export function voxelSizeForTarget(mesh: Mesh, target: number): number {
  let area = 0;
  for (const loop of mesh.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      const a = mesh.positions[loop[0]];
      const b = mesh.positions[loop[i]];
      const c = mesh.positions[loop[i + 1]];
      area += b.sub(a).cross(c.sub(a)).length() * 0.5;
    }
  }
  const radius = Math.max(1e-4, mesh.bounds().radius());
  if (area <= 0) return radius / 32;
  const cells = Math.max(1, target / 2);
  return Math.min(radius, Math.max(radius / 512, Math.sqrt(area / cells)));
}

/**
 * The marching-cubes triangle table.
 *
 * These are the 256 corner patterns of a cube, each listed as the triangles to
 * emit in terms of the 12 edge indices. It is a lookup table, not logic — there
 * is nothing to derive here, only the standard enumeration.
 */
const TRI_ROWS: number[][] = [
  [], [0, 8, 3], [0, 1, 9], [1, 8, 3, 9, 8, 1], [1, 2, 10], [0, 8, 3, 1, 2, 10],
  [9, 2, 10, 0, 2, 9], [2, 8, 3, 2, 10, 8, 10, 9, 8], [3, 11, 2], [0, 11, 2, 8, 11, 0],
  [1, 9, 0, 2, 3, 11], [1, 11, 2, 1, 9, 11, 9, 8, 11], [3, 10, 1, 11, 10, 3],
  [0, 10, 1, 0, 8, 10, 8, 11, 10], [3, 9, 0, 3, 11, 9, 11, 10, 9],
  [9, 8, 10, 10, 8, 11], [4, 7, 8], [4, 3, 0, 7, 3, 4], [0, 1, 9, 8, 4, 7],
  [4, 1, 9, 4, 7, 1, 7, 3, 1], [1, 2, 10, 8, 4, 7], [3, 4, 7, 3, 0, 4, 1, 2, 10],
  [9, 2, 10, 9, 0, 2, 8, 4, 7], [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
  [8, 4, 7, 3, 11, 2], [11, 4, 7, 11, 2, 4, 2, 0, 4], [9, 0, 1, 8, 4, 7, 2, 3, 11],
  [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1], [3, 10, 1, 3, 11, 10, 7, 8, 4],
  [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4], [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3],
  [4, 7, 11, 4, 11, 9, 9, 11, 10], [9, 5, 4], [9, 5, 4, 0, 8, 3], [0, 5, 4, 1, 5, 0],
  [8, 5, 4, 8, 3, 5, 3, 1, 5], [1, 2, 10, 9, 5, 4], [3, 0, 8, 1, 2, 10, 4, 9, 5],
  [5, 2, 10, 5, 4, 2, 4, 0, 2], [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8],
  [9, 5, 4, 2, 3, 11], [0, 11, 2, 0, 8, 11, 4, 9, 5], [0, 5, 4, 0, 1, 5, 2, 3, 11],
  [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5], [10, 3, 11, 10, 1, 3, 9, 5, 4],
  [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10], [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3],
  [5, 4, 8, 5, 8, 10, 10, 8, 11], [9, 7, 8, 5, 7, 9], [9, 3, 0, 9, 5, 3, 5, 7, 3],
  [0, 7, 8, 0, 1, 7, 1, 5, 7], [1, 5, 3, 3, 5, 7], [9, 7, 8, 9, 5, 7, 10, 1, 2],
  [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3], [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2],
  [2, 10, 5, 2, 5, 3, 3, 5, 7], [7, 9, 5, 7, 8, 9, 3, 11, 2],
  [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11], [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7],
  [11, 2, 1, 11, 1, 7, 7, 1, 5], [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11],
  [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0],
  [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0], [11, 10, 5, 7, 11, 5],
  [10, 6, 5], [0, 8, 3, 5, 10, 6], [9, 0, 1, 5, 10, 6], [1, 8, 3, 1, 9, 8, 5, 10, 6],
  [1, 6, 5, 2, 6, 1], [1, 6, 5, 1, 2, 6, 3, 0, 8], [9, 6, 5, 9, 0, 6, 0, 2, 6],
  [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8], [2, 3, 11, 10, 6, 5],
  [11, 0, 8, 11, 2, 0, 10, 6, 5], [0, 1, 9, 2, 3, 11, 5, 10, 6],
  [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11], [6, 3, 11, 6, 5, 3, 5, 1, 3],
  [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6], [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9],
  [6, 5, 9, 6, 9, 11, 11, 9, 8], [5, 10, 6, 4, 7, 8], [4, 3, 0, 4, 7, 3, 6, 5, 10],
  [1, 9, 0, 5, 10, 6, 8, 4, 7], [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4],
  [6, 1, 2, 6, 5, 1, 4, 7, 8], [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7],
  [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6], [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9],
  [3, 11, 2, 7, 8, 4, 10, 6, 5], [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11],
  [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6],
  [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6],
  [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6],
  [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11],
  [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7],
  [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9], [10, 4, 9, 6, 4, 10],
  [4, 10, 6, 4, 9, 10, 0, 8, 3], [10, 0, 1, 10, 6, 0, 6, 4, 0],
  [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10], [1, 4, 9, 1, 2, 4, 2, 6, 4],
  [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4], [0, 2, 4, 4, 2, 6],
  [8, 3, 2, 8, 2, 4, 4, 2, 6], [10, 4, 9, 10, 6, 4, 11, 2, 3],
  [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
  [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1],
  [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3],
  [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1], [3, 11, 6, 3, 6, 0, 0, 6, 4],
  [6, 4, 8, 11, 6, 8], [7, 10, 6, 7, 8, 10, 8, 9, 10],
  [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0],
  [10, 6, 7, 10, 7, 1, 1, 7, 3], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7],
  [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9], [7, 8, 0, 7, 0, 6, 6, 0, 2],
  [7, 3, 2, 6, 7, 2], [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7],
  [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7],
  [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11],
  [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1],
  [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6], [0, 9, 1, 11, 6, 7],
  [7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0], [7, 11, 6], [7, 6, 11],
  [3, 0, 8, 11, 7, 6], [0, 1, 9, 11, 7, 6], [8, 1, 9, 8, 3, 1, 11, 7, 6],
  [10, 1, 2, 6, 11, 7], [1, 2, 10, 3, 0, 8, 6, 11, 7], [2, 9, 0, 2, 10, 9, 6, 11, 7],
  [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8], [7, 2, 3, 6, 2, 7],
  [7, 0, 8, 7, 6, 0, 6, 2, 0], [2, 7, 6, 2, 3, 7, 0, 1, 9],
  [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6], [10, 7, 6, 10, 1, 7, 1, 3, 7],
  [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8], [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7],
  [7, 6, 10, 7, 10, 8, 8, 10, 9], [6, 8, 4, 11, 8, 6], [3, 6, 11, 3, 0, 6, 0, 4, 6],
  [8, 6, 11, 8, 4, 6, 9, 0, 1], [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6],
  [6, 8, 4, 6, 11, 8, 2, 10, 1], [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6],
  [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9],
  [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3], [8, 2, 3, 8, 4, 2, 4, 6, 2],
  [0, 4, 2, 4, 6, 2], [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8],
  [1, 9, 4, 1, 4, 2, 2, 4, 6], [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1],
  [10, 1, 0, 10, 0, 6, 6, 0, 4], [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3],
  [10, 9, 4, 6, 10, 4], [4, 9, 5, 7, 6, 11], [0, 8, 3, 4, 9, 5, 11, 7, 6],
  [5, 0, 1, 5, 4, 0, 7, 6, 11], [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5],
  [9, 5, 4, 10, 1, 2, 7, 6, 11], [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5],
  [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2],
  [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6], [7, 2, 3, 7, 6, 2, 5, 4, 9],
  [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7], [3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0],
  [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8], [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7],
  [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4],
  [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10],
  [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10], [6, 9, 5, 6, 11, 9, 11, 8, 9],
  [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5], [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11],
  [6, 11, 3, 6, 3, 5, 5, 3, 1], [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6],
  [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10],
  [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5],
  [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3], [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2],
  [9, 5, 6, 9, 6, 0, 0, 6, 2], [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8],
  [1, 5, 6, 2, 1, 6], [1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6],
  [10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0], [0, 3, 8, 5, 6, 10], [10, 5, 6],
  [11, 5, 10, 7, 5, 11], [11, 5, 10, 11, 7, 5, 8, 3, 0], [5, 11, 7, 5, 10, 11, 1, 9, 0],
  [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1], [11, 1, 2, 11, 7, 1, 7, 5, 1],
  [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11], [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7],
  [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2], [2, 5, 10, 2, 3, 5, 3, 7, 5],
  [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5], [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2],
  [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2], [1, 3, 5, 3, 7, 5],
  [0, 8, 7, 0, 7, 1, 1, 7, 5], [9, 0, 3, 9, 3, 5, 5, 3, 7], [9, 8, 7, 5, 9, 7],
  [5, 8, 4, 5, 10, 8, 10, 11, 8], [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0],
  [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5],
  [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4], [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8],
  [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11],
  [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5], [9, 4, 5, 2, 11, 3],
  [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4], [5, 10, 2, 5, 2, 4, 4, 2, 0],
  [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2],
  [8, 4, 5, 8, 5, 3, 3, 5, 1], [0, 4, 5, 1, 0, 5], [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5],
  [9, 4, 5], [4, 11, 7, 4, 9, 11, 9, 10, 11], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11],
  [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11],
  [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4], [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2],
  [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3], [11, 7, 4, 11, 4, 2, 2, 4, 0],
  [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4], [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9],
  [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7],
  [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10], [1, 10, 2, 8, 7, 4],
  [4, 9, 1, 4, 1, 7, 7, 1, 3], [4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1], [4, 0, 3, 7, 4, 3],
  [4, 8, 7], [9, 10, 8, 10, 11, 8], [3, 0, 9, 3, 9, 11, 11, 9, 10],
  [0, 1, 10, 0, 10, 8, 8, 10, 11], [3, 1, 10, 11, 3, 10], [1, 2, 11, 1, 11, 9, 9, 11, 8],
  [3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9], [0, 2, 11, 8, 0, 11], [3, 2, 11],
  [2, 3, 8, 2, 8, 10, 10, 8, 9], [9, 10, 2, 0, 9, 2], [2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8],
  [1, 10, 2], [1, 3, 8, 9, 1, 8], [0, 9, 1], [0, 3, 8], [],
];
