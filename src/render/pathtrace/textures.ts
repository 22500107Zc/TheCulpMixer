import { Scene } from '../../scene/Scene';

/**
 * Getting pictures into the path tracer.
 *
 * The tracer runs in workers, and a worker has no DOM: it cannot turn a data
 * URL into pixels, which is how Kline stores every texture so that a saved
 * scene is one self-contained file. So the decoding happens here, once, on the
 * thread that does have a document, and what crosses to the workers is a flat
 * block of floats they can index without unpacking anything.
 *
 * Until this existed the final render simply ignored image textures. A model
 * built from a photograph, a checker laid on to judge a UV layout, a painted
 * base map — all of them previewed correctly in the viewport and then rendered
 * as flat base colour, which is the worst kind of difference between a preview
 * and a result: it looks deliberate.
 */

export interface PackedTextures {
  /** Every image end to end: four linear channels per pixel. */
  data: Float32Array;
  /** Three ints per texture — offset into `data`, width, height. */
  index: Int32Array;
  /** Scene texture id to its slot, for materials to point at. */
  slotOf: Map<number, number>;
}

export const EMPTY_TEXTURES: PackedTextures = {
  data: new Float32Array(0), index: new Int32Array(0), slotOf: new Map(),
};

/**
 * sRGB to linear, per channel.
 *
 * A texture is authored and stored in sRGB; the tracer integrates light in
 * linear. Skipping this is the classic way to get a render that is close
 * enough to look right and wrong everywhere it matters — midtones too bright,
 * and colours that drift as soon as they are lit by anything but white.
 */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Decode one data URL to linear RGBA. Returns null if it cannot be read. */
async function decode(url: string): Promise<{ width: number; height: number; data: Float32Array } | null> {
  if (!url) return null;
  try {
    const bitmap = await loadBitmap(url);
    if (!bitmap || bitmap.width === 0 || bitmap.height === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const out = new Float32Array(canvas.width * canvas.height * 4);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = toLinear(pixels[i] / 255);
      out[i + 1] = toLinear(pixels[i + 1] / 255);
      out[i + 2] = toLinear(pixels[i + 2] / 255);
      // Alpha is a coverage fraction, not a colour, so it stays linear.
      out[i + 3] = pixels[i + 3] / 255;
    }
    return { width: canvas.width, height: canvas.height, data: out };
  } catch {
    return null;
  }
}

function loadBitmap(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Decode every texture a material actually points at.
 *
 * Only the ones in use: a scene can carry images from a reference photograph
 * or an earlier material, and decoding those would cost megabytes per render
 * for pixels nothing samples.
 */
export async function packTextures(scene: Scene): Promise<PackedTextures> {
  const wanted = new Set<number>();
  for (const m of scene.materials) {
    if (m.baseColorTexture != null) wanted.add(m.baseColorTexture);
  }
  if (!wanted.size || typeof document === 'undefined') return EMPTY_TEXTURES;

  const decoded: { id: number; width: number; height: number; data: Float32Array }[] = [];
  for (const tex of scene.textures) {
    if (!wanted.has(tex.id)) continue;
    const image = await decode(tex.url);
    if (image) decoded.push({ id: tex.id, ...image });
  }
  if (!decoded.length) return EMPTY_TEXTURES;

  let total = 0;
  for (const d of decoded) total += d.data.length;
  const data = new Float32Array(total);
  const index = new Int32Array(decoded.length * 3);
  const slotOf = new Map<number, number>();
  let at = 0;
  decoded.forEach((d, slot) => {
    data.set(d.data, at);
    index[slot * 3] = at;
    index[slot * 3 + 1] = d.width;
    index[slot * 3 + 2] = d.height;
    slotOf.set(d.id, slot);
    at += d.data.length;
  });
  return { data, index, slotOf };
}
