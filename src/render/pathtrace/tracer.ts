import { BandRequest, BandResult, LIGHT_STRIDE, MATERIAL_STRIDE, RenderSettings, TraceScene, MAT_TEXTURE, MAT_UV_OFFSET, MAT_UV_SCALE } from './types';

/**
 * A progressive path tracer.
 *
 * Triangles go into a binned-SAH BVH; each pixel shoots paths that bounce
 * through a metallic-roughness GGX BSDF. Analytic lights are sampled directly
 * (next event estimation) with a shadow ray, and the sky contributes whenever
 * a ray escapes, so a scene with no lights at all still renders rather than
 * coming back black.
 *
 * Everything is plain typed arrays and free functions: the same code runs on
 * the main thread and inside a worker, and the hot loops stay monomorphic.
 */

const EPS = 1e-4;

// ------------------------------------------------------------------ RNG

/** PCG-derived hash; seeding per sample keeps the noise decorrelated. */
function hashInit(a: number, b: number, c: number): number {
  let h = (a * 0x9e3779b1) ^ (b * 0x85ebca6b) ^ (c * 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed || 1) >>> 0;
  }

  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 4294967296;
  }
}

// ------------------------------------------------------------------ BVH

export interface Bvh {
  /** 6 floats per node: min xyz, max xyz. */
  bounds: Float32Array;
  /** Left child index, or -1 for a leaf. */
  left: Int32Array;
  right: Int32Array;
  /** For leaves: first triangle slot and count in `order`. */
  start: Int32Array;
  count: Int32Array;
  order: Int32Array;
  nodeCount: number;
}

const BINS = 12;

export function buildBvh(positions: Float32Array): Bvh {
  const triCount = positions.length / 9;
  const order = new Int32Array(triCount);
  const centroid = new Float32Array(triCount * 3);
  const triMin = new Float32Array(triCount * 3);
  const triMax = new Float32Array(triCount * 3);

  for (let t = 0; t < triCount; t++) {
    order[t] = t;
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      const v0 = positions[o + a];
      const v1 = positions[o + 3 + a];
      const v2 = positions[o + 6 + a];
      const lo = Math.min(v0, v1, v2);
      const hi = Math.max(v0, v1, v2);
      triMin[t * 3 + a] = lo;
      triMax[t * 3 + a] = hi;
      centroid[t * 3 + a] = (lo + hi) * 0.5;
    }
  }

  const maxNodes = Math.max(1, triCount * 2);
  const bounds = new Float32Array(maxNodes * 6);
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nodeCount = 0;

  const nodeBounds = (node: number, from: number, to: number): void => {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = from; i < to; i++) {
      const t = order[i];
      if (triMin[t * 3] < x0) x0 = triMin[t * 3];
      if (triMin[t * 3 + 1] < y0) y0 = triMin[t * 3 + 1];
      if (triMin[t * 3 + 2] < z0) z0 = triMin[t * 3 + 2];
      if (triMax[t * 3] > x1) x1 = triMax[t * 3];
      if (triMax[t * 3 + 1] > y1) y1 = triMax[t * 3 + 1];
      if (triMax[t * 3 + 2] > z1) z1 = triMax[t * 3 + 2];
    }
    bounds[node * 6] = x0;
    bounds[node * 6 + 1] = y0;
    bounds[node * 6 + 2] = z0;
    bounds[node * 6 + 3] = x1;
    bounds[node * 6 + 4] = y1;
    bounds[node * 6 + 5] = z1;
  };

  const stack: { node: number; from: number; to: number }[] = [];
  const root = nodeCount++;
  nodeBounds(root, 0, triCount);
  start[root] = 0;
  count[root] = triCount;
  stack.push({ node: root, from: 0, to: triCount });

  while (stack.length) {
    const { node, from, to } = stack.pop()!;
    const n = to - from;
    if (n <= 4 || nodeCount + 2 > maxNodes) continue;

    // Split on the axis with the widest spread of centroids.
    let axis = 0;
    let bestSpread = -1;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = from; i < to; i++) {
      const t = order[i];
      for (let a = 0; a < 3; a++) {
        const c = centroid[t * 3 + a];
        if (c < lo[a]) lo[a] = c;
        if (c > hi[a]) hi[a] = c;
      }
    }
    for (let a = 0; a < 3; a++) {
      const spread = hi[a] - lo[a];
      if (spread > bestSpread) {
        bestSpread = spread;
        axis = a;
      }
    }
    if (bestSpread <= 1e-12) continue;

    // Binned surface-area heuristic.
    const binCount = new Int32Array(BINS);
    const binBox = new Float32Array(BINS * 6);
    for (let b = 0; b < BINS; b++) {
      binBox[b * 6] = binBox[b * 6 + 1] = binBox[b * 6 + 2] = Infinity;
      binBox[b * 6 + 3] = binBox[b * 6 + 4] = binBox[b * 6 + 5] = -Infinity;
    }
    const scale = BINS / bestSpread;
    for (let i = from; i < to; i++) {
      const t = order[i];
      let b = Math.floor((centroid[t * 3 + axis] - lo[axis]) * scale);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      binCount[b]++;
      for (let a = 0; a < 3; a++) {
        if (triMin[t * 3 + a] < binBox[b * 6 + a]) binBox[b * 6 + a] = triMin[t * 3 + a];
        if (triMax[t * 3 + a] > binBox[b * 6 + 3 + a]) binBox[b * 6 + 3 + a] = triMax[t * 3 + a];
      }
    }
    const area = (bx: Float32Array, o: number): number => {
      const dx = Math.max(0, bx[o + 3] - bx[o]);
      const dy = Math.max(0, bx[o + 4] - bx[o + 1]);
      const dz = Math.max(0, bx[o + 5] - bx[o + 2]);
      return 2 * (dx * dy + dy * dz + dz * dx);
    };
    const leftArea = new Float32Array(BINS);
    const leftCount = new Int32Array(BINS);
    const acc = new Float32Array(6);
    acc[0] = acc[1] = acc[2] = Infinity;
    acc[3] = acc[4] = acc[5] = -Infinity;
    let running = 0;
    for (let b = 0; b < BINS; b++) {
      for (let a = 0; a < 3; a++) {
        if (binBox[b * 6 + a] < acc[a]) acc[a] = binBox[b * 6 + a];
        if (binBox[b * 6 + 3 + a] > acc[3 + a]) acc[3 + a] = binBox[b * 6 + 3 + a];
      }
      running += binCount[b];
      leftArea[b] = area(acc, 0);
      leftCount[b] = running;
    }
    acc[0] = acc[1] = acc[2] = Infinity;
    acc[3] = acc[4] = acc[5] = -Infinity;
    let bestCost = Infinity;
    let bestBin = -1;
    let rightRunning = 0;
    for (let b = BINS - 1; b > 0; b--) {
      for (let a = 0; a < 3; a++) {
        if (binBox[b * 6 + a] < acc[a]) acc[a] = binBox[b * 6 + a];
        if (binBox[b * 6 + 3 + a] > acc[3 + a]) acc[3 + a] = binBox[b * 6 + 3 + a];
      }
      rightRunning += binCount[b];
      const lc = leftCount[b - 1];
      if (lc === 0 || rightRunning === 0) continue;
      const cost = leftArea[b - 1] * lc + area(acc, 0) * rightRunning;
      if (cost < bestCost) {
        bestCost = cost;
        bestBin = b;
      }
    }
    if (bestBin < 0) continue;

    // Partition in place around the chosen bin.
    let i = from;
    let j = to - 1;
    while (i <= j) {
      const t = order[i];
      let b = Math.floor((centroid[t * 3 + axis] - lo[axis]) * scale);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      if (b < bestBin) {
        i++;
      } else {
        order[i] = order[j];
        order[j] = t;
        j--;
      }
    }
    const mid = i;
    if (mid === from || mid === to) continue;

    const l = nodeCount++;
    const r = nodeCount++;
    nodeBounds(l, from, mid);
    nodeBounds(r, mid, to);
    start[l] = from;
    count[l] = mid - from;
    start[r] = mid;
    count[r] = to - mid;
    left[node] = l;
    right[node] = r;
    count[node] = 0;
    stack.push({ node: l, from, to: mid });
    stack.push({ node: r, from: mid, to });
  }

  return { bounds, left, right, start, count, order, nodeCount };
}

// ------------------------------------------------------------ intersection

interface Hit {
  t: number;
  tri: number;
  u: number;
  v: number;
}

const noHit: Hit = { t: Infinity, tri: -1, u: 0, v: 0 };

function slabTest(
  b: Float32Array, node: number,
  ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tMax: number,
): number {
  const o = node * 6;
  let t0 = (b[o] - ox) * ix;
  let t1 = (b[o + 3] - ox) * ix;
  let lo = Math.min(t0, t1);
  let hi = Math.max(t0, t1);
  t0 = (b[o + 1] - oy) * iy;
  t1 = (b[o + 4] - oy) * iy;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));
  t0 = (b[o + 2] - oz) * iz;
  t1 = (b[o + 5] - oz) * iz;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));
  if (hi < Math.max(lo, 0) || lo > tMax) return Infinity;
  return Math.max(lo, 0);
}

const traversal = new Int32Array(128);

function intersect(
  scene: TraceScene, bvh: Bvh,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  tMax: number, anyHit: boolean, out: Hit,
): boolean {
  const pos = scene.positions;
  const ix = 1 / (dx || 1e-20);
  const iy = 1 / (dy || 1e-20);
  const iz = 1 / (dz || 1e-20);
  let best = tMax;
  out.t = tMax;
  out.tri = -1;
  let sp = 0;
  traversal[sp++] = 0;

  while (sp > 0) {
    const node = traversal[--sp];
    if (slabTest(bvh.bounds, node, ox, oy, oz, ix, iy, iz, best) === Infinity) continue;
    const l = bvh.left[node];
    if (l >= 0) {
      if (sp + 2 < traversal.length) {
        traversal[sp++] = l;
        traversal[sp++] = bvh.right[node];
      }
      continue;
    }
    const from = bvh.start[node];
    const to = from + bvh.count[node];
    for (let i = from; i < to; i++) {
      const t = bvh.order[i];
      const o = t * 9;
      const ax = pos[o];
      const ay = pos[o + 1];
      const az = pos[o + 2];
      const e1x = pos[o + 3] - ax;
      const e1y = pos[o + 4] - ay;
      const e1z = pos[o + 5] - az;
      const e2x = pos[o + 6] - ax;
      const e2y = pos[o + 7] - ay;
      const e2z = pos[o + 8] - az;
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax;
      const ty = oy - ay;
      const tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-7 || u > 1 + 1e-7) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-7 || u + v > 1 + 1e-7) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist <= EPS || dist >= best) continue;
      best = dist;
      out.t = dist;
      out.tri = t;
      out.u = u;
      out.v = v;
      if (anyHit) return true;
    }
  }
  return out.tri >= 0;
}

// --------------------------------------------------------------- shading

function normalize3(v: Float64Array, o = 0): void {
  const l = Math.hypot(v[o], v[o + 1], v[o + 2]) || 1;
  v[o] /= l;
  v[o + 1] /= l;
  v[o + 2] /= l;
}

/** Build an orthonormal basis around `n` (Duff et al.). */
function basis(nx: number, ny: number, nz: number, out: Float64Array): void {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  out[0] = 1 + sign * nx * nx * a;
  out[1] = sign * b;
  out[2] = -sign * nx;
  out[3] = b;
  out[4] = sign + ny * ny * a;
  out[5] = -ny;
}

/**
 * Environment radiance for a ray that escapes. This is the only ambient term:
 * a constant added at every hit would light the inside of a shadow just as
 * brightly as the outside, which is exactly what kills a render's contrast.
 */
function skyColor(scene: TraceScene, dz: number, out: Float64Array): void {
  const bg = scene.background;
  const s = scene.skyStrength;
  if (s <= 0) {
    out[0] = bg[0];
    out[1] = bg[1];
    out[2] = bg[2];
    return;
  }
  // Cooler overhead, warmer toward the horizon.
  const t = Math.max(0, Math.min(1, dz * 0.5 + 0.5));
  out[0] = bg[0] + s * (0.42 + 0.38 * t);
  out[1] = bg[1] + s * (0.48 + 0.40 * t);
  out[2] = bg[2] + s * (0.60 + 0.36 * t);
}

const hitScratch: Hit = { ...noHit };
const tangent = new Float64Array(6);
const dir = new Float64Array(3);
const envScratch = new Float64Array(3);
/**
 * Cap on a single scattering event's throughput multiplier. Sampling a narrow
 * GGX lobe can hand back a huge weight for one unlucky sample, and one such
 * sample is a permanent white speck in the average.
 */
const FIREFLY_CLAMP = 1.25;
/**
 * Upper bound on one sample's radiance. Specular highlights from a small
 * light are a true delta spike: unbounded in theory, and in practice a
 * permanent white pixel that no number of extra samples averages away.
 */
const SAMPLE_CLAMP = 6;

/**
 * The chance the scatter step would have picked this direction, per unit solid
 * angle. It has to mirror the sampling code below exactly — the same lobe
 * split, the same GGX distribution — or the MIS weights stop summing to one
 * and the image drifts light or dark.
 */
function bsdfPdfFor(
  nx: number, ny: number, nz: number, vx: number, vy: number, vz: number,
  lx: number, ly: number, lz: number, rough: number, metallic: number, ndl: number,
): number {
  const ndv = Math.max(1e-4, nx * vx + ny * vy + nz * vz);
  const fresnel = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
  const specProb = Math.min(0.9, Math.max(0.1, Math.max(metallic, fresnel)));

  let hx = vx + lx;
  let hy = vy + ly;
  let hz = vz + lz;
  const hl = Math.hypot(hx, hy, hz) || 1;
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const ndh = Math.max(1e-4, nx * hx + ny * hy + nz * hz);
  const vdh = Math.max(1e-4, vx * hx + vy * hy + vz * hz);
  const a = rough * rough;
  const a2 = a * a;
  const denom = ndh * ndh * (a2 - 1) + 1;
  const d = a2 / (Math.PI * denom * denom);
  // Half-vector density, converted from the half vector to the outgoing one.
  const pSpec = (d * ndh) / (4 * vdh);
  const pDiff = ndl / Math.PI;
  return specProb * pSpec + (1 - specProb) * pDiff;
}

const shadowHit: Hit = { ...noHit };
const shadowTint = new Float64Array(3);
/** Scratch for one texture lookup, reused rather than allocated per hit. */
const texel = new Float32Array(3);

/**
 * How much of a light survives the trip to a shading point, as an RGB factor
 * in `shadowTint`. Returns false when the path is fully blocked.
 *
 * A binary "did anything get in the way" is wrong the moment the scene has
 * glass in it: a window would cast the same shadow as a brick. Transmissive
 * surfaces tint the light and let the ray carry on; so does an alpha cutout,
 * proportionally. Everything else stops it.
 */
function shadowTransmittance(
  scene: TraceScene, bvh: Bvh,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number,
): boolean {
  shadowTint[0] = 1;
  shadowTint[1] = 1;
  shadowTint[2] = 1;
  let travelled = 0;
  // Bounded: a ray through a dozen panes of glass contributes nothing worth
  // the traversals, and an unbounded loop is a hang waiting to happen.
  for (let step = 0; step < 8; step++) {
    const remaining = tMax - travelled;
    if (remaining <= EPS) return true;
    if (!intersect(scene, bvh, ox, oy, oz, dx, dy, dz, remaining, false, shadowHit)) return true;
    const mi = scene.material[shadowHit.tri] * MATERIAL_STRIDE;
    const alpha = scene.materials[mi + 9];
    const transmission = scene.materials[mi + 10];
    const openness = transmission + (1 - transmission) * (1 - alpha);
    if (openness <= 0.001) return false;
    // Tinted glass colours what passes; a clear cutout does not.
    shadowTint[0] *= openness * (transmission > 0 ? scene.materials[mi] : 1);
    shadowTint[1] *= openness * (transmission > 0 ? scene.materials[mi + 1] : 1);
    shadowTint[2] *= openness * (transmission > 0 ? scene.materials[mi + 2] : 1);
    if (shadowTint[0] + shadowTint[1] + shadowTint[2] < 1e-4) return false;
    const advance = shadowHit.t + EPS * 4;
    travelled += advance;
    ox += dx * advance;
    oy += dy * advance;
    oz += dz * advance;
  }
  return true;
}

const lightPoint = new Float64Array(6);

/**
 * Pick an emissive triangle in proportion to its area and a uniform point on
 * it. Writes position into 0..2 and the geometric normal into 3..5, and
 * returns the triangle index, or -1 when the scene has no emitters.
 */
function sampleEmissive(scene: TraceScene, rng: Rng, out: Float64Array): number {
  const n = scene.emissive.length;
  if (n === 0 || scene.emissiveArea <= 0) return -1;
  // Binary search the running area sum.
  const target = rng.next() * scene.emissiveArea;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scene.emissiveCdf[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const tri = scene.emissive[lo];
  const o = tri * 9;
  // The usual square-root warp, which spreads points evenly over a triangle
  // where a naive pair of uniforms would bunch them into one corner.
  let a = rng.next();
  let b = rng.next();
  const sa = Math.sqrt(a);
  a = 1 - sa;
  b = b * sa;
  const c = 1 - a - b;
  out[0] = scene.positions[o] * a + scene.positions[o + 3] * b + scene.positions[o + 6] * c;
  out[1] = scene.positions[o + 1] * a + scene.positions[o + 4] * b + scene.positions[o + 7] * c;
  out[2] = scene.positions[o + 2] * a + scene.positions[o + 5] * b + scene.positions[o + 8] * c;
  const e1x = scene.positions[o + 3] - scene.positions[o];
  const e1y = scene.positions[o + 4] - scene.positions[o + 1];
  const e1z = scene.positions[o + 5] - scene.positions[o + 2];
  const e2x = scene.positions[o + 6] - scene.positions[o];
  const e2y = scene.positions[o + 7] - scene.positions[o + 1];
  const e2z = scene.positions[o + 8] - scene.positions[o + 2];
  let cx = e1y * e2z - e1z * e2y;
  let cy = e1z * e2x - e1x * e2z;
  let cz = e1x * e2y - e1y * e2x;
  const cl = Math.hypot(cx, cy, cz) || 1;
  out[3] = cx / cl;
  out[4] = cy / cl;
  out[5] = cz / cl;
  return tri;
}

/** Area of one triangle, for converting between area and solid-angle pdfs. */
function triangleArea(scene: TraceScene, tri: number): number {
  const o = tri * 9;
  const e1x = scene.positions[o + 3] - scene.positions[o];
  const e1y = scene.positions[o + 4] - scene.positions[o + 1];
  const e1z = scene.positions[o + 5] - scene.positions[o + 2];
  const e2x = scene.positions[o + 6] - scene.positions[o];
  const e2y = scene.positions[o + 7] - scene.positions[o + 1];
  const e2z = scene.positions[o + 8] - scene.positions[o + 2];
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  return Math.hypot(cx, cy, cz) * 0.5;
}

/**
 * The probability, per unit solid angle, that light sampling would have
 * produced this direction towards this emissive triangle. Needed to weight a
 * BSDF ray that lands on an emitter against the light sample that could have
 * found it.
 */
function emissivePdf(scene: TraceScene, tri: number, dist: number, cosAtLight: number): number {
  if (scene.emissiveArea <= 0 || cosAtLight <= 1e-6) return 0;
  const area = triangleArea(scene, tri);
  if (area <= 0) return 0;
  // Uniform over total area, converted to solid angle at the shading point.
  return (dist * dist) / (cosAtLight * scene.emissiveArea);
}
/**
 * The colour of a material's picture at one point on a triangle.
 *
 * Bilinear, wrapping, and in linear light — the pixels were converted on the
 * way in. Wrapping rather than clamping because that is what the viewport does
 * and what a tiled `uvScale` above one is for; a render that clamped where the
 * preview tiled would disagree with the screen at exactly the edges people
 * look at.
 *
 * Returns false when the material has no texture, so the caller can leave the
 * base colour alone rather than multiplying by white.
 */
function sampleTexture(
  scene: TraceScene, mi: number, uvU: number, uvV: number, out: Float32Array,
): boolean {
  const slot = scene.materials[mi + MAT_TEXTURE];
  if (slot < 0 || scene.textureIndex.length === 0) return false;
  const si = (slot | 0) * 3;
  if (si + 2 >= scene.textureIndex.length) return false;
  const base = scene.textureIndex[si];
  const w = scene.textureIndex[si + 1];
  const h = scene.textureIndex[si + 2];
  if (w <= 0 || h <= 0) return false;

  // Tiling and offset, the same transform the viewport applies.
  const su = uvU * scene.materials[mi + MAT_UV_SCALE] + scene.materials[mi + MAT_UV_OFFSET];
  const sv = uvV * scene.materials[mi + MAT_UV_SCALE + 1] + scene.materials[mi + MAT_UV_OFFSET + 1];

  // The V axis runs the other way in an image than it does in a UV layout.
  const x = su * w - 0.5;
  const y = (1 - sv) * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (n: number, size: number): number => ((n % size) + size) % size;
  const xa = wrap(x0, w);
  const xb = wrap(x0 + 1, w);
  const ya = wrap(y0, h);
  const yb = wrap(y0 + 1, h);

  const at = (px: number, py: number): number => base + (py * w + px) * 4;
  const p00 = at(xa, ya);
  const p10 = at(xb, ya);
  const p01 = at(xa, yb);
  const p11 = at(xb, yb);
  const t = scene.textures;
  for (let c = 0; c < 3; c++) {
    const top = t[p00 + c] * (1 - fx) + t[p10 + c] * fx;
    const bottom = t[p01 + c] * (1 - fx) + t[p11 + c] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return true;
}


/**
 * The balance heuristic, squared — the "power heuristic" with beta 2. Given
 * two ways of finding the same light path, it weights each by how likely it
 * was to have found it, which suppresses the variance either strategy has
 * where the other is strong.
 */
function powerHeuristic(pdfA: number, pdfB: number): number {
  const a = pdfA * pdfA;
  const b = pdfB * pdfB;
  const sum = a + b;
  return sum > 0 ? a / sum : 0;
}

/**
 * Trace one path and return its radiance. Written as a loop with an explicit
 * throughput rather than recursion so the depth limit is exact and the hot
 * path allocates nothing.
 */
function radiance(
  scene: TraceScene, bvh: Bvh, rng: Rng, maxBounces: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  out: Float64Array, feature: Float64Array | null = null,
): void {
  if (feature) {
    feature[0] = 0; feature[1] = 0; feature[2] = 0;
    feature[3] = 0; feature[4] = 0; feature[5] = 0;
    feature[6] = 0;
  }
  let tr = 1;
  let tg = 1;
  let tb = 1;
  let ar = 0;
  let ag = 0;
  let ab = 0;
  /**
   * Solid-angle pdf of the direction that got us here, or 0 for the camera
   * ray and for perfectly specular steps where light sampling cannot compete.
   */
  let bsdfPdf = 0;

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    if (!intersect(scene, bvh, ox, oy, oz, dx, dy, dz, Infinity, false, hitScratch)) {
      skyColor(scene, dz, envScratch);
      ar += tr * envScratch[0];
      ag += tg * envScratch[1];
      ab += tb * envScratch[2];
      if (feature && bounce === 0) {
        feature[0] = envScratch[0];
        feature[1] = envScratch[1];
        feature[2] = envScratch[2];
        feature[6] = 1e9;
      }
      break;
    }

    const tri = hitScratch.tri;
    const t = hitScratch.t;
    const u = hitScratch.u;
    const v = hitScratch.v;
    const w = 1 - u - v;
    const px = ox + dx * t;
    const py = oy + dy * t;
    const pz = oz + dz * t;

    const no = tri * 9;
    let nx = scene.normals[no] * w + scene.normals[no + 3] * u + scene.normals[no + 6] * v;
    let ny = scene.normals[no + 1] * w + scene.normals[no + 4] * u + scene.normals[no + 7] * v;
    let nz = scene.normals[no + 2] * w + scene.normals[no + 5] * u + scene.normals[no + 8] * v;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const backface = nx * dx + ny * dy + nz * dz > 0;
    if (backface) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const mi = scene.material[tri] * MATERIAL_STRIDE;
    let albR = scene.materials[mi];
    let albG = scene.materials[mi + 1];
    let albB = scene.materials[mi + 2];
    // The picture on the surface, if there is one. Multiplied into the base
    // colour exactly as the viewport does it, so the finished render and the
    // preview agree — which they did not, because this lookup did not exist
    // and every image texture was ignored by the final renderer.
    if (scene.uvs.length > 0 && scene.materials[mi + MAT_TEXTURE] >= 0) {
      const uo = tri * 6;
      const tu = scene.uvs[uo] * w + scene.uvs[uo + 2] * u + scene.uvs[uo + 4] * v;
      const tv = scene.uvs[uo + 1] * w + scene.uvs[uo + 3] * u + scene.uvs[uo + 5] * v;
      if (sampleTexture(scene, mi, tu, tv, texel)) {
        albR *= texel[0];
        albG *= texel[1];
        albB *= texel[2];
      }
    }
    if (scene.colors.length > 0) {
      // Painted colour multiplies in, interpolated across the triangle exactly
      // as the viewport shades it.
      const co = tri * 9;
      albR *= scene.colors[co] * w + scene.colors[co + 3] * u + scene.colors[co + 6] * v;
      albG *= scene.colors[co + 1] * w + scene.colors[co + 4] * u + scene.colors[co + 7] * v;
      albB *= scene.colors[co + 2] * w + scene.colors[co + 5] * u + scene.colors[co + 8] * v;
    }
    const metallic = scene.materials[mi + 3];
    const rough = Math.max(0.015, scene.materials[mi + 4]);
    const emitStrength = scene.materials[mi + 8];
    const alpha = scene.materials[mi + 9];
    const transmission = scene.materials[mi + 10];
    const ior = Math.max(1.0001, scene.materials[mi + 11]);

    if (feature && bounce === 0) {
      // Glass and mirrors have no surface colour worth guiding a filter with,
      // so leave their albedo white and let the normal do the work.
      const flat = transmission > 0.5 || metallic > 0.9;
      feature[0] = flat ? 1 : albR;
      feature[1] = flat ? 1 : albG;
      feature[2] = flat ? 1 : albB;
      feature[3] = nx;
      feature[4] = ny;
      feature[5] = nz;
      feature[6] = t;
    }

    if (emitStrength > 0) {
      // Emissive surfaces are sampled directly as well, so this hit and that
      // sample are two routes to the same light path. Weight by which route
      // was more likely to find it; without that, every emitter is counted
      // twice and the image comes out too bright.
      let weight = 1;
      if (bsdfPdf > 0 && scene.emissiveArea > 0) {
        const cosAtLight = Math.max(0, -(nx * dx + ny * dy + nz * dz));
        const pl = emissivePdf(scene, tri, t, cosAtLight);
        weight = pl > 0 ? powerHeuristic(bsdfPdf, pl) : 1;
      }
      ar += tr * scene.materials[mi + 5] * emitStrength * weight;
      ag += tg * scene.materials[mi + 6] * emitStrength * weight;
      ab += tb * scene.materials[mi + 7] * emitStrength * weight;
    }

    // Alpha is a cutout, not glass: the ray carries on unchanged, which is
    // what leaves and fences want and what refraction would get wrong.
    if (alpha < 1 && rng.next() > alpha) {
      ox = px + dx * EPS;
      oy = py + dy * EPS;
      oz = pz + dz * EPS;
      continue;
    }

    // ---- next event estimation against the analytic lights
    for (let li = 0; li < scene.lightCount; li++) {
      const lo = li * LIGHT_STRIDE;
      const type = scene.lights[lo + 3];
      let lx: number;
      let ly: number;
      let lz: number;
      let dist: number;
      let atten: number;
      if (type < 0.5 || type > 2.5) {
        // Point or area: jitter over the light's radius for a soft edge.
        const radius = scene.lights[lo + 7];
        const jx = (rng.next() - 0.5) * 2 * radius;
        const jy = (rng.next() - 0.5) * 2 * radius;
        const jz = (rng.next() - 0.5) * 2 * radius;
        lx = scene.lights[lo] + jx - px;
        ly = scene.lights[lo + 1] + jy - py;
        lz = scene.lights[lo + 2] + jz - pz;
        dist = Math.hypot(lx, ly, lz) || 1e-6;
        lx /= dist;
        ly /= dist;
        lz /= dist;
        atten = 1 / (4 * Math.PI * dist * dist);
        if (type > 2.5) {
          const facing = Math.max(0, -(scene.lights[lo + 8] * lx + scene.lights[lo + 9] * ly + scene.lights[lo + 10] * lz));
          atten = facing / (Math.PI * dist * dist);
        }
      } else if (type < 1.5) {
        lx = -scene.lights[lo + 8];
        ly = -scene.lights[lo + 9];
        lz = -scene.lights[lo + 10];
        const l = Math.hypot(lx, ly, lz) || 1;
        lx /= l;
        ly /= l;
        lz /= l;
        dist = 1e6;
        atten = 1;
      } else {
        lx = scene.lights[lo] - px;
        ly = scene.lights[lo + 1] - py;
        lz = scene.lights[lo + 2] - pz;
        dist = Math.hypot(lx, ly, lz) || 1e-6;
        lx /= dist;
        ly /= dist;
        lz /= dist;
        const cosA = -(scene.lights[lo + 8] * lx + scene.lights[lo + 9] * ly + scene.lights[lo + 10] * lz);
        const cone = scene.lights[lo + 11];
        const edge = cosA <= cone ? 0 : Math.min(1, (cosA - cone) / Math.max(1e-4, (1 - cone) * 0.25));
        atten = edge / (4 * Math.PI * dist * dist);
      }
      const ndl = nx * lx + ny * ly + nz * lz;
      if (ndl <= 0 || atten <= 0) continue;
      if (!shadowTransmittance(
        scene, bvh, px + nx * EPS, py + ny * EPS, pz + nz * EPS,
        lx, ly, lz, dist - EPS * 4,
      )) continue;
      const contrib = ndl * atten;
      const kd = (1 - metallic) / Math.PI;
      const spec = ggxSpecular(nx, ny, nz, -dx, -dy, -dz, lx, ly, lz, rough, metallic, albR, albG, albB);
      ar += tr * (albR * kd + spec[0]) * scene.lights[lo + 4] * contrib * shadowTint[0];
      ag += tg * (albG * kd + spec[1]) * scene.lights[lo + 5] * contrib * shadowTint[1];
      ab += tb * (albB * kd + spec[2]) * scene.lights[lo + 6] * contrib * shadowTint[2];
    }

    // ---- next event estimation against emissive surfaces
    //
    // An emission plane is how most people light an interior, and finding one
    // by chance is hopeless: a diffuse bounce lands on it about as often as it
    // covers the hemisphere. Sampling it directly turns that noise into a
    // clean estimate, and the MIS weight keeps it honest where the BSDF was
    // the better route anyway.
    if (transmission < 1 && scene.emissiveArea > 0) {
      const etri = sampleEmissive(scene, rng, lightPoint);
      if (etri >= 0) {
        let ex = lightPoint[0] - px;
        let ey = lightPoint[1] - py;
        let ez = lightPoint[2] - pz;
        const edist = Math.hypot(ex, ey, ez) || 1e-6;
        ex /= edist;
        ey /= edist;
        ez /= edist;
        const ndl = nx * ex + ny * ey + nz * ez;
        const cosAtLight = Math.abs(lightPoint[3] * ex + lightPoint[4] * ey + lightPoint[5] * ez);
        if (ndl > 0 && cosAtLight > 1e-6) {
          const pl = emissivePdf(scene, etri, edist, cosAtLight);
          if (pl > 0 && shadowTransmittance(
            scene, bvh, px + nx * EPS, py + ny * EPS, pz + nz * EPS,
            ex, ey, ez, edist - EPS * 8,
          )) {
            const emi = scene.material[etri] * MATERIAL_STRIDE;
            const es = scene.materials[emi + 8];
            const kd = (1 - metallic) / Math.PI;
            const spec = ggxSpecular(nx, ny, nz, -dx, -dy, -dz, ex, ey, ez, rough, metallic, albR, albG, albB);
            // pdf of the BSDF having chosen this same direction, for the weight.
            const pb = bsdfPdfFor(nx, ny, nz, -dx, -dy, -dz, ex, ey, ez, rough, metallic, ndl);
            const wl = powerHeuristic(pl, pb);
            const gain = Math.min(FIREFLY_CLAMP * 4, (ndl * wl) / pl);
            ar += tr * (albR * kd + spec[0]) * scene.materials[emi + 5] * es * gain * shadowTint[0];
            ag += tg * (albG * kd + spec[1]) * scene.materials[emi + 6] * es * gain * shadowTint[1];
            ab += tb * (albB * kd + spec[2]) * scene.materials[emi + 7] * es * gain * shadowTint[2];
          }
        }
      }
    }

    if (bounce === maxBounces) break;

    // ---- choose the next direction

    // Glass. The surface either reflects or refracts, in the proportion
    // Fresnel gives, and which one this ray does is decided by a coin flip
    // rather than by tracing both — splitting every glass hit in two makes the
    // path count explode through a window pane.
    if (transmission > 0 && rng.next() < transmission) {
      // `backface` told us the geometric normal faced away, which for a closed
      // solid means we are on the way out.
      const eta = backface ? ior : 1 / ior;
      const cosI = Math.min(1, Math.max(0, -(nx * dx + ny * dy + nz * dz)));
      const sinT2 = eta * eta * (1 - cosI * cosI);
      // Schlick against the real interface, so the grazing sheen on glass is
      // right rather than the metal-ish 0.04 the opaque path assumes.
      const r0 = ((ior - 1) / (ior + 1)) ** 2;
      const reflectance = sinT2 > 1 ? 1 : r0 + (1 - r0) * Math.pow(1 - cosI, 5);
      if (rng.next() < reflectance) {
        // Total internal reflection, or the reflected share of the split.
        const dn = dx * nx + dy * ny + dz * nz;
        dir[0] = dx - 2 * dn * nx;
        dir[1] = dy - 2 * dn * ny;
        dir[2] = dz - 2 * dn * nz;
      } else {
        const cosT = Math.sqrt(Math.max(0, 1 - sinT2));
        const k = eta * cosI - cosT;
        dir[0] = eta * dx + k * nx;
        dir[1] = eta * dy + k * ny;
        dir[2] = eta * dz + k * nz;
        // Tinted glass: the colour multiplies in on the way through, not on
        // every bounce off the surface.
        tr *= albR;
        tg *= albG;
        tb *= albB;
      }
      normalize3(dir);
      // A specular event: no direction has finite density, so light sampling
      // could never have produced it and MIS must not try to weight it.
      bsdfPdf = 0;
      const along = dir[0] * nx + dir[1] * ny + dir[2] * nz;
      ox = px + (along > 0 ? nx : -nx) * EPS;
      oy = py + (along > 0 ? ny : -ny) * EPS;
      oz = pz + (along > 0 ? nz : -nz) * EPS;
      dx = dir[0];
      dy = dir[1];
      dz = dir[2];
      if (bounce >= 3) {
        const p = Math.min(0.95, Math.max(tr, tg, tb));
        if (rng.next() > p) break;
        tr /= p;
        tg /= p;
        tb /= p;
      }
      continue;
    }

    const fresnel = 0.04 + (1 - 0.04) * Math.pow(1 - Math.max(0, -(nx * dx + ny * dy + nz * dz)), 5);
    // Bounded so neither lobe is ever sampled so rarely that the 1/p weight
    // of a single hit dominates the pixel's average.
    const specProb = Math.min(0.9, Math.max(0.1, Math.max(metallic, fresnel)));
    basis(nx, ny, nz, tangent);
    if (rng.next() < specProb) {
      // GGX half-vector sample around the reflection of the view ray.
      const a = rough * rough;
      const u1 = rng.next();
      const u2 = rng.next();
      const phi = 2 * Math.PI * u1;
      const cosTheta = Math.sqrt((1 - u2) / (1 + (a * a - 1) * u2));
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const hx = tangent[0] * sinTheta * Math.cos(phi) + tangent[3] * sinTheta * Math.sin(phi) + nx * cosTheta;
      const hy = tangent[1] * sinTheta * Math.cos(phi) + tangent[4] * sinTheta * Math.sin(phi) + ny * cosTheta;
      const hz = tangent[2] * sinTheta * Math.cos(phi) + tangent[5] * sinTheta * Math.sin(phi) + nz * cosTheta;
      const dh = dx * hx + dy * hy + dz * hz;
      dir[0] = dx - 2 * dh * hx;
      dir[1] = dy - 2 * dh * hy;
      dir[2] = dz - 2 * dh * hz;
      normalize3(dir);
      const ndl = dir[0] * nx + dir[1] * ny + dir[2] * nz;
      if (ndl <= 0) break;
      // Half-vector sampling: BRDF * cos / pdf collapses to F * G2 * (v·h) /
      // ((n·h)(n·v)). Using F alone (the usual shortcut) over-weights grazing
      // angles badly enough to show as fireflies.
      const ndv = Math.max(1e-4, -(nx * dx + ny * dy + nz * dz));
      const ndh = Math.max(1e-4, nx * hx + ny * hy + nz * hz);
      const vdh = Math.max(1e-4, -(dx * hx + dy * hy + dz * hz));
      const kk = (rough + 1) * (rough + 1) / 8;
      const g2 = (ndv / (ndv * (1 - kk) + kk)) * (ndl / (ndl * (1 - kk) + kk));
      const fs = Math.pow(1 - vdh, 5);
      const f0r = 0.04 + (albR - 0.04) * metallic;
      const f0g = 0.04 + (albG - 0.04) * metallic;
      const f0b = 0.04 + (albB - 0.04) * metallic;
      const shared = Math.min(FIREFLY_CLAMP, (g2 * vdh) / (ndh * ndv)) / specProb;
      tr *= (f0r + (1 - f0r) * fs) * shared;
      tg *= (f0g + (1 - f0g) * fs) * shared;
      tb *= (f0b + (1 - f0b) * fs) * shared;
      bsdfPdf = bsdfPdfFor(nx, ny, nz, -dx, -dy, -dz, dir[0], dir[1], dir[2], rough, metallic, ndl);
    } else {
      // Cosine-weighted hemisphere.
      const u1 = rng.next();
      const u2 = rng.next();
      const r = Math.sqrt(u1);
      const phi = 2 * Math.PI * u2;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      const z = Math.sqrt(Math.max(0, 1 - u1));
      dir[0] = tangent[0] * x + tangent[3] * y + nx * z;
      dir[1] = tangent[1] * x + tangent[4] * y + ny * z;
      dir[2] = tangent[2] * x + tangent[5] * y + nz * z;
      normalize3(dir);
      const kd = 1 - metallic;
      tr *= albR * kd / (1 - specProb);
      tg *= albG * kd / (1 - specProb);
      tb *= albB * kd / (1 - specProb);
      const ndl = Math.max(1e-4, dir[0] * nx + dir[1] * ny + dir[2] * nz);
      bsdfPdf = bsdfPdfFor(nx, ny, nz, -dx, -dy, -dz, dir[0], dir[1], dir[2], rough, metallic, ndl);
    }

    ox = px + nx * EPS;
    oy = py + ny * EPS;
    oz = pz + nz * EPS;
    dx = dir[0];
    dy = dir[1];
    dz = dir[2];

    // Russian roulette once the path has dimmed.
    if (bounce >= 3) {
      const p = Math.min(0.95, Math.max(tr, tg, tb));
      if (rng.next() > p) break;
      tr /= p;
      tg /= p;
      tb /= p;
    }
    if (tr + tg + tb < 1e-5) break;
  }

  out[0] = ar;
  out[1] = ag;
  out[2] = ab;
}

const specScratch: [number, number, number] = [0, 0, 0];

function ggxSpecular(
  nx: number, ny: number, nz: number, vx: number, vy: number, vz: number,
  lx: number, ly: number, lz: number, rough: number, metallic: number,
  ar: number, ag: number, ab: number,
): [number, number, number] {
  let hx = vx + lx;
  let hy = vy + ly;
  let hz = vz + lz;
  const hl = Math.hypot(hx, hy, hz) || 1;
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
  const ndv = Math.max(1e-4, nx * vx + ny * vy + nz * vz);
  const ndl = Math.max(1e-4, nx * lx + ny * ly + nz * lz);
  const vdh = Math.max(0, vx * hx + vy * hy + vz * hz);
  const a = rough * rough;
  const a2 = a * a;
  const denom = ndh * ndh * (a2 - 1) + 1;
  const d = a2 / Math.max(Math.PI * denom * denom, 1e-7);
  const k = (rough + 1) * (rough + 1) / 8;
  const g = (ndv / (ndv * (1 - k) + k)) * (ndl / (ndl * (1 - k) + k));
  const fs = Math.pow(1 - vdh, 5);
  const f0r = 0.04 + (ar - 0.04) * metallic;
  const f0g = 0.04 + (ag - 0.04) * metallic;
  const f0b = 0.04 + (ab - 0.04) * metallic;
  const common = (d * g) / Math.max(4 * ndv * ndl, 1e-4);
  specScratch[0] = common * (f0r + (1 - f0r) * fs);
  specScratch[1] = common * (f0g + (1 - f0g) * fs);
  specScratch[2] = common * (f0b + (1 - f0b) * fs);
  return specScratch;
}

// ------------------------------------------------------------ band render

const sample = new Float64Array(3);
const feature = new Float64Array(7);

/**
 * Accumulate `req.samples` samples per pixel for one horizontal band.
 * The returned buffer holds radiance *sums*, not averages, so the caller can
 * keep adding passes to it.
 */
export function renderBand(
  scene: TraceScene, bvh: Bvh, settings: RenderSettings, req: BandRequest,
): BandResult {
  const { width, height, maxBounces } = settings;
  const rows = req.y1 - req.y0;
  const data = new Float32Array(rows * width * 3);
  const albedo = new Float32Array(rows * width * 3);
  const normal = new Float32Array(rows * width * 3);
  const depth = new Float32Array(rows * width);
  const cam = scene.camera;
  const aspect = width / Math.max(1, height);
  const tanHalf = Math.tan(cam.fovY * 0.5);

  for (let y = req.y0; y < req.y1; y++) {
    for (let x = 0; x < width; x++) {
      const rng = new Rng(hashInit(x, y, req.seed));
      let r = 0;
      let g = 0;
      let b = 0;
      let far = 0;
      let fag = 0;
      let fab = 0;
      let fnx = 0;
      let fny = 0;
      let fnz = 0;
      let fd = 0;
      for (let s = 0; s < req.samples; s++) {
        const sx = (x + rng.next()) / width * 2 - 1;
        const sy = 1 - (y + rng.next()) / height * 2;
        let ox: number;
        let oy: number;
        let oz: number;
        let dx: number;
        let dy: number;
        let dz: number;
        if (cam.orthographic) {
          const h = cam.orthoHeight;
          ox = cam.origin[0] + cam.right[0] * sx * h * aspect + cam.up[0] * sy * h;
          oy = cam.origin[1] + cam.right[1] * sx * h * aspect + cam.up[1] * sy * h;
          oz = cam.origin[2] + cam.right[2] * sx * h * aspect + cam.up[2] * sy * h;
          dx = cam.forward[0];
          dy = cam.forward[1];
          dz = cam.forward[2];
        } else {
          ox = cam.origin[0];
          oy = cam.origin[1];
          oz = cam.origin[2];
          dx = cam.forward[0] + cam.right[0] * sx * tanHalf * aspect + cam.up[0] * sy * tanHalf;
          dy = cam.forward[1] + cam.right[1] * sx * tanHalf * aspect + cam.up[1] * sy * tanHalf;
          dz = cam.forward[2] + cam.right[2] * sx * tanHalf * aspect + cam.up[2] * sy * tanHalf;
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l;
          dy /= l;
          dz /= l;

          if (cam.aperture > 0) {
            // A real lens gathers over its whole opening, so every point off
            // the focal plane arrives as a disc rather than a point. Move the
            // ray's origin to a random point on that opening and re-aim it at
            // where the pinhole ray would have crossed the focal plane; what
            // is in focus stays put, everything else spreads.
            const fd = cam.focusDistance;
            const fx = ox + dx * fd;
            const fy = oy + dy * fd;
            const fz = oz + dz * fd;
            // Concentric-ish disc sample: sqrt keeps it uniform over area.
            const rr = Math.sqrt(rng.next()) * cam.aperture;
            const ra = rng.next() * Math.PI * 2;
            const lx = Math.cos(ra) * rr;
            const ly = Math.sin(ra) * rr;
            ox += cam.right[0] * lx + cam.up[0] * ly;
            oy += cam.right[1] * lx + cam.up[1] * ly;
            oz += cam.right[2] * lx + cam.up[2] * ly;
            dx = fx - ox;
            dy = fy - oy;
            dz = fz - oz;
            const fl = Math.hypot(dx, dy, dz) || 1;
            dx /= fl;
            dy /= fl;
            dz /= fl;
          }
        }
        radiance(scene, bvh, rng, maxBounces, ox, oy, oz, dx, dy, dz, sample, feature);
        r += Math.min(sample[0], SAMPLE_CLAMP);
        g += Math.min(sample[1], SAMPLE_CLAMP);
        b += Math.min(sample[2], SAMPLE_CLAMP);
        far += feature[0];
        fag += feature[1];
        fab += feature[2];
        fnx += feature[3];
        fny += feature[4];
        fnz += feature[5];
        fd += Math.min(feature[6], 1e6);
      }
      const pi = (y - req.y0) * width + x;
      const o = pi * 3;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      albedo[o] = far;
      albedo[o + 1] = fag;
      albedo[o + 2] = fab;
      normal[o] = fnx;
      normal[o + 1] = fny;
      normal[o + 2] = fnz;
      depth[pi] = fd;
    }
  }
  return { y0: req.y0, y1: req.y1, samples: req.samples, data, albedo, normal, depth };
}

/** ACES-ish tonemap plus sRGB encode, matching the viewport. */
export function tonemapToImage(
  accum: Float32Array, samples: number, width: number, height: number,
  out: Uint8ClampedArray, transparentBackground = false, coverage: Float32Array | null = null,
  exposure = 0,
): void {
  // Exposure is in stops, so one step is a doubling — the unit every camera
  // and every compositor already uses.
  const inv = (samples > 0 ? 1 / samples : 0) * Math.pow(2, exposure);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    let r = accum[p] * inv;
    let g = accum[p + 1] * inv;
    let b = accum[p + 2] * inv;
    r = (r * (2.51 * r + 0.03)) / (r * (2.43 * r + 0.59) + 0.14);
    g = (g * (2.51 * g + 0.03)) / (g * (2.43 * g + 0.59) + 0.14);
    b = (b * (2.51 * b + 0.03)) / (b * (2.43 * b + 0.59) + 0.14);
    const enc = (c: number): number => {
      const x = Math.min(1, Math.max(0, c));
      const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      return s * 255;
    };
    const o = i * 4;
    out[o] = enc(r);
    out[o + 1] = enc(g);
    out[o + 2] = enc(b);
    out[o + 3] = transparentBackground && coverage ? Math.min(255, coverage[i] * 255) : 255;
  }
}
