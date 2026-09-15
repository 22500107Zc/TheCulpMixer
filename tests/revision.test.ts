import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, SceneObject } from '../src/scene/Scene';
import { History } from '../src/editor/history';
import { Vec3 } from '../src/core/math';
import { SelectMode } from '../src/render/Renderer';
import { interpret } from '../src/build/interpreter';
import { captureBaseline, executePlan, recordProvenance } from '../src/build/plan';
import {
  PROVENANCE_SCHEMA, assignPartKeys, cloneProvenance, normaliseProvenance, partKeyFor,
  regenerability, roleOf,
} from '../src/build/provenance';
import { mergeAsset, sameMesh, summariseMerge } from '../src/build/merge';
import {
  identifiedParts, parseRevision, proposedFromParts, rebuildRecipe, revisableSettings,
} from '../src/build/revise';
import { runProgramHere } from '../src/build/sandbox';
import { validatePlan } from '../src/build/plan';
import {
  RevisionSession, assetFingerprint, assetRootFor, collectAsset, revisability,
} from '../src/editor/revision';
import { buildPrimitive } from '../src/mesh/primitives';
import { createModifier } from '../src/modifiers';
import { catmullClark } from '../src/mesh/ops';

/** Build a scene containing one generated asset, exactly as the Build bar does. */
function build(prompt: string): { scene: Scene; root: SceneObject } {
  const scene = new Scene();
  const result = interpret(prompt);
  assert.ok(result.plan, `nothing built for "${prompt}"`);
  const { root, objects, keys } = executePlan(scene, result.plan!);
  recordProvenance(root, result.origin, captureBaseline(objects, keys, scene.materials));
  return { scene, root };
}

/** A revision host backed by a plain scene, which is all the session needs. */
function hostFor(scene: Scene): {
  session: RevisionSession; history: History; refreshes: number[]; status: string[];
  notices: { title: string; warnings: string[] }[];
} {
  const history = new History();
  const refreshes: number[] = [];
  const status: string[] = [];
  const notices: { title: string; warnings: string[] }[] = [];
  const snapshot = (label: string) => ({
    label,
    scene: scene.toJSON(history.store),
    mode: 'object' as const,
    editObject: null,
    selectMode: 'vertex' as SelectMode,
    verts: [], edges: [], faces: [],
  });
  const session = new RevisionSession({
    scene,
    snapshotStore: () => history.store,
    snapshot,
    restore: (snap) => { scene.adopt(Scene.fromJSON(snap.scene)); },
    pushHistory: (snap) => history.push(snap),
    setStatus: (m) => { status.push(m); },
    notify: (title, warnings) => { notices.push({ title, warnings }); },
    refresh: () => { refreshes.push(1); },
  });
  return { session, history, refreshes, status, notices };
}

/**
 * The scene's contents, ignoring the id counter.
 *
 * `adopt` deliberately never counts `nextId` backwards — an id handed out
 * during a preview must not be handed out again — so "the scene is unchanged"
 * means its objects, materials and relationships, not that counter.
 */
function contents(scene: Scene): string {
  const doc = scene.toJSON() as Record<string, unknown>;
  delete doc.nextId;
  return JSON.stringify(doc);
}

const childrenOf = (scene: Scene, root: SceneObject): SceneObject[] =>
  root.children.map((id) => scene.get(id)!).filter(Boolean);

// ------------------------------------------------------------------ identity

test('a repeated part is identified by its role and its ordinal, not its index', () => {
  assert.equal(roleOf('Step 7'), 'step');
  assert.equal(roleOf('Step'), 'step');
  assert.equal(roleOf('Hat brim'), 'hat-brim');
  assert.equal(roleOf('Leg.003'), 'leg');
  assert.equal(partKeyFor('Step 12', 12), 'step#12');

  const keys = assignPartKeys(['Top', 'Leg', 'Leg', 'Leg', 'Leg']);
  assert.deepEqual(keys, ['top#1', 'leg#1', 'leg#2', 'leg#3', 'leg#4']);
  // Same list, same keys — the mapping cannot drift between two runs.
  assert.deepEqual(assignPartKeys(['Top', 'Leg', 'Leg', 'Leg', 'Leg']), keys);
});

test('growing a repeated part keeps the ones that were already there', () => {
  const twenty = assignPartKeys(Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`));
  const thirty = assignPartKeys(Array.from({ length: 30 }, (_, i) => `Step ${i + 1}`));
  assert.deepEqual(thirty.slice(0, 20), twenty);
  assert.equal(thirty[29], 'step#30');
  // And shrinking drops from the top rather than renumbering the lot.
  const ten = assignPartKeys(Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`));
  assert.deepEqual(ten, twenty.slice(0, 10));
});

// ---------------------------------------------------------------- provenance

test('a generated asset records what made it, and every part is identified', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const prov = root.provenance;
  assert.ok(prov, 'the asset has no provenance');
  assert.equal(prov!.schema, PROVENANCE_SCHEMA);
  assert.equal(prov!.source, 'recipe');
  assert.equal(prov!.params.count, 20);
  assert.equal(prov!.prompt, 'a staircase with 20 steps');
  assert.ok(prov!.assetId.length > 4);
  assert.equal(regenerability(prov).can, true);

  const kids = childrenOf(scene, root);
  assert.equal(kids.length, 20);
  assert.ok(kids.every((k) => !!k.partKey), 'a generated part has no key');
  assert.equal(new Set(kids.map((k) => k.partKey)).size, 20, 'part keys are not unique');
  assert.equal(prov!.baseline.parts?.length, 20);
});

test('provenance survives a save and reload, and old files load without it', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const reloaded = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const back = reloaded.get(root.id)!;
  assert.equal(back.provenance?.assetId, root.provenance!.assetId);
  assert.equal(back.provenance?.params.count, 20);
  assert.equal(back.provenance?.baseline.parts?.length, 20);
  assert.equal(reloaded.get(root.children[0])!.partKey, scene.get(root.children[0])!.partKey);

  // A document written before any of this existed: the fields are simply not
  // there, and that has to be an ordinary scene rather than an error.
  const legacy = JSON.parse(JSON.stringify(scene.toJSON())) as Record<string, unknown>;
  for (const o of legacy.objects as Record<string, unknown>[]) {
    delete o.provenance;
    delete o.partKey;
    delete o.protectedFromRegen;
  }
  const old = Scene.fromJSON(legacy as never);
  assert.equal(old.objects.size, scene.objects.size);
  assert.equal(old.get(root.id)!.provenance, null);
  assert.equal(revisability(old.get(root.id)).can, false);
  assert.match(revisability(old.get(root.id)).why, /no record of how it was made/);
});

test('rubbish in the provenance field is dropped rather than trusted', () => {
  assert.equal(normaliseProvenance(null), null);
  assert.equal(normaliseProvenance({ source: 'nonsense', assetId: 'x' }), null);
  assert.equal(normaliseProvenance({ source: 'recipe' }), null, 'no id is no identity');
  const p = normaliseProvenance({
    source: 'recipe', assetId: 'a1', params: { count: 20, bad: { deep: 1 }, ok: 'yes' },
    baseline: { parts: [{ key: 'step#1', position: [1, 'x', 3] }, { name: 'no key' }] },
  });
  assert.ok(p);
  assert.deepEqual(Object.keys(p!.params).sort(), ['count', 'ok']);
  assert.equal(p!.baseline.parts?.length, 1, 'a baseline part with no key has no identity');
  assert.deepEqual(p!.baseline.parts![0].position, [1, 0, 3]);
});

test('duplicating a generated asset copies the parts and mints a new identity', () => {
  const { scene, root } = build('a table');
  const copy = scene.duplicateObject(root.id)!;
  assert.equal(copy.children.length, root.children.length);
  assert.notEqual(copy.provenance!.assetId, root.provenance!.assetId);
  assert.equal(copy.provenance!.params.recipe, root.provenance!.params.recipe);
  // Part keys are kept: within the copy they still name the same parts.
  assert.deepEqual(
    childrenOf(scene, copy).map((c) => c.partKey),
    childrenOf(scene, root).map((c) => c.partKey),
  );
});

// -------------------------------------------------------------------- revise

test('a revision request is read against the settings the asset actually has', () => {
  const { root } = build('a staircase with 20 steps');
  const prov = root.provenance!;

  const more = parseRevision(prov, 'change this staircase from 20 steps to 30');
  assert.equal(more.params.count, 30);
  assert.equal(more.empty, false);

  const bigger = parseRevision(prov, 'make it bigger');
  assert.ok((bigger.params.scale as number) > 1);

  const nothing = parseRevision(prov, 'make it nicer');
  assert.equal(nothing.empty, true, 'a request naming no setting must not look like it worked');

  // A setting this asset does not have is reported, not invented.
  const shapes = build('12 cubes in a circle');
  const segments = parseRevision(shapes.root.provenance!, 'use 8 segments');
  assert.equal(segments.params.segments, undefined);
});

test('the settings a user can change are listed without the internals', () => {
  const { root } = build('a staircase with 20 steps');
  const keys = revisableSettings(root.provenance).map((s) => s.key);
  assert.ok(keys.includes('count'));
  assert.ok(!keys.includes('words'), 'the raw prompt text is not a setting');
  assert.ok(!keys.includes('recipe'));
});

test('rerunning a recipe with a new count produces matching part keys', () => {
  const { root } = build('a staircase with 20 steps');
  const next = rebuildRecipe(root.provenance!, { count: 30 });
  assert.ok(next);
  const keys = next!.parts.map((p) => p.key);
  assert.equal(keys.filter((k) => k.startsWith('step#')).length, 30);
  const baseKeys = root.provenance!.baseline.parts!.map((p) => p.key);
  // Every part that existed before still exists under the same name.
  for (const key of baseKeys) assert.ok(keys.includes(key), `${key} lost its identity`);
});

// --------------------------------------------------------------------- merge

test('a revision keeps your materials, your extra objects and your placement', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);

  // The user recolours one step, moves another, and adds a handrail.
  const slot = scene.addMaterial();
  kids[0].materialSlots = [slot];
  kids[1].position = new Vec3(9, 9, 9);
  const rail = scene.add('mesh', 'Handrail', buildPrimitive('cube'));
  scene.setParent(rail.id, root.id);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  assert.equal(plan.report.added, 10, 'ten new steps');
  assert.equal(plan.report.removed, 0);
  assert.equal(plan.report.conflicts.length, 0, 'nothing here actually disagrees');
  assert.equal(plan.report.userAdded.length, 1);
  assert.equal(plan.report.userAdded[0].name, 'Handrail');

  const moved = plan.report.parts.find((p) => p.objectId === kids[1].id)!;
  assert.ok(moved.keptYours.includes('position'), 'the step you moved was moved back');
  assert.ok(!plan.remove.includes(rail.id), 'your own object was scheduled for removal');
  // Materials are never taken from the generator.
  assert.ok(plan.parts.every((p) => !('materialSlots' in p)));
});

test('a sculpted part and a topology change is a conflict, not a silent overwrite', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);

  // Sculpt: move vertices without changing the face list.
  const mesh = kids[3].mesh!;
  for (const p of mesh.positions) p.z += 0.15;
  mesh.markDirty();

  // A revision that rebuilds every step with a different shape.
  const next = rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  const conflict = plan.report.conflicts.find((c) => c.objectId === kids[3].id);
  assert.ok(conflict, 'the sculpted step was overwritten without a word');
  assert.match(conflict!.detail, /you/i);
  assert.ok(!plan.parts.some((p) => p.objectId === kids[3].id && p.mesh),
    'a conflicted part must not be written');
});

test('a topology conflict names the attributes that cannot come with it', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  const baseMesh = part.mesh!.toJSON();
  root.provenance = normaliseProvenance({
    source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: { parts: [{ key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mesh: baseMesh }] },
  });

  // The user unwraps it, then a revision rebuilds it with more faces.
  part.mesh!.faceUV = part.mesh!.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]);
  part.mesh!.markDirty();
  const denser = buildPrimitive('uvsphere');
  const proposed = [{
    key: 'body#1', name: 'Body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: denser.toJSON(),
  }];
  const { current } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, proposed, []);
  const conflict = plan.report.conflicts[0];
  assert.ok(conflict);
  assert.equal(conflict.kind, 'topology');
  assert.match(conflict.detail, /UV coordinates/);
});

test('a protected part is never regenerated, and says so when asked to be', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[2].protectedFromRegen = true;

  const next = rebuildRecipe(root.provenance!, { count: 20, scale: 1.5 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  assert.equal(plan.report.protectedParts, 1);
  assert.ok(!plan.parts.some((p) => p.objectId === kids[2].id),
    'a protected part was written anyway');
  const conflict = plan.report.conflicts.find((c) => c.objectId === kids[2].id);
  assert.ok(conflict, 'a revision that changes a protected part must report it');
  assert.equal(conflict!.kind, 'protected');
});

test('with no baseline the merge admits it cannot tell your edits apart', () => {
  const { scene, root } = build('a table');
  const prov = root.provenance!;
  prov.baseline = {};
  const next = rebuildRecipe(prov, {})!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(prov.baseline, current, next.parts, userAdded);
  assert.equal(plan.report.blind, true);
  assert.ok(summariseMerge(plan.report).length > 0);
});

// ------------------------------------------------------------------- session

test('rejecting a preview leaves the scene exactly as it was', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history } = hostFor(scene);
  const before = contents(scene);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  const summary = session.preview(root, next.parts, '30 steps');
  assert.ok(summary);
  assert.equal(session.active, true);
  assert.equal(scene.get(root.id)!.children.length, 30, 'the preview is not visible');

  assert.equal(session.reject(), true);
  assert.equal(session.active, false);
  assert.equal(contents(scene), before, 'reject did not restore the scene');
  assert.equal(history.canUndo, false, 'a rejected revision left a step in the history');
});

test('accepting a revision is one undoable step that carries the record with it', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history } = hostFor(scene);
  const before = contents(scene);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  session.preview(root, next.parts, '30 steps');
  assert.equal(session.accept(), true);

  const after = scene.get(root.id)!;
  assert.equal(after.children.length, 30);
  assert.equal(after.provenance!.revision, 1);
  assert.equal(after.provenance!.baseline.parts!.length, 30, 'the baseline did not move on');
  assert.equal(history.depth, 1, 'a thirty-part revision must be one undo step');

  // Undo puts back the geometry, the record and the relationships together.
  const step = history.undo({
    label: 'redo', scene: scene.toJSON(history.store), mode: 'object', editObject: null,
    selectMode: 'vertex', verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(step.scene));
  assert.equal(contents(scene), before, 'undo did not restore everything');
  assert.equal(scene.get(root.id)!.provenance!.revision, 0);
});

test('a second preview is refused rather than quietly replacing the first', () => {
  // Silently rejecting the open proposal to make room for a new one is a
  // review thrown away without anybody being asked — the same quiet loss as
  // overwriting geometry, aimed at the decision instead of the model.
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history, status } = hostFor(scene);
  const before = contents(scene);

  assert.ok(session.preview(root, rebuildRecipe(root.provenance!, { count: 30 })!.parts, '30 steps'));
  const live = scene.get(root.id)!;
  assert.equal(
    session.preview(live, rebuildRecipe(live.provenance!, { count: 25 })!.parts, '25 steps'),
    null,
    'a second revision was started over an open one',
  );
  assert.match(status[status.length - 1], /still waiting/);
  assert.equal(session.summary!.label, '30 steps', 'the first proposal was replaced');
  assert.equal(scene.get(root.id)!.children.length, 30);

  session.reject();
  assert.equal(contents(scene), before);
  assert.equal(history.canUndo, false);

  // With it closed, the next one starts normally.
  assert.ok(session.preview(scene.get(root.id)!, rebuildRecipe(root.provenance!, { count: 25 })!.parts, '25 steps'));
});

test('a conflict can be settled three ways, all inside the preview', () => {
  const setup = () => {
    const { scene, root } = build('a staircase with 8 steps');
    const kids = childrenOf(scene, root);
    for (const p of kids[2].mesh!.positions) p.z += 0.3;
    kids[2].mesh!.markDirty();
    const sculpted = JSON.stringify(kids[2].mesh!.toJSON());
    const { session, history } = hostFor(scene);
    const next = rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!;
    // Captured before the preview writes anything, which is what Reject has
    // to be measured against.
    const before = contents(scene);
    const summary = session.preview(root, next.parts, 'bigger')!;
    const conflict = summary.report.conflicts.find((c) => c.objectId === kids[2].id)!;
    return { scene, root, session, history, conflict, sculpted, before, targetId: kids[2].id };
  };

  // Keep mine: the object is already yours, and it stays that way.
  {
    const { scene, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'mine'), true);
    assert.equal(session.summary!.report.conflicts.length, 0);
    session.accept();
    assert.equal(JSON.stringify(scene.get(targetId)!.mesh!.toJSON()), sculpted);
  }

  // Use the revised one: your version goes, knowingly.
  {
    const { scene, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'theirs'), true);
    session.accept();
    assert.notEqual(JSON.stringify(scene.get(targetId)!.mesh!.toJSON()), sculpted);
  }

  // Keep both: yours survives as your own object, the generated one takes the
  // identity — so the next revision has exactly one part to match.
  {
    const { scene, root, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'both'), true);
    session.accept();
    const mine = scene.get(targetId)!;
    assert.equal(JSON.stringify(mine.mesh!.toJSON()), sculpted, 'your version was not kept');
    assert.equal(mine.partKey, null, 'two objects would claim the same part');
    const carriers = childrenOf(scene, scene.get(root.id)!)
      .filter((c) => c.partKey === conflict.key);
    assert.equal(carriers.length, 1, 'the part identity is ambiguous after keeping both');
    assert.notEqual(carriers[0].id, targetId);
  }

  // And a rejection after resolving still puts everything back.
  {
    const { scene, session, conflict, history, before } = setup();
    session.resolveConflict(conflict.key, 'theirs');
    session.reject();
    assert.equal(contents(scene), before, 'resolving then rejecting changed the scene');
    assert.equal(history.canUndo, false);
  }
});

test('the fingerprint notices the asset moving while a request is in flight', () => {
  const { scene, root } = build('a table');
  const stamp = assetFingerprint(scene, root);
  assert.equal(assetFingerprint(scene, root), stamp, 'the fingerprint is not stable');
  scene.get(root.children[0])!.position = new Vec3(0, 0, 5);
  assert.notEqual(assetFingerprint(scene, root), stamp);
});

test('the asset root is found from any part of it', () => {
  const { scene, root } = build('a table');
  const leg = scene.get(root.children[2])!;
  assert.equal(assetRootFor(scene, leg)?.id, root.id);
  assert.equal(assetRootFor(scene, root)?.id, root.id);
  const loose = scene.add('mesh', 'Loose', buildPrimitive('cube'));
  assert.equal(assetRootFor(scene, loose), null);
});

test('two meshes are the same only when they really are', () => {
  const a = buildPrimitive('cube').toJSON();
  const b = buildPrimitive('cube').toJSON();
  assert.equal(sameMesh(a, b), true);
  b.positions[0] += 1e-4;
  assert.equal(sameMesh(a, b), false);
  assert.equal(sameMesh(null, null), true);
  assert.equal(sameMesh(a, null), false);
});

test('a plan turned into proposed parts keeps rotations in radians', () => {
  const result = interpret('a spiral staircase with 6 steps');
  const parts = proposedFromParts(result.plan!.parts);
  const turned = parts.find((p) => p.rotation.some((r) => Math.abs(r) > 1e-9));
  assert.ok(turned, 'a spiral staircase has turned treads');
  assert.ok(turned!.rotation.every((r) => Math.abs(r) < 7), 'rotations were left in degrees');
});

test('a pending preview blocks the paths that would make it permanent', () => {
  // Three ways a proposal could become the model without anyone agreeing: an
  // autosave, a save to disk, and a document loaded over the top of it.
  const { scene, root } = build('a staircase with 6 steps');
  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 9 })!.parts, '9 steps');
  assert.equal(session.active, true);

  // Discard is for the case where the scene itself is going away: it neither
  // restores nor commits, because both would be claims about a scene that no
  // longer exists.
  session.discard();
  assert.equal(session.active, false);
  assert.equal(session.summary, null);
  assert.equal(scene.get(root.id)!.children.length, 9, 'discard is not a rollback');
  assert.equal(scene.get(root.id)!.provenance!.revision, 0, 'discard is not an acceptance');
});

test('reviewing an asset with no baseline says so instead of guessing', () => {
  const { scene, root } = build('a table');
  root.provenance!.baseline = {};
  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, {})!.parts, 'rebuild');
  assert.ok(summary);
  assert.equal(summary!.report.blind, true);
  assert.ok(summary!.notes.some((n) => /could not be told/.test(n)),
    'a blind merge must say that it is blind');
});

test('an object with no record cannot be previewed at all', () => {
  const scene = new Scene();
  const plain = scene.add('mesh', 'Hand-modelled', buildPrimitive('cube'));
  const { session, status } = hostFor(scene);
  assert.equal(session.preview(plain, [], 'anything'), null);
  assert.equal(session.active, false);
  assert.match(status[status.length - 1], /no record of how it was made/);
});

test('a removal that would take your work with it is a conflict, not a deletion', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  // A detail modelled onto the top step, which a shorter staircase removes.
  const detail = scene.add('mesh', 'Nosing', buildPrimitive('cube'));
  detail.position = new Vec3(0, 0, 0.5);
  scene.setParent(detail.id, kids[19].id);
  const worldBefore = detail.worldMatrix(scene).transformPoint(new Vec3());

  const { session } = hostFor(scene);
  const next = rebuildRecipe(root.provenance!, { count: 10 })!;
  const summary = session.preview(root, next.parts, '10 steps')!;

  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a step carrying your work was removed with no conflict');
  assert.match(conflict!.detail, /object\(s\) you made are attached/);
  assert.ok(scene.get(detail.id), 'the preview deleted your detail');

  // Agreeing to the removal lifts your work clear rather than taking it along,
  // and leaves it exactly where it was in the world.
  session.resolveConflict(conflict!.key, 'theirs', 'existence');
  const survivor = scene.get(detail.id);
  assert.ok(survivor, 'a detail you modelled was deleted along with its step');
  assert.equal(survivor!.parent, root.id, 'it should hang off the asset instead');
  assert.equal(survivor!.partKey, null);
  const worldAfter = survivor!.worldMatrix(scene).transformPoint(new Vec3());
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(worldBefore[axis] - worldAfter[axis]) < 1e-6,
      `your detail moved on ${axis}: ${worldBefore[axis]} -> ${worldAfter[axis]}`);
  }
});

// ------------------------------------------------------- deletion is a decision

test('a part you deleted stays deleted, revision after revision', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const doomedKey = kids[5].partKey!;
  scene.remove(kids[5].id);

  const { session } = hostFor(scene);
  // A revision that changes something else entirely.
  session.preview(root, rebuildRecipe(root.provenance!, { count: 20, color: '#ff0000' })!.parts, 'red');
  assert.equal(session.summary!.report.conflicts.length, 0,
    'recolouring is no reason to argue about a deletion');
  session.accept();

  const after = scene.get(root.id)!;
  assert.ok(!childrenOf(scene, after).some((c) => c.partKey === doomedKey),
    'the deleted step came back on the first revision');
  assert.deepEqual(after.provenance!.deletedParts, [doomedKey],
    'the deletion was not written down');

  // And again, and after a save and a reload.
  session.preview(after, rebuildRecipe(after.provenance!, { count: 20 })!.parts, 'again');
  session.accept();
  assert.ok(!childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === doomedKey),
    'the deleted step came back on the second revision');

  const reloaded = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.deepEqual(reloaded.get(root.id)!.provenance!.deletedParts, [doomedKey],
    'the deletion did not survive a save and reload');
});

test('a deletion the revision disagrees with is a conflict, and restoring is a choice', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const key = kids[5].partKey!;
  scene.remove(kids[5].id);

  const { session } = hostFor(scene);
  // Scaling changes every step, including the one that is gone.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find((c) => c.key === key);
  assert.ok(conflict, 'delete-versus-modify was decided silently');
  assert.equal(conflict!.kind, 'delete-vs-modify');
  assert.equal(conflict!.field, 'existence');
  assert.match(conflict!.yours ?? '', /deleted/);

  // It stays gone until asked for.
  assert.ok(!childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === key));
  session.resolveConflict(key, 'theirs', 'existence');
  assert.ok(childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === key),
    'asking for it back did not bring it back');
  session.accept();
  assert.ok(!(scene.get(root.id)!.provenance!.deletedParts ?? []).includes(key),
    'a restored part is still recorded as deleted');
});

test('deleted by both stays deleted without an argument', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const key = kids[19].partKey!;
  scene.remove(kids[19].id);

  const { session } = hostFor(scene);
  // Shrinking to 10 steps drops it too.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  assert.ok(!summary.report.conflicts.some((c) => c.key === key),
    'both sides agreeing is not a conflict');
  assert.ok(summary.report.staysDeleted > 0);
});

// ------------------------------------------- every edit counts before a removal

test('a material-only edit blocks a silent removal', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = scene.addMaterial();
  scene.materials[slot].color = [1, 0, 0];
  kids[19].materialSlots = [slot];

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a recoloured step was removed without a word');
  assert.equal(conflict!.kind, 'modify-vs-delete');
  assert.match(conflict!.detail, /material/);
  assert.ok(scene.get(kids[19].id), 'it was removed during the preview');
});

test('changing a material in place counts, not just changing which slot', () => {
  // The subtle one: a slot is an index into a shared list, so recolouring a
  // material changes how an object looks without touching the object at all.
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = kids[19].materialSlots[0];
  scene.materials[slot] = { ...scene.materials[slot], color: [0.9, 0.1, 0.1] };

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a material edited in place was invisible to the merge');
  assert.match(conflict!.detail, /material/);
});

test('modifier and animation edits block a silent removal too', () => {
  for (const [label, mutate] of [
    ['modifiers', (o: SceneObject) => { o.modifiers = [createModifier('subdivision')]; }],
    ['animation', (o: SceneObject) => {
      o.animation = [{ path: 'position', index: 2, keys: [{ frame: 1, value: 0 }, { frame: 10, value: 3 }] }];
    }],
  ] as const) {
    const { scene, root } = build('a staircase with 20 steps');
    const kids = childrenOf(scene, root);
    mutate(kids[19]);
    const { session } = hostFor(scene);
    const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
    const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
    assert.ok(conflict, `an ${label} edit was invisible to the merge`);
    assert.match(conflict!.detail, new RegExp(label));
  }
});

test('a baseline too old to prove anything refuses to delete on a guess', () => {
  const { scene, root } = build('a staircase with 20 steps');
  // An asset recorded before The Culp Mixer stored materials, modifiers or animation.
  const prov = root.provenance!;
  prov.baseline.version = 1;
  for (const part of prov.baseline.parts!) {
    delete part.materialSlots;
    delete part.materials;
    delete part.modifiers;
    delete part.animation;
  }

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(prov, { count: 10 })!.parts, '10')!;
  assert.equal(summary.report.unverifiable, true);
  const conflicts = summary.report.conflicts.filter((c) => c.kind === 'unverifiable');
  assert.equal(conflicts.length, 10, 'ten steps would have been deleted on an assumption');
  assert.match(conflicts[0].detail, /no way to show/);
});

// --------------------------------------------------- fields disagree out loud

test('both changing the same transform is a conflict, not a silent win', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[3].position = new Vec3(5, 5, 5);

  const { session } = hostFor(scene);
  // Scaling moves every step, including the one you moved.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find(
    (c) => c.objectId === kids[3].id && c.field === 'position',
  );
  assert.ok(conflict, 'the placement disagreement was decided silently');
  assert.equal(conflict!.kind, 'transform');
  assert.ok(conflict!.yours && conflict!.theirs, 'a conflict must show both values');
  assert.match(conflict!.yours!, /5/);
  // Nothing was written while it is in dispute.
  assert.deepEqual(scene.get(kids[3].id)!.position.toArray(), [5, 5, 5]);
});

test('resolving a name keeps the shape, and resolving a shape keeps the name', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: part.mesh!.toJSON(), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });

  // You rename it and move it; the revision renames it differently and
  // reshapes it. Three separate questions.
  part.name = 'My body';
  part.position = new Vec3(1, 0, 0);
  const proposed = [{
    key: 'body#1', name: 'Generated body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(scene.get(root.id)!, proposed, 'reshape')!;

  const nameConflict = summary.report.conflicts.find((c) => c.field === 'name');
  assert.ok(nameConflict, 'two different names is a disagreement');
  assert.equal(summary.report.conflicts.some((c) => c.field === 'geometry'), false,
    'you did not touch the shape, so there is nothing to argue about there');
  // The shape was taken; the position you set was kept; the name is still open.
  const live = scene.get(part.id)!;
  assert.equal(live.faceCountForTest ?? live.mesh!.faceCount > 6, true);
  assert.deepEqual(live.position.toArray(), [1, 0, 0], 'your placement was reset');
  assert.equal(live.name, 'My body', 'the name changed while it was still in dispute');

  // Settling the name touches only the name.
  session.resolveConflict('body#1', 'theirs', 'name');
  assert.equal(scene.get(part.id)!.name, 'Generated body');
  assert.deepEqual(scene.get(part.id)!.position.toArray(), [1, 0, 0],
    'resolving a name reset an unrelated placement');
});

test('an unresolved conflict cannot slip through acceptance', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[3].position = new Vec3(5, 5, 5);
  const { session, history } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger');
  assert.ok(session.summary!.report.conflicts.length > 0);

  assert.equal(session.accept(), false, 'an open conflict was accepted anyway');
  assert.equal(session.active, true, 'the revision was closed with conflicts open');
  assert.equal(history.canUndo, false);

  // Saying it once settles them all, and is recorded as an override.
  const settled = session.keepMineForAll();
  assert.ok(settled > 0);
  assert.equal(session.summary!.report.conflicts.length, 0);
  assert.equal(session.accept(), true);
  assert.deepEqual(scene.get(kids[3].id)!.position.toArray(), [5, 5, 5],
    'keep-mine-for-all did not keep mine');
});

// ---------------------------------------------- the document is held on review

test('the fingerprint sees every kind of change, not a sample of one kind', () => {
  const { scene, root } = build('a table');
  const kids = childrenOf(scene, root);
  const stamp = () => assetFingerprint(scene, scene.get(root.id));
  const start = stamp();
  assert.equal(stamp(), start, 'the stamp is not stable');

  const changes: [string, () => void][] = [
    ['one vertex moved', () => { kids[0].mesh!.positions[3].x += 1e-3; kids[0].mesh!.markDirty(); }],
    ['a material slot', () => { kids[1].materialSlots = [scene.addMaterial()]; }],
    // A material the asset actually uses: editing one nothing points at is
    // correctly invisible to the asset's stamp.
    ['a material value', () => {
      const slot = kids[2].materialSlots[0];
      scene.materials[slot] = { ...scene.materials[slot], roughness: 0.11 };
    }],
    ['a modifier', () => { kids[2].modifiers = [createModifier('subdivision')]; }],
    ['an animation key', () => {
      kids[3].animation = [{ path: 'position', index: 0, keys: [{ frame: 1, value: 0 }] }];
    }],
    ['visibility', () => { kids[4].visible = false; }],
    ['a rename', () => { kids[0].name = 'Renamed'; }],
    ['protection', () => { kids[1].protectedFromRegen = true; }],
  ];
  let previous = start;
  for (const [what, mutate] of changes) {
    mutate();
    const now = stamp();
    assert.notEqual(now, previous, `${what} did not move the stamp`);
    previous = now;
  }
});

test('a mesh edit that misses a sampled index is still noticed', () => {
  // The reason the old sampled hash was replaced: it read one position in
  // every few hundred, so an edit between two samples was invisible.
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Grid', buildPrimitive('grid'));
  part.partKey = 'grid#1';
  scene.setParent(part.id, root.id);
  const before = assetFingerprint(scene, root);
  part.mesh!.positions[1].z += 0.25;   // index 1: never sampled by the old hash
  part.mesh!.markDirty();
  assert.notEqual(assetFingerprint(scene, root), before);
});

// -------------------------------------------- journey 1: 20 -> 30 -> 15 -> 25

test('a staircase survives being revised three times over', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = scene.addMaterial();
  scene.materials[slot].color = [0.9, 0.1, 0.1];
  kids[0].materialSlots = [slot];
  const detail = scene.add('mesh', 'My finial', buildPrimitive('cube'));
  scene.setParent(detail.id, root.id);

  const { session, history } = hostFor(scene);
  const steps = (): SceneObject[] => childrenOf(scene, scene.get(root.id)!)
    .filter((c) => (c.partKey ?? '').startsWith('step#'));

  for (const [count, expect] of [[30, 30], [15, 15], [25, 25]] as const) {
    const live = scene.get(root.id)!;
    const summary = session.preview(
      live, rebuildRecipe(live.provenance!, { count })!.parts, `${count} steps`,
    )!;
    // Shrinking removes steps; none of them were edited, so none should argue.
    if (summary.report.conflicts.length) session.keepMineForAll();
    assert.equal(session.accept(), true, `accepting ${count} steps failed`);
    assert.equal(steps().length, expect, `expected ${expect} steps`);
    assert.ok(scene.get(detail.id), 'your finial was lost');
    assert.equal(scene.get(kids[0].id)?.materialSlots[0], slot,
      'your material was lost during repeated revisions');
  }
  assert.equal(history.depth, 3, 'three revisions should be three undo steps');
  assert.equal(scene.get(root.id)!.provenance!.revision, 3);
});

test('Keep Both leaves two independently addressable objects, once', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  for (const p of kids[2].mesh!.positions) p.z += 0.3;
  kids[2].mesh!.markDirty();
  const key = kids[2].partKey!;

  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger');
  session.resolveConflict(key, 'both', 'geometry');
  session.keepMineForAll();
  session.accept();

  const after = childrenOf(scene, scene.get(root.id)!);
  const carriers = after.filter((c) => c.partKey === key);
  assert.equal(carriers.length, 1, 'two objects claim the same generated identity');
  const mine = after.find((c) => c.id === kids[2].id)!;
  assert.equal(mine.partKey, null, 'your copy still claims a generated identity');
  assert.notEqual(mine.name, carriers[0].name, 'the two are not separately addressable');

  // And a second revision knows which is which.
  const live = scene.get(root.id)!;
  const second = session.preview(live, rebuildRecipe(live.provenance!, { count: 8, scale: 2 })!.parts, 'again')!;
  assert.equal(second.report.conflicts.length, 0,
    'the settled argument came back on the next revision');
  session.accept();
  assert.ok(scene.get(mine.id), 'your kept copy was removed by the next revision');
});

test('Keep Mine survives the next revision instead of being re-argued', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  kids[2].position = new Vec3(9, 9, 9);

  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger');
  session.keepMineForAll();
  session.accept();
  assert.deepEqual(scene.get(kids[2].id)!.position.toArray(), [9, 9, 9]);

  // The same revision again: the generator now proposes what the baseline
  // holds, so there is nothing new to disagree about and your placement stands.
  const live = scene.get(root.id)!;
  const again = session.preview(live, rebuildRecipe(live.provenance!, { count: 8, scale: 2 })!.parts, 'again')!;
  assert.equal(again.report.conflicts.length, 0, 'the same argument was had twice');
  session.accept();
  assert.deepEqual(scene.get(kids[2].id)!.position.toArray(), [9, 9, 9],
    'your placement was lost on the second revision');
});

test('a protected part cannot be changed through conflict resolution either', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  kids[4].protectedFromRegen = true;
  const before = JSON.stringify(kids[4].mesh!.toJSON());

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[4].id)!;
  assert.equal(conflict.kind, 'protected');
  // Even choosing the generator's version leaves a protected part alone unless
  // the protection is lifted first.
  session.resolveConflict(conflict.key, 'theirs', conflict.field);
  assert.equal(JSON.stringify(scene.get(kids[4].id)!.mesh!.toJSON()), before,
    'a protected part was changed through the conflict panel');
});

// --------------------------------- journey 6: reorder and rename generated parts

test('declared identifiers survive reordering and renaming; position matching does not', () => {
  const first = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'top', name: 'Top', position: [0, 0, 1], size: [2, 1, 0.1] },
      { shape: 'cube', id: 'leg', name: 'Leg', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
    ],
  }).plan!;
  // The same program, reordered and renamed — which is what a model does when
  // asked to change one thing.
  const second = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'leg', name: 'Support', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', id: 'top', name: 'Tabletop', position: [0, 0, 1], size: [3, 1, 0.1] },
    ],
  }).plan!;

  const a = identifiedParts(first.parts);
  const b = identifiedParts(second.parts);
  assert.deepEqual(a.uncertain, [], 'declared ids should not be uncertain');
  const keyOf = (parts: typeof a.parts, name: string): string =>
    parts.find((p) => p.name === name)!.key;
  assert.equal(keyOf(a.parts, 'Top'), keyOf(b.parts, 'Tabletop'),
    'the tabletop lost its identity when it was renamed and moved down the list');
  assert.equal(keyOf(a.parts, 'Leg'), keyOf(b.parts, 'Support'));

  // Without ids the same reorder swaps them, and that is reported rather than
  // presented as a match.
  const noIds = identifiedParts(validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', name: 'Support', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', name: 'Tabletop', position: [0, 0, 1], size: [3, 1, 0.1] },
    ],
  }).plan!.parts);
  assert.equal(noIds.uncertain.length, 2, 'parts with no identity must be flagged as uncertain');
});

test('a duplicated identifier is refused rather than silently picked between', () => {
  const plan = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'leg', name: 'Leg', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', id: 'leg', name: 'Leg', position: [1, 0, 0.5], size: [0.1, 0.1, 1] },
    ],
  }).plan!;
  const out = identifiedParts(plan.parts);
  assert.equal(out.problems.length, 1, 'a duplicated id must be reported');
  assert.match(out.problems[0], /more than once/);
  assert.equal(new Set(out.parts.map((p) => p.key)).size, 2, 'the two must stay distinguishable');
  assert.equal(out.uncertain.length, 2, 'both should be treated as uncertain');
});

test('an edited program revises the asset it came from, with no model involved', async () => {
  const scene = new Scene();
  const built = runProgramHere(
    "part({shape:'cube', id:'top', name:'Top', at:[0,0,1], size:[2,1,0.1], color:'#8b5e34'});"
    + "part({shape:'cube', id:'leg', name:'Leg', at:[0,0,0.5], size:[0.1,0.1,1], color:'#8b5e34'});",
  );
  const plan = { name: 'Table', parts: built.parts };
  const { root, objects, keys } = executePlan(scene, plan);
  recordProvenance(root, { source: 'program', generator: 'program:hand', code: 'original' },
    captureBaseline(objects, keys, scene.materials));

  // Make it yours, then edit the program by hand.
  const top = childrenOf(scene, root).find((c) => c.name === 'Top')!;
  const slot = scene.addMaterial();
  top.materialSlots = [slot];

  const edited = runProgramHere(
    "part({shape:'cube', id:'top', name:'Top', at:[0,0,1], size:[4,1,0.1], color:'#8b5e34'});"
    + "part({shape:'cube', id:'leg', name:'Leg', at:[0,0,0.5], size:[0.1,0.1,1], color:'#8b5e34'});",
  );
  const { session } = hostFor(scene);
  const summary = session.preview(
    root, identifiedParts(edited.parts).parts, 'Your edited program', [], { code: 'wider' },
  )!;
  assert.equal(summary.report.conflicts.length, 0);
  assert.equal(session.accept(), true);

  const after = childrenOf(scene, scene.get(root.id)!).find((c) => c.name === 'Top')!;
  assert.equal(after.id, top.id, 'the asset was replaced rather than revised');
  assert.equal(after.materialSlots[0], slot, 'your material was lost');
  assert.ok(after.mesh!.bounds().size().x > 3, 'the edited program was not applied');
  assert.equal(scene.get(root.id)!.provenance!.code, 'wider',
    'the accepted program was not recorded');
});

test('an answer that outlived its question is refused, not applied', () => {
  // Journey 10: a slow revision whose target is replaced while it runs. The id
  // may well be handed to something else, so identity is what is checked.
  const { scene, root } = build('a table');
  const staleAssetId = root.provenance!.assetId;
  const proposal = rebuildRecipe(root.provenance!, { scale: 2 })!.parts;

  // The object is deleted and a different asset takes its place.
  const { session, status } = hostFor(scene);
  const replacement = build('a chair');
  scene.remove(root.id);
  const other = scene.add('empty', 'Chair');
  other.provenance = cloneProvenance(replacement.root.provenance!);

  assert.equal(session.preview(other, proposal, 'late answer', [], {}, staleAssetId), null,
    'a stale answer was applied to whatever was there instead');
  assert.match(status[status.length - 1], /replaced while/);
  assert.equal(session.active, false);

  // The same proposal against its own asset is fine.
  const fresh = build('a table');
  assert.ok(session.preview(
    fresh.root,
    rebuildRecipe(fresh.root.provenance!, { scale: 2 })!.parts,
    'in time', [], {}, fresh.root.provenance!.assetId,
  ));
});

// ----------------------- the review is scoped to its asset, not to the document

test('work done elsewhere during a review survives Reject', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session, history } = hostFor(scene);
  const bystander = scene.add('mesh', 'Not part of this', buildPrimitive('cube'));

  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  // While deciding, the creator gets on with something else entirely.
  bystander.position = new Vec3(4, 4, 4);
  bystander.name = 'A thing I made while thinking';
  const invented = scene.add('mesh', 'Invented mid-review', buildPrimitive('uvsphere'));
  const slot = scene.addMaterial();
  scene.materials[slot].color = [0.2, 0.9, 0.4];
  bystander.materialSlots = [slot];

  assert.equal(session.reject(), true);

  // The asset went back...
  assert.equal(childrenOf(scene, scene.get(root.id)!).length, 8, 'the asset did not go back');
  // ...and none of the rest did.
  const kept = scene.get(bystander.id);
  assert.ok(kept, 'Reject deleted an object made during the review');
  assert.deepEqual(kept!.position.toArray(), [4, 4, 4], 'Reject undid unrelated work');
  assert.equal(kept!.name, 'A thing I made while thinking');
  assert.equal(kept!.materialSlots[0], slot, 'Reject took back a material you made');
  assert.ok(scene.get(invented.id), 'Reject deleted an object invented during the review');
  assert.equal(history.canUndo, false, 'a rejected revision left a step in the history');
});

test('accepting takes in the asset and nothing else, as one undo step', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session, history } = hostFor(scene);

  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');
  const bystander = scene.add('mesh', 'Made during the review', buildPrimitive('cube'));
  bystander.position = new Vec3(2, 0, 0);
  assert.equal(session.accept(), true);
  assert.equal(history.depth, 1);

  // Undo puts the asset back and leaves the unrelated object where it is,
  // because it was never part of what was accepted.
  const step = history.undo({
    label: 'redo', scene: scene.toJSON(history.store), mode: 'object', editObject: null,
    selectMode: 'vertex', verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(step.scene));
  assert.equal(childrenOf(scene, scene.get(root.id)!).length, 8, 'undo did not restore the asset');
  const survivor = scene.get(bystander.id);
  assert.ok(survivor, 'undoing the revision deleted work that was never part of it');
  assert.deepEqual(survivor!.position.toArray(), [2, 0, 0]);
});

test('the asset under review is the only thing held', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session } = hostFor(scene);
  const kids = childrenOf(scene, root);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  assert.equal(session.touches([kids[0].id]), true, 'a part under review is not held');
  assert.equal(session.touches([root.id]), true, 'the asset root is not held');
  const outside = scene.add('mesh', 'Elsewhere', buildPrimitive('cube'));
  assert.equal(session.touches([outside.id]), false, 'an unrelated object was held');
  session.reject();
  assert.equal(session.touches([kids[0].id]), false, 'the hold outlived the review');
});

test('an object parented under the asset during a review is not lost by Reject', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  // Hung onto one of the *proposed* steps, which is about to stop existing.
  const live = childrenOf(scene, scene.get(root.id)!);
  const mine = scene.add('mesh', 'Hung on a proposal', buildPrimitive('cube'));
  scene.setParent(mine.id, live[live.length - 1].id);

  session.reject();
  const survivor = scene.get(mine.id);
  assert.ok(survivor, 'an object you made was deleted with the proposal it hung from');
  assert.equal(survivor!.parent, null, 'it should be lifted to the top level, not orphaned');
  assert.ok(scene.order.includes(mine.id), 'it is not reachable in the outliner');
});

// ------------------------------- per-vertex work is carried, not written off

test('choosing the revised shape carries weights, colours and UVs across', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('uvsphere'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  const baseMesh = part.mesh!.toJSON();
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: baseMesh, materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });

  // Rig it, paint it and unwrap it — three separate things stored against
  // these particular vertices.
  const mesh = part.mesh!;
  mesh.skin = {
    bones: new Int32Array(mesh.vertCount * 4),
    weights: new Float32Array(mesh.vertCount * 4),
  };
  for (let v = 0; v < mesh.vertCount; v++) {
    // Bone 1 above the equator, bone 0 below: a boundary the transfer has to
    // land in roughly the right place.
    const upper = mesh.positions[v].z > 0;
    mesh.skin.bones[v * 4] = upper ? 1 : 0;
    mesh.skin.weights[v * 4] = 1;
  }
  mesh.colors = new Float32Array(mesh.vertCount * 3);
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.colors[v * 3] = mesh.positions[v].z > 0 ? 1 : 0;
  }
  mesh.faceUV = mesh.faces.map(() => new Array(mesh.faces[0].length * 2).fill(0.5));
  mesh.markDirty();

  // A revision that rebuilds it with different topology.
  const denser = catmullClark(buildPrimitive('uvsphere'), 1);
  const proposed = [{
    key: 'body#1', name: 'Body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: denser.toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(scene.get(root.id)!, proposed, 'denser')!;
  const conflict = summary.report.conflicts.find((c) => c.field === 'geometry')!;
  assert.ok(conflict, 'a topology change over rigged work should be a conflict');

  session.resolveConflict('body#1', 'theirs', 'geometry');
  const after = scene.get(part.id)!.mesh!;
  assert.notEqual(after.vertCount, mesh.vertCount, 'the new shape was not applied');
  assert.ok(after.skin, 'the skin weights were thrown away');
  assert.ok(after.colors, 'the vertex colours were thrown away');
  assert.equal(after.hasUV, true, 'the UVs were thrown away');

  // And they landed in the right places, not merely in some place.
  let right = 0;
  let counted = 0;
  for (let v = 0; v < after.vertCount; v++) {
    const z = after.positions[v].z;
    if (Math.abs(z) < 0.15) continue;   // near the boundary, either answer is fair
    counted++;
    const bone = after.skin!.bones[v * 4];
    if ((z > 0 && bone === 1) || (z < 0 && bone === 0)) right++;
  }
  assert.ok(counted > 20, 'not enough vertices away from the boundary to judge');
  assert.ok(right / counted > 0.95,
    `weights landed on the wrong side for ${counted - right} of ${counted} vertices`);

  // The panel says it happened, and how much to trust it.
  assert.ok(session.summary!.notes.some((n) => /Carried your/.test(n)),
    'carrying work across was done silently');
});

test('Keep Both on a one-mesh reference asset leaves a coherent structure', () => {
  const scene = new Scene();
  const asset = scene.add('mesh', 'Badge', buildPrimitive('cube'));
  asset.partKey = 'surface#1';
  asset.position = new Vec3(2, 0, 0);
  const baseMesh = asset.mesh!.toJSON();
  asset.provenance = normaliseProvenance({
    schema: 2, source: 'reference', assetId: 'a1', generator: 'reference:silhouette',
    params: { mode: 'silhouette', depth: 0.4 },
    reference: { textureId: 1, name: 'badge.png', frameTime: 0, width: 4, height: 4 },
    baseline: {
      version: 2,
      parts: [{
        key: 'surface#1', name: 'Badge', position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: baseMesh, materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });
  // Sculpted, so a rebuild is a real disagreement.
  for (const p of asset.mesh!.positions) p.z += 0.2;
  asset.mesh!.markDirty();
  const sculpted = JSON.stringify(asset.mesh!.toJSON());

  const proposed = [{
    key: 'surface#1', name: 'Badge',
    position: [2, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(asset, proposed, 'deeper')!;
  const conflict = summary.report.conflicts.find((c) => c.field === 'geometry')!;
  session.resolveConflict(conflict.key, 'both', 'geometry');
  session.accept();

  const all = [...scene.objects.values()];
  const assets = all.filter((o) => o.provenance);
  assert.equal(assets.length, 1, 'keeping both produced two objects claiming the same asset');
  assert.equal(assets[0].id, asset.id, 'the asset lost its identity');
  assert.equal(assets[0].partKey, 'surface#1', 'the asset lost its part identity');
  assert.ok(assets[0].mesh!.faceCount > 6, 'the asset did not take the generated shape');

  const yours = all.find((o) => o.id !== asset.id && o.name.includes('yours'));
  assert.ok(yours, 'your version was not kept');
  assert.equal(yours!.partKey, null, 'your copy still carries a generated identity');
  assert.equal(yours!.provenance, null, 'your copy would be regenerated again');
  assert.equal(JSON.stringify(yours!.mesh!.toJSON()), sculpted, 'your sculpt was not what was kept');
  assert.equal(yours!.parent, asset.parent, 'your copy is not a sibling of the asset');

  // And the next revision knows exactly what it owns.
  const again = session.preview(scene.get(asset.id)!, proposed, 'again')!;
  assert.equal(again.report.conflicts.length, 0, 'the settled argument came back');
  session.accept();
  assert.ok(scene.get(yours!.id), 'your copy was swept up by the next revision');
});

// ------------------------------------------------- field-scoped resolutions

/**
 * An asset whose shape, name and placement were all edited by hand, against a
 * revision that proposes a different one of each. Three separate arguments.
 */
function threeWayScene(): { scene: Scene; root: SceneObject; part: SceneObject; proposed: never[] } {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: part.mesh!.toJSON(), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });

  // Your three edits: a different shape, a different name, a different place.
  part.mesh = buildPrimitive('cylinder');
  part.name = 'My body';
  part.position = new Vec3(1, 2, 3);

  const proposed = [{
    key: 'body#1', name: 'Generated body',
    position: [9, 9, 9] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  return { scene, root, part, proposed: proposed as never };
}

test('taking the revised shape does not take the name and placement with it', () => {
  const { scene, root, part, proposed } = threeWayScene();
  const { session } = hostFor(scene);
  const summary = session.preview(scene.get(root.id)!, proposed, 'reshape')!;

  const fields = summary.report.conflicts.map((c) => c.field).sort();
  assert.deepEqual(fields, ['geometry', 'name', 'position'],
    'three independent edits should be three independent questions');

  // Answer the one about the shape, and only that one.
  assert.equal(session.resolveConflict('body#1', 'theirs', 'geometry'), true);

  const live = scene.get(part.id)!;
  assert.ok(live.mesh!.vertCount > 8, 'the revised shape was not taken');
  assert.equal(live.name, 'My body',
    'resolving the shape renamed the part — the name was never in question here');
  assert.deepEqual(live.position.toArray(), [1, 2, 3],
    'resolving the shape moved the part back to where the generator wanted it');

  // And the other two are still open, still waiting to be answered.
  const stillOpen = session.summary!.report.conflicts.map((c) => c.field).sort();
  assert.deepEqual(stillOpen, ['name', 'position'],
    'resolving the shape silently closed the other arguments');
});

test('conflicts settle the same way whichever order they are answered in', () => {
  const outcome = (order: ('geometry' | 'name' | 'position')[]): string => {
    const { scene, root, part, proposed } = threeWayScene();
    const { session } = hostFor(scene);
    session.preview(scene.get(root.id)!, proposed, 'reshape');
    // The shape is taken; the name and the placement you chose are kept.
    for (const field of order) {
      session.resolveConflict('body#1', field === 'geometry' ? 'theirs' : 'mine', field);
    }
    const live = scene.get(part.id)!;
    return JSON.stringify({
      verts: live.mesh!.vertCount,
      name: live.name,
      position: live.position.toArray(),
      open: session.summary!.report.conflicts.length,
    });
  };

  const first = outcome(['geometry', 'name', 'position']);
  assert.equal(outcome(['name', 'position', 'geometry']), first,
    'answering the shape last gave a different result from answering it first');
  assert.equal(outcome(['position', 'geometry', 'name']), first,
    'the order the questions were answered in changed the answer');
  assert.match(first, /"name":"My body"/, 'the name you chose did not survive');
  assert.match(first, /"position":\[1,2,3\]/, 'the placement you chose did not survive');
  assert.match(first, /"open":0/, 'not every conflict was settled');
});

// -------------------------------------------------- placement through revert

/**
 * An asset of two generated parts, both moved, turned and resized, with your
 * own detail attached to each: one to a part the revision keeps, one to a part
 * it drops.
 */
function attachedScene(): {
  scene: Scene; root: SceneObject;
  keeper: SceneObject; doomed: SceneObject;
  onKeeper: SceneObject; onDoomed: SceneObject;
} {
  const scene = new Scene();
  const root = scene.add('empty', 'Rig');
  root.position = new Vec3(10, 0, 0);
  root.rotation = new Vec3(0, 0, Math.PI / 3);

  const keeper = scene.add('mesh', 'Bracket', buildPrimitive('cube'));
  keeper.partKey = 'bracket#1';
  keeper.position = new Vec3(2, 3, 4);
  keeper.rotation = new Vec3(Math.PI / 5, 0, Math.PI / 7);
  keeper.scale = new Vec3(2, 2, 2);
  scene.setParent(keeper.id, root.id);

  const doomed = scene.add('mesh', 'Arm', buildPrimitive('cube'));
  doomed.partKey = 'arm#1';
  doomed.position = new Vec3(-1, 5, 2);
  doomed.rotation = new Vec3(0, Math.PI / 4, Math.PI / 6);
  doomed.scale = new Vec3(3, 3, 3);
  scene.setParent(doomed.id, root.id);

  const onKeeper = scene.add('mesh', 'Bolt', buildPrimitive('cube'));
  onKeeper.position = new Vec3(0.5, 0, 0.25);
  scene.setParent(onKeeper.id, keeper.id);

  const onDoomed = scene.add('mesh', 'Washer', buildPrimitive('cube'));
  onDoomed.position = new Vec3(0, 0.75, 0);
  onDoomed.rotation = new Vec3(0, 0, Math.PI / 9);
  scene.setParent(onDoomed.id, doomed.id);

  const partOf = (o: SceneObject) => ({
    key: o.partKey!, name: o.name,
    position: o.position.toArray() as [number, number, number],
    rotation: o.rotation.toArray() as [number, number, number],
    scale: o.scale.toArray() as [number, number, number],
    mesh: o.mesh!.toJSON(),
  });
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [keeper, doomed].map((o) => ({
        ...partOf(o), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      })),
    },
  });
  return { scene, root, keeper, doomed, onKeeper, onDoomed };
}

/** World placement, as sixteen numbers, so a test compares the real thing. */
function worldOf(scene: Scene, id: number): number[] {
  return [...scene.get(id)!.worldMatrix(scene).m];
}

const closeTo = (a: number[], b: number[], why: string): void => {
  assert.equal(a.length, b.length, why);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-6,
      `${why} (entry ${i}: ${a[i].toFixed(6)} vs ${b[i].toFixed(6)})`);
  }
};

test('a detail on a dropped part keeps its place in the world through Reject', () => {
  const { scene, root, doomed, onDoomed, onKeeper, keeper } = attachedScene();
  const { session } = hostFor(scene);

  const washerBefore = worldOf(scene, onDoomed.id);
  const boltBefore = worldOf(scene, onKeeper.id);

  // The revision keeps the bracket and drops the arm entirely.
  const proposed = [{
    key: 'bracket#1', name: 'Bracket',
    position: keeper.position.toArray() as [number, number, number],
    rotation: keeper.rotation.toArray() as [number, number, number],
    scale: keeper.scale.toArray() as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  const summary = session.preview(scene.get(root.id)!, proposed as never, 'drop the arm')!;
  // Dropping a part you have hung your own work on is a question, not a
  // foregone conclusion. Answer it the generator's way.
  const removal = summary.report.conflicts.find((c) => c.key === 'arm#1');
  assert.ok(removal, 'dropping a part carrying your work went through unasked');
  session.resolveConflict('arm#1', 'theirs', removal!.field);
  assert.ok(!scene.get(doomed.id), 'the arm was not dropped');

  // Lifted clear of the part that went, and still exactly where it was.
  closeTo(worldOf(scene, onDoomed.id), washerBefore,
    'your washer moved when the part under it was dropped');

  session.reject();

  // Reject puts the arm back, and the washer belongs to it again — at the same
  // place in the world it has been the whole time.
  assert.ok(scene.get(doomed.id), 'Reject did not put the dropped part back');
  closeTo(worldOf(scene, onDoomed.id), washerBefore, 'your washer moved when the revision was rejected');
  closeTo(worldOf(scene, onKeeper.id), boltBefore, 'your bolt moved when the revision was rejected');
});

test('reverting a moved part carries the work attached to it', () => {
  const { scene, root, keeper, onKeeper } = attachedScene();
  const { session } = hostFor(scene);

  const boltLocal = onKeeper.position.toArray();
  const proposed = [
    {
      key: 'bracket#1', name: 'Bracket',
      // The revision picks the bracket up and puts it somewhere else entirely.
      position: [-40, 12, 7] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      mesh: keeper.mesh!.toJSON(),
    },
    {
      key: 'arm#1', name: 'Arm',
      position: [-1, 5, 2] as [number, number, number],
      rotation: [0, Math.PI / 4, Math.PI / 6] as [number, number, number],
      scale: [3, 3, 3] as [number, number, number],
      mesh: buildPrimitive('cube').toJSON(),
    },
  ];
  session.preview(scene.get(root.id)!, proposed as never, 'move the bracket');

  // A bolt on a bracket goes where the bracket goes: that is what attaching it
  // meant, and freezing it in world space would leave it hanging in the air.
  assert.deepEqual(scene.get(onKeeper.id)!.position.toArray(), boltLocal,
    'the bolt was detached from the bracket it is bolted to');
  assert.equal(scene.get(onKeeper.id)!.parent, keeper.id);

  session.reject();
  assert.deepEqual(scene.get(onKeeper.id)!.position.toArray(), boltLocal,
    'rejecting changed how the bolt is attached');
  assert.equal(scene.get(onKeeper.id)!.parent, keeper.id, 'the bolt lost its bracket');
});

test('a scoped revert leaves the hierarchy sound: reciprocal, single-entry, walkable', () => {
  const { scene, root, doomed, onDoomed } = attachedScene();
  const { session } = hostFor(scene);

  const proposed = [{
    key: 'bracket#1', name: 'Bracket',
    position: [2, 3, 4] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  session.preview(scene.get(root.id)!, proposed as never, 'drop the arm');
  // Something new of yours, made during the review and hung on the asset.
  const during = scene.add('mesh', 'Shim', buildPrimitive('cube'));
  scene.setParent(during.id, root.id);
  session.reject();

  const doc = scene.toJSON();
  const byId = new Map(doc.objects.map((o) => [o.id, o]));

  // No id twice, and no id in the outliner twice.
  assert.equal(byId.size, doc.objects.length, 'an object appears twice in the document');
  assert.equal(new Set(doc.order).size, doc.order.length, 'an object is listed twice in the outliner');

  for (const o of doc.objects) {
    if (o.parent !== null) {
      const parent = byId.get(o.parent);
      assert.ok(parent, `"${o.name}" names a parent that is not there`);
      assert.ok(parent!.children.includes(o.id), `"${o.name}" is not in its parent's children`);
    }
    for (const child of o.children) {
      assert.equal(byId.get(child)?.parent, o.id, `"${o.name}" claims a child that disowns it`);
    }
    // Every top-level object is listed exactly once, and no child is.
    assert.equal(doc.order.includes(o.id), o.parent === null,
      `"${o.name}" is ${o.parent === null ? 'missing from' : 'wrongly in'} the outliner`);
  }

  // Everything is reachable by walking down from the roots.
  const seen = new Set<number>();
  const walk = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of byId.get(id)?.children ?? []) walk(c);
  };
  for (const id of doc.order) walk(id);
  assert.equal(seen.size, doc.objects.length, 'an object cannot be reached from any root');

  assert.ok(scene.get(doomed.id), 'the dropped part did not come back');
  assert.ok(scene.get(onDoomed.id), 'your washer was lost');
  assert.ok(scene.get(during.id), 'work made during the review was lost');
});

test('work hung on a part the revision invented keeps its place when the part goes', () => {
  const { scene, root, keeper } = attachedScene();
  const { session } = hostFor(scene);

  // The revision keeps both parts and adds a third, well away from the origin
  // and turned and scaled, so that "kept its local transform" and "kept its
  // place in the world" cannot possibly be the same answer.
  const proposed = [
    {
      key: 'bracket#1', name: 'Bracket',
      position: keeper.position.toArray() as [number, number, number],
      rotation: keeper.rotation.toArray() as [number, number, number],
      scale: keeper.scale.toArray() as [number, number, number],
      mesh: keeper.mesh!.toJSON(),
    },
    {
      key: 'mount#1', name: 'Mount',
      position: [12, -7, 3] as [number, number, number],
      rotation: [Math.PI / 3, Math.PI / 8, -Math.PI / 5] as [number, number, number],
      scale: [4, 4, 4] as [number, number, number],
      mesh: buildPrimitive('cube').toJSON(),
    },
  ];
  session.preview(scene.get(root.id)!, proposed as never, 'add a mount');

  const mount = [...scene.objects.values()].find((o) => o.partKey === 'mount#1')!;
  assert.ok(mount, 'the revision did not add the new part');

  // You bolt something of your own onto the part the revision proposed.
  const yours = scene.add('mesh', 'Sensor', buildPrimitive('cube'));
  yours.position = new Vec3(0, 0.5, 0.25);
  yours.rotation = new Vec3(0, Math.PI / 11, 0);
  scene.setParent(yours.id, mount.id);
  const sensorWorld = worldOf(scene, yours.id);

  session.reject();

  // The mount was never agreed to and goes. What you made is yours, stays, and
  // stays where you put it — not dropped back to the origin by having its
  // parent taken away and its local transform left behind.
  assert.ok(!scene.get(mount.id), 'the proposed part survived a rejection');
  const survivor = scene.get(yours.id);
  assert.ok(survivor, 'your sensor was destroyed with the part it was attached to');
  assert.equal(survivor!.parent, null, 'your sensor still points at a part that is gone');
  closeTo(worldOf(scene, yours.id), sensorWorld,
    'your sensor moved when the part under it was rejected');
});

test('accepting, then undoing, also keeps that work in place', () => {
  const { scene, root, keeper } = attachedScene();
  const { session, history } = hostFor(scene);
  const proposed = [
    {
      key: 'bracket#1', name: 'Bracket',
      position: keeper.position.toArray() as [number, number, number],
      rotation: keeper.rotation.toArray() as [number, number, number],
      scale: keeper.scale.toArray() as [number, number, number],
      mesh: keeper.mesh!.toJSON(),
    },
    {
      key: 'mount#1', name: 'Mount',
      position: [12, -7, 3] as [number, number, number],
      rotation: [Math.PI / 3, Math.PI / 8, -Math.PI / 5] as [number, number, number],
      scale: [4, 4, 4] as [number, number, number],
      mesh: buildPrimitive('cube').toJSON(),
    },
  ];
  const staged = session.preview(scene.get(root.id)!, proposed as never, 'add a mount')!;
  // The arm is not in this proposal and carries work of yours, so its removal
  // is a question. Keep it, which is the answer that leaves the rest to test.
  for (const c of [...staged.report.conflicts]) session.resolveConflict(c.key, 'mine', c.field);
  const mount = [...scene.objects.values()].find((o) => o.partKey === 'mount#1')!;
  const yours = scene.add('mesh', 'Sensor', buildPrimitive('cube'));
  yours.position = new Vec3(0, 0.5, 0.25);
  scene.setParent(yours.id, mount.id);
  const sensorWorld = worldOf(scene, yours.id);

  assert.equal(session.accept(), true);
  assert.equal(history.depth, 1, 'accepting a revision should cost exactly one undo step');

  const back = history.undo({
    label: 'redo', scene: scene.toJSON(), mode: 'object', editObject: null,
    selectMode: 'vertex' as SelectMode, verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(back.scene));

  assert.ok(!scene.get(mount.id), 'undoing the revision left the new part behind');
  assert.ok(scene.get(yours.id), 'undoing the revision destroyed work made during it');
  closeTo(worldOf(scene, yours.id), sensorWorld, 'undoing the revision moved your sensor');
});

test('a scene reconstructed this way still saves and reloads intact', () => {
  const { scene, root, keeper } = attachedScene();
  const { session } = hostFor(scene);
  session.preview(scene.get(root.id)!, [{
    key: 'bracket#1', name: 'Bracket',
    position: keeper.position.toArray() as [number, number, number],
    rotation: keeper.rotation.toArray() as [number, number, number],
    scale: keeper.scale.toArray() as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }] as never, 'reshape');
  const mine = scene.add('mesh', 'Shim', buildPrimitive('cube'));
  mine.position = new Vec3(3, 3, 3);
  scene.setParent(mine.id, scene.get(root.id)!.id);
  const shimWorld = worldOf(scene, mine.id);
  session.reject();

  const reloaded = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.equal(reloaded.objects.size, scene.objects.size, 'reloading lost or duplicated an object');
  closeTo([...reloaded.get(mine.id)!.worldMatrix(reloaded).m], shimWorld,
    'your work moved across a save and reload');
  assert.equal(reloaded.get(root.id)!.provenance?.assetId, 'a1', 'the record did not survive');
  // Written twice, the same bytes come out: nothing here is order-dependent.
  assert.equal(JSON.stringify(reloaded.toJSON().objects), JSON.stringify(scene.toJSON().objects));
});

// ------------------------------------------------ the preview and the history

/**
 * A host wired the way the Editor is wired, so these exercise the real
 * contract rather than a convenient one: the history records what
 * `committedScene` says, and going back to a recorded step puts the proposal
 * back on top through `withProposal`.
 */
function editorLike(scene: Scene): {
  session: RevisionSession; history: History;
  edit(label: string, change: () => void): void;
  undo(): void; redo(): void;
} {
  const history = new History();
  let session!: RevisionSession;
  const snapshot = (label: string) => ({
    label,
    scene: session.committedScene() ?? scene.toJSON(history.store),
    mode: 'object' as const,
    editObject: null,
    selectMode: 'vertex' as SelectMode,
    verts: [], edges: [], faces: [],
  });
  const restore = (snap: ReturnType<typeof snapshot>): void => {
    scene.adopt(Scene.fromJSON(session.withProposal(snap.scene)));
  };
  session = new RevisionSession({
    scene,
    snapshotStore: () => history.store,
    snapshot,
    restore,
    pushHistory: (snap) => history.push(snap),
    setStatus: () => {},
    refresh: () => {},
  });
  return {
    session,
    history,
    // The shape of Editor.beginUndo: record, then change.
    edit(label, change) {
      history.push(snapshot(label));
      change();
    },
    undo() {
      const s = history.undo(snapshot('redo'));
      if (s) restore(s);
    },
    redo() {
      const s = history.redo(snapshot('undo'));
      if (s) restore(s);
    },
  };
}

/** A cube of the asset's own, plus one object of yours standing beside it. */
function assetAndBystander(): { scene: Scene; root: SceneObject; part: SceneObject; mine: SceneObject } {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: part.mesh!.toJSON(), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });
  const mine = scene.add('mesh', 'Mine', buildPrimitive('cube'));
  mine.position = new Vec3(5, 0, 0);
  return { scene, root, part, mine };
}

const sphereProposal = [{
  key: 'body#1', name: 'Body',
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  mesh: buildPrimitive('uvsphere').toJSON(),
}];

test('a rejected shape cannot come back through an unrelated undo', () => {
  const { scene, root, part, mine } = assetAndBystander();
  const app = editorLike(scene);
  const cubeFaces = scene.get(part.id)!.mesh!.faceCount;

  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');
  assert.notEqual(scene.get(part.id)!.mesh!.faceCount, cubeFaces, 'the preview did not apply');

  // While looking at it you move something else. That edit is yours and is
  // undoable; the proposal in front of you is not yours and is not.
  app.edit('Move Mine', () => { scene.get(mine.id)!.position = new Vec3(9, 0, 0); });

  app.session.reject();
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces, 'Reject did not put the shape back');
  assert.equal(scene.get(mine.id)!.position.x, 9, 'Reject undid your unrelated move');

  // The whole point: undoing that unrelated move must not resurrect the shape
  // you rejected. It used to, because the snapshot taken for the move had the
  // proposal inside it.
  app.undo();
  assert.equal(scene.get(mine.id)!.position.x, 5, 'undo did not undo your move');
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces,
    'a shape you rejected came back through an unrelated undo');

  app.redo();
  assert.equal(scene.get(mine.id)!.position.x, 9, 'redo did not redo your move');
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces,
    'a shape you rejected came back through an unrelated redo');
});

test('an object created during a review survives a rejection and stays undoable', () => {
  const { scene, root, part } = assetAndBystander();
  const app = editorLike(scene);
  const cubeFaces = scene.get(part.id)!.mesh!.faceCount;
  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');

  let madeId = 0;
  app.edit('Add Cube', () => {
    const made = scene.add('mesh', 'Made', buildPrimitive('cube'));
    made.position = new Vec3(-4, 0, 0);
    madeId = made.id;
  });
  app.edit('Move Made', () => { scene.get(madeId)!.position = new Vec3(-8, 0, 0); });

  app.session.reject();
  assert.ok(scene.get(madeId), 'Reject destroyed an object you made while deciding');
  assert.equal(scene.get(madeId)!.position.x, -8);

  app.undo();
  assert.equal(scene.get(madeId)!.position.x, -4, 'the move was not undone');
  app.undo();
  assert.ok(!scene.get(madeId), 'undoing the creation did not remove it');
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces, 'the rejected shape reappeared');

  app.redo();
  assert.ok(scene.get(madeId), 'redo did not put it back');
  app.redo();
  assert.equal(scene.get(madeId)!.position.x, -8, 'redo did not replay the move');
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces,
    'the rejected shape reappeared through redo');
});

test('accepting is one step, and the steps under it are still your own', () => {
  const { scene, root, part, mine } = assetAndBystander();
  const app = editorLike(scene);
  const cubeFaces = scene.get(part.id)!.mesh!.faceCount;

  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');
  app.edit('Move Mine', () => { scene.get(mine.id)!.position = new Vec3(9, 0, 0); });
  assert.equal(app.session.accept(), true);

  const roundFaces = scene.get(part.id)!.mesh!.faceCount;
  assert.notEqual(roundFaces, cubeFaces);
  assert.equal(scene.get(root.id)!.provenance!.revision, 1, 'the record did not advance');

  // One step for the whole revision.
  app.undo();
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces, 'undo did not take the revision back');
  assert.equal(scene.get(root.id)!.provenance!.revision, 0, 'the record did not go back with it');
  assert.equal(scene.get(mine.id)!.position.x, 9, 'undoing the revision also undid your move');

  // Then your own work, underneath it, one step at a time.
  app.undo();
  assert.equal(scene.get(mine.id)!.position.x, 5, 'your move was not undoable after the revision');

  app.redo();
  assert.equal(scene.get(mine.id)!.position.x, 9);
  app.redo();
  assert.equal(scene.get(part.id)!.mesh!.faceCount, roundFaces, 'redo did not put the revision back');
  assert.equal(scene.get(root.id)!.provenance!.revision, 1, 'the record did not come back');
});

test('stepping through your own history during a review leaves the proposal up', () => {
  const { scene, root, part, mine } = assetAndBystander();
  const app = editorLike(scene);
  const cubeFaces = scene.get(part.id)!.mesh!.faceCount;

  app.edit('Move Mine', () => { scene.get(mine.id)!.position = new Vec3(9, 0, 0); });
  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');
  const roundFaces = scene.get(part.id)!.mesh!.faceCount;

  app.undo();
  assert.equal(scene.get(mine.id)!.position.x, 5, 'undo did not reach your earlier move');
  assert.equal(scene.get(part.id)!.mesh!.faceCount, roundFaces,
    'undoing your own work took the proposal off the screen');
  assert.equal(app.session.active, true, 'the review was cancelled by an undo');

  app.redo();
  assert.equal(scene.get(mine.id)!.position.x, 9);
  assert.equal(scene.get(part.id)!.mesh!.faceCount, roundFaces, 'redo took the proposal away');

  // And it can still be answered, either way, from there.
  app.session.reject();
  assert.equal(scene.get(part.id)!.mesh!.faceCount, cubeFaces, 'Reject stopped working');
  assert.equal(scene.get(mine.id)!.position.x, 9, 'Reject undid your work');
});

// ------------------------------------------------- placement that cannot fit

/**
 * A rotated child under a non-uniformly scaled proposed parent.
 *
 * The one arrangement position/rotation/scale genuinely cannot reproduce once
 * the parent goes: the combination is a shear, and there is no euler rotation
 * and axis scale that makes one.
 */
function shearScene(): { scene: Scene; root: SceneObject; proposed: never } {
  const scene = new Scene();
  const root = scene.add('empty', 'Rig');
  const anchor = scene.add('mesh', 'Anchor', buildPrimitive('cube'));
  anchor.partKey = 'anchor#1';
  scene.setParent(anchor.id, root.id);
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'anchor#1', name: 'Anchor', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: anchor.mesh!.toJSON(), materialSlots: [], materials: [], modifiers: [],
        animation: [], visible: true, locked: false,
      }],
    },
  });
  const proposed = [
    {
      key: 'anchor#1', name: 'Anchor',
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      mesh: anchor.mesh!.toJSON(),
    },
    {
      key: 'skew#1', name: 'Skew',
      position: [3, 1, 2] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      // Wildly non-uniform: this is what turns a rotated child into a shear.
      scale: [5, 1, 0.25] as [number, number, number],
      mesh: buildPrimitive('cube').toJSON(),
    },
  ];
  return { scene, root, proposed: proposed as never };
}

/** Hang a rotated object of your own under the proposed skewed part. */
function rotatedChildUnderSkew(scene: Scene): { yours: SceneObject; skew: SceneObject } {
  const skew = [...scene.objects.values()].find((o) => o.partKey === 'skew#1')!;
  const yours = scene.add('mesh', 'Tag', buildPrimitive('cube'));
  yours.position = new Vec3(0.4, 0.2, 0.1);
  yours.rotation = new Vec3(0, 0, Math.PI / 4);
  scene.setParent(yours.id, skew.id);
  return { yours, skew };
}

test('a placement that cannot be reproduced exactly is applied as closely as possible and said out loud', () => {
  const { scene, root, proposed } = shearScene();
  const { session, notices } = hostFor(scene);
  session.preview(scene.get(root.id)!, proposed, 'add a skewed mount');
  const { yours, skew } = rotatedChildUnderSkew(scene);
  const wanted = worldOf(scene, yours.id);

  assert.equal(session.reject(), true);

  // The part it was hanging on is gone; your object is not.
  assert.ok(!scene.get(skew.id), 'the proposed part survived a rejection');
  const survivor = scene.get(yours.id)!;
  assert.ok(survivor, 'your work went with the part it was attached to');

  const got = worldOf(scene, yours.id);
  const worst = Math.max(...got.map((n, i) => Math.abs(n - wanted[i])));

  // Either it fits exactly, or it does not and that is reported. What must not
  // happen is the second one silently.
  const outcome = session.outcome!;
  assert.ok(outcome, 'a finished revision left no record of itself');
  assert.equal(outcome.action, 'rejected');
  if (worst > 1e-6) {
    assert.ok(outcome.warnings.length > 0,
      `placement was off by ${worst} and nothing was said about it`);
    assert.match(outcome.warnings.join(' '), /shear|as closely as/);
    assert.equal(notices.length, 1, 'the warning never reached a visible notice');
    assert.match(notices[0].title, /Rejected/);
  } else {
    assert.deepEqual(outcome.warnings, [],
      'an exact placement was reported as an approximation');
  }
});

test('the same placement warning arrives at the undo, not at the accept', () => {
  const { scene, root, proposed } = shearScene();
  const { session, history, notices } = hostFor(scene);
  session.preview(scene.get(root.id)!, proposed, 'add a skewed mount');
  const { yours } = rotatedChildUnderSkew(scene);
  const wanted = worldOf(scene, yours.id);

  assert.equal(session.accept(), true);
  // Accepting keeps the asset exactly as previewed. Nothing was approximated,
  // so nothing is claimed to have been.
  assert.deepEqual(notices, [], 'accepting warned about an approximation it had not made');
  assert.equal(session.outcome!.action, 'accepted');

  const entry = history.steps()[0];
  assert.ok(entry, 'accepting recorded no undo step');

  const back = history.undo({
    label: 'redo', scene: scene.toJSON(), mode: 'object', editObject: null,
    selectMode: 'vertex' as SelectMode, verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(back.scene));

  const got = worldOf(scene, yours.id);
  const worst = Math.max(...got.map((n, i) => Math.abs(n - wanted[i])));
  if (worst > 1e-6) {
    // The approximation happens *here*, so the warning has to be attached to
    // the state that causes it rather than announced when it was computed.
    assert.ok((back.warnings ?? []).length > 0,
      `the undo moved your work by ${worst} and carried no warning`);
    assert.match((back.warnings ?? []).join(' '), /shear|as closely as/);
  } else {
    assert.deepEqual(back.warnings ?? [], [],
      'an exact undo carried a warning about an approximation');
  }
});

test('an ordinary revision finishes with a record and nothing to warn about', () => {
  const { scene, root, part } = assetAndBystander();
  const { session, notices } = hostFor(scene);
  session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');
  assert.equal(session.accept(), true);
  assert.deepEqual(notices, [], 'a clean revision produced a warning');
  assert.deepEqual(session.outcome, { label: 'make it round', action: 'accepted', warnings: [] });
  assert.ok(scene.get(part.id));

  session.dismissOutcome();
  assert.equal(session.outcome, null, 'the record could not be dismissed');
});

// -------------------------------------------- reconstruction touches nothing

/** A deep, stable description of a serialized document. */
const frozen = (doc: object): string => JSON.stringify(doc);

test('reconstruction never writes back into the snapshots it reads', () => {
  const { scene, root, proposed } = shearScene();
  const app = editorLike(scene);
  app.session.preview(scene.get(root.id)!, proposed, 'add a skewed mount');
  rotatedChildUnderSkew(scene);

  // Everything the reconstruction is about to read from.
  const heldBefore = frozen(app.history.steps().map((st) => st.scene));

  // Measuring a committed document is the thing that happens most often — once
  // per unrelated edit during a review — so it is the one most able to corrupt
  // what it reads.
  const first = frozen(app.session.committedScene()!);
  const second = frozen(app.session.committedScene()!);
  assert.equal(second, first, 'building the committed document twice gave two answers');

  // And putting the proposal back over a stored step.
  const step = app.history.steps()[0];
  if (step) {
    const stepBefore = frozen(step.scene);
    app.session.withProposal(step.scene);
    app.session.withProposal(step.scene);
    assert.equal(frozen(step.scene), stepBefore,
      'restoring a history entry rewrote the entry it was restoring');
  }
  assert.equal(frozen(app.history.steps().map((st) => st.scene)), heldBefore,
    'the history was altered by being read');
});

test('repeated undo and redo during a review stay on the same states', () => {
  const { scene, root, part, mine } = assetAndBystander();
  const app = editorLike(scene);
  app.edit('Move Mine', () => { scene.get(mine.id)!.position = new Vec3(9, 0, 0); });
  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');

  const at = (): string => JSON.stringify({
    mine: scene.get(mine.id)?.position.toArray(),
    faces: scene.get(part.id)?.mesh?.faceCount,
    reviewing: app.session.active,
  });

  app.undo();
  const undone = at();
  app.redo();
  const redone = at();
  // The stacks re-capture as they turn over — an undo pushes the state it left
  // onto the redo side — so the *entries* legitimately change hands. What must
  // not change is where they lead.
  const settled = frozen(app.history.steps().map((st) => st.scene));

  // Round and round: every lap has to land on the same two states.
  for (let i = 0; i < 4; i++) {
    app.undo();
    assert.equal(at(), undone, `undo drifted on lap ${i + 1}`);
    app.redo();
    assert.equal(at(), redone, `redo drifted on lap ${i + 1}`);
    assert.equal(frozen(app.history.steps().map((st) => st.scene)), settled,
      `the recorded states drifted on lap ${i + 1}`);
  }
});

test('rejecting after a rebuild still restores exactly what was held', () => {
  const { scene, root, part, mine } = assetAndBystander();
  const app = editorLike(scene);
  const before = scene.get(part.id)!.mesh!.faceCount;
  app.session.preview(scene.get(root.id)!, sphereProposal as never, 'make it round');

  // Build the committed document several times over — every unrelated edit
  // does — then reject. A rebuild that had damaged the held snapshot would
  // show up here as a rejection that restores the wrong thing.
  app.session.committedScene();
  app.edit('Move Mine', () => { scene.get(mine.id)!.position = new Vec3(9, 0, 0); });
  app.session.committedScene();
  app.edit('Move Mine again', () => { scene.get(mine.id)!.position = new Vec3(11, 0, 0); });

  assert.equal(app.session.reject(), true);
  assert.equal(scene.get(part.id)!.mesh!.faceCount, before,
    'the asset was not restored to what was held');
  assert.equal(scene.get(mine.id)!.position.x, 11, 'rejecting undid your unrelated work');
});

test('putting the proposal back over a stored step does not rewrite the step', () => {
  // Your own work, hanging on a part the revision drops. Restoring a step from
  // before the preview means rebuilding a document in which that part is gone
  // but your work is not — which is the case that has to *move* something, and
  // so the case that can damage what it is reading.
  const scene = new Scene();
  const root = scene.add('empty', 'Rig');
  const keep = scene.add('mesh', 'Keep', buildPrimitive('cube'));
  keep.partKey = 'keep#1';
  scene.setParent(keep.id, root.id);
  const drop = scene.add('mesh', 'Drop', buildPrimitive('cube'));
  drop.partKey = 'drop#1';
  drop.position = new Vec3(4, 5, 6);
  drop.rotation = new Vec3(0, 0, Math.PI / 3);
  scene.setParent(drop.id, root.id);
  const tag = scene.add('mesh', 'Tag', buildPrimitive('cube'));
  tag.position = new Vec3(0.5, 0, 0);
  scene.setParent(tag.id, drop.id);

  const partOf = (o: SceneObject) => ({
    key: o.partKey!, name: o.name,
    position: o.position.toArray() as [number, number, number],
    rotation: o.rotation.toArray() as [number, number, number],
    scale: o.scale.toArray() as [number, number, number],
    mesh: o.mesh!.toJSON(),
  });
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [keep, drop].map((o) => ({
        ...partOf(o), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      })),
    },
  });

  const app = editorLike(scene);
  app.edit('Nudge', () => { scene.get(tag.id)!.position = new Vec3(0.75, 0, 0); });
  const step = app.history.steps()[0];
  assert.ok(step, 'nothing was recorded to rebuild against');
  const stored = JSON.stringify(step.scene);

  // A revision that keeps one part and drops the other.
  const summary = app.session.preview(scene.get(root.id)!, [partOf(scene.get(keep.id)!)] as never,
    'drop the arm')!;
  const removal = summary.report.conflicts.find((c) => c.key === 'drop#1');
  assert.ok(removal, 'dropping a part carrying your work went through unasked');
  app.session.resolveConflict('drop#1', 'theirs', removal!.field);
  assert.ok(!scene.get(drop.id), 'the part was not dropped');

  const rebuilt = app.session.withProposal(step.scene);
  assert.equal(JSON.stringify(step.scene), stored,
    'rebuilding against a recorded step rewrote the step itself');

  // Twice, because a rebuild that damages its input gives a different answer
  // the second time round.
  const again = app.session.withProposal(step.scene);
  assert.equal(JSON.stringify(again), JSON.stringify(rebuilt),
    'rebuilding the same step twice gave two different documents');
  assert.equal(JSON.stringify(step.scene), stored, 'the second rebuild rewrote the step');
});
