import { AABB, DEG2RAD, Mat4, Vec3, decomposeMatrix, rayPlane } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PRIMITIVES, PrimitiveKind, buildPrimitive } from '../mesh/primitives';
import { Renderer, SelectMode, ShadingMode, LineSegment, THEME, ViewportOptions } from '../render/Renderer';
import { LightType, Scene, SceneObject, SerializedScene } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { createMaterial } from '../scene/Material';
import { History, EditorSnapshot } from './history';
import { SceneDiff, diffScene, summarise } from '../diff';
import { TransformKind, TransformSession } from './transform';
import {
  Rect, boxSelectElements, boxSelectObjects, normalizeRect, pickElement, pickFaceRay, pickObject,
  raycastGround,
} from './picking';
import { ElementSelection, deriveSelection, elementCount, emptySelection } from './selection';
import { edgeRing, insetFaces, loopCut } from '../mesh/ops';
import { ProportionalSettings, defaultProportional, influenceCircle, proportionalWeights } from './proportional';
import { SnapSettings, defaultSnap, snapPointUnderCursor } from './snapping';
import { NavGesture, NavMode, modifiersOf, navModeForPress, pressGesture, wheelGesture } from './navigation';
import { SculptSettings, SculptStroke, defaultSculpt } from '../sculpt/sculpt';
import { ChannelPath, cloneChannels, removeKey, setKey } from '../anim/animation';
import { bevelEdges } from '../mesh/bevel';
import { knifeCut } from '../mesh/knife';
import { clearPose, createBone, sortBones } from '../anim/armature';
import { BoneConstraint, constraintLabel, createConstraint } from '../anim/constraints';
import { actionRange, createAction, createStrip } from '../anim/actions';
import { envelopeWeights } from '../mesh/skin';
import { createModifier } from '../modifiers';
import { Brush, PaintSurface, defaultBrush, paintTargets, uvScaleAt } from '../paint/texture';
import { SceneTexture } from '../scene/Texture';
import { transferUV } from '../uv/transfer';
import { forgetSaveTargets } from '../io/files';
import {
  LicenceState, canUse as licenceAllowsUse, clearLicence, describeLicence, licenceState,
  storeLicence, verifyKey, whyBlocked,
} from '../licence/licence';
import {
  checkoutUrl, signIn as signInToAccount, syncLicence, takeCheckoutSession,
} from '../licence/activation';
import {
  AccountState, forgetSession, hasSession, logIn as logInToAccount, refreshAccount,
  signUp as signUpForAccount,
} from '../licence/account';
import { FOUNDER_EMAIL, isFounderEmail, unsealOwnerKey } from '../licence/founder';
import { RenderJob } from '../render/pathtrace/RenderJob';
import { RenderSettings, defaultRenderSettings } from '../render/pathtrace/types';
import { buildTraceScene, cameraFromObject, cameraFromViewport } from '../render/pathtrace/build';
import { EMPTY_TEXTURES, PackedTextures, packTextures } from '../render/pathtrace/textures';
import { SequenceRender, framesFor } from '../render/pathtrace/sequence';
import { Destination, chooseDestination } from '../render/pathtrace/deliver';
import { Preferences, defaultPreferences, loadPreferences, savePreferences } from './persistence';
import { RecoveryStore } from './recovery';
import { RevisionSession } from './revision';

export type EditorMode = 'object' | 'edit' | 'sculpt';
export type PivotMode = 'median' | 'cursor';

interface TransformSnapshot {
  verts: { index: number; position: Vec3; weight: number }[] | null;
  objects: { id: number; world: Mat4; parentInverse: Mat4 }[] | null;
}

interface BevelState {
  baseline: Mesh;
  edges: number[];
  startX: number;
  startY: number;
  width: number;
  segments: number;
  profile: number;
}

type Modal =
  | { type: 'transform'; session: TransformSession; snapshot: TransformSnapshot }
  | { type: 'bevel'; state: BevelState }
  | { type: 'inset'; baseline: Mesh; faces: number[]; startX: number; startY: number; thickness: number; depth: number }
  | { type: 'loopcut'; edge: number | null; cuts: number }
  | { type: 'box'; rect: Rect; extend: boolean; subtract: boolean }
  | { type: 'knife'; points: [number, number][]; preview: [number, number] | null };

export type EditorEvent = 'change' | 'status' | 'modal' | 'render' | 'frame' | 'diff' | 'revision' | 'licence';

/**
 * The application controller: owns the scene, the viewport camera, input
 * handling, the operator/undo plumbing and the render loop. The UI layer only
 * reads state from here and calls commands.
 */
export class Editor {
  readonly scene = new Scene();
  readonly camera = new ViewportCamera();
  readonly renderer: Renderer;
  readonly history = new History();
  /**
   * The version currently being compared against, and the result.
   *
   * Held on the editor rather than inside the panel that shows it, because the
   * viewport tints geometry from it too — a comparison is a mode the whole
   * application is in, not a window that happens to be open.
   */
  comparison: { label: string; against: SerializedScene; diff: SceneDiff } | null = null;
  /**
   * The staged revision, when one is being previewed.
   *
   * On the editor rather than in the panel that started it, because a preview
   * is a state the whole application is in: the viewport is showing something
   * that is not committed, and saving, closing or starting another revision
   * all have to know that.
   */
  readonly revision = new RevisionSession({
    scene: this.scene,
    snapshotStore: () => this.history.store,
    snapshot: (label) => this.snapshot(label),
    restore: (snap) => this.restore(snap),
    pushHistory: (snap) => this.history.push(snap),
    setStatus: (msg) => this.setStatus(msg),
    notify: (title, warnings) => this.notify(title, warnings),
    refresh: () => {
      for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
      this.emit('revision');
      this.changed();
    },
  });
  readonly recovery = new RecoveryStore();

  mode: EditorMode = 'object';
  editObjectId: number | null = null;
  selectMode: SelectMode = 'vertex';
  selection: ElementSelection = emptySelection();
  selectionVersion = 0;
  pivotMode: PivotMode = 'median';
  statusMessage = '';
  proportional: ProportionalSettings = defaultProportional();
  snap: SnapSettings = defaultSnap();
  sculpt: SculptSettings = defaultSculpt();
  renderSettings: RenderSettings = defaultRenderSettings();
  activeRender: RenderJob | null = null;
  preferences: Preferences = defaultPreferences();
  /** Set when a mesh edit has happened since the last autosave. */
  private dirtySinceSave = false;
  /**
   * Whether the document has changed since it was last *explicitly* saved.
   *
   * Kept separate from `dirtySinceSave`, which a recovery snapshot clears. A
   * recovery copy is not a save: it lives in browser storage under a name
   * nobody chose, it is overwritten by the next one, and it disappears with the
   * profile. Letting an autosave mark the document clean is how somebody
   * closes over their work having been shown no warning at all.
   */
  private unsavedChanges = false;
  private autosaveTimer: number | null = null;
  private playbackHandle: number | null = null;
  private playbackClock = 0;
  private stroke: SculptStroke | null = null;
  private strokeStart: Vec3 | null = null;
  private brushCursor: { center: Vec3; normal: Vec3; radius: number } | null = null;

  options: ViewportOptions = {
    shading: 'solid',
    showGrid: true,
    showOverlays: true,
    showObjectWireframe: false,
    showOrigins: true,
    xray: false,
    backfaceCulling: false,
    shadows: true,
  };

  private modal: Modal | null = null;
  private listeners = new Map<EditorEvent, Set<() => void>>();
  private needsRender = true;
  private running = false;
  /**
   * Windows the shell owns that commands need to open.
   *
   * The UV and graph editors are DOM, so the editor cannot hold them — but a
   * command is the one thing that reaches the menu, the palette and the
   * shortcut list at once, and both of them spent their first release
   * reachable only by a key combination nothing mentioned. The shell fills
   * this in at startup; a command calls through it and does not care what is
   * on the other side.
   */
  panels: {
    toggleUV?: () => void;
    toggleGraph?: () => void;
    toggleDiff?: () => void;
    toggleGuide?: () => void;
    openCreate?: () => void;
    focusBuild?: (prefill?: string) => void;
    toggleLicence?: () => void;
    toggleIssue?: () => void;
  } = {};
  private pointer = { x: 0, y: 0, down: false, button: -1, startX: 0, startY: 0, dragging: false };
  /**
   * Set when a press has already been spent on something other than picking.
   *
   * A modal is confirmed on press, which leaves a release with nothing to do —
   * and a release with nothing to do used to be read as a click on empty
   * space, so confirming an inset or a move by clicking threw away the very
   * selection the next operator was meant to act on. Every modelling idiom
   * that chains two operators depends on this flag.
   */
  private pressConsumed = false;
  /**
   * Which camera move the current drag is performing, decided when the press
   * landed and held until it is released.
   *
   * Navigation used to be re-derived from the modifier keys on every move
   * event, which meant a drag changed job halfway through if a finger came
   * off a key. Letting go of Option a moment early turned the tail of an
   * orbit into a box select, and the release then applied it — so the usual
   * way to lose a careful selection was to navigate away from it.
   */
  private navMode: NavMode | null = null;
  private keys = { shift: false, ctrl: false, alt: false };
  private hoverPreview: LineSegment[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.buildDefaultScene();
    this.attachEvents();
  }

  // ---------------------------------------------------------------- lifecycle

  private buildDefaultScene(): void {
    const s = this.scene;
    s.materials.push(createMaterial({ name: 'Material', color: [0.75, 0.75, 0.78] }));

    const cube = s.add('mesh', 'Cube', buildPrimitive('cube'));
    cube.position = new Vec3(0, 0, 1);

    const light = s.add('light', 'Light');
    light.position = new Vec3(4.08, 1.01, 5.9);
    if (light.light) light.light.energy = 1000;

    const cam = s.add('camera', 'Camera');
    cam.position = new Vec3(7.36, -6.93, 4.96);
    cam.rotation = new Vec3(63.6 * DEG2RAD, 0, 46.7 * DEG2RAD);

    s.selection = new Set([cube.id]);
    s.active = cube.id;
    this.camera.target = new Vec3(0, 0, 1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      if (!this.running) return;
      if (this.needsRender || this.renderer.resize()) this.renderNow();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------- comparison

  /**
   * Start comparing the scene against another version of it.
   *
   * The comparison is recomputed whenever the scene changes, so the tint
   * follows edits live: undo a step and the geometry it added stops being
   * green while you watch.
   */
  compareAgainst(against: SerializedScene, label: string): SceneDiff {
    const diff = diffScene(against, this.scene.toJSON());
    this.comparison = { label, against, diff };
    this.options.showDiff = true;
    this.setStatus(`Comparing with ${label} — ${summarise(diff)}`);
    this.emit('diff');
    this.markAllGeometryDirty();
    this.requestRender();
    return diff;
  }

  /** Recompute against the same version, after the scene has moved on. */
  refreshComparison(): void {
    if (!this.comparison) return;
    this.comparison.diff = diffScene(this.comparison.against, this.scene.toJSON());
    this.emit('diff');
    this.markAllGeometryDirty();
    this.requestRender();
  }

  stopComparing(): void {
    if (!this.comparison) return;
    this.comparison = null;
    this.options.showDiff = false;
    this.setStatus('Comparison closed');
    this.emit('diff');
    this.markAllGeometryDirty();
    this.requestRender();
  }

  /**
   * Drop every cached surface buffer.
   *
   * A comparison changes how geometry is coloured without changing the
   * geometry, so nothing the cache keys on has moved and it would happily
   * keep serving the untinted buffers.
   */
  private markAllGeometryDirty(): void {
    for (const obj of this.scene.objects.values()) this.renderer.invalidate(obj.id);
  }

  /**
   * Draw one frame right now, outside the animation loop.
   *
   * Worth being a method rather than a closure inside `start`: a WebGL
   * drawing buffer is only readable until the browser composites it, so
   * anything that wants to look at the pixels it just produced — a test
   * asserting that a shadow actually landed, a thumbnail — has to draw and
   * read within one task. There was no way to ask for that before, which is
   * a large part of why a renderer bug could sit unnoticed.
   */
  renderNow(): void {
    this.needsRender = false;
    this.renderer.render({
      scene: this.scene,
      camera: this.camera,
      // The rig tools highlight the bone they act on; the renderer only
      // needs to know which one.
      options: { ...this.options, activeBone: this.activeBone },
      edit: this.editOverlay(),
      lines: this.overlayLines(),
      diff: this.options.showDiff ? this.comparison?.diff ?? null : null,
    });
  }

  stop(): void {
    this.running = false;
  }

  requestRender(): void {
    this.needsRender = true;
  }

  on(event: EditorEvent, fn: () => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  emit(event: EditorEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  private changed(): void {
    this.requestRender();
    this.emit('change');
  }

  setStatus(msg: string): void {
    this.statusMessage = msg;
    this.emit('status');
  }

  // ------------------------------------------------------------------- state

  get editObject(): SceneObject | null {
    return this.mode === 'edit' ? this.scene.get(this.editObjectId) : null;
  }

  /** The object a sculpt stroke applies to. */
  get sculptObject(): SceneObject | null {
    if (this.mode !== 'sculpt') return null;
    const obj = this.scene.activeObject;
    return obj && obj.type === 'mesh' && obj.mesh ? obj : null;
  }

  get editMesh(): Mesh | null {
    return this.editObject?.mesh ?? null;
  }

  get modalLabel(): string | null {
    if (!this.modal) return null;
    switch (this.modal.type) {
      case 'transform': return this.modal.session.header();
      case 'inset': return `Inset ${this.modal.thickness.toFixed(4)} (depth ${this.modal.depth.toFixed(3)})`;
      case 'loopcut': return `Loop Cut — ${this.modal.cuts} cut${this.modal.cuts === 1 ? '' : 's'} (scroll to change, click to confirm)`;
      case 'bevel': {
        const b = this.modal.state;
        return `Bevel ${b.width.toFixed(4)} — ${b.segments} segment${b.segments === 1 ? '' : 's'}, profile ${b.profile.toFixed(2)} (scroll for segments)`;
      }
      case 'box': return 'Box Select';
      case 'knife': return 'Knife';
    }
  }

  get isModal(): boolean {
    return this.modal !== null;
  }

  /** The running transform session, for operators that want to constrain it. */
  get currentTransform(): TransformSession | null {
    return this.modal?.type === 'transform' ? this.modal.session : null;
  }

  /** Re-apply the running transform (after changing its constraint). */
  refreshTransform(): void {
    if (this.modal?.type !== 'transform') return;
    this.applyTransform(this.modal.session.update(this.pointer.x, this.pointer.y));
  }

  get boxSelectRect(): Rect | null {
    return this.modal?.type === 'box' ? normalizeRect(this.modal.rect) : null;
  }

  private editOverlay() {
    const obj = this.editObject;
    if (!obj) return null;
    return {
      objectId: obj.id,
      selectMode: this.selectMode,
      verts: this.selection.verts,
      edges: this.selection.edges,
      faces: this.selection.faces,
      version: this.selectionVersion,
    };
  }

  private viewport(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  // --------------------------------------------------------------- selection

  bumpSelection(): void {
    this.selectionVersion++;
    this.requestRender();
    this.emit('change');
  }

  clearElementSelection(): void {
    this.selection.verts.clear();
    this.selection.edges.clear();
    this.selection.faces.clear();
    this.bumpSelection();
  }

  /** The selection set the current mode edits directly. */
  private setForMode(mode: SelectMode = this.selectMode): Set<number> {
    return mode === 'vertex' ? this.selection.verts
      : mode === 'edge' ? this.selection.edges
        : this.selection.faces;
  }

  /**
   * Re-derive the passive selection sets after an edit made in `from` mode.
   * See `selection.ts` for why the authoritative set depends on the mode.
   */
  syncSelection(from: SelectMode = this.selectMode): void {
    const mesh = this.editMesh;
    if (!mesh) return;
    deriveSelection(mesh, this.selection, from);
    this.bumpSelection();
  }

  setSelectMode(mode: SelectMode): void {
    // Convert through the old mode's rules first, then hand authority over.
    this.syncSelection(this.selectMode);
    this.selectMode = mode;
    this.setStatus(`${mode[0].toUpperCase()}${mode.slice(1)} select`);
    this.bumpSelection();
  }

  selectedVertList(): number[] {
    return [...this.selection.verts];
  }

  /** Vertices that a transform should move, taking the select mode into account. */
  transformVerts(): number[] {
    return [...this.selection.verts];
  }

  selectAll(): void {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      if (!mesh) return;
      const count = elementCount(mesh, this.selectMode);
      const set = this.setForMode();
      set.clear();
      for (let i = 0; i < count; i++) set.add(i);
      this.syncSelection();
    } else {
      this.scene.selection = new Set(
        [...this.scene.objects.values()].filter((o) => o.visible && !o.locked).map((o) => o.id),
      );
      if (this.scene.active === null) this.scene.active = [...this.scene.selection][0] ?? null;
      this.changed();
    }
  }

  deselectAll(): void {
    if (this.mode === 'edit') this.clearElementSelection();
    else {
      this.scene.selection.clear();
      this.changed();
    }
  }

  invertSelection(): void {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      if (!mesh) return;
      const count = elementCount(mesh, this.selectMode);
      const set = this.setForMode();
      const next = new Set<number>();
      for (let i = 0; i < count; i++) if (!set.has(i)) next.add(i);
      set.clear();
      for (const i of next) set.add(i);
      this.syncSelection();
    } else {
      const next = new Set<number>();
      for (const o of this.scene.objects.values()) if (!this.scene.selection.has(o.id)) next.add(o.id);
      this.scene.selection = next;
      this.changed();
    }
  }

  selectObject(id: number | null, extend = false): void {
    if (!extend) this.scene.selection.clear();
    if (id !== null) {
      if (extend && this.scene.selection.has(id)) this.scene.selection.delete(id);
      else this.scene.selection.add(id);
      this.scene.active = this.scene.selection.has(id) ? id : null;
    } else {
      this.scene.active = null;
    }
    this.changed();
  }

  private selectElementAt(x: number, y: number, extend: boolean): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), this.selectMode, {
      xray: this.options.xray,
      radius: 14,
    });
    if (hit === null) {
      if (!extend) this.clearElementSelection();
      return;
    }
    const set = this.setForMode();
    if (!extend) set.clear();
    if (extend && set.has(hit)) set.delete(hit);
    else set.add(hit);
    this.syncSelection();
  }

  /** Grow the selection along an edge loop (Alt+click). */
  selectLoopAt(x: number, y: number, extend: boolean): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), 'edge', {
      xray: this.options.xray, radius: 18,
    });
    if (hit === null) return;
    const ring = edgeRing(mesh, hit);
    if (!extend) this.selection.edges.clear();
    for (const ei of ring.edges) this.selection.edges.add(ei);
    this.syncSelection('edge');
    this.setStatus(`Selected edge ring (${ring.edges.length} edges)`);
  }

  // ----------------------------------------------------------------- history

  /**
   * The document, for the history to hold.
   *
   * While a revision is being reviewed the scene on screen is your document
   * with a proposal laid over one asset in it, and only the first of those two
   * belongs in the history: the proposal is not something anybody has agreed
   * to, and Reject is meant to leave no trace of it. Recording them together
   * is what let a rejected shape reappear — an edit made elsewhere during a
   * review captured the proposal in its snapshot, and undoing that edit after
   * the rejection put the rejected geometry back on screen.
   *
   * So during a review the asset is recorded as it stood before the preview,
   * and everything else exactly as it stands. Off the review path this is the
   * scene, unchanged and at no extra cost.
   */
  snapshot(label: string): EditorSnapshot {
    return {
      label,
      scene: this.revision.committedScene() ?? this.scene.toJSON(this.history.store),
      mode: this.mode,
      editObject: this.editObjectId,
      selectMode: this.selectMode,
      verts: [...this.selection.verts],
      edges: [...this.selection.edges],
      faces: [...this.selection.faces],
    };
  }

  /**
   * Record the pre-edit state so the next operation is undoable.
   *
   * Returns false when the edit must not happen at all, which today means one
   * thing: a revision is being reviewed. While a proposal is on screen the
   * document is held — the scene you are looking at is not one anybody has
   * agreed to yet, so an edit made on top of it would either be destroyed by
   * Reject or swept into Accept, and neither is something a person asked for.
   *
   * Returning a value rather than throwing because these are all UI event
   * handlers, and the honest response to "you cannot do that yet" is to say so
   * and do nothing.
   */
  beginUndo(label: string, creates = false): boolean {
    // Editing during a review is allowed, and is the reason the revision
    // transaction is scoped to its asset rather than to the whole document:
    // Reject puts that asset back and leaves everything you did in the
    // meantime alone, and Accept takes in the asset and nothing else. What is
    // *not* allowed is editing the asset under review — those objects are
    // showing a proposal nobody has agreed to, so an edit to one would be
    // silently thrown away by whichever button you pressed next.
    // A creation touches nothing that already exists, so it is never held —
    // the selection it happens to be made alongside is not its target. Judging
    // it by the selection blocked "add a cube" simply because the asset under
    // review was the thing last clicked on.
    if (!creates && this.revision.active && this.revision.touches(this.mutating(label))) {
      this.setStatus(
        `That object is showing a proposed revision. Accept or reject it first — `
        + 'everything else in the scene is yours to edit.',
      );
      return false;
    }
    this.history.push(this.snapshot(label));
    this.unsavedChanges = true;
    return true;
  }

  /** The objects an edit is about to touch: the selection, or the edit target. */
  private mutating(_label: string): number[] {
    const ids = new Set<number>(this.scene.selection);
    if (this.scene.active !== null) ids.add(this.scene.active);
    if (this.editObjectId !== null) ids.add(this.editObjectId);
    return [...ids];
  }

  /**
   * Whether the document can be edited right now, for callers that mutate
   * without an undo step of their own.
   */
  get editable(): boolean {
    return !this.revision.active || !this.revision.touches(this.mutating(''));
  }

  /**
   * Go to a recorded state.
   *
   * The counterpart of `snapshot`: because the history holds the document
   * without the proposal, restoring one of its entries would take the preview
   * off the screen — through undo, through redo, or through cancelling a modal
   * transform on some unrelated object. The proposal is put back over the
   * restored document so that stepping through your own history during a
   * review does what it says and nothing more.
   */
  /**
   * Something the person needs to see and dismiss, rather than read in passing.
   *
   * The status bar is a running commentary: the next thing that happens
   * overwrites it. That is right for "Selected edge ring" and wrong for "this
   * placement could not be reproduced exactly", which is a thing to act on and
   * may be minutes of work away from being noticed.
   */
  notice: { title: string; warnings: string[] } | null = null;

  // --------------------------------------------------------------- licence

  /**
   * Where this copy stands.
   *
   * Starts permissive and is narrowed once the real answer arrives, because
   * verifying a signature is asynchronous and the alternative is a moment at
   * startup where a paying customer is told they cannot export.
   */
  licence: LicenceState = { status: 'source' };

  /**
   * Who is signed in, and where their thirty-three hours stand.
   *
   * Null means nobody — which is the front door, not an error.
   */
  account: AccountState | null = null;

  /**
   * Whether this build can take accounts at all.
   *
   * False for a desktop build with no network, or a deployment with no store.
   * The front door is only put in somebody's way when there is something
   * behind it — a sign-up form that cannot be completed is worse than no form.
   */
  accountsAvailable = false;

  /** Whether anybody is signed in at all, without waiting for the server. */
  get signedIn(): boolean {
    return this.account !== null || hasSession();
  }

  /** Make an account and start the trial. No confirmation email, by design. */
  async createAccount(
    username: string, email: string, password: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!username || !email || !password) {
      return { ok: false, message: 'Fill all three in.' };
    }
    const result = await signUpForAccount(username, email, password);
    if (!result.ok) return { ok: false, message: result.message };
    this.account = result.account;
    await this.refreshLicence();
    this.emit('licence');
    return { ok: true, message: '' };
  }

  /**
   * Log back in, here or on any other machine.
   *
   * The founder is tried first, and entirely locally. It is the one login
   * that must never depend on a server being configured — the person who owns
   * this has to be able to open it anywhere, including on a deployment that
   * is half finished, which is exactly when they need to look at it.
   */
  async logIn(email: string, password: string): Promise<{ ok: boolean; message: string }> {
    if (!email || !password) return { ok: false, message: 'Both the email and the password.' };

    if (isFounderEmail(email)) {
      const ownerKey = await unsealOwnerKey(password);
      if (ownerKey) {
        const applied = await this.applyLicenceKey(ownerKey);
        if (applied.ok) {
          this.account = {
            status: 'paid',
            username: 'Founder',
            email: FOUNDER_EMAIL,
            plan: 'Founder',
            paidUntil: null,
            founder: true,
          };
          this.emit('licence');
          return { ok: true, message: '' };
        }
      }
      // Wrong password on the founder address. Fall through rather than
      // refusing outright: the address might also be an ordinary account, and
      // being told "no" on your own email with a typo is a bad minute.
    }

    const result = await logInToAccount(email, password);
    if (!result.ok) return { ok: false, message: result.message };
    this.account = result.account;
    await this.refreshLicence();
    this.emit('licence');
    return { ok: true, message: '' };
  }

  /** Forget the session on this machine. Their work and account are untouched. */
  signOutOfKline(): void {
    forgetSession();
    this.account = null;
    void this.refreshLicence();
    this.emit('licence');
  }

  /**
   * Ask where the account stands, on every launch.
   *
   * This is what notices that the founder has switched somebody on after they
   * paid, and what notices a trial running out. It never throws anybody out
   * over a dropped connection: no answer means the last one stands.
   */
  async refreshAccountState(): Promise<AccountState | null> {
    const { reached, account } = await refreshAccount();
    this.accountsAvailable = reached;
    if (account) {
      this.account = account;
      await this.refreshLicence();
    } else if (!hasSession()) {
      this.account = null;
    }
    this.emit('licence');
    return account;
  }

  /** Ask the licence layer, and tell the interface what it said. */
  async refreshLicence(): Promise<LicenceState> {
    this.licence = await licenceState();
    this.emit('licence');
    this.changed();
    return this.licence;
  }

  /**
   * Check with the licence server, then re-read the answer locally.
   *
   * This is what makes a link the whole of the sale: somebody who has paid is
   * recognised here, silently, without ever being handed a key. It cannot fail
   * loudly — no network, no server, no Stripe account yet, all end the same
   * way, with whatever is already on this machine still standing.
   */
  async syncLicence(options: { email?: string } = {}): Promise<LicenceState> {
    await syncLicence({
      ...(options.email ? { email: options.email } : {}),
      session: takeCheckoutSession(),
    });
    return this.refreshLicence();
  }

  /**
   * Sign in with an account, and re-read where that leaves this copy.
   *
   * Returns what to tell them. A wrong email and a wrong password give the
   * same answer, because anything else is a way to find out which emails have
   * accounts.
   */
  async signInToKline(email: string, password: string): Promise<{ ok: boolean; message: string }> {
    if (!email || !password) {
      return { ok: false, message: 'Both the email and the password, please.' };
    }
    const result = await signInToAccount(email, password);
    await this.refreshLicence();
    if (result.ok) return { ok: true, message: describeLicence(this.licence) };
    return {
      ok: false,
      message: result.reason === 'offline'
        ? 'Could not reach the server to check. Try again in a moment — nothing is wrong '
          + 'with your account.'
        : 'That email and password do not match an account.',
    };
  }

  /**
   * Send somebody to pay.
   *
   * Returns the page to open, or a sentence saying why there isn't one. The
   * caller opens it rather than this doing it, so a popup blocker sees a click
   * rather than a script.
   */
  async checkoutLink(email?: string): Promise<{ url: string } | { error: string }> {
    const url = await checkoutUrl(email);
    if (url) return { url };
    return {
      error: 'Could not reach the payment page just now. Check the connection and try again — '
        + 'nothing has been charged.',
    };
  }

  /**
   * Whether The Culp Mixer may be used at all. False once the trial has ended.
   *
   * When somebody is signed in, their account is the authority and nothing
   * else gets a say. Without this, a customer whose thirty-three hours ran out
   * fell through to the anonymous install trial and was quietly handed another
   * thirty-three — which is every customer, for ever, and no revenue.
   */
  get canUse(): boolean {
    // A signed key outranks everything, including a locked account. It is
    // what is issued *after* somebody pays, so if it did not win, the
    // customer who just paid would still be staring at the wall — which is
    // precisely the moment the application must not get this wrong.
    if (this.licence.status === 'owner' || this.licence.status === 'licensed') return true;
    if (this.account) return this.account.status !== 'locked';
    return licenceAllowsUse(this.licence);
  }

  /** Whether finished work can leave the application. */
  get canExport(): boolean {
    return this.canUse;
  }

  get licenceSummary(): string {
    return describeLicence(this.licence);
  }

  get licenceBlockedMessage(): string {
    return whyBlocked(this.licence);
  }

  /**
   * Take a key somebody pasted in.
   *
   * Returns what to tell them either way. A key that does not verify is a
   * typo far more often than it is an attack, so the message says so.
   */
  async applyLicenceKey(key: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = key.trim();
    if (!trimmed) {
      clearLicence();
      await this.refreshLicence();
      return { ok: false, message: 'Licence key removed.' };
    }
    const payload = await verifyKey(trimmed);
    if (!payload) {
      return {
        ok: false,
        message: 'That key did not verify. Check it was copied whole — they are long, '
          + 'and a missing character at either end is the usual reason.',
      };
    }
    storeLicence(trimmed);
    await this.refreshLicence();
    return { ok: true, message: describeLicence(this.licence) };
  }

  notify(title: string, warnings: string[]): void {
    if (!warnings.length) return;
    this.notice = { title, warnings };
    this.emit('revision');
    this.changed();
  }

  /** The person has read it. */
  dismissNotice(): void {
    this.notice = null;
    this.emit('revision');
    this.changed();
  }

  restore(s: EditorSnapshot): void {
    this.scene.adopt(Scene.fromJSON(this.revision.withProposal(s.scene)));
    this.mode = s.mode;
    this.editObjectId = s.editObject;
    this.selectMode = s.selectMode;
    this.selection = { verts: new Set(s.verts), edges: new Set(s.edges), faces: new Set(s.faces) };
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.bumpSelection();
    this.changed();
    // A stored reconstruction that could not be exact only becomes inexact
    // when it is put on screen, which has just happened. Said after the
    // restore rather than during it, so the notice describes a state that is
    // already there to be looked at.
    if (s.warnings?.length) this.notify(`Undo: ${s.label}`, s.warnings);
  }

  /** Whether there is work that has not been written to a file the user named. */
  get hasUnsavedChanges(): boolean {
    return this.unsavedChanges;
  }

  /** Called once a save has actually completed. */
  markSaved(): void {
    this.unsavedChanges = false;
    this.dirtySinceSave = false;
    this.changed();
  }

  /**
   * Start an empty document, keeping the undo history.
   *
   * File > New used to remove the objects and stop there, so the materials and
   * the embedded images of whatever had been open stayed behind — and were
   * written into the next file saved. Somebody who opened a photo model,
   * started something new and saved it shipped the old photograph inside it.
   *
   * Not loadSceneJSON, which clears the history: starting a new document is
   * one of the things people most want to undo.
   */
  newScene(): void {
    // A pending preview belongs to a scene that is about to stop existing;
    // keeping it would leave Accept holding a snapshot of somewhere else.
    this.revision.discard();
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.scene.adopt(new Scene());
    this.mode = 'object';
    this.editObjectId = null;
    this.clearElementSelection();
    this.unsavedChanges = false;
    // A new document has never been saved. Keeping the old file handle would
    // make the next Ctrl+S quietly overwrite the previous project's file.
    forgetSaveTargets();
    this.changed();
  }

  /** Replace the whole scene from a parsed .kline document. */
  loadSceneJSON(data: SerializedScene): void {
    this.revision.discard();
    const restored = Scene.fromJSON(data);
    this.history.clear();
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.scene.adopt(restored);
    this.mode = 'object';
    this.editObjectId = null;
    this.clearElementSelection();
    this.frameAll();
    this.unsavedChanges = false;
    this.changed();
    // An image the document wanted from somewhere else was not loaded. Said
    // out loud rather than silently: the person is owed an explanation for the
    // missing texture, and "this file tried to fetch something" is worth
    // knowing about a file somebody sent you.
    if (restored.rejectedTextures.length) {
      this.notify('This project asked to load images from the internet', [
        'The Culp Mixer only loads images stored inside the file itself, so nothing was fetched and '
          + 'nothing about you was sent anywhere.',
        ...restored.rejectedTextures.map((t) => `Not loaded: ${t}`),
        'Those surfaces will show their base colour instead. If you trust the file and want '
          + 'the images, ask whoever made it to embed them.',
      ]);
    }
  }

  undo(): void {
    const s = this.history.undo(this.snapshot('redo'));
    if (!s) {
      this.setStatus('Nothing to undo');
      return;
    }
    this.setStatus(`Undo: ${s.label}`);
    this.restore(s);
  }

  redo(): void {
    const s = this.history.redo(this.snapshot('undo'));
    if (!s) {
      this.setStatus('Nothing to redo');
      return;
    }
    this.setStatus(`Redo: ${s.label}`);
    this.restore(s);
  }

  /** Call after mutating an object's geometry so caches refresh. */
  markGeometryDirty(obj: SceneObject): void {
    obj.mesh?.markDirty();
    obj.invalidate();
    this.renderer.invalidate(obj.id);
    this.changed();
  }

  // -------------------------------------------------------------- mode & add

  /** Switch modes explicitly; the mode selector and commands both use this. */
  setMode(mode: EditorMode): void {
    if (mode === this.mode) return;
    if (mode === 'sculpt') {
      this.enterSculptMode();
      return;
    }
    if (mode === 'edit') {
      // Via Object Mode rather than a bare assignment, so the sculpt brush
      // cursor is cleared on the way through instead of being left hanging
      // over the mesh in Edit Mode.
      if (this.mode === 'sculpt') this.setMode('object');
      if (this.mode === 'object') this.toggleEditMode();
      return;
    }
    this.mode = 'object';
    this.editObjectId = null;
    this.brushCursor = null;
    this.setStatus('Object Mode');
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  /**
   * The object an Edit or Sculpt switch would act on.
   *
   * The active object when there is one — and otherwise the only mesh in the
   * scene, if there is exactly one, because then there is no question about
   * what was meant. The Culp Mixer starts with nothing active and clicking empty space
   * puts it back there, so without this the Edit and Sculpt buttons are dead
   * on launch: they refuse, they look no different from a button that works,
   * and the only word about it is a line at the bottom of a crowded status
   * bar. "The buttons don't do anything" is exactly how that reads.
   */
  meshForModeChange(): SceneObject | null {
    const active = this.scene.activeObject;
    if (active && active.type === 'mesh' && active.mesh) return active;
    const meshes = [...this.scene.objects.values()].filter(
      (o) => o.type === 'mesh' && o.mesh && o.visible,
    );
    return meshes.length === 1 ? meshes[0] : null;
  }

  /** Why Edit and Sculpt cannot be entered, or null when they can. */
  meshModeBlocker(): string | null {
    if (this.meshForModeChange()) return null;
    const meshes = [...this.scene.objects.values()].filter((o) => o.type === 'mesh' && o.mesh);
    if (meshes.length === 0) return 'Add a mesh first — press Shift+A, or drop a photo on the window';
    return 'Click the object you want to work on first';
  }

  toggleEditMode(): void {
    if (this.mode === 'sculpt') {
      this.setMode('object');
      return;
    }
    if (this.mode === 'object') {
      const obj = this.meshForModeChange();
      if (!obj) {
        this.setStatus(this.meshModeBlocker() ?? 'Select a mesh object to edit');
        return;
      }
      // Picked for them, so select it too — otherwise leaving Edit Mode would
      // drop them back into a scene with nothing selected, and the button
      // would be dead again.
      if (this.scene.active !== obj.id) this.selectObject(obj.id);
      this.mode = 'edit';
      this.editObjectId = obj.id;
      this.clearElementSelection();
      this.setStatus(`Edit Mode — ${obj.name}`);
    } else {
      this.mode = 'object';
      this.editObjectId = null;
      this.setStatus('Object Mode');
    }
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  addPrimitive(kind: PrimitiveKind): SceneObject | null {
    const label = PRIMITIVES.find((p) => p.kind === kind)?.label ?? kind;
    if (!this.beginUndo(`Add ${label}`, true)) return null;
    const obj = this.scene.add('mesh', label, buildPrimitive(kind));
    obj.position = this.scene.cursor.clone();
    this.selectObject(obj.id);
    this.setStatus(`Added ${obj.name}`);
    return obj;
  }

  addLight(type: LightType): SceneObject | null {
    if (!this.beginUndo('Add light', true)) return null;
    const obj = this.scene.add('light', type[0].toUpperCase() + type.slice(1));
    if (obj.light) obj.light.type = type;
    obj.position = this.scene.cursor.add(new Vec3(0, 0, 3));
    this.selectObject(obj.id);
    return obj;
  }

  addCamera(): SceneObject | null {
    if (!this.beginUndo('Add camera', true)) return null;
    const obj = this.scene.add('camera', 'Camera');
    obj.position = this.camera.eye();
    const f = this.camera.forward();
    obj.rotation = new Vec3(Math.acos(-f.z), 0, Math.atan2(f.y, f.x) + Math.PI / 2);
    this.selectObject(obj.id);
    return obj;
  }

  addEmpty(): SceneObject | null {
    if (!this.beginUndo('Add empty', true)) return null;
    const obj = this.scene.add('empty', 'Empty');
    obj.position = this.scene.cursor.clone();
    this.selectObject(obj.id);
    return obj;
  }

  addArmature(): SceneObject | null {
    if (!this.beginUndo('Add armature', true)) return null;
    const obj = this.scene.add('armature', 'Armature');
    obj.position = this.scene.cursor.clone();
    this.selectObject(obj.id);
    this.activeBone = 0;
    return obj;
  }

  // ---------------------------------------------------------------- rigging

  /** Index of the bone edits and weight painting apply to. */
  activeBone = 0;

  /** The selected armature, if exactly one is involved in the selection. */
  get activeArmature(): SceneObject | null {
    const active = this.scene.get(this.scene.active ?? -1);
    if (active?.armature) return active;
    for (const id of this.scene.selection) {
      const o = this.scene.get(id);
      if (o?.armature) return o;
    }
    return null;
  }

  /**
   * Add a bone growing out of the active one, so building a chain is a matter
   * of pressing the key repeatedly rather than typing coordinates.
   */
  extrudeBone(): void {
    const obj = this.activeArmature;
    if (!obj?.armature) {
      this.setStatus('Select an armature first');
      return;
    }
    const bones = obj.armature.bones;
    const parent = Math.min(Math.max(0, this.activeBone), bones.length - 1);
    const from = bones[parent];
    if (!this.beginUndo('Add bone')) return;
    const head = from.tail;
    const dir = [
      from.tail[0] - from.head[0],
      from.tail[1] - from.head[1],
      from.tail[2] - from.head[2],
    ] as [number, number, number];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    bones.push(createBone({
      name: `Bone.${String(bones.length).padStart(3, '0')}`,
      parent,
      head: [...head] as [number, number, number],
      tail: [head[0] + dir[0] / len, head[1] + dir[1] / len, head[2] + dir[2] / len],
    }));
    sortBones(obj.armature);
    this.activeBone = bones.length - 1;
    this.setStatus(`Added bone ${bones.length} of ${bones.length}`);
    this.changed();
    this.requestRender();
  }

  /**
   * A bone that deforms nothing, for a constraint to aim at.
   *
   * A rig is grabbed by its controls, not by its deforming bones — you drag
   * the foot, the knee works itself out — and a control is just an unparented
   * bone nothing is weighted to. Making one is two steps done wrong often
   * enough to be worth a command: it lands away from the chain so it is
   * visible, and it is named so the constraint dropdown reads sensibly.
   */
  addControlBone(): void {
    const obj = this.activeArmature;
    if (!obj?.armature) {
      this.setStatus('Select an armature first');
      return;
    }
    const bones = obj.armature.bones;
    const from = bones[Math.min(Math.max(0, this.activeBone), bones.length - 1)];
    if (!this.beginUndo('Add control bone')) return;
    const at = from ? from.tail : [0, 0, 0];
    let n = 1;
    while (bones.some((b) => b.name === `CTRL.${String(n).padStart(3, '0')}`)) n++;
    bones.push(createBone({
      name: `CTRL.${String(n).padStart(3, '0')}`,
      parent: -1,
      head: [at[0], at[1], at[2]] as [number, number, number],
      tail: [at[0], at[1], at[2] + 0.25] as [number, number, number],
    }));
    sortBones(obj.armature);
    this.activeBone = obj.armature.bones.findIndex((b) => b.name === `CTRL.${String(n).padStart(3, '0')}`);
    this.setStatus(`Added control bone CTRL.${String(n).padStart(3, '0')} — move it, and point a constraint at it`);
    this.changed();
    this.requestRender();
  }

  /** Put a constraint on the active bone, aimed at a sensible default target. */
  addBoneConstraint(kind: BoneConstraint['type']): void {
    const obj = this.activeArmature;
    if (!obj?.armature) {
      this.setStatus('Select an armature first');
      return;
    }
    const bones = obj.armature.bones;
    const index = Math.min(Math.max(0, this.activeBone), bones.length - 1);
    const bone = bones[index];
    if (!bone) return;
    if (!this.beginUndo(`Add ${constraintLabel(kind)}`)) return;
    const constraint = createConstraint(kind);
    // Aim it at a control bone if there is one, because that is what a control
    // bone is for, and otherwise at nothing — which is inert and says so in
    // the panel rather than quietly picking a bone the person did not mean.
    if ('target' in constraint) {
      const control = bones.find((b) => b !== bone && b.parent < 0 && b.name.startsWith('CTRL'));
      constraint.target = control?.name ?? '';
    }
    bone.constraints = [...(bone.constraints ?? []), constraint];
    obj.invalidate();
    this.setStatus(
      `${constraintLabel(kind)} added to ${bone.name}`
      + ('target' in constraint && !constraint.target
        ? ' — choose a target bone in Properties' : ''),
    );
    this.changed();
    this.requestRender();
  }

  /** Drop a constraint off the active bone. */
  removeBoneConstraint(boneIndex: number, at: number): void {
    const obj = this.activeArmature;
    const bone = obj?.armature?.bones[boneIndex];
    if (!bone?.constraints) return;
    if (!this.beginUndo('Remove constraint')) return;
    bone.constraints = bone.constraints.filter((_, i) => i !== at);
    if (bone.constraints.length === 0) delete bone.constraints;
    obj?.invalidate();
    this.changed();
    this.requestRender();
  }

  // ----------------------------------------------------------- actions

  /**
   * Keep the keys being edited as a named take, and start fresh.
   *
   * The point of the copy is that the keys stay editable *and* stay kept: the
   * action is a snapshot, so refining the take afterwards does not silently
   * change every strip already playing it.
   */
  stashAction(): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.animation.length === 0) {
      this.setStatus('Nothing keyed on this object to stash');
      return;
    }
    if (!this.beginUndo('Stash action')) return;
    const name = `Action.${String(obj.actions.length + 1).padStart(3, '0')}`;
    obj.actions.push(createAction(name, cloneChannels(obj.animation)));
    this.setStatus(`Stashed ${obj.animation.length} channel(s) as "${name}" — the keys are still here to edit`);
    this.changed();
  }

  /** Lay an action onto the timeline. */
  addStrip(actionId?: string, blend: 'replace' | 'add' = 'replace'): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.actions.length === 0) {
      this.setStatus('Stash an action first — there is nothing to lay down');
      return;
    }
    const action = obj.actions.find((a) => a.id === actionId) ?? obj.actions[obj.actions.length - 1];
    if (!this.beginUndo('Add strip')) return;
    const range = actionRange(action);
    const start = this.scene.timeline.current;
    const strip = createStrip(action.id, start, start + Math.max(1, range.end - range.start));
    strip.blend = blend;
    // The action's own first key is where a strip starts reading it, so a take
    // that begins at frame 20 does not play twenty frames of nothing.
    strip.offset = range.start;
    obj.strips.push(strip);
    this.setStatus(
      `"${action.name}" laid down from frame ${strip.start} to ${strip.end}`
      + (obj.strips.length > 1 ? ` — ${obj.strips.length} strips blending` : ''),
    );
    this.changed();
    this.requestRender();
  }

  /** Take every strip off, so the object goes back to its own keys. */
  clearStrips(): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.strips.length === 0) return;
    if (!this.beginUndo('Remove strips')) return;
    const n = obj.strips.length;
    obj.strips = [];
    this.setStatus(`Removed ${n} strip(s) — this object plays its own keys again`);
    this.changed();
    this.requestRender();
  }

  removeStrip(at: number): void {
    const obj = this.scene.activeObject;
    if (!obj || !obj.strips[at]) return;
    if (!this.beginUndo('Remove strip')) return;
    obj.strips.splice(at, 1);
    this.changed();
    this.requestRender();
  }

  /**
   * Bind the selected meshes to the selected armature, generating weights.
   *
   * This is the one operation a rig is actually for, so it does the whole
   * thing: weights, the modifier, and the parent link, rather than leaving
   * three separate steps to remember in the right order.
   */
  bindToArmature(): void {
    const rig = this.activeArmature;
    if (!rig?.armature) {
      this.setStatus('Select an armature along with the meshes to bind');
      return;
    }
    const meshes = [...this.scene.selection]
      .map((id) => this.scene.get(id))
      .filter((o): o is SceneObject => !!o && o.type === 'mesh' && !!o.mesh);
    if (meshes.length === 0) {
      this.setStatus('Select at least one mesh as well as the armature');
      return;
    }
    if (!this.beginUndo('Bind to armature')) return;
    const rigWorld = rig.worldMatrix(this.scene);
    for (const obj of meshes) {
      const toArmature = rigWorld.inverse().multiply(obj.worldMatrix(this.scene));
      obj.mesh!.skin = envelopeWeights(obj.mesh!, rig.armature, toArmature);
      obj.mesh!.markDirty();
      if (!obj.modifiers.some((m) => m.type === 'armature' && m.objectId === rig.id)) {
        const mod = createModifier('armature');
        if (mod.type === 'armature') mod.objectId = rig.id;
        obj.modifiers.push(mod);
      }
      obj.invalidate();
      this.markGeometryDirty(obj);
    }
    this.setStatus(
      `Bound ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'} to ${rig.name} with automatic weights`,
    );
    this.changed();
  }

  /** Put every bone back where it started. */
  clearArmaturePose(): void {
    const rig = this.activeArmature;
    if (!rig?.armature) {
      this.setStatus('Select an armature first');
      return;
    }
    if (!this.beginUndo('Clear pose')) return;
    clearPose(rig.armature);
    for (const o of this.scene.objects.values()) {
      if (o.modifiers.some((m) => m.type === 'armature' && m.objectId === rig.id)) {
        o.invalidate();
        this.markGeometryDirty(o);
      }
    }
    this.setStatus('Pose cleared');
    this.changed();
  }

  // ------------------------------------------------------------------ modals

  /**
   * Begin a modal transform. Compound operators (extrude, duplicate) push their
   * own undo step first and pass `pushUndo = false`, so cancelling rolls back
   * the whole operation rather than just the move.
   */
  startTransform(kind: TransformKind, axis: number | null = null, pushUndo = true): void {
    const pivot = this.transformPivot();
    if (!pivot) {
      this.setStatus('Nothing selected');
      return;
    }
    const snapshot = this.captureTransform();
    if (!snapshot) return;
    if (pushUndo) {
      if (!this.beginUndo(kind === 'translate' ? 'Move' : kind === 'rotate' ? 'Rotate' : 'Scale')) return;
    }
    const session = new TransformSession(
      kind, pivot, this.camera, this.viewport(), this.pointer.x, this.pointer.y,
    );
    if (axis !== null) session.setAxis(axis);
    session.setModifiers({ precision: this.keys.shift, snap: this.keys.ctrl });
    this.modal = { type: 'transform', session, snapshot };
    this.applyTransform(session.update(this.pointer.x, this.pointer.y));
    this.emit('modal');
  }

  private transformPivot(): Vec3 | null {
    if (this.pivotMode === 'cursor') return this.scene.cursor.clone();
    if (this.mode === 'edit') {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh || this.selection.verts.size === 0) return null;
      const model = obj.worldMatrix(this.scene);
      const c = new Vec3();
      for (const v of this.selection.verts) c.addInPlace(model.transformPoint(mesh.positions[v]));
      return c.scale(1 / this.selection.verts.size);
    }
    const objs = this.scene.selectedObjects();
    if (objs.length === 0) return null;
    const c = new Vec3();
    for (const o of objs) c.addInPlace(o.worldMatrix(this.scene).transformPoint(new Vec3()));
    return c.scale(1 / objs.length);
  }

  private captureTransform(): TransformSnapshot | null {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      const obj = this.editObject;
      if (!mesh || !obj || this.selection.verts.size === 0) return null;
      let weights: Map<number, number> | null = null;
      if (this.proportional.enabled) {
        // The radius is a world-space distance; the mesh is not.
        const s = obj.scale;
        const avg = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
        weights = proportionalWeights(
          mesh, this.selection.verts, this.proportional.radius / avg,
          this.proportional.falloff, this.proportional.connected,
        );
      }
      const indices = weights ? [...weights.keys()] : [...this.selection.verts];
      return {
        verts: indices.map((index) => ({
          index, position: mesh.positions[index].clone(), weight: weights?.get(index) ?? 1,
        })),
        objects: null,
      };
    }
    const objs = this.scene.selectedObjects();
    if (objs.length === 0) return null;
    return {
      verts: null,
      objects: objs.map((o) => ({
        id: o.id,
        world: o.worldMatrix(this.scene),
        parentInverse: o.parent !== null
          ? (this.scene.get(o.parent)?.worldMatrix(this.scene) ?? Mat4.identity()).inverse()
          : Mat4.identity(),
      })),
    };
  }

  private applyTransform(matrix: Mat4): void {
    if (this.modal?.type !== 'transform') return;
    const snap = this.modal.snapshot;
    if (snap.verts) {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh) return;
      const model = obj.worldMatrix(this.scene);
      const toLocal = model.inverse();
      for (const v of snap.verts) {
        const world = model.transformPoint(v.position);
        const moved = matrix.transformPoint(world);
        mesh.positions[v.index] = toLocal.transformPoint(
          v.weight >= 1 ? moved : world.lerp(moved, v.weight),
        );
      }
      this.markGeometryDirty(obj);
    } else if (snap.objects) {
      for (const item of snap.objects) {
        const obj = this.scene.get(item.id);
        if (!obj) continue;
        const local = item.parentInverse.multiply(matrix.multiply(item.world));
        const d = decomposeMatrix(local);
        obj.position = d.position;
        obj.rotation = d.rotation;
        obj.scale = d.scale;
      }
      this.changed();
    }
    this.emit('modal');
  }

  startInset(): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh || this.selection.faces.size === 0) {
      this.setStatus('Inset needs a face selection');
      return;
    }
    if (!this.beginUndo('Inset')) return;
    this.modal = {
      type: 'inset',
      baseline: mesh.clone(),
      faces: [...this.selection.faces],
      startX: this.pointer.x,
      startY: this.pointer.y,
      thickness: 0,
      depth: 0,
    };
    this.emit('modal');
  }

  private updateInset(x: number, y: number): void {
    if (this.modal?.type !== 'inset') return;
    const obj = this.editObject;
    if (!obj) return;
    const m = this.modal;
    const pivot = this.transformPivot() ?? new Vec3();
    const scale = this.camera.pixelScaleAt(pivot, this.canvas.clientHeight);
    m.thickness = Math.max(0, Math.hypot(x - m.startX, y - m.startY) * scale * (this.keys.shift ? 0.1 : 1));
    // Re-run the operator from the pristine copy each frame so it stays exact.
    const fresh = m.baseline.clone();
    const r = insetFaces(fresh, m.faces, m.thickness, m.depth);
    transferUV(m.baseline, fresh);
    obj.mesh = fresh;
    this.selection.verts = new Set(r.movedVerts);
    this.syncSelection('vertex');
    this.markGeometryDirty(obj);
    this.emit('modal');
  }

  startLoopCut(): void {
    if (!this.editObject) {
      this.setStatus('Loop cut works in Edit Mode');
      return;
    }
    this.modal = { type: 'loopcut', edge: null, cuts: 1 };
    this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
    this.emit('modal');
  }

  private updateLoopCutPreview(x: number, y: number): void {
    if (this.modal?.type !== 'loopcut') return;
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), 'edge', {
      xray: true, radius: 100,
    });
    this.modal.edge = hit;
    this.hoverPreview = [];
    if (hit === null) return;
    const ring = edgeRing(mesh, hit);
    const t = mesh.topology();
    const cuts = this.modal.cuts;
    for (let k = 0; k < cuts; k++) {
      const p = (k + 1) / (cuts + 1);
      const pts: Vec3[] = [];
      for (const ei of ring.edges) {
        const e = t.edges[ei];
        pts.push(model.transformPoint(mesh.positions[e.a].lerp(mesh.positions[e.b], p)));
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        this.hoverPreview.push({ a: pts[i], b: pts[i + 1], color: [1, 0.85, 0.2], overlay: true });
      }
      if (ring.cyclic && pts.length > 2) {
        this.hoverPreview.push({ a: pts[pts.length - 1], b: pts[0], color: [1, 0.85, 0.2], overlay: true });
      }
    }
    this.requestRender();
  }

  private confirmLoopCut(): void {
    if (this.modal?.type !== 'loopcut') return;
    const obj = this.editObject;
    const mesh = this.editMesh;
    const edge = this.modal.edge;
    const cuts = this.modal.cuts;
    this.modal = null;
    this.hoverPreview = [];
    if (!obj || !mesh || edge === null) {
      this.setStatus('Loop cut cancelled');
      this.emit('modal');
      return;
    }
    if (!this.beginUndo('Loop Cut')) return;
    const r = loopCut(mesh, edge, cuts);
    this.selection.verts = new Set(r.newVerts);
    this.syncSelection('vertex');
    this.markGeometryDirty(obj);
    this.setStatus(`Loop cut: ${cuts} loop${cuts === 1 ? '' : 's'} inserted`);
    this.emit('modal');
  }

  // ------------------------------------------------------------------ bevel

  /** Start a modal bevel on the current edge (or face-region) selection. */
  // ------------------------------------------------------------------ knife

  /**
   * Begin a knife cut. Clicking adds points, Enter cuts, Escape backs out.
   */
  startKnife(): void {
    if (!this.editObject || !this.editMesh) {
      this.setStatus('Knife works in Edit Mode');
      return;
    }
    this.modal = { type: 'knife', points: [], preview: null };
    this.setStatus('Knife: click to place cut points, Enter to cut, Esc to cancel');
    this.emit('modal');
    this.requestRender();
  }

  /** The cut line so far, for the overlay to draw. */
  get knifePath(): [number, number][] | null {
    if (this.modal?.type !== 'knife') return null;
    return this.modal.preview ? [...this.modal.points, this.modal.preview] : [...this.modal.points];
  }

  /** How many of `knifePath`'s points are placed rather than the live cursor. */
  get knifePointCount(): number {
    return this.modal?.type === 'knife' ? this.modal.points.length : 0;
  }

  private addKnifePoint(x: number, y: number): void {
    if (this.modal?.type !== 'knife') return;
    this.modal.points.push([x, y]);
    this.setStatus(
      `Knife: ${this.modal.points.length} point${this.modal.points.length === 1 ? '' : 's'} — Enter to cut`,
    );
    this.emit('modal');
    this.requestRender();
  }

  private applyKnife(): void {
    if (this.modal?.type !== 'knife') return;
    const path = this.modal.points;
    const obj = this.editObject;
    const mesh = this.editMesh;
    this.modal = null;
    this.emit('modal');
    if (!obj || !mesh || path.length < 2) {
      this.setStatus('Knife needs at least two points');
      this.changed();
      return;
    }
    const view = this.viewport();
    const model = obj.worldMatrix(this.scene);
    const eye = this.camera.eye();
    const forward = this.camera.forward();
    const t = mesh.topology();
    const normalMat = model.normalMatrix();

    if (!this.beginUndo('Knife')) return;
    const result = knifeCut(mesh, {
      project: (p) => {
        const s = this.camera.worldToScreen(model.transformPoint(p), view.width, view.height);
        return [s.x, s.y];
      },
      path,
      // Only what the user can see. A cut drawn over the front of a model is
      // very rarely meant for the back of it as well.
      frontFacing: (f) => {
        const n = normalMat.transformDirection(t.faceNormals[f]);
        const c = model.transformPoint(t.faceCenters[f]);
        const towards = this.camera.orthographic ? forward.neg() : eye.sub(c);
        return n.dot(towards) > 0;
      },
    });
    if (result.splits === 0) {
      this.setStatus('The knife did not cross any faces');
      const undoState = this.history.undo(this.snapshot('cancelled'));
      if (undoState) this.restore(undoState);
      return;
    }
    // Select what was cut, so the next operation has something to work on.
    this.selectMode = 'vertex';
    this.selection.verts = new Set(result.newVerts);
    this.selection.edges.clear();
    this.selection.faces.clear();
    this.syncSelection();
    this.markGeometryDirty(obj);
    this.setStatus(`Knife split ${result.splits} face${result.splits === 1 ? '' : 's'}`);
    this.changed();
  }

  startBevel(): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) {
      this.setStatus('Bevel works in Edit Mode');
      return;
    }
    const edges = this.bevelTargets(mesh);
    if (edges.length === 0) {
      this.setStatus('Select edges or faces to bevel');
      return;
    }
    if (!this.beginUndo('Bevel')) return;
    this.modal = {
      type: 'bevel',
      state: {
        baseline: mesh.clone(), edges,
        startX: this.pointer.x, startY: this.pointer.y,
        width: 0, segments: 1, profile: 0.5,
      },
    };
    this.emit('modal');
  }

  /**
   * Which edges a bevel should act on: the selected edges, or the boundary of
   * the selected face region when the user is working in face mode.
   */
  private bevelTargets(mesh: Mesh): number[] {
    if (this.selection.edges.size > 0 && this.selectMode !== 'face') return [...this.selection.edges];
    if (this.selection.faces.size > 0) {
      const t = mesh.topology();
      const faces = this.selection.faces;
      const out: number[] = [];
      for (let ei = 0; ei < t.edges.length; ei++) {
        let inside = 0;
        for (const f of t.edges[ei].faces) if (faces.has(f)) inside++;
        if (inside === 1) out.push(ei);
      }
      if (out.length) return out;
    }
    return [...this.selection.edges];
  }

  private updateBevel(x: number, y: number): void {
    if (this.modal?.type !== 'bevel') return;
    const obj = this.editObject;
    if (!obj) return;
    const b = this.modal.state;
    const pivot = this.transformPivot() ?? new Vec3();
    const scale = this.camera.pixelScaleAt(pivot, this.canvas.clientHeight);
    b.width = Math.max(0, Math.hypot(x - b.startX, y - b.startY) * scale * (this.keys.shift ? 0.1 : 1));
    this.applyBevel();
    this.emit('modal');
  }

  private applyBevel(): void {
    if (this.modal?.type !== 'bevel') return;
    const obj = this.editObject;
    if (!obj) return;
    const b = this.modal.state;
    // Re-run from the pristine copy so dragging back and forth stays exact.
    const fresh = b.baseline.clone();
    const r = bevelEdges(fresh, b.edges, b.width, b.segments, b.profile);
    transferUV(b.baseline, fresh);
    obj.mesh = fresh;
    this.selection.verts = new Set(r.newVerts);
    this.selection.edges.clear();
    this.selection.faces.clear();
    this.syncSelection('vertex');
    this.markGeometryDirty(obj);
  }

  // ----------------------------------------------------------------- sculpt

  get brushOverlay(): { center: Vec3; normal: Vec3; radius: number } | null {
    return this.brushCursor;
  }

  setSculptBrush(brush: SculptSettings['brush']): void {
    this.sculpt.brush = brush;
    this.setStatus(`Brush: ${brush}`);
    this.emit('change');
  }

  adjustBrushRadius(factor: number): void {
    this.sculpt.radius = Math.max(0.005, Math.min(100, this.sculpt.radius * factor));
    this.setStatus(`Brush radius ${this.sculpt.radius.toFixed(3)}`);
    this.emit('change');
    this.requestRender();
  }

  adjustBrushStrength(delta: number): void {
    this.sculpt.strength = Math.max(0.01, Math.min(1, this.sculpt.strength + delta));
    this.setStatus(`Brush strength ${this.sculpt.strength.toFixed(2)}`);
    this.emit('change');
  }

  enterSculptMode(): void {
    const obj = this.meshForModeChange();
    if (!obj) {
      this.setStatus(this.meshModeBlocker() ?? 'Select a mesh object to sculpt');
      return;
    }
    if (this.scene.active !== obj.id) this.selectObject(obj.id);
    this.mode = 'sculpt';
    this.editObjectId = null;
    this.clearElementSelection();
    this.setStatus(`Sculpt Mode — ${obj.name} (${this.sculpt.brush} brush)`);
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  /** Where the cursor meets the sculpted surface, in the mesh's own space. */
  private sculptHit(x: number, y: number): { local: Vec3; normal: Vec3; radius: number } | null {
    const obj = this.sculptObject;
    const mesh = obj?.mesh;
    if (!obj || !mesh) return null;
    const model = obj.worldMatrix(this.scene);
    const inv = model.inverse();
    const ray = this.camera.screenRay(x, y, this.viewport().width, this.viewport().height);
    const o = inv.transformPoint(ray.origin);
    const d = inv.transformDirection(ray.dir).normalized();
    const hit = pickFaceRay(mesh, o, d);
    if (!hit) return null;
    const local = o.add(d.scale(hit.t));
    const normal = mesh.topology().faceNormals[hit.face] ?? new Vec3(0, 0, 1);
    // The radius is authored in world units; convert once per stroke step.
    const sc = obj.scale;
    const avg = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
    return { local, normal, radius: this.sculpt.radius / avg };
  }

  // --------------------------------------------------------- texture paint

  /** The live pixel surface for the texture being painted, if any. */
  private paintSurface: PaintSurface | null = null;
  paintBrush: Brush = defaultBrush();

  /** The texture the active object's material paints onto, or null. */
  private paintTexture(): SceneTexture | null {
    const obj = this.sculptObject;
    if (!obj) return null;
    const slot = obj.materialSlots[0] ?? 0;
    const mat = this.scene.materials[slot];
    if (!mat || mat.baseColorTexture === null) return null;
    return this.scene.textures.find((t) => t.id === mat.baseColorTexture) ?? null;
  }

  /**
   * Ready a surface to paint on.
   *
   * The texture's own pixels are drawn in first, so painting over an imported
   * map edits it rather than starting from blank — and the decode is
   * asynchronous, so the first dab of a stroke may land before it finishes.
   * That is a cosmetic race on the first stroke only, and waiting for it would
   * mean dropping the click.
   */
  private ensurePaintSurface(): PaintSurface | null {
    const tex = this.paintTexture();
    if (!tex) return null;
    if (this.paintSurface?.texture === tex) return this.paintSurface;
    this.paintSurface = new PaintSurface(tex);
    void this.paintSurface.adoptExisting();
    return this.paintSurface;
  }

  /** Stamp the texture brush wherever the cursor is over the model. */
  private paintTextureAt(local: Vec3, radius: number): boolean {
    const surface = this.ensurePaintSurface();
    const mesh = this.sculptObject?.mesh;
    if (!surface || !mesh) return false;
    const targets = paintTargets(mesh, local, radius);
    if (targets.length === 0) return false;
    // Radius is in world units; the brush works in texture pixels, and the
    // ratio between them is whatever the unwrap decided.
    const scale = uvScaleAt(mesh, targets[0].face);
    const brush: Brush = {
      ...this.paintBrush,
      radius: Math.max(1, radius * scale * surface.width),
      strength: this.paintBrush.strength,
      color: this.sculpt.invert ? [1, 1, 1] : this.paintBrush.color,
    };
    for (const target of targets) surface.stamp(brush, target.uv[0], target.uv[1], target.outline);
    return true;
  }

  /** Write painted pixels back into the scene texture. */
  private commitPaint(): void {
    if (!this.paintSurface?.hasUncommittedPaint) return;
    if (this.paintSurface.commit()) {
      this.renderer.invalidateTextures();
      this.dirtySinceSave = true;
      this.unsavedChanges = true;
      this.changed();
    }
  }

  private beginStroke(x: number, y: number, invert: boolean): boolean {
    const obj = this.sculptObject;
    const mesh = obj?.mesh;
    if (!obj || !mesh) return false;
    const hit = this.sculptHit(x, y);
    if (!hit) return false;
    if (!this.beginUndo(`Sculpt ${this.sculpt.brush}`)) return false;
    this.sculpt.invert = invert;
    if (this.sculpt.brush === 'texture') {
      if (!this.paintTextureAt(hit.local, hit.radius)) {
        this.setStatus('Give this object a material with a base colour map to paint on');
        return false;
      }
      this.strokeStart = hit.local;
      this.stroke = new SculptStroke(mesh, this.sculpt, hit.radius);
      this.stroke.begin(hit.local, hit.radius);
      return true;
    }
    this.stroke = new SculptStroke(mesh, this.sculpt, hit.radius);
    this.strokeStart = hit.local;
    this.stroke.begin(hit.local, hit.radius);
    this.stroke.dab(hit.local, hit.normal, hit.radius, new Vec3());
    this.markGeometryDirty(obj);
    return true;
  }

  private continueStroke(x: number, y: number): void {
    const obj = this.sculptObject;
    if (!this.stroke || !obj || !obj.mesh) return;
    if (this.sculpt.brush === 'grab') {
      // Grab drags along the view plane through the point the stroke started.
      const start = this.strokeStart;
      if (!start) return;
      const model = obj.worldMatrix(this.scene);
      const inv = model.inverse();
      const worldStart = model.transformPoint(start);
      const n = this.camera.forward().neg();
      const ray = this.camera.screenRay(x, y, this.viewport().width, this.viewport().height);
      const t = rayPlane(ray.origin, ray.dir, worldStart, n);
      if (t === null) return;
      const worldNow = ray.origin.add(ray.dir.scale(t));
      const delta = inv.transformPoint(worldNow).sub(start);
      const sc = obj.scale;
      const avg = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
      this.stroke.dab(start, n, this.sculpt.radius / avg, delta);
      this.markGeometryDirty(obj);
      return;
    }
    const hit = this.sculptHit(x, y);
    if (!hit) return;
    if (this.sculpt.brush === 'texture') {
      this.paintTextureAt(hit.local, hit.radius);
      // Painting shows immediately; the encode back to the texture waits for
      // the stroke to end, because a PNG per dab would make this unusable.
      this.renderer.uploadPaintPreview(this.paintSurface?.canvas ?? null, this.paintTexture()?.id ?? -1);
      this.requestRender();
      return;
    }
    // `stroke` lays down as many dabs as the distance covered calls for, so
    // the result does not depend on how fast the pointer was moving.
    if (this.stroke.stroke(hit.local, hit.normal, hit.radius, new Vec3()) > 0) {
      this.markGeometryDirty(obj);
    }
  }

  private endStroke(): void {
    if (!this.stroke) return;
    this.commitPaint();
    this.stroke = null;
    this.strokeStart = null;
    this.sculpt.invert = false;
    this.dirtySinceSave = true;
    this.unsavedChanges = true;
    this.changed();
  }

  // -------------------------------------------------------------- animation

  /** Key the active objects' transform at the current frame. */
  insertKeyframe(which: 'position' | 'rotation' | 'scale' | 'all' = 'all'): number {
    const objects = this.scene.selectedObjects();
    if (objects.length === 0) {
      this.setStatus('Select something to key');
      return 0;
    }
    if (!this.beginUndo('Insert keyframe')) return 0;
    const frame = this.scene.timeline.current;
    const paths: ChannelPath[] = which === 'all' ? ['position', 'rotation', 'scale'] : [which];
    for (const obj of objects) {
      for (const path of paths) {
        const v = path === 'position' ? obj.position : path === 'rotation' ? obj.rotation : obj.scale;
        setKey(obj.animation, path, 0, frame, v.x);
        setKey(obj.animation, path, 1, frame, v.y);
        setKey(obj.animation, path, 2, frame, v.z);
      }
    }
    this.setStatus(`Keyed ${which} at frame ${frame}`);
    this.changed();
    return objects.length;
  }

  deleteKeyframe(): number {
    const objects = this.scene.selectedObjects();
    if (objects.length === 0) return 0;
    if (!this.beginUndo('Delete keyframe')) return 0;
    let n = 0;
    for (const obj of objects) n += removeKey(obj.animation, this.scene.timeline.current);
    this.setStatus(n ? `Removed ${n} key${n === 1 ? '' : 's'}` : 'No key on this frame');
    this.changed();
    return n;
  }

  setFrame(frame: number): void {
    const tl = this.scene.timeline;
    const f = Math.max(tl.start, Math.min(tl.end, Math.round(frame)));
    this.scene.setFrame(f);
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.emit('frame');
    this.changed();
  }

  stepFrame(delta: number): void {
    this.setFrame(this.scene.timeline.current + delta);
  }

  togglePlayback(): void {
    if (this.scene.timeline.playing) this.stopPlayback();
    else this.startPlayback();
  }

  startPlayback(): void {
    const tl = this.scene.timeline;
    if (tl.playing) return;
    tl.playing = true;
    this.playbackClock = performance.now();
    const tick = (now: number): void => {
      if (!this.scene.timeline.playing) return;
      const dt = (now - this.playbackClock) / 1000;
      const advance = dt * this.scene.timeline.fps;
      if (advance >= 1) {
        this.playbackClock = now;
        let next = this.scene.timeline.current + Math.floor(advance);
        if (next > this.scene.timeline.end) {
          if (!this.scene.timeline.loop) {
            this.stopPlayback();
            return;
          }
          const span = this.scene.timeline.end - this.scene.timeline.start + 1;
          next = this.scene.timeline.start + ((next - this.scene.timeline.start) % Math.max(1, span));
        }
        this.setFrame(next);
      }
      this.playbackHandle = requestAnimationFrame(tick);
    };
    this.playbackHandle = requestAnimationFrame(tick);
    this.emit('frame');
  }

  stopPlayback(): void {
    this.scene.timeline.playing = false;
    if (this.playbackHandle !== null) cancelAnimationFrame(this.playbackHandle);
    this.playbackHandle = null;
    this.emit('frame');
  }

  // ----------------------------------------------------------------- render

  /** The animation render in progress, so it can be cancelled and reported on. */
  activeSequence: SequenceRender | null = null;

  /**
   * Render the frame range and deliver it.
   *
   * Deliberately one call rather than a render that leaves a pile of images in
   * memory for somebody else to deal with: the destination is chosen *before*
   * the first frame, so a person who cancels the folder picker has not waited
   * through a render first, and a browser that cannot deliver the range says
   * so up front instead of after twenty minutes.
   */
  async renderAnimation(prefer: 'frames' | 'video' = 'frames'): Promise<boolean> {
    if (this.activeSequence) {
      this.setStatus('An animation render is already running.');
      return false;
    }
    const total = framesFor(this.scene, this.renderSettings).length;
    const { destination, reason } = await chooseDestination(
      prefer, this.scene.timeline.fps, total,
    );
    if (!destination) {
      this.setStatus(reason);
      return false;
    }
    this.setStatus(`${reason} — rendering ${total} frame(s)…`);
    return this.renderAnimationTo(destination);
  }

  /**
   * Render the frame range into a destination that has already been chosen.
   *
   * Split out from `renderAnimation` so the engine can be exercised against a
   * destination that counts instead of writing. Everything above the write is
   * the code the buttons run, which is the part worth testing; a test that had
   * to accept real downloads would either not run or not mean anything.
   */
  async renderAnimationTo(destination: Destination): Promise<boolean> {
    if (this.activeSequence) {
      this.setStatus('An animation render is already running.');
      return false;
    }
    const total = framesFor(this.scene, this.renderSettings).length;
    const packed = await packTextures(this.scene);
    let written = 0;
    const run = new SequenceRender(this.scene, {
      settings: { ...this.renderSettings },
      viewport: this.camera,
      textures: packed,
      onFrame: async (image) => {
        if (await destination.write(image, total)) written++;
        else run.cancel();
      },
      onProgress: (p) => {
        this.setStatus(`Rendering frame ${p.frame} — ${p.done} of ${p.total}`);
        this.emit('render');
      },
    });
    this.activeSequence = run;
    this.emit('render');
    try {
      const result = await run.run();
      this.setStatus(await destination.finish(written, result.cancelled));
      return !result.cancelled && written === total;
    } finally {
      this.activeSequence = null;
      this.emit('render');
    }
  }

  /** Stop an animation render between frames. */
  cancelAnimation(): void {
    this.activeSequence?.cancel();
  }

  /**
   * Decode the scene's textures, then render.
   *
   * Decoding a data URL needs a document and returns asynchronously, which is
   * why this is separate from `startRender` — that stays synchronous for the
   * tests and for any caller that has already done the decoding.
   */
  async renderWithTextures(fromCamera = true): Promise<RenderJob | null> {
    const packed = await packTextures(this.scene);
    return this.startRender(fromCamera, packed);
  }

  /**
   * Kick off a path-traced render. `fromCamera` uses the scene camera when one
   * exists so the framing is reproducible; otherwise it renders the viewport.
   */
  startRender(fromCamera = true, packed: PackedTextures = EMPTY_TEXTURES): RenderJob | null {
    this.cancelRender();
    let cam = null;
    if (fromCamera) {
      const camObj = [...this.scene.objects.values()].find((o) => o.type === 'camera' && o.visible);
      if (camObj) cam = cameraFromObject(this.scene, camObj.id);
    }
    if (!cam) cam = cameraFromViewport(this.camera);
    const traceScene = buildTraceScene(this.scene, cam, this.scene.world.sky, packed);
    if (traceScene.positions.length === 0) {
      this.setStatus('Nothing to render');
      return null;
    }
    const job = new RenderJob(traceScene, { ...this.renderSettings });
    this.activeRender = job;
    job.onPass = () => this.emit('render');
    this.emit('render');
    void job.run().then(() => {
      this.emit('render');
      if (!job.cancelled) {
        const secs = ((Date.now() - job.startedAt) / 1000).toFixed(1);
        this.setStatus(`Render finished — ${job.settings.samples} samples in ${secs}s`);
      }
    });
    this.setStatus(`Rendering ${job.settings.width}×${job.settings.height} at ${job.settings.samples} samples…`);
    return job;
  }

  cancelRender(): void {
    if (!this.activeRender) return;
    this.activeRender.cancel();
    this.activeRender = null;
    this.emit('render');
  }

  // --------------------------------------------------------------- autosave

  applyPreferences(prefs: Preferences): void {
    this.preferences = prefs;
    this.options.showGrid = prefs.showGrid;
    this.options.showOverlays = prefs.showOverlays;
    this.snap.increment = prefs.snapIncrement;
    this.renderSettings.samples = prefs.renderSamples;
    this.renderSettings.width = prefs.renderWidth;
    this.renderSettings.height = prefs.renderHeight;
    savePreferences(prefs);
    this.startAutosave();
    this.changed();
  }

  loadStoredPreferences(): void {
    this.applyPreferences(loadPreferences());
  }

  startAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (!this.preferences.autosaveEnabled) return;
    const period = Math.max(15, this.preferences.autosaveSeconds) * 1000;
    this.autosaveTimer = setInterval(() => this.autosaveNow(false), period) as unknown as number;
  }

  /**
   * Write a recovery copy.
   *
   * Storage is asynchronous, so this returns before the write lands; that is
   * deliberate, because the alternative is stalling the frame on a scene that
   * may be tens of megabytes. The store serializes overlapping saves itself.
   */
  autosaveNow(announce = true): Promise<boolean> {
    // A recovery copy must never contain a proposal. The scene on screen
    // during a review is a proposal nobody has agreed to, and a crash-recovery
    // copy of *that* would come back with no way left to reject it.
    //
    // Refusing outright was the wrong answer to the right problem, though: it
    // meant that for as long as a review was open — which can be a long time,
    // since the whole point is to look before deciding — the work underneath
    // it had no recovery copy at all. A crash during a review lost the
    // session, and the longer somebody deliberated the more they stood to
    // lose.
    //
    // The revision session already knows how to describe the document with the
    // proposal taken back out, because the undo history is built on exactly
    // that. So the committed state is what gets written: recovery keeps
    // working throughout a review, and what comes back is the document as it
    // stood before the preview, with the preview neither accepted nor
    // serialized.
    const scene = this.revision.committedScene() ?? this.scene.toJSON();
    return this.recovery.save(scene, 'Autosave').then((res) => {
      if (res.ok) {
        // A recovery copy, not a save: `unsavedChanges` is deliberately left
        // alone so closing still asks.
        this.dirtySinceSave = false;
        if (announce) {
          this.setStatus(`Autosaved${this.revision.active ? ' (the document, not the proposal)' : ''}`
            + ` (${res.where === 'indexeddb' ? 'local database' : 'browser storage'})`);
        }
        return true;
      }
      if (announce || this.dirtySinceSave) {
        this.setStatus(`Autosave skipped — ${res.reason ?? 'storage unavailable'}`);
      }
      return false;
    });
  }

  confirmModal(): void {
    if (!this.modal) return;
    switch (this.modal.type) {
      case 'transform':
        this.setStatus(this.modal.session.header());
        this.modal = null;
        break;
      case 'inset':
        this.setStatus(`Inset ${this.modal.thickness.toFixed(4)}`);
        this.modal = null;
        break;
      case 'bevel':
        this.setStatus(`Bevel ${this.modal.state.width.toFixed(4)} × ${this.modal.state.segments}`);
        this.modal = null;
        break;
      case 'loopcut':
        this.confirmLoopCut();
        return;
      case 'box':
        this.applyBoxSelect();
        this.modal = null;
        break;
      case 'knife':
        this.applyKnife();
        return;
    }
    this.emit('modal');
    this.changed();
  }

  cancelModal(): void {
    if (!this.modal) return;
    const m = this.modal;
    this.modal = null;
    this.hoverPreview = [];
    if (m.type === 'transform' || m.type === 'inset' || m.type === 'bevel') {
      // Undo restores the pre-modal snapshot that beginUndo pushed.
      const s = this.history.undo(this.snapshot('cancelled'));
      if (s) this.restore(s);
      this.setStatus('Cancelled');
    }
    this.emit('modal');
    this.changed();
  }

  private applyBoxSelect(): void {
    if (this.modal?.type !== 'box') return;
    const rect = normalizeRect(this.modal.rect);
    if (Math.abs(rect.x1 - rect.x0) < 3 && Math.abs(rect.y1 - rect.y0) < 3) return;
    const extend = this.modal.extend;
    const subtract = this.modal.subtract;
    if (this.mode === 'edit') {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh) return;
      const hits = boxSelectElements(
        mesh, obj.worldMatrix(this.scene), this.camera, rect, this.viewport(),
        this.selectMode, this.options.xray,
      );
      const set = this.setForMode();
      if (!extend && !subtract) set.clear();
      for (const h of hits) {
        if (subtract) set.delete(h);
        else set.add(h);
      }
      this.syncSelection();
    } else {
      const hits = boxSelectObjects(this.scene, this.camera, rect, this.viewport());
      if (!extend && !subtract) this.scene.selection.clear();
      for (const id of hits) {
        if (subtract) this.scene.selection.delete(id);
        else this.scene.selection.add(id);
      }
      if (this.scene.active === null || !this.scene.selection.has(this.scene.active)) {
        this.scene.active = [...this.scene.selection][0] ?? null;
      }
      this.changed();
    }
  }

  // ------------------------------------------------------------------- views

  frameSelected(): void {
    let box: AABB;
    if (this.mode === 'edit' && this.editObject && this.editMesh && this.selection.verts.size) {
      box = new AABB();
      const model = this.editObject.worldMatrix(this.scene);
      for (const v of this.selection.verts) box.expand(model.transformPoint(this.editMesh.positions[v]));
    } else {
      box = this.scene.bounds(this.scene.selection.size > 0);
    }
    if (!box.valid) box = this.scene.bounds(false);
    this.camera.frame(box);
    this.requestRender();
  }

  frameAll(): void {
    this.camera.frame(this.scene.bounds(false));
    this.requestRender();
  }

  setShading(mode: ShadingMode): void {
    this.options.shading = mode;
    this.changed();
  }

  cycleShading(): void {
    const order: ShadingMode[] = ['solid', 'material', 'wireframe'];
    this.setShading(order[(order.indexOf(this.options.shading) + 1) % order.length]);
    this.setStatus(`Shading: ${this.options.shading}`);
  }

  private overlayLines(): LineSegment[] {
    const lines: LineSegment[] = [...this.hoverPreview];
    if (this.modal?.type === 'transform') {
      const s = this.modal.session;
      if (s.axis !== null && !s.plane) {
        const color = [THEME.axisX, THEME.axisY, THEME.axisZ][s.axis];
        const dir = Vec3.axis(s.axis).scale(1000);
        lines.push({ a: s.pivot.sub(dir), b: s.pivot.add(dir), color, overlay: true });
      }
    }
    if (this.modal?.type === 'transform' && this.proportional.enabled && this.mode === 'edit') {
      const ring = influenceCircle(
        this.modal.session.pivot, this.proportional.radius, this.camera.right(), this.camera.up(),
      );
      for (let i = 0; i < ring.length; i++) {
        lines.push({
          a: ring[i], b: ring[(i + 1) % ring.length], color: [0.35, 0.75, 1], overlay: true,
        });
      }
    }
    if (this.mode === 'sculpt' && this.brushCursor) {
      const c = this.brushCursor;
      const helper = Math.abs(c.normal.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
      const right = helper.cross(c.normal).normalized();
      const up = c.normal.cross(right).normalized();
      const ring = influenceCircle(c.center, c.radius, right, up, 48);
      const color: [number, number, number] = this.sculpt.invert ? [1, 0.45, 0.35] : [0.95, 0.95, 1];
      for (let i = 0; i < ring.length; i++) {
        lines.push({ a: ring[i], b: ring[(i + 1) % ring.length], color, overlay: true });
      }
    }
    if (this.modal?.type === 'transform' && this.modal.session.snapPoint) {
      const p = this.modal.session.snapPoint;
      const r = this.camera.pixelScaleAt(p, this.canvas.clientHeight) * 9;
      for (const [ax, ay] of [[this.camera.right(), this.camera.up()]] as [Vec3, Vec3][]) {
        lines.push({ a: p.sub(ax.scale(r)), b: p.add(ax.scale(r)), color: [1, 0.4, 0.9], overlay: true });
        lines.push({ a: p.sub(ay.scale(r)), b: p.add(ay.scale(r)), color: [1, 0.4, 0.9], overlay: true });
      }
    }
    return lines;
  }

  // ------------------------------------------------------------------- input

  private attachEvents(): void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.requestRender()).observe(c);
  }

  private localPointer(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.localPointer(e);
    this.pointer = { x: p.x, y: p.y, down: true, button: e.button, startX: p.x, startY: p.y, dragging: false };
    this.pressConsumed = false;
    this.syncModifierKeys(e);
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);

    if (this.modal) {
      this.pressConsumed = true;
      // The knife collects points on click rather than being confirmed by one.
      if (this.modal.type === 'knife') {
        if (e.button === 0) this.addKnifePoint(p.x, p.y);
        else if (e.button === 2) this.cancelModal();
        return;
      }
      if (e.button === 0) this.confirmModal();
      else if (e.button === 2) this.cancelModal();
      return;
    }
    this.navMode = navModeForPress(e.button, modifiersOf(e));
    if (this.navMode) return;

    if (this.mode === 'sculpt' && e.button === 0 && !e.altKey) {
      if (this.beginStroke(p.x, p.y, e.ctrlKey || e.metaKey)) return;
    }
    if (e.button === 2 && e.shiftKey) {
      const hit = raycastGround(this.camera, p.x, p.y, this.viewport());
      if (hit) {
        if (!this.beginUndo('Move 3D cursor')) return;
        this.scene.cursor = hit;
        this.changed();
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.localPointer(e);
    const dx = p.x - this.pointer.x;
    const dy = p.y - this.pointer.y;
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.syncModifierKeys(e);

    if (this.modal) {
      switch (this.modal.type) {
        case 'transform':
          this.updateSnapping(this.modal.session, p.x, p.y, e.ctrlKey);
          this.modal.session.setModifiers({
            precision: e.shiftKey,
            snap: this.snappingActive(e.ctrlKey) && this.snap.mode === 'increment',
          });
          this.applyTransform(this.modal.session.update(p.x, p.y));
          break;
        case 'inset':
          this.updateInset(p.x, p.y);
          break;
        case 'bevel':
          this.updateBevel(p.x, p.y);
          break;
        case 'loopcut':
          this.updateLoopCutPreview(p.x, p.y);
          break;
        case 'box':
          this.modal.rect.x1 = p.x;
          this.modal.rect.y1 = p.y;
          this.emit('modal');
          this.requestRender();
          break;
        case 'knife':
          this.modal.preview = [p.x, p.y];
          this.emit('modal');
          this.requestRender();
          break;
      }
      return;
    }

    if (this.mode === 'sculpt') {
      this.updateBrushCursor(p.x, p.y);
      if (this.stroke && this.pointer.down && this.pointer.button === 0) {
        this.continueStroke(p.x, p.y);
        return;
      }
    }

    if (!this.pointer.down) return;
    const moved = Math.hypot(p.x - this.pointer.startX, p.y - this.pointer.startY);
    if (moved > 3) this.pointer.dragging = true;

    if (this.navMode) {
      this.applyNavGesture(pressGesture(this.navMode, dx, dy));
    } else if (this.pointer.button === 0 && this.pointer.dragging && this.mode !== 'sculpt') {
      this.modal = {
        type: 'box',
        rect: { x0: this.pointer.startX, y0: this.pointer.startY, x1: p.x, y1: p.y },
        extend: e.shiftKey,
        subtract: e.ctrlKey,
      };
      this.emit('modal');
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const wasDown = this.pointer.down;
    const dragging = this.pointer.dragging;
    const consumed = this.pressConsumed;
    this.pointer.down = false;
    this.pointer.dragging = false;
    this.pressConsumed = false;
    this.navMode = null;
    if (this.stroke) {
      this.endStroke();
      return;
    }
    if (this.modal?.type === 'box') {
      this.applyBoxSelect();
      this.modal = null;
      this.emit('modal');
      this.requestRender();
      return;
    }
    if (!wasDown || dragging || consumed || e.button !== 0) return;

    const p = this.localPointer(e);
    if (this.mode === 'sculpt') return;
    if (this.mode === 'edit') {
      if (e.altKey) this.selectLoopAt(p.x, p.y, e.shiftKey);
      else this.selectElementAt(p.x, p.y, e.shiftKey);
    } else {
      const hit = pickObject(this.scene, this.camera, p.x, p.y, this.viewport());
      this.selectObject(hit ? hit.object.id : null, e.shiftKey);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.modal?.type === 'transform' && this.proportional.enabled && this.mode === 'edit') {
      this.setProportionalRadius(this.proportional.radius * (e.deltaY < 0 ? 1 / 1.12 : 1.12));
      return;
    }
    if (this.modal?.type === 'bevel') {
      const b = this.modal.state;
      b.segments = Math.max(1, Math.min(32, b.segments + (e.deltaY < 0 ? 1 : -1)));
      this.applyBevel();
      this.emit('modal');
      return;
    }
    if (this.mode === 'sculpt' && (e.ctrlKey || e.metaKey)) {
      this.adjustBrushRadius(e.deltaY < 0 ? 1 / 1.1 : 1.1);
      return;
    }
    if (this.modal?.type === 'loopcut') {
      this.modal.cuts = Math.max(1, Math.min(64, this.modal.cuts + (e.deltaY < 0 ? 1 : -1)));
      this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
      this.emit('modal');
      return;
    }
    // Zoom towards the cursor rather than the middle of the screen: the point
    // you are scrolling at is the point you mean, and zooming about the pivot
    // instead slides it away as you approach.
    const p = this.localPointer(e);
    this.applyNavGesture(wheelGesture(e, modifiersOf(e), this.canvas.clientHeight), p);
  }

  /** Move the camera the way a navigation gesture asks. */
  private applyNavGesture(g: NavGesture, at?: { x: number; y: number }): void {
    switch (g.kind) {
      case 'orbit': this.camera.orbit(g.dx, g.dy); break;
      case 'pan': this.camera.pan(g.dx, g.dy, this.canvas.clientHeight); break;
      case 'zoom': {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (at && w > 0 && h > 0) {
          this.camera.zoomAt(g.amount, (at.x / w) * 2 - 1, 1 - (at.y / h) * 2, w / h);
        } else {
          this.camera.zoom(g.amount);
        }
        break;
      }
    }
    this.requestRender();
  }

  private syncModifierKeys(e: PointerEvent | KeyboardEvent | WheelEvent): void {
    this.keys.shift = e.shiftKey;
    this.keys.ctrl = e.ctrlKey || e.metaKey;
    this.keys.alt = e.altKey;
  }

  /** Feed a keyboard event from the document. Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    this.syncModifierKeys(e);
    if (this.modal) return this.handleModalKey(e);
    return false;
  }

  private handleModalKey(e: KeyboardEvent): boolean {
    const m = this.modal;
    if (!m) return false;
    const key = e.key;
    if (key === 'Escape') {
      this.cancelModal();
      return true;
    }
    if (key === 'Enter' || key === ' ') {
      this.confirmModal();
      return true;
    }
    if (m.type === 'transform') {
      const axisIndex = { x: 0, y: 1, z: 2 }[key.toLowerCase()];
      if (axisIndex !== undefined) {
        m.session.setAxis(axisIndex, e.shiftKey);
        this.applyTransform(m.session.update(this.pointer.x, this.pointer.y));
        return true;
      }
      if (m.session.typeChar(key === 'Backspace' ? 'Backspace' : key)) {
        this.applyTransform(m.session.update(this.pointer.x, this.pointer.y));
        return true;
      }
    }
    if (m.type === 'bevel') {
      if (key === 'ArrowUp' || key === '+') {
        m.state.segments = Math.min(32, m.state.segments + 1);
        this.applyBevel();
        return true;
      }
      if (key === 'ArrowDown' || key === '-') {
        m.state.segments = Math.max(1, m.state.segments - 1);
        this.applyBevel();
        return true;
      }
      if (key === 'p' || key === 'P') {
        // Cycle the profile between chamfer, round and crease.
        m.state.profile = m.state.profile >= 0.99 ? 0 : m.state.profile < 0.05 ? 0.5 : 1;
        this.applyBevel();
        return true;
      }
    }
    if (m.type === 'loopcut') {
      if (key === 'ArrowUp' || key === '+') {
        m.cuts = Math.min(64, m.cuts + 1);
        this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
        return true;
      }
      if (key === 'ArrowDown' || key === '-') {
        m.cuts = Math.max(1, m.cuts - 1);
        this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
        return true;
      }
    }
    return true; // swallow everything else while modal
  }

  /** Ctrl inverts whatever the snap toggle is set to, the way Blender does it. */
  private snappingActive(ctrl: boolean): boolean {
    return this.snap.enabled !== ctrl;
  }

  private updateSnapping(session: TransformSession, x: number, y: number, ctrl: boolean): void {
    session.snapPoint = null;
    session.gridStep = 0;
    if (!this.snappingActive(ctrl) || session.kind !== 'translate') return;
    if (this.snap.mode === 'increment') return;
    if (this.snap.mode === 'grid') {
      session.gridStep = this.snap.increment;
      return;
    }
    const exclude = new Set<number>();
    if (this.mode === 'edit' && this.editObjectId !== null) exclude.add(this.editObjectId);
    else for (const id of this.scene.selection) exclude.add(id);
    session.snapPoint = snapPointUnderCursor(
      this.scene, this.camera, x, y, this.viewport(), this.snap.mode, exclude,
    );
  }

  /**
   * Change the proportional radius mid-drag. The weight set has to be rebuilt,
   * which means putting the already-moved vertices back first.
   */
  setProportionalRadius(radius: number): void {
    this.proportional.radius = Math.max(0.001, Math.min(1e5, radius));
    if (this.modal?.type === 'transform' && this.modal.snapshot.verts) {
      const mesh = this.editMesh;
      if (mesh) {
        for (const v of this.modal.snapshot.verts) mesh.positions[v.index] = v.position.clone();
        const fresh = this.captureTransform();
        if (fresh) this.modal.snapshot = fresh;
      }
      this.applyTransform(this.modal.session.update(this.pointer.x, this.pointer.y));
    }
    this.setStatus(`Proportional radius ${this.proportional.radius.toFixed(3)}`);
    this.emit('modal');
    this.requestRender();
  }

  toggleProportional(): void {
    this.proportional.enabled = !this.proportional.enabled;
    if (this.modal?.type === 'transform') this.setProportionalRadius(this.proportional.radius);
    this.setStatus(`Proportional editing ${this.proportional.enabled ? 'on' : 'off'}`);
    this.emit('change');
    this.requestRender();
  }

  /** Track where the brush would land, for the viewport ring. */
  private updateBrushCursor(x: number, y: number): void {
    const hit = this.sculptHit(x, y);
    const obj = this.sculptObject;
    if (!hit || !obj) {
      if (this.brushCursor) {
        this.brushCursor = null;
        this.requestRender();
      }
      return;
    }
    const model = obj.worldMatrix(this.scene);
    this.brushCursor = {
      center: model.transformPoint(hit.local),
      normal: model.normalMatrix().transformDirection(hit.normal).normalized(),
      radius: this.sculpt.radius,
    };
    this.requestRender();
  }

  get pointerPosition(): { x: number; y: number } {
    return { x: this.pointer.x, y: this.pointer.y };
  }
}
