import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_LABELS, PROPERTY_PATHS, channelDefault, completeTransform, defaultTimeline, keyFrames,
  offsetKeys, pathComponents, removeKey, sampleChannel, sampleChannels, samplePropertyChannels,
  setKey,
} from '../src/anim/animation';
import type { Channel } from '../src/anim/animation';
import { Scene } from '../src/scene/Scene';
import { createMaterial } from '../src/scene/Material';
import { buildPrimitive } from '../src/mesh/primitives';
import { exportGLTF } from '../src/io/gltf';
import { Vec3 } from '../src/core/math';
import { niceStep } from '../src/ui/GraphEditor';

test('keys land sorted no matter what order they arrive in', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 30, 3);
  setKey(channels, 'position', 0, 1, 1);
  setKey(channels, 'position', 0, 15, 2);
  assert.deepEqual(channels[0].keys.map((k) => k.frame), [1, 15, 30]);
  // Re-keying the same frame replaces rather than duplicates.
  setKey(channels, 'position', 0, 15, 9);
  assert.equal(channels[0].keys.length, 3);
  assert.equal(channels[0].keys[1].value, 9);
});

test('sampling holds the ends and interpolates between', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 10, 0, 'linear');
  setKey(channels, 'position', 0, 20, 10, 'linear');
  const ch = channels[0];
  assert.equal(sampleChannel(ch, 5), 0);
  assert.equal(sampleChannel(ch, 10), 0);
  assert.equal(sampleChannel(ch, 15), 5);
  assert.equal(sampleChannel(ch, 20), 10);
  assert.equal(sampleChannel(ch, 99), 10);
});

test('constant interpolation steps rather than ramps', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 1, 1, 0, 'constant');
  setKey(channels, 'position', 1, 10, 5, 'constant');
  assert.equal(sampleChannel(channels[0], 9), 0);
  assert.equal(sampleChannel(channels[0], 10), 5);
});

test('bezier eases and never overshoots a local extreme', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 2, 1, 0);
  setKey(channels, 'position', 2, 10, 1);
  setKey(channels, 'position', 2, 20, 0);
  const ch = channels[0];
  for (let f = 1; f <= 20; f += 0.5) {
    const v = sampleChannel(ch, f)!;
    assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `overshot to ${v} at frame ${f}`);
  }
  // The peak key is flat, so its neighbours sit just below it.
  assert.ok(sampleChannel(ch, 9)! < 1);
  assert.ok(sampleChannel(ch, 11)! < 1);
});

test('only keyed components are overwritten', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 1, 5);
  const sampled = sampleChannels(channels, 1);
  const current = { position: new Vec3(1, 2, 3), rotation: new Vec3(), scale: new Vec3(1, 1, 1) };
  const next = completeTransform(sampled, current, channels);
  assert.equal(next.position.x, 5);
  assert.equal(next.position.y, 2, 'unkeyed Y must survive');
  assert.equal(next.position.z, 3);
  assert.equal(next.scale.x, 1);
});

test('removing a key prunes the empty channel', () => {
  const channels: Channel[] = [];
  setKey(channels, 'scale', 0, 4, 2);
  assert.equal(channels.length, 1);
  assert.equal(removeKey(channels, 4), 1);
  assert.equal(channels.length, 0);
});

test('keyFrames lists each keyed frame once', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 5, 0);
  setKey(channels, 'position', 1, 5, 0);
  setKey(channels, 'rotation', 2, 12, 0);
  assert.deepEqual(keyFrames(channels), [5, 12]);
  offsetKeys(channels, 10);
  assert.deepEqual(keyFrames(channels), [15, 22]);
});

test('the scene drives animated objects and leaves the rest alone', () => {
  const scene = new Scene();
  const moving = scene.add('mesh', 'Moving', buildPrimitive('cube'));
  const still = scene.add('mesh', 'Still', buildPrimitive('cube'));
  still.position = new Vec3(9, 9, 9);
  setKey(moving.animation, 'position', 0, 1, 0, 'linear');
  setKey(moving.animation, 'position', 0, 11, 10, 'linear');

  assert.equal(scene.hasAnimation, true);
  scene.setFrame(6);
  assert.equal(moving.position.x, 5);
  assert.equal(still.position.x, 9);
  scene.setFrame(1);
  assert.equal(moving.position.x, 0);
});

test('animation survives a scene round trip', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  setKey(obj.animation, 'rotation', 2, 1, 0);
  setKey(obj.animation, 'rotation', 2, 24, Math.PI);
  scene.timeline = { ...defaultTimeline(), end: 24, fps: 30 };
  const copy = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const restored = [...copy.objects.values()][0];
  assert.equal(restored.animation.length, 1);
  assert.equal(restored.animation[0].keys.length, 2);
  assert.equal(copy.timeline.fps, 30);
  assert.equal(copy.timeline.playing, false, 'a saved scene should never load mid-playback');
});

test('glTF export carries the animation and UV channels', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  setKey(obj.animation, 'position', 0, 1, 0, 'linear');
  setKey(obj.animation, 'position', 0, 10, 4, 'linear');
  scene.timeline = { ...defaultTimeline(), start: 1, end: 10, fps: 24 };
  const gltf = JSON.parse(exportGLTF(scene).json);
  assert.equal(gltf.animations.length, 1);
  assert.equal(gltf.animations[0].channels[0].target.path, 'translation');
  assert.ok(gltf.animations[0].samplers.length >= 1);

  const noUV = JSON.parse(exportGLTF(scene).json);
  assert.equal(noUV.meshes[0].primitives[0].attributes.TEXCOORD_0, undefined);
});

// -------------------------------------------------- property channels

test('a light dims when its power is keyed', () => {
  const scene = new Scene();
  const light = scene.add('light', 'Key');
  light.light!.energy = 100;
  setKey(light.animation, 'light.energy', 0, 1, 100, 'linear');
  setKey(light.animation, 'light.energy', 0, 11, 0, 'linear');

  scene.setFrame(1);
  assert.equal(light.light!.energy, 100);
  scene.setFrame(11);
  assert.equal(light.light!.energy, 0);
  scene.setFrame(6);
  assert.ok(Math.abs(light.light!.energy - 50) < 1e-6, `halfway gave ${light.light!.energy}`);
});

test('keying one component of a colour leaves the others alone', () => {
  const scene = new Scene();
  const light = scene.add('light', 'Key');
  light.light!.color = [0.2, 0.4, 0.6];
  setKey(light.animation, 'light.color', 0, 1, 1, 'linear');
  scene.setFrame(1);
  assert.deepEqual(light.light!.color, [1, 0.4, 0.6]);
});

test('a lens pulls back when the field of view is keyed', () => {
  const scene = new Scene();
  const cam = scene.add('camera', 'Camera');
  setKey(cam.animation, 'camera.fov', 0, 1, 0.5, 'linear');
  setKey(cam.animation, 'camera.fov', 0, 21, 1.2, 'linear');
  scene.setFrame(21);
  assert.ok(Math.abs(cam.camera!.fov - 1.2) < 1e-6);
});

test('a material can be animated', () => {
  const scene = new Scene();
  scene.materials.push(createMaterial({ name: 'M', roughness: 0.1 }));
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  obj.materialSlots = [0];
  setKey(obj.animation, 'material.roughness', 0, 1, 0.1, 'linear');
  setKey(obj.animation, 'material.roughness', 0, 11, 0.9, 'linear');
  scene.setFrame(11);
  assert.ok(Math.abs(scene.materials[0].roughness - 0.9) < 1e-6);
});

test('property channels do not disturb the transform', () => {
  const scene = new Scene();
  const light = scene.add('light', 'Key');
  light.position = new Vec3(1, 2, 3);
  setKey(light.animation, 'light.energy', 0, 1, 10, 'linear');
  setKey(light.animation, 'light.energy', 0, 11, 20, 'linear');
  scene.setFrame(11);
  assert.deepEqual([light.position.x, light.position.y, light.position.z], [1, 2, 3]);
});

test('a transform channel still works alongside a property one', () => {
  const scene = new Scene();
  const light = scene.add('light', 'Key');
  setKey(light.animation, 'position', 2, 1, 0, 'linear');
  setKey(light.animation, 'position', 2, 11, 10, 'linear');
  setKey(light.animation, 'light.energy', 0, 1, 5, 'linear');
  setKey(light.animation, 'light.energy', 0, 11, 15, 'linear');
  scene.setFrame(6);
  assert.ok(Math.abs(light.position.z - 5) < 1e-6, `z was ${light.position.z}`);
  assert.ok(Math.abs(light.light!.energy - 10) < 1e-6, `energy was ${light.light!.energy}`);
});

test('sampling reports which properties are keyed and which are not', () => {
  const channels: Channel[] = [];
  setKey(channels, 'material.color', 0, 1, 0.5, 'linear');
  setKey(channels, 'material.color', 2, 1, 0.25, 'linear');
  const sampled = samplePropertyChannels(channels, 1);
  const rgb = sampled.get('material.color')!;
  assert.equal(rgb[0], 0.5);
  assert.ok(Number.isNaN(rgb[1]), 'an unkeyed component should read as absent, not as zero');
  assert.equal(rgb[2], 0.25);
});

test('every path knows how many components it has', () => {
  assert.equal(pathComponents('position'), 3);
  assert.equal(pathComponents('material.color'), 3);
  assert.equal(pathComponents('light.energy'), 1);
  assert.equal(pathComponents('camera.fov'), 1);
  for (const p of PROPERTY_PATHS) {
    assert.ok(CHANNEL_LABELS[p], `${p} has no label`);
    assert.equal(channelDefault(p).length, pathComponents(p), `${p} default is the wrong length`);
  }
});

test('property channels survive a save and load', () => {
  const scene = new Scene();
  const light = scene.add('light', 'Key');
  setKey(light.animation, 'light.energy', 0, 5, 42, 'constant');
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const l2 = [...back.objects.values()][0];
  assert.equal(l2.animation.length, 1);
  assert.equal(l2.animation[0].path, 'light.energy');
  assert.equal(l2.animation[0].keys[0].value, 42);
  back.setFrame(5);
  assert.equal(l2.light!.energy, 42);
});

test('an eased key actually eases', () => {
  // Two keys and bezier interpolation used to give a straight line, because
  // each end key took its slope from the only neighbour it had. An ease that
  // does not ease is a slower way of writing linear.
  const ch: Channel[] = [];
  setKey(ch, 'position', 2, 1, 0, 'bezier');
  setKey(ch, 'position', 2, 11, 10, 'bezier');
  const at = (f: number): number => sampleChannel(ch[0], f)!;
  assert.equal(at(1), 0);
  assert.equal(at(11), 10);
  assert.ok(Math.abs(at(6) - 5) < 1e-6, `the midpoint should still be halfway, got ${at(6)}`);
  // Slow at the start, fast in the middle: a quarter of the way through time
  // should be well under a quarter of the way through the value.
  assert.ok(at(3.5) < 2, `a quarter in gave ${at(3.5)}, which is not an ease`);
  assert.ok(at(8.5) > 8, `three quarters in gave ${at(8.5)}, which is not an ease`);
  // And it never overshoots its own keys.
  for (let f = 1; f <= 11; f += 0.25) {
    const v = at(f);
    assert.ok(v >= -1e-9 && v <= 10 + 1e-9, `overshot to ${v} at frame ${f}`);
  }
});

test('linear stays linear', () => {
  const ch: Channel[] = [];
  setKey(ch, 'position', 0, 1, 0, 'linear');
  setKey(ch, 'position', 0, 11, 10, 'linear');
  assert.ok(Math.abs(sampleChannel(ch[0], 3.5)! - 2.5) < 1e-6);
});

test('a held key does not move until the next one', () => {
  const ch: Channel[] = [];
  setKey(ch, 'position', 0, 1, 0, 'constant');
  setKey(ch, 'position', 0, 11, 10, 'constant');
  assert.equal(sampleChannel(ch[0], 10.9), 0);
  assert.equal(sampleChannel(ch[0], 11), 10);
});

test('graph axis steps land on 1, 2 or 5 times a power of ten', () => {
  for (const span of [0.004, 0.05, 0.3, 1, 3.4, 7, 25, 180, 4200]) {
    for (const target of [3, 5, 8]) {
      const step = niceStep(span, target);
      const mantissa = step / Math.pow(10, Math.round(Math.log10(step)));
      const normalised = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
      assert.ok(
        [1, 2, 5].some((m) => Math.abs(normalised - m) < 1e-9),
        `step ${step} for span ${span} is not a 1/2/5 step (normalised ${normalised}, ${mantissa})`,
      );
      // The whole point is a readable number of lines, not an exact count.
      const lines = span / step;
      assert.ok(lines >= 1 && lines <= target * 2.5, `span ${span} at target ${target} gives ${lines} lines`);
    }
  }
});

test('a degenerate range still gives a usable step rather than zero or NaN', () => {
  for (const span of [0, 1e-12, -0]) {
    const step = niceStep(span, 5);
    assert.ok(Number.isFinite(step) && step > 0, `span ${span} gave ${step}`);
  }
});
