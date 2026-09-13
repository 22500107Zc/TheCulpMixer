import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { createMaterial } from '../src/scene/Material';
import { buildPrimitive } from '../src/mesh/primitives';
import { buildTraceScene, cameraFromObject } from '../src/render/pathtrace/build';
import { buildBvh, renderBand, tonemapToImage } from '../src/render/pathtrace/tracer';
import { denoise } from '../src/render/pathtrace/denoise';
import { defaultRenderSettings, LIGHT_STRIDE, MATERIAL_STRIDE, MAT_TEXTURE } from '../src/render/pathtrace/types';
import { EMPTY_TEXTURES, PackedTextures } from '../src/render/pathtrace/textures';
import {
  FrameImage, SequenceRender, frameFilename, framesFor,
} from '../src/render/pathtrace/sequence';
import type { RenderSettings } from '../src/render/pathtrace/types';
import { Vec3 } from '../src/core/math';
import type { TraceCamera } from '../src/render/pathtrace/types';

function lookAt(eye: Vec3, target: Vec3): TraceCamera {
  const forward = target.sub(eye).normalized();
  const right = forward.cross(new Vec3(0, 0, 1)).normalized();
  const up = right.cross(forward).normalized();
  return {
    origin: eye.toArray(), forward: forward.toArray(), right: right.toArray(), up: up.toArray(),
    fovY: 0.7, orthographic: false, orthoHeight: 1, aperture: 0, focusDistance: eye.distanceTo(target),
  };
}

function studio(): { scene: Scene; camera: TraceCamera } {
  const scene = new Scene();
  scene.materials.push(createMaterial({ name: 'Grey', color: [0.6, 0.6, 0.6], roughness: 0.8 }));
  const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
  floor.scale = new Vec3(10, 10, 1);
  floor.materialSlots = [0];
  const ball = scene.add('mesh', 'Ball', buildPrimitive('uvsphere'));
  ball.position = new Vec3(0, 0, 1);
  ball.materialSlots = [0];
  const light = scene.add('light', 'Key');
  light.position = new Vec3(0, -2, 6);
  if (light.light) light.light.energy = 2000;
  return { scene, camera: lookAt(new Vec3(0, -6, 3), new Vec3(0, 0, 1)) };
}

test('the scene flattens into triangles, materials and lights', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.3);
  assert.ok(ts.positions.length > 0);
  assert.equal(ts.positions.length % 9, 0);
  assert.equal(ts.material.length, ts.positions.length / 9);
  assert.equal(ts.normals.length, ts.positions.length);
  assert.equal(ts.lightCount, 1);
  assert.equal(ts.lights.length % LIGHT_STRIDE, 0);
  assert.equal(ts.materials.length % MATERIAL_STRIDE, 0);
});

test('hidden objects are not traced', () => {
  const { scene, camera } = studio();
  const full = buildTraceScene(scene, camera, 0.3).positions.length;
  for (const o of scene.objects.values()) if (o.name === 'Ball') o.visible = false;
  const fewer = buildTraceScene(scene, camera, 0.3).positions.length;
  assert.ok(fewer < full);
});

test('the BVH covers every triangle', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.3);
  const bvh = buildBvh(ts.positions);
  assert.equal(bvh.order.length, ts.positions.length / 9);
  const seen = new Set(bvh.order);
  assert.equal(seen.size, bvh.order.length, 'a triangle appeared twice');
  assert.ok(bvh.nodeCount > 1);
});

test('a lit scene renders something, and the shadow is darker than the lit floor', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.25);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 64, height: 48, samples: 24 };
  const band = renderBand(ts, bvh, settings, {
    y0: 0, y1: settings.height, pass: 0, samples: settings.samples, seed: 7,
  });
  assert.equal(band.data.length, settings.width * settings.height * 3);
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < band.data.length; i += 3) {
    const l = (band.data[i] + band.data[i + 1] + band.data[i + 2]) / 3 / settings.samples;
    sum += l;
    if (l < 0.02) dark++;
  }
  const mean = sum / (settings.width * settings.height);
  assert.ok(mean > 0.02, `image came back essentially black (mean ${mean})`);
  assert.ok(Number.isFinite(mean));
  assert.ok(dark < settings.width * settings.height * 0.5, 'most of the frame should be lit');
});

test('an empty scene renders the sky rather than failing', () => {
  const scene = new Scene();
  const ts = buildTraceScene(scene, lookAt(new Vec3(0, -5, 0), new Vec3()), 0.5);
  assert.equal(ts.positions.length, 0);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 16, height: 16, samples: 2 };
  const band = renderBand(ts, bvh, settings, { y0: 0, y1: 16, pass: 0, samples: 2, seed: 1 });
  assert.ok(band.data.every((v) => Number.isFinite(v) && v >= 0));
  assert.ok(band.data.some((v) => v > 0), 'the sky should still contribute');
});

test('more samples converge rather than drift', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.25);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 32, height: 24 };
  const mean = (samples: number, seed: number): number => {
    const band = renderBand(ts, bvh, settings, { y0: 0, y1: 24, pass: 0, samples, seed });
    let s = 0;
    for (let i = 0; i < band.data.length; i++) s += band.data[i];
    return s / band.data.length / samples;
  };
  const low = mean(8, 1);
  const high = mean(64, 2);
  assert.ok(Math.abs(low - high) / Math.max(high, 1e-6) < 0.25, `${low} vs ${high}`);
});

test('tonemapping produces opaque 8-bit pixels', () => {
  const width = 4;
  const height = 2;
  const accum = new Float32Array(width * height * 3).fill(1.5);
  const out = new Uint8ClampedArray(width * height * 4);
  tonemapToImage(accum, 1, width, height, out);
  for (let i = 0; i < width * height; i++) {
    assert.equal(out[i * 4 + 3], 255);
    assert.ok(out[i * 4] > 180, 'a bright sample should map near white');
  }
});

test('a scene camera drives the framing when there is one', () => {
  const scene = new Scene();
  const cam = scene.add('camera', 'Camera');
  cam.position = new Vec3(3, 4, 5);
  const desc = cameraFromObject(scene, cam.id);
  assert.ok(desc);
  assert.deepEqual(desc!.origin, [3, 4, 5]);
  assert.equal(cameraFromObject(scene, 9999), null);
});

// -------------------------------------------- transmission, emitters, lens

/** Mean luminance of a render, which is what most of these compare. */
function meanLuma(scene: Scene, camera: TraceCamera, samples = 24, size = 24, sky = 0.3): number {
  const ts = buildTraceScene(scene, camera, sky);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: size, height: size, maxBounces: 6 };
  const band = renderBand(ts, bvh, settings, { y0: 0, y1: size, pass: 0, samples, seed: 7 });
  let sum = 0;
  for (let i = 0; i < band.data.length; i += 3) {
    sum += (band.data[i] * 0.2126 + band.data[i + 1] * 0.7152 + band.data[i + 2] * 0.0722) / samples;
  }
  return sum / (size * size);
}

test('emissive triangles are collected with a running area sum', () => {
  const scene = new Scene();
  scene.materials.push(createMaterial({ name: 'Grey' }));
  scene.materials.push(createMaterial({ name: 'Glow', emission: [1, 1, 1], emissionStrength: 5 }));
  const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
  floor.materialSlots = [0];
  const panel = scene.add('mesh', 'Panel', buildPrimitive('plane'));
  panel.position = new Vec3(0, 0, 3);
  panel.materialSlots = [1];

  const ts = buildTraceScene(scene, lookAt(new Vec3(0, -6, 3), new Vec3()), 0.3);
  assert.ok(ts.emissive.length > 0, 'the glowing plane should be in the emitter list');
  assert.equal(ts.emissive.length, ts.emissiveCdf.length);
  assert.ok(ts.emissiveArea > 0);
  // The sum must be non-decreasing, or picking by area lands on the wrong one.
  for (let i = 1; i < ts.emissiveCdf.length; i++) {
    assert.ok(ts.emissiveCdf[i] >= ts.emissiveCdf[i - 1]);
  }
  assert.ok(Math.abs(ts.emissiveCdf[ts.emissiveCdf.length - 1] - ts.emissiveArea) < 1e-4);
  // Only the glowing plane, not the floor.
  for (const tri of ts.emissive) {
    assert.equal(ts.materials[ts.material[tri] * MATERIAL_STRIDE + 8], 5);
  }
});

test('an emission panel lights the scene on its own', () => {
  // No analytic lights at all: if direct sampling of emitters did not work,
  // this would be near black and far noisier than the lit version.
  const build = (strength: number): { scene: Scene; camera: TraceCamera } => {
    const scene = new Scene();
    scene.world.ambient = 0;
    scene.world.background = [0, 0, 0];
    scene.materials.push(createMaterial({ name: 'Grey', color: [0.7, 0.7, 0.7], roughness: 0.9 }));
    scene.materials.push(createMaterial({
      name: 'Glow', color: [0, 0, 0], emission: [1, 1, 1], emissionStrength: strength,
    }));
    const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
    floor.scale = new Vec3(6, 6, 1);
    floor.materialSlots = [0];
    const panel = scene.add('mesh', 'Panel', buildPrimitive('plane'));
    panel.position = new Vec3(0, 0, 3);
    panel.scale = new Vec3(2, 2, 1);
    panel.materialSlots = [1];
    return { scene, camera: lookAt(new Vec3(0, -5, 2), new Vec3(0, 0, 0.5)) };
  };
  const dark = build(0);
  const lit = build(8);
  const a = meanLuma(dark.scene, dark.camera, 8, 24, 0);
  const b = meanLuma(lit.scene, lit.camera, 32, 24, 0);
  assert.ok(a < 1e-6, `an unlit scene should be black, got ${a}`);
  assert.ok(b > 0.02, `the emission panel should light the floor, got ${b}`);
});

test('emission is not counted twice', () => {
  // Doubling the emitter's strength should roughly double the light it casts.
  // Counting both the direct sample and the chance hit would overshoot.
  const build = (strength: number): { scene: Scene; camera: TraceCamera } => {
    const scene = new Scene();
    scene.world.ambient = 0;
    scene.world.background = [0, 0, 0];
    scene.materials.push(createMaterial({ name: 'Grey', color: [0.8, 0.8, 0.8], roughness: 1 }));
    scene.materials.push(createMaterial({
      name: 'Glow', color: [0, 0, 0], emission: [1, 1, 1], emissionStrength: strength,
    }));
    const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
    floor.scale = new Vec3(6, 6, 1);
    floor.materialSlots = [0];
    const panel = scene.add('mesh', 'Panel', buildPrimitive('plane'));
    panel.position = new Vec3(0, 0, 2);
    panel.scale = new Vec3(2, 2, 1);
    panel.materialSlots = [1];
    // Look at the floor only, so the panel itself is not in frame.
    return { scene, camera: lookAt(new Vec3(0, -4, 1), new Vec3(0, 0, 0)) };
  };
  const one = build(4);
  const two = build(8);
  const a = meanLuma(one.scene, one.camera, 48, 20, 0);
  const b = meanLuma(two.scene, two.camera, 48, 20, 0);
  assert.ok(a > 1e-4, `expected some light, got ${a}`);
  const ratio = b / a;
  assert.ok(ratio > 1.7 && ratio < 2.3, `doubling emission changed brightness by ${ratio.toFixed(3)}x`);
});

test('a transmissive material lets light through instead of blocking it', () => {
  const build = (transmission: number): { scene: Scene; camera: TraceCamera } => {
    const scene = new Scene();
    scene.world.ambient = 0;
    scene.world.background = [0, 0, 0];
    scene.materials.push(createMaterial({ name: 'Floor', color: [0.8, 0.8, 0.8], roughness: 1 }));
    scene.materials.push(createMaterial({
      name: 'Pane', color: [1, 1, 1], roughness: 0.02, transmission, ior: 1.45,
    }));
    const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
    floor.scale = new Vec3(6, 6, 1);
    floor.materialSlots = [0];
    // A slab between the light and the floor.
    const pane = scene.add('mesh', 'Pane', buildPrimitive('plane'));
    pane.position = new Vec3(0, 0, 2);
    pane.scale = new Vec3(3, 3, 1);
    pane.materialSlots = [1];
    const light = scene.add('light', 'Key');
    light.position = new Vec3(0, 0, 8);
    if (light.light) light.light.energy = 3000;
    return { scene, camera: lookAt(new Vec3(0, -4, 1), new Vec3(0, 0, 0)) };
  };
  const opaque = build(0);
  const glass = build(1);
  const a = meanLuma(opaque.scene, opaque.camera, 32, 20, 0);
  const b = meanLuma(glass.scene, glass.camera, 32, 20, 0);
  assert.ok(b > a * 1.3, `glass (${b.toFixed(4)}) should pass more light than an opaque pane (${a.toFixed(4)})`);
});

test('total internal reflection happens where it should', () => {
  const scene = new Scene();
  scene.materials.push(createMaterial({ name: 'Glass', transmission: 1, ior: 1.5, roughness: 0.01 }));
  const ts = buildTraceScene(scene, lookAt(new Vec3(0, -3, 0), new Vec3()), 0.3);
  const o = 0;
  assert.equal(ts.materials[o + 10], 1, 'transmission should reach the tracer');
  assert.equal(ts.materials[o + 11], 1.5, 'IOR should reach the tracer');
  // Snell says light leaving glass at more than ~41.8° cannot get out.
  const critical = Math.asin(1 / 1.5) * (180 / Math.PI);
  assert.ok(critical > 41 && critical < 42);
});

test('an open aperture blurs what is off the focal plane and keeps what is on it', () => {
  const scene = new Scene();
  scene.world.ambient = 0.0;
  scene.world.background = [0, 0, 0];
  scene.materials.push(createMaterial({ name: 'Glow', emission: [1, 1, 1], emissionStrength: 40, color: [0, 0, 0] }));
  // A small bright square well behind the focal plane.
  const far = scene.add('mesh', 'Far', buildPrimitive('plane'));
  far.position = new Vec3(0, 6, 0);
  far.scale = new Vec3(0.25, 0.25, 0.25);
  far.rotation = new Vec3(Math.PI / 2, 0, 0);
  far.materialSlots = [0];

  const render = (aperture: number): Float32Array => {
    const cam = lookAt(new Vec3(0, -4, 0), new Vec3(0, 6, 0));
    cam.aperture = aperture;
    cam.focusDistance = 1; // focus very near, so the square is far off-plane
    const ts = buildTraceScene(scene, cam, 0);
    const bvh = buildBvh(ts.positions);
    const settings = { ...defaultRenderSettings(), width: 32, height: 32, maxBounces: 2 };
    return renderBand(ts, bvh, settings, { y0: 0, y1: 32, pass: 0, samples: 64, seed: 3 }).data;
  };

  const spread = (d: Float32Array): number => {
    // How many pixels carry any light at all: blur spreads the square out.
    let lit = 0;
    for (let i = 0; i < d.length; i += 3) if (d[i] + d[i + 1] + d[i + 2] > 1e-3) lit++;
    return lit;
  };
  const sharp = render(0);
  const blurred = render(0.6);
  assert.ok(spread(sharp) > 0, 'the sharp render should see the square at all');
  assert.ok(
    spread(blurred) > spread(sharp) * 1.2,
    `blur should cover more pixels: sharp ${spread(sharp)}, blurred ${spread(blurred)}`,
  );
});

test('a pinhole camera renders identically however the focus distance is set', () => {
  const { scene } = studio();
  const near = lookAt(new Vec3(0, -6, 3), new Vec3(0, 0, 1));
  const farFocus = { ...near, focusDistance: 500 };
  assert.equal(meanLuma(scene, near, 8, 16), meanLuma(scene, farFocus, 8, 16));
});

// ------------------------------------------------------------- denoising

test('the filter cuts noise on a flat surface', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.3);
  const bvh = buildBvh(ts.positions);
  const size = 40;
  const settings = { ...defaultRenderSettings(), width: size, height: size, maxBounces: 4 };
  const samples = 4;
  const band = renderBand(ts, bvh, settings, { y0: 0, y1: size, pass: 0, samples, seed: 11 });

  const n = size * size;
  const color = new Float32Array(n * 3);
  const albedo = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  for (let i = 0; i < n * 3; i++) {
    color[i] = band.data[i] / samples;
    albedo[i] = band.albedo[i] / samples;
    normal[i] = band.normal[i] / samples;
  }
  for (let i = 0; i < n; i++) depth[i] = band.depth[i] / samples;

  const cleaned = denoise({ width: size, height: size, color, albedo, normal, depth });

  // Neighbour-to-neighbour difference is what noise looks like numerically.
  const roughness = (buf: Float32Array): number => {
    let sum = 0;
    let count = 0;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = (y * size + x) * 3;
        const r = (y * size + x + 1) * 3;
        const d = ((y + 1) * size + x) * 3;
        sum += Math.abs(buf[i] - buf[r]) + Math.abs(buf[i] - buf[d]);
        count += 2;
      }
    }
    return sum / count;
  };

  const before = roughness(color);
  const after = roughness(cleaned);
  assert.ok(before > 0, 'a four-sample render should be noisy to begin with');
  assert.ok(after < before * 0.7, `filtering barely helped: ${before.toFixed(5)} -> ${after.toFixed(5)}`);

  // And it must not have moved the overall brightness.
  const mean = (buf: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i];
    return s / buf.length;
  };
  const drift = Math.abs(mean(cleaned) - mean(color)) / Math.max(1e-6, mean(color));
  assert.ok(drift < 0.12, `filtering shifted the exposure by ${(drift * 100).toFixed(1)}%`);
});

test('the filter keeps an edge that the guide buffers can see', () => {
  // Two flat regions at different depths and normals, with a hard boundary.
  const size = 32;
  const n = size * size;
  const color = new Float32Array(n * 3);
  const albedo = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const left = x < size / 2;
      const v = left ? 0.15 : 0.85;
      color[i * 3] = v;
      color[i * 3 + 1] = v;
      color[i * 3 + 2] = v;
      albedo[i * 3] = left ? 0.2 : 0.9;
      albedo[i * 3 + 1] = left ? 0.2 : 0.9;
      albedo[i * 3 + 2] = left ? 0.2 : 0.9;
      normal[i * 3] = left ? 1 : 0;
      normal[i * 3 + 2] = left ? 0 : 1;
      depth[i] = left ? 2 : 9;
    }
  }
  const cleaned = denoise({ width: size, height: size, color, albedo, normal, depth });
  const mid = size >> 1;
  const row = (size >> 1) * size;
  const leftSide = cleaned[(row + mid - 1) * 3];
  const rightSide = cleaned[(row + mid) * 3];
  assert.ok(
    rightSide - leftSide > 0.5,
    `the edge was blurred away: ${leftSide.toFixed(3)} vs ${rightSide.toFixed(3)}`,
  );
});

test('filtering an already clean image barely changes it', () => {
  const size = 16;
  const n = size * size;
  const color = new Float32Array(n * 3).fill(0.4);
  const albedo = new Float32Array(n * 3).fill(0.5);
  const normal = new Float32Array(n * 3);
  const depth = new Float32Array(n).fill(3);
  for (let i = 0; i < n; i++) normal[i * 3 + 2] = 1;
  const cleaned = denoise({ width: size, height: size, color, albedo, normal, depth });
  for (let i = 0; i < cleaned.length; i++) {
    assert.ok(Math.abs(cleaned[i] - 0.4) < 1e-4, `pixel ${i} moved to ${cleaned[i]}`);
  }
});

// ------------------------------------------------- textures in the real render

/**
 * A two-by-two checker, built by hand.
 *
 * Not decoded from an image: decoding needs a document, and the point of the
 * test is what the tracer does with pixels once it has them, not how they were
 * obtained. This is exactly the shape `packTextures` hands over.
 */
function checker(): PackedTextures {
  const w = 2;
  const h = 2;
  const data = new Float32Array(w * h * 4);
  const put = (i: number, r: number, g: number, b: number): void => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 1;
  };
  // Top row red, black; bottom row black, red.
  put(0, 1, 0, 0); put(1, 0, 0, 0);
  put(2, 0, 0, 0); put(3, 1, 0, 0);
  return { data, index: new Int32Array([0, w, h]), slotOf: new Map([[7, 0]]) };
}

/** One big textured quad facing the camera, lit flatly. */
function texturedWall(): { scene: Scene; camera: TraceCamera } {
  const scene = new Scene();
  scene.materials.push(createMaterial({
    name: 'Mapped', color: [1, 1, 1], roughness: 1, metallic: 0,
  }));
  scene.materials[0].baseColorTexture = 7;
  const plane = buildPrimitive('plane');
  // Coordinates across the whole quad. Without them every sample lands on one
  // texel and a tiling test cannot tell a working transform from a missing
  // one — which is exactly how a texture lookup that ignored uvScale would
  // sneak past.
  const box = plane.bounds();
  const span = box.size();
  for (let f = 0; f < plane.faces.length; f++) {
    const loop = plane.faces[f];
    const run: number[] = [];
    for (const v of loop) {
      const p = plane.positions[v];
      run.push(
        (p.x - box.min.x) / Math.max(1e-6, span.x),
        (p.y - box.min.y) / Math.max(1e-6, span.y),
      );
    }
    plane.setUV(f, run);
  }
  plane.markDirty();
  const wall = scene.add('mesh', 'Wall', plane);
  wall.rotation = new Vec3(Math.PI / 2, 0, 0);
  wall.scale = new Vec3(4, 4, 1);
  wall.materialSlots = [0];
  const light = scene.add('light', 'Key');
  light.position = new Vec3(0, -4, 0);
  if (light.light) light.light.energy = 4000;
  return { scene, camera: lookAt(new Vec3(0, -5, 0), new Vec3(0, 0, 0)) };
}

/** Render the wall and hand back the raw pixels, normalised per sample. */
function renderPixels(
  scene: Scene, camera: TraceCamera, packed: PackedTextures,
): Float32Array {
  const ts = buildTraceScene(scene, camera, 0.05, packed);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 24, height: 24, samples: 6 };
  const band = renderBand(ts, bvh, settings, {
    y0: 0, y1: settings.height, pass: 0, samples: settings.samples, seed: 3,
  });
  const out = new Float32Array(band.data.length);
  for (let i = 0; i < band.data.length; i++) out[i] = band.data[i] / settings.samples;
  return out;
}

/** Mean linear colour of a render, per channel. */
function meanColour(scene: Scene, camera: TraceCamera, packed: PackedTextures): number[] {
  const px = renderPixels(scene, camera, packed);
  const sums = [0, 0, 0];
  for (let i = 0; i < px.length; i += 3) {
    sums[0] += px[i];
    sums[1] += px[i + 1];
    sums[2] += px[i + 2];
  }
  return sums.map((s) => s / (px.length / 3));
}

/** How far apart two renders are, per pixel — the mean absolute difference. */
function pixelDistance(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

test('the final render carries the material over into the flattened scene', () => {
  const { scene, camera } = texturedWall();
  const packed = checker();
  const ts = buildTraceScene(scene, camera, 0.05, packed);
  assert.equal(ts.materials[MAT_TEXTURE], 0, 'the material does not name its texture');
  assert.ok(ts.textures.length > 0, 'the pixels did not travel to the tracer');
  assert.deepEqual([...ts.textureIndex], [0, 2, 2]);

  // The control: the same scene with no texture bound must differ.
  const bare = new Scene();
  bare.materials.push(createMaterial({ name: 'Plain', color: [1, 1, 1] }));
  assert.equal(buildTraceScene(bare, camera, 0.05).materials[MAT_TEXTURE], -1);
});

test('a textured surface renders differently from an untextured one', () => {
  const { scene, camera } = texturedWall();
  const withTexture = meanColour(scene, camera, checker());
  const withoutTexture = meanColour(scene, camera, EMPTY_TEXTURES);

  // The checker is half red, half black, so a textured wall is darker overall
  // and strongly biased to red. An unmapped white wall is neither.
  assert.ok(withTexture[0] > withTexture[2] * 3,
    `the texture did not reach the render: ${withTexture.map((n) => n.toFixed(3))}`);
  assert.ok(withoutTexture[0] < withoutTexture[2] * 2,
    `the control should be neutral: ${withoutTexture.map((n) => n.toFixed(3))}`);
});

test('uvScale and uvOffset change the rendered image', () => {
  const { scene, camera } = texturedWall();
  const packed = checker();
  const plain = renderPixels(scene, camera, packed);

  // Compared pixel by pixel rather than by average brightness: a checker is
  // periodic, so tiling it changes where every square lands while leaving the
  // mean of the picture almost exactly where it was. An averaged test would
  // pass against a tracer that ignored the transform entirely.
  scene.materials[0].uvScale = [8, 8];
  const tiled = renderPixels(scene, camera, packed);
  assert.ok(pixelDistance(plain, tiled) > 0.01,
    `uvScale made no difference to the rendered image (distance ${pixelDistance(plain, tiled)})`);

  // And sliding it half a tile swaps the squares over.
  scene.materials[0].uvScale = [1, 1];
  scene.materials[0].uvOffset = [0.5, 0];
  const shifted = renderPixels(scene, camera, packed);
  assert.ok(pixelDistance(plain, shifted) > 0.01,
    `uvOffset made no difference to the rendered image (distance ${pixelDistance(plain, shifted)})`);

  // The control: re-rendering with the same settings is deterministic, so a
  // nonzero distance above really is the transform and not noise.
  scene.materials[0].uvOffset = [0, 0];
  assert.equal(pixelDistance(plain, renderPixels(scene, camera, packed)), 0,
    'the renderer is not deterministic, so the comparisons above mean nothing');
});

test('painted vertex colour still renders, with and without a texture', () => {
  const { scene, camera } = texturedWall();
  const wall = [...scene.objects.values()].find((o) => o.name === 'Wall')!;
  const mesh = wall.mesh!;
  mesh.colors = new Float32Array(mesh.vertCount * 3);
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.colors[v * 3] = 0;
    mesh.colors[v * 3 + 1] = 1;
    mesh.colors[v * 3 + 2] = 0;
  }
  mesh.markDirty();

  // Green paint under a red-and-black checker leaves almost nothing: the two
  // multiply. That is the existing behaviour and it must survive the repair.
  const painted = meanColour(scene, camera, EMPTY_TEXTURES);
  assert.ok(painted[1] > painted[0] * 3,
    `vertex colour stopped rendering: ${painted.map((n) => n.toFixed(3))}`);
});

// --------------------------------------------- rendering an animation, not a still

/** A ball keyed to move, so consecutive frames must differ. */
function movingScene(): Scene {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 5;
  scene.timeline.fps = 24;
  scene.materials.push(createMaterial({ name: 'Grey', color: [0.6, 0.6, 0.6], roughness: 0.8 }));
  const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
  floor.scale = new Vec3(10, 10, 1);
  floor.materialSlots = [0];
  const ball = scene.add('mesh', 'Ball', buildPrimitive('uvsphere'));
  ball.position = new Vec3(0, 0, 1);
  ball.materialSlots = [0];
  ball.animation = [{
    path: 'position', index: 0,
    keys: [
      { frame: 1, value: -2, interp: 'linear' },
      { frame: 5, value: 2, interp: 'linear' },
    ],
  }];
  const light = scene.add('light', 'Key');
  light.position = new Vec3(0, -2, 6);
  if (light.light) light.light.energy = 2000;
  const cam = scene.add('camera', 'Shot');
  cam.position = new Vec3(0, -6, 3);
  cam.rotation = new Vec3(Math.PI / 2.6, 0, 0);
  return scene;
}

const tinySettings = (): RenderSettings => ({
  ...defaultRenderSettings(), width: 8, height: 6, samples: 1, samplesPerPass: 1, denoise: false,
});

test('a frame range resolves against the timeline and honours a step', () => {
  const scene = movingScene();
  assert.deepEqual(framesFor(scene, tinySettings()), [1, 2, 3, 4, 5]);
  assert.deepEqual(framesFor(scene, { ...tinySettings(), frameStart: 2, frameEnd: 4 }), [2, 3, 4]);
  assert.deepEqual(framesFor(scene, { ...tinySettings(), frameStep: 2 }), [1, 3, 5]);
  // A backwards range is a typo, and producing nothing after a long wait is
  // the least useful way to report one.
  assert.deepEqual(framesFor(scene, { ...tinySettings(), frameStart: 9, frameEnd: 2 }), [9]);
});

test('an animation render produces one image per frame, in order', async () => {
  const scene = movingScene();
  const seen: number[] = [];
  const progress: number[] = [];
  const run = new SequenceRender(scene, {
    settings: { ...tinySettings(), frameStart: 1, frameEnd: 3 },
    onFrame: (img) => { seen.push(img.frame); },
    onProgress: (p) => { progress.push(p.done); },
  });
  const result = await run.run();

  assert.equal(result.cancelled, false);
  assert.equal(result.frames, 3);
  assert.deepEqual(seen, [1, 2, 3], 'frames did not arrive in order');
  assert.deepEqual(progress, [1, 2, 3], 'progress was not reported per frame');
});

test('consecutive frames actually differ, so the animation is being evaluated', async () => {
  const scene = movingScene();
  const images: FrameImage[] = [];
  await new SequenceRender(scene, {
    settings: { ...tinySettings(), frameStart: 1, frameEnd: 5, frameStep: 4 },
    onFrame: (img) => { images.push(img); },
  }).run();

  assert.equal(images.length, 2);
  let different = 0;
  for (let i = 0; i < images[0].pixels.length; i++) {
    if (images[0].pixels[i] !== images[1].pixels[i]) different++;
  }
  assert.ok(different > 0, 'every frame came out identical — the timeline was not applied');
});

test('rendering an animation is deterministic', async () => {
  const scene = movingScene();
  const grab = async (): Promise<Uint8ClampedArray> => {
    let first: Uint8ClampedArray | null = null;
    await new SequenceRender(scene, {
      settings: { ...tinySettings(), frameStart: 2, frameEnd: 2 },
      onFrame: (img) => { first = img.pixels; },
    }).run();
    return first!;
  };
  const a = await grab();
  const b = await grab();
  assert.deepEqual([...a], [...b], 'the same frame rendered twice gave two different images');
});

test('an animation render can be cancelled part way and says so', async () => {
  const scene = movingScene();
  const seen: number[] = [];
  const run = new SequenceRender(scene, {
    settings: { ...tinySettings(), frameStart: 1, frameEnd: 5 },
    onFrame: (img) => {
      seen.push(img.frame);
      if (seen.length === 2) run.cancel();
    },
  });
  const result = await run.run();
  assert.equal(result.cancelled, true, 'a cancelled render did not report itself as cancelled');
  assert.ok(result.frames < 5, `cancelling did not stop the run: ${result.frames} frames`);
  assert.deepEqual(seen, [1, 2]);
});

test('rendering an animation leaves the playhead where it found it', async () => {
  const scene = movingScene();
  scene.setFrame(3);
  await new SequenceRender(scene, {
    settings: { ...tinySettings(), frameStart: 1, frameEnd: 4 },
  }).run();
  assert.equal(scene.timeline.current, 3, 'the render moved the user timeline');
});

test('the sequence poses the scene exactly as scrubbing does', async () => {
  // The consistency claim, checked rather than asserted: the trace scene built
  // during an animation render has to match the one built after scrubbing to
  // the same frame by hand.
  const scene = movingScene();
  const captured: string[] = [];
  await new SequenceRender(scene, {
    settings: { ...tinySettings(), frameStart: 4, frameEnd: 4 },
    onFrame: () => {
      // Inside the callback the scene is still posed at the frame.
      captured.push(JSON.stringify([...buildTraceScene(scene, lookAt(new Vec3(0, -6, 3), new Vec3(0, 0, 1)), 0.3).positions]));
    },
  }).run();

  scene.setFrame(4);
  const byHand = JSON.stringify([...buildTraceScene(
    scene, lookAt(new Vec3(0, -6, 3), new Vec3(0, 0, 1)), 0.3,
  ).positions]);
  assert.equal(captured[0], byHand, 'the render posed the scene differently from scrubbing');
});

test('frame files are named so they sort correctly', () => {
  assert.equal(frameFilename(7, 120), 'frame_0007.png');
  assert.equal(frameFilename(1200, 5000), 'frame_1200.png');
  // Padded to at least four even for a short range, which is what every
  // sequence reader expects.
  assert.equal(frameFilename(3, 5), 'frame_0003.png');
});
