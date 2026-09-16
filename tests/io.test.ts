import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { buildPrimitive, createCube, createUVSphere } from '../src/mesh/primitives';
import { createBone } from '../src/anim/armature';
import { createMaterial } from '../src/scene/Material';
import { createTexture } from '../src/scene/Texture';
import { meshFromPhoto } from '../src/imaging/photo';
import { createModifier } from '../src/modifiers';
import { MTL_FILENAME, exportMTL, exportOBJ, importOBJ, texturesForMTL } from '../src/io/obj';
import { exportSTL } from '../src/io/stl';
import { exportGLTF } from '../src/io/gltf';

function sceneWithCube(): Scene {
  const s = new Scene();
  s.materials.push(createMaterial({ name: 'Clay', color: [0.8, 0.4, 0.2] }));
  const obj = s.add('mesh', 'Cube', createCube());
  obj.position = new Vec3(0, 0, 1);
  return s;
}

test('OBJ export writes transformed, Y-up geometry', () => {
  const text = exportOBJ(sceneWithCube());
  const verts = text.split('\n').filter((l) => l.startsWith('v '));
  assert.equal(verts.length, 8);
  assert.equal(text.split('\n').filter((l) => l.startsWith('f ')).length, 6);
  assert.match(text, /^o Cube$/m);
  assert.match(text, /^usemtl Clay$/m);
  // The Culp Mixer's +Z (up) becomes OBJ's +Y, so every vertex sits at y = 0 or y = 2.
  for (const line of verts) {
    const y = parseFloat(line.split(/\s+/)[2]);
    assert.ok(Math.abs(y) < 1e-6 || Math.abs(y - 2) < 1e-6, `unexpected y ${y}`);
  }
});

test('OBJ round-trips through import with axes restored', () => {
  const back = importOBJ(exportOBJ(sceneWithCube()));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Cube');
  assert.equal(back[0].mesh.vertCount, 8);
  assert.equal(back[0].mesh.faceCount, 6);
  const b = back[0].mesh.bounds();
  assert.ok(Math.abs(b.min.z) < 1e-5 && Math.abs(b.max.z - 2) < 1e-5, 'Z-up restored');
});

test('OBJ import handles negative indices, quads and missing groups', () => {
  const objects = importOBJ([
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'f -4 -3 -2 -1',
  ].join('\n'));
  assert.equal(objects.length, 1);
  assert.deepEqual(objects[0].mesh.faces, [[0, 1, 2, 3]]);
});

test('binary STL has a correct header and triangle count', () => {
  const buffer = exportSTL(sceneWithCube());
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(count, 12, 'a cube is twelve triangles');
  assert.equal(buffer.byteLength, 84 + 12 * 50);
});

test('glTF export produces a valid-looking document', () => {
  const s = sceneWithCube();
  s.add('light', 'Light').position = new Vec3(3, 3, 3);
  const obj = s.activeObject ?? [...s.objects.values()][0];
  obj.modifiers.push(createModifier('subsurf'));
  const gltf = JSON.parse(exportGLTF(s).json);

  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.meshes.length, 1);
  assert.equal(gltf.materials.length, 1);
  assert.deepEqual(gltf.extensionsUsed, ['KHR_lights_punctual']);
  assert.equal(gltf.extensions.KHR_lights_punctual.lights.length, 1);

  // The root node converts Z-up to Y-up and owns every other node.
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  assert.equal(root.name, 'CulpMixerScene',
    'the exported file carries the old name into the customer\'s 3D application');
  assert.ok(Math.abs(root.rotation[0] + Math.SQRT1_2) < 1e-6);
  assert.equal(root.children.length, 2);

  // Buffer views must be 4-byte aligned and inside the buffer.
  const byteLength = gltf.buffers[0].byteLength;
  for (const view of gltf.bufferViews) {
    assert.equal(view.byteOffset % 4, 0, 'aligned');
    assert.ok(view.byteOffset + view.byteLength <= byteLength, 'inside the buffer');
  }
  const positions = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  assert.equal(positions.type, 'VEC3');
  assert.equal(positions.min.length, 3);
  assert.ok(gltf.buffers[0].uri.startsWith('data:application/octet-stream;base64,'));
});

test('glTF export honours the selection filter', () => {
  const s = sceneWithCube();
  s.add('mesh', 'Sphere', createUVSphere(1, 8, 6));
  s.selection = new Set([[...s.objects.values()][0].id]);
  const gltf = JSON.parse(exportGLTF(s, true).json);
  assert.equal(gltf.meshes.length, 1);
});

/**
 * OBJ arrives from everywhere — other applications, half-finished exports,
 * downloads that stopped early — so the importer is the one place in The Culp Mixer
 * where the input was written by a stranger. It gets to return an empty list
 * or a smaller model, but never a mesh the rest of the app cannot draw.
 */
test('a corrupt OBJ never produces geometry the app cannot draw', () => {
  const cases: Record<string, string> = {
    empty: '',
    justComments: '# nothing here\n# at all\n',
    faceBeforeVertex: 'f 1 2 3\nv 0 0 0\n',
    outOfRange: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n',
    nonNumericVertex: 'v a b c\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    missingComponents: 'v 1 2\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    overflowingCoordinate: 'v 1e999 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
    twoVertexFace: 'v 0 0 0\nv 1 0 0\nf 1 2\n',
    repeatedCorner: 'v 0 0 0\nf 1 1 1\n',
    // OBJ indices are 1-based, so a zero does not name a vertex.
    zeroIndex: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n',
    negativeBeyondStart: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -99 -2 -1\n',
    notAnOBJAtAll: '    binary noise',
  };
  for (const [name, text] of Object.entries(cases)) {
    const objects = importOBJ(text);
    for (const { mesh } of objects) {
      for (const p of mesh.positions) {
        assert.ok(Number.isFinite(p.x + p.y + p.z), `${name}: coordinates must be finite`);
      }
      assert.ok(mesh.faces.length > 0, `${name}: an empty group should not be imported at all`);
      for (const f of mesh.faces) {
        assert.ok(f.length >= 3, `${name}: a face needs three corners`);
        for (const v of f) {
          assert.ok(
            Number.isInteger(v) && v >= 0 && v < mesh.positions.length,
            `${name}: corner ${v} does not name one of the ${mesh.positions.length} vertices`,
          );
        }
      }
    }
  }
});

test('a readable OBJ still imports everything it should', () => {
  // The hardening above must not cost the cases that were always fine.
  const negative = importOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  assert.equal(negative.length, 1, 'negative indices count back from here');
  assert.equal(negative[0].mesh.faces.length, 1);

  const crlf = importOBJ('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n');
  assert.equal(crlf[0].mesh.faces.length, 1, 'Windows line endings');

  const slashes = importOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n');
  assert.equal(slashes[0].mesh.faces.length, 1, 'vertex/uv/normal corner references');

  // A bad coordinate costs that coordinate, not the vertex it belongs to:
  // dropping the `v` line would shift every index after it and quietly
  // reassemble the model out of the wrong corners.
  const partial = importOBJ('v 5 nope 7\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  assert.equal(partial[0].mesh.positions.length, 3, 'the vertex still exists');
  assert.equal(partial[0].mesh.faces[0].length, 3, 'and the face still finds it');
});


// ------------------------------------------------- taking a texture with you

/** A photograph, its model, and the texture, wired up the way the panel does. */
function texturedPhotoScene(): { scene: Scene; textureId: number } {
  const w = 72;
  const h = 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = ((x - 36) / 20) ** 2 + ((y - 48) / 32) ** 2 < 1;
      data[o] = inside ? 60 : 175;
      data[o + 1] = inside ? 95 : 80;
      data[o + 2] = inside ? 205 : 45;
      data[o + 3] = 255;
    }
  }
  const { mesh } = meshFromPhoto({ width: w, height: h, data }, { resolution: 56 });
  const scene = new Scene();
  const texture = createTexture('holiday photo', 'data:image/png;base64,iVBORw0KGgo=', w, h);
  scene.textures.push(texture);
  const slot = scene.addMaterial(createMaterial({ name: 'photo surface', baseColorTexture: texture.id }));
  const obj = scene.add('mesh', 'Photo', mesh);
  obj.materialSlots = [slot];
  return { scene, textureId: texture.id };
}

test('an exported OBJ points at its material file and its texture', () => {
  // The .obj never named the .mtl, so every importer ignored the material file
  // the app had just written beside it — and the .mtl never named the image,
  // so a model built from a photograph arrived somewhere else as a grey shape
  // with nothing in the files to say what had been lost.
  const { scene } = texturedPhotoScene();
  const obj = exportOBJ(scene);
  const mtl = exportMTL(scene);

  assert.ok(obj.split('\n').includes(`mtllib ${MTL_FILENAME}`), 'the .obj does not name the .mtl');
  assert.ok(obj.includes('usemtl photo_surface'), 'no material is selected for the faces');
  assert.ok(mtl.includes('newmtl photo_surface'));

  const images = texturesForMTL(scene);
  assert.equal(images.length, 1, 'the texture was not offered for saving beside the .obj');
  assert.ok(mtl.includes(`map_Kd ${images[0].filename}`), `the .mtl does not point at ${images[0].filename}`);
  assert.ok(images[0].url.startsWith('data:image'), 'no bytes to write for the image');

  // A texture nothing uses is not written out.
  const spare = createTexture('unused', 'data:image/png;base64,iVBORw0KGgo=', 4, 4);
  scene.textures.push(spare);
  assert.equal(texturesForMTL(scene).length, 1, 'an unreferenced texture was written out anyway');
});

test('OBJ survives a round trip through The Culp Mixer with its coordinates', () => {
  // The Culp Mixer read back its own export and dropped the texture coordinates every
  // time: the file had them written in it and the importer walked past them.
  const { scene } = texturedPhotoScene();
  const original = [...scene.objects.values()][0].mesh!;
  const back = importOBJ(exportOBJ(scene));

  assert.equal(back.length, 1);
  const mesh = back[0].mesh;
  assert.equal(mesh.faceCount, original.faceCount, 'faces were lost on the way back in');
  assert.equal(mesh.hasUV, true, 'the coordinates did not survive the round trip');

  let worst = 0;
  for (let f = 0; f < original.faces.length; f++) {
    const a = original.uvFor(f);
    const b = mesh.uvFor(f);
    assert.ok(a && b && a.length === b.length, `face ${f} lost its coordinates`);
    for (let i = 0; i < a!.length; i++) worst = Math.max(worst, Math.abs(a![i] - b![i]));
  }
  // The export rounds to six decimals; anything beyond that is a real drift.
  assert.ok(worst < 1e-5, `coordinates drifted by ${worst}`);
});

test('a face with no coordinates stays a face with no coordinates', () => {
  // `v//vn` is legal OBJ and means this corner has no texture coordinate.
  // Inventing one puts a corner of the image somewhere it was never meant to
  // be, which is worse than having none.
  const text = [
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'vt 0 0', 'vt 1 0', 'vt 1 1',
    'o Mixed',
    'f 1//1 2//2 3//3',
    'f 1/1/1 2/2/2 3/3/3',
    // A coordinate index past the end of the table is a corrupt file, not a
    // coordinate.
    'f 1/1/1 2/2/2 4/99/3',
  ].join('\n');
  const [imported] = importOBJ(text);
  assert.equal(imported.mesh.faceCount, 3);
  assert.equal(imported.mesh.uvFor(0), null, 'a face with no coordinates was given some');
  assert.deepEqual(imported.mesh.uvFor(1), [0, 0, 1, 0, 1, 1]);
  assert.equal(imported.mesh.uvFor(2), null, 'an out-of-range coordinate index was used anyway');
});

test('glTF carries the picture, not just the coordinates', () => {
  // TEXCOORD_0 and a material and no image at all: the model arrived in
  // Blender or a game engine grey, and glTF is the format people actually
  // move models with.
  const { scene, textureId } = texturedPhotoScene();
  const doc = JSON.parse(exportGLTF(scene).json);

  assert.equal(doc.images?.length, 1, 'no image in the glTF');
  assert.ok(String(doc.images[0].uri).startsWith('data:image'), 'the image is a reference to a file that will not be there');
  assert.equal(doc.textures?.length, 1);
  assert.equal(doc.samplers?.length, 1);
  assert.equal(doc.textures[0].source, 0);

  const pbr = doc.materials[0].pbrMetallicRoughness;
  assert.equal(pbr.baseColorTexture?.index, 0, 'the material does not use the texture');
  assert.ok(doc.meshes[0].primitives[0].attributes.TEXCOORD_0 !== undefined);

  // Tiling is not part of a plain glTF texture reference, so it has to be
  // declared rather than exported silently as something else.
  assert.equal(doc.extensionsUsed?.includes('KHR_texture_transform') ?? false, false);
  scene.materials[0].uvScale = [3, 3];
  const tiled = JSON.parse(exportGLTF(scene).json);
  assert.ok(tiled.extensionsUsed.includes('KHR_texture_transform'), 'tiling was exported silently');
  assert.deepEqual(tiled.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform.scale, [3, 3]);

  // A scene with no textures should not grow empty arrays for them.
  const plain = JSON.parse(exportGLTF(sceneWithCube()).json);
  assert.equal(plain.images, undefined);
  assert.equal(plain.textures, undefined);
  assert.equal(plain.samplers, undefined);
  assert.ok(textureId > 0);
});

// --------------------------------------------------- glTF fidelity, verified

/** A scene with everything the audit asked to see travel: colour, rig, cameras. */
function richScene(): Scene {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 6;

  const mesh = buildPrimitive('cube');
  mesh.colors = new Float32Array(mesh.vertCount * 3);
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.colors[v * 3] = 1;
    mesh.colors[v * 3 + 1] = 0.25;
    mesh.colors[v * 3 + 2] = 0;
  }
  mesh.markDirty();
  const body = scene.add('mesh', 'Body', mesh);

  const wide = scene.add('camera', 'Wide');
  wide.camera = { fov: 90, near: 0.05, far: 500, orthographic: false, orthoScale: 5 };
  const long = scene.add('camera', 'Long');
  long.camera = { fov: 20, near: 1, far: 2000, orthographic: false, orthoScale: 5 };
  return scene;
}

test('glTF carries painted vertex colours', () => {
  const doc = JSON.parse(exportGLTF(richScene()).json);
  const prim = doc.meshes[0].primitives[0];
  assert.ok(prim.attributes.COLOR_0 !== undefined, 'painted colour was dropped from the export');
  const acc = doc.accessors[prim.attributes.COLOR_0];
  assert.equal(acc.type, 'VEC4');
  assert.equal(acc.componentType, 5126);
  assert.ok(acc.count > 0);
});

test('each camera exports its own settings rather than a shared default', () => {
  const doc = JSON.parse(exportGLTF(richScene()).json);
  assert.equal(doc.cameras.length, 2, 'two cameras should produce two camera definitions');

  const nodes = doc.nodes.filter((n: { camera?: number }) => n.camera !== undefined);
  assert.equal(nodes.length, 2);
  // The bug: every camera node pointed at cameras[0].
  assert.notEqual(nodes[0].camera, nodes[1].camera, 'both cameras shared one definition');

  const yfovs = doc.cameras.map((c: { perspective: { yfov: number } }) => c.perspective.yfov);
  assert.ok(Math.abs(yfovs[0] - yfovs[1]) > 0.3, `both cameras got the same lens: ${yfovs}`);
  const nears = doc.cameras.map((c: { perspective: { znear: number } }) => c.perspective.znear);
  assert.deepEqual(nears, [0.05, 1], 'the near planes were not carried');
  const fars = doc.cameras.map((c: { perspective: { zfar: number } }) => c.perspective.zfar);
  assert.deepEqual(fars, [500, 2000], 'the far planes were not carried');
});

test('an orthographic camera is exported as one', () => {
  const scene = new Scene();
  const cam = scene.add('camera', 'Top');
  cam.camera = { fov: 50, near: 0.1, far: 100, orthographic: true, orthoScale: 8 };
  const doc = JSON.parse(exportGLTF(scene).json);
  assert.equal(doc.cameras[0].type, 'orthographic');
  assert.equal(doc.cameras[0].orthographic.xmag, 4);
  assert.equal(doc.cameras[0].perspective, undefined);
});

test('a skinned mesh exports joints, weights and a skin instead of a frozen pose', () => {
  const scene = new Scene();
  const rig = scene.add('armature', 'Rig');
  rig.armature = {
    bones: [
      createBone({ name: 'root', head: [0, 0, 0], tail: [0, 0, 1] }),
      createBone({ name: 'tip', parent: 0, head: [0, 0, 1], tail: [0, 0, 2] }),
    ],
  };

  const mesh = buildPrimitive('cube');
  mesh.skin = {
    bones: new Int32Array(mesh.vertCount * 4),
    weights: new Float32Array(mesh.vertCount * 4),
  };
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.skin.bones[v * 4] = v % 2;
    mesh.skin.weights[v * 4] = 1;
  }
  mesh.markDirty();
  const body = scene.add('mesh', 'Body', mesh);
  body.modifiers = [createModifier('armature')];
  (body.modifiers[0] as unknown as { objectId: number }).objectId = rig.id;

  const out = exportGLTF(scene);
  const doc = JSON.parse(out.json);

  assert.ok(doc.skins?.length, 'no skin was written, so the rig does not travel');
  const skin = doc.skins[0];
  assert.equal(skin.joints.length, 2, 'a node per bone should exist');
  assert.ok(skin.inverseBindMatrices !== undefined, 'no inverse bind matrices');
  const ibm = doc.accessors[skin.inverseBindMatrices];
  assert.equal(ibm.type, 'MAT4');
  assert.equal(ibm.count, 2);

  const prim = doc.meshes[0].primitives[0];
  assert.ok(prim.attributes.JOINTS_0 !== undefined, 'joint indices were dropped');
  assert.ok(prim.attributes.WEIGHTS_0 !== undefined, 'skin weights were dropped');
  assert.equal(doc.accessors[prim.attributes.JOINTS_0].componentType, 5123, 'joints must be ushort');
  assert.equal(doc.accessors[prim.attributes.WEIGHTS_0].type, 'VEC4');

  const meshNode = doc.nodes.find((n: { mesh?: number }) => n.mesh !== undefined);
  assert.equal(meshNode.skin, 0, 'the mesh node does not reference the skin');

  // Every joint has to be reachable, or the file is invalid.
  const named = new Set<number>(skin.joints);
  for (const j of skin.joints) assert.ok(doc.nodes[j], `joint ${j} is not a node`);
  assert.equal(named.size, skin.joints.length, 'a joint was listed twice');

  // And it says what it could not carry, rather than implying full fidelity.
  assert.ok(out.warnings.some((w) => /per-bone/i.test(w)),
    `no note about per-bone animation: ${out.warnings.join(' | ')}`);
});

/** Read an accessor's numbers back out of the embedded buffer. */
function readAccessor(doc: any, index: number): number[] {
  const a = doc.accessors[index];
  const view = doc.bufferViews[a.bufferView];
  const bytes = Buffer.from(doc.buffers[view.buffer].uri.split(',')[1], 'base64');
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type as string]!;
  const out: number[] = [];
  for (let i = 0; i < a.count * width; i++) {
    if (a.componentType === 5123) out.push(bytes.readUInt16LE(base + i * 2));
    else if (a.componentType === 5125) out.push(bytes.readUInt32LE(base + i * 4));
    else out.push(bytes.readFloatLE(base + i * 4));
  }
  return out;
}

test('unused skin slots do not become joint 65535', () => {
  // The Culp Mixer marks an empty influence slot with bone -1. Written as the unsigned
  // short glTF asks for, that became 65535 — a joint index thousands past the
  // end of the skin. The Khronos validator counted 5,664 of them in one
  // ordinary rigged sphere; an importer reads whatever is at that index.
  const scene = new Scene();
  const rig = scene.add('armature', 'Rig');
  rig.armature = { bones: [createBone({ name: 'root', head: [0, 0, 0], tail: [0, 0, 1] })] };

  const mesh = buildPrimitive('cube');
  mesh.skin = {
    bones: new Int32Array(mesh.vertCount * 4).fill(-1),
    weights: new Float32Array(mesh.vertCount * 4),
  };
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.skin.bones[v * 4] = 0;
    mesh.skin.weights[v * 4] = 1;
    // The other three slots stay -1, which is the usual case: four influences
    // are reserved per vertex and almost nothing uses all four.
  }
  mesh.markDirty();
  const body = scene.add('mesh', 'Body', mesh);
  body.modifiers = [createModifier('armature')];
  (body.modifiers[0] as unknown as { objectId: number }).objectId = rig.id;

  const doc = JSON.parse(exportGLTF(scene).json);
  const prim = doc.meshes[0].primitives[0];
  const joints = readAccessor(doc, prim.attributes.JOINTS_0);
  const weights = readAccessor(doc, prim.attributes.WEIGHTS_0);
  const jointCount = doc.skins[0].joints.length;
  for (let i = 0; i < joints.length; i++) {
    assert.ok(joints[i] < jointCount,
      `joint index ${joints[i]} is past the ${jointCount} joints in the skin`);
    // An empty slot is joint 0 with weight 0 — the only spelling glTF has.
    if (i % 4 !== 0) assert.equal(weights[i], 0, 'an unused slot carries a weight');
  }
});

test('buffer views only claim a GL target when they have one', () => {
  // A view holding inverse bind matrices or animation sampler values is read
  // by the importer, not bound as a vertex buffer. Stamping ARRAY_BUFFER on
  // all of them made the validator reject the file outright: one view cannot
  // be a vertex buffer and a bind-matrix store at once.
  const scene = new Scene();
  const rig = scene.add('armature', 'Rig');
  rig.armature = { bones: [createBone({ name: 'root', head: [0, 0, 0], tail: [0, 0, 1] })] };
  const mesh = buildPrimitive('cube');
  mesh.skin = {
    bones: new Int32Array(mesh.vertCount * 4).fill(0),
    weights: new Float32Array(mesh.vertCount * 4).fill(0.25),
  };
  mesh.markDirty();
  const body = scene.add('mesh', 'Body', mesh);
  body.modifiers = [createModifier('armature')];
  (body.modifiers[0] as unknown as { objectId: number }).objectId = rig.id;
  rig.animation = [
    { path: 'position', axis: 0, keys: [
      { frame: 1, value: 0, interpolation: 'linear' },
      { frame: 10, value: 3, interpolation: 'linear' },
    ] },
  ] as never;

  const doc = JSON.parse(exportGLTF(scene).json);
  const bound = new Set<number>();
  for (const m of doc.meshes) {
    for (const p of m.primitives) {
      for (const a of Object.values(p.attributes) as number[]) bound.add(doc.accessors[a].bufferView);
      if (p.indices !== undefined) bound.add(doc.accessors[p.indices].bufferView);
    }
  }
  const ibmView = doc.accessors[doc.skins[0].inverseBindMatrices].bufferView;
  assert.equal(doc.bufferViews[ibmView].target, undefined,
    'the inverse bind matrices are in a view that claims to be a vertex buffer');
  for (const anim of doc.animations ?? []) {
    for (const sampler of anim.samplers) {
      for (const which of [sampler.input, sampler.output]) {
        assert.equal(doc.bufferViews[doc.accessors[which].bufferView].target, undefined,
          'animation sampler data is in a view that claims a GL target');
      }
    }
  }
  for (const view of bound) {
    assert.ok([34962, 34963].includes(doc.bufferViews[view].target),
      'a vertex or index view lost its target');
  }
});

test('geometry with no UVs is not given a material it cannot sample', () => {
  // A material is shared, and only some of the objects using it need be
  // unwrapped. glTF calls a primitive with a base colour texture and no
  // TEXCOORD_0 an error, so the unwrapped half keeps the picture and the rest
  // gets a plain twin — and is told.
  const scene = new Scene();
  scene.textures.push({ id: 1, name: 'paint', url: 'data:image/png;base64,AAAA', width: 2, height: 2 });
  const plain = buildPrimitive('cube');
  plain.faceUV = plain.faces.map(() => null);
  plain.markDirty();
  scene.add('mesh', 'Plain', plain);
  scene.materials[0].baseColorTexture = 1;

  const out = exportGLTF(scene);
  const doc = JSON.parse(out.json);
  for (const m of doc.meshes) {
    for (const p of m.primitives) {
      const mat = doc.materials[p.material];
      if (p.attributes.TEXCOORD_0 === undefined) {
        assert.equal(mat.pbrMetallicRoughness.baseColorTexture, undefined,
          'a primitive with no UVs was handed a textured material');
      }
    }
  }
  assert.ok(out.warnings.some((w) => /no UVs|texture coordinates/i.test(w)),
    `nothing was said about the dropped picture: ${out.warnings.join(' | ')}`);
});

test('an export states what it could not carry', () => {
  const scene = new Scene();
  const cube = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  cube.animation = [
    { path: 'material.roughness', index: 0, keys: [{ frame: 1, value: 0.2, interp: 'linear' }, { frame: 5, value: 0.9, interp: 'linear' }] },
  ];
  scene.materials[0].transmission = 0.8;
  scene.materials[0].emissionStrength = 5;

  const out = exportGLTF(scene);
  assert.ok(out.warnings.some((w) => /material\.roughness/.test(w)),
    'an animated material property was dropped without a word');
  assert.ok(out.warnings.some((w) => /transmission/i.test(w)));
  assert.ok(out.warnings.some((w) => /emission/i.test(w)));

  const doc = JSON.parse(out.json);
  assert.ok(doc.extensionsUsed.includes('KHR_materials_transmission'));
  assert.equal(doc.materials[0].extensions.KHR_materials_transmission.transmissionFactor, 0.8);
});

test('a clean scene claims nothing it did not do', () => {
  const out = exportGLTF(sceneWithCube());
  assert.deepEqual(out.warnings, [], `a plain cube produced warnings: ${out.warnings.join(' | ')}`);
});
