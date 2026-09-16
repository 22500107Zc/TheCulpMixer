/**
 * The operators, under sustained abuse.
 *
 * Every test in this suite so far asks an operator to do a reasonable thing
 * and checks it did. That is the wrong shape for finding the bugs that lose
 * somebody's work, because nobody loses their work doing a reasonable thing.
 * They lose it on the tenth operation of an afternoon, on a mesh that four
 * earlier operators have already reshaped, with a selection that means
 * something slightly different than it did when it was made.
 *
 * So this drives long random chains of real operators over real meshes and
 * checks the invariants after EVERY step, not at the end:
 *
 *   - no NaN or Infinity in any position, ever, because one NaN vertex
 *     poisons bounds, normals, the BVH and the renderer, and the scene looks
 *     fine until it silently does not
 *   - every face index inside the vertex array, because an out-of-range index
 *     is a crash the moment anything walks the topology
 *   - no face with fewer than three corners, and no duplicate corner within a
 *     face, both of which produce degenerate normals
 *   - the mesh still serialises and comes back identical, because that is
 *     what Save does
 *
 * Seeded, so a failure names the exact chain that caused it and can be
 * replayed rather than hunted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '../src/mesh/Mesh';
import { buildPrimitive } from '../src/mesh/primitives';
import { bevelEdges, bevelVertices } from '../src/mesh/bevel';
import { dissolveCoplanar, dropSlivers, repairManifold, stitchTJunctions } from '../src/mesh/boolean';
import { bisect, pokeFaces, spinEdges, symmetrize } from '../src/mesh/modeling';
import { catmullClark, deleteEdges, deleteFaces, deleteVertices, dissolveFaces, duplicateFaces, extrudeEdges, extrudeFaces, flipNormals, insetFaces, insetFacesIndividual, loopCut, makeFace, mergeByDistance, mergeVertices, recalculateNormals, smoothVertices, subdivideFaces, triangulateFaces } from '../src/mesh/ops';
import { decimate } from '../src/mesh/decimate';
import { meshBoolean } from '../src/mesh/csg';
import { Mat4, Vec3 } from '../src/core/math';

/**
 * How hard to push. The committed default keeps `npm test` quick; a deep run
 * is one environment variable away, which is what gets done before a release.
 */
const DEPTH = Number(process.env.CULPMIXER_FUZZ ?? '1') || 1;

/** A small deterministic generator, so every failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const PRIMITIVES = ['cube', 'uvSphere', 'icoSphere', 'cylinder', 'cone', 'torus', 'plane', 'grid', 'circle'] as const;

/**
 * Everything that must be true of a mesh at all times.
 *
 * Returns a description of the first violation, or null. Written to return
 * rather than throw so the caller can say which step in the chain broke it.
 */
function violation(mesh: Mesh): string | null {
  const n = mesh.positions.length;
  for (let i = 0; i < n; i++) {
    const p = mesh.positions[i];
    if (!p) return `vertex ${i} is missing`;
    for (const axis of ['x', 'y', 'z'] as const) {
      const v = p[axis];
      if (!Number.isFinite(v)) return `vertex ${i}.${axis} is ${v}`;
      // A coordinate this large is not a model any more; it is a runaway
      // operator, and it destroys the precision of everything near it.
      if (Math.abs(v) > 1e9) return `vertex ${i}.${axis} ran away to ${v}`;
    }
  }
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    if (!face) return `face ${f} is missing`;
    if (face.length < 3) return `face ${f} has only ${face.length} corners`;
    const seen = new Set<number>();
    for (const c of face) {
      if (!Number.isInteger(c)) return `face ${f} has a non-integer corner ${c}`;
      if (c < 0 || c >= n) return `face ${f} references vertex ${c} of ${n}`;
      if (seen.has(c)) return `face ${f} uses vertex ${c} twice`;
      seen.add(c);
    }
  }
  return null;
}

/** Indices that exist, plus the awkward ones that should be ignored. */
function someFaces(mesh: Mesh, r: () => number): number[] {
  const out: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) if (r() < 0.35) out.push(f);
  if (out.length === 0 && mesh.faces.length) out.push(0);
  // Stale indices are the realistic case: a selection made before an operator
  // that removed geometry. They must be ignored, not followed.
  if (r() < 0.25) out.push(mesh.faces.length + Math.floor(r() * 50));
  if (r() < 0.15) out.push(-1);
  return out;
}

function someVerts(mesh: Mesh, r: () => number): number[] {
  const out: number[] = [];
  for (let v = 0; v < mesh.positions.length; v++) if (r() < 0.3) out.push(v);
  if (out.length === 0 && mesh.positions.length) out.push(0);
  if (r() < 0.25) out.push(mesh.positions.length + Math.floor(r() * 50));
  if (r() < 0.15) out.push(-1);
  return out;
}

function someEdges(mesh: Mesh, r: () => number): number[] {
  const topo = mesh.topology();
  const out: number[] = [];
  for (let e = 0; e < topo.edges.length; e++) if (r() < 0.3) out.push(e);
  if (out.length === 0 && topo.edges.length) out.push(0);
  if (r() < 0.25) out.push(topo.edges.length + Math.floor(r() * 50));
  if (r() < 0.15) out.push(-1);
  return out;
}

/** A number, including the ones that break arithmetic. */
function awkwardNumber(r: () => number): number {
  const roll = r();
  if (roll < 0.08) return 0;
  if (roll < 0.14) return -Math.abs(r() * 3);
  if (roll < 0.18) return 1e-12;
  if (roll < 0.22) return 1e7;
  return r() * 2;
}

interface Step { name: string; run: (mesh: Mesh, r: () => number) => Mesh | void }

const STEPS: Step[] = [
  { name: 'extrudeFaces', run: (m, r) => { extrudeFaces(m, someFaces(m, r), awkwardNumber(r)); } },
  { name: 'insetFaces', run: (m, r) => { insetFaces(m, someFaces(m, r), awkwardNumber(r), awkwardNumber(r) - 1); } },
  { name: 'insetFacesIndividual', run: (m, r) => { insetFacesIndividual(m, someFaces(m, r), awkwardNumber(r), 0); } },
  { name: 'subdivideFaces', run: (m, r) => { subdivideFaces(m, someFaces(m, r)); } },
  { name: 'pokeFaces', run: (m, r) => { pokeFaces(m, someFaces(m, r)); } },
  { name: 'deleteFaces', run: (m, r) => { deleteFaces(m, someFaces(m, r)); } },
  { name: 'dissolveFaces', run: (m, r) => { dissolveFaces(m, someFaces(m, r)); } },
  { name: 'duplicateFaces', run: (m, r) => { duplicateFaces(m, someFaces(m, r)); } },
  { name: 'triangulateFaces', run: (m, r) => { triangulateFaces(m, someFaces(m, r)); } },
  { name: 'deleteVertices', run: (m, r) => { deleteVertices(m, someVerts(m, r)); } },
  { name: 'smoothVertices', run: (m, r) => { smoothVertices(m, someVerts(m, r), awkwardNumber(r), 1); } },
  { name: 'mergeByDistance', run: (m, r) => { mergeByDistance(m, someVerts(m, r), awkwardNumber(r) * 0.1); } },
  { name: 'mergeVertices', run: (m, r) => { mergeVertices(m, someVerts(m, r)); } },
  { name: 'makeFace', run: (m, r) => { makeFace(m, someVerts(m, r)); } },
  { name: 'deleteEdges', run: (m, r) => { deleteEdges(m, someEdges(m, r)); } },
  { name: 'extrudeEdges', run: (m, r) => { extrudeEdges(m, someEdges(m, r), awkwardNumber(r)); } },
  { name: 'bevelEdges', run: (m, r) => { bevelEdges(m, someEdges(m, r), awkwardNumber(r) * 0.1, 1 + Math.floor(r() * 4), r()); } },
  { name: 'bevelVertices', run: (m, r) => { bevelVertices(m, someVerts(m, r), awkwardNumber(r) * 0.1); } },
  { name: 'spinEdges', run: (m, r) => { spinEdges(m, someEdges(m, r), Vec3.axis(Math.floor(r() * 3) as 0 | 1 | 2), m.centroid(), Math.PI * r(), 2 + Math.floor(r() * 4)); } },
  { name: 'loopCut', run: (m, r) => { const e = someEdges(m, r)[0] ?? 0; loopCut(m, e, 1 + Math.floor(r() * 3)); } },
  { name: 'flipNormals', run: (m, r) => { flipNormals(m, someFaces(m, r)); } },
  { name: 'recalculateNormals', run: (m) => { recalculateNormals(m); } },
  { name: 'catmullClark', run: (m) => { if (m.faces.length < 400) catmullClark(m); } },
  { name: 'decimate', run: (m, r) => decimate(m, 0.2 + r() * 0.7) },
  { name: 'dropSlivers', run: (m) => { dropSlivers(m); } },
  { name: 'stitchTJunctions', run: (m) => { stitchTJunctions(m); } },
  { name: 'dissolveCoplanar', run: (m) => { dissolveCoplanar(m); } },
  { name: 'repairManifold', run: (m) => { repairManifold(m); } },
  { name: 'symmetrize', run: (m, r) => { symmetrize(m, Math.floor(r() * 3) as 0 | 1 | 2, r() < 0.5); } },
  { name: 'bisect', run: (m, r) => {
    const n = new Vec3(r() - 0.5, r() - 0.5, r() - 0.5);
    bisect(m, n.lengthSq() < 1e-9 ? new Vec3(0, 0, 1) : n, (r() - 0.5) * 2, {});
  } },
];

test('a long random chain of operators never corrupts a mesh', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 60 * DEPTH; seed++) {
    const r = rng(seed * 7919);
    const kind = PRIMITIVES[Math.floor(r() * PRIMITIVES.length)];
    let mesh: Mesh;
    try {
      mesh = buildPrimitive(kind);
    } catch (err) {
      failures.push(`seed ${seed}: building a ${kind} threw ${(err as Error).message}`);
      continue;
    }
    const chain: string[] = [];
    for (let step = 0; step < 24 + 8 * (DEPTH - 1); step++) {
      if (mesh.positions.length === 0 || mesh.faces.length === 0) break;
      // Meshes that have grown past anything a person would make are not the
      // subject here, and subdividing them wastes the whole budget.
      if (mesh.faces.length > 6000) break;
      const op = STEPS[Math.floor(r() * STEPS.length)];
      chain.push(op.name);
      try {
        const replaced = op.run(mesh, r);
        if (replaced instanceof Mesh) mesh = replaced;
      } catch (err) {
        failures.push(`seed ${seed} step ${step}: ${chain.join(' > ')} THREW ${(err as Error).message}`);
        break;
      }
      const bad = violation(mesh);
      if (bad) {
        failures.push(`seed ${seed} step ${step}: ${chain.join(' > ')} LEFT ${bad}`);
        break;
      }
    }
  }
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} chains corrupted or crashed`);
});

test('a mesh survives a round trip through its own serialisation at every stage', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 25 * DEPTH; seed++) {
    const r = rng(seed * 104729);
    let mesh = buildPrimitive(PRIMITIVES[Math.floor(r() * PRIMITIVES.length)]);
    const chain: string[] = [];
    for (let step = 0; step < 8; step++) {
      if (!mesh.faces.length || mesh.faces.length > 4000) break;
      const op = STEPS[Math.floor(r() * STEPS.length)];
      chain.push(op.name);
      try {
        const replaced = op.run(mesh, r);
        if (replaced instanceof Mesh) mesh = replaced;
      } catch {
        break;
      }
      if (violation(mesh)) break;

      // What Save actually does. A mesh that cannot make the round trip is a
      // file that opens as something other than what was saved.
      let back: Mesh;
      try {
        back = Mesh.fromJSON(JSON.parse(JSON.stringify(mesh.toJSON())));
      } catch (err) {
        failures.push(`seed ${seed} after ${chain.join(' > ')}: reload threw ${(err as Error).message}`);
        break;
      }
      if (back.positions.length !== mesh.positions.length || back.faces.length !== mesh.faces.length) {
        failures.push(
          `seed ${seed} after ${chain.join(' > ')}: saved ${mesh.positions.length}v/${mesh.faces.length}f, `
          + `reloaded ${back.positions.length}v/${back.faces.length}f`,
        );
        break;
      }
      const bad = violation(back);
      if (bad) {
        failures.push(`seed ${seed} after ${chain.join(' > ')}: the reloaded mesh has ${bad}`);
        break;
      }
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} round trips lost or corrupted data`);
});

test('a clone is never entangled with the mesh it came from', () => {
  // Undo is built on clones. A clone that shares an array with its original
  // means undo silently does nothing, which is the worst possible bug here:
  // the work is gone and the history says it was restored.
  const failures: string[] = [];
  for (let seed = 1; seed <= 20 * DEPTH; seed++) {
    const r = rng(seed * 31337);
    const mesh = buildPrimitive(PRIMITIVES[Math.floor(r() * PRIMITIVES.length)]);
    const before = mesh.clone();
    const snapshot = JSON.stringify(before.toJSON());
    for (let step = 0; step < 6; step++) {
      if (!mesh.faces.length || mesh.faces.length > 3000) break;
      const op = STEPS[Math.floor(r() * STEPS.length)];
      try {
        op.run(mesh, r);
      } catch {
        break;
      }
    }
    if (JSON.stringify(before.toJSON()) !== snapshot) {
      failures.push(`seed ${seed}: operating on a mesh changed a clone taken beforehand`);
    }
  }
  assert.deepEqual(failures, [], 'undo would silently restore nothing');
});

test('booleans between real shapes do not produce corrupt geometry', () => {
  const failures: string[] = [];
  const ops = ['union', 'difference', 'intersect'] as const;
  for (let seed = 1; seed <= 24 * DEPTH; seed++) {
    const r = rng(seed * 6007);
    const a = buildPrimitive(PRIMITIVES[Math.floor(r() * PRIMITIVES.length)]);
    const b = buildPrimitive(PRIMITIVES[Math.floor(r() * PRIMITIVES.length)]);
    // Overlapping, touching exactly, and completely apart are all cases a
    // person hits, and the exact touch is the one that breaks solvers.
    const offset = [0.3, 1.0, 5.0][Math.floor(r() * 3)];
    b.transform(Mat4.translation(new Vec3(offset, offset * 0.5, 0)));
    const op = ops[Math.floor(r() * ops.length)];
    let out: Mesh | null = null;
    try {
      out = meshBoolean(a, b, op);
    } catch (err) {
      failures.push(`seed ${seed}: ${op} at ${offset} threw ${(err as Error).message}`);
      continue;
    }
    if (!(out instanceof Mesh)) continue;
    const bad = violation(out);
    if (bad) failures.push(`seed ${seed}: ${op} at ${offset} produced ${bad}`);
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} boolean results were corrupt`);
});
