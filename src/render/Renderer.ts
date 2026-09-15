import { AABB, Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene, SceneObject } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { posedSegments } from '../anim/armature';
import { FACE_CHANGE_CODE, SceneDiff, faceSignature } from '../diff';
import { DynamicBuffer, IndexBuffer, Program, applyAttribs, setupAttribs } from './gl';
import {
  LINE_LAYOUT, LINE_STRIDE, POINT_LAYOUT, SURFACE_LAYOUT,
  buildPoints, buildSurface, buildWire,
} from './MeshBuffers';
import {
  GRID_FRAG, GRID_VERT, LINE_FRAG, LINE_VERT, MAX_LIGHTS, MAX_MATERIALS, MAX_TEXTURES,
  OUTLINE_FRAG, OUTLINE_VERT, POINT_FRAG, POINT_VERT, SHADOW_FRAG, SHADOW_SIZE, SHADOW_VERT,
  SURFACE_FRAG, SURFACE_VERT, TEXTURE_SIZE,
} from './shaders';

export type ShadingMode = 'solid' | 'material' | 'wireframe';
export type SelectMode = 'vertex' | 'edge' | 'face';

export interface EditOverlay {
  objectId: number;
  selectMode: SelectMode;
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
  /** Bumped by the editor whenever any of the selection sets change. */
  version: number;
}

export interface ViewportOptions {
  shading: ShadingMode;
  showGrid: boolean;
  showOverlays: boolean;
  showObjectWireframe: boolean;
  showOrigins: boolean;
  xray: boolean;
  backfaceCulling: boolean;
  /** Replace base colours with a procedural checker, for judging an unwrap. */
  uvCheck?: boolean;
  /** Bone the rig tools are working on, drawn highlighted. */
  activeBone?: number;
  /** Cast a shadow from the strongest directional light. Costs one extra pass. */
  shadows?: boolean;
  /** Tint geometry by how it differs from the version being compared against. */
  showDiff?: boolean;
}

export interface LineSegment {
  a: Vec3;
  b: Vec3;
  color: [number, number, number];
  /** Drawn ignoring depth when true (axis guides, the 3D cursor). */
  overlay?: boolean;
}

export interface FrameState {
  scene: Scene;
  camera: ViewportCamera;
  options: ViewportOptions;
  edit: EditOverlay | null;
  lines: LineSegment[];
  /** Per-object face classes and removed loops, when a comparison is open. */
  diff?: SceneDiff | null;
}

export const THEME = {
  wire: [0.05, 0.05, 0.06] as [number, number, number],
  wireSelected: [1.0, 0.62, 0.16] as [number, number, number],
  vertex: [0.0, 0.0, 0.0] as [number, number, number],
  vertexSelected: [1.0, 0.62, 0.16] as [number, number, number],
  outlineActive: [1.0, 0.62, 0.16] as [number, number, number],
  outlineSelected: [0.93, 0.42, 0.12] as [number, number, number],
  grid: [0.32, 0.32, 0.35] as [number, number, number],
  axisX: [0.79, 0.25, 0.31] as [number, number, number],
  axisY: [0.44, 0.66, 0.2] as [number, number, number],
  axisZ: [0.25, 0.45, 0.79] as [number, number, number],
  cursor: [0.95, 0.55, 0.15] as [number, number, number],
  light: [0.95, 0.85, 0.35] as [number, number, number],
  camera: [0.5, 0.85, 0.95] as [number, number, number],
  // Comparison: green for what this version gained, amber for what shifted,
  // red for what is gone. Green and red read as add and remove to anyone who
  // has looked at a diff before, and amber is the one hue left that stays
  // legible against both a light surface and a dark one.
  diffAdded: [0.24, 0.78, 0.36] as [number, number, number],
  diffMoved: [0.98, 0.68, 0.15] as [number, number, number],
  diffRemoved: [0.93, 0.27, 0.24] as [number, number, number],
};

interface GeometryEntry {
  key: string;
  surface: DynamicBuffer;
  /** Triangle indices into `surface`. */
  surfaceIndex: IndexBuffer;
  wire: DynamicBuffer;
  points: DynamicBuffer;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private surfaceProgram: Program;
  private outlineProgram: Program;
  private lineProgram: Program;
  private pointProgram: Program;
  private gridProgram: Program;
  private gridQuad: WebGLBuffer;
  private lineScratch: DynamicBuffer;
  private cache = new Map<number, GeometryEntry>();
  private shadowProgram: Program;
  private shadowFbo: WebGLFramebuffer | null = null;
  private shadowMap: WebGLTexture | null = null;
  /** Light-space matrix of whatever cast the current frame's shadows. */
  private shadowViewProj = new Mat4();
  private shadowLightIndex = -1;
  /** Bumped whenever the comparison changes, so cached buffers are rebuilt. */
  private diffVersion = 0;
  private diffSignature = '';
  private diffClasses = new Map<number, Uint8Array>();
  private textureArray: WebGLTexture | null = null;
  /** Layers actually allocated, which grows with the scene rather than being fixed. */
  private textureCapacity = 0;
  private textureLayers = new Map<number, number>();
  private textureSignature = '';
  /** Called when an image finishes decoding, so the host can redraw. */
  onTexturesReady: (() => void) | null = null;
  width = 1;
  height = 1;
  pixelRatio = 1;
  lastDrawCalls = 0;
  /** Vertices and pre-deduplication corners of the last surface built. */
  lastVertices = 0;
  lastCorners = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      // The selection outline masks the object's own pixels out of its hull,
      // and a stencil buffer is what that mask is.
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is required — The Culp Mixer could not create a rendering context.');
    this.gl = gl;

    this.surfaceProgram = new Program(gl, SURFACE_VERT, SURFACE_FRAG, 'surface');
    this.outlineProgram = new Program(gl, OUTLINE_VERT, OUTLINE_FRAG, 'outline');
    this.lineProgram = new Program(gl, LINE_VERT, LINE_FRAG, 'line');
    this.pointProgram = new Program(gl, POINT_VERT, POINT_FRAG, 'point');
    this.gridProgram = new Program(gl, GRID_VERT, GRID_FRAG, 'grid');
    this.shadowProgram = new Program(gl, SHADOW_VERT, SHADOW_FRAG, 'shadow');

    const quad = gl.createBuffer();
    if (!quad) throw new Error('failed to allocate grid buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.gridQuad = quad;

    this.lineScratch = new DynamicBuffer(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  resize(): boolean {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.pixelRatio = ratio;
    return true;
  }

  private geometryFor(
    obj: SceneObject, mesh: Mesh, edit: EditOverlay | null, diff?: Uint8Array | null,
  ): GeometryEntry {
    const editing = edit && edit.objectId === obj.id ? edit : null;
    // Identity as well as revision: a modifier stack hands back a new mesh
    // every time it runs, always at revision 1, so a key without the identity
    // matches the previous one and the buffer is never re-uploaded.
    // The comparison is part of what the buffer holds, so it has to be part of
    // the key: tinting changes the vertex data without changing the geometry,
    // and nothing else here would notice.
    const diffKey = diff ? `${diff.length}:${this.diffVersion}` : '-';
    const key = `${mesh.id}:${mesh.revision}|${editing ? `${editing.version}:${editing.selectMode}` : '-'}|${diffKey}`;
    let entry = this.cache.get(obj.id);
    if (!entry) {
      entry = {
        key: '',
        surface: new DynamicBuffer(this.gl),
        surfaceIndex: new IndexBuffer(this.gl),
        wire: new DynamicBuffer(this.gl),
        points: new DynamicBuffer(this.gl),
      };
      this.cache.set(obj.id, entry);
    }
    if (entry.key === key) return entry;

    const faceSel = editing && editing.selectMode === 'face' ? editing.faces : null;
    const surface = buildSurface(mesh, faceSel, diff);
    entry.surface.upload(surface.data, surface.count);
    entry.surfaceIndex.upload(surface.indices);
    this.lastVertices = surface.count;
    this.lastCorners = surface.corners;

    if (editing) {
      const wire = buildWire(mesh, editing.edges, THEME.wire, THEME.wireSelected);
      entry.wire.upload(wire.data, wire.count);
      const pts = buildPoints(mesh, editing.verts);
      entry.points.upload(pts.data, pts.count);
    } else {
      entry.wire.count = 0;
      entry.points.count = 0;
    }
    entry.key = key;
    return entry;
  }

  /**
   * Turn a scene comparison into a per-face table the buffer builder can read.
   *
   * Rebuilt only when the comparison itself changes — the version counter is
   * what the geometry cache keys on, so recomputing this every frame would
   * throw away every surface buffer every frame.
   */
  private syncDiff(diff: SceneDiff | null): void {
    // The signature has to depend on *which* faces changed, not how many.
    // Counting alone meant that moving a different set of the same number of
    // faces produced an identical signature, so the version never advanced,
    // the per-face table was never rebuilt, and every surface buffer kept the
    // tints from the previous comparison — the viewport quietly showing an
    // answer to a question nobody had asked any more.
    const signature = diff
      ? diff.objects.map((o) => `${o.id}:${o.mesh ? faceSignature(o.mesh.faces) : '-'}`).join('|')
      : '';
    if (signature === this.diffSignature) return;
    this.diffSignature = signature;
    this.diffVersion++;
    this.diffClasses.clear();
    if (!diff) return;
    for (const entry of diff.objects) {
      if (!entry.mesh) continue;
      const classes = new Uint8Array(entry.mesh.faces.length);
      for (let f = 0; f < classes.length; f++) classes[f] = FACE_CHANGE_CODE[entry.mesh.faces[f]];
      this.diffClasses.set(entry.id, classes);
    }
  }

  /**
   * Outlines where geometry used to be.
   *
   * Deleted faces cannot be tinted, because they are not in the mesh any
   * more — but "what did I remove" is half of what a comparison is for, so
   * they are drawn as loops floating in the space they used to occupy.
   */
  private drawRemovedGeometry(state: FrameState, viewProj: Mat4): void {
    const diff = state.diff;
    if (!diff || !state.options.showDiff) return;
    const segments: number[] = [];
    const [r, g, b] = THEME.diffRemoved;
    for (const entry of diff.objects) {
      const mesh = entry.mesh;
      if (!mesh || mesh.removedFaces.length === 0) continue;
      const obj = state.scene.get(entry.id);
      // A removed object has no transform left to place its ghost with, so it
      // is drawn where it stood in world space.
      const model = obj ? obj.worldMatrix(state.scene) : new Mat4();
      const pos = mesh.removedPositions;
      for (const loop of mesh.removedFaces) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i] * 3;
          const c = loop[(i + 1) % loop.length] * 3;
          if (a + 2 >= pos.length || c + 2 >= pos.length) continue;
          const p0 = model.transformPoint(new Vec3(pos[a], pos[a + 1], pos[a + 2]));
          const p1 = model.transformPoint(new Vec3(pos[c], pos[c + 1], pos[c + 2]));
          segments.push(p0.x, p0.y, p0.z, r, g, b, p1.x, p1.y, p1.z, r, g, b);
        }
      }
    }
    if (segments.length === 0) return;
    this.lineScratch.upload(new Float32Array(segments), segments.length / LINE_STRIDE);
    this.drawLineBuffer(this.lineScratch, new Mat4(), viewProj, 0.00012, 0.9);
  }

  /** Drop cached GPU buffers for objects that no longer exist. */
  private pruneCache(scene: Scene): void {
    for (const [id, entry] of this.cache) {
      if (!scene.objects.has(id)) {
        entry.surface.dispose();
        entry.surfaceIndex.dispose();
        entry.wire.dispose();
        entry.points.dispose();
        this.cache.delete(id);
      }
    }
  }

  /**
   * What the geometry cache currently believes about the comparison.
   *
   * Two different comparisons must never produce the same value, because that
   * is exactly when the cache would keep serving buffers tinted for the
   * previous one. Exposed so a test can assert that rather than infer it from
   * pixels, which would pass for the wrong reason as often as the right one.
   */
  diffDigest(): string {
    return `${this.diffVersion}:${this.diffSignature}`;
  }

  invalidate(objectId: number): void {
    const e = this.cache.get(objectId);
    if (e) e.key = '';
  }

  render(state: FrameState): void {
    const gl = this.gl;
    const { scene, camera, options, edit } = state;
    this.resize();
    this.pruneCache(scene);
    this.syncTextures(scene);
    this.lastDrawCalls = 0;

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const viewProj = camera.viewProjection(aspect);
    const eye = camera.eye();
    const bg = scene.world.background;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    this.syncDiff(state.diff ?? null);

    const drawables: { obj: SceneObject; mesh: Mesh; model: Mat4; transparent: boolean }[] = [];
    for (const obj of scene.objects.values()) {
      if (!obj.visible || obj.type !== 'mesh') continue;
      const editing = !!edit && edit.objectId === obj.id;
      const mesh = obj.evaluated(editing);
      if (!mesh || mesh.faceCount === 0) continue;
      const transparent = obj.materialSlots.some((s) => (scene.materials[s]?.alpha ?? 1) < 0.999);
      drawables.push({ obj, mesh, model: obj.worldMatrix(scene), transparent });
    }

    // Depth from the light first, so the surface pass can read it.
    this.renderShadowMap(state, drawables);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    if (options.shading !== 'wireframe') {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      if (options.backfaceCulling) {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      } else {
        gl.disable(gl.CULL_FACE);
      }
      for (const d of drawables) {
        if (d.transparent) continue;
        this.drawSurface(d.obj, d.mesh, d.model, state, viewProj, eye, 1);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.CULL_FACE);
    }

    this.drawRemovedGeometry(state, viewProj);

    // Selection outlines (object mode only).
    if (options.showOverlays && !edit && options.shading !== 'wireframe') {
      this.drawOutlines(scene, drawables, viewProj, eye);
    }

    if (options.showGrid) this.drawGrid(camera, viewProj);

    if (options.shading !== 'wireframe') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      const sorted = drawables
        .filter((d) => d.transparent)
        .sort((a, b) => {
          const da = a.model.transformPoint(new Vec3()).distanceTo(eye);
          const db = b.model.transformPoint(new Vec3()).distanceTo(eye);
          return db - da;
        });
      for (const d of sorted) this.drawSurface(d.obj, d.mesh, d.model, state, viewProj, eye, 1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    if (options.showOverlays) {
      this.drawEditOverlays(state, drawables, viewProj);
      this.drawHelperLines(state, viewProj);
    }
  }

  private drawSurface(
    obj: SceneObject, mesh: Mesh, model: Mat4, state: FrameState,
    viewProj: Mat4, eye: Vec3, opacity: number,
  ): void {
    const gl = this.gl;
    const { scene, options, edit } = state;
    const entry = this.geometryFor(obj, mesh, edit, this.diffClasses.get(obj.id) ?? null);
    if (entry.surface.count === 0) return;

    const p = this.surfaceProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uModel', model.m);
    p.setMat4('uNormalMat', model.normalMatrix().m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    p.setInt('uShadingMode', options.shading === 'material' ? 1 : 0);
    p.setVec3('uSelectColor', ...THEME.wireSelected);
    p.setFloat('uDiffMode', options.showDiff && state.diff ? 1 : 0);
    p.setVec3('uDiffAdded', ...THEME.diffAdded);
    p.setVec3('uDiffMoved', ...THEME.diffMoved);
    p.setFloat('uObjectSelected', !edit && scene.selection.has(obj.id) ? 1 : 0);
    p.setFloat('uOpacity', opacity * (options.xray ? 0.45 : 1));

    const amb = scene.world.ambient;
    p.setVec3('uAmbient', amb, amb, amb);
    p.setFloat('uUVCheck', options.uvCheck ? 1 : 0);
    this.uploadLights(p, scene);
    this.uploadMaterials(p, scene, obj);
    this.bindTextures(p);
    this.bindShadowMap(p);

    gl.bindBuffer(gl.ARRAY_BUFFER, entry.surface.buffer);
    setupAttribs(gl, p, SURFACE_LAYOUT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.surfaceIndex.buffer);
    gl.drawElements(gl.TRIANGLES, entry.surfaceIndex.count, gl.UNSIGNED_INT, 0);
    this.lastDrawCalls++;
  }

  private uploadLights(p: Program, scene: Scene): void {
    const pos = new Float32Array(MAX_LIGHTS * 4);
    const col = new Float32Array(MAX_LIGHTS * 4);
    const dir = new Float32Array(MAX_LIGHTS * 4);
    let n = 0;
    for (const obj of scene.objects.values()) {
      if (n >= MAX_LIGHTS || obj.type !== 'light' || !obj.visible || !obj.light) continue;
      const m = obj.worldMatrix(scene);
      const wp = m.transformPoint(new Vec3());
      const wd = m.transformDirection(new Vec3(0, 0, -1)).normalized();
      const type = obj.light.type === 'point' ? 0 : obj.light.type === 'sun' ? 1 : obj.light.type === 'spot' ? 2 : 3;
      pos.set([wp.x, wp.y, wp.z, type], n * 4);
      const e = obj.light.energy;
      col.set([
        obj.light.color[0] * e, obj.light.color[1] * e, obj.light.color[2] * e,
        Math.cos(obj.light.spotAngle),
      ], n * 4);
      dir.set([wd.x, wd.y, wd.z, obj.light.size], n * 4);
      n++;
    }
    p.setInt('uLightCount', n);
    p.setVec4Array('uLightPos', pos);
    p.setVec4Array('uLightColor', col);
    p.setVec4Array('uLightDir', dir);
  }

  private uploadMaterials(p: Program, scene: Scene, obj: SceneObject): void {
    const color = new Float32Array(MAX_MATERIALS * 3);
    const mr = new Float32Array(MAX_MATERIALS * 2);
    const emit = new Float32Array(MAX_MATERIALS * 4);
    const alpha = new Float32Array(MAX_MATERIALS);
    const texLayer = new Float32Array(MAX_MATERIALS).fill(-1);
    const uvXform = new Float32Array(MAX_MATERIALS * 4);
    const slots = obj.materialSlots.length ? obj.materialSlots : [0];
    for (let i = 0; i < MAX_MATERIALS; i++) {
      const m = scene.materials[slots[Math.min(i, slots.length - 1)] ?? 0];
      const c = m?.color ?? [0.75, 0.75, 0.78];
      color.set(c, i * 3);
      mr.set([m?.metallic ?? 0, m?.roughness ?? 0.5], i * 2);
      emit.set([...(m?.emission ?? [0, 0, 0]), m?.emissionStrength ?? 0], i * 4);
      alpha[i] = m?.alpha ?? 1;
      const layer = m?.baseColorTexture != null ? this.textureLayers.get(m.baseColorTexture) : undefined;
      texLayer[i] = layer === undefined ? -1 : layer;
      uvXform.set([
        m?.uvScale?.[0] ?? 1, m?.uvScale?.[1] ?? 1,
        m?.uvOffset?.[0] ?? 0, m?.uvOffset?.[1] ?? 0,
      ], i * 4);
    }
    p.setFloatArray('uMatTexLayer', texLayer);
    p.setVec4Array('uMatUV', uvXform);
    p.setVec3Array('uMatColor', color);
    p.setVec2Array('uMatMR', mr);
    p.setVec4Array('uMatEmit', emit);
    p.setFloatArray('uMatAlpha', alpha);
  }

  private drawOutlines(
    scene: Scene,
    drawables: { obj: SceneObject; mesh: Mesh; model: Mat4 }[],
    viewProj: Mat4, eye: Vec3,
  ): void {
    const gl = this.gl;
    const selected = drawables.filter((d) => scene.selection.has(d.obj.id));
    if (selected.length === 0) return;
    const p = this.outlineProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.STENCIL_TEST);
    for (const d of selected) {
      const entry = this.cache.get(d.obj.id);
      if (!entry || entry.surface.count === 0) continue;
      const active = scene.active === d.obj.id;
      p.setMat4('uModel', d.model.m);
      p.setMat4('uNormalMat', d.model.normalMatrix().m);
      p.setVec3('uColor', ...(active ? THEME.outlineActive : THEME.outlineSelected));
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.surface.buffer);
      setupAttribs(gl, p, SURFACE_LAYOUT);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.surfaceIndex.buffer);

      // Mark where this object is already on screen, then draw the hull
      // everywhere except there.
      //
      // The outline is the usual inverted hull: the mesh again, pushed out
      // along its normals, back faces only, so what is left over is a rim.
      // Where the surface turns edge-on to the camera that push is almost
      // entirely sideways, and on a dense organic mesh — a model built from a
      // photograph has tens of thousands of faces and a thin lip all round it
      // — the pushed-out far side comes through the near side as a hatch of
      // orange slivers across the model. It reads as the model being broken
      // rather than as it being selected, and no amount of depth offset fixes
      // it, because the hull really is in front there.
      //
      // A rim is by definition the part that is not the object, so the object
      // says where it is and the hull is refused those pixels outright.
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);

      // Pass one: the mesh as it stands, into the stencil only. Depth stays
      // as it is, so this marks exactly the pixels where the object is the
      // thing being looked at — anywhere it is hidden behind something else
      // is left unmarked, and keeps the outline it had.
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.cullFace(gl.BACK);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      p.setFloat('uWidth', 0);
      gl.drawElements(gl.TRIANGLES, entry.surfaceIndex.count, gl.UNSIGNED_INT, 0);

      // Pass two: the hull, kept out of everything pass one marked.
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.cullFace(gl.FRONT);
      gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      p.setFloat('uWidth', 0.0035);
      gl.drawElements(gl.TRIANGLES, entry.surfaceIndex.count, gl.UNSIGNED_INT, 0);
      this.lastDrawCalls += 2;
    }
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.disable(gl.STENCIL_TEST);
    gl.cullFace(gl.BACK);
    gl.disable(gl.CULL_FACE);
  }


  private drawGrid(camera: ViewportCamera, viewProj: Mat4): void {
    const gl = this.gl;
    const p = this.gridProgram;
    p.use();
    const eye = camera.eye();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uInvViewProj', viewProj.inverse().m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    // Step the grid by powers of ten so it stays readable at any zoom: the fine
    // grid lands roughly one order of magnitude below the visible span.
    const span = camera.orthoHalfHeight() * 2;
    const decade = Math.pow(10, Math.round(Math.log10(Math.max(span, 1e-4))) - 1);
    p.setFloat('uSpacing', decade);
    p.setFloat('uFadeDistance', Math.max(20, camera.distance * 6));
    p.setVec3('uLineColor', ...THEME.grid);
    p.setVec3('uXAxisColor', ...THEME.axisX);
    p.setVec3('uYAxisColor', ...THEME.axisY);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridQuad);
    const loc = p.attrib('aPos');
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    applyAttribs(gl, loc >= 0 ? new Set([loc]) : new Set());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.lastDrawCalls++;
  }

  private drawEditOverlays(
    state: FrameState,
    drawables: { obj: SceneObject; mesh: Mesh; model: Mat4 }[],
    viewProj: Mat4,
  ): void {
    const gl = this.gl;
    const { options, edit } = state;

    // Object-mode wireframe overlay.
    if (options.showObjectWireframe || options.shading === 'wireframe') {
      for (const d of drawables) {
        if (edit && edit.objectId === d.obj.id) continue;
        const entry = this.cache.get(d.obj.id);
        if (!entry) continue;
        if (entry.wire.count === 0) {
          const wire = buildWire(d.mesh, null, THEME.wire, THEME.wire);
          entry.wire.upload(wire.data, wire.count);
        }
        this.drawLineBuffer(entry.wire, d.model, viewProj, 0.00008, 0.55);
      }
    }

    if (!edit) return;
    const editable = drawables.find((d) => d.obj.id === edit.objectId);
    if (!editable) return;
    const entry = this.cache.get(edit.objectId);
    if (!entry) return;

    if (options.xray) gl.disable(gl.DEPTH_TEST);
    this.drawLineBuffer(entry.wire, editable.model, viewProj, 0.00012, 1);

    if (edit.selectMode === 'vertex' && entry.points.count > 0) {
      const p = this.pointProgram;
      p.use();
      p.setMat4('uViewProj', viewProj.m);
      p.setMat4('uModel', editable.model.m);
      p.setFloat('uSize', 6.5 * this.pixelRatio);
      p.setFloat('uDepthBias', 0.00016);
      p.setVec3('uColor', ...THEME.vertex);
      p.setVec3('uSelectColor', ...THEME.vertexSelected);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.points.buffer);
      setupAttribs(gl, p, POINT_LAYOUT);
      gl.drawArrays(gl.POINTS, 0, entry.points.count);
      this.lastDrawCalls++;
    }
    if (options.xray) gl.enable(gl.DEPTH_TEST);
  }

  private drawLineBuffer(
    buffer: DynamicBuffer, model: Mat4, viewProj: Mat4, bias: number, alpha: number,
  ): void {
    if (buffer.count === 0) return;
    const gl = this.gl;
    const p = this.lineProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uModel', model.m);
    p.setFloat('uDepthBias', bias);
    p.setFloat('uAlpha', alpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer);
    setupAttribs(gl, p, LINE_LAYOUT);
    gl.drawArrays(gl.LINES, 0, buffer.count);
    gl.disable(gl.BLEND);
    this.lastDrawCalls++;
  }

  /** Gizmos, light/camera helpers, the 3D cursor and modal transform guides. */
  private drawHelperLines(state: FrameState, viewProj: Mat4): void {
    const { scene, camera, options } = state;
    const segments: LineSegment[] = [];

    for (const obj of scene.objects.values()) {
      if (!obj.visible) continue;
      const m = obj.worldMatrix(scene);
      const selected = scene.selection.has(obj.id);
      if (obj.type === 'light' && obj.light) {
        const c: [number, number, number] = selected ? THEME.wireSelected : THEME.light;
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 26;
        pushCircle(segments, o, s, camera, c);
        if (obj.light.type === 'sun') {
          const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
          segments.push({ a: o, b: o.add(d.scale(s * 4)), color: c });
        } else if (obj.light.type === 'spot') {
          const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
          const tip = o.add(d.scale(s * 5));
          const r = Math.tan(obj.light.spotAngle) * s * 5;
          pushCircle(segments, tip, r, camera, c, d);
          for (const k of [0, 1, 2, 3]) {
            const ang = (k / 4) * Math.PI * 2;
            const u = d.perpendicular();
            const v = d.cross(u);
            const rim = tip.add(u.scale(Math.cos(ang) * r)).add(v.scale(Math.sin(ang) * r));
            segments.push({ a: o, b: rim, color: c });
          }
        } else {
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * Math.PI * 2;
            const u = camera.right().scale(Math.cos(ang)).add(camera.up().scale(Math.sin(ang)));
            segments.push({ a: o.add(u.scale(s * 1.4)), b: o.add(u.scale(s * 2.2)), color: c });
          }
        }
      } else if (obj.type === 'camera' && obj.camera) {
        const c: [number, number, number] = selected ? THEME.wireSelected : THEME.camera;
        pushCameraGizmo(segments, m, obj.camera.fov, camera.pixelScaleAt(m.transformPoint(new Vec3()), this.height) * 55, c);
      } else if (obj.type === 'armature' && obj.armature) {
        // Bones as octahedra: a plain line gives no sense of which way a bone
        // is twisted, and roll is exactly what decides how a joint bends.
        const c: [number, number, number] = selected ? THEME.wireSelected : [0.55, 0.72, 0.95];
        const segs = posedSegments(obj.armature);
        for (let i = 0; i < segs.length; i++) {
          const head = m.transformPoint(segs[i].head);
          const tail = m.transformPoint(segs[i].tail);
          const bright: [number, number, number] = i === options.activeBone ? THEME.wireSelected : c;
          pushBone(segments, head, tail, bright);
        }
      } else if (obj.type === 'empty') {
        const c: [number, number, number] = selected ? THEME.wireSelected : [0.6, 0.6, 0.65];
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 24;
        for (let a = 0; a < 3; a++) {
          const d = Vec3.axis(a).scale(s);
          segments.push({ a: o.sub(d), b: o.add(d), color: c });
        }
      }
      if (options.showOrigins && obj.type === 'mesh' && selected) {
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 4;
        for (let a = 0; a < 3; a++) {
          const d = Vec3.axis(a).scale(s);
          segments.push({ a: o.sub(d), b: o.add(d), color: THEME.wireSelected, overlay: true });
        }
      }
    }

    // 3D cursor.
    if (options.showOverlays) {
      const o = scene.cursor;
      const s = camera.pixelScaleAt(o, this.height) * 12;
      pushCircle(segments, o, s * 0.7, camera, THEME.cursor, undefined, true);
      for (let a = 0; a < 3; a++) {
        const d = Vec3.axis(a).scale(s);
        segments.push({ a: o.sub(d), b: o.add(d), color: THEME.cursor, overlay: true });
      }
    }

    segments.push(...state.lines);
    if (segments.length === 0) return;

    const depth = segments.filter((s) => !s.overlay);
    const noDepth = segments.filter((s) => s.overlay);
    if (depth.length) this.flushSegments(depth, viewProj, true);
    if (noDepth.length) this.flushSegments(noDepth, viewProj, false);
  }

  private flushSegments(segments: LineSegment[], viewProj: Mat4, depthTest: boolean): void {
    const gl = this.gl;
    const data = new Float32Array(segments.length * 2 * 6);
    let o = 0;
    for (const s of segments) {
      for (const p of [s.a, s.b]) {
        data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
        data[o++] = s.color[0]; data[o++] = s.color[1]; data[o++] = s.color[2];
      }
    }
    this.lineScratch.upload(data, segments.length * 2);
    if (!depthTest) gl.disable(gl.DEPTH_TEST);
    this.drawLineBuffer(this.lineScratch, Mat4.identity(), viewProj, 0.0002, 1);
    if (!depthTest) gl.enable(gl.DEPTH_TEST);
  }

  /**
   * Keep a texture array in step with the scene. Images decode asynchronously,
   * so layers appear a frame or two after the scene references them.
   */
  private syncTextures(scene: Scene): void {
    const list = scene.textures.slice(0, MAX_TEXTURES);
    const signature = list.map((t) => `${t.id}:${t.url.length}`).join('|');
    if (signature === this.textureSignature) return;
    this.textureSignature = signature;

    const gl = this.gl;
    // Grow the array in steps rather than reserving the maximum: thirty-two
    // layers of 1024² RGBA with mipmaps is well over a hundred megabytes, and
    // most scenes use three.
    const want = Math.max(4, Math.min(MAX_TEXTURES, Math.ceil(Math.max(1, list.length) / 4) * 4));
    if (this.textureArray && want > this.textureCapacity) {
      gl.deleteTexture(this.textureArray);
      this.textureArray = null;
    }
    if (!this.textureArray) {
      this.textureArray = gl.createTexture();
      this.textureCapacity = want;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
      // Mip levels for a square power-of-two texture: log2(size) + 1.
      const levels = Math.floor(Math.log2(TEXTURE_SIZE)) + 1;
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, TEXTURE_SIZE, TEXTURE_SIZE, want);
      // Mipmapping matters more here than anywhere: without it a textured
      // floor seen at a glancing angle shimmers with every camera move, which
      // reads as a broken renderer rather than as an aliasing artefact.
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
        gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
    }

    this.textureLayers.clear();
    let pending = 0;
    list.forEach((tex, layer) => {
      if (layer >= this.textureCapacity) return;
      this.textureLayers.set(tex.id, layer);
      pending++;
      const img = new Image();
      const done = (): void => {
        pending--;
        if (pending === 0 && this.textureArray) {
          // One mipmap build once everything has landed, rather than one per
          // image: the call regenerates every layer either way.
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
          gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        }
        this.onTexturesReady?.();
      };
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = TEXTURE_SIZE;
        canvas.height = TEXTURE_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx || !this.textureArray) {
          done();
          return;
        }
        ctx.drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, TEXTURE_SIZE, TEXTURE_SIZE, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, canvas,
        );
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        done();
      };
      img.onerror = () => done();
      img.src = tex.url;
    });
  }

  // ---------------------------------------------------------------- shadows

  /**
   * Pick the light worth casting shadows from and render depth from it.
   *
   * One light, not all of them: each would need its own map and its own pass,
   * and a scene lit the way most are — a strong key with a couple of fills —
   * gets almost all of the benefit from the key alone. The strongest light
   * wins, which is nearly always the one the eye reads shadows from.
   */
  private renderShadowMap(state: FrameState, drawables: { mesh: Mesh; model: Mat4; obj: SceneObject }[]): void {
    const gl = this.gl;
    this.shadowLightIndex = -1;
    if (state.options.shading !== 'material' || drawables.length === 0) return;
    if (state.options.shadows === false) return;

    let index = -1;
    let bestEnergy = 0;
    let n = 0;
    let caster: SceneObject | null = null;
    for (const obj of state.scene.objects.values()) {
      if (n >= MAX_LIGHTS || obj.type !== 'light' || !obj.visible || !obj.light) continue;
      // A point light casts in every direction and would need a cube map;
      // suns and spots have a direction, which one matrix can describe.
      const directional = obj.light.type === 'sun' || obj.light.type === 'spot';
      if (directional && obj.light.energy > bestEnergy) {
        bestEnergy = obj.light.energy;
        index = n;
        caster = obj;
      }
      n++;
    }
    if (!caster || !caster.light) return;

    // Fit the map to what is actually in the scene, so its resolution is spent
    // on the model rather than on empty space around it.
    const bounds = new AABB();
    for (const d of drawables) {
      const b = d.mesh.bounds();
      if (!b.valid) continue;
      for (let i = 0; i < 8; i++) {
        bounds.expand(d.model.transformPoint(new Vec3(
          i & 1 ? b.max.x : b.min.x,
          i & 2 ? b.max.y : b.min.y,
          i & 4 ? b.max.z : b.min.z,
        )));
      }
    }
    if (!bounds.valid) return;
    const centre = bounds.center();
    const radius = Math.max(1e-3, bounds.radius());

    const m = caster.worldMatrix(state.scene);
    const dir = m.transformDirection(new Vec3(0, 0, -1)).normalized();
    const eye = centre.sub(dir.scale(radius * 2.5));
    const up = Math.abs(dir.z) > 0.95 ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
    const view = Mat4.lookAt(eye, centre, up);
    const proj = Mat4.orthographic(-radius, radius, -radius, radius, 0.01, radius * 5);
    this.shadowViewProj = proj.multiply(view);
    this.shadowLightIndex = index;

    if (!this.shadowFbo) this.createShadowTarget();
    if (!this.shadowFbo) {
      this.shadowLightIndex = -1;
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    // Draw back faces into the map: the depth recorded is then the far side of
    // each object, which puts the bias comfortably away from the lit surface
    // and removes most shadow acne outright.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);

    const p = this.shadowProgram;
    p.use();
    p.setMat4('uLightViewProj', this.shadowViewProj.m);
    for (const d of drawables) {
      const entry = this.geometryFor(d.obj, d.mesh, state.edit);
      if (entry.surface.count === 0) continue;
      p.setMat4('uModel', d.model.m);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.surface.buffer);
      setupAttribs(gl, p, SURFACE_LAYOUT);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.surfaceIndex.buffer);
      gl.drawElements(gl.TRIANGLES, entry.surfaceIndex.count, gl.UNSIGNED_INT, 0);
      this.lastDrawCalls++;
    }

    gl.cullFace(gl.BACK);
    gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private createShadowTarget(): void {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Hardware depth comparison, which is what makes a filtered lookup give a
    // smooth edge rather than a stepped one.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    // A depth-only target has no colour buffer to draw into or read from.
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return;
    }
    this.shadowMap = tex;
    this.shadowFbo = fbo;
  }

  private bindShadowMap(p: Program): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    if (this.shadowMap) gl.bindTexture(gl.TEXTURE_2D, this.shadowMap);
    p.setInt('uShadowMap', 1);
    p.setMat4('uLightViewProj', this.shadowViewProj.m);
    p.setInt('uShadowLight', this.shadowLightIndex);
    p.setFloat('uShadowStrength', this.shadowLightIndex >= 0 && this.shadowMap ? 0.85 : 0);
    p.setFloat('uShadowTexel', 1 / SHADOW_SIZE);
    // Put the active unit back. Everything else in this file that touches a
    // texture — the array upload, the mipmap rebuild, the paint preview —
    // binds without naming a unit, and those run from image callbacks between
    // frames, long after this left the context pointing somewhere else.
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Force the texture array to be rebuilt on the next frame.
   *
   * The signature check keys on the data URL, so a texture whose pixels
   * changed but whose URL happens to be the same length would otherwise be
   * missed.
   */
  invalidateTextures(): void {
    this.textureSignature = '';
  }

  /**
   * Push a paint canvas straight into its texture layer, skipping the encode.
   *
   * Painting has to show up on the model as the brush moves, and going through
   * a PNG for that would be far too slow. The proper upload still happens when
   * the stroke ends; this just keeps the viewport honest in between.
   */
  uploadPaintPreview(canvas: HTMLCanvasElement | null, textureId: number): void {
    if (!canvas || !this.textureArray) return;
    const layer = this.textureLayers.get(textureId);
    if (layer === undefined) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, TEXTURE_SIZE, TEXTURE_SIZE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, canvas,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // The lower mip levels are now stale; regenerating keeps a painted surface
    // from going smooth again the moment the camera pulls back.
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  private bindTextures(p: Program): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    if (this.textureArray) gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    p.setInt('uTextures', 0);
  }

  dispose(): void {
    for (const e of this.cache.values()) {
      e.surface.dispose();
      e.wire.dispose();
      e.points.dispose();
    }
    this.cache.clear();
    this.lineScratch.dispose();
    this.gl.deleteBuffer(this.gridQuad);
    this.surfaceProgram.dispose();
    this.outlineProgram.dispose();
    this.lineProgram.dispose();
    this.shadowProgram.dispose();
    if (this.shadowMap) this.gl.deleteTexture(this.shadowMap);
    if (this.shadowFbo) this.gl.deleteFramebuffer(this.shadowFbo);
    this.pointProgram.dispose();
    this.gridProgram.dispose();
  }
}

function pushCircle(
  out: LineSegment[], center: Vec3, radius: number, camera: ViewportCamera,
  color: [number, number, number], normal?: Vec3, overlay = false,
): void {
  const n = normal ? normal.normalized() : camera.forward();
  const u = n.perpendicular();
  const v = n.cross(u);
  const steps = 24;
  let prev = center.add(u.scale(radius));
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const p = center.add(u.scale(Math.cos(a) * radius)).add(v.scale(Math.sin(a) * radius));
    out.push({ a: prev, b: p, color, overlay });
    prev = p;
  }
}

/**
 * An octahedral bone from head to tail.
 *
 * A plain line would be cheaper, but it gives no sense of which way the bone
 * is twisted — and roll is exactly what decides which way a joint bends, so it
 * has to be visible.
 */
function pushBone(
  out: LineSegment[], head: Vec3, tail: Vec3, color: [number, number, number],
): void {
  const axis = tail.sub(head);
  const len = axis.length();
  if (len < 1e-6) return;
  const dir = axis.scale(1 / len);
  const helper = Math.abs(dir.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  const x = helper.cross(dir).normalized().scale(len * 0.12);
  const y = dir.cross(x.normalized()).normalized().scale(len * 0.12);
  // The widest point sits a short way along, which is what reads as a joint.
  const waist = head.add(dir.scale(len * 0.2));
  const ring = [waist.add(x), waist.add(y), waist.sub(x), waist.sub(y)];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    out.push({ a, b, color });
    out.push({ a: head, b: a, color });
    out.push({ a, b: tail, color });
  }
}

function pushCameraGizmo(
  out: LineSegment[], m: Mat4, fov: number, size: number, color: [number, number, number],
): void {
  const o = m.transformPoint(new Vec3());
  const h = Math.tan(fov / 2) * size;
  const w = h * 1.5;
  const corners = [
    new Vec3(-w, -h, -size), new Vec3(w, -h, -size), new Vec3(w, h, -size), new Vec3(-w, h, -size),
  ].map((p) => m.transformPoint(p));
  for (let i = 0; i < 4; i++) {
    out.push({ a: corners[i], b: corners[(i + 1) % 4], color });
    out.push({ a: o, b: corners[i], color });
  }
  // Up triangle marker.
  const top = m.transformPoint(new Vec3(0, h * 1.6, -size));
  out.push({ a: corners[3], b: top, color });
  out.push({ a: corners[2], b: top, color });
}

