import { Mesh } from '../mesh/Mesh';
import { SerializedObject, SerializedScene } from '../scene/Scene';
import { SelectMode } from '../render/Renderer';

export type SerializedMesh = ReturnType<Mesh['toJSON']>;

export interface EditorSnapshot {
  label: string;
  scene: SerializedScene;
  mode: 'object' | 'edit' | 'sculpt';
  editObject: number | null;
  selectMode: SelectMode;
  verts: number[];
  edges: number[];
  faces: number[];
  /**
   * Anything that will only be approximate once this state is restored.
   *
   * Some reconstructions cannot be exact — lifting a rotated object out from
   * under a non-uniformly scaled parent has no exact answer in position,
   * rotation and scale. When such a reconstruction is *stored* rather than
   * applied, saying so at the time it was computed would warn about something
   * that has not happened; the warning belongs to whoever restores it, so it
   * travels here and is delivered then.
   */
  warnings?: string[];
}

/**
 * Serialized mesh data, shared between snapshots.
 *
 * Snapshot undo is worth keeping — it makes every operator undoable without
 * writing a matching inverse for each one — but copying every mesh in the
 * scene on every edit is not. Editing one object in a scene of twenty used to
 * copy all twenty, and sixty-four times over as the history filled up.
 *
 * A mesh's serialized form only changes when the mesh does, and `revision`
 * already tracks that. So serialize once per revision and let every snapshot
 * point at the same frozen blob: work becomes proportional to what the edit
 * touched, and an untouched mesh costs one copy no matter how deep the history
 * goes. Sharing is safe because nothing mutates a blob — `Mesh.fromJSON`
 * rebuilds every array on the way back out.
 */
export class SnapshotStore {
  private byMesh = new WeakMap<Mesh, { revision: number; data: SerializedMesh }>();
  private bytes = new WeakMap<object, number>();

  serialize(mesh: Mesh): SerializedMesh {
    const hit = this.byMesh.get(mesh);
    if (hit && hit.revision === mesh.revision) return hit.data;
    const data = mesh.toJSON();
    this.byMesh.set(mesh, { revision: mesh.revision, data });
    this.bytes.set(data, estimateMeshBytes(data));
    return data;
  }

  /** Roughly how much memory a shared blob holds, for the history budget. */
  sizeOf(data: object): number {
    return this.bytes.get(data) ?? 0;
  }
}

function estimateMeshBytes(d: SerializedMesh): number {
  let n = d.positions.length * 8;
  for (const f of d.faces) n += f.length * 8 + 32;
  n += d.faceMaterial.length * 8;
  if (d.faceSmooth) n += d.faceSmooth.length;
  if (d.faceUV) for (const uv of d.faceUV) if (uv) n += uv.length * 8 + 32;
  if (d.seams) n += d.seams.length * 24;
  if (d.edgeWeights) n += d.edgeWeights.length * 32;
  // Three attributes the estimate used to walk straight past, and they are not
  // small: skin weights are eight numbers per vertex and are usually the
  // largest thing on a rigged character, painted colour is three, a sculpt
  // mask is one. A budget that ignores them is a budget that lets a rigged,
  // painted, sculpted project — exactly the kind that needs the limit — grow
  // several times past it before anything is dropped.
  if (d.skin) n += (d.skin.bones.length + d.skin.weights.length) * 8;
  if (d.colors) n += d.colors.length * 8;
  if (d.mask) n += d.mask.length * 8;
  return n;
}

/**
 * Roughly what a string costs to hold, in bytes.
 *
 * Two per character is the usual figure for a JavaScript string, and these are
 * base64 data URLs — a photograph embedded in the document, or a depth map
 * encoded beside it — which is the one place in a scene where the numbers get
 * genuinely large.
 */
function stringBytes(s: string): number {
  return s.length * 2;
}

/** What one object's record costs beyond its mesh. */
function estimateObjectExtras(o: SerializedObject, seen: Set<object>): number {
  let n = 0;
  // Provenance carries a baseline, and a baseline carries a serialized mesh
  // per part — a full copy of the asset's geometry as the generator last made
  // it. For a model built from a photograph it also carries the encoded depth
  // map, which is a few hundred kilobytes on its own. None of that was counted.
  const prov = o.provenance as unknown as Record<string, unknown> | null | undefined;
  if (prov && !seen.has(prov)) {
    seen.add(prov);
    const baseline = prov.baseline as
      { parts?: { mesh?: SerializedMesh | null }[]; mesh?: SerializedMesh | null } | undefined;
    for (const part of baseline?.parts ?? []) {
      if (part.mesh) n += estimateMeshBytes(part.mesh);
    }
    // A single-mesh baseline — what a reference-derived asset records — is the
    // same copy of the geometry under a different key.
    if (baseline?.mesh) n += estimateMeshBytes(baseline.mesh);
    const params = prov.params as Record<string, unknown> | undefined;
    for (const value of Object.values(params ?? {})) {
      if (typeof value === 'string') n += stringBytes(value);
    }
    if (typeof prov.code === 'string') n += stringBytes(prov.code);
  }
  for (const channel of o.animation ?? []) {
    // A key is a small object; the count is what matters on a baked
    // simulation, where every frame of every axis is one.
    n += channel.keys.length * 48;
  }
  return n;
}

/**
 * Snapshot-based undo, bounded by memory rather than by a step count alone.
 *
 * A count on its own is the wrong limit: sixty-four steps of moving a cube is
 * nothing, and sixty-four steps on a subdivided character is hundreds of
 * megabytes. Both limits apply, and the memory one counts each shared blob
 * once however many snapshots reference it.
 */
export class History {
  readonly store = new SnapshotStore();
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];

  constructor(public limit = 64, public budgetBytes = 256 * 1024 * 1024) {}

  /** Record the state *before* an edit. */
  push(snapshot: EditorSnapshot): void {
    this.undoStack.push(snapshot);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    // Always keep one step: undoing the thing you just did matters more than
    // the budget, and a single snapshot over budget is the user's own scene.
    while (this.undoStack.length > 1 && this.footprint() > this.budgetBytes) {
      this.undoStack.shift();
    }
  }

  /**
   * Bytes held by the history, counting each shared thing once.
   *
   * "Once" is the hard part and the reason this is not simply a walk. A mesh
   * blob is shared between every snapshot that did not change it — that is the
   * whole point of the store — so counting it per snapshot would report a
   * scene as tens of times larger than it is. The same is true of an embedded
   * texture: `toJSON` gives each snapshot its own wrapper object but the data
   * URL inside it is one string, shared by reference, so the dedup has to be
   * on the string rather than on the object holding it.
   *
   * What is *not* shared is counted per snapshot, because it genuinely exists
   * per snapshot.
   */
  footprint(): number {
    const seen = new Set<object>();
    const seenText = new Set<string>();
    let total = 0;
    for (const stack of [this.undoStack, this.redoStack]) {
      for (const snap of stack) {
        for (const o of snap.scene.objects as SerializedObject[]) {
          if (o.mesh && !seen.has(o.mesh)) {
            seen.add(o.mesh);
            total += this.store.sizeOf(o.mesh);
          }
          total += estimateObjectExtras(o, seen);
        }
        // Embedded images. A scene built from a photograph keeps the
        // photograph inside it, which is usually larger than all its geometry
        // put together, and none of it was being counted at all.
        for (const t of snap.scene.textures ?? []) {
          const url = (t as { url?: string }).url;
          if (typeof url !== 'string' || seenText.has(url)) continue;
          seenText.add(url);
          total += stringBytes(url);
        }
      }
    }
    return total;
  }

  undo(current: EditorSnapshot): EditorSnapshot | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(current);
    return s;
  }

  redo(current: EditorSnapshot): EditorSnapshot | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(current);
    return s;
  }

  get depth(): number {
    return this.undoStack.length;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get nextUndoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }
  get nextRedoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }

  /**
   * The recorded steps, newest last, for anything that wants to look back
   * rather than travel back.
   *
   * Comparing against an earlier version needs to *read* a snapshot without
   * unwinding to it, which undo cannot do — it pops. The scenes handed out
   * here are the stored ones, so callers must treat them as read-only.
   */
  steps(): { index: number; label: string; scene: SerializedScene }[] {
    return this.undoStack.map((s, index) => ({ index, label: s.label, scene: s.scene }));
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
