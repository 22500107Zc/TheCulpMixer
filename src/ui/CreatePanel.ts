import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { SceneObject } from '../scene/Scene';
import { Mesh } from '../mesh/Mesh';
import { Bitmap, MaskChannel, MaskOptions, denoiseMask, maskFromBitmap, splitComponents, suggestMaskOptions, traceContours, simplifyContours } from '../imaging/contour';
import {
  HeightfieldOptions, LatheOptions, SilhouetteOptions,
  meshFromHeightfield, meshFromLathe, meshFromSilhouette,
} from '../imaging/generate';
import { PhotoOptions, PhotoResult, meshFromPhoto } from '../imaging/photo';
import { decodeDepth, encodeDepth, estimateDepth, patchAligned } from '../imaging/neuralDepth';
import { meshFromDepth } from '../imaging/sceneDepth';
import { DepthField, DepthOptions, depthFromPhoto } from '../imaging/depth';
import {
  HINT_BACKGROUND, HINT_NONE, HINT_SUBJECT, MIN_SEPARATION, Matte, segmentSubject,
} from '../imaging/segment';
import { createTexture } from '../scene/Texture';
import { createMaterial } from '../scene/Material';
import {
  Reference, bitmapFromReference, blobFromReference, drawReferenceInto, isSupportedFile,
  loadReference, referenceFromDataUrl, releaseReference, seekVideo, textureFromReference,
} from '../imaging/load';
import { BackendInfo, generateMesh, probeBackend, storeEndpoint, storedEndpoint } from '../ai/client';
import { assetRootFor } from '../editor/revision';
import {
  GENERATOR_VERSION, PROVENANCE_SCHEMA, ParamValue, ReferenceOrigin, newAssetId,
} from '../build/provenance';
import { ProposedPart, sameMesh } from '../build/merge';
import { button, checkbox, clear, h, numberField, row, select } from './dom';

type Mode = 'photo' | 'scene' | 'silhouette' | 'lathe' | 'relief';

/**
 * The part key a reference-built model carries.
 *
 * One mesh, so one part — but it still needs a key, because that is what the
 * merge matches on and what the comparison pairs by when a rebuild gives the
 * object a new id.
 */
const REFERENCE_PART = 'surface#1';

const MODES: { id: Mode; label: string; blurb: string }[] = [
  {
    id: 'photo',
    label: 'Photo',
    blurb: 'Find the subject by colour, inflate it to its own thickness, and project the photo back on. '
      + 'The far side is the near side, shallower — a photograph does not contain the back.',
  },
  {
    id: 'scene',
    label: 'Whole Scene',
    blurb: 'Read the distance to everything in the picture with a depth network that runs on this '
      + 'machine, and build the surface it describes. For photographs that have no single subject '
      + 'to cut out — a room, a street, somebody standing in front of something. Correct in front, '
      + 'hollow behind: one photograph cannot see round anything.',
  },
  { id: 'silhouette', label: 'Cut Out', blurb: 'Trace the outline and extrude it into a flat solid.' },
  { id: 'lathe', label: 'Turn', blurb: 'Spin the profile around a vertical axis.' },
  { id: 'relief', label: 'Relief', blurb: 'Raise the surface by image brightness.' },
];

/**
 * Drop in a photo or a video frame and get geometry back.
 *
 * The object is built the moment a file lands, then rebuilt in place as the
 * settings change, so the reference and the mesh stay side by side instead of
 * the panel being a one-shot import dialog.
 */
export class CreatePanel {
  readonly root = h('div', { class: 'create-panel' });

  private reference: Reference | null = null;
  private bitmap: Bitmap | null = null;
  private mode: Mode = 'photo';
  /** Settings for the depth-network route. */
  private scene = {
    resolution: 220,
    targetWidth: 3,
    relief: 1.1,
    cut: 0.06,
    smoothing: 1,
    /** Square side handed to the network; a multiple of its 14px patch. */
    modelSize: 392,
    texture: true,
  };
  private sceneRunning = false;
  /** The last depth map read for this frame, cached into the record. */
  private sceneDepth: { width: number; height: number; data: Float32Array; ms: number } | null = null;
  private sceneNote = h('p', { class: 'dim small' });
  private targetId: number | null = null;
  /** The name this panel gave the target, so a user rename is never clobbered. */
  private assignedName = '';
  private frameTime = 0;
  private busy = false;
  private pending = false;

  private mask: Required<Pick<MaskOptions, 'channel' | 'threshold' | 'invert'>> = {
    channel: 'luma', threshold: 0.5, invert: false,
  };
  private silhouette: Required<Pick<SilhouetteOptions, 'depth' | 'targetHeight' | 'simplify' | 'denoise' | 'maxParts' | 'bevel'>>
    & { texture: boolean } = {
      depth: 0.4, targetHeight: 2, simplify: 1.2, denoise: 1, maxParts: 8, bevel: 0, texture: true,
    };
  private lathe: Required<Pick<LatheOptions, 'segments' | 'targetHeight' | 'axis' | 'side' | 'smooth'>> = {
    segments: 48, targetHeight: 2, axis: 0.5, side: 'widest', smooth: true,
  };
  private relief: Required<Pick<HeightfieldOptions, 'resolution' | 'size' | 'height' | 'invert' | 'solid' | 'smooth'>> = {
    resolution: 128, size: 2, height: 0.35, invert: false, solid: false, smooth: true,
  };
  private photo: Required<Pick<PhotoOptions, 'resolution' | 'targetHeight' | 'depthScale' | 'back'>>
    & Required<Pick<DepthOptions, 'volume' | 'detail' | 'symmetry'>> & { texture: boolean } = {
      resolution: 160, targetHeight: 2, depthScale: 1, back: 0.8,
      volume: 1, detail: 0.35, symmetry: 0.5, texture: true,
    };
  /**
   * Finding the subject and solving its thickness cost a few hundred
   * milliseconds and depend on neither the grid resolution nor the target
   * height. Cached against the settings that do change them, so dragging a
   * slider rebuilds the mesh and nothing else.
   */
  private matte: { key: string; value: Matte } | null = null;
  /**
   * The user's corrections to the subject, one byte per pixel of `bitmap`.
   *
   * Null until they pick up the brush, so an untouched photograph is
   * segmented exactly as it was before this existed.
   */
  private hints: Uint8Array | null = null;
  /** What the brush paints, and how wide, in source pixels. */
  private brush: { mode: 'subject' | 'background' | 'erase'; radius: number } =
    { mode: 'subject', radius: 14 };
  /** Set while a stroke is in progress, so the model is rebuilt once at the end. */
  private painting = false;
  /** Bumped by every stroke, so the cached matte knows it is out of date. */
  private hintRevision = 0;
  /** Where the picture sits inside the preview, for turning clicks into pixels. */
  private previewPlacement: { x: number; y: number; width: number; height: number } | null = null;

  /**
   * Paint one dab of the current brush at a point on the source image.
   *
   * Erase writes HINT_NONE rather than the opposite mark: a correction taken
   * back should hand the decision to the colour models again, not assert the
   * reverse.
   */
  private paintHint(px: number, py: number): void {
    const bitmap = this.bitmap;
    if (!bitmap) return;
    if (!this.hints) this.hints = new Uint8Array(bitmap.width * bitmap.height);
    const value = this.brush.mode === 'subject'
      ? HINT_SUBJECT
      : this.brush.mode === 'background' ? HINT_BACKGROUND : HINT_NONE;
    const r = this.brush.radius;
    const x0 = Math.max(0, Math.floor(px - r));
    const x1 = Math.min(bitmap.width - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r));
    const y1 = Math.min(bitmap.height - 1, Math.ceil(py + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - px) ** 2 + (y - py) ** 2 > r * r) continue;
        this.hints[y * bitmap.width + x] = value;
      }
    }
  }

  /** Throw every correction away and go back to what the colours alone say. */
  private clearHints(): void {
    if (!this.hints) return;
    this.hints = null;
    this.hintRevision++;
    this.generate(true);
  }

  /**
   * The threshold settings with the user's corrections attached.
   *
   * Cut Out and Turned find their subject with a brightness threshold, which
   * cannot tell a dark subject from a dark background at all. The brush was
   * built for the photo route; there is no reason the blunter routes should
   * not have it too, and it is the only answer they have when the histogram
   * simply does not separate the two.
   */
  private maskOptions(): MaskOptions {
    return this.hints ? { ...this.mask, hints: this.hints } : { ...this.mask };
  }

  /** Whether anything has been marked, for the buttons that undo it. */
  private hasHints(): boolean {
    if (!this.hints) return false;
    for (let i = 0; i < this.hints.length; i++) if (this.hints[i] !== HINT_NONE) return true;
    return false;
  }
  private depthField: { key: string; value: DepthField } | null = null;
  /** The texture id already made for this reference, so retries do not pile up copies. */
  private photoTexture: { key: string; id: number } | null = null;
  /**
   * The source image kept purely so the asset can be rebuilt later.
   *
   * Separate from `photoTexture`, which exists to shade the model: turning the
   * texture off is a look, not a decision to throw the original away.
   */
  private sourceTexture: { key: string; id: number } | null = null;
  /**
   * The material slot this panel made, and which object it made it for.
   *
   * Kept because the object is rebuilt on every settings change, and a fresh
   * material each time would mean one per slider event — hundreds of them in
   * the material list and in the saved file, all identical, all but one
   * unused.
   */
  private photoMaterial: { objectId: number; slot: number } | null = null;
  /** Whether the viewport has already been switched over to show a photograph. */
  private revealedTexture = false;
  /** Fraction of the frame the last photo build found as subject. */
  private lastCoverage = 0;
  /** Pending debounced photo rebuild, if a slider is mid-drag. */
  private photoTimer: number | null = null;

  private endpoint = storedEndpoint();
  private backend: BackendInfo | null = null;
  private backendModel = '';
  private aiPrompt = '';
  private aiRunning: AbortController | null = null;
  /** Whether a probe has run, so the rebuild does not clobber its message. */
  private aiChecked = false;
  private aiStatus = h('span', { class: 'ai-status', text: 'not checked' });
  private aiNote = h('p', { class: 'dim small' });

  private preview = h('canvas', { class: 'ref-preview' });
  private body = h('div', { class: 'create-body' });
  private statsLine = h('p', { class: 'dim small create-stats' });
  /** The plain answer to "did it find the thing", above the numbers. */
  private verdict = h('p', { class: 'create-verdict hidden' });

  constructor(private editor: Editor) {
    this.root.append(this.body);
    // The preview element survives every rebuild of the panel, so its pointer
    // handlers are attached once here rather than in build().
    this.wirePreviewBrush();
    this.build();
  }

  /** Accept a file from the drop target or the file picker. */
  async loadFile(file: File): Promise<void> {
    if (!isSupportedFile(file)) {
      this.editor.setStatus(`${file.name} is not an image or a video`);
      return;
    }
    this.editor.setStatus(`Reading ${file.name}…`);
    try {
      const reference = await loadReference(file);
      releaseReference(this.reference);
      this.reference = reference;
      this.frameTime = 0;
      this.targetId = null;
      this.assignedName = '';
      if (reference.kind === 'video' && reference.duration > 0) {
        // The first frame of a video is often black; a little way in is safer.
        this.frameTime = Math.min(reference.duration * 0.1, 1);
        await seekVideo(reference.element as HTMLVideoElement, this.frameTime);
      }
      this.sampleFrame();
      const suggested = suggestMaskOptions(this.bitmap!);
      this.mask = {
        channel: (suggested.channel ?? 'luma') as MaskChannel,
        threshold: suggested.threshold ?? 0.5,
        invert: suggested.invert ?? false,
      };
      this.build();
      this.generate(true);
    } catch (err) {
      this.editor.setStatus((err as Error).message);
    }
  }

  dispose(): void {
    if (this.photoTimer !== null) {
      clearTimeout(this.photoTimer);
      this.photoTimer = null;
    }
    releaseReference(this.reference);
    this.reference = null;
  }

  private sampleFrame(): void {
    if (!this.reference) return;
    // Photo mode reads colour and shading rather than tracing an outline, and
    // it now fits its grid to the subject rather than to the frame — so a
    // sharper source buys detail in the model instead of just costing time.
    const detail = this.mode === 'photo' ? 512 : this.mode === 'relief' ? 512 : 384;
    this.bitmap = bitmapFromReference(this.reference, detail);
    this.matte = null;
    this.hints = null;
    this.depthField = null;
  }

  // ------------------------------------------------------------------- build

  private build(): void {
    clear(this.body);
    if (!this.reference) {
      // A saved reference model is selected and the panel is empty: offer to
      // pick it up rather than making somebody find the original photograph
      // again. Offered rather than done, because adopting replaces whatever is
      // loaded and that should be a decision.
      const saved = this.savedAssetInSelection();
      if (saved) this.body.appendChild(this.adoptZone(saved));
      this.body.appendChild(this.dropZone());
      return;
    }
    this.body.appendChild(this.referenceSection());
    this.body.appendChild(this.modeSection());
    this.body.appendChild(this.settingsSection());
    this.body.appendChild(this.actionsSection());
    this.body.appendChild(this.aiSection());
    this.drawPreview();
  }

  /** The selected object, when it is a reference model this panel could reopen. */
  private savedAssetInSelection(): SceneObject | null {
    const scene = this.editor.scene;
    const obj = scene.activeObject ?? scene.selectedObjects()[0] ?? null;
    const root = assetRootFor(scene, obj);
    if (!root || root.provenance?.source !== 'reference') return null;
    return root.id === this.targetId && this.reference ? null : root;
  }

  private adoptZone(asset: SceneObject): HTMLElement {
    const prov = asset.provenance!;
    const stored = prov.reference?.textureId !== null && !prov.reference?.missing;
    return h('section', { class: 'prop-section' }, [
      h('h3', { class: 'prop-heading', text: `"${asset.name}" was built from a picture` }),
      h('p', { class: 'dim small', text: stored
        ? `Its picture (${prov.reference?.name ?? 'unknown'}) and settings are stored in this `
          + 'project, so it can be reopened and revised without the original file.'
        : `Its picture (${prov.reference?.name ?? 'unknown'}) is not stored in this project, so `
          + 'it cannot be rebuilt. Drop the original in to work from it again.' }),
      stored
        ? h('div', { class: 'btn-row' }, [
          button('Reopen its settings', () => { void this.adoptAsset(asset); }, {
            class: 'primary', title: 'Load the picture and settings this object was built with',
          }),
        ])
        : null,
    ].filter((e) => e !== null) as HTMLElement[]);
  }

  private dropZone(): HTMLElement {
    const input = h('input', { type: 'file', class: 'hidden-input' });
    input.accept = 'image/*,video/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.loadFile(file);
    });

    const zone = h('div', {
      class: 'drop-zone',
      on: { click: () => input.click() },
    }, [
      h('div', { class: 'drop-mark', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 15l5-5 4 4 3-3 6 6"/><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>' }),
      h('p', { class: 'drop-title', text: 'Drop an image or a video' }),
      h('p', { class: 'dim small', text: 'Or click to choose a file. It is read on this machine and never uploaded.' }),
      input,
    ]);
    return zone;
  }

  private referenceSection(): HTMLElement {
    const ref = this.reference!;
    const section = h('section', { class: 'prop-section' }, [
      h('div', { class: 'ref-head' }, [
        h('span', { class: 'ref-name', text: ref.name, title: ref.name }),
        h('button', {
          class: 'icon-btn small', text: '✕', title: 'Clear the reference',
          on: {
            click: () => {
              releaseReference(this.reference);
              this.reference = null;
              this.bitmap = null;
              this.targetId = null;
              this.assignedName = '';
              this.build();
            },
          },
        }),
      ]),
      this.preview,
      h('p', { class: 'dim small', text: `${ref.width}×${ref.height}${ref.kind === 'video' ? ` · ${ref.duration.toFixed(1)}s` : ''}` }),
    ]);

    if (ref.kind === 'video' && ref.duration > 0) {
      const slider = h('input', {
        type: 'range', class: 'slider',
        min: '0', max: ref.duration.toFixed(3), step: '0.01', value: `${this.frameTime}`,
      });
      const label = h('span', { class: 'mono small', text: `${this.frameTime.toFixed(2)}s` });
      let queued = false;
      const scrub = async (commit: boolean): Promise<void> => {
        if (queued) return;
        queued = true;
        this.frameTime = parseFloat(slider.value);
        label.textContent = `${this.frameTime.toFixed(2)}s`;
        await seekVideo(ref.element as HTMLVideoElement, this.frameTime);
        queued = false;
        this.sampleFrame();
        this.drawPreview();
        if (commit) this.generate(false);
      };
      slider.addEventListener('input', () => void scrub(false));
      slider.addEventListener('change', () => void scrub(true));
      section.appendChild(h('div', { class: 'scrub-row' }, [
        h('span', { class: 'prop-label', text: 'Frame' }), slider, label,
      ]));
    }
    return section;
  }

  private modeSection(): HTMLElement {
    const group = h('div', { class: 'mode-group' });
    for (const m of MODES) {
      group.appendChild(h('button', {
        class: `mode-btn${this.mode === m.id ? ' active' : ''}`,
        title: m.blurb,
        text: m.label,
        on: {
          click: () => {
            if (this.mode === m.id) return;
            this.mode = m.id;
            this.sampleFrame();
            this.build();
            // A different generator makes a very different shape, so refit the
            // view rather than leaving the camera inside the new object.
            this.generate(true, true);
          },
        },
      }));
    }
    return h('section', { class: 'prop-section' }, [
      group,
      h('p', { class: 'dim small', text: MODES.find((m) => m.id === this.mode)!.blurb }),
    ]);
  }

  private settingsSection(): HTMLElement {
    const section = h('section', { class: 'prop-section' }, [
      h('h3', { class: 'prop-heading', text: 'Settings' }),
    ]);

    const num = (
      label: string, value: number, step: number,
      set: (v: number) => void, opts: { min?: number; max?: number; precision?: number } = {},
    ): void => {
      section.appendChild(row(label, numberField({
        label: '', value, step, min: opts.min, max: opts.max, precision: opts.precision ?? 2,
        onLive: (v) => { set(v); this.generate(false); },
        onChange: (v) => { set(v); this.generate(true); },
      })));
    };
    const toggle = (label: string, value: boolean, set: (v: boolean) => void): void => {
      section.appendChild(checkbox(label, value, (v) => { set(v); this.generate(true); }));
    };

    if (this.mode !== 'relief' && this.mode !== 'photo') {
      section.appendChild(row('Detect', select(
        [
          { value: 'luma', label: 'Brightness' },
          { value: 'alpha', label: 'Transparency' },
          { value: 'red', label: 'Red channel' },
          { value: 'green', label: 'Green channel' },
          { value: 'blue', label: 'Blue channel' },
        ],
        this.mask.channel,
        (v) => { this.mask.channel = v as MaskChannel; this.generate(true); },
      )));
      num('Threshold', this.mask.threshold, 0.01, (v) => { this.mask.threshold = v; }, { min: 0, max: 1 });
      toggle('Subject is darker', this.mask.invert, (v) => { this.mask.invert = v; });
    }

    if (this.mode === 'photo') {
      num('Detail', this.photo.resolution, 8, (v) => { this.photo.resolution = Math.round(v); }, { min: 24, max: 400, precision: 0 });
      num('Height', this.photo.targetHeight, 0.05, (v) => { this.photo.targetHeight = v; }, { min: 0.01 });
      num('Roundness', this.photo.volume, 0.05, (v) => { this.photo.volume = v; }, { min: 0, max: 2 });
      num('Surface relief', this.photo.detail, 0.05, (v) => { this.photo.detail = v; }, { min: 0, max: 1 });
      num('Even out the sides', this.photo.symmetry, 0.05, (v) => { this.photo.symmetry = v; }, { min: 0, max: 1 });
      num('Thickness', this.photo.depthScale, 0.05, (v) => { this.photo.depthScale = v; }, { min: 0.02, max: 4 });
      num('Back fullness', this.photo.back, 0.05, (v) => { this.photo.back = v; }, { min: 0, max: 1 });
      toggle('Project the photo on as a texture', this.photo.texture, (v) => { this.photo.texture = v; });
      section.appendChild(this.brushControls());
    } else if (this.mode === 'scene') {
      num('Detail', this.scene.resolution, 10, (v) => { this.scene.resolution = Math.round(v); },
        { min: 16, max: 512, precision: 0 });
      num('Width', this.scene.targetWidth, 0.1, (v) => { this.scene.targetWidth = v; }, { min: 0.1 });
      num('Depth', this.scene.relief, 0.05, (v) => { this.scene.relief = v; }, { min: 0.01, max: 6 });
      num('Break at edges', this.scene.cut, 0.01, (v) => { this.scene.cut = v; }, { min: 0.01, max: 1 });
      num('Smoothing', this.scene.smoothing, 1, (v) => { this.scene.smoothing = Math.round(v); },
        { min: 0, max: 8, precision: 0 });
      num('Model detail', this.scene.modelSize, 14, (v) => { this.scene.modelSize = patchAligned(v); },
        { min: 112, max: 644, precision: 0 });
      toggle('Project the photo on as a texture', this.scene.texture, (v) => { this.scene.texture = v; });
      section.appendChild(h('div', { class: 'btn-row' }, [
        button(this.sceneRunning ? 'Reading the picture…' : 'Build the scene', () => {
          if (this.sceneRunning) return;
          void this.runSceneDepth();
        }, { class: 'primary', title: 'Estimate depth for the whole frame and build the surface' }),
      ]));
      section.appendChild(this.sceneNote);
      if (!this.sceneRunning && !this.sceneNote.textContent) {
        this.sceneNote.textContent =
          'The depth model is 26MB and loads the first time you use it. It runs here — nothing '
          + 'about your picture leaves this machine.';
      }
    } else if (this.mode === 'silhouette') {
      num('Depth', this.silhouette.depth, 0.02, (v) => { this.silhouette.depth = v; }, { min: 0.001 });
      num('Height', this.silhouette.targetHeight, 0.05, (v) => { this.silhouette.targetHeight = v; }, { min: 0.01 });
      num('Smoothing', this.silhouette.simplify, 0.1, (v) => { this.silhouette.simplify = v; }, { min: 0, max: 12 });
      num('Clean up', this.silhouette.denoise, 1, (v) => { this.silhouette.denoise = Math.round(v); }, { min: 0, max: 5, precision: 0 });
      num('Bevel', this.silhouette.bevel, 0.01, (v) => { this.silhouette.bevel = v; }, { min: 0, max: 0.45 });
      num('Max parts', this.silhouette.maxParts, 1, (v) => { this.silhouette.maxParts = Math.round(v); }, { min: 1, max: 64, precision: 0 });
      toggle('Project the photo on as a texture', this.silhouette.texture, (v) => { this.silhouette.texture = v; });
      section.appendChild(this.brushControls());
    } else if (this.mode === 'lathe') {
      num('Segments', this.lathe.segments, 1, (v) => { this.lathe.segments = Math.round(v); }, { min: 3, max: 256, precision: 0 });
      num('Height', this.lathe.targetHeight, 0.05, (v) => { this.lathe.targetHeight = v; }, { min: 0.01 });
      num('Axis', this.lathe.axis, 0.01, (v) => { this.lathe.axis = v; }, { min: 0, max: 1 });
      section.appendChild(row('Profile', select(
        [
          { value: 'widest', label: 'Widest side' },
          { value: 'left', label: 'Left of axis' },
          { value: 'right', label: 'Right of axis' },
        ],
        this.lathe.side,
        (v) => { this.lathe.side = v as 'widest' | 'left' | 'right'; this.generate(true); },
      )));
      toggle('Smooth shading', this.lathe.smooth, (v) => { this.lathe.smooth = v; });
      section.appendChild(this.brushControls());
    } else {
      num('Resolution', this.relief.resolution, 8, (v) => { this.relief.resolution = Math.round(v); }, { min: 8, max: 512, precision: 0 });
      num('Size', this.relief.size, 0.1, (v) => { this.relief.size = v; }, { min: 0.05 });
      num('Depth', this.relief.height, 0.02, (v) => { this.relief.height = v; }, { min: 0 });
      toggle('Invert', this.relief.invert, (v) => { this.relief.invert = v; });
      toggle('Solid block', this.relief.solid, (v) => { this.relief.solid = v; });
      toggle('Smooth shading', this.relief.smooth, (v) => { this.relief.smooth = v; });
    }

    section.appendChild(this.verdict);
    section.appendChild(this.statsLine);
    return section;
  }

  private actionsSection(): HTMLElement {
    const target = this.editor.scene.get(this.targetId);
    const revisable = !!target?.provenance;
    return h('section', { class: 'prop-section' }, [
      h('div', { class: 'btn-row' }, [
        button('Add as New Object', () => {
          this.targetId = null;
          this.assignedName = '';
          this.generate(true);
        }, { title: 'Keep the current result and build another from the same reference' }),
        // Sliders rebuild in place while the model is still exactly what the
        // settings produce — there is nothing to lose, and asking someone to
        // confirm every tick of a slider would be absurd. This is the other
        // half: once you have made the object yours, or once you want to see
        // what a change would do before it does it, the same settings go
        // through the same review as every other revision.
        revisable
          ? button('Preview as Revision', () => this.reviseFromSettings(), {
            title: 'Rebuild with these settings, previewing what it keeps and what it conflicts with',
          })
          : null,
        button('Frame', () => this.editor.frameSelected(), { title: 'Zoom the viewport to the result' }),
      ]),
      h('p', {
        class: 'dim small',
        text: 'Tweaks rebuild the object in place while it is still what these settings made. '
          + 'Once you have edited it, a rebuild becomes a revision you can review first — '
          + 'a rebuild replaces every vertex, so sculpting, UVs and painting on it cannot come across.',
      }),
    ]);
  }

  /**
   * Rebuild with the current settings, as a reviewable revision.
   *
   * The same generator and the same merge as everything else. What makes this
   * worth its own button is that it works even when nothing is at risk: seeing
   * what a change would do before agreeing to it is useful in its own right,
   * not only as a rescue.
   */
  private reviseFromSettings(): void {
    const object = this.editor.scene.get(this.targetId);
    if (!object || !this.bitmap) return;
    if (this.mode === 'scene') {
      // Rebuilt from the stored depth map rather than from the network. The
      // slow half already happened, once, and its answer is in the file.
      const cached = this.sceneDepth
        ?? decodeDepth(this.editor.scene.get(this.targetId)?.provenance?.params.depth);
      if (!cached) {
        this.statsLine.textContent = 'No depth reading is stored for this object. '
          + 'Press "Build the scene" to read the picture again.';
        return;
      }
      const rebuilt = meshFromDepth(this.bitmap, cached, {
        resolution: this.scene.resolution,
        targetWidth: this.scene.targetWidth,
        relief: this.scene.relief,
        cut: this.scene.cut,
        smoothing: this.scene.smoothing,
      });
      if (rebuilt.mesh.faceCount === 0) {
        this.statsLine.textContent = 'These settings leave no surface to build.';
        return;
      }
      this.sceneDepth = cached;
      this.stageProposal(object, rebuilt.mesh);
      return;
    }
    const result = this.buildMesh();
    if (result.mesh.faceCount === 0) {
      this.statsLine.textContent = 'Nothing found at this threshold, so there is nothing to revise to.';
      return;
    }
    this.stageProposal(object, result.mesh);
  }

  /** Offer a rebuilt mesh as a revision of this object, and say what it costs. */
  private stageProposal(object: SceneObject, mesh: Mesh): void {
    const proposed: ProposedPart[] = [{
      key: REFERENCE_PART,
      name: object.name,
      position: object.position.toArray(),
      rotation: object.rotation.toArray(),
      scale: object.scale.toArray(),
      mesh: mesh.toJSON(),
    }];
    const edited = !sameMesh(
      object.provenance?.baseline.parts?.[0]?.mesh ?? null,
      object.mesh ? object.mesh.toJSON() : null,
    );
    const summary = this.editor.revision.preview(
      object,
      proposed,
      `Rebuild ${object.name} from ${this.reference?.name ?? 'the reference'}`,
      edited
        ? ['You have edited this model since it was built. A rebuild replaces every vertex — '
          + 'choosing the rebuilt shape carries your UVs, vertex colours, weights and sculpt '
          + 'mask across by nearest surface point, and says how well they landed.']
        : ['Its placement, material, modifiers and animation are kept — a rebuild only replaces '
          + 'the geometry.'],
      { params: this.settingsForMode(), reference: this.referenceOrigin() },
    );
    if (summary) this.statsLine.textContent = `${summary.headline} — accept or reject it.`;
  }

  /**
   * Hand the frame to a local image-to-3D model, if one is running. The whole
   * feature is opt-in and points at 127.0.0.1 by default: no endpoint, no
   * network traffic.
   */
  private aiSection(): HTMLElement {
    const section = h('section', { class: 'prop-section ai-section' }, [
      h('h3', { class: 'prop-heading' }, [
        h('span', { text: 'Local AI model' }),
        this.aiStatus,
      ]),
    ]);

    const input = h('input', { class: 'text-input', type: 'text', value: this.endpoint });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      this.endpoint = input.value.trim() || this.endpoint;
      storeEndpoint(this.endpoint);
      void this.checkBackend();
    });
    section.appendChild(row('Server', input));

    if (this.backend && this.backend.models.length > 1) {
      section.appendChild(row('Model', select(
        this.backend.models.map((m) => ({ value: m, label: m })),
        this.backendModel || this.backend.models[0],
        (v) => { this.backendModel = v; },
      )));
    }

    const prompt = h('input', {
      class: 'text-input', type: 'text', value: this.aiPrompt,
      placeholder: 'optional hint, if the model takes one',
    });
    prompt.addEventListener('keydown', (e) => e.stopPropagation());
    prompt.addEventListener('input', () => { this.aiPrompt = prompt.value; });
    section.appendChild(row('Prompt', prompt));

    section.appendChild(h('div', { class: 'btn-row' }, [
      button(this.aiRunning ? 'Cancel' : 'Generate 3D', () => {
        if (this.aiRunning) {
          this.aiRunning.abort();
          return;
        }
        void this.runBackend();
      }, { class: this.aiRunning ? '' : 'primary', title: 'Send this frame to the local model' }),
      button('Check', () => void this.checkBackend(), { title: 'See whether a server is listening' }),
    ]));
    section.appendChild(this.aiNote);
    if (!this.aiChecked && !this.aiRunning) {
      this.aiNote.textContent =
        'Optional. Point this at a local image-to-3D server — tools/The Culp Mixer-ai-server.py in the repo is a working example. Everything above works without it.';
    }
    return section;
  }

  private setBackendStatus(text: string, state: 'ok' | 'bad' | 'idle' | 'busy'): void {
    this.aiStatus.textContent = text;
    this.aiStatus.className = `ai-status ${state}`;
  }

  private async checkBackend(): Promise<void> {
    this.aiChecked = true;
    this.setBackendStatus('checking…', 'busy');
    const result = await probeBackend(this.endpoint);
    if (result.ok) {
      this.backend = result.info;
      this.backendModel = this.backendModel || result.info.models[0] || '';
      this.setBackendStatus(result.info.name, 'ok');
      this.aiNote.textContent = result.info.detail ?? 'Ready.';
    } else {
      this.backend = null;
      this.setBackendStatus('offline', 'bad');
      this.aiNote.textContent = `${result.reason} at ${this.endpoint}. Start a server, or keep using the generators above.`;
    }
    this.build();
  }

  private async runBackend(): Promise<void> {
    if (!this.reference) return;
    const controller = new AbortController();
    this.aiRunning = controller;
    this.setBackendStatus('generating…', 'busy');
    this.aiNote.textContent = 'Working. This can take anywhere from seconds to minutes.';
    this.build();
    const started = Date.now();
    try {
      const image = await blobFromReference(this.reference);
      const result = await generateMesh(this.endpoint, {
        image,
        model: this.backendModel || undefined,
        prompt: this.aiPrompt || undefined,
        signal: controller.signal,
      });
      if (!this.editor.beginUndo('Generate with local model')) return;
      const object = this.editor.scene.add('mesh', result.name || 'AI Mesh', result.mesh);
      object.position = this.placementFor(result.mesh);
      this.editor.selectObject(object.id);
      this.editor.markGeometryDirty(object);
      this.editor.frameSelected();
      const seconds = result.seconds ?? (Date.now() - started) / 1000;
      this.setBackendStatus('done', 'ok');
      this.aiNote.textContent =
        `${result.mesh.faceCount.toLocaleString()} faces in ${seconds.toFixed(1)}s. It is a normal mesh now — edit it like anything else.`;
      this.editor.setStatus(`${object.name}: ${result.mesh.faceCount.toLocaleString()} faces from the local model`);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setBackendStatus(aborted ? 'cancelled' : 'failed', aborted ? 'idle' : 'bad');
      this.aiNote.textContent = aborted ? 'Cancelled.' : (err as Error).message;
    } finally {
      this.aiRunning = null;
      this.build();
    }
  }

  // ---------------------------------------------------------------- generate

  /**
   * Rebuild the target object from the current settings.
   *
   * Photo mode's analysis costs the better part of a second, and a slider
   * emits an event per pixel of travel — so a live drag would queue forty of
   * those and the panel would still be catching up a minute later. Live
   * changes wait until the dragging stops; releasing the slider rebuilds at
   * once. Everything else is fast enough to run on every event, as it did.
   */
  private generate(commit: boolean, refit = false): void {
    if (this.photoTimer !== null) {
      clearTimeout(this.photoTimer);
      this.photoTimer = null;
    }
    if (this.mode !== 'photo' || commit) {
      this.generateNow(commit, refit);
      return;
    }
    this.statsLine.textContent = 'Working…';
    this.photoTimer = setTimeout(() => {
      this.photoTimer = null;
      this.generateNow(false, refit);
    }, 160) as unknown as number;
  }

  private generateNow(commit: boolean, refit = false): void {
    if (!this.bitmap) return;
    // The depth route is not one of these. It costs seconds rather than
    // milliseconds, so it runs from its own button and never from a slider —
    // without this, nudging one of its settings would quietly build a
    // brightness relief instead, which is a different thing that looks a
    // little like the right answer.
    if (this.mode === 'scene') {
      this.drawPreview();
      return;
    }
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      const result = this.buildMesh();
      if (result.mesh.faceCount === 0) {
        this.statsLine.textContent = 'Nothing found at this threshold — try moving it, or flip "subject is darker".';
        return;
      }

      let object = this.editor.scene.get(this.targetId);
      if (!object) {
        if (commit) this.editor.beginUndo('Create from reference');
        object = this.editor.scene.add('mesh', this.nameForMode(), result.mesh);
        object.position = this.placementFor(result.mesh);
        object.partKey = REFERENCE_PART;
        this.targetId = object.id;
        this.assignedName = object.name;
        this.editor.selectObject(object.id);
        this.editor.frameSelected();
      } else if (this.stageRevision(object, result.mesh)) {
        // Somebody has edited this model since it was generated, so a rebuild
        // is a revision and goes through the same review everything else does
        // — sliding a slider must not be a way round the preservation rules.
        this.drawPreview();
        return;
      } else {
        object.mesh = result.mesh;
        // Keep the name honest as the mode changes, unless it was renamed.
        if (object.name === this.assignedName && !object.name.startsWith(this.nameForMode())) {
          object.name = this.editor.scene.uniqueName(this.nameForMode());
          this.assignedName = object.name;
        }
      }
      // The texture goes on first, so the record can say the picture is in the
      // file: an asset whose reference is embedded can be revised months later
      // with nothing but the file, and one whose is not has to say so.
      if (this.wantsTexture()) this.applyPhotoTexture(object);
      this.recordOrigin(object, result.mesh);
      this.editor.markGeometryDirty(object);
      if (refit) this.editor.frameSelected();

      const { stats } = result;
      this.statsLine.textContent =
        `${stats.verts.toLocaleString()} verts · ${stats.faces.toLocaleString()} faces · ${stats.ms} ms`;
      if (this.mode === 'photo') this.reportSubject();
      else this.verdict.classList.add('hidden');
      this.editor.setStatus(`${object.name}: ${stats.faces.toLocaleString()} faces from ${this.reference?.name ?? 'reference'}`);
      this.drawPreview();
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.generateNow(false);
      }
    }
  }

  // ------------------------------------------------------- record and revise

  /** The settings this mode was run with, as named values a revision can change. */
  private settingsForMode(): Record<string, ParamValue> {
    const base: Record<string, ParamValue> = {
      mode: this.mode,
      channel: this.mask.channel,
      threshold: this.mask.threshold,
      invert: this.mask.invert,
    };
    switch (this.mode) {
      case 'photo':
        return { ...base, ...this.photo };
      case 'scene':
        return { ...base, ...this.scene };
      case 'silhouette':
        return { ...base, ...this.silhouette };
      case 'lathe':
        return { ...base, ...this.lathe };
      default:
        return { ...base, ...this.relief };
    }
  }

  /**
   * Where the picture is, so the model can be rebuilt from the saved file.
   *
   * When the photograph is embedded as a texture the asset is self-contained
   * and a revision can run offline, months later, on another machine. When it
   * is not, that is recorded as a missing dependency by name rather than
   * discovered as a failure at the moment somebody asks for a change.
   */
  /**
   * Make sure the picture itself is in the file.
   *
   * Without it, "revise this" months later has nothing to revise from — the
   * settings survive and the thing they were settings *for* does not. It is
   * stored whether or not the photograph is being used as a texture, because
   * being able to rebuild the model is a different question from how the model
   * is shaded.
   */
  private ensureSourceStored(): number | null {
    const ref = this.reference;
    if (!ref) return null;
    if (this.photoTexture) return this.photoTexture.id;
    const key = `${ref.name}:${this.frameTime}`;
    if (this.sourceTexture?.key === key) return this.sourceTexture.id;
    try {
      const { url, width, height } = textureFromReference(ref);
      const texture = createTexture(`${ref.name.replace(/\.[^.]+$/, '')} (source)`, url, width, height);
      this.editor.scene.textures.push(texture);
      this.sourceTexture = { key, id: texture.id };
      return texture.id;
    } catch {
      return null;
    }
  }

  private referenceOrigin(): ReferenceOrigin {
    const ref = this.reference;
    return {
      textureId: this.ensureSourceStored(),
      name: ref?.name ?? 'reference',
      frameTime: this.frameTime,
      width: ref?.width ?? 0,
      height: ref?.height ?? 0,
      missing: !this.photoTexture && !this.sourceTexture,
    };
  }

  /**
   * Pick a saved reference asset back up, from the file alone.
   *
   * Everything this needs is in the document: the picture as an embedded
   * texture, the mode, the settings and the correction marks. Nothing here
   * depends on the panel having been open when the object was made, which is
   * the whole point — reopening a project a month later and changing the
   * extrusion depth is the ordinary case, not a special one.
   *
   * Nothing is regenerated by adopting. It loads the settings and stops.
   */
  async adoptAsset(object: SceneObject): Promise<boolean> {
    const prov = object.provenance;
    if (!prov || prov.source !== 'reference') return false;
    const textureId = prov.reference?.textureId ?? null;
    const texture = textureId !== null
      ? this.editor.scene.textures.find((t) => t.id === textureId)
      : undefined;
    if (!texture || !texture.url) {
      this.statsLine.textContent = `The picture "${prov.reference?.name ?? 'unknown'}" is not stored `
        + 'in this file, so this object cannot be rebuilt from it.';
      return false;
    }
    let reference: Reference;
    try {
      reference = await referenceFromDataUrl(prov.reference?.name ?? texture.name, texture.url);
    } catch (err) {
      this.statsLine.textContent = `The stored picture could not be read: ${(err as Error).message}`;
      return false;
    }

    releaseReference(this.reference);
    this.reference = reference;
    this.bitmap = bitmapFromReference(reference);
    this.frameTime = prov.reference?.frameTime ?? 0;
    this.targetId = object.id;
    this.assignedName = object.name;
    this.matte = null;
    this.depthField = null;
    this.photoTexture = null;
    this.sourceTexture = { key: `${reference.name}:${this.frameTime}`, id: texture.id };
    this.applySavedSettings(prov.params);
    this.hints = this.decodeHints(prov.params.hints, this.bitmap.width, this.bitmap.height);
    this.build();
    this.drawPreview();
    this.statsLine.textContent = `Loaded the settings "${object.name}" was built with. `
      + 'Change them and press "Preview as Revision".';
    return true;
  }

  /** Put saved settings back into the panel's controls, mode by mode. */
  private applySavedSettings(params: Record<string, ParamValue>): void {
    const mode = params.mode;
    if (mode === 'photo' || mode === 'scene' || mode === 'silhouette'
      || mode === 'lathe' || mode === 'relief') {
      this.mode = mode;
    }
    const num = (key: string, apply: (v: number) => void): void => {
      const v = params[key];
      if (typeof v === 'number' && Number.isFinite(v)) apply(v);
    };
    const bool = (key: string, apply: (v: boolean) => void): void => {
      const v = params[key];
      if (typeof v === 'boolean') apply(v);
    };
    if (typeof params.channel === 'string') this.mask.channel = params.channel as MaskChannel;
    num('threshold', (v) => { this.mask.threshold = v; });
    bool('invert', (v) => { this.mask.invert = v; });

    const target: Record<string, unknown> = this.mode === 'photo' ? this.photo
      : this.mode === 'scene' ? this.scene
        : this.mode === 'silhouette' ? this.silhouette
          : this.mode === 'lathe' ? this.lathe : this.relief;
    for (const [key, value] of Object.entries(params)) {
      if (!(key in target)) continue;
      const existing = target[key];
      if (typeof existing === typeof value && value !== null) target[key] = value;
    }
  }

  /**
   * The correction marks, small enough to keep in the file.
   *
   * Two strokes are what rescue a photograph whose colours will not separate,
   * so losing them on save means the revision after a reload quietly produces
   * a worse model than the one you accepted. They are almost all zeroes, so a
   * run-length encoding turns a hundred kilobytes into a few hundred bytes.
   */
  private encodedHints(): string | null {
    const hints = this.hints;
    if (!hints || !this.bitmap) return null;
    let any = false;
    const runs: number[] = [];
    let value = hints[0];
    let run = 0;
    for (let i = 0; i < hints.length; i++) {
      if (hints[i] !== HINT_NONE) any = true;
      if (hints[i] === value) { run++; continue; }
      runs.push(value, run);
      value = hints[i];
      run = 1;
    }
    runs.push(value, run);
    if (!any) return null;
    return `${this.bitmap.width}x${this.bitmap.height}:${runs.join(',')}`;
  }

  /** Read marks back out of a saved record, ignoring anything that does not fit. */
  private decodeHints(encoded: unknown, width: number, height: number): Uint8Array | null {
    if (typeof encoded !== 'string') return null;
    const [size, body] = encoded.split(':');
    const [w, h] = (size ?? '').split('x').map(Number);
    if (w !== width || h !== height || !body) return null;
    const runs = body.split(',').map(Number);
    const out = new Uint8Array(width * height);
    let at = 0;
    for (let i = 0; i + 1 < runs.length; i += 2) {
      const value = runs[i];
      const run = runs[i + 1];
      if (!Number.isFinite(value) || !Number.isFinite(run) || run < 0) return null;
      if (at + run > out.length) return null;
      out.fill(value, at, at + run);
      at += run;
    }
    return at === out.length ? out : null;
  }

  /**
   * Write down what built this model, and what it looked like when new.
   *
   * Refreshed on every rebuild from this panel, because while the panel is
   * open with the picture loaded it *is* the generator: the object on screen
   * is what these settings produce, and that is what the next revision needs
   * as its baseline. Nothing here runs on load — reopening a file shows the
   * geometry the file holds.
   */
  private recordOrigin(object: SceneObject, mesh: Mesh): void {
    const existing = object.provenance;
    object.partKey = REFERENCE_PART;
    object.provenance = {
      schema: PROVENANCE_SCHEMA,
      source: 'reference',
      assetId: existing?.assetId ?? newAssetId(),
      generator: `reference:${this.mode}`,
      generatorVersion: GENERATOR_VERSION,
      prompt: existing?.prompt,
      params: {
        ...this.settingsForMode(),
        hints: this.encodedHints(),
        // Only for the depth route, and only what it cannot recompute cheaply.
        depth: this.mode === 'scene' && this.sceneDepth ? encodeDepth(this.sceneDepth) : null,
      },
      reference: this.referenceOrigin(),
      baseline: {
        parts: [{
          key: REFERENCE_PART,
          name: object.name,
          position: object.position.toArray(),
          rotation: object.rotation.toArray(),
          scale: object.scale.toArray(),
          mesh: mesh.toJSON(),
        }],
      },
      createdAt: Date.now(),
      revision: existing ? existing.revision + 1 : 0,
    };
  }

  /**
   * Stage a rebuild as a revision when the model is no longer what was built.
   *
   * A reference model is one mesh, so a resolution change replaces every
   * vertex in it — which means a sculpt, an unwrap or a paint pass on it has
   * nothing to map onto. That is a real conflict and it is reported as one;
   * pretending a re-sample preserves detail it cannot preserve would be the
   * worst kind of quiet.
   *
   * Returns true when the rebuild was staged and must not also be applied.
   */
  private stageRevision(object: SceneObject, mesh: Mesh): boolean {
    const prov = object.provenance;
    const baseline = prov?.baseline.parts?.[0];
    if (!prov || !baseline) return false;
    if (sameMesh(baseline.mesh, object.mesh ? object.mesh.toJSON() : null)) return false;

    const proposed: ProposedPart[] = [{
      key: REFERENCE_PART,
      name: object.name,
      position: object.position.toArray(),
      rotation: object.rotation.toArray(),
      scale: object.scale.toArray(),
      mesh: mesh.toJSON(),
    }];
    const summary = this.editor.revision.preview(
      object,
      proposed,
      `Rebuild ${object.name} from ${this.reference?.name ?? 'the reference'}`,
      ['You have edited this model since it was built from the picture. Rebuilding it replaces '
        + 'every vertex, so edits stored against the old ones cannot be carried across.'],
      { params: this.settingsForMode(), reference: this.referenceOrigin() },
    );
    if (!summary) return false;
    this.statsLine.textContent = `${summary.headline} — accept or reject it.`;
    return true;
  }

  /**
   * Lay new results out along +X beside whatever is already in the scene,
   * rather than stacking every generated object on the 3D cursor.
   */
  private placementFor(mesh: Mesh): Vec3 {
    const cursor = this.editor.scene.cursor.clone();
    const existing = this.editor.scene.bounds(false);
    if (!existing.valid) return cursor;
    const box = mesh.bounds();
    if (!box.valid) return cursor;
    const gap = 0.4;
    cursor.x = existing.max.x + gap - box.min.x;
    return cursor;
  }

  private nameForMode(): string {
    if (this.mode === 'photo') return 'Photo';
    return this.mode === 'silhouette' ? 'Cutout' : this.mode === 'lathe' ? 'Turned' : 'Relief';
  }

  private buildMesh(): ReturnType<typeof meshFromSilhouette> {
    const bitmap = this.bitmap!;
    if (this.mode === 'photo') return this.buildPhoto(bitmap);
    if (this.mode === 'silhouette') {
      return meshFromSilhouette(bitmap, { ...this.silhouette, mask: this.maskOptions() });
    }
    if (this.mode === 'lathe') {
      return meshFromLathe(bitmap, {
        ...this.lathe,
        denoise: this.silhouette.denoise,
        mask: this.maskOptions(),
      });
    }
    return meshFromHeightfield(bitmap, { ...this.relief });
  }

  /**
   * The photograph route, with the slow half cached.
   *
   * Segmentation and the depth solve are keyed on the settings that actually
   * change them. Without that, nudging the target height would re-run a
   * GrabCut and a Poisson solve — half a second of work to move some vertices
   * that were already in the right place relative to each other.
   */
  private buildPhoto(bitmap: Bitmap): PhotoResult {
    const matteKey = `${bitmap.width}x${bitmap.height}:${this.frameTime}:${this.hintRevision}`;
    if (this.matte?.key !== matteKey) {
      this.matte = {
        key: matteKey,
        value: segmentSubject(bitmap, this.hints ? { hints: this.hints } : {}),
      };
      this.depthField = null;
    }
    const matte = this.matte.value;

    const depthKey = `${matteKey}|${this.photo.volume}|${this.photo.detail}|${this.photo.symmetry}`;
    if (this.depthField?.key !== depthKey) {
      this.depthField = {
        key: depthKey,
        value: depthFromPhoto(bitmap, matte, {
          volume: this.photo.volume,
          detail: this.photo.detail,
          symmetry: this.photo.symmetry,
        }),
      };
    }

    const result = meshFromPhoto(bitmap, {
      resolution: this.photo.resolution,
      targetHeight: this.photo.targetHeight,
      depthScale: this.photo.depthScale,
      back: this.photo.back,
      matte,
      field: this.depthField.value,
    });
    this.noteCoverage(result);
    return result;
  }

  /**
   * Read the whole picture with the depth network and build what it describes.
   *
   * Separate from `generate()` and deliberately behind a button. The other
   * routes are milliseconds and can run on every nudge of a slider; this one
   * loads 26MB the first time and then takes a second or several, so running
   * it by accident would be the difference between an application that feels
   * instant and one that does not. Everything it needs is bundled, so it works
   * with the network unplugged.
   */
  private async runSceneDepth(): Promise<void> {
    const bitmap = this.bitmap;
    const ref = this.reference;
    if (!bitmap || !ref || this.sceneRunning) return;
    this.sceneRunning = true;
    this.build();
    const say = (text: string): void => {
      this.sceneNote.textContent = text;
      this.editor.setStatus(text);
    };
    say('Loading the depth model…');
    try {
      const depth = await estimateDepth(bitmap, {
        size: this.scene.modelSize,
        onProgress: (f) => {
          if (f < 1) say(`Loading the depth model… ${Math.round(f * 100)}%`);
          else say('Reading the picture…');
        },
      });
      const result = meshFromDepth(bitmap, depth, {
        resolution: this.scene.resolution,
        targetWidth: this.scene.targetWidth,
        relief: this.scene.relief,
        cut: this.scene.cut,
        smoothing: this.scene.smoothing,
      });
      if (result.mesh.faceCount === 0) {
        say('The model read this frame as one flat distance, so there is no surface to build.');
        return;
      }

      // Before anything is touched, either way.
      //
      // Building over an object that already exists throws its mesh away, and
      // that used to happen with no undo step at all: press the button twice
      // and the first result was gone for good. Only the branch that creates
      // an object was recording one, which is the branch where there is
      // nothing to lose.
      if (!this.editor.beginUndo('Build scene from photo')) return;
      let object = this.editor.scene.get(this.targetId);
      if (!object) {
        object = this.editor.scene.add('mesh', this.editor.scene.uniqueName('Scene'), result.mesh);
        object.position = this.placementFor(result.mesh);
        this.targetId = object.id;
        this.assignedName = object.name;
        this.editor.selectObject(object.id);
      } else if (this.stageRevision(object, result.mesh)) {
        say(`${this.editor.revision.summary?.headline ?? 'Ready'} — accept or reject the rebuild.`);
        return;
      } else {
        object.mesh = result.mesh;
      }
      if (this.scene.texture) this.applyPhotoTexture(object);
      else object.materialSlots = [this.editor.scene.ensureDefaultMaterial()];
      // The depth map goes in the file with everything else, so this scene can
      // be revised later without the network — on a machine that has never
      // downloaded it.
      this.sceneDepth = depth;
      this.recordOrigin(object, result.mesh);
      this.editor.markGeometryDirty(object);
      this.editor.frameSelected();

      const { stats } = result;
      this.statsLine.textContent =
        `${stats.verts.toLocaleString()} verts · ${stats.faces.toLocaleString()} faces · ${stats.ms} ms`;
      say(`Scene built — ${stats.faces.toLocaleString()} faces, ${Math.round(result.covered * 100)}% of the `
        + `frame joined up, ${(depth.ms / 1000).toFixed(1)}s in the depth model.`);
    } catch (err) {
      // A failure here has to be a sentence, not a silence: this is the route
      // people reach for when the others could not do their photograph.
      say(`The depth model could not run: ${(err as Error).message}`);
    } finally {
      this.sceneRunning = false;
      this.build();
    }
  }

  /** Remember what the last photo build found, for the line under the settings. */
  private noteCoverage(result: PhotoResult): void {
    this.lastCoverage = result.coverage;
  }

  /**
   * Say what was found, and say when it was not found.
   *
   * A subject that covers the whole frame, or none of it, means the colour
   * models could not tell the thing from the room behind it — and the model
   * that comes out is then a rectangle or nothing. Announcing that beats
   * letting someone conclude the feature is broken and close the panel.
   */
  private reportSubject(): void {
    const matte = this.matte?.value;
    if (!matte) return;
    const percent = Math.round(this.lastCoverage * 100);
    const marked = this.hasHints();
    // Said plainly, in the place the result appears, and said as a verdict
    // rather than as a statistic. Somebody who has just watched their photo
    // turn into a blob needs to know whether the subject was found, and what
    // to do if it was not — a number appended to a face count answers neither.
    this.verdict.classList.remove('good', 'bad', 'hidden');
    if (matte.separation < MIN_SEPARATION && !marked) {
      this.verdict.classList.add('bad');
      this.verdict.textContent =
        'The subject and the background are too close in colour to tell apart, so the '
        + 'whole frame was used. Draw over the subject and over the background below, or '
        + 'crop to the subject.';
    } else if (percent < 3) {
      this.verdict.classList.add('bad');
      this.verdict.textContent = marked
        ? 'Still almost nothing — try marking more of the subject.'
        : 'Almost nothing was found. Draw over the subject below, or try a photo where it '
          + 'is nearer the middle of the frame.';
    } else if (percent > 92 && !marked) {
      this.verdict.classList.add('bad');
      this.verdict.textContent =
        'Nearly the whole frame came back as subject, which usually means the background '
        + 'was not recognised. Draw over some background below to say what to drop.';
    } else {
      this.verdict.classList.add('good');
      this.verdict.textContent = marked
        ? `Subject found with your corrections — it fills ${percent}% of the frame.`
        : `Subject found — it fills ${percent}% of the frame.`;
    }
  }


  /**
   * Put the photograph on the model.
   *
   * This is not decoration. An inflated silhouette with no texture is a grey
   * lump in roughly the right outline, and it is the step everyone skips —
   * the difference between "that is my shoe" and "that is a shoe-shaped
   * thing" is almost entirely the picture being on it.
   */
  private wantsTexture(): boolean {
    if (this.mode === 'photo') return this.photo.texture;
    if (this.mode === 'silhouette') return this.silhouette.texture;
    return false;
  }

  private applyPhotoTexture(object: SceneObject): void {
    const ref = this.reference;
    if (!ref) return;
    const scene = this.editor.scene;
    if (!this.wantsTexture()) {
      object.materialSlots = [scene.ensureDefaultMaterial()];
      return;
    }
    const key = `${ref.name}:${this.frameTime}`;
    if (this.photoTexture?.key !== key) {
      try {
        const { url, width, height } = textureFromReference(ref);
        const texture = createTexture(ref.name.replace(/\.[^.]+$/, ''), url, width, height);
        const stale = this.photoTexture?.id ?? null;
        scene.textures.push(texture);
        this.photoTexture = { key, id: texture.id };
        // The previous frame's copy goes, unless something else has taken it
        // up in the meantime. A texture is an embedded PNG; scrubbing a video
        // would otherwise put one in the file per frame anyone looked at.
        if (stale !== null && !scene.materials.some((m) => m.baseColorTexture === stale)) {
          const at = scene.textures.findIndex((t) => t.id === stale);
          if (at >= 0) scene.textures.splice(at, 1);
        }
      } catch (err) {
        this.editor.setStatus(`The model was built, but the photo could not be used as a texture: ${(err as Error).message}`);
        return;
      }
    }

    const settings = {
      name: `${object.name} surface`,
      baseColorTexture: this.photoTexture.id,
      // A photograph already contains its own highlights; a shiny material on
      // top of one reads as plastic wrap.
      roughness: 0.85,
      metallic: 0,
    };
    // One material for this object, updated in place. A new one per rebuild
    // would leave the material list full of identical orphans, and every one
    // of them would be written into the saved scene.
    const existing = this.photoMaterial;
    if (existing && existing.objectId === object.id && scene.materials[existing.slot]) {
      Object.assign(scene.materials[existing.slot], settings);
      object.materialSlots = [existing.slot];
      this.showTexture();
      return;
    }
    const slot = scene.addMaterial(createMaterial(settings));
    this.photoMaterial = { objectId: object.id, slot };
    object.materialSlots = [slot];
    this.showTexture();
  }

  /**
   * Put the viewport where the photograph can be seen.
   *
   * Solid shading is the right default for modelling — it reads shape without
   * a material in the way — but it is the wrong thing to be looking at one
   * second after dropping a photograph on the window. The whole promise is
   * that the picture comes out on the model, and in solid shading it does
   * not: the first thing anyone saw after using the headline feature was a
   * grey blob, with nothing on screen to say the photograph had arrived at
   * all.
   *
   * Once, on the first photo model of the session. Anybody who then goes back
   * to solid shading meant it, and is left alone.
   */
  private showTexture(): void {
    if (this.revealedTexture) return;
    this.revealedTexture = true;
    if (this.editor.options.shading !== 'solid') return;
    this.editor.setShading('material');
  }

  /**
   * Correcting the subject by hand.
   *
   * The colour models are right most of the time and hopeless the rest of it:
   * a subject photographed against something its own colour cannot be found
   * by colour, and no amount of work on the segmentation changes that. Two
   * strokes can. Marking a stripe of the thing and a stripe of what is behind
   * it takes a photograph that produced nothing and makes it produce the
   * model — on a test frame where subject and background differ by six values
   * in each channel, the automatic pass gives up and calls the whole frame
   * subject; with two strokes it gets 98.8% of the pixels right.
   *
   * The alternative for these photographs is a trained depth network, which
   * means a few hundred megabytes in the download or a server to upload to.
   * A brush is ten seconds of the user's time and neither of those.
   */
  private brushControls(): HTMLElement {
    const wrap = h('div', { class: 'brush-controls' });
    wrap.appendChild(h('p', {
      class: 'dim small',
      text: 'Draw on the picture above to correct what was found. Subject marks what to '
        + 'keep, Background marks what to drop.',
    }));

    const modes: { id: 'subject' | 'background' | 'erase'; label: string }[] = [
      { id: 'subject', label: 'Subject' },
      { id: 'background', label: 'Background' },
      { id: 'erase', label: 'Erase' },
    ];
    const group = h('div', { class: 'seg-group brush-modes' });
    for (const m of modes) {
      group.appendChild(h('button', {
        class: `seg${this.brush.mode === m.id ? ' active' : ''}`,
        text: m.label,
        on: {
          click: () => {
            this.brush.mode = m.id;
            for (const b of [...group.children]) b.classList.remove('active');
            group.children[modes.indexOf(m)].classList.add('active');
          },
        },
      }));
    }
    wrap.appendChild(group);

    const size = h('input', {
      type: 'range', class: 'slider',
      min: '4', max: '60', step: '1', value: `${this.brush.radius}`,
      on: { input: (e: Event) => { this.brush.radius = Number((e.target as HTMLInputElement).value); } },
    });
    wrap.appendChild(row('Brush size', size));

    wrap.appendChild(button('Clear marks', () => this.clearHints(), {
      title: 'Throw away every correction and go back to what the colours alone find',
    }));
    return wrap;
  }

  /**
   * The user's own marks, over the top of what the segmentation made of them.
   *
   * Green for keep and red for drop rather than more of the ember the matte
   * already uses: the point of looking at this is to tell your corrections
   * apart from the result they produced.
   */
  private drawHints(
    ctx: CanvasRenderingContext2D,
    placement: { x: number; y: number; width: number; height: number },
  ): void {
    const hints = this.hints;
    const bitmap = this.bitmap;
    if (!hints || !bitmap) return;
    const layer = document.createElement('canvas');
    layer.width = bitmap.width;
    layer.height = bitmap.height;
    const lctx = layer.getContext('2d');
    if (!lctx) return;
    const image = lctx.createImageData(bitmap.width, bitmap.height);
    let any = false;
    for (let i = 0; i < hints.length; i++) {
      if (hints[i] === HINT_SUBJECT) {
        image.data[i * 4] = 90; image.data[i * 4 + 1] = 220; image.data[i * 4 + 2] = 120;
        image.data[i * 4 + 3] = 190;
        any = true;
      } else if (hints[i] === HINT_BACKGROUND) {
        image.data[i * 4] = 230; image.data[i * 4 + 1] = 70; image.data[i * 4 + 2] = 80;
        image.data[i * 4 + 3] = 190;
        any = true;
      }
    }
    if (!any) return;
    lctx.putImageData(image, 0, 0);
    ctx.drawImage(layer, placement.x, placement.y, placement.width, placement.height);
  }

  /**
   * Turn a pointer position on the preview into a pixel of the source image.
   *
   * The preview letterboxes the picture, so the offsets and the scale both
   * matter; a click outside the picture is not a paint.
   */
  private previewToImage(e: PointerEvent): { x: number; y: number } | null {
    const placement = this.previewPlacement;
    const bitmap = this.bitmap;
    if (!placement || !bitmap) return null;
    const rect = this.preview.getBoundingClientRect();
    // The canvas is drawn at its own pixel size and laid out at whatever width
    // the panel gives it, so page pixels are not canvas pixels.
    const cx = (e.clientX - rect.left) * (this.preview.width / rect.width);
    const cy = (e.clientY - rect.top) * (this.preview.height / rect.height);
    const u = (cx - placement.x) / placement.width;
    const v = (cy - placement.y) / placement.height;
    if (u < 0 || v < 0 || u > 1 || v > 1) return null;
    return { x: u * (bitmap.width - 1), y: v * (bitmap.height - 1) };
  }

  /** The routes that take corrections: everything that segments an image. */
  private brushable(): boolean {
    return this.mode === 'photo' || this.mode === 'silhouette' || this.mode === 'lathe';
  }

  /** Pointer handling for the correction brush, wired once. */
  private wirePreviewBrush(): void {
    const paintAt = (e: PointerEvent): void => {
      const at = this.previewToImage(e);
      if (!at) return;
      this.paintHint(at.x, at.y);
      this.drawPreview();
    };
    this.preview.addEventListener('pointerdown', (e) => {
      if (!this.brushable() || !this.bitmap) return;
      e.preventDefault();
      this.painting = true;
      this.preview.setPointerCapture(e.pointerId);
      paintAt(e);
    });
    this.preview.addEventListener('pointermove', (e) => {
      if (!this.painting) return;
      paintAt(e);
    });
    const finish = (e: PointerEvent): void => {
      if (!this.painting) return;
      this.painting = false;
      if (this.preview.hasPointerCapture(e.pointerId)) this.preview.releasePointerCapture(e.pointerId);
      // Rebuilt once, at the end of the stroke: re-segmenting on every pointer
      // move would run a GrabCut sixty times a second.
      this.hintRevision++;
      this.generate(true);
    };
    this.preview.addEventListener('pointerup', finish);
    this.preview.addEventListener('pointercancel', finish);
  }

  /** Frame plus the traced outline, so the threshold is something you can see. */
  private drawPreview(): void {
    const ref = this.reference;
    if (!ref) return;
    const width = 260;
    const height = Math.max(90, Math.min(200, Math.round((width * ref.height) / ref.width)));
    this.preview.width = width;
    this.preview.height = height;
    const placement = drawReferenceInto(this.preview, ref);
    this.previewPlacement = placement ?? null;
    const ctx = this.preview.getContext('2d');
    if (!ctx || !placement || !this.bitmap || this.mode === 'relief') return;

    if (this.mode === 'photo') {
      // The matte over the frame, so the thing being modelled is visible
      // before the model exists. Photo mode does not use a threshold, so
      // there is nothing to nudge — but there is plenty to check.
      const matte = this.matte?.value;
      if (!matte) return;
      const overlay = document.createElement('canvas');
      overlay.width = matte.width;
      overlay.height = matte.height;
      const octx = overlay.getContext('2d');
      if (!octx) return;
      const image = octx.createImageData(matte.width, matte.height);
      for (let i = 0; i < matte.data.length; i++) {
        image.data[i * 4] = 255;
        image.data[i * 4 + 1] = 158;
        image.data[i * 4 + 2] = 44;
        image.data[i * 4 + 3] = Math.round((1 - Math.min(1, matte.data[i])) * 150);
      }
      octx.putImageData(image, 0, 0);
      ctx.drawImage(overlay, placement.x, placement.y, placement.width, placement.height);
      this.drawHints(ctx, placement);
      return;
    }

    const mask = denoiseMask(maskFromBitmap(this.bitmap, this.maskOptions()), this.silhouette.denoise);
    const parts = splitComponents(mask, 32).slice(0, this.mode === 'lathe' ? 1 : this.silhouette.maxParts);
    const sx = placement.width / this.bitmap.width;
    const sy = placement.height / this.bitmap.height;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ff9e2c';
    ctx.fillStyle = 'rgba(255, 158, 44, 0.16)';
    for (const part of parts.length ? parts : [mask]) {
      for (const loop of simplifyContours(traceContours(part), this.silhouette.simplify)) {
        ctx.beginPath();
        loop.points.forEach(([x, y], i) => {
          const px = placement.x + x * sx;
          const py = placement.y + y * sy;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        if (!loop.hole) ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    this.drawHints(ctx, placement);
    ctx.save();
    if (this.mode === 'lathe') {
      const ax = placement.x + this.lathe.axis * placement.width;
      ctx.strokeStyle = '#4074c9';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ax, placement.y);
      ctx.lineTo(ax, placement.y + placement.height);
      ctx.stroke();
    }
    ctx.restore();
  }
}
