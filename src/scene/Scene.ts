import { AABB, Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import {
  ArmatureResolver, Modifier, ObjectResolver, evaluateStack, normaliseModifier, stackKey,
} from '../modifiers';
import { Material, cloneMaterial, createMaterial } from './Material';
import { SceneTexture, acceptTextures, reserveTextureId } from './Texture';
import {
  Channel, ChannelPath, TimelineSettings, cloneChannels, completeTransform, defaultTimeline,
  samplePropertyChannels, sampleChannels,
} from '../anim/animation';
import { ArmatureData, cloneArmature, createArmature } from '../anim/armature';
import {
  Action, Strip, blendStrips, cloneAction, cloneActions, cloneStrip, cloneStrips, splitBlend,
} from '../anim/actions';
import { BodyShape } from '../physics/rigidbody';
import { Provenance, cloneProvenance, newAssetId, normaliseProvenance } from '../build/provenance';

/** How an object takes part in a rigid body simulation. */
export interface PhysicsBody {
  /** Passive bodies never move; they are the floor and the walls. */
  kind: 'active' | 'passive';
  shape: BodyShape;
  mass: number;
  friction: number;
  restitution: number;
}

export function createPhysicsBody(kind: 'active' | 'passive' = 'active'): PhysicsBody {
  return {
    kind,
    shape: 'box',
    mass: kind === 'passive' ? 0 : 1,
    friction: 0.5,
    restitution: 0.1,
  };
}

export type ObjectType = 'mesh' | 'light' | 'camera' | 'empty' | 'armature';
export type LightType = 'point' | 'sun' | 'spot' | 'area';

export interface LightData {
  type: LightType;
  color: [number, number, number];
  /** Watts for point/spot/area, irradiance for sun. */
  energy: number;
  /** Spot cone half-angle in radians. */
  spotAngle: number;
  /** Area light edge length. */
  size: number;
}

export interface CameraData {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  orthoScale: number;
  /**
   * Lens radius in scene units. Zero is a pinhole — everything sharp, which is
   * what a renderer does by default and what no real camera does.
   */
  aperture?: number;
  /** Distance to the plane that stays sharp when the aperture is open. */
  focusDistance?: number;
}

export function createLightData(type: LightType = 'point'): LightData {
  return {
    type,
    color: [1, 1, 1],
    energy: type === 'sun' ? 3 : 100,
    spotAngle: Math.PI / 6,
    size: 1,
  };
}

export function createCameraData(): CameraData {
  return {
    fov: 39.6 * (Math.PI / 180), near: 0.1, far: 1000, orthographic: false, orthoScale: 6,
    aperture: 0, focusDistance: 8,
  };
}

export class SceneObject {
  id: number;
  name: string;
  type: ObjectType;
  position = new Vec3();
  rotation = new Vec3();
  scale = new Vec3(1, 1, 1);
  visible = true;
  /** Excluded from selection and picking when locked. */
  locked = false;
  parent: number | null = null;
  children: number[] = [];
  mesh: Mesh | null = null;
  modifiers: Modifier[] = [];
  /** Indices into `Scene.materials`; face material slots index into this list. */
  materialSlots: number[] = [];
  light: LightData | null = null;
  camera: CameraData | null = null;
  /** Bones, when this object is an armature. */
  armature: ArmatureData | null = null;
  /**
   * Named takes this object can play.
   *
   * `animation` above is the one being edited; these are the ones being kept.
   * Empty on almost everything, which is why they are separate rather than one
   * list with a "current" index — an object with a single set of keys should
   * cost exactly what it did before actions existed.
   */
  actions: Action[] = [];
  /**
   * When each action plays, and how it mixes with the others.
   *
   * Non-empty is what switches this object over to blended evaluation; empty
   * means `animation` drives it directly, exactly as it always has.
   */
  strips: Strip[] = [];
  /**
   * Rigid body settings, when this object takes part in a simulation. Kept on
   * the object rather than in a separate world so it survives a save and
   * travels with a copied object.
   */
  physics: PhysicsBody | null = null;
  /**
   * How this object was generated, on the root of a generated asset.
   *
   * Null on anything modelled by hand, imported, or made before revisions
   * existed — which is a supported state everywhere, not a missing field.
   */
  provenance: Provenance | null = null;
  /**
   * Which generated part this is, on a child of a generated asset.
   *
   * Stable across renames, reordering and a save/reload; see `partKeyFor`.
   * Null on anything the user added themselves, which is exactly what tells
   * a regeneration to leave it alone.
   */
  partKey: string | null = null;
  /**
   * Held back from regeneration at the user's request.
   *
   * A revision that would change a protected part reports a conflict instead
   * of changing it. Distinct from `locked`, which is about selection and
   * picking in the viewport.
   */
  protectedFromRegen = false;

  private evalCache: { key: string; revision: number; mesh: Mesh } | null = null;

  /** Keyframe channels driving this object's transform. */
  animation: Channel[] = [];
  /**
   * Back-reference to the owning scene. Modifiers that point at another object
   * (boolean, above all) cannot be evaluated without it.
   */
  owner: Scene | null = null;
  /** Re-entrancy guard: a boolean chain that loops back would never return. */
  private evaluating = false;

  constructor(id: number, name: string, type: ObjectType) {
    this.id = id;
    this.name = name;
    this.type = type;
  }

  matrix(): Mat4 {
    return Mat4.compose(this.position, this.rotation, this.scale);
  }

  /** Local matrix combined with every ancestor's. */
  worldMatrix(scene: Scene): Mat4 {
    let m = this.matrix();
    let p = this.parent !== null ? scene.get(this.parent) : null;
    let guard = 0;
    while (p && guard++ < 64) {
      m = p.matrix().multiply(m);
      p = p.parent !== null ? scene.get(p.parent) : null;
    }
    return m;
  }

  /** Modifier-evaluated mesh, memoised against geometry revision + stack state. */
  evaluated(editMode = false): Mesh | null {
    if (!this.mesh) return null;
    if (this.modifiers.length === 0) return this.mesh;
    if (this.evaluating) return this.mesh;
    const scene = this.owner;
    // References to other objects have to be part of the cache key, or editing
    // a boolean's cutter would leave the result stale.
    let refs = '';
    if (scene) {
      for (const mod of this.modifiers) {
        if (mod.type !== 'armature' && mod.type !== 'boolean') continue;
        if (mod.objectId === null) continue;
        const other = scene.get(mod.objectId);
        if (mod.type === 'armature') {
          // The pose is the input here, so it has to be part of the key or a
          // posed rig would keep showing the mesh from before it moved.
          refs += `|A${mod.objectId}:${JSON.stringify(other?.armature?.bones ?? null)}`;
          refs += `:${JSON.stringify(other?.position)},${JSON.stringify(other?.rotation)}`;
        } else if (mod.type === 'boolean') {
          refs += `|${mod.objectId}:${other?.mesh?.revision ?? -1}`;
        }
      }
    }
    const key = stackKey(this.modifiers, editMode) + refs;
    if (this.evalCache && this.evalCache.key === key && this.evalCache.revision === this.mesh.revision) {
      return this.evalCache.mesh;
    }
    const resolve: ObjectResolver | undefined = scene
      ? (id) => {
        const other = scene.get(id);
        if (!other || other === this) return null;
        const geo = other.evaluated(false);
        if (!geo) return null;
        // Bring the cutter into this object's local space.
        const into = this.worldMatrix(scene).inverse().multiply(other.worldMatrix(scene));
        const copy = geo.clone();
        copy.transform(into);
        return copy;
      }
      : undefined;
    this.evaluating = true;
    let result: Mesh;
    try {
      const rig: ArmatureResolver | undefined = scene
        ? (id) => {
          const other = scene.get(id);
          if (!other || !other.armature) return null;
          const mine = this.worldMatrix(scene);
          const theirs = other.worldMatrix(scene);
          return {
            armature: other.armature,
            meshToArmature: theirs.inverse().multiply(mine),
            armatureToMesh: mine.inverse().multiply(theirs),
          };
        }
        : undefined;
      result = evaluateStack(this.mesh, this.modifiers, editMode, resolve, rig);
    } finally {
      this.evaluating = false;
    }
    this.evalCache = { key, revision: this.mesh.revision, mesh: result };
    return result;
  }

  invalidate(): void {
    this.evalCache = null;
  }

  get animated(): boolean {
    return this.animation.length > 0;
  }

  /**
   * World-space bounds, including children — a group's extent is its contents,
   * otherwise framing an empty puts the camera inside whatever hangs off it.
   */
  bounds(scene: Scene, editMode = false, depth = 0): AABB {
    const b = new AABB();
    const m = this.worldMatrix(scene);
    const geo = this.evaluated(editMode);
    if (geo) {
      for (const p of geo.positions) b.expand(m.transformPoint(p));
    } else {
      b.expand(m.transformPoint(new Vec3()));
    }
    if (depth < 32) {
      for (const id of this.children) {
        const child = scene.get(id);
        if (child && child.visible) b.union(child.bounds(scene, editMode, depth + 1));
      }
    }
    return b;
  }
}

export interface WorldSettings {
  background: [number, number, number];
  ambient: number;
  showGrid: boolean;
  gridSize: number;
  /**
   * Strength of the sky dome in a path-traced render. It both lights the
   * scene and is what a ray that escapes sees, so raising it brightens the
   * shadows and the backdrop together.
   */
  sky: number;
}

export class Scene {
  objects = new Map<number, SceneObject>();
  /** Top-level display order in the outliner. */
  order: number[] = [];
  materials: Material[] = [];
  /** Images referenced by materials, embedded so a saved scene is portable. */
  textures: SceneTexture[] = [];
  /**
   * Images a loaded document asked for that were refused, for the caller to
   * report. Not an error: the rest of the document is still worth having.
   */
  rejectedTextures: string[] = [];
  world: WorldSettings = {
    background: [0.05, 0.05, 0.06],
    ambient: 0.12,
    showGrid: true,
    gridSize: 1,
    sky: 0.35,
  };
  selection = new Set<number>();
  active: number | null = null;
  timeline: TimelineSettings = defaultTimeline();
  /** 3D cursor — the pivot/spawn point, as in Blender. */
  cursor = new Vec3();

  private nextId = 1;
  private nameCounts = new Map<string, number>();

  /**
   * Take over every piece of state from another scene, in one place.
   *
   * Undo and File > Open both replace the whole scene, and both used to do it
   * by assigning the fields they remembered to list — objects, order,
   * materials, world, cursor, selection, active. Both lists were missing the
   * same two things, and had been for as long as the two lists existed:
   * `textures` and `timeline`.
   *
   * What that cost: opening a file kept the previous scene's images and threw
   * the file's own away. Since a material names its texture by id, opening a
   * photo model while a UV checker happened to hold id 1 put the checker on
   * the model. The discarded images were never freed either, so every file
   * opened added its predecessor's embedded PNGs to the next save. Undo had
   * the same hole from the other side: adding a texture and undoing left the
   * image in the document for good.
   *
   * Two lists that have to agree will not stay agreeing. There is one now, and
   * it lives next to the fields it copies.
   */
  adopt(other: Scene): void {
    this.objects = other.objects;
    this.order = other.order;
    this.materials = other.materials;
    this.textures = other.textures;
    this.world = other.world;
    this.cursor = other.cursor;
    this.selection = other.selection;
    this.active = other.active;
    this.timeline = other.timeline;
    // Never counted backwards. Undo restores the objects that held the old
    // ids, so rewinding the counter would hand a live id to the next object
    // added — and anything still pointing at the first one would silently
    // follow the second.
    this.nextId = Math.max(this.nextId, other.nextId);
  }

  uniqueName(base: string): string {
    const used = new Set([...this.objects.values()].map((o) => o.name));
    if (!used.has(base)) {
      this.nameCounts.set(base, 0);
      return base;
    }
    let n = this.nameCounts.get(base) ?? 0;
    let name: string;
    do {
      n++;
      name = `${base}.${String(n).padStart(3, '0')}`;
    } while (used.has(name));
    this.nameCounts.set(base, n);
    return name;
  }

  add(type: ObjectType, name: string, mesh: Mesh | null = null): SceneObject {
    const obj = new SceneObject(this.nextId++, this.uniqueName(name), type);
    obj.owner = this;
    obj.mesh = mesh;
    if (type === 'light') obj.light = createLightData();
    if (type === 'camera') obj.camera = createCameraData();
    if (type === 'armature') obj.armature = createArmature();
    if (mesh) obj.materialSlots = [this.ensureDefaultMaterial()];
    this.objects.set(obj.id, obj);
    this.order.push(obj.id);
    return obj;
  }

  get(id: number | null): SceneObject | null {
    return id === null ? null : this.objects.get(id) ?? null;
  }

  get activeObject(): SceneObject | null {
    return this.get(this.active);
  }

  selectedObjects(): SceneObject[] {
    return [...this.selection].map((id) => this.objects.get(id)).filter((o): o is SceneObject => !!o);
  }

  remove(id: number): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    for (const c of [...obj.children]) this.remove(c);
    if (obj.parent !== null) {
      const p = this.objects.get(obj.parent);
      if (p) p.children = p.children.filter((c) => c !== id);
    }
    this.objects.delete(id);
    this.order = this.order.filter((o) => o !== id);
    this.selection.delete(id);
    if (this.active === id) this.active = this.selection.values().next().value ?? null;
  }

  /**
   * Copy an object and everything under it.
   *
   * The subtree rather than the object alone, because a generated asset *is*
   * a root plus its parts: copying the root by itself would leave a record of
   * twenty steps with no steps under it.
   *
   * The copy is a new asset, not a second reference to the same one. Asset
   * ids are how a revision finds what it is revising, so two objects sharing
   * one would mean revising either changed the record of both. Part keys are
   * kept, because within the copy they still identify the same parts.
   */
  duplicateObject(id: number, parentId: number | null = null): SceneObject | null {
    const src = this.objects.get(id);
    if (!src) return null;
    const copy = this.add(src.type, src.name.replace(/\.\d+$/, ''), src.mesh ? src.mesh.clone() : null);
    copy.position = src.position.clone();
    copy.rotation = src.rotation.clone();
    copy.scale = src.scale.clone();
    copy.visible = src.visible;
    copy.locked = src.locked;
    copy.modifiers = JSON.parse(JSON.stringify(src.modifiers));
    copy.materialSlots = [...src.materialSlots];
    copy.light = src.light ? { ...src.light, color: [...src.light.color] as [number, number, number] } : null;
    copy.camera = src.camera ? { ...src.camera } : null;
    copy.armature = src.armature ? cloneArmature(src.armature) : null;
    copy.actions = src.actions.map(cloneAction);
    copy.strips = src.strips.map(cloneStrip);
    copy.physics = src.physics ? { ...src.physics } : null;
    copy.animation = cloneChannels(src.animation);
    copy.partKey = src.partKey;
    copy.protectedFromRegen = src.protectedFromRegen;
    if (src.provenance) {
      copy.provenance = cloneProvenance(src.provenance);
      copy.provenance.assetId = newAssetId();
    }
    if (parentId !== null) this.setParent(copy.id, parentId);
    for (const child of src.children) this.duplicateObject(child, copy.id);
    return copy;
  }

  setParent(childId: number, parentId: number | null): void {
    const child = this.objects.get(childId);
    if (!child) return;
    // Refuse to build a cycle.
    let p = parentId;
    let guard = 0;
    while (p !== null && guard++ < 64) {
      if (p === childId) return;
      p = this.objects.get(p)?.parent ?? null;
    }
    if (child.parent !== null) {
      const old = this.objects.get(child.parent);
      if (old) old.children = old.children.filter((c) => c !== childId);
    }
    child.parent = parentId;
    if (parentId !== null) {
      const np = this.objects.get(parentId);
      if (np && !np.children.includes(childId)) np.children.push(childId);
      this.order = this.order.filter((o) => o !== childId);
    } else if (!this.order.includes(childId)) {
      this.order.push(childId);
    }
  }

  ensureDefaultMaterial(): number {
    if (this.materials.length === 0) {
      this.materials.push(createMaterial({ name: 'Material', color: [0.75, 0.75, 0.78] }));
    }
    return 0;
  }

  addMaterial(m?: Material): number {
    this.materials.push(m ?? createMaterial());
    return this.materials.length - 1;
  }

  materialFor(obj: SceneObject, faceSlot: number): Material {
    const idx = obj.materialSlots[faceSlot] ?? obj.materialSlots[0] ?? 0;
    return this.materials[idx] ?? createMaterial();
  }

  /** Depth-first traversal of the hierarchy in outliner order. */
  *walk(): Generator<{ obj: SceneObject; depth: number }> {
    const visit = function* (this: Scene, id: number, depth: number): Generator<{ obj: SceneObject; depth: number }> {
      const o = this.objects.get(id);
      if (!o) return;
      yield { obj: o, depth };
      for (const c of o.children) yield* visit.call(this, c, depth + 1);
    }.bind(this);
    for (const id of this.order) yield* visit(id, 0);
  }

  bounds(selectionOnly = false): AABB {
    const b = new AABB();
    for (const obj of this.objects.values()) {
      if (selectionOnly && !this.selection.has(obj.id)) continue;
      if (!obj.visible) continue;
      b.union(obj.bounds(this));
    }
    return b;
  }

  stats(): { objects: number; verts: number; edges: number; faces: number; tris: number } {
    let verts = 0, edges = 0, faces = 0, tris = 0;
    for (const obj of this.objects.values()) {
      if (!obj.visible) continue;
      const m = obj.evaluated();
      if (!m) continue;
      verts += m.vertCount;
      edges += m.edgeCount;
      faces += m.faceCount;
      tris += m.triCount;
    }
    return { objects: this.objects.size, verts, edges, faces, tris };
  }

  /** Any object in the scene carrying keyframes. */
  animatedObjects(): SceneObject[] {
    return [...this.objects.values()].filter((o) => o.animation.length > 0);
  }

  get hasAnimation(): boolean {
    for (const o of this.objects.values()) if (o.animation.length > 0) return true;
    return false;
  }

  /** Drive every animated object's transform to the given frame. */
  setFrame(frame: number): boolean {
    this.timeline.current = frame;
    let changed = false;
    for (const obj of this.objects.values()) {
      // Strips win where there are any: they are the explicit statement of
      // what plays when, and an object that has been given one has stopped
      // being driven by the keys in the editor.
      if (obj.strips.length && obj.actions.length) {
        if (this.applyStrips(obj, frame)) changed = true;
        continue;
      }
      if (obj.animation.length === 0) continue;
      const sampled = sampleChannels(obj.animation, frame);
      const next = completeTransform(sampled, obj, obj.animation);
      obj.position = next.position;
      obj.rotation = next.rotation;
      obj.scale = next.scale;
      if (this.applyProperties(obj, frame)) obj.invalidate();
      changed = true;
    }
    return changed;
  }

  /**
   * Evaluate an object through its strips.
   *
   * The blend produces a value per component, with NaN where no strip had
   * anything to say — so an axis nothing drives keeps what the person set,
   * exactly as an unkeyed axis does on the direct path.
   */
  private applyStrips(obj: SceneObject, frame: number): boolean {
    const { transform, properties } = splitBlend(blendStrips(obj.strips, obj.actions, frame));
    const put = (target: Vec3, values: number[] | undefined): void => {
      if (!values) return;
      if (!Number.isNaN(values[0])) target.x = values[0];
      if (!Number.isNaN(values[1])) target.y = values[1];
      if (!Number.isNaN(values[2])) target.z = values[2];
    };
    put(obj.position, transform.get('position'));
    put(obj.rotation, transform.get('rotation'));
    put(obj.scale, transform.get('scale'));
    if (properties.size) {
      this.writeProperties(obj, properties);
      obj.invalidate();
    }
    return transform.size > 0 || properties.size > 0;
  }

  /**
   * Drive the non-transform channels: a light dimming, a lens pulling back, a
   * material going matte.
   *
   * A component with no channel is left alone, so keying only the red of a
   * colour does not blank the other two. Materials are shared, so an animated
   * material is animated everywhere it is used — which is what a shared
   * material means, and better than silently giving each object its own copy.
   */
  private applyProperties(obj: SceneObject, frame: number): boolean {
    const sampled = samplePropertyChannels(obj.animation, frame);
    if (sampled.size === 0) return false;
    this.writeProperties(obj, sampled);
    return true;
  }

  /**
   * Put sampled property values where they live.
   *
   * Shared between the direct path and the blended one, because a light's
   * power is written the same way whether one action drove it or three did.
   */
  private writeProperties(obj: SceneObject, sampled: Map<ChannelPath, number[]>): void {
    const put = (target: number[] | undefined, values: number[]): void => {
      if (!target) return;
      for (let i = 0; i < values.length && i < target.length; i++) {
        if (!Number.isNaN(values[i])) target[i] = values[i];
      }
    };
    const material = this.materials[obj.materialSlots[0] ?? 0];
    for (const [path, values] of sampled) {
      const first = values[0];
      switch (path) {
        case 'light.energy':
          if (obj.light && !Number.isNaN(first)) obj.light.energy = first;
          break;
        case 'light.color':
          put(obj.light?.color, values);
          break;
        case 'camera.fov':
          if (obj.camera && !Number.isNaN(first)) obj.camera.fov = first;
          break;
        case 'material.color':
          put(material?.color, values);
          break;
        case 'material.roughness':
          if (material && !Number.isNaN(first)) material.roughness = first;
          break;
        case 'material.metallic':
          if (material && !Number.isNaN(first)) material.metallic = first;
          break;
        case 'material.alpha':
          if (material && !Number.isNaN(first)) material.alpha = first;
          break;
        case 'material.emissionStrength':
          if (material && !Number.isNaN(first)) material.emissionStrength = first;
          break;
        default:
          break;
      }
    }
  }

  /**
   * `meshes` lets a caller reuse serialized mesh data it already holds — undo
   * passes its snapshot store so an untouched mesh is not copied again.
   */
  toJSON(meshes?: { serialize(m: Mesh): ReturnType<Mesh['toJSON']> }): SerializedScene {
    return {
      format: 'The Culp Mixer-scene',
      version: 1,
      nextId: this.nextId,
      world: { ...this.world, background: [...this.world.background] as [number, number, number] },
      cursor: this.cursor.toArray(),
      materials: this.materials.map(cloneMaterial),
      textures: this.textures.map((t) => ({ ...t })),
      timeline: { ...this.timeline, playing: false },
      active: this.active,
      selection: [...this.selection],
      order: [...this.order],
      objects: [...this.objects.values()].map((o) => ({
        id: o.id,
        name: o.name,
        type: o.type,
        position: o.position.toArray(),
        rotation: o.rotation.toArray(),
        scale: o.scale.toArray(),
        visible: o.visible,
        locked: o.locked,
        parent: o.parent,
        children: [...o.children],
        mesh: o.mesh ? (meshes ? meshes.serialize(o.mesh) : o.mesh.toJSON()) : null,
        modifiers: JSON.parse(JSON.stringify(o.modifiers)),
        materialSlots: [...o.materialSlots],
        light: o.light ? { ...o.light, color: [...o.light.color] as [number, number, number] } : null,
        camera: o.camera ? { ...o.camera } : null,
        armature: o.armature ? cloneArmature(o.armature) : null,
        ...(o.actions.length ? { actions: o.actions.map(cloneAction) } : {}),
        ...(o.strips.length ? { strips: o.strips.map(cloneStrip) } : {}),
        physics: o.physics ? { ...o.physics } : null,
        animation: cloneChannels(o.animation),
        provenance: o.provenance ? cloneProvenance(o.provenance) : null,
        partKey: o.partKey,
        protectedFromRegen: o.protectedFromRegen || undefined,
      })),
    };
  }

  /**
   * Rebuild a scene from a document, keeping only what is actually usable.
   *
   * This is the one entry point in the application whose input nobody here
   * wrote. A file arrives truncated by a full disk, half-written by a cloud
   * folder, edited by hand, or produced by a different version — and every
   * one of those used to throw a raw TypeError out of the loader, which took
   * the whole application down rather than reporting a bad file.
   *
   * The rule throughout is the one the modifier stack already follows: check
   * what a field has to be, keep it if it is, drop it if it is not, and never
   * throw. An empty scene is a scene somebody can still work in; a stack
   * trace is not.
   */
  static fromJSON(data: SerializedScene): Scene {
    const doc = (data ?? {}) as Partial<SerializedScene>;
    const s = new Scene();

    const number = (v: unknown, fallback: number): number => (
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    );
    /** A transform component, defaulting per-axis rather than all-or-nothing. */
    const vector = (v: unknown, fallback: number): Vec3 => {
      const a = Array.isArray(v) ? v : [];
      return new Vec3(number(a[0], fallback), number(a[1], fallback), number(a[2], fallback));
    };

    s.nextId = Math.max(1, Math.floor(number(doc.nextId, 1)));
    s.world = { ...s.world, ...(doc.world && typeof doc.world === 'object' ? doc.world : {}) };
    s.cursor = vector(doc.cursor, 0);
    s.materials = (Array.isArray(doc.materials) ? doc.materials : [])
      .filter((m) => m && typeof m === 'object')
      .map(cloneMaterial);
    // A document is untrusted input. Only self-contained images are loaded;
    // anything pointing off the machine is dropped and reported, because an
    // <img> src is a network request and a project file is a thing people
    // share.
    const accepted = acceptTextures(doc.textures);
    s.textures = accepted.textures;
    s.rejectedTextures = accepted.rejected;
    s.timeline = {
      ...defaultTimeline(),
      ...(doc.timeline && typeof doc.timeline === 'object' ? doc.timeline : {}),
      playing: false,
    };
    for (const t of s.textures) reserveTextureId(t.id);
    s.order = (Array.isArray(doc.order) ? doc.order : []).filter((id) => Number.isInteger(id));

    for (const raw of Array.isArray(doc.objects) ? doc.objects : []) {
      if (!raw || typeof raw !== 'object') continue;
      const od = raw as Partial<SerializedObject>;
      // An object with no usable id cannot be referenced, parented or
      // selected, so there is nothing to salvage.
      if (!Number.isInteger(od.id)) continue;
      const o = new SceneObject(
        od.id as number,
        typeof od.name === 'string' ? od.name : 'Object',
        od.type ?? 'mesh',
      );
      o.owner = s;
      o.position = vector(od.position, 0);
      o.rotation = vector(od.rotation, 0);
      // Scale defaults to one: a zero there would make the object invisible
      // and its matrix singular.
      o.scale = vector(od.scale, 1);
      o.visible = od.visible !== false;
      o.locked = !!od.locked;
      o.parent = Number.isInteger(od.parent) ? (od.parent as number) : null;
      o.children = (Array.isArray(od.children) ? od.children : []).filter((id) => Number.isInteger(id));
      o.mesh = od.mesh && typeof od.mesh === 'object' ? Mesh.fromJSON(od.mesh) : null;
      // Each modifier is checked and completed rather than trusted; anything
      // unrecognisable is dropped instead of carried.
      o.modifiers = (Array.isArray(od.modifiers) ? od.modifiers : [])
        .map((m) => normaliseModifier(m))
        .filter((m): m is Modifier => m !== null);
      o.materialSlots = (Array.isArray(od.materialSlots) ? od.materialSlots : [])
        .filter((i) => Number.isInteger(i) && i >= 0);
      o.light = od.light && typeof od.light === 'object' ? od.light : null;
      o.camera = od.camera && typeof od.camera === 'object' ? od.camera : null;
      o.armature = od.armature && typeof od.armature === 'object' ? cloneArmature(od.armature) : null;
      o.actions = cloneActions(od.actions);
      // A strip pointing at an action that is not in the file would evaluate
      // to nothing for ever, so it is dropped on the way in rather than kept
      // as a row in the panel that does nothing.
      const known = new Set(o.actions.map((a) => a.id));
      o.strips = cloneStrips(od.strips).filter((st) => known.has(st.action));
      o.physics = od.physics && typeof od.physics === 'object' ? { ...od.physics } : null;
      o.animation = sanitiseChannels(od.animation);
      // Absent in every file written before revisions existed, and absent on
      // anything modelled by hand. Both are ordinary.
      o.provenance = normaliseProvenance(od.provenance);
      o.partKey = typeof od.partKey === 'string' && od.partKey ? od.partKey : null;
      o.protectedFromRegen = od.protectedFromRegen === true;
      s.objects.set(o.id, o);
      s.nextId = Math.max(s.nextId, o.id + 1);
    }

    // Parent and child links that point nowhere would leave objects
    // unreachable in the outliner and loop forever in a world-matrix walk.
    for (const o of s.objects.values()) {
      if (o.parent !== null && !s.objects.has(o.parent)) o.parent = null;
      if (o.parent === o.id) o.parent = null;
      o.children = o.children.filter((id) => id !== o.id && s.objects.has(id));
    }
    // A parent cycle is not repairable by filtering alone; walk up from each
    // object and cut the link that closes the loop.
    for (const o of s.objects.values()) {
      const seen = new Set<number>([o.id]);
      let cursor = o;
      while (cursor.parent !== null) {
        if (seen.has(cursor.parent)) { cursor.parent = null; break; }
        seen.add(cursor.parent);
        const next = s.objects.get(cursor.parent);
        if (!next) { cursor.parent = null; break; }
        cursor = next;
      }
    }

    // A child that its parent does not list is unreachable: the outliner walks
    // down from the roots, so it would be in the file and nowhere on screen.
    for (const o of s.objects.values()) {
      if (o.parent === null) continue;
      const parent = s.objects.get(o.parent);
      if (parent && !parent.children.includes(o.id)) parent.children.push(o.id);
    }
    // `order` is the top level only — a parented object is reached through its
    // parent. Keeping children here as well listed every one of them twice in
    // the outliner, once nested and once at the root, from the moment a scene
    // with any hierarchy was saved and reopened.
    const top = (id: number): boolean => s.objects.get(id)?.parent === null;
    const seen = new Set<number>();
    s.order = s.order.filter((id) => {
      if (!s.objects.has(id) || !top(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    for (const id of s.objects.keys()) {
      if (top(id) && !seen.has(id)) {
        seen.add(id);
        s.order.push(id);
      }
    }
    s.selection = new Set(
      (Array.isArray(doc.selection) ? doc.selection : []).filter((id) => s.objects.has(id)),
    );
    s.active = Number.isInteger(doc.active) && s.objects.has(doc.active as number)
      ? (doc.active as number)
      : null;
    return s;
  }
}

/**
 * Animation channels from a document, keeping only the keys that are keys.
 *
 * A channel whose keys are missing, null, or not an array is not something to
 * interpolate; a key with a non-finite frame or value would put NaN into a
 * transform the moment the playhead reached it.
 */
function sanitiseChannels(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) return [];
  const out: Channel[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const channel = c as Partial<Channel>;
    if (typeof channel.path !== 'string') continue;
    if (!Number.isInteger(channel.index) || (channel.index as number) < 0) continue;
    if (!Array.isArray(channel.keys)) continue;
    const keys = channel.keys
      .filter((k) => k && typeof k === 'object'
        && Number.isFinite((k as { frame: number }).frame)
        && Number.isFinite((k as { value: number }).value))
      .map((k) => ({ ...(k as object) })) as Channel['keys'];
    if (keys.length === 0) continue;
    keys.sort((a, b) => a.frame - b.frame);
    out.push({ path: channel.path, index: channel.index as number, keys });
  }
  return out;
}

export interface SerializedObject {
  id: number;
  name: string;
  type: ObjectType;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  locked: boolean;
  parent: number | null;
  children: number[];
  mesh: ReturnType<Mesh['toJSON']> | null;
  modifiers: Modifier[];
  materialSlots: number[];
  light: LightData | null;
  camera: CameraData | null;
  armature?: ArmatureData | null;
  actions?: Action[];
  strips?: Strip[];
  physics?: PhysicsBody | null;
  animation?: Channel[];
  /** How a generated asset was made; absent on everything else. */
  provenance?: Provenance | null;
  /** Which generated part a child is; absent on user-added objects. */
  partKey?: string | null;
  /** Held back from regeneration; absent when it is not. */
  protectedFromRegen?: boolean;
}

export interface SerializedScene {
  format: string;
  version: number;
  nextId: number;
  world: WorldSettings;
  cursor: [number, number, number];
  materials: Material[];
  textures?: SceneTexture[];
  timeline?: TimelineSettings;
  active: number | null;
  selection: number[];
  order: number[];
  objects: SerializedObject[];
}
