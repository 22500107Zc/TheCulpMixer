import test from 'node:test';
import assert from 'node:assert/strict';
import { History, SnapshotStore } from '../src/editor/history';
import { RecoveryStore, memoryBackend, formatAge } from '../src/editor/recovery';
import { Scene } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { Vec3 } from '../src/core/math';
import { SelectMode } from '../src/render/Renderer';

function sceneWith(count: number, dense = false): Scene {
  const s = new Scene();
  for (let i = 0; i < count; i++) {
    const o = s.add('mesh', `cube${i}`, dense ? catmullClark(buildPrimitive('cube'), 2) : buildPrimitive('cube'));
    o.position = new Vec3(i * 3, 0, 0);
  }
  return s;
}

function snap(scene: Scene, store: SnapshotStore, label: string) {
  return {
    label,
    scene: scene.toJSON(store),
    mode: 'object' as const,
    editObject: null,
    selectMode: 'vertex' as SelectMode,
    verts: [],
    edges: [],
    faces: [],
  };
}

test('snapshots share the meshes an edit did not touch', () => {
  const scene = sceneWith(4);
  const store = new SnapshotStore();
  const first = scene.toJSON(store);

  // Edit one object.
  const target = [...scene.objects.values()][1];
  target.mesh!.positions[0].x += 1;
  target.mesh!.markDirty();
  const second = scene.toJSON(store);

  assert.notEqual(first.objects[1].mesh, second.objects[1].mesh, 'the edited mesh should be re-serialized');
  for (const i of [0, 2, 3]) {
    assert.equal(first.objects[i].mesh, second.objects[i].mesh, `object ${i} was copied for no reason`);
  }
});

test('serializing again without an edit reuses the same data', () => {
  const scene = sceneWith(2);
  const store = new SnapshotStore();
  const a = scene.toJSON(store);
  const b = scene.toJSON(store);
  assert.equal(a.objects[0].mesh, b.objects[0].mesh);
  assert.equal(a.objects[1].mesh, b.objects[1].mesh);
});

test('sharing does not leak between restored scenes', () => {
  // Restoring has to deep-copy: if a restored mesh aliased the snapshot's
  // arrays, the next edit would silently rewrite history.
  const scene = sceneWith(1);
  const store = new SnapshotStore();
  const saved = scene.toJSON(store);
  const restored = Scene.fromJSON(saved);
  const mesh = [...restored.objects.values()][0].mesh!;
  mesh.positions[0].x = 99;
  mesh.faces[0].push(0);
  assert.notEqual(saved.objects[0].mesh!.positions[0], 99);
  assert.equal(saved.objects[0].mesh!.faces[0].length, 4);
});

test('history stays inside its memory budget by dropping the oldest steps', () => {
  const scene = sceneWith(1, true);
  const history = new History(64, 1);
  for (let i = 0; i < 5; i++) {
    history.push(snap(scene, history.store, `step ${i}`));
    scene.objects.values().next().value!.mesh!.positions[0].x += 1;
    scene.objects.values().next().value!.mesh!.markDirty();
  }
  // A one-byte budget cannot hold anything, but undo has to stay possible.
  assert.equal(history.depth, 1);
  assert.equal(history.nextUndoLabel, 'step 4');
  assert.ok(history.canUndo);
});

test('a generous budget keeps every step', () => {
  const scene = sceneWith(1);
  const history = new History(64, 1024 * 1024 * 1024);
  for (let i = 0; i < 10; i++) history.push(snap(scene, history.store, `step ${i}`));
  assert.equal(history.depth, 10);
});

test('the step limit still applies', () => {
  const scene = sceneWith(1);
  const history = new History(3, 1024 * 1024 * 1024);
  for (let i = 0; i < 10; i++) history.push(snap(scene, history.store, `step ${i}`));
  assert.equal(history.depth, 3);
  assert.equal(history.nextUndoLabel, 'step 9');
});

test('shared meshes are only counted once against the budget', () => {
  const scene = sceneWith(3, true);
  const history = new History(64, 1024 * 1024 * 1024);
  history.push(snap(scene, history.store, 'one'));
  const single = history.footprint();
  for (let i = 0; i < 9; i++) history.push(snap(scene, history.store, `more ${i}`));
  assert.equal(history.depth, 10);
  assert.equal(history.footprint(), single, 'ten snapshots of an unchanged scene should cost one');
});

// ------------------------------------------------------------- recovery

test('recovery keeps a rolling set of copies, newest first', async () => {
  const store = new RecoveryStore(3);
  store.use(memoryBackend());
  for (let i = 0; i < 5; i++) {
    const scene = sceneWith(i + 1);
    const res = await store.save(scene.toJSON(), `save ${i}`);
    assert.ok(res.ok, res.reason);
    // Slots are keyed by timestamp, so keep them distinct.
    await new Promise((r) => setTimeout(r, 2));
  }
  const slots = await store.list();
  assert.equal(slots.length, 3, 'older copies should have been pruned');
  assert.ok(slots[0].savedAt >= slots[1].savedAt);
  assert.equal(slots[0].objectCount, 5);
});

test('the newest copy round-trips back into a scene', async () => {
  const store = new RecoveryStore();
  store.use(memoryBackend());
  const scene = sceneWith(2);
  await store.save(scene.toJSON(), 'Autosave');
  const rec = await store.latest();
  assert.ok(rec);
  const back = Scene.fromJSON(rec!.scene);
  assert.equal(back.objects.size, 2);
  assert.equal([...back.objects.values()][0].mesh!.faceCount, 6);
});

test('a backend that refuses every write reports failure instead of throwing', async () => {
  const store = new RecoveryStore();
  const broken = memoryBackend();
  broken.put = async () => {
    throw new Error('quota exceeded');
  };
  store.use(broken);
  const res = await store.save(sceneWith(1).toJSON(), 'Autosave');
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /quota/i);
  assert.deepEqual(await store.list(), []);
});

test('overlapping saves do not interleave', async () => {
  const store = new RecoveryStore(10);
  const backend = memoryBackend();
  const inner = backend.put.bind(backend);
  let inFlight = 0;
  backend.put = async (rec) => {
    inFlight++;
    assert.equal(inFlight, 1, 'two saves ran at once');
    await new Promise((r) => setTimeout(r, 1));
    await inner(rec);
    inFlight--;
  };
  store.use(backend);
  await Promise.all([1, 2, 3].map((i) => store.save(sceneWith(i).toJSON(), `save ${i}`)));
  assert.ok((await store.list()).length >= 1);
});

test('discard clears the copies', async () => {
  const store = new RecoveryStore();
  store.use(memoryBackend());
  await store.save(sceneWith(1).toJSON(), 'Autosave');
  assert.equal((await store.list()).length, 1);
  await store.discard();
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.latest(), null);
});

test('ages read the way a person would say them', () => {
  assert.equal(formatAge(5000), '5s ago');
  assert.equal(formatAge(120000), '2 min ago');
  assert.equal(formatAge(3 * 3600 * 1000), '3 h ago');
  assert.equal(formatAge(2 * 24 * 3600 * 1000), '2 days ago');
});

// --------------------------------------------- what the history actually holds

/** A base64-ish payload of a given size, so a fixture can carry a real image. */
function fakeImage(kb: number): string {
  return 'data:image/png;base64,' + 'A'.repeat(kb * 1024);
}

function skinnedPaintedSculpted(scene: Scene): void {
  for (const o of scene.objects.values()) {
    const m = o.mesh!;
    const n = m.positions.length;
    m.skin = { bones: new Int32Array(n * 4).fill(0), weights: new Float32Array(n * 4).fill(0.25) };
    m.colors = new Float32Array(n * 3).fill(0.5);
    m.mask = new Float32Array(n).fill(0.25);
    m.markDirty();
  }
}

test('the memory estimate counts skin weights, vertex colour and sculpt mask', () => {
  // These three are per-vertex arrays and skin is eight numbers of it. A budget
  // that walks past them lets exactly the projects that need the limit — rigged,
  // painted, sculpted characters — grow several times past it before anything
  // is dropped.
  const plain = sceneWith(1, true);
  const bare = new History();
  bare.push(snap(plain, bare.store, 'plain'));
  const bareBytes = bare.footprint();

  const rigged = sceneWith(1, true);
  skinnedPaintedSculpted(rigged);
  const loaded = new History();
  loaded.push(snap(rigged, loaded.store, 'rigged'));
  const loadedBytes = loaded.footprint();

  const verts = [...plain.objects.values()][0].mesh!.positions.length;
  assert.ok(verts > 50, 'the fixture needs enough vertices to measure');
  // Eight skin numbers, three colour, one mask: twelve doubles a vertex. Allow
  // generous slack, but nothing like zero.
  const expected = verts * 12 * 8;
  assert.ok(
    loadedBytes - bareBytes > expected * 0.5,
    `skin, colour and mask added ${loadedBytes - bareBytes} bytes to the estimate, expected about ${expected}`,
  );
});

test('the memory estimate counts embedded images, and counts each one once', () => {
  const scene = sceneWith(1);
  scene.textures.push({ id: 1, name: 'photo', url: fakeImage(512), width: 8, height: 8 });
  const history = new History();
  const store = history.store;

  history.push(snap(scene, store, 'a'));
  const one = history.footprint();
  // Half a megabyte of base64 is two bytes a character in memory.
  assert.ok(one > 512 * 1024, `an embedded 512 KB image was estimated at ${one} bytes`);

  // Ten more snapshots of the same document. `toJSON` gives each its own
  // texture *wrapper*, but the data URL inside is one string shared by
  // reference — so the total must barely move.
  for (let i = 0; i < 10; i++) history.push(snap(scene, store, `s${i}`));
  const many = history.footprint();
  assert.ok(
    many < one * 1.5,
    `one image was counted ${many / one} times over eleven snapshots`,
  );
});

test('the memory estimate counts what provenance retains', () => {
  const scene = sceneWith(1, true);
  const object = [...scene.objects.values()][0];
  const baselineMesh = object.mesh!.toJSON();
  object.provenance = {
    schema: 2,
    source: 'reference',
    assetId: 'a1',
    generator: 'reference:silhouette',
    generatorVersion: 1,
    params: { depth: fakeImage(256) },
    baseline: { version: 2, parts: [{
      key: 'body#0', name: 'body',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      mesh: baselineMesh,
    }] },
    createdAt: 0,
    revision: 0,
  };

  const withProv = new History();
  withProv.push(snap(scene, withProv.store, 'with'));

  const bare = new History();
  bare.push(snap(sceneWith(1, true), bare.store, 'without'));

  const extra = withProv.footprint() - bare.footprint();
  // A quarter-megabyte depth map plus a whole second copy of the geometry.
  assert.ok(extra > 256 * 1024, `provenance added only ${extra} bytes to the estimate`);
});

test('a shared mesh blob is counted once however deep the history goes', () => {
  const scene = sceneWith(3, true);
  const history = new History();
  const store = history.store;
  history.push(snap(scene, store, 'first'));
  const one = history.footprint();

  for (let i = 0; i < 20; i++) history.push(snap(scene, store, `s${i}`));
  assert.equal(history.depth, 21);
  assert.ok(
    history.footprint() < one * 1.2,
    'untouched geometry was counted again for every snapshot',
  );

  // And an edit genuinely costs: the changed mesh is a new blob.
  const target = [...scene.objects.values()][1];
  target.mesh!.positions[0].x += 1;
  target.mesh!.markDirty();
  history.push(snap(scene, store, 'moved'));
  assert.ok(history.footprint() > one, 'an edited mesh was not counted');
});

test('a realistically large project is held to the budget', () => {
  // Twenty subdivided, rigged, painted objects and an embedded photograph — the
  // shape of a real character file. The budget has to be measured against what
  // the project actually costs rather than guessed, so it is set from one
  // snapshot of this very scene; with skin, colour, mask and the image all
  // uncounted that measurement came out near zero and nothing was ever dropped.
  const scene = sceneWith(20, true);
  skinnedPaintedSculpted(scene);
  scene.textures.push({ id: 1, name: 'photo', url: fakeImage(64), width: 16, height: 16 });

  const history = new History(64, Number.MAX_SAFE_INTEGER);
  const store = history.store;
  history.push(snap(scene, store, 'start'));
  const oneSnapshot = history.footprint();
  assert.ok(oneSnapshot > 400 * 1024, `the fixture only measured ${oneSnapshot} bytes`);
  history.budgetBytes = oneSnapshot * 2;

  for (let i = 0; i < 40; i++) {
    const target = [...scene.objects.values()][i % 20];
    target.mesh!.positions[0].x += 0.01;
    target.mesh!.markDirty();
    history.push(snap(scene, store, `edit ${i}`));
  }
  assert.ok(history.depth > 0, 'the history dropped everything');
  assert.ok(history.depth < 41, `nothing was dropped: ${history.depth} steps held`);
  assert.ok(
    history.footprint() <= history.budgetBytes,
    `the history holds ${history.footprint()} bytes against a ${history.budgetBytes} byte budget`,
  );
});
