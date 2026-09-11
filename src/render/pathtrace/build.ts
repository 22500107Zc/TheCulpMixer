import { Mat4, Vec3 } from '../../core/math';
import { Scene } from '../../scene/Scene';
import { ViewportCamera } from '../../scene/ViewportCamera';
import {
  LIGHT_STRIDE, MATERIAL_STRIDE, MAT_TEXTURE, MAT_UV_OFFSET, MAT_UV_SCALE,
  TraceCamera, TraceScene,
} from './types';
import { EMPTY_TEXTURES, PackedTextures } from './textures';

/** Flatten the editable scene into the tracer's transferable form. */
export function buildTraceScene(
  scene: Scene, camera: TraceCamera, skyStrength = 0.6,
  /**
   * Decoded pictures for the materials that use them.
   *
   * Handed in rather than fetched here because decoding needs a document and
   * this runs wherever a scene needs flattening, tests included.
   */
  packed: PackedTextures = EMPTY_TEXTURES,
): TraceScene {
  const posList: number[] = [];
  const nrmList: number[] = [];
  const uvList: number[] = [];
  const colList: number[] = [];
  const matList: number[] = [];
  let anyColor = false;

  for (const obj of scene.objects.values()) {
    if (!obj.visible || obj.type !== 'mesh') continue;
    const mesh = obj.evaluated(false);
    if (!mesh || mesh.faceCount === 0) continue;
    const model: Mat4 = obj.worldMatrix(scene);
    const normalMat = model.normalMatrix();
    const t = mesh.topology();
    const slots = obj.materialSlots.length ? obj.materialSlots : [0];

    const world = mesh.positions.map((p) => model.transformPoint(p));
    const worldVertN = t.vertNormals.map((n) => normalMat.transformDirection(n).normalized());

    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      if (loop.length < 3) continue;
      const smooth = mesh.isFaceSmooth(f);
      const fn = normalMat.transformDirection(t.faceNormals[f]).normalized();
      const slot = mesh.faceMaterial[f] ?? 0;
      const matIndex = slots[Math.min(slot, slots.length - 1)] ?? 0;
      const uv = mesh.uvFor(f);
      const vc = mesh.colors;
      if (vc) anyColor = true;
      for (let i = 1; i + 1 < loop.length; i++) {
        for (const corner of [0, i, i + 1]) {
          const v = loop[corner];
          const p = world[v];
          const n = smooth ? worldVertN[v] : fn;
          posList.push(p.x, p.y, p.z);
          nrmList.push(n.x, n.y, n.z);
          uvList.push(uv ? uv[corner * 2] : 0, uv ? uv[corner * 2 + 1] : 0);
          const painted = vc && v * 3 + 2 < vc.length;
          colList.push(
            painted ? vc[v * 3] : 1,
            painted ? vc[v * 3 + 1] : 1,
            painted ? vc[v * 3 + 2] : 1,
          );
        }
        matList.push(matIndex);
      }
    }
  }

  const materials = new Float32Array(Math.max(1, scene.materials.length) * MATERIAL_STRIDE);
  for (let i = 0; i < scene.materials.length; i++) {
    const m = scene.materials[i];
    const o = i * MATERIAL_STRIDE;
    materials[o] = m.color[0];
    materials[o + 1] = m.color[1];
    materials[o + 2] = m.color[2];
    materials[o + 3] = m.metallic;
    materials[o + 4] = m.roughness;
    materials[o + 5] = m.emission[0];
    materials[o + 6] = m.emission[1];
    materials[o + 7] = m.emission[2];
    materials[o + 8] = m.emissionStrength;
    materials[o + 9] = m.alpha;
    materials[o + 10] = m.transmission;
    materials[o + 11] = Math.max(1.0001, m.ior);
    // Which picture, and how it is laid out. -1 is "no texture", which is why
    // the slot is a float holding an integer rather than an index into a
    // parallel array that would have to be checked for length everywhere.
    const slot = m.baseColorTexture == null ? undefined : packed.slotOf.get(m.baseColorTexture);
    materials[o + MAT_TEXTURE] = slot === undefined ? -1 : slot;
    materials[o + MAT_UV_SCALE] = m.uvScale[0];
    materials[o + MAT_UV_SCALE + 1] = m.uvScale[1];
    materials[o + MAT_UV_OFFSET] = m.uvOffset[0];
    materials[o + MAT_UV_OFFSET + 1] = m.uvOffset[1];
  }
  if (scene.materials.length === 0) {
    materials.set([0.75, 0.75, 0.78, 0, 0.5, 0, 0, 0, 0, 1, 0, 1.45, -1, 1, 1, 0, 0]);
  }

  const lightObjects = [...scene.objects.values()].filter((o) => o.type === 'light' && o.visible && o.light);
  const lights = new Float32Array(Math.max(1, lightObjects.length) * LIGHT_STRIDE);
  lightObjects.forEach((obj, i) => {
    const l = obj.light!;
    const m = obj.worldMatrix(scene);
    const p = m.transformPoint(new Vec3());
    const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
    const type = l.type === 'point' ? 0 : l.type === 'sun' ? 1 : l.type === 'spot' ? 2 : 3;
    const o = i * LIGHT_STRIDE;
    lights[o] = p.x;
    lights[o + 1] = p.y;
    lights[o + 2] = p.z;
    lights[o + 3] = type;
    // A sun's "energy" is irradiance, not power, so it does not want the 4π.
    const e = type === 1 ? l.energy : l.energy;
    lights[o + 4] = l.color[0] * e;
    lights[o + 5] = l.color[1] * e;
    lights[o + 6] = l.color[2] * e;
    lights[o + 7] = Math.max(0, l.size);
    lights[o + 8] = d.x;
    lights[o + 9] = d.y;
    lights[o + 10] = d.z;
    lights[o + 11] = Math.cos(l.spotAngle);
  });

  const positions = new Float32Array(posList);
  const material = new Int32Array(matList);

  // Emissive triangles, kept with a running area sum so a light sample can
  // pick one in proportion to how much of the scene's glow it accounts for.
  const emissiveList: number[] = [];
  const cdfList: number[] = [];
  let area = 0;
  for (let tri = 0; tri < material.length; tri++) {
    const mo = material[tri] * MATERIAL_STRIDE;
    const strength = materials[mo + 8];
    if (strength <= 0) continue;
    if (materials[mo + 5] + materials[mo + 6] + materials[mo + 7] <= 0) continue;
    const o = tri * 9;
    const e1x = positions[o + 3] - positions[o];
    const e1y = positions[o + 4] - positions[o + 1];
    const e1z = positions[o + 5] - positions[o + 2];
    const e2x = positions[o + 6] - positions[o];
    const e2y = positions[o + 7] - positions[o + 1];
    const e2z = positions[o + 8] - positions[o + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const a = Math.hypot(cx, cy, cz) * 0.5;
    if (!(a > 0)) continue;
    area += a;
    emissiveList.push(tri);
    cdfList.push(area);
  }

  return {
    positions,
    normals: new Float32Array(nrmList),
    uvs: new Float32Array(uvList),
    // Left empty when nothing is painted, so the tracer can skip the lookup
    // rather than multiplying by white a few million times.
    colors: anyColor ? new Float32Array(colList) : new Float32Array(0),
    material,
    materials,
    textures: packed.data,
    textureIndex: packed.index,
    emissive: new Int32Array(emissiveList),
    emissiveCdf: new Float32Array(cdfList),
    emissiveArea: area,
    lights,
    lightCount: lightObjects.length,
    background: [...scene.world.background] as [number, number, number],
    ambient: scene.world.ambient,
    skyStrength,
    camera,
  };
}

/** Camera description for the current viewport view. */
export function cameraFromViewport(vc: ViewportCamera): TraceCamera {
  const eye = vc.eye();
  const f = vc.forward();
  const r = vc.right();
  const u = vc.up();
  return {
    origin: [eye.x, eye.y, eye.z],
    forward: [f.x, f.y, f.z],
    right: [r.x, r.y, r.z],
    up: [u.x, u.y, u.z],
    fovY: vc.fov,
    orthographic: vc.orthographic,
    orthoHeight: vc.orthoHalfHeight(),
    // The viewport camera is a pinhole; depth of field belongs to a real
    // camera object, where the user can see and set it.
    aperture: 0,
    focusDistance: vc.distance,
  };
}

/** Camera description for a scene camera object. */
export function cameraFromObject(scene: Scene, objId: number): TraceCamera | null {
  const obj = scene.get(objId);
  if (!obj || obj.type !== 'camera' || !obj.camera) return null;
  const m = obj.worldMatrix(scene);
  const origin = m.transformPoint(new Vec3());
  const forward = m.transformDirection(new Vec3(0, 0, -1)).normalized();
  const up = m.transformDirection(new Vec3(0, 1, 0)).normalized();
  const right = forward.cross(up).normalized();
  return {
    origin: [origin.x, origin.y, origin.z],
    forward: [forward.x, forward.y, forward.z],
    right: [right.x, right.y, right.z],
    up: [up.x, up.y, up.z],
    fovY: obj.camera.fov,
    orthographic: false,
    orthoHeight: 1,
    aperture: Math.max(0, obj.camera.aperture ?? 0),
    focusDistance: Math.max(1e-3, obj.camera.focusDistance ?? 5),
  };
}
