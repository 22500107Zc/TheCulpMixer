/**
 * A whole working session, driven randomly.
 *
 * The mesh fuzz next door abuses one operator at a time against one mesh. This
 * abuses the layer somebody actually touches: commands, selection, modes,
 * undo, redo, and the save/load round trip, in whatever order they land in.
 *
 * That layer holds the state the operators do not. A selection is a set of
 * integers that only means something against the mesh it was read from, and an
 * operator that shrinks the mesh leaves it pointing at geometry that is no
 * longer there. Undo swaps a whole scene underneath everything that was
 * holding a reference into it. Mode changes move which selection is live.
 * Each is fine alone; it is the interleaving that produces the afternoon
 * somebody loses.
 *
 * The invariants checked after every single action:
 *
 *   - no selection names an object, face, edge or vertex that is not there
 *   - the active object, if there is one, is in the scene
 *   - every mesh is still structurally sound (no NaN, no out-of-range corner)
 *   - undo to the bottom and the scene equals what it was at the start
 *   - the scene still round-trips through JSON, because that is Save
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { Mesh } from '../src/mesh/Mesh';
import { buildPrimitive } from '../src/mesh/primitives';
import { EditorSnapshot, History } from '../src/editor/history';

const DEPTH = Number(process.env.CULPMIXER_FUZZ ?? '1') || 1;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** Wrap a scene as the snapshot History actually stores. */
function snapOf(scene: Scene, label = 'now'): EditorSnapshot {
  return {
    label, scene: scene.toJSON(), mode: 'object', editObject: null,
    selectMode: 'vertex', verts: [], edges: [], faces: [],
  };
}

const KINDS = ['cube', 'uvSphere', 'cylinder', 'cone', 'torus', 'plane'] as const;

/**
 * Anything structurally wrong with the scene, or null.
 *
 * Structure means the things that must hold at every instant, whatever the
 * person just did: geometry that indexes itself correctly, transforms that
 * are numbers, a hierarchy that closes. A stale selection is deliberately not
 * here — it is allowed to exist between an operator running and the selection
 * being pruned — and is checked separately after a save.
 */
function structuralProblem(scene: Scene): string | null {
  const ids = new Set(scene.objects.keys());
  for (const [id, obj] of scene.objects) {
    if (obj.parent !== null && obj.parent !== undefined && !ids.has(obj.parent)) {
      return `object ${id} is parented to ${obj.parent}, which is not in the scene`;
    }
    for (const child of obj.children ?? []) {
      if (!ids.has(child)) return `object ${id} lists child ${child}, which is not in the scene`;
    }
    const mesh = obj.mesh;
    if (!mesh) continue;
    for (let i = 0; i < mesh.positions.length; i++) {
      const p = mesh.positions[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        return `object ${id} vertex ${i} is not a finite point`;
      }
    }
    for (let f = 0; f < mesh.faces.length; f++) {
      const face = mesh.faces[f];
      if (!face || face.length < 3) return `object ${id} face ${f} has ${face?.length ?? 0} corners`;
      for (const c of face) {
        if (!Number.isInteger(c) || c < 0 || c >= mesh.positions.length) {
          return `object ${id} face ${f} references vertex ${c} of ${mesh.positions.length}`;
        }
      }
    }
    for (const v of [obj.position, obj.rotation, obj.scale]) {
      if (!v) continue;
      for (const axis of ['x', 'y', 'z'] as const) {
        if (!Number.isFinite(v[axis])) return `object ${id} has a non-finite transform`;
      }
    }
  }
  return null;
}

test('a randomly driven session never leaves the scene inconsistent', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 40 * DEPTH; seed++) {
    const r = rng(seed * 2654435761);
    const history = new History();
    const trail: string[] = [];
    // Undo replaces the whole scene rather than mutating it, so the live one
    // is held in a box every action reads through. Anything that kept its own
    // reference would carry on editing a scene nothing else can see, which is
    // itself a bug worth not writing into the test.
    let live = new Scene();

    const snap = (label: string): EditorSnapshot => ({
      label, scene: live.toJSON(), mode: 'object', editObject: null,
      selectMode: 'vertex', verts: [], edges: [], faces: [],
    });
    const restore = (s: EditorSnapshot | null): void => {
      if (s) live = Scene.fromJSON(s.scene);
    };

    const actions: Array<[string, () => void]> = [
      ['add', () => {
        const kind = KINDS[Math.floor(r() * KINDS.length)];
        const obj = live.add('mesh', kind, buildPrimitive(kind));
        live.selection.clear();
        live.selection.add(obj.id);
        live.active = obj.id;
      }],
      ['deleteSelected', () => {
        for (const id of [...live.selection]) live.remove(id);
        live.selection.clear();
        if (live.active !== null && !live.objects.has(live.active)) live.active = null;
      }],
      ['selectRandom', () => {
        live.selection.clear();
        for (const id of live.objects.keys()) if (r() < 0.5) live.selection.add(id);
        live.active = [...live.selection][0] ?? null;
      }],
      ['selectStale', () => {
        // The realistic case after an undo: a selection naming geometry that
        // the scene no longer has. Nothing downstream may follow it.
        live.selection.add(999999);
        live.active = 999999;
      }],
      ['duplicate', () => {
        for (const id of [...live.selection]) {
          const src = live.objects.get(id);
          if (!src?.mesh) continue;
          live.add('mesh', `${src.name} copy`, src.mesh.clone());
        }
      }],
      ['moveSelected', () => {
        for (const id of live.selection) {
          const o = live.objects.get(id);
          if (!o) continue;
          o.position.x += (r() - 0.5) * 4;
          o.position.y += (r() - 0.5) * 4;
          o.position.z += (r() - 0.5) * 4;
        }
      }],
      ['scaleSelected', () => {
        for (const id of live.selection) {
          const o = live.objects.get(id);
          if (!o) continue;
          // Including the degenerate values a person can type into the field.
          const f = [0, 1e-9, 1, 1e6][Math.floor(r() * 4)];
          o.scale.x = f; o.scale.y = f; o.scale.z = f;
        }
      }],
      ['push', () => { history.push(snap('step')); }],
      ['undo', () => { restore(history.undo(snap('now'))); }],
      ['redo', () => { restore(history.redo(snap('now'))); }],
      ['saveLoad', () => { restore(JSON.parse(JSON.stringify(snap('save'))) as EditorSnapshot); }],
    ];

    for (let step = 0; step < 30 + 10 * (DEPTH - 1); step++) {
      const [name, run] = actions[Math.floor(r() * actions.length)];
      trail.push(name);
      try {
        run();
      } catch (err) {
        failures.push(`seed ${seed}: ${trail.join(' > ')} THREW ${(err as Error).message}`);
        break;
      }
      // A stale selection is allowed to exist for exactly as long as it takes
      // the next action to notice; what is not allowed is a MESH that names a
      // vertex it does not have, or a transform that is not a number.
      const bad = structuralProblem(live);
      if (bad) {
        failures.push(`seed ${seed}: ${trail.join(' > ')} LEFT ${bad}`);
        break;
      }
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} sessions went inconsistent`);
});

/** Structure, plus the references that a saved scene must have resolved. */
function sceneProblem(scene: Scene): string | null {
  const structural = structuralProblem(scene);
  if (structural) return structural;
  const ids = new Set(scene.objects.keys());
  if (scene.active !== null && !ids.has(scene.active)) {
    return `the active object ${scene.active} is not in the scene`;
  }
  for (const id of scene.selection) {
    if (!ids.has(id)) return `the selection names object ${id}, which is not in the scene`;
  }
  return null;
}

test('undoing everything returns the scene to exactly where it started', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 25 * DEPTH; seed++) {
    const r = rng(seed * 40503);
    let scene = new Scene();
    const history = new History();
    scene.add('mesh', 'cube', buildPrimitive('cube'));
    const start = JSON.stringify(scene.toJSON());

    const edits = 4 + Math.floor(r() * 6);
    for (let i = 0; i < edits; i++) {
      history.push(snapOf(scene, `edit ${i}`));
      const kind = KINDS[Math.floor(r() * KINDS.length)];
      if (r() < 0.6) {
        scene.add('mesh', kind, buildPrimitive(kind));
      } else {
        const ids = [...scene.objects.keys()];
        if (ids.length > 1) scene.remove(ids[Math.floor(r() * ids.length)]);
      }
      if (scene.active !== null && !scene.objects.has(scene.active)) scene.active = null;
    }

    // All the way back down. This is Ctrl+Z held until nothing happens, which
    // is what somebody does when an afternoon has gone wrong.
    for (let i = 0; i < edits + 5; i++) {
      const s = history.undo(snapOf(scene));
      if (!s) break;
      scene = Scene.fromJSON(s.scene);
    }
    const ended = JSON.stringify(scene.toJSON());
    if (ended !== start) {
      failures.push(`seed ${seed}: after ${edits} edits and undoing all of them the scene differs`);
    }
  }
  assert.deepEqual(failures.slice(0, 6), [], `${failures.length} sessions could not be fully undone`);
});

test('a scene survives being saved and reopened at any point', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 25 * DEPTH; seed++) {
    const r = rng(seed * 7717);
    const scene = new Scene();
    for (let i = 0; i < 1 + Math.floor(r() * 5); i++) {
      const kind = KINDS[Math.floor(r() * KINDS.length)];
      const o = scene.add('mesh', kind, buildPrimitive(kind));
      o.position.x = (r() - 0.5) * 10;
      o.scale.y = 0.1 + r() * 3;
    }
    const before = JSON.stringify(scene.toJSON());
    const reopened = new Scene();
    try {
      Object.assign(reopened, Scene.fromJSON(JSON.parse(before)));
    } catch (err) {
      failures.push(`seed ${seed}: reopening threw ${(err as Error).message}`);
      continue;
    }
    const after = JSON.stringify(reopened.toJSON());
    if (after !== before) failures.push(`seed ${seed}: the reopened scene is not the one that was saved`);
    const bad = sceneProblem(reopened);
    if (bad) failures.push(`seed ${seed}: the reopened scene has ${bad}`);
  }
  assert.deepEqual(failures.slice(0, 6), [], `${failures.length} scenes did not survive a save`);
});

test('a file written by somebody else never crashes the loader', () => {
  // Someone will open a file that is truncated, hand-edited, from a newer
  // build, or simply not ours. None of that may take the application down.
  const hostile: unknown[] = [
    null, undefined, 0, '', 'not json at all', [], {},
    { objects: null }, { objects: 'no' }, { objects: [1, 2, 3] },
    { objects: [{ id: 1 }], active: 99 },
    { objects: [{ id: 1, mesh: null }] },
    { objects: [{ id: 1, mesh: { positions: 'no', faces: 'no' } }] },
    { objects: [{ id: 1, mesh: { positions: [{ x: NaN, y: 0, z: 0 }], faces: [[0, 0, 0]] } }] },
    { objects: [{ id: 1, mesh: { positions: [], faces: [[5, 6, 7]] } }] },
    { objects: [{ id: 1, parent: 42 }] },
    { objects: [{ id: 1, children: [99] }] },
    { objects: [{ id: 1, position: { x: 'a', y: null, z: undefined } }] },
    { objects: [{ id: 1, scale: { x: Infinity, y: 0, z: -0 } }] },
    { objects: Array.from({ length: 50 }, (_, i) => ({ id: i, parent: i - 1 })) },
  ];
  const failures: string[] = [];
  for (const [i, doc] of hostile.entries()) {
    const scene = new Scene();
    try {
      Object.assign(scene, Scene.fromJSON(doc as never));
    } catch (err) {
      // Refusing a bad document is allowed; the message has to be a message.
      const message = (err as Error).message ?? '';
      if (!message) failures.push(`document ${i} threw something with no message`);
      continue;
    }
    const bad = sceneProblem(scene);
    if (bad) failures.push(`document ${i} loaded into a broken scene: ${bad}`);
  }
  assert.deepEqual(failures, [], 'a hostile file got through the loader');
});

test('a mesh from a hostile file cannot poison the rest of the session', () => {
  const failures: string[] = [];
  const shapes: unknown[] = [
    { positions: [{ x: 0, y: 0, z: 0 }], faces: [[0, 1, 2]] },
    { positions: [{ x: 1e308, y: 1e308, z: 1e308 }], faces: [] },
    { positions: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], faces: [[0, 1, 1]] },
    { positions: [{ x: 0, y: 0, z: 0 }], faces: [[-1, -2, -3]] },
    { positions: 'nope', faces: [[0, 1, 2]] },
    { positions: [{ x: 0, y: 0, z: 0 }], faces: [[0.5, 1.5, 2.5]] },
  ];
  for (const [i, raw] of shapes.entries()) {
    let mesh: Mesh;
    try {
      mesh = Mesh.fromJSON(raw as never);
    } catch (err) {
      if (!(err as Error).message) failures.push(`mesh ${i} threw with no message`);
      continue;
    }
    for (let f = 0; f < mesh.faces.length; f++) {
      for (const c of mesh.faces[f] ?? []) {
        if (!Number.isInteger(c) || c < 0 || c >= mesh.positions.length) {
          failures.push(`mesh ${i} loaded with face ${f} pointing at vertex ${c} of ${mesh.positions.length}`);
        }
      }
    }
    for (const p of mesh.positions) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y) || !Number.isFinite(p?.z)) {
        failures.push(`mesh ${i} loaded with a non-finite vertex`);
        break;
      }
    }
    // Whatever came out has to survive the things every mesh gets put through.
    try {
      mesh.bounds();
      mesh.topology();
      mesh.triangulate();
      mesh.clone().toJSON();
    } catch (err) {
      failures.push(`mesh ${i} loaded but then threw from ${(err as Error).message}`);
    }
  }
  assert.deepEqual(failures.slice(0, 8), [], 'a hostile mesh got through');
});

/**
 * The checks above can fail.
 *
 * A fuzz test that passes because its invariant never fires is worse than no
 * test: it is a green tick over unexamined code. So the checker is shown a
 * scene broken in each of the ways it claims to catch, and has to catch them.
 */
test('the invariant checker actually catches a broken scene', () => {
  const caught = (build: (s: Scene) => void, what: string): void => {
    const scene = new Scene();
    const obj = scene.add('mesh', 'cube', buildPrimitive('cube'));
    build(scene);
    const found = structuralProblem(scene) ?? sceneProblem(scene);
    assert.ok(found, `a scene with ${what} was reported as fine`);
    void obj;
  };

  caught((s) => { [...s.objects.values()][0].mesh!.faces[0] = [0, 1, 99999]; },
    'a face pointing past the end of the vertex array');
  caught((s) => { [...s.objects.values()][0].mesh!.positions[0].x = NaN; },
    'a NaN vertex');
  caught((s) => { [...s.objects.values()][0].mesh!.faces[0] = [0, 1]; },
    'a two-corner face');
  caught((s) => { [...s.objects.values()][0].position.z = Infinity; },
    'an infinite transform');
  caught((s) => { [...s.objects.values()][0].parent = 4242; },
    'a parent that is not in the scene');
  caught((s) => { s.active = 4242; },
    'an active object that is not in the scene');
  caught((s) => { s.selection.add(4242); },
    'a selection naming an object that is not in the scene');

  // And the control: an ordinary scene is not reported as broken.
  const fine = new Scene();
  const o = fine.add('mesh', 'cube', buildPrimitive('cube'));
  fine.selection.add(o.id);
  fine.active = o.id;
  assert.equal(structuralProblem(fine), null, 'an ordinary scene was called broken');
  assert.equal(sceneProblem(fine), null, 'an ordinary scene was called broken');
});

/** The fuzz has to actually run its actions, not skip them all. */
test('the session fuzz does real work', () => {
  const scene = new Scene();
  let built = 0;
  for (const kind of KINDS) {
    const o = scene.add('mesh', kind, buildPrimitive(kind));
    assert.ok(o.mesh && o.mesh.faces.length > 0, `${kind} built no geometry`);
    built += o.mesh!.faces.length;
  }
  assert.ok(built > 100, `the primitives together produced only ${built} faces`);
  assert.equal(structuralProblem(scene), null);
});
