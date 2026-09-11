import { Mat4, Vec3, decomposeMatrix } from '../core/math';
import { Scene, SceneObject } from '../scene/Scene';
import { Channel, sampleChannel } from '../anim/animation';
import { poseMatrices } from '../anim/armature';

/**
 * glTF 2.0 export (.gltf with an embedded base64 buffer).
 *
 * Kline is Z-up, glTF is Y-up, so everything is parented to a root node that
 * carries a -90° X rotation instead of rewriting every vertex.
 */

interface GLTFAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/**
 * The aspect ratio a horizontal field of view is converted through.
 *
 * glTF stores the vertical angle and Kline stores the horizontal one, so the
 * conversion needs a ratio. A camera has no viewport of its own to ask, so the
 * file states the assumption rather than leaving the number unexplained.
 */
const GLTF_ASPECT = 16 / 9;

function eulerToQuaternion(e: Vec3): [number, number, number, number] {
  // Matches Mat4.rotationEuler: Rz * Ry * Rx.
  const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2);
  const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2);
  const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * What an export carried, and what it could not.
 *
 * glTF is not a superset of what Kline can hold, and the difference used to be
 * invisible: the file came out, nothing was said, and whatever the format had
 * no room for was simply missing when somebody opened it somewhere else. A
 * silent omission in an interchange format is the expensive kind of bug,
 * because it is found downstream by somebody who cannot tell whether the
 * modelling application or the importer lost it.
 */
export interface GLTFExport {
  json: string;
  /** Anything about this scene the file does not carry, in plain words. */
  warnings: string[];
}

/** A matrix as the translation/rotation/scale triple a glTF node carries. */
function matrixToTRS(m: Mat4): {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  const d = decomposeMatrix(m);
  return {
    translation: [d.position.x, d.position.y, d.position.z],
    rotation: eulerToQuaternion(d.rotation),
    scale: [d.scale.x, d.scale.y, d.scale.z],
  };
}

/** The armature an object is bound to, through its modifier stack. */
function armatureFor(scene: Scene, obj: SceneObject): SceneObject | null {
  for (const mod of obj.modifiers) {
    if (mod.type !== 'armature') continue;
    const id = (mod as unknown as { objectId?: number }).objectId;
    if (id === undefined) continue;
    const other = scene.get(id);
    if (other?.armature) return other;
  }
  return null;
}

export function exportGLTF(scene: Scene, selectionOnly = false): GLTFExport {
  const warnings: string[] = [];
  /** Say something once, however many objects prompt it. */
  const note = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: GLTFAccessor[] = [];

  const pushView = (data: ArrayBufferView, target: number): number => {
    // glTF requires 4-byte aligned buffer views.
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  // Images, and the textures that point at them.
  //
  // Kline stores a texture as a data URL so a saved scene is self-contained,
  // and glTF accepts a data URL as an image `uri` — so the picture travels
  // inside the .gltf too. Without this the export carried TEXCOORD_0 and a
  // material and no image at all: every model built from a photograph arrived
  // in Blender or a game engine as a grey lump, with nothing in the file to
  // say the photograph had ever been on it.
  const imageOfTexture = new Map<number, number>();
  const images: { uri: string; name?: string }[] = [];
  const textures: { source: number; sampler: number }[] = [];
  for (const t of scene.textures) {
    if (!t?.url || imageOfTexture.has(t.id)) continue;
    imageOfTexture.set(t.id, textures.length);
    images.push({ uri: t.url, name: t.name });
    textures.push({ source: images.length - 1, sampler: 0 });
  }
  const usesTextures = textures.length > 0;
  const textureTransforms: string[] = [];
  const materialExtensions: string[] = [];

  const materials = scene.materials.map((m) => {
    const index = m.baseColorTexture == null ? undefined : imageOfTexture.get(m.baseColorTexture);
    const pbr: Record<string, unknown> = {
      baseColorFactor: [...m.color, m.alpha],
      metallicFactor: m.metallic,
      roughnessFactor: m.roughness,
    };
    if (index !== undefined) {
      const base: Record<string, unknown> = { index };
      // Tiling and offset are not part of a plain glTF texture reference, so
      // exporting them silently would mean the model arrives with its picture
      // stretched differently from how it looks here.
      const tiled = m.uvScale[0] !== 1 || m.uvScale[1] !== 1
        || m.uvOffset[0] !== 0 || m.uvOffset[1] !== 0;
      if (tiled) {
        base.extensions = {
          KHR_texture_transform: { scale: [...m.uvScale], offset: [...m.uvOffset] },
        };
        if (!textureTransforms.length) textureTransforms.push('KHR_texture_transform');
      }
      pbr.baseColorTexture = base;
    }
    const out: Record<string, unknown> = {
      name: m.name,
      pbrMetallicRoughness: pbr,
      emissiveFactor: m.emission.map((c) => Math.min(1, c * Math.max(m.emissionStrength, 0))),
      alphaMode: m.alpha < 0.999 ? 'BLEND' : 'OPAQUE',
      doubleSided: true,
    };

    // Glass. These are standard ratified extensions rather than core glTF, so
    // an importer that does not know them falls back to an opaque surface —
    // which is why the export says it used them rather than assuming.
    const ext: Record<string, unknown> = {};
    if (m.transmission > 0) {
      ext.KHR_materials_transmission = { transmissionFactor: m.transmission };
      if (!materialExtensions.includes('KHR_materials_transmission')) {
        materialExtensions.push('KHR_materials_transmission');
      }
      note('Transmission and index of refraction are exported through KHR_materials_* '
        + 'extensions; importers that do not support them will show those surfaces opaque.');
    }
    if (Math.abs(m.ior - 1.45) > 1e-6) {
      ext.KHR_materials_ior = { ior: m.ior };
      if (!materialExtensions.includes('KHR_materials_ior')) {
        materialExtensions.push('KHR_materials_ior');
      }
    }
    if (Object.keys(ext).length) out.extensions = ext;
    if (m.emissionStrength > 1) {
      note('Emission strengths above 1 are clamped: glTF emissiveFactor is limited to 0–1 '
        + 'without the KHR_materials_emissive_strength extension.');
    }
    return out;
  });

  const meshes: unknown[] = [];
  const nodes: Record<string, unknown>[] = [];
  const lights: Record<string, unknown>[] = [];
  const cameraDefs: Record<string, unknown>[] = [];
  const skins: Record<string, unknown>[] = [];
  const nodeIndexById = new Map<number, number>();

  const included: SceneObject[] = [...scene.objects.values()].filter(
    (o) => (!selectionOnly || scene.selection.has(o.id)) && o.visible,
  );

  for (const obj of included) {
    const node: Record<string, unknown> = { name: obj.name };
    const q = eulerToQuaternion(obj.rotation);
    if (obj.position.lengthSq() > 0) node.translation = obj.position.toArray();
    if (Math.abs(q[3] - 1) > 1e-9) node.rotation = q;
    if (!obj.scale.equals(new Vec3(1, 1, 1))) node.scale = obj.scale.toArray();

    if (obj.type === 'mesh') {
      // A skinned mesh is a special case. `evaluated()` has already applied the
      // armature, so exporting that would bake the pose into the vertices and
      // hand over a statue. glTF wants the *rest* shape plus joints and
      // weights, and does the skinning itself — which is what makes the rig
      // usable in whatever opens it.
      const rig = armatureFor(scene, obj);
      const skinned = rig && obj.mesh?.skin ? obj.mesh : null;
      if (skinned && obj.modifiers.filter((m) => m.type !== 'armature').length > 0) {
        note(`"${obj.name}" is skinned, so its other modifiers are not applied in the export — `
          + 'glTF needs the rest shape for the rig to work.');
      }
      const mesh = skinned ?? obj.evaluated();
      if (mesh && mesh.faceCount > 0) {
        const t = mesh.topology();
        // One primitive per material slot used by the mesh.
        const bySlot = new Map<number, number[]>();
        for (let f = 0; f < mesh.faces.length; f++) {
          const slot = mesh.faceMaterial[f] ?? 0;
          const list = bySlot.get(slot) ?? [];
          list.push(f);
          bySlot.set(slot, list);
        }
        const primitives: unknown[] = [];
        for (const [slot, faces] of bySlot) {
          const positions: number[] = [];
          const normals: number[] = [];
          const texcoords: number[] = [];
          const colors: number[] = [];
          const joints: number[] = [];
          const weights: number[] = [];
          const indices: number[] = [];
          let anyUV = false;
          const vc = mesh.colors;
          const sk = skinned ? mesh.skin : null;
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (const f of faces) {
            const loop = mesh.faces[f];
            const smooth = mesh.isFaceSmooth(f);
            const base = positions.length / 3;
            const uv = mesh.uvFor(f);
            if (uv) anyUV = true;
            for (let corner = 0; corner < loop.length; corner++) {
              const v = loop[corner];
              const p = mesh.positions[v];
              const n = smooth ? t.shadingNormals[v] : t.faceNormals[f];
              positions.push(p.x, p.y, p.z);
              normals.push(n.x, n.y, n.z);
              // glTF's V axis runs the other way.
              texcoords.push(uv ? uv[corner * 2] : 0, uv ? 1 - uv[corner * 2 + 1] : 0);
              if (vc) {
                // VEC4 with an opaque alpha: both VEC3 and VEC4 are legal, and
                // VEC4 is the one every importer handles without argument.
                const at = v * 3;
                colors.push(vc[at] ?? 1, vc[at + 1] ?? 1, vc[at + 2] ?? 1, 1);
              }
              if (sk) {
                const at = v * 4;
                joints.push(
                  sk.bones[at] ?? 0, sk.bones[at + 1] ?? 0,
                  sk.bones[at + 2] ?? 0, sk.bones[at + 3] ?? 0,
                );
                weights.push(
                  sk.weights[at] ?? 0, sk.weights[at + 1] ?? 0,
                  sk.weights[at + 2] ?? 0, sk.weights[at + 3] ?? 0,
                );
              }
              for (let k = 0; k < 3; k++) {
                const c = [p.x, p.y, p.z][k];
                min[k] = Math.min(min[k], c);
                max[k] = Math.max(max[k], c);
              }
            }
            for (let i = 1; i + 1 < loop.length; i++) indices.push(base, base + i, base + i + 1);
          }
          if (indices.length === 0) continue;

          const posView = pushView(new Float32Array(positions), TARGET_ARRAY_BUFFER);
          accessors.push({
            bufferView: posView, componentType: COMPONENT_FLOAT,
            count: positions.length / 3, type: 'VEC3', min, max,
          });
          const posAccessor = accessors.length - 1;

          const nrmView = pushView(new Float32Array(normals), TARGET_ARRAY_BUFFER);
          accessors.push({
            bufferView: nrmView, componentType: COMPONENT_FLOAT,
            count: normals.length / 3, type: 'VEC3',
          });
          const nrmAccessor = accessors.length - 1;

          let uvAccessor: number | undefined;
          if (anyUV) {
            const uvView = pushView(new Float32Array(texcoords), TARGET_ARRAY_BUFFER);
            accessors.push({
              bufferView: uvView, componentType: COMPONENT_FLOAT,
              count: texcoords.length / 2, type: 'VEC2',
            });
            uvAccessor = accessors.length - 1;
          }

          const idxView = pushView(new Uint32Array(indices), TARGET_ELEMENT_ARRAY_BUFFER);
          accessors.push({
            bufferView: idxView, componentType: COMPONENT_UINT,
            count: indices.length, type: 'SCALAR',
          });
          const idxAccessor = accessors.length - 1;

          const attributes: Record<string, number> = { POSITION: posAccessor, NORMAL: nrmAccessor };
          if (uvAccessor !== undefined) attributes.TEXCOORD_0 = uvAccessor;

          // Painted colour. Previously dropped without a word, so a mesh
          // painted in Kline arrived plain white everywhere else.
          if (colors.length) {
            const colView = pushView(new Float32Array(colors), TARGET_ARRAY_BUFFER);
            accessors.push({
              bufferView: colView, componentType: COMPONENT_FLOAT,
              count: colors.length / 4, type: 'VEC4',
            });
            attributes.COLOR_0 = accessors.length - 1;
          }

          if (joints.length) {
            // Joint indices are unsigned shorts, which is what the format
            // expects and what keeps the buffer half the size.
            const jointView = pushView(new Uint16Array(joints), TARGET_ARRAY_BUFFER);
            accessors.push({
              bufferView: jointView, componentType: COMPONENT_USHORT,
              count: joints.length / 4, type: 'VEC4',
            });
            attributes.JOINTS_0 = accessors.length - 1;

            const weightView = pushView(new Float32Array(weights), TARGET_ARRAY_BUFFER);
            accessors.push({
              bufferView: weightView, componentType: COMPONENT_FLOAT,
              count: weights.length / 4, type: 'VEC4',
            });
            attributes.WEIGHTS_0 = accessors.length - 1;
          }
          primitives.push({
            attributes,
            indices: idxAccessor,
            material: obj.materialSlots[slot] ?? 0,
            mode: 4,
          });
        }
        if (primitives.length) {
          meshes.push({ name: `${obj.name}-mesh`, primitives });
          node.mesh = meshes.length - 1;
        }
      }
    } else if (obj.type === 'light' && obj.light) {
      const l = obj.light;
      const type = l.type === 'sun' ? 'directional' : l.type === 'spot' ? 'spot' : 'point';
      const light: Record<string, unknown> = {
        name: obj.name,
        type,
        color: l.color,
        // Approximate: Blender-style watts converted to candela / lux.
        intensity: type === 'directional' ? l.energy : l.energy / (4 * Math.PI),
      };
      if (type === 'spot') {
        light.spot = { innerConeAngle: l.spotAngle * 0.75, outerConeAngle: l.spotAngle };
      }
      lights.push(light);
      node.extensions = { KHR_lights_punctual: { light: lights.length - 1 } };
    } else if (obj.type === 'camera' && obj.camera) {
      const c = obj.camera;
      if (c.orthographic) {
        const half = Math.max(1e-4, c.orthoScale / 2);
        cameraDefs.push({
          name: obj.name,
          type: 'orthographic',
          orthographic: { xmag: half, ymag: half, znear: Math.max(1e-6, c.near), zfar: c.far },
        });
      } else {
        cameraDefs.push({
          name: obj.name,
          type: 'perspective',
          // Kline stores a horizontal field of view; glTF wants the vertical
          // one, and the conversion needs an aspect ratio to go through.
          perspective: {
            yfov: 2 * Math.atan(Math.tan((c.fov * Math.PI / 180) / 2) / GLTF_ASPECT),
            znear: Math.max(1e-6, c.near),
            zfar: c.far,
            aspectRatio: GLTF_ASPECT,
          },
        });
      }
      node.camera = cameraDefs.length - 1;
      if ((c.aperture ?? 0) > 0) {
        note('Depth of field (camera aperture) is not part of glTF, so exported cameras '
          + 'render everything sharp.');
      }
    }

    nodes.push(node);
    nodeIndexById.set(obj.id, nodes.length - 1);
  }

  // Re-create the hierarchy, then parent everything under a Z-up→Y-up root.
  const parented = new Set<number>();
  for (const obj of included) {
    if (obj.parent === null) continue;
    const pi = nodeIndexById.get(obj.parent);
    const ci = nodeIndexById.get(obj.id);
    if (pi === undefined || ci === undefined) continue;
    const kids = (nodes[pi].children as number[]) ?? [];
    kids.push(ci);
    nodes[pi].children = kids;
    parented.add(ci);
  }
  // ---- skins: a node per bone, so the rig arrives usable rather than baked
  //
  // Kline keeps bones as data on one armature object; glTF needs each joint to
  // be a node in the hierarchy. They are emitted here, after the object nodes
  // exist, and parented under their armature so the whole rig moves with it.
  const skinForArmature = new Map<number, number>();
  for (const rigObj of included) {
    if (rigObj.type !== 'armature' || !rigObj.armature) continue;
    const bones = rigObj.armature.bones;
    if (!bones.length) continue;
    const { rest, pose } = poseMatrices(rigObj.armature);
    const jointNodes: number[] = [];
    for (let i = 0; i < bones.length; i++) {
      // The posed matrix relative to the parent bone, which is what a node
      // transform is. Kline has no per-bone animation channels, so this is the
      // single pose the armature is currently in.
      const parent = bones[i].parent;
      const local = parent >= 0 && parent < i
        ? pose[parent].inverse().multiply(pose[i])
        : pose[i];
      const placed = matrixToTRS(local);
      const boneNode: Record<string, unknown> = { name: bones[i].name };
      if (placed.translation.some((n) => n !== 0)) boneNode.translation = placed.translation;
      if (Math.abs(placed.rotation[3] - 1) > 1e-9) boneNode.rotation = placed.rotation;
      if (placed.scale.some((n) => Math.abs(n - 1) > 1e-9)) boneNode.scale = placed.scale;
      nodes.push(boneNode);
      jointNodes.push(nodes.length - 1);
    }
    // Children, so the rig is one tree rather than a pile of loose nodes.
    for (let i = 0; i < bones.length; i++) {
      const parent = bones[i].parent;
      const owner = parent >= 0 && parent < i
        ? jointNodes[parent]
        : nodeIndexById.get(rigObj.id);
      if (owner === undefined) continue;
      const kids = (nodes[owner].children as number[]) ?? [];
      kids.push(jointNodes[i]);
      nodes[owner].children = kids;
      parented.add(jointNodes[i]);
    }
    // The inverse bind matrix takes a vertex from the mesh's space into the
    // bone's, which for a rest-pose export is the inverse of the bone's rest
    // matrix in armature space.
    const ibm = new Float32Array(bones.length * 16);
    for (let i = 0; i < bones.length; i++) ibm.set(rest[i].inverse().m, i * 16);
    const ibmView = pushView(ibm, TARGET_ARRAY_BUFFER);
    accessors.push({
      bufferView: ibmView, componentType: COMPONENT_FLOAT,
      count: bones.length, type: 'MAT4',
    });
    skins.push({
      name: rigObj.name,
      joints: jointNodes,
      inverseBindMatrices: accessors.length - 1,
      skeleton: nodeIndexById.get(rigObj.id),
    });
    skinForArmature.set(rigObj.id, skins.length - 1);
    note('Bone poses are exported as they stand. Kline animates an armature as a whole '
      + 'rather than keyframing individual bones, so no per-bone curves are written.');
  }
  for (const obj of included) {
    if (obj.type !== 'mesh' || !obj.mesh?.skin) continue;
    const rig = armatureFor(scene, obj);
    const skin = rig ? skinForArmature.get(rig.id) : undefined;
    const nodeIndex = nodeIndexById.get(obj.id);
    if (skin === undefined || nodeIndex === undefined) continue;
    if (nodes[nodeIndex].mesh !== undefined) nodes[nodeIndex].skin = skin;
  }

  const roots = nodes.map((_, i) => i).filter((i) => !parented.has(i));
  const s = Math.SQRT1_2;
  nodes.push({ name: 'KlineScene', rotation: [-s, 0, 0, s], children: roots });
  const rootIndex = nodes.length - 1;

  // Cameras are emitted above, one per camera object, each carrying its own
  // settings. Every camera in the file used to point at `cameras[0]`, a single
  // hard-coded 39.6° perspective — so a scene with a wide establishing shot and
  // a long lens arrived with two identical cameras, and an orthographic camera
  // arrived as a perspective one.
  const cameras = cameraDefs.length ? cameraDefs : undefined;

  // ---- animation: one sampler per animated node, baked at the scene's fps
  const animChannels: Record<string, unknown>[] = [];
  const animSamplers: Record<string, unknown>[] = [];
  const tl = scene.timeline;
  for (const obj of included) {
    if (obj.animation.length === 0) continue;
    const nodeIndex = nodeIndexById.get(obj.id);
    if (nodeIndex === undefined) continue;
    const frames: number[] = [];
    for (let f = tl.start; f <= tl.end; f++) frames.push(f);
    if (frames.length < 2) continue;
    const times = new Float32Array(frames.map((f) => (f - tl.start) / Math.max(1, tl.fps)));
    const timeView = pushView(times, TARGET_ARRAY_BUFFER);
    accessors.push({
      bufferView: timeView, componentType: COMPONENT_FLOAT, count: times.length,
      type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]],
    });
    const timeAccessor = accessors.length - 1;

    const paths: { path: 'translation' | 'rotation' | 'scale'; key: 'position' | 'rotation' | 'scale' }[] = [
      { path: 'translation', key: 'position' },
      { path: 'rotation', key: 'rotation' },
      { path: 'scale', key: 'scale' },
    ];
    const unsupported = new Set(
      obj.animation
        .filter((c: Channel) => c.path !== 'position' && c.path !== 'rotation' && c.path !== 'scale')
        .map((c: Channel) => c.path),
    );
    if (unsupported.size) {
      note(`Animated ${[...unsupported].join(', ')} is not carried: glTF animates node `
        + 'transforms and morph weights only, so those curves stay in the .kline file.');
    }
    for (const { path, key } of paths) {
      const chans = obj.animation.filter((c: Channel) => c.path === key);
      if (chans.length === 0) continue;
      const base = key === 'position' ? obj.position : key === 'rotation' ? obj.rotation : obj.scale;
      const comps = path === 'rotation' ? 4 : 3;
      const values = new Float32Array(frames.length * comps);
      frames.forEach((frame, i) => {
        const v = base.clone();
        for (const c of chans) {
          const sampled = sampleChannel(c, frame);
          if (sampled === null) continue;
          if (c.index === 0) v.x = sampled;
          else if (c.index === 1) v.y = sampled;
          else v.z = sampled;
        }
        if (path === 'rotation') values.set(eulerToQuaternion(v), i * 4);
        else values.set([v.x, v.y, v.z], i * 3);
      });
      const valueView = pushView(values, TARGET_ARRAY_BUFFER);
      accessors.push({
        bufferView: valueView, componentType: COMPONENT_FLOAT,
        count: frames.length, type: path === 'rotation' ? 'VEC4' : 'VEC3',
      });
      animSamplers.push({ input: timeAccessor, output: accessors.length - 1, interpolation: 'LINEAR' });
      animChannels.push({
        sampler: animSamplers.length - 1,
        target: { node: nodeIndex, path },
      });
    }
  }

  const totalBytes = new Uint8Array(byteLength);
  let o = 0;
  for (const c of chunks) {
    totalBytes.set(c, o);
    o += c.byteLength;
  }

  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Kline' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [rootIndex] }],
    nodes,
    meshes,
    materials: materials.length ? materials : undefined,
    images: usesTextures ? images : undefined,
    textures: usesTextures ? textures : undefined,
    // One sampler for everything: Kline wraps and filters every texture the
    // same way, so a per-texture sampler would be the same object repeated.
    samplers: usesTextures
      ? [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
      : undefined,
    accessors,
    bufferViews,
    skins: skins.length ? skins : undefined,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${base64(totalBytes)}` }],
    animations: animChannels.length
      ? [{ name: 'KlineAction', channels: animChannels, samplers: animSamplers }]
      : undefined,
    cameras,
  };
  const extensions = [
    ...(lights.length ? ['KHR_lights_punctual'] : []),
    ...textureTransforms,
    ...materialExtensions,
  ];
  if (extensions.length) gltf.extensionsUsed = extensions;
  if (lights.length) gltf.extensions = { KHR_lights_punctual: { lights } };
  return { json: JSON.stringify(gltf, null, 2), warnings };
}
