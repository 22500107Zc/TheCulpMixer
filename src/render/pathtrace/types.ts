/**
 * The flat, structured-cloneable description of a scene the path tracer works
 * from. Nothing here holds a class instance, so the whole thing crosses into a
 * worker with no serialization step of its own.
 */

/**
 * Per material: colour(3) metallic roughness emission(3) emissionStrength
 * alpha transmission ior.
 */
/**
 * Floats per material.
 *
 * Twelve of these describe the surface; the last five say which picture is on
 * it and how it is laid out. Without them the final render ignored every
 * image texture in the scene — a checker, a photograph, a painted map — and
 * returned the flat base colour, so the preview viewport and the finished
 * render disagreed about what the model looked like.
 */
export const MATERIAL_STRIDE = 17;

/** Offsets into a material record, so the tracer and the builder cannot drift. */
export const MAT_TEXTURE = 12;
export const MAT_UV_SCALE = 13;
export const MAT_UV_OFFSET = 15;
/** Per light: position(3) type colour(3) radius direction(3) spotCos. */
export const LIGHT_STRIDE = 12;

export interface TraceCamera {
  origin: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view in radians. */
  fovY: number;
  orthographic: boolean;
  orthoHeight: number;
  /**
   * Lens radius in scene units. Zero is a pinhole; anything larger throws
   * everything off the focal plane out of focus, the way a real lens does.
   */
  aperture: number;
  /** Distance to the plane that stays sharp. */
  focusDistance: number;
}

export interface TraceScene {
  /** 9 floats per triangle. */
  positions: Float32Array;
  /** 9 floats per triangle; already smoothed or faceted as authored. */
  normals: Float32Array;
  /** 6 floats per triangle, or empty when the mesh has no coordinates. */
  uvs: Float32Array;
  /**
   * 9 floats per triangle of vertex colour, or empty when nothing is painted.
   * Multiplied into the base colour the same way the viewport does it, so a
   * render matches what was on screen.
   */
  colors: Float32Array;
  /** One material index per triangle. */
  material: Int32Array;
  materials: Float32Array;
  /**
   * Every image the materials refer to, decoded and packed end to end.
   *
   * Linear, premultiplied by nothing, four channels. Decoded once on the main
   * thread — a worker has no DOM to decode a data URL with — and handed over
   * as one transferable block rather than a structure per texture.
   */
  textures: Float32Array;
  /** Where each texture starts in that block, plus its size: [offset, w, h]. */
  textureIndex: Int32Array;
  lights: Float32Array;
  lightCount: number;
  /**
   * Triangles with emissive materials, so they can be sampled directly rather
   * than found by luck. Without this an emission plane — the way most people
   * light an interior — is pure noise.
   */
  emissive: Int32Array;
  /** Running sum of emissive triangle areas, for picking one by area. */
  emissiveCdf: Float32Array;
  /** Total emissive area; zero when the scene has no emissive surfaces. */
  emissiveArea: number;
  background: [number, number, number];
  ambient: number;
  /** Strength of the sky as an area light, on top of the flat background. */
  skyStrength: number;
  camera: TraceCamera;
}

export interface RenderSettings {
  width: number;
  height: number;
  samples: number;
  maxBounces: number;
  /** Samples accumulated per progressive pass. */
  samplesPerPass: number;
  transparentBackground: boolean;
  /** Stops of exposure applied before tonemapping; 0 leaves it alone. */
  exposure: number;
  /**
   * Run the edge-aware filter over the result. Worth it below a few hundred
   * samples, where the noise floor is what you notice rather than the light.
   */
  denoise: boolean;
  /**
   * The frames an animation render covers.
   *
   * Absent until now: the renderer only ever produced one image, so "render
   * the animation" was not a thing the application could do at all. A still is
   * this range collapsed to a single frame.
   */
  frameStart?: number;
  frameEnd?: number;
  /** Render every Nth frame. 1 is every frame; 2 halves the work for a test. */
  frameStep?: number;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    width: 960, height: 540, samples: 128, maxBounces: 6,
    samplesPerPass: 4, transparentBackground: false, exposure: 0, denoise: true,
  };
}

export interface BandRequest {
  y0: number;
  y1: number;
  pass: number;
  samples: number;
  seed: number;
}

export interface BandResult {
  y0: number;
  y1: number;
  samples: number;
  /** RGB radiance sums for the band, 3 floats per pixel. */
  data: Float32Array;
  /**
   * First-hit surface colour, normal and distance, summed the same way. These
   * are what let a filter tell a noisy flat wall from a genuine edge: they
   * come out of the same rays for free and carry almost no noise themselves.
   */
  albedo: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
}
