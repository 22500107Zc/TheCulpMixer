import { setting } from '../core/math';
import { Bitmap, Mask } from './contour';

/**
 * Finding the subject in a photograph.
 *
 * Everything downstream of a reference image — the silhouette, the inflation,
 * the texture — depends on knowing which pixels are the thing and which are
 * the room it was standing in. The Culp Mixer used to decide that with one global
 * brightness threshold, which is exactly right for a logo on white and
 * useless for anything else: a shoe on a wooden floor, a chair against a wall,
 * a person outdoors. Half the floor came out as subject, the dark parts of the
 * shoe came out as floor, and the model that came out the other end looked
 * nothing like the photograph. That single threshold was the reason The Culp Mixer
 * could only ever turn logos into 3D.
 *
 * So the subject is found by colour instead, in CIELAB where distance means
 * roughly what the eye means by "a different colour". A band around the edge
 * of the frame is taken as definitely background and the middle as probably
 * subject; each gets a small set of colour clusters; every pixel then goes to
 * whichever set explains it better. The models are refit from the result and
 * it runs again, a few times, each pass sharpened against the image's own
 * colour edges so the boundary lands on the object's outline rather than
 * drifting across it. That is a cut-down GrabCut, and it is the difference
 * between a photograph working and not.
 *
 * Everything is deterministic — no random seeding anywhere — so the same
 * photograph always gives the same model, which matters when the model is
 * something you are going to keep working on.
 */

export interface Matte {
  width: number;
  height: number;
  /** 0 is background, 1 is subject, with soft values across the boundary. */
  data: Float32Array;
  /**
   * How far apart the subject's colours were from the background's, in
   * spreads. Below about 4 the two are the same thing as far as colour is
   * concerned and the whole frame was taken as subject — worth saying out
   * loud rather than quietly handing back a rectangle.
   */
  separation: number;
}

export interface SegmentOptions {
  /**
   * Fraction of the shorter side around the frame taken as definitely
   * background. A photograph is framed around its subject, so the very edge
   * is the one region that can be assumed.
   */
  border?: number;
  /** Refinement passes. Two is usually enough; more costs milliseconds. */
  passes?: number;
  /** Colour clusters in each of the two models. */
  clusters?: number;
  /** How hard the boundary is pulled onto colour edges, 0..1. */
  edgeSnap?: number;
  /** Softening of the final edge, in pixels. */
  feather?: number;
  /**
   * The user's own corrections, one byte per pixel of the same frame.
   *
   * `HINT_NONE` where they have said nothing, `HINT_SUBJECT` where they have
   * marked the thing they want, `HINT_BACKGROUND` where they have marked what
   * they do not. Both are treated as ground truth rather than as evidence:
   * they seed the colour models, they are pinned after every pass, and a
   * region carrying a subject mark is never discarded as a stray blob.
   *
   * This is what makes a photograph the colour models cannot separate usable
   * anyway — a shoe on a carpet the same shade as the shoe needs two strokes,
   * not a better algorithm.
   */
  hints?: Uint8Array;
}

/** No correction here. */
export const HINT_NONE = 0;
/** The user marked this as the thing they want modelled. */
export const HINT_SUBJECT = 1;
/** The user marked this as background. */
export const HINT_BACKGROUND = 2;

// ------------------------------------------------------------------- colour

/** sRGB 0..255 to CIELAB, three floats per pixel. */
export function labFromBitmap(bitmap: Bitmap): Float32Array {
  const n = bitmap.width * bitmap.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = srgbToLinear(bitmap.data[o] / 255);
    const g = srgbToLinear(bitmap.data[o + 1] / 255);
    const b = srgbToLinear(bitmap.data[o + 2] / 255);
    // Linear sRGB to XYZ, D65, then XYZ to Lab.
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    const fx = labCurve(x);
    const fy = labCurve(y);
    const fz = labCurve(z);
    out[i * 3] = 116 * fy - 16;
    out[i * 3 + 1] = 500 * (fx - fy);
    out[i * 3 + 2] = 200 * (fy - fz);
  }
  return out;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labCurve(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function labDistanceSq(lab: Float32Array, a: number, b: number): number {
  const dl = lab[a * 3] - lab[b * 3];
  const da = lab[a * 3 + 1] - lab[b * 3 + 1];
  const db = lab[a * 3 + 2] - lab[b * 3 + 2];
  return dl * dl + da * da + db * db;
}

// ------------------------------------------------------------ colour models

interface ColourModel {
  /** Cluster centres, three components each. */
  centres: Float32Array;
  /** Mean squared distance within each cluster, floored so it never divides by nothing. */
  spread: Float32Array;
  count: number;
}

/**
 * k-means over a sample of pixels, seeded farthest-point-first.
 *
 * Farthest-point seeding rather than random seeding because a generator that
 * gives a different mask each time it is run is not something anyone can
 * model against — you would tweak a slider and not know whether the change
 * came from the slider or the dice.
 */
function fitModel(lab: Float32Array, indices: number[], k: number, iterations = 6): ColourModel {
  const count = Math.min(k, indices.length);
  const centres = new Float32Array(Math.max(1, count) * 3);
  const spread = new Float32Array(Math.max(1, count)).fill(64);
  if (indices.length === 0) return { centres, spread, count: 0 };

  // Seed on the sample nearest the mean, then repeatedly on whichever sample
  // is farthest from everything chosen so far.
  let ml = 0, ma = 0, mb = 0;
  for (const i of indices) { ml += lab[i * 3]; ma += lab[i * 3 + 1]; mb += lab[i * 3 + 2]; }
  ml /= indices.length; ma /= indices.length; mb /= indices.length;
  let best = indices[0];
  let bestD = Infinity;
  for (const i of indices) {
    const d = (lab[i * 3] - ml) ** 2 + (lab[i * 3 + 1] - ma) ** 2 + (lab[i * 3 + 2] - mb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  centres[0] = lab[best * 3]; centres[1] = lab[best * 3 + 1]; centres[2] = lab[best * 3 + 2];

  const nearest = new Float32Array(indices.length).fill(Infinity);
  for (let c = 1; c < count; c++) {
    let far = indices[0];
    let farD = -1;
    for (let s = 0; s < indices.length; s++) {
      const i = indices[s];
      const d = pointDistanceSq(lab, i, centres, c - 1);
      if (d < nearest[s]) nearest[s] = d;
      if (nearest[s] > farD) { farD = nearest[s]; far = i; }
    }
    centres[c * 3] = lab[far * 3];
    centres[c * 3 + 1] = lab[far * 3 + 1];
    centres[c * 3 + 2] = lab[far * 3 + 2];
  }

  const sums = new Float64Array(count * 3);
  const members = new Float64Array(count);
  const errors = new Float64Array(count);
  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0); members.fill(0); errors.fill(0);
    for (const i of indices) {
      let pick = 0;
      let pickD = Infinity;
      for (let c = 0; c < count; c++) {
        const d = pointDistanceSq(lab, i, centres, c);
        if (d < pickD) { pickD = d; pick = c; }
      }
      sums[pick * 3] += lab[i * 3];
      sums[pick * 3 + 1] += lab[i * 3 + 1];
      sums[pick * 3 + 2] += lab[i * 3 + 2];
      members[pick]++;
      errors[pick] += pickD;
    }
    for (let c = 0; c < count; c++) {
      if (members[c] === 0) continue;
      centres[c * 3] = sums[c * 3] / members[c];
      centres[c * 3 + 1] = sums[c * 3 + 1] / members[c];
      centres[c * 3 + 2] = sums[c * 3 + 2] / members[c];
      // The floor keeps a cluster of near-identical pixels from claiming
      // certainty it has not earned.
      spread[c] = Math.max(16, errors[c] / members[c]);
    }
  }
  return { centres, spread, count };
}

function pointDistanceSq(lab: Float32Array, i: number, centres: Float32Array, c: number): number {
  const dl = lab[i * 3] - centres[c * 3];
  const da = lab[i * 3 + 1] - centres[c * 3 + 1];
  const db = lab[i * 3 + 2] - centres[c * 3 + 2];
  return dl * dl + da * da + db * db;
}

/**
 * Below this the subject's colours and the background's are the same colours.
 * Four spreads is roughly "a difference you could see across the room".
 */
export const MIN_SEPARATION = 4;

/**
 * How far the most distinctive foreground colour sits from everything the
 * background contains, measured in that background cluster's own spread.
 *
 * The maximum rather than the average, because the middle of a frame always
 * contains some background too — a subject only has to bring one colour the
 * edges do not have for there to be something to cut out.
 */
function modelSeparation(bg: ColourModel, fg: ColourModel): number {
  let best = 0;
  for (let c = 0; c < fg.count; c++) {
    let nearest = Infinity;
    for (let b = 0; b < bg.count; b++) {
      const dl = fg.centres[c * 3] - bg.centres[b * 3];
      const da = fg.centres[c * 3 + 1] - bg.centres[b * 3 + 1];
      const db = fg.centres[c * 3 + 2] - bg.centres[b * 3 + 2];
      nearest = Math.min(nearest, (dl * dl + da * da + db * db) / bg.spread[b]);
    }
    if (nearest > best) best = nearest;
  }
  return best;
}

/** How badly a model explains a pixel: the best cluster's distance, in spreads. */
function cost(model: ColourModel, lab: Float32Array, i: number): number {
  if (model.count === 0) return 1e6;
  let best = Infinity;
  for (let c = 0; c < model.count; c++) {
    const d = pointDistanceSq(lab, i, model.centres, c) / model.spread[c];
    if (d < best) best = d;
  }
  return best;
}

// -------------------------------------------------------------- the segment

export function segmentSubject(bitmap: Bitmap, options: SegmentOptions = {}): Matte {
  const { width, height } = bitmap;
  const n = width * height;
  const data = new Float32Array(n);
  if (n === 0) return { width, height, data, separation: 0 };

  // A cut-out PNG has already answered the question.
  const cutout = alphaMatte(bitmap);
  if (cutout) return cutout;

  const border = Math.max(1, Math.round(setting(options.border, 0.06, 0, 0.49) * Math.min(width, height)));
  const passes = Math.floor(setting(options.passes, 3, 1, 8));
  const clusters = Math.floor(setting(options.clusters, 5, 1, 12));
  const edgeSnap = setting(options.edgeSnap, 0.7, 0, 1);

  const lab = labFromBitmap(bitmap);

  const hints = options.hints && options.hints.length === n ? options.hints : null;
  let markedSubject = 0;
  let markedBackground = 0;
  if (hints) {
    for (let i = 0; i < n; i++) {
      if (hints[i] === HINT_SUBJECT) markedSubject++;
      else if (hints[i] === HINT_BACKGROUND) markedBackground++;
    }
  }
  const corrected = markedSubject > 0 || markedBackground > 0;
  /** Hold the user's marks to what they said, wherever the solver has been. */
  const pinHints = (): void => {
    if (!hints) return;
    for (let i = 0; i < n; i++) {
      if (hints[i] === HINT_SUBJECT) data[i] = 1;
      else if (hints[i] === HINT_BACKGROUND) data[i] = 0;
    }
  };

  // Sampling rather than using every pixel: the models are five colours, and
  // four thousand pixels pin those down as well as a million do.
  const stride = Math.max(1, Math.floor(Math.sqrt(n / 4000)));
  const bgSeeds: number[] = [];
  const fgSeeds: number[] = [];
  const insetX = Math.floor(width * 0.25);
  const insetY = Math.floor(height * 0.25);
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x;
      // A mark overrules the guess entirely. The frame's edge is assumed to be
      // background and its middle assumed to be subject, and both assumptions
      // are exactly what somebody reaches for the brush to correct — a subject
      // that runs off the edge of the frame, or a hole through the middle of
      // it.
      if (hints && hints[i] !== HINT_NONE) {
        (hints[i] === HINT_SUBJECT ? fgSeeds : bgSeeds).push(i);
        continue;
      }
      if (x < border || y < border || x >= width - border || y >= height - border) bgSeeds.push(i);
      else if (x >= insetX && y >= insetY && x < width - insetX && y < height - insetY) fgSeeds.push(i);
    }
  }
  // Marks made too finely to survive the sampling stride still have to count,
  // or a thin stroke on a big photograph does nothing at all.
  if (hints && (fgSeeds.length === 0 || bgSeeds.length === 0)) {
    for (let i = 0; i < n; i++) {
      if (hints[i] === HINT_SUBJECT && fgSeeds.length === 0) fgSeeds.push(i);
      else if (hints[i] === HINT_BACKGROUND && bgSeeds.length === 0) bgSeeds.push(i);
    }
  }
  // A frame filled edge to edge by its subject has no background band to learn
  // from. Rather than inventing one, everything is subject.
  if (bgSeeds.length === 0 || fgSeeds.length === 0) {
    data.fill(1);
    return { width, height, data, separation: 0 };
  }

  let bg = fitModel(lab, bgSeeds, clusters);
  let fg = fitModel(lab, fgSeeds, clusters);

  // Nothing in the middle of the frame is a colour the edges do not already
  // have. That is a close-up, or a photograph of a wall, and there is no
  // subject to find; deciding one anyway produces an arbitrary blob whose
  // shape comes from the arithmetic rather than from the picture.
  const separation = modelSeparation(bg, fg);
  // Giving up because the colours are close is the right answer when nobody
  // has said otherwise, and the wrong one the moment somebody has: a person
  // who has just marked the subject and the background has told us where the
  // boundary is, and is owed an attempt at it.
  if (separation < MIN_SEPARATION && !corrected) {
    data.fill(1);
    return { width, height, data, separation };
  }

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      // The difference of the two costs, squashed. A pixel the background
      // explains far better lands near 0, one only the subject explains near 1,
      // and a pixel both explain about equally sits in the middle where the
      // spatial pass below can settle it from its neighbours.
      const d = cost(bg, lab, i) - cost(fg, lab, i);
      data[i] = 1 / (1 + Math.exp(-d * 0.35));
    }
    // The frame's edge is only assumed to be background; a mark is not.
    if (!corrected) pinBorder(data, width, height, border);
    pinHints();
    for (let s = 0; s < 3; s++) diffuse(data, lab, width, height, edgeSnap);
    if (!corrected) pinBorder(data, width, height, border);
    pinHints();

    if (pass + 1 < passes) {
      const nextBg: number[] = [];
      const nextFg: number[] = [];
      for (let i = 0; i < n; i += stride) {
        if (data[i] < 0.25) nextBg.push(i);
        else if (data[i] > 0.75) nextFg.push(i);
      }
      // Refit only while both sides still have something to learn from;
      // otherwise keep the models that produced this result.
      if (nextBg.length > clusters && nextFg.length > clusters) {
        bg = fitModel(lab, nextBg, clusters);
        fg = fitModel(lab, nextFg, clusters);
      } else break;
    }
  }

  keepLargestBlob(data, width, height, hints ?? undefined);
  fillEnclosedHoles(data, width, height);
  // Filling holes can swallow a gap somebody deliberately marked out.
  pinHints();

  // A close-up has no background band to learn from: the two models end up
  // describing the same colours and nothing wins. Coming back with an empty
  // mask reads as the feature being broken, so a frame that is all one thing
  // is treated as all subject, which at least gives something to crop.
  let covered = 0;
  for (let i = 0; i < n; i++) if (data[i] >= 0.5) covered++;
  if (covered / n < 0.02 && !corrected) {
    data.fill(1);
    return { width, height, data, separation };
  }

  // Bounded as well as guarded: the softening is a blur whose cost grows with
  // its radius, and a radius of a million is a window that never comes back.
  feather(data, width, height, setting(options.feather, 1.2, 0, 32));
  pinHints();
  return { width, height, data, separation };
}

/** Straight from the alpha channel, when the image came with one. */
function alphaMatte(bitmap: Bitmap): Matte | null {
  const n = bitmap.width * bitmap.height;
  let transparent = 0;
  const step = Math.max(1, Math.floor(n / 4096));
  let sampled = 0;
  for (let i = 0; i < n; i += step) {
    sampled++;
    if (bitmap.data[i * 4 + 3] < 250) transparent++;
  }
  if (transparent / Math.max(1, sampled) <= 0.05) return null;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = bitmap.data[i * 4 + 3] / 255;
  return { width: bitmap.width, height: bitmap.height, data, separation: Infinity };
}

function pinBorder(data: Float32Array, width: number, height: number, border: number): void {
  for (let y = 0; y < height; y++) {
    const edgeRow = y < border || y >= height - border;
    for (let x = 0; x < width; x++) {
      if (edgeRow || x < border || x >= width - border) data[y * width + x] = 0;
    }
  }
}

/**
 * One pass of colour-aware diffusion: every pixel moves towards its
 * neighbours, weighted by how similar they look.
 *
 * This is what puts the boundary on the object's outline. Plain blurring
 * would smear the mask across the outline instead, which is how a subject
 * ends up wearing a halo of the wall behind it.
 */
function diffuse(data: Float32Array, lab: Float32Array, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  const src = data.slice();
  const sigma = 90;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sum = src[i];
      let weight = 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const w = Math.exp(-labDistanceSq(lab, i, j) / sigma);
        sum += src[j] * w;
        weight += w;
      }
      data[i] = src[i] + (sum / weight - src[i]) * strength;
    }
  }
}

/**
 * Keep the biggest connected subject and drop the rest.
 *
 * A photograph almost always contains something else the colour models like —
 * a patch of skin-toned floor, a reflection — and those specks would each
 * become their own little island of geometry.
 */
/**
 * Reduce the mask to one subject — plus anything the user pointed at.
 *
 * The largest region is the subject; everything else is a stray patch of
 * background that happened to match. But a region the user has marked as
 * subject is not a guess to be overruled, however small it is: marking a
 * strap and watching it disappear is worse than no correction at all.
 */
function keepLargestBlob(
  data: Float32Array, width: number, height: number, hints?: Uint8Array,
): void {
  const n = width * height;
  const label = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const marked = new Set<number>();
  let bestLabel = -1;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (data[start] < 0.5 || label[start] >= 0) continue;
    const id = next++;
    let size = 0;
    label[start] = id;
    stack.push(start);
    const visit = (j: number): void => {
      if (label[j] < 0 && data[j] >= 0.5) {
        label[j] = id;
        stack.push(j);
      }
    };
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      if (hints && hints[i] === HINT_SUBJECT) marked.add(id);
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0) visit(i - 1);
      if (x + 1 < width) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y + 1 < height) visit(i + width);
    }
    if (size > bestSize) { bestSize = size; bestLabel = id; }
  }
  if (bestLabel < 0) return;
  for (let i = 0; i < n; i++) {
    if (label[i] !== bestLabel && !marked.has(label[i])) data[i] = 0;
  }
}

/**
 * Fill anything enclosed by the subject.
 *
 * A dark buckle inside a bag reads as background to the colour models, and
 * left alone it punches a hole clean through the finished model. Only regions
 * that cannot reach the frame edge are filled, so genuine gaps — the space
 * inside a handle — survive.
 */
function fillEnclosedHoles(data: Float32Array, width: number, height: number): void {
  const n = width * height;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (i: number): void => {
    if (!outside[i] && data[i] < 0.5) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) seed(i - 1);
    if (x + 1 < width) seed(i + 1);
    if (y > 0) seed(i - width);
    if (y + 1 < height) seed(i + width);
  }
  for (let i = 0; i < n; i++) if (!outside[i] && data[i] < 0.5) data[i] = 1;
}

/** A short blur so the rim of the geometry is not a staircase of pixels. */
function feather(data: Float32Array, width: number, height: number, radius: number): void {
  if (radius <= 0) return;
  const r = Math.max(1, Math.round(radius));
  blurAxis(data, width, height, r, true);
  blurAxis(data, width, height, r, false);
}

function blurAxis(data: Float32Array, width: number, height: number, r: number, horizontal: boolean): void {
  const src = data.slice();
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let a = 0; a < outer; a++) {
    for (let b = 0; b < inner; b++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const t = b + k;
        if (t < 0 || t >= inner) continue;
        sum += src[horizontal ? a * width + t : t * width + a];
        count++;
      }
      data[horizontal ? a * width + b : b * width + a] = sum / count;
    }
  }
}

/** The hard mask the contour tracer wants, from the soft matte. */
export function matteToMask(matte: Matte, threshold = 0.5): Mask {
  const data = new Uint8Array(matte.width * matte.height);
  for (let i = 0; i < data.length; i++) data[i] = matte.data[i] >= threshold ? 1 : 0;
  return { width: matte.width, height: matte.height, data };
}

/** What fraction of the frame the subject covers — a quick sanity read. */
export function matteCoverage(matte: Matte): number {
  if (matte.data.length === 0) return 0;
  // Counted at the same half-way line the rest of the pipeline cuts at, not
  // averaged. On a confident matte the two agree; on an uncertain one — a
  // subject barely separable from its background, where the values sit just
  // over the line rather than at 1 — the average reads about half of what is
  // actually modelled. That number is shown to the user as "the subject fills
  // N% of the frame", so it has to mean the thing that gets built.
  let covered = 0;
  for (let i = 0; i < matte.data.length; i++) if (matte.data[i] >= 0.5) covered++;
  return covered / matte.data.length;
}
