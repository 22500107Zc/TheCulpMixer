import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PRIMITIVES } from '../mesh/primitives';
import {
  deleteEdges, deleteFaces, deleteVertices, dissolveFaces, duplicateFaces, extrudeEdges,
  extrudeFaces, facesToVerts, flipNormals, makeFace, mergeByDistance, mergeVertices,
  recalculateNormals, smoothVertices, subdivideFaces, triangulateFaces,
} from '../mesh/ops';
import { Scene, SceneObject, createPhysicsBody } from '../scene/Scene';
import { assetRootFor } from './revision';
import { bevelVertices, markBevelWeight } from '../mesh/bevel';
import { voxelRemesh, voxelSizeForTarget } from '../mesh/remesh';
import { BooleanOp, dissolveCoplanar, isSolid, meshBoolean, stitchTJunctions } from '../mesh/boolean';
import { bisect, bridgeLoops, pokeFaces, spinEdges, symmetrize } from '../mesh/modeling';
import { decimate } from '../mesh/decimate';
import {
  cubeProject, cylinderProject, markSeams, planarProject, smartProject, sphereProject, unwrap,
} from '../uv/unwrap';
import { blankTexture, generateCheckerTexture, loadTextureFile } from '../scene/Texture';
import { bakeToKeyframes, clearBake } from '../physics/bake';
import { FALLOFF_LABELS, FalloffType } from './proportional';
import { SNAP_LABELS, SnapMode } from './snapping';
import { BRUSH_LABELS, SculptBrush } from '../sculpt/sculpt';
import { pickFile } from '../io/files';
import { preserveUV, transferUV } from '../uv/transfer';
import {
  describeExport, describeSave, openTextFile, saveAll, saveBinary, saveText, saveWorked,
} from '../io/files';
import { askUnsaved } from '../ui/UnsavedDialog';
import { MTL_FILENAME, exportMTL, exportOBJ, importOBJ, texturesForMTL } from '../io/obj';
import { exportSTL } from '../io/stl';
import { exportGLTF } from '../io/gltf';
import { Editor, EditorMode } from './Editor';
import { pruneSelection } from './selection';

export interface Command {
  id: string;
  label: string;
  category: 'File' | 'Edit' | 'Add' | 'Object' | 'Mesh' | 'Rig' | 'Select' | 'View' | 'Help';
  shortcut?: string;
  /** Which mode the command applies to; omitted means every mode. */
  mode?: EditorMode;
  /** Return value is ignored; commands may return anything convenient. */
  run: (editor: Editor) => unknown;
  enabled?: (editor: Editor) => boolean;
  /**
   * True for operators that add geometry, which are the ones held to the face
   * budget. Operators that shrink a mesh are deliberately never marked, so a
   * mesh that somehow got over the budget can always be brought back down.
   */
  grows?: boolean;
}

const hasEditSelection = (ed: Editor): boolean => ed.mode === 'edit' && ed.selection.verts.size > 0;
const hasObjectSelection = (ed: Editor): boolean => ed.scene.selection.size > 0;

/**
 * The largest mesh an edit-mode operator is allowed to produce.
 *
 * Subdivision multiplies a mesh by four every time it runs, so a few
 * absent-minded presses take a cube past anything a browser tab can hold. The
 * numbers are worth being concrete about: on a sphere, the fifth subdivision
 * reaches half a million faces and takes about seven seconds, and the sixth
 * reaches two million and takes nearly half a minute — half a minute during
 * which the tab is frozen, nothing on screen has changed, and the natural
 * response is to press the key again.
 *
 * The budget sits above any mesh someone models by hand and below the size
 * where the tab is in danger, so the operator that would cross it is refused
 * with a message instead of taking an hour of unsaved work down with it.
 */
/**
 * The bytes behind a `data:` URL, or null if it is not one.
 *
 * Textures are stored as data URLs so a saved scene is self-contained; writing
 * one beside an .obj means turning it back into a file.
 */
function dataUrlToBytes(url: string): ArrayBuffer | null {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) return null;
  if (!url.slice(0, comma).includes(';base64')) return null;
  try {
    const binary = atob(url.slice(comma + 1));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
  } catch {
    return null;
  }
}

export const MAX_EDITABLE_FACES = 1_000_000;

/**
 * Refuse an operator that would push the mesh past what the tab can hold.
 *
 * Returns true when there is room. The caller does nothing else on false: the
 * status line already explains what happened and what to do about it.
 */
function withinFaceBudget(ed: Editor, predicted: number, label: string): boolean {
  if (predicted <= MAX_EDITABLE_FACES) return true;
  const millions = (predicted / 1e6).toFixed(1);
  ed.setStatus(
    `${label} would make ${millions}M faces, past the ${MAX_EDITABLE_FACES / 1e6}M limit — ` +
    'select fewer faces, or add a Subdivision Surface modifier instead of subdividing the mesh',
  );
  return false;
}

/** How many faces subdividing this selection would leave behind. */
export function facesAfterSubdivide(mesh: Mesh, faces: Iterable<number>): number {
  let total = mesh.faces.length;
  for (const f of faces) {
    const loop = mesh.faces[f];
    if (!loop) continue;
    // Each selected face becomes one quad per corner.
    total += loop.length - 1;
  }
  return total;
}

/** Run an edit-mode mesh operation with undo and cache invalidation handled. */
function editOp(ed: Editor, label: string, fn: (mesh: Mesh) => void): void {
  const obj = ed.editObject;
  const mesh = ed.editMesh;
  if (!obj || !mesh) return;
  if (!ed.beginUndo(label)) return;
  // Anything the operator cannot carry exactly is resampled off the pre-edit
  // surface, so an unwrapped model survives being modelled on.
  preserveUV(mesh, () => fn(mesh));
  // Indices shift under most operators; drop anything that no longer exists.
  pruneSelection(mesh, ed.selection);
  ed.syncSelection('vertex');
  ed.markGeometryDirty(obj);
  ed.setStatus(label);
}

function objectOp(ed: Editor, label: string, fn: (scene: Scene) => void): void {
  if (!ed.beginUndo(label)) return;
  fn(ed.scene);
  for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
  ed.emit('change');
  ed.requestRender();
  ed.setStatus(label);
}

/**
 * Ask before an action that loses the current document.
 *
 * Returns false when the person backed out, so the caller does nothing at all.
 * A save that is itself cancelled or fails also counts as backing out: the
 * whole point of pressing Save here was to keep the work, and carrying on
 * regardless would throw away exactly what they asked to protect.
 */
async function okToReplaceDocument(ed: Editor, action: string): Promise<boolean> {
  if (!ed.hasUnsavedChanges) return true;
  const answer = await askUnsaved(action);
  if (answer === 'cancel') {
    ed.setStatus('Cancelled — nothing was changed.');
    return false;
  }
  if (answer === 'discard') return true;
  const outcome = await saveText(
    'scene.kline', JSON.stringify(ed.scene.toJSON(), null, 1), 'application/json',
  );
  if (!saveWorked(outcome)) {
    ed.setStatus(`${describeSave(outcome, 'scene.kline')} — your project is untouched.`);
    return false;
  }
  ed.markSaved();
  return true;
}

export const COMMANDS: Command[] = [
  // ------------------------------------------------------------------- File
  {
    id: 'file.new', label: 'New Scene', category: 'File',
    run: async (ed) => {
      if (!await okToReplaceDocument(ed, 'Starting a new scene will replace them.')) return;
      if (!ed.beginUndo('New scene')) return;
      ed.newScene();
      ed.setStatus('New scene');
    },
  },
  {
    id: 'file.save', label: 'Save Scene (.kline)', category: 'File', shortcut: 'Ctrl+S',
    run: async (ed) => {
      // Saving mid-preview would write a proposal into the file as though it
      // were the model. Said out loud rather than silently written: the
      // proposal is on screen, so nothing about the file looks wrong until it
      // is reopened somewhere else.
      if (ed.revision.active) {
        ed.setStatus('A revision is waiting — accept or reject it before saving, or the file will hold the preview');
        return;
      }
      ed.setStatus('Saving scene.kline…');
      const outcome = await saveText(
        'scene.kline', JSON.stringify(ed.scene.toJSON(), null, 1), 'application/json',
      );
      ed.setStatus(describeSave(outcome, 'scene.kline'));
      // Only a save that actually happened clears the document. Marking it
      // clean on a cancel is how somebody ends up closing over their work
      // having been told it was safe.
      if (saveWorked(outcome)) ed.markSaved();
    },
  },
  {
    id: 'file.open', label: 'Open Scene (.kline)', category: 'File', shortcut: 'Ctrl+O',
    run: async (ed) => {
      if (!await okToReplaceDocument(ed, 'Opening another project will replace them.')) return;
      const file = await openTextFile('.kline,.kiln,application/json');
      if (!file) return;
      try {
        ed.loadSceneJSON(JSON.parse(file.text));
        ed.setStatus(`Opened ${file.name}`);
      } catch (err) {
        ed.setStatus(`Could not open ${file.name}: ${(err as Error).message}`);
      }
    },
  },
  {
    id: 'file.importObj', label: 'Import OBJ', category: 'File',
    run: async (ed) => {
      const file = await openTextFile('.obj');
      if (!file) return;
      const objects = importOBJ(file.text);
      if (objects.length === 0) {
        ed.setStatus('No geometry found in that OBJ');
        return;
      }
      objectOp(ed, 'Import OBJ', (scene) => {
        scene.selection.clear();
        for (const o of objects) {
          const added = scene.add('mesh', o.name, o.mesh);
          scene.selection.add(added.id);
          scene.active = added.id;
        }
      });
      ed.setStatus(`Imported ${objects.length} object(s) from ${file.name}`);
    },
  },
  {
    id: 'file.exportObj', label: 'Export OBJ', category: 'File',
    run: async (ed) => {
      // One export, several files. MTL can only name an image sitting next to
      // it, so the images have to come out too; glTF embeds them and needs
      // none of this. They go out in order and the first refusal stops the
      // rest — a .obj whose .mtl was cancelled is not a partial success, it is
      // a model that opens grey.
      const files: { filename: string; text?: string; bytes?: ArrayBuffer; mime?: string }[] = [
        { filename: 'scene.obj', text: exportOBJ(ed.scene), mime: 'text/plain' },
        { filename: MTL_FILENAME, text: exportMTL(ed.scene), mime: 'text/plain' },
      ];
      for (const t of texturesForMTL(ed.scene)) {
        const bytes = dataUrlToBytes(t.url);
        if (bytes) files.push({ filename: t.filename, bytes, mime: 'image/png' });
      }
      ed.setStatus(`Exporting ${files.length} file(s)…`);
      ed.setStatus(describeExport(await saveAll(files), files.length));
    },
  },
  {
    id: 'file.exportStl', label: 'Export STL', category: 'File',
    run: async (ed) => {
      ed.setStatus(describeSave(
        await saveBinary('scene.stl', exportSTL(ed.scene), 'model/stl'), 'scene.stl',
      ));
    },
  },
  {
    id: 'file.exportGltf', label: 'Export glTF', category: 'File',
    run: async (ed) => {
      const { json, warnings } = exportGLTF(ed.scene);
      const outcome = await saveText('scene.gltf', json, 'model/gltf+json');
      // Anything the format could not carry is said here rather than left for
      // somebody to discover in another application.
      const note = warnings.length ? ` — ${warnings.join('; ')}` : '';
      ed.setStatus(describeSave(outcome, 'scene.gltf') + (saveWorked(outcome) ? note : ''));
    },
  },

  // ------------------------------------------------------------------- Edit
  { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', run: (ed) => ed.undo() },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: 'Ctrl+Shift+Z', run: (ed) => ed.redo() },
  {
    id: 'edit.toggleMode', label: 'Toggle Edit Mode', category: 'Edit', shortcut: 'Tab',
    run: (ed) => ed.toggleEditMode(),
  },

  // -------------------------------------------------------------------- Add
  ...PRIMITIVES.map((p): Command => ({
    id: `add.${p.kind}`,
    label: p.label,
    category: 'Add',
    mode: 'object',
    run: (ed) => ed.addPrimitive(p.kind),
  })),
  { id: 'add.light.point', label: 'Point Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('point') },
  { id: 'add.light.sun', label: 'Sun', category: 'Add', mode: 'object', run: (ed) => ed.addLight('sun') },
  { id: 'add.light.spot', label: 'Spot Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('spot') },
  { id: 'add.light.area', label: 'Area Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('area') },
  { id: 'add.camera', label: 'Camera', category: 'Add', mode: 'object', run: (ed) => ed.addCamera() },
  { id: 'add.empty', label: 'Empty', category: 'Add', mode: 'object', run: (ed) => ed.addEmpty() },
  { id: 'add.armature', label: 'Armature', category: 'Add', mode: 'object', run: (ed) => ed.addArmature() },

  // ---------------------------------------------------------------- Rigging
  {
    id: 'rig.extrudeBone', label: 'Add Bone', category: 'Rig', mode: 'object',
    run: (ed) => ed.extrudeBone(),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.bind', label: 'Bind to Armature (automatic weights)', category: 'Rig', mode: 'object',
    run: (ed) => ed.bindToArmature(),
    enabled: (ed) => !!ed.activeArmature && ed.scene.selection.size >= 2,
  },
  {
    id: 'rig.clearPose', label: 'Clear Pose', category: 'Rig', mode: 'object',
    run: (ed) => ed.clearArmaturePose(),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.nextBone', label: 'Next Bone', category: 'Rig',
    run: (ed) => {
      const rig = ed.activeArmature;
      if (!rig?.armature || rig.armature.bones.length === 0) return;
      ed.activeBone = (ed.activeBone + 1) % rig.armature.bones.length;
      ed.setStatus(`Active bone: ${rig.armature.bones[ed.activeBone].name}`);
      ed.emit('change');
      ed.requestRender();
    },
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addIK', label: 'Add IK Constraint to Active Bone', category: 'Rig', mode: 'object',
    run: (ed) => ed.addBoneConstraint('ik'),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addCopyRotation', label: 'Add Copy Rotation Constraint', category: 'Rig', mode: 'object',
    run: (ed) => ed.addBoneConstraint('copyRotation'),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addCopyLocation', label: 'Add Copy Location Constraint', category: 'Rig', mode: 'object',
    run: (ed) => ed.addBoneConstraint('copyLocation'),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addTrackTo', label: 'Add Track To Constraint', category: 'Rig', mode: 'object',
    run: (ed) => ed.addBoneConstraint('trackTo'),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addLimitRotation', label: 'Add Rotation Limit', category: 'Rig', mode: 'object',
    run: (ed) => ed.addBoneConstraint('limitRotation'),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.addControlBone', label: 'Add Control Bone (unparented target)', category: 'Rig', mode: 'object',
    run: (ed) => ed.addControlBone(),
    enabled: (ed) => !!ed.activeArmature,
  },

  // ------------------------------------------------------------------ Anim
  {
    id: 'anim.stashAction', label: 'Stash Keys as an Action', category: 'Object', mode: 'object',
    run: (ed) => ed.stashAction(),
    enabled: (ed) => (ed.scene.activeObject?.animation.length ?? 0) > 0,
  },
  {
    id: 'anim.addStrip', label: 'Add Strip for an Action', category: 'Object', mode: 'object',
    run: (ed) => ed.addStrip(),
    enabled: (ed) => (ed.scene.activeObject?.actions.length ?? 0) > 0,
  },
  {
    id: 'anim.clearStrips', label: 'Remove All Strips', category: 'Object', mode: 'object',
    run: (ed) => ed.clearStrips(),
    enabled: (ed) => (ed.scene.activeObject?.strips.length ?? 0) > 0,
  },

  // ----------------------------------------------------------------- Select
  { id: 'select.all', label: 'Select All', category: 'Select', shortcut: 'A', run: (ed) => ed.selectAll() },
  { id: 'select.none', label: 'Deselect All', category: 'Select', shortcut: 'Alt+A', run: (ed) => ed.deselectAll() },
  { id: 'select.invert', label: 'Invert Selection', category: 'Select', shortcut: 'Ctrl+I', run: (ed) => ed.invertSelection() },
  {
    id: 'select.vertex', label: 'Vertex Select', category: 'Select', shortcut: '1', mode: 'edit',
    run: (ed) => ed.setSelectMode('vertex'),
  },
  {
    id: 'select.edge', label: 'Edge Select', category: 'Select', shortcut: '2', mode: 'edit',
    run: (ed) => ed.setSelectMode('edge'),
  },
  {
    id: 'select.face', label: 'Face Select', category: 'Select', shortcut: '3', mode: 'edit',
    run: (ed) => ed.setSelectMode('face'),
  },
  {
    id: 'select.linked', label: 'Select Linked', category: 'Select', shortcut: 'Ctrl+L', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const mesh = ed.editMesh;
      if (!mesh) return;
      const t = mesh.topology();
      const stack = [...ed.selection.verts];
      const seen = new Set(stack);
      while (stack.length) {
        const v = stack.pop()!;
        for (const ei of t.vertEdges[v] ?? []) {
          const e = t.edges[ei];
          const other = e.a === v ? e.b : e.a;
          if (!seen.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
      ed.selection.verts = seen;
      ed.syncSelection('vertex');
      ed.setStatus(`Selected linked (${seen.size} vertices)`);
    },
  },

  // ------------------------------------------------------------- Transforms
  { id: 'transform.move', label: 'Move', category: 'Object', shortcut: 'G', run: (ed) => ed.startTransform('translate') },
  { id: 'transform.rotate', label: 'Rotate', category: 'Object', shortcut: 'R', run: (ed) => ed.startTransform('rotate') },
  { id: 'transform.scale', label: 'Scale', category: 'Object', shortcut: 'S', run: (ed) => ed.startTransform('scale') },

  // ----------------------------------------------------------------- Object
  {
    id: 'object.delete', label: 'Delete', category: 'Object', mode: 'object', shortcut: 'X',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Delete objects', (scene) => {
      for (const id of [...scene.selection]) scene.remove(id);
      scene.selection.clear();
      scene.active = null;
    }),
  },
  {
    id: 'object.duplicate', label: 'Duplicate', category: 'Object', mode: 'object', shortcut: 'Shift+D',
    enabled: hasObjectSelection,
    run: (ed) => {
      if (!ed.beginUndo('Duplicate objects', true)) return;
      const scene = ed.scene;
      const copies: number[] = [];
      // Selecting a child as well as its parent would otherwise copy it twice:
      // once in its own right and once inside the parent's subtree.
      const chosen = new Set(scene.selection);
      const nested = (o: SceneObject): boolean => {
        let p = o.parent;
        let guard = 0;
        while (p !== null && guard++ < 64) {
          if (chosen.has(p)) return true;
          p = scene.get(p)?.parent ?? null;
        }
        return false;
      };
      for (const src of scene.selectedObjects()) {
        if (nested(src)) continue;
        const copy = scene.duplicateObject(src.id, src.parent);
        if (copy) copies.push(copy.id);
      }
      scene.selection = new Set(copies);
      scene.active = copies[copies.length - 1] ?? null;
      ed.emit('change');
      ed.startTransform('translate', null, false);
    },
  },
  {
    id: 'object.join', label: 'Join', category: 'Object', mode: 'object', shortcut: 'Ctrl+J',
    enabled: (ed) => ed.scene.selection.size > 1,
    run: (ed) => objectOp(ed, 'Join objects', (scene) => {
      const active = scene.activeObject;
      if (!active || !active.mesh) return;
      const targetInverse = active.worldMatrix(scene).inverse();
      for (const src of scene.selectedObjects()) {
        if (src.id === active.id || !src.mesh) continue;
        const geo = src.mesh.clone();
        geo.transform(targetInverse.multiply(src.worldMatrix(scene)));
        const slotOffset = active.materialSlots.length;
        for (const s of src.materialSlots) active.materialSlots.push(s);
        active.mesh.append(geo, slotOffset);
        scene.remove(src.id);
      }
      active.invalidate();
      scene.selection = new Set([active.id]);
      scene.active = active.id;
    }),
  },
  {
    id: 'object.applyTransform', label: 'Apply Transform', category: 'Object', mode: 'object',
    shortcut: 'Ctrl+A', enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Apply transform', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        obj.mesh.transform(obj.matrix());
        obj.position = new Vec3();
        obj.rotation = new Vec3();
        obj.scale = new Vec3(1, 1, 1);
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.originToGeometry', label: 'Origin to Geometry', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Origin to geometry', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        const c = obj.mesh.bounds().center();
        obj.mesh.transform(Mat4.translation(c.neg()));
        obj.position = obj.position.add(obj.matrix().transformDirection(c));
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.originToCursor', label: 'Origin to 3D Cursor', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Origin to cursor', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        const localCursor = obj.worldMatrix(scene).inverse().transformPoint(scene.cursor);
        obj.mesh.transform(Mat4.translation(localCursor.neg()));
        obj.position = scene.cursor.clone();
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.shadeSmooth', label: 'Shade Smooth', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Shade smooth', (scene) => {
      for (const o of scene.selectedObjects()) o.mesh?.setAllSmooth(true);
    }),
  },
  {
    id: 'object.shadeFlat', label: 'Shade Flat', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Shade flat', (scene) => {
      for (const o of scene.selectedObjects()) o.mesh?.setAllSmooth(false);
    }),
  },
  {
    id: 'object.hide', label: 'Hide Selected', category: 'Object', mode: 'object', shortcut: 'H',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Hide', (scene) => {
      for (const o of scene.selectedObjects()) o.visible = false;
    }),
  },
  {
    id: 'object.unhide', label: 'Show All', category: 'Object', mode: 'object', shortcut: 'Alt+H',
    run: (ed) => objectOp(ed, 'Show all', (scene) => {
      for (const o of scene.objects.values()) o.visible = true;
    }),
  },

  // ------------------------------------------------------------------- Mesh
  {
    id: 'mesh.extrude', label: 'Extrude Region', category: 'Mesh', mode: 'edit', shortcut: 'E', grows: true,
    enabled: hasEditSelection,
    run: (ed) => {
      const obj = ed.editObject;
      const mesh = ed.editMesh;
      if (!obj || !mesh) return;
      if (!ed.beginUndo('Extrude')) return;
      if (ed.selection.faces.size > 0) {
        const r = extrudeFaces(mesh, ed.selection.faces);
        ed.selection.verts = new Set(r.movedVerts);
        ed.syncSelection('vertex');
        ed.markGeometryDirty(obj);
        ed.startTransform('translate', null, false);
        const world = obj.worldMatrix(ed.scene).normalMatrix().transformDirection(r.normal);
        ed.currentTransform?.constrainTo(world, 'normal');
        ed.refreshTransform();
      } else if (ed.selection.edges.size > 0) {
        const moved = extrudeEdges(mesh, ed.selection.edges);
        ed.selection.verts = new Set(moved);
        ed.syncSelection('vertex');
        ed.markGeometryDirty(obj);
        ed.startTransform('translate', null, false);
      } else {
        ed.setStatus('Extrude needs an edge or face selection');
      }
    },
  },
  {
    id: 'mesh.inset', label: 'Inset Faces', category: 'Mesh', mode: 'edit', shortcut: 'I', grows: true,
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => ed.startInset(),
  },
  {
    id: 'mesh.loopcut', label: 'Loop Cut', category: 'Mesh', mode: 'edit', shortcut: 'Ctrl+R', grows: true,
    run: (ed) => ed.startLoopCut(),
  },
  {
    id: 'mesh.knife', label: 'Knife', category: 'Mesh', mode: 'edit', shortcut: 'K', grows: true,
    run: (ed) => ed.startKnife(),
    enabled: (ed) => ed.mode === 'edit',
  },
  {
    id: 'mesh.subdivide', label: 'Subdivide', category: 'Mesh', mode: 'edit', grows: true,
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      const mesh = ed.editMesh;
      if (mesh && !withinFaceBudget(ed, facesAfterSubdivide(mesh, faces), 'Subdivide')) return;
      editOp(ed, 'Subdivide', (m) => {
        const r = subdivideFaces(m, faces);
        for (const v of r.newVerts) ed.selection.verts.add(v);
      });
    },
  },
  {
    id: 'mesh.duplicate', label: 'Duplicate', category: 'Mesh', mode: 'edit', shortcut: 'Shift+D', grows: true,
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const obj = ed.editObject;
      const mesh = ed.editMesh;
      if (!obj || !mesh) return;
      if (!ed.beginUndo('Duplicate')) return;
      const r = duplicateFaces(mesh, ed.selection.faces);
      ed.selection.verts = new Set(r.verts);
      ed.syncSelection('vertex');
      ed.markGeometryDirty(obj);
      ed.startTransform('translate', null, false);
    },
  },
  {
    id: 'mesh.delete', label: 'Delete Selection', category: 'Mesh', mode: 'edit', shortcut: 'X',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      const edges = [...ed.selection.edges];
      const faces = [...ed.selection.faces];
      const mode = ed.selectMode;
      editOp(ed, `Delete ${mode === 'vertex' ? 'vertices' : mode === 'edge' ? 'edges' : 'faces'}`, (mesh) => {
        if (mode === 'vertex') deleteVertices(mesh, verts);
        else if (mode === 'edge') deleteEdges(mesh, edges);
        else deleteFaces(mesh, faces);
      });
      ed.clearElementSelection();
    },
  },
  {
    id: 'mesh.dissolve', label: 'Dissolve Faces', category: 'Mesh', mode: 'edit', shortcut: 'Ctrl+X',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 1,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Dissolve faces', (mesh) => {
        dissolveFaces(mesh, faces);
      });
    },
  },
  {
    id: 'mesh.merge', label: 'Merge at Centre', category: 'Mesh', mode: 'edit', shortcut: 'M',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.verts.size > 1,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Merge vertices', (mesh) => {
        mergeVertices(mesh, verts);
      });
      ed.clearElementSelection();
    },
  },
  {
    id: 'mesh.mergeByDistance', label: 'Merge by Distance', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      let removed = 0;
      editOp(ed, 'Merge by distance', (mesh) => {
        removed = mergeByDistance(mesh, verts, 0.0001);
      });
      ed.clearElementSelection();
      ed.setStatus(`Merged ${removed} vertices`);
    },
  },
  {
    id: 'mesh.makeFace', label: 'New Face from Selection', category: 'Mesh', mode: 'edit', shortcut: 'F', grows: true,
    enabled: (ed) => ed.mode === 'edit' && ed.selection.verts.size >= 3,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Make face', (mesh) => {
        makeFace(mesh, verts);
      });
    },
  },
  {
    id: 'mesh.flipNormals', label: 'Flip Normals', category: 'Mesh', mode: 'edit',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Flip normals', (mesh) => flipNormals(mesh, faces));
    },
  },
  {
    id: 'mesh.recalcNormals', label: 'Recalculate Normals', category: 'Mesh', mode: 'edit', shortcut: 'Shift+N',
    run: (ed) => editOp(ed, 'Recalculate normals', (mesh) => recalculateNormals(mesh)),
  },
  {
    id: 'mesh.triangulate', label: 'Triangulate Faces', category: 'Mesh', mode: 'edit',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Triangulate', (mesh) => triangulateFaces(mesh, faces));
    },
  },
  {
    id: 'mesh.smooth', label: 'Smooth Vertices', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Smooth vertices', (mesh) => smoothVertices(mesh, verts, 0.5, 1));
    },
  },
  {
    id: 'mesh.selectFacesOfSelection', label: 'Select Faces of Vertices', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const mesh = ed.editMesh;
      if (!mesh) return;
      const t = mesh.topology();
      const faces = new Set<number>();
      for (const v of ed.selection.verts) for (const f of t.vertFaces[v] ?? []) faces.add(f);
      ed.selection.verts = facesToVerts(mesh, faces);
      ed.syncSelection('vertex');
    },
  },

  // ------------------------------------------------------------------- View
  { id: 'view.frameSelected', label: 'Frame Selected', category: 'View', shortcut: '.', run: (ed) => ed.frameSelected() },
  { id: 'view.frameAll', label: 'Frame All', category: 'View', shortcut: 'Home', run: (ed) => ed.frameAll() },
  { id: 'view.front', label: 'Front', category: 'View', shortcut: 'Numpad 1', run: (ed) => { ed.camera.setAxisView('front'); ed.requestRender(); } },
  { id: 'view.back', label: 'Back', category: 'View', shortcut: 'Ctrl+Numpad 1', run: (ed) => { ed.camera.setAxisView('back'); ed.requestRender(); } },
  { id: 'view.right', label: 'Right', category: 'View', shortcut: 'Numpad 3', run: (ed) => { ed.camera.setAxisView('right'); ed.requestRender(); } },
  { id: 'view.left', label: 'Left', category: 'View', shortcut: 'Ctrl+Numpad 3', run: (ed) => { ed.camera.setAxisView('left'); ed.requestRender(); } },
  { id: 'view.top', label: 'Top', category: 'View', shortcut: 'Numpad 7', run: (ed) => { ed.camera.setAxisView('top'); ed.requestRender(); } },
  { id: 'view.bottom', label: 'Bottom', category: 'View', shortcut: 'Ctrl+Numpad 7', run: (ed) => { ed.camera.setAxisView('bottom'); ed.requestRender(); } },
  {
    id: 'view.ortho', label: 'Toggle Orthographic', category: 'View', shortcut: 'Numpad 5',
    run: (ed) => {
      ed.camera.orthographic = !ed.camera.orthographic;
      ed.requestRender();
      ed.emit('change');
      ed.setStatus(ed.camera.orthographic ? 'Orthographic' : 'Perspective');
    },
  },
  {
    id: 'view.camera', label: 'Look Through Camera', category: 'View', shortcut: 'Numpad 0',
    run: (ed) => {
      const cam = [...ed.scene.objects.values()].find((o) => o.type === 'camera');
      if (!cam) {
        ed.setStatus('No camera in the scene');
        return;
      }
      ed.camera.lockedMatrix = ed.camera.lockedMatrix ? null : cam.worldMatrix(ed.scene);
      ed.requestRender();
      ed.setStatus(ed.camera.lockedMatrix ? `Looking through ${cam.name}` : 'Free view');
    },
  },
  {
    id: 'view.shading', label: 'Cycle Shading', category: 'View', shortcut: 'Z',
    run: (ed) => ed.cycleShading(),
  },
  {
    id: 'view.xray', label: 'Toggle X-Ray', category: 'View', shortcut: 'Alt+Z',
    run: (ed) => {
      ed.options.xray = !ed.options.xray;
      ed.emit('change');
      ed.requestRender();
      ed.setStatus(`X-ray ${ed.options.xray ? 'on' : 'off'}`);
    },
  },
  {
    id: 'view.uvEditor', label: 'UV Editor', category: 'View', shortcut: 'Ctrl+U',
    run: (ed) => ed.panels.toggleUV?.(),
  },
  {
    id: 'view.graphEditor', label: 'Graph Editor', category: 'View', shortcut: 'Ctrl+G',
    run: (ed) => ed.panels.toggleGraph?.(),
  },
  {
    id: 'view.compare', label: 'Compare Versions', category: 'View', shortcut: 'Ctrl+D',
    run: (ed) => ed.panels.toggleDiff?.(),
  },
  {
    id: 'object.acceptRevision',
    label: 'Accept Revision',
    category: 'Object',
    mode: 'object',
    enabled: (ed) => ed.revision.active,
    run: (ed) => {
      if (!ed.revision.accept()) ed.setStatus('No revision is waiting to be accepted');
    },
  },
  {
    id: 'object.rejectRevision',
    label: 'Reject Revision',
    category: 'Object',
    mode: 'object',
    enabled: (ed) => ed.revision.active,
    run: (ed) => {
      if (!ed.revision.reject()) ed.setStatus('No revision is waiting to be rejected');
    },
  },
  {
    id: 'object.protectFromRegeneration',
    label: 'Protect From Regeneration',
    category: 'Object',
    mode: 'object',
    enabled: (ed) => !!ed.scene.activeObject && !!assetRootFor(ed.scene, ed.scene.activeObject),
    run: (ed) => {
      const obj = ed.scene.activeObject;
      if (!obj) return;
      if (!ed.beginUndo('Protect part')) return;
      obj.protectedFromRegen = !obj.protectedFromRegen;
      ed.setStatus(obj.protectedFromRegen
        ? `"${obj.name}" will not be changed by a revision; one that tries will say so`
        : `"${obj.name}" can be regenerated again`);
      ed.emit('change');
    },
  },
  {
    id: 'help.guide', label: 'Getting Started Guide', category: 'Help',
    run: (ed) => ed.panels.toggleGuide?.(),
  },
  {
    id: 'help.licence', label: 'Licence', category: 'Help',
    run: (ed) => ed.panels.toggleLicence?.(),
  },
  {
    id: 'help.guideOnStart',
    label: 'Show The Guide When The Culp Mixer Opens',
    category: 'Help',
    run: (ed) => {
      const on = !ed.preferences.showGuideOnStart;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: on });
      ed.setStatus(on ? 'The guide will open with The Culp Mixer' : 'The guide will stay closed on start');
    },
  },
  {
    id: 'view.compareLastStep',
    label: 'Compare With Before The Last Operation',
    category: 'View',
    run: (ed) => {
      const steps = ed.history.steps();
      const last = steps[steps.length - 1];
      if (!last) {
        ed.setStatus('Nothing has been done yet to compare against');
        return;
      }
      ed.panels.toggleDiff?.();
      ed.compareAgainst(last.scene, `before ${last.label}`);
    },
  },
  {
    id: 'view.grid', label: 'Toggle Grid', category: 'View',
    run: (ed) => {
      ed.options.showGrid = !ed.options.showGrid;
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.overlays', label: 'Toggle Overlays', category: 'View',
    run: (ed) => {
      ed.options.showOverlays = !ed.options.showOverlays;
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.wireframeOverlay', label: 'Toggle Wireframe Overlay', category: 'View',
    run: (ed) => {
      ed.options.showObjectWireframe = !ed.options.showObjectWireframe;
      for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.cursorToOrigin', label: '3D Cursor to World Origin', category: 'View', shortcut: 'Shift+C',
    run: (ed) => {
      if (!ed.beginUndo('Cursor to origin')) return;
      ed.scene.cursor = new Vec3();
      ed.frameAll();
      ed.emit('change');
    },
  },

  // ------------------------------------------------------- Mesh: hard surface
  {
    id: 'mesh.bevel', label: 'Bevel', category: 'Mesh', shortcut: 'Ctrl+B', mode: 'edit', grows: true,
    run: (ed) => ed.startBevel(),
    enabled: (ed) => ed.mode === 'edit' && (ed.selection.edges.size > 0 || ed.selection.faces.size > 0),
  },
  {
    id: 'mesh.bevelWeightFull', label: 'Set Bevel Weight: Full', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 1);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} back to full bevel width`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelWeightHalf', label: 'Set Bevel Weight: Half', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 0.5);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} set to half bevel width`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelWeightNone', label: 'Set Bevel Weight: None', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 0);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} excluded from bevels`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelVertices', label: 'Bevel Vertices', category: 'Mesh', mode: 'edit', grows: true,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Bevel vertices', (mesh) => {
        bevelVertices(mesh, verts, 0.08);
      });
    },
    enabled: hasEditSelection,
  },
  {
    id: 'mesh.bisect', label: 'Bisect at 3D Cursor (view aligned)', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      // The cut plane faces the camera and passes through the 3D cursor, which
      // is the one plane the user can position without a gizmo.
      const inv = obj.worldMatrix(ed.scene).inverse();
      const normal = inv.transformDirection(ed.camera.forward()).normalized();
      const point = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Bisect', (mesh) => {
        bisect(mesh, normal, normal.dot(point), { fill: true });
      });
    },
  },
  {
    id: 'mesh.bisectCut', label: 'Bisect and Remove Front Half', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      const inv = obj.worldMatrix(ed.scene).inverse();
      const normal = inv.transformDirection(ed.camera.forward()).normalized();
      const point = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Bisect (cut)', (mesh) => {
        bisect(mesh, normal, normal.dot(point), { fill: true, clearBack: true });
      });
    },
  },
  {
    id: 'mesh.spin', label: 'Spin Selected Edges Around Z', category: 'Mesh', mode: 'edit', grows: true,
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      const edges = [...ed.selection.edges];
      if (edges.length === 0) {
        ed.setStatus('Spin needs an edge selection');
        return;
      }
      const inv = obj.worldMatrix(ed.scene).inverse();
      const center = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Spin', (mesh) => {
        spinEdges(mesh, edges, new Vec3(0, 0, 1), center, Math.PI * 2, 16);
      });
    },
  },
  {
    id: 'mesh.bridge', label: 'Bridge Edge Loops', category: 'Mesh', mode: 'edit', grows: true,
    run: (ed) => {
      const edges = [...ed.selection.edges];
      let problem: string | undefined;
      editOp(ed, 'Bridge loops', (mesh) => {
        problem = bridgeLoops(mesh, edges).error;
      });
      if (problem) ed.setStatus(problem);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.poke', label: 'Poke Faces', category: 'Mesh', mode: 'edit', grows: true,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Poke faces', (mesh) => {
        pokeFaces(mesh, faces, 0);
      });
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
  },
  {
    id: 'mesh.symmetrizeX', label: 'Symmetrize +X to -X', category: 'Mesh', mode: 'edit', grows: true,
    run: (ed) => editOp(ed, 'Symmetrize', (mesh) => symmetrize(mesh, 0, true)),
  },
  {
    id: 'mesh.limitedDissolve', label: 'Limited Dissolve (merge coplanar)', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let merged = 0;
      editOp(ed, 'Limited dissolve', (mesh) => {
        merged = dissolveCoplanar(mesh, 1.5);
      });
      ed.setStatus(`Limited dissolve: ${merged} face${merged === 1 ? '' : 's'} merged`);
    },
  },
  {
    id: 'mesh.stitch', label: 'Fix T-Junctions', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let n = 0;
      editOp(ed, 'Fix T-junctions', (mesh) => {
        const scale = Math.max(1e-6, mesh.bounds().radius());
        n = stitchTJunctions(mesh, 1e-4 * scale);
      });
      ed.setStatus(n ? `Stitched ${n} vertices into their neighbours' edges` : 'No T-junctions found');
    },
  },

  // ------------------------------------------------------------------- UV
  {
    id: 'uv.unwrap', label: 'Unwrap (conformal, respects seams)', category: 'Mesh', shortcut: 'U', mode: 'edit',
    run: (ed) => {
      let islands = 0;
      editOp(ed, 'Unwrap', (mesh) => {
        islands = unwrap(mesh, { useSeams: true, angleLimit: 66, margin: 0.01 });
      });
      ed.setStatus(`Unwrapped into ${islands} island${islands === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'uv.smart', label: 'Smart UV Project', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let islands = 0;
      editOp(ed, 'Smart UV project', (mesh) => {
        islands = smartProject(mesh, 66, 0.01);
      });
      ed.setStatus(`Projected ${islands} island${islands === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'uv.cube', label: 'Cube Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Cube project', (mesh) => cubeProject(mesh, Math.max(0.001, mesh.bounds().radius()))),
  },
  {
    id: 'uv.cylinder', label: 'Cylinder Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Cylinder project', (mesh) => cylinderProject(mesh)),
  },
  {
    id: 'uv.sphere', label: 'Sphere Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Sphere project', (mesh) => sphereProject(mesh)),
  },
  {
    id: 'uv.planar', label: 'Planar Project (top)', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Planar project', (mesh) => planarProject(mesh, 2)),
  },
  {
    id: 'uv.markSeam', label: 'Mark Seam', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Mark seam', (mesh) => {
        markSeams(mesh, edges, true);
      });
      ed.setStatus(`Marked ${edges.length} seam edge${edges.length === 1 ? '' : 's'}`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'uv.clearSeam', label: 'Clear Seam', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Clear seam', (mesh) => {
        markSeams(mesh, edges, false);
      });
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'paint.newTexture', label: 'New Paint Map', category: 'Mesh',
    run: (ed) => {
      const obj = ed.editObject ?? ed.scene.get(ed.scene.active ?? -1);
      if (!obj || obj.type !== 'mesh') {
        ed.setStatus('Select a mesh first');
        return;
      }
      if (!ed.beginUndo('New paint map')) return;
      // A blank white map, and a material to hang it on if there is not one.
      let slot = obj.materialSlots[0];
      if (slot === undefined || !ed.scene.materials[slot]) {
        slot = ed.scene.addMaterial();
        obj.materialSlots = [slot];
      }
      const tex = blankTexture(`${obj.name} paint`, 1024);
      ed.scene.textures.push(tex);
      ed.scene.materials[slot].baseColorTexture = tex.id;
      if (!obj.mesh?.hasUV) {
        // Painting needs somewhere to put the pixels; an unwrapped mesh has
        // nowhere, so do the obvious thing rather than failing.
        smartProject(obj.mesh!, 66, 0.01);
        ed.setStatus(`Made a 1024² paint map and unwrapped ${obj.name} for it`);
      } else {
        ed.setStatus(`Made a 1024² paint map for ${obj.name}`);
      }
      obj.invalidate();
      ed.markGeometryDirty(obj);
      ed.emit('change');
    },
    enabled: (ed) => !!(ed.editObject ?? ed.scene.get(ed.scene.active ?? -1)),
  },
  {
    id: 'paint.clearColors', label: 'Clear Vertex Colours', category: 'Mesh',
    run: (ed) => {
      const mesh = (ed.editObject ?? ed.scene.get(ed.scene.active ?? -1))?.mesh;
      if (!mesh?.colors) {
        ed.setStatus('Nothing painted');
        return;
      }
      if (!ed.beginUndo('Clear vertex colours')) return;
      mesh.colors = null;
      mesh.markDirty();
      ed.setStatus('Vertex colours cleared');
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.shadows', label: 'Toggle Shadows', category: 'View',
    run: (ed) => {
      ed.options.shadows = ed.options.shadows === false;
      ed.setStatus(
        ed.options.shadows
          ? 'Shadows on — cast by the strongest sun or spot, in Material shading'
          : 'Shadows off',
      );
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.uvCheck', label: 'Toggle UV Checker', category: 'View',
    run: (ed) => {
      ed.options.uvCheck = !ed.options.uvCheck;
      ed.setStatus(`UV checker ${ed.options.uvCheck ? 'on' : 'off'}`);
      ed.emit('change');
      ed.requestRender();
    },
  },

  // --------------------------------------------------------------- Physics
  {
    id: 'physics.makeActive', label: 'Make Rigid Body (active)', category: 'Object', mode: 'object',
    run: (ed) => {
      const objs = [...ed.scene.selection].map((id) => ed.scene.get(id)).filter((o) => o?.type === 'mesh');
      if (objs.length === 0) {
        ed.setStatus('Select a mesh first');
        return;
      }
      if (!ed.beginUndo('Make rigid body')) return;
      for (const o of objs) o!.physics = createPhysicsBody('active');
      ed.setStatus(`${objs.length} object${objs.length === 1 ? '' : 's'} will fall`);
      ed.emit('change');
    },
    enabled: (ed) => ed.scene.selection.size > 0,
  },
  {
    id: 'physics.makePassive', label: 'Make Rigid Body (passive)', category: 'Object', mode: 'object',
    run: (ed) => {
      const objs = [...ed.scene.selection].map((id) => ed.scene.get(id)).filter((o) => o?.type === 'mesh');
      if (objs.length === 0) return;
      if (!ed.beginUndo('Make passive body')) return;
      for (const o of objs) o!.physics = createPhysicsBody('passive');
      ed.setStatus(`${objs.length} object${objs.length === 1 ? '' : 's'} will hold still and be landed on`);
      ed.emit('change');
    },
    enabled: (ed) => ed.scene.selection.size > 0,
  },
  {
    id: 'physics.remove', label: 'Remove Rigid Body', category: 'Object', mode: 'object',
    run: (ed) => {
      if (!ed.beginUndo('Remove rigid body')) return;
      let n = 0;
      for (const id of ed.scene.selection) {
        const o = ed.scene.get(id);
        if (o?.physics) {
          o.physics = null;
          n++;
        }
      }
      ed.setStatus(n ? `Removed ${n} rigid bod${n === 1 ? 'y' : 'ies'}` : 'None of those were rigid bodies');
      ed.emit('change');
    },
    enabled: (ed) => ed.scene.selection.size > 0,
  },
  {
    id: 'physics.bake', label: 'Bake Physics to Keyframes', category: 'Object', mode: 'object',
    run: (ed) => {
      if (!ed.beginUndo('Bake physics')) return;
      const t0 = Date.now();
      const r = bakeToKeyframes(ed.scene);
      if (r.bodies === 0) {
        ed.setStatus('Nothing to simulate — mark some objects as active rigid bodies first');
        return;
      }
      ed.setStatus(
        `Baked ${r.bodies} bod${r.bodies === 1 ? 'y' : 'ies'} over ${r.frames} frames `
        + `(${r.keys} keys) in ${Date.now() - t0}ms`,
      );
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'physics.clearBake', label: 'Clear Baked Physics', category: 'Object', mode: 'object',
    run: (ed) => {
      if (!ed.beginUndo('Clear baked physics')) return;
      const n = clearBake(ed.scene);
      ed.setStatus(n ? `Cleared the bake on ${n} object${n === 1 ? '' : 's'}` : 'Nothing was baked');
      ed.emit('change');
      ed.requestRender();
    },
  },

  // -------------------------------------------------------------- Booleans
  {
    id: 'object.booleanDifference', label: 'Boolean Difference', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'difference'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.booleanUnion', label: 'Boolean Union', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'union'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.booleanIntersect', label: 'Boolean Intersect', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'intersect'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.decimate', label: 'Decimate to Half', category: 'Object', mode: 'object',
    run: (ed) => {
      const objs = ed.scene.selectedObjects().filter((o) => o.mesh);
      if (objs.length === 0) return;
      objectOp(ed, 'Decimate', () => {
        for (const o of objs) {
          if (!o.mesh) continue;
          const before = o.mesh;
          o.mesh = decimate(before, 0.5);
          transferUV(before, o.mesh);
        }
      });
      const total = objs.reduce((n, o) => n + (o.mesh?.triCount ?? 0), 0);
      ed.setStatus(`Decimated to ${total} triangles`);
    },
    enabled: hasObjectSelection,
  },

  // -------------------------------------------------------------- Textures
  {
    id: 'material.checker', label: 'Add UV Checker Texture', category: 'Object',
    run: (ed) => {
      const obj = ed.scene.activeObject;
      const slot = obj?.materialSlots[0] ?? 0;
      const mat = ed.scene.materials[slot];
      if (!mat) {
        ed.setStatus('No material to texture');
        return;
      }
      objectOp(ed, 'Add checker texture', (scene) => {
        const tex = generateCheckerTexture(512, 8);
        scene.textures.push(tex);
        mat.baseColorTexture = tex.id;
      });
      ed.setStatus(`Checker texture on ${mat.name}`);
    },
  },
  {
    id: 'material.loadTexture', label: 'Load Image Texture', category: 'Object',
    run: async (ed) => {
      const file = await pickFile('image/*');
      if (!file) return;
      const tex = await loadTextureFile(file);
      const obj = ed.scene.activeObject;
      const slot = obj?.materialSlots[0] ?? 0;
      const mat = ed.scene.materials[slot];
      objectOp(ed, 'Load texture', (scene) => {
        scene.textures.push(tex);
        if (mat) mat.baseColorTexture = tex.id;
      });
      ed.setStatus(`Loaded ${tex.name} (${tex.width}×${tex.height})`);
    },
  },

  // ------------------------------------------------------------- Animation
  {
    id: 'anim.insertKey', label: 'Insert Keyframe', category: 'Object', shortcut: 'I', mode: 'object',
    run: (ed) => ed.insertKeyframe('all'),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.insertLocKey', label: 'Insert Location Keyframe', category: 'Object', mode: 'object',
    run: (ed) => ed.insertKeyframe('position'),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.deleteKey', label: 'Delete Keyframe', category: 'Object', shortcut: 'Alt+I', mode: 'object',
    run: (ed) => ed.deleteKeyframe(),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.play', label: 'Play / Pause Animation', category: 'View', shortcut: 'Space',
    run: (ed) => ed.togglePlayback(),
  },
  {
    id: 'anim.nextFrame', label: 'Next Frame', category: 'View', shortcut: 'Right',
    run: (ed) => ed.stepFrame(1),
  },
  {
    id: 'anim.prevFrame', label: 'Previous Frame', category: 'View', shortcut: 'Left',
    run: (ed) => ed.stepFrame(-1),
  },
  {
    id: 'anim.jumpStart', label: 'Jump to Start', category: 'View', shortcut: 'Shift+Left',
    run: (ed) => ed.setFrame(ed.scene.timeline.start),
  },
  {
    id: 'anim.jumpEnd', label: 'Jump to End', category: 'View', shortcut: 'Shift+Right',
    run: (ed) => ed.setFrame(ed.scene.timeline.end),
  },

  // ---------------------------------------------------------------- Render
  {
    id: 'render.image', label: 'Render Image', category: 'View', shortcut: 'F12',
    run: (ed) => { void ed.renderWithTextures(true); },
  },
  {
    id: 'render.viewport', label: 'Render Current View', category: 'View',
    run: (ed) => { void ed.renderWithTextures(false); },
  },
  {
    id: 'render.animation', label: 'Render Animation (frame sequence)', category: 'View',
    run: (ed) => { void ed.renderAnimation('frames'); },
  },
  {
    id: 'render.video', label: 'Render Animation (video)', category: 'View',
    run: (ed) => { void ed.renderAnimation('video'); },
  },
  {
    id: 'render.cancelAnimation', label: 'Stop Animation Render', category: 'View',
    run: (ed) => ed.cancelAnimation(),
  },
  {
    id: 'render.cancel', label: 'Cancel Render', category: 'View',
    run: (ed) => ed.cancelRender(),
    enabled: (ed) => ed.activeRender !== null && !ed.activeRender.finished,
  },

  // ----------------------------------------------------------------- Modes
  {
    id: 'mode.object', label: 'Object Mode', category: 'Edit',
    run: (ed) => ed.setMode('object'),
  },
  {
    id: 'mode.edit', label: 'Edit Mode', category: 'Edit',
    run: (ed) => ed.setMode('edit'),
  },
  {
    id: 'mode.sculpt', label: 'Sculpt Mode', category: 'Edit',
    run: (ed) => ed.setMode('sculpt'),
  },

  // ------------------------------------------------------- Sculpt & options
  {
    id: 'sculpt.cycleBrush', label: 'Next Sculpt Brush', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const order = Object.keys(BRUSH_LABELS) as SculptBrush[];
      const next = order[(order.indexOf(ed.sculpt.brush) + 1) % order.length];
      ed.setSculptBrush(next);
    },
  },
  {
    id: 'sculpt.radiusUp', label: 'Larger Brush', category: 'Edit', shortcut: ']', mode: 'sculpt',
    run: (ed) => ed.adjustBrushRadius(1.15),
  },
  {
    id: 'sculpt.radiusDown', label: 'Smaller Brush', category: 'Edit', shortcut: '[', mode: 'sculpt',
    run: (ed) => ed.adjustBrushRadius(1 / 1.15),
  },
  {
    id: 'sculpt.symmetryX', label: 'Toggle X Symmetry', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      ed.sculpt.symmetry[0] = !ed.sculpt.symmetry[0];
      ed.setStatus(`X symmetry ${ed.sculpt.symmetry[0] ? 'on' : 'off'}`);
      ed.emit('change');
    },
  },
  {
    id: 'sculpt.remesh', label: 'Voxel Remesh', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const obj = ed.editObject ?? ed.scene.get(ed.scene.active ?? -1);
      const mesh = obj?.mesh;
      if (!obj || !mesh || mesh.faceCount === 0) {
        ed.setStatus('Nothing to remesh');
        return;
      }
      const before = mesh.faceCount;
      const t0 = Date.now();
      if (!ed.beginUndo('Voxel remesh')) return;
      // Aim for a similar triangle count to what is already there, with a
      // floor: remeshing a cube is pointless at six faces' worth of detail.
      const target = Math.max(20000, Math.min(400000, mesh.triCount));
      const rebuilt = voxelRemesh(mesh, { voxelSize: voxelSizeForTarget(mesh, target) });
      if (rebuilt.faceCount === 0) {
        ed.setStatus('Remesh produced nothing — the mesh may not enclose a volume');
        return;
      }
      obj.mesh = rebuilt;
      ed.markGeometryDirty(obj);
      ed.setStatus(
        `Remeshed ${before} faces into ${rebuilt.faceCount} in ${Date.now() - t0}ms — UVs were reset`,
      );
      ed.emit('change');
    },
  },
  {
    id: 'sculpt.clearMask', label: 'Clear Sculpt Mask', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const mesh = (ed.editObject ?? ed.scene.get(ed.scene.active ?? -1))?.mesh;
      if (!mesh || !mesh.mask) {
        ed.setStatus('Nothing is masked');
        return;
      }
      if (!ed.beginUndo('Clear mask')) return;
      mesh.mask = null;
      mesh.markDirty();
      ed.setStatus('Mask cleared');
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'sculpt.invertMask', label: 'Invert Sculpt Mask', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const mesh = (ed.editObject ?? ed.scene.get(ed.scene.active ?? -1))?.mesh;
      if (!mesh) return;
      if (!ed.beginUndo('Invert mask')) return;
      const mask = mesh.ensureMask();
      for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
      mesh.markDirty();
      ed.setStatus('Mask inverted');
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'transform.proportional', label: 'Toggle Proportional Editing', category: 'Edit', shortcut: 'O', mode: 'edit',
    run: (ed) => ed.toggleProportional(),
  },
  {
    id: 'transform.falloff', label: 'Next Proportional Falloff', category: 'Edit', mode: 'edit',
    run: (ed) => {
      const order = Object.keys(FALLOFF_LABELS) as FalloffType[];
      const next = order[(order.indexOf(ed.proportional.falloff) + 1) % order.length];
      ed.proportional.falloff = next;
      ed.setStatus(`Falloff: ${FALLOFF_LABELS[next]}`);
      ed.emit('change');
    },
  },
  {
    id: 'transform.snap', label: 'Toggle Snapping', category: 'Edit', shortcut: 'Shift+Tab',
    run: (ed) => {
      ed.snap.enabled = !ed.snap.enabled;
      ed.setStatus(`Snapping ${ed.snap.enabled ? `on (${SNAP_LABELS[ed.snap.mode]})` : 'off'}`);
      ed.emit('change');
    },
  },
  {
    id: 'transform.snapMode', label: 'Next Snap Target', category: 'Edit',
    run: (ed) => {
      const order = Object.keys(SNAP_LABELS) as SnapMode[];
      const next = order[(order.indexOf(ed.snap.mode) + 1) % order.length];
      ed.snap.mode = next;
      ed.setStatus(`Snap to ${SNAP_LABELS[next]}`);
      ed.emit('change');
    },
  },
  {
    id: 'file.autosave', label: 'Save Recovery Copy Now', category: 'File',
    run: (ed) => ed.autosaveNow(true),
  },
];

/**
 * Boolean between the active object and everything else selected. The active
 * object keeps its name and modifiers; the cutters are consumed.
 */
function runBoolean(ed: Editor, op: BooleanOp): void {
  const scene = ed.scene;
  const target = scene.activeObject;
  if (!target || !target.mesh) {
    ed.setStatus('Boolean needs an active mesh object');
    return;
  }
  const cutters = scene.selectedObjects().filter((o) => o !== target && o.type === 'mesh' && o.mesh);
  if (cutters.length === 0) {
    ed.setStatus('Select a second object to use as the cutter');
    return;
  }
  // An open surface has no inside, so the classification has nothing to go on.
  // Say so rather than returning something that only looks like a mistake.
  const open = [target, ...cutters].filter((o) => o.mesh && !isSolid(o.mesh));
  if (open.length > 0) {
    ed.setStatus(
      `${open.map((o) => o.name).join(', ')} ${open.length === 1 ? 'is not a closed solid' : 'are not closed solids'}`
      + ' — a boolean needs a watertight mesh on both sides.',
    );
    return;
  }
  objectOp(ed, `Boolean ${op}`, () => {
    const toLocal = target.worldMatrix(scene).inverse();
    let result = target.mesh!;
    for (const cutter of cutters) {
      const other = (cutter.evaluated(false) ?? cutter.mesh!).clone();
      other.transform(toLocal.multiply(cutter.worldMatrix(scene)));
      const before = result;
      result = meshBoolean(before, other, op);
      // The cut face is new geometry; sample it off whichever operand it
      // came from so a textured model survives being carved.
      transferUV(before, result);
      transferUV(other, result);
    }
    target.mesh = result;
    for (const c of cutters) scene.remove(c.id);
    scene.selection = new Set([target.id]);
    scene.active = target.id;
  });
  ed.setStatus(`Boolean ${op}: ${target.mesh.faceCount} faces`);
}


export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/**
 * Commands that are allowed while a revision is being reviewed.
 *
 * Reviewing needs the viewport: you have to be able to orbit, frame, change
 * shading and open the comparison to judge what you are being offered. What
 * you may not do is edit the document, take it somewhere else, or write it to
 * disk, because the thing on screen is a proposal and none of those would know
 * that.
 */
/**
 * The few actions that must not run while a revision is being reviewed.
 *
 * Editing is not on the list: the transaction is scoped to the asset, so
 * modelling something else during a review is safe and is allowed. What is
 * held is anything that would take the proposal *out* of the review — writing
 * it to a file, exporting it, or replacing the document it belongs to — where
 * a proposal nobody agreed to would escape as though it were the model.
 */
function heldDuringRevision(id: string): boolean {
  return id === 'file.save' || id === 'file.open' || id === 'file.new'
    || id === 'file.autosave' || id.startsWith('file.export');
}

/**
 * The handful of commands that still work once The Culp Mixer is locked.
 *
 * After the trial, The Culp Mixer is locked — not restricted, locked. These four are
 * the exceptions and each one exists so the lock cannot trap somebody: the
 * licence panel is how you unlock it, Help and the guide explain why it is
 * locked, and Save lets whatever is on screen right now reach the disk before
 * the session ends. Everything else is refused.
 */
const ALLOWED_WHILE_LOCKED = new Set([
  'help.licence', 'help.guide', 'help.guideOnStart', 'file.save',
]);

const MODE_NAMES: Record<string, string> = {
  object: 'Object Mode', edit: 'Edit Mode', sculpt: 'Sculpt Mode',
};

export function runCommand(editor: Editor, id: string): void {
  const cmd = COMMANDS_BY_ID.get(id);
  if (!cmd) {
    // Every other refusal below says what happened. This one returned in
    // silence, which is the worst of the set: a generated program naming a
    // command that does not exist did nothing at all and reported success,
    // and so did anything driving the scripting handle with a typo. Nothing
    // is thrown — a wrong name is an ordinary mistake, not a crash — but it
    // is said out loud.
    editor.setStatus(`There is no command called "${id}"`);
    return;
  }
  // Every mutating operator calls beginUndo, which refuses on its own while a
  // revision is pending — but File actions do not, and "save the document"
  // during a review would write a proposal into the file as though it were the
  // model. So the boundary is drawn here as well, in one place, rather than
  // relying on each command to remember.
  if (editor.revision.active && heldDuringRevision(id)) {
    editor.setStatus(
      `${cmd.label} would write a revision nobody has agreed to. Accept or reject it first — `
      + 'the rest of the scene is yours to edit.',
    );
    return;
  }
  // A command scoped to a mode must not run outside it. Every path into the
  // application already filtered on this — the palette greys the row, the menu
  // hides it, the keymap resolves per mode — which left the check out of the
  // one place that would catch the paths that do not: the scripting handle,
  // and any future caller. Unfiltered, "Unwrap" in Object Mode reported
  // "Unwrapped into 0 islands", which is the language of success for something
  // that could not have done anything.
  // The licence gate. Checked here, once, rather than in each command: a gate
  // somebody has to remember to add is a gate that will be missing from the
  // next command somebody writes. Everything is refused while locked except
  // the few things that let a person unlock it or save what is already open.
  if (!editor.canUse && !ALLOWED_WHILE_LOCKED.has(id)) {
    editor.setStatus(editor.licenceBlockedMessage);
    editor.emit('licence');
    return;
  }
  if (cmd.mode && cmd.mode !== editor.mode) {
    editor.setStatus(
      `${cmd.label} is a ${MODE_NAMES[cmd.mode]} command — you are in ${MODE_NAMES[editor.mode]}`,
    );
    return;
  }
  if (cmd.enabled && !cmd.enabled(editor)) {
    editor.setStatus(`${cmd.label} is not available right now`);
    return;
  }
  // Nothing may add geometry to a mesh that is already at the budget. The
  // operators that remove geometry are never marked, so there is always a way
  // back down from a mesh that arrived over the line in a file.
  if (cmd.grows) {
    const faces = editor.editMesh?.faces.length ?? 0;
    if (faces >= MAX_EDITABLE_FACES && !withinFaceBudget(editor, faces + 1, cmd.label)) return;
  }
  void cmd.run(editor);
}

/** Normalise a keyboard event into a lookup string such as "ctrl+shift+z". */
export function keyChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  // Lowercase everything so named keys ("Tab", "Home") match the keymap too.
  let key = e.key.toLowerCase();
  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') key = e.code.toLowerCase();
  // Give the keys whose `key` value reads badly in a shortcut label a short
  // name, so the keymap and the sheet can use the same spelling.
  if (key === ' ') key = 'space';
  else if (key.startsWith('arrow')) key = key.slice(5);
  parts.push(key);
  return parts.join('+');
}

interface KeyBinding {
  chord: string;
  command: string;
  mode?: EditorMode;
}

export const KEYMAP: KeyBinding[] = [
  { chord: 'tab', command: 'edit.toggleMode' },
  { chord: 'ctrl+z', command: 'edit.undo' },
  { chord: 'ctrl+shift+z', command: 'edit.redo' },
  { chord: 'ctrl+y', command: 'edit.redo' },
  { chord: 'ctrl+s', command: 'file.save' },
  { chord: 'ctrl+o', command: 'file.open' },
  { chord: 'g', command: 'transform.move' },
  { chord: 'r', command: 'transform.rotate' },
  { chord: 's', command: 'transform.scale' },
  { chord: 'a', command: 'select.all' },
  { chord: 'alt+a', command: 'select.none' },
  { chord: 'ctrl+u', command: 'view.uvEditor' },
  { chord: 'ctrl+g', command: 'view.graphEditor' },
  { chord: 'ctrl+d', command: 'view.compare' },
  { chord: 'ctrl+i', command: 'select.invert' },
  { chord: 'ctrl+l', command: 'select.linked', mode: 'edit' },
  { chord: '1', command: 'select.vertex', mode: 'edit' },
  { chord: '2', command: 'select.edge', mode: 'edit' },
  { chord: '3', command: 'select.face', mode: 'edit' },
  { chord: 'e', command: 'mesh.extrude', mode: 'edit' },
  { chord: 'i', command: 'mesh.inset', mode: 'edit' },
  { chord: 'ctrl+r', command: 'mesh.loopcut', mode: 'edit' },
  { chord: 'm', command: 'mesh.merge', mode: 'edit' },
  { chord: 'f', command: 'mesh.makeFace', mode: 'edit' },
  { chord: 'shift+n', command: 'mesh.recalcNormals', mode: 'edit' },
  { chord: 'ctrl+x', command: 'mesh.dissolve', mode: 'edit' },
  { chord: 'x', command: 'mesh.delete', mode: 'edit' },
  { chord: 'delete', command: 'mesh.delete', mode: 'edit' },
  { chord: 'shift+d', command: 'mesh.duplicate', mode: 'edit' },
  { chord: 'x', command: 'object.delete', mode: 'object' },
  { chord: 'delete', command: 'object.delete', mode: 'object' },
  { chord: 'shift+d', command: 'object.duplicate', mode: 'object' },
  { chord: 'ctrl+j', command: 'object.join', mode: 'object' },
  { chord: 'ctrl+a', command: 'object.applyTransform', mode: 'object' },
  { chord: 'h', command: 'object.hide', mode: 'object' },
  { chord: 'alt+h', command: 'object.unhide', mode: 'object' },
  { chord: 'z', command: 'view.shading' },
  { chord: 'alt+z', command: 'view.xray' },
  { chord: '.', command: 'view.frameSelected' },
  { chord: 'numpaddecimal', command: 'view.frameSelected' },
  { chord: 'home', command: 'view.frameAll' },
  { chord: 'numpad1', command: 'view.front' },
  { chord: 'ctrl+numpad1', command: 'view.back' },
  { chord: 'numpad3', command: 'view.right' },
  { chord: 'ctrl+numpad3', command: 'view.left' },
  { chord: 'numpad7', command: 'view.top' },
  { chord: 'ctrl+numpad7', command: 'view.bottom' },
  { chord: 'numpad5', command: 'view.ortho' },
  { chord: 'numpad0', command: 'view.camera' },
  { chord: 'shift+c', command: 'view.cursorToOrigin' },
  { chord: 'ctrl+b', command: 'mesh.bevel', mode: 'edit' },
  { chord: 'u', command: 'uv.unwrap', mode: 'edit' },
  { chord: 'o', command: 'transform.proportional', mode: 'edit' },
  { chord: 'shift+tab', command: 'transform.snap' },
  { chord: 'i', command: 'anim.insertKey', mode: 'object' },
  { chord: 'alt+i', command: 'anim.deleteKey', mode: 'object' },
  { chord: 'space', command: 'anim.play' },
  { chord: 'right', command: 'anim.nextFrame' },
  { chord: 'left', command: 'anim.prevFrame' },
  { chord: 'shift+left', command: 'anim.jumpStart' },
  { chord: 'shift+right', command: 'anim.jumpEnd' },
  { chord: 'f12', command: 'render.image' },
  { chord: 'k', command: 'mesh.knife', mode: 'edit' },
  { chord: ']', command: 'sculpt.radiusUp', mode: 'sculpt' },
  { chord: '[', command: 'sculpt.radiusDown', mode: 'sculpt' },
  { chord: 'b', command: 'sculpt.cycleBrush', mode: 'sculpt' },
];

/** Resolve a key event to a command id, honouring the current mode. */
export function lookupKey(chord: string, mode: EditorMode): string | null {
  const exact = KEYMAP.find((k) => k.chord === chord && k.mode === mode);
  if (exact) return exact.command;
  const generic = KEYMAP.find((k) => k.chord === chord && !k.mode);
  return generic ? generic.command : null;
}
