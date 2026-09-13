import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import {
  actionRange, blendStrips, cloneActions, cloneStrips, createAction, createStrip, stripAt,
} from '../src/anim/actions';
import { Channel } from '../src/anim/animation';

/** A channel that moves one axis from `a` to `b` over the given frames. */
function ramp(
  path: Channel['path'], index: number, from: [number, number], to: [number, number],
): Channel {
  return {
    path, index,
    keys: [
      { frame: from[0], value: from[1], interp: 'linear' },
      { frame: to[0], value: to[1], interp: 'linear' },
    ],
  };
}

const walk = () => createAction('Walk', [ramp('position', 0, [1, 0], [11, 10])]);
const wave = () => createAction('Wave', [ramp('position', 2, [1, 0], [11, 2])]);

test('a strip plays its action over the frames it covers', () => {
  const a = walk();
  const s = createStrip(a.id, 1, 11);
  s.offset = 1;
  assert.equal(stripAt(s, 0), null, 'the strip played before it starts');
  assert.equal(stripAt(s, 12), null, 'the strip played after it ends');
  assert.equal(blendStrips([s], [a], 1).values.get('position')![0], 0);
  assert.equal(blendStrips([s], [a], 11).values.get('position')![0], 10);
  assert.equal(blendStrips([s], [a], 6).values.get('position')![0], 5);
});

test('offset enters an action part way through', () => {
  // The thing that lets a cycle be picked up mid-stride rather than always
  // starting from the same frame.
  const a = walk();
  const s = createStrip(a.id, 1, 6);
  s.offset = 6;
  assert.equal(blendStrips([s], [a], 1).values.get('position')![0], 5);
});

test('speed rescales the action without moving the strip', () => {
  const a = walk();
  const s = createStrip(a.id, 1, 6);
  s.offset = 1;
  s.scale = 2;
  // Five timeline frames covering ten of the action.
  assert.equal(blendStrips([s], [a], 6).values.get('position')![0], 10);
});

test('a looping strip repeats the action for as long as it lasts', () => {
  const a = walk();
  const s = createStrip(a.id, 1, 31);
  s.offset = 1;
  s.loop = true;
  // The action is ten frames long; frame 11 is one lap, 21 is two.
  const at = (f: number) => blendStrips([s], [a], f).values.get('position')![0];
  assert.ok(Math.abs(at(6) - 5) < 1e-9);
  assert.ok(Math.abs(at(16) - 5) < 1e-9, 'the second lap did not line up with the first');
  assert.ok(Math.abs(at(26) - 5) < 1e-9, 'the third lap drifted');
});

test('two strips replacing each other cross over their fades', () => {
  const first = createAction('A', [ramp('position', 0, [1, 0], [20, 0])]);
  const second = createAction('B', [ramp('position', 0, [1, 10], [20, 10])]);
  const a = createStrip(first.id, 1, 20);
  a.offset = 1;
  const b = createStrip(second.id, 11, 30);
  b.offset = 1;
  b.fadeIn = 10;

  const at = (f: number) => blendStrips([a, b], [first, second], f).values.get('position')![0];
  assert.ok(Math.abs(at(11) - 0) < 1e-9, 'the second take was already showing at its first frame');
  assert.ok(Math.abs(at(16) - 5) < 1e-6, `halfway through the fade should be halfway across, got ${at(16)}`);
  // Ten frames of fade starting at 11 finishes at 21, not 20.
  assert.ok(Math.abs(at(21) - 10) < 1e-6, `the fade did not finish, got ${at(21)}`);
});

test('an additive strip rides on top instead of replacing', () => {
  // The case the single channel list could not express at all: a wave while
  // walking. The walk drives X, the wave adds to Z, and neither is lost.
  const w = walk();
  const v = wave();
  const base = createStrip(w.id, 1, 11);
  base.offset = 1;
  const over = createStrip(v.id, 1, 11);
  over.offset = 1;
  over.blend = 'add';

  const values = blendStrips([base, over], [w, v], 6).values.get('position')!;
  assert.ok(Math.abs(values[0] - 5) < 1e-9, 'the walk was lost');
  assert.ok(Math.abs(values[2] - 1) < 1e-9, 'the wave was lost');
});

test('an additive strip adds its departure from rest, not its absolute value', () => {
  // Two copies of the same additive action must double the motion; if it were
  // adding absolutes the rest offset would be counted twice as well.
  const a = createAction('Nod', [ramp('rotation', 0, [1, 0], [11, 1])]);
  const one = createStrip(a.id, 1, 11);
  one.offset = 1;
  one.blend = 'add';
  const two = { ...createStrip(a.id, 1, 11), offset: 1, blend: 'add' as const };
  assert.equal(blendStrips([one], [a], 11).values.get('rotation')![0], 1);
  assert.equal(blendStrips([one, two], [a], 11).values.get('rotation')![0], 2);
});

test('weight scales a strip without changing where it plays', () => {
  const a = walk();
  const s = createStrip(a.id, 1, 11);
  s.offset = 1;
  s.weight = 0.25;
  assert.ok(Math.abs(blendStrips([s], [a], 11).values.get('position')![0] - 2.5) < 1e-9);
});

test('a disabled strip contributes nothing', () => {
  const a = walk();
  const s = createStrip(a.id, 1, 11);
  s.offset = 1;
  s.enabled = false;
  assert.equal(blendStrips([s], [a], 6).any, false);
});

test('a strip pointing at an action that is gone is skipped, not a crash', () => {
  const s = createStrip('nothing-with-this-id', 1, 11);
  assert.doesNotThrow(() => blendStrips([s], [walk()], 6));
  assert.equal(blendStrips([s], [walk()], 6).any, false);
});

test('the scene evaluates strips through the one frame-setting path', () => {
  // Playback, scrubbing and rendering all go through setFrame, so a strip has
  // to be driven from there or it would show in one of the three and not the
  // others.
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const a = walk();
  obj.actions = [a];
  const s = createStrip(a.id, 1, 11);
  s.offset = 1;
  obj.strips = [s];

  scene.setFrame(1);
  assert.equal(obj.position.x, 0);
  scene.setFrame(11);
  assert.equal(obj.position.x, 10);
  scene.setFrame(6);
  assert.equal(obj.position.x, 5);
});

test('an object with no strips is driven by its own keys, exactly as before', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  obj.animation = [ramp('position', 1, [1, 0], [11, 4])];
  scene.setFrame(6);
  assert.equal(obj.position.y, 2);
  // And stashing keys does not change that — the strips list is what switches.
  obj.actions = [createAction('Kept', obj.animation)];
  scene.setFrame(11);
  assert.equal(obj.position.y, 4);
});

test('actions and strips survive a save and reload', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const a = walk();
  obj.actions = [a];
  const s = createStrip(a.id, 5, 25);
  s.blend = 'add';
  s.fadeIn = 3;
  s.loop = true;
  obj.strips = [s];

  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const reloaded = [...back.objects.values()][0];
  assert.equal(reloaded.actions.length, 1);
  assert.equal(reloaded.actions[0].name, 'Walk');
  assert.equal(reloaded.actions[0].channels.length, 1);
  assert.equal(reloaded.strips.length, 1);
  assert.equal(reloaded.strips[0].blend, 'add');
  assert.equal(reloaded.strips[0].fadeIn, 3);
  assert.equal(reloaded.strips[0].loop, true);
  back.setFrame(15);
  assert.ok(Number.isFinite(reloaded.position.x));
});

test('a strip whose action did not survive the file is dropped on the way in', () => {
  // Better than a row in the panel that can never do anything.
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const doc = JSON.parse(JSON.stringify(scene.toJSON()));
  doc.objects[0].actions = [];
  doc.objects[0].strips = [{ action: 'ghost', start: 1, end: 10 }];
  const back = Scene.fromJSON(doc);
  assert.deepEqual([...back.objects.values()][0].strips, []);
  assert.ok(obj);
});

test('actions and strips off a file are cleaned rather than trusted', () => {
  const actions = cloneActions([
    { id: 'a', name: 'Good', channels: [] },
    { name: 'no id' },
    null,
  ]);
  assert.equal(actions.length, 1);
  const strips = cloneStrips([
    { action: 'a', start: 'x', end: null, weight: 40, scale: 0, fadeIn: -5, blend: 'nonsense' },
    { start: 1 },
  ]);
  assert.equal(strips.length, 1);
  assert.equal(strips[0].blend, 'replace', 'an unknown blend mode was kept');
  assert.equal(strips[0].weight, 1, 'an out-of-range weight was not clamped');
  assert.equal(strips[0].scale, 1, 'a zero speed would divide the timeline by nothing');
  assert.equal(strips[0].fadeIn, 0);
  assert.ok(Number.isFinite(strips[0].start) && Number.isFinite(strips[0].end));
});

test('an action reports the frames it actually covers', () => {
  assert.deepEqual(actionRange(walk()), { start: 1, end: 11 });
  assert.deepEqual(actionRange(createAction('Empty')), { start: 0, end: 0 });
});
