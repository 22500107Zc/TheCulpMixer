import {
  Channel, ChannelPath, PROPERTY_PATHS, channelDefault, cloneChannels, pathComponents,
  sampleChannel,
} from './animation';

/**
 * Actions and strips — animation you can reuse, cut and blend.
 *
 * A single channel list per object is enough to animate one shot and nothing
 * more. The moment somebody has a walk and a wave and wants the character to
 * wave while walking, that model is finished: there is one set of keys, the
 * two are on the same channels, and the only way to combine them is to key the
 * result by hand and lose both originals.
 *
 * So a set of keys becomes an **action** — named, kept, reusable — and the
 * timeline holds **strips** that say when an action plays, how fast, how
 * strongly, and whether it replaces what came before or adds on top of it. A
 * walk is a `replace` strip; a wave laid over it is an `add` strip weighted
 * against the rest pose. Fades taper a strip's weight at its ends so two takes
 * cross rather than snap.
 *
 * The object's own `animation` stays exactly what it was — the keys being
 * edited right now — and is used whenever there are no strips, so every file
 * and every habit from before this existed works unchanged.
 */

export interface Action {
  /** Stable across renames, because a strip points at it. */
  id: string;
  name: string;
  channels: Channel[];
}

export type BlendMode = 'replace' | 'add';

export interface Strip {
  /** Which action, by id. */
  action: string;
  /** Timeline frame the strip starts on. */
  start: number;
  /** Timeline frame it ends on. Equal to `start` means a single frame. */
  end: number;
  /**
   * The frame inside the action that `start` lines up with.
   *
   * This is what lets a four-second cycle be entered halfway through, which is
   * most of what makes two strips of the same walk read as one walk.
   */
  offset: number;
  /** Playback rate. 2 plays the action twice as fast; 0.5, half. */
  scale: number;
  blend: BlendMode;
  /** Constant weight, before the fades. */
  weight: number;
  /** Frames over which the weight rises at the start. */
  fadeIn: number;
  /** Frames over which it falls at the end. */
  fadeOut: number;
  enabled?: boolean;
  /** Keep playing the action end to end for as long as the strip lasts. */
  loop?: boolean;
}

let actionCounter = 0;

export function createAction(name = 'Action', channels: Channel[] = []): Action {
  actionCounter += 1;
  return { id: `act${actionCounter}_${Math.random().toString(36).slice(2, 8)}`, name, channels };
}

export function cloneAction(a: Action): Action {
  return { id: a.id, name: a.name, channels: cloneChannels(a.channels) };
}

export function createStrip(action: string, start = 1, end = 60): Strip {
  return {
    action, start, end, offset: 0, scale: 1,
    blend: 'replace', weight: 1, fadeIn: 0, fadeOut: 0, enabled: true, loop: false,
  };
}

export function cloneStrip(s: Strip): Strip {
  return { ...s };
}

/** The frames an action's keys actually span. */
export function actionRange(a: Action): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const ch of a.channels) {
    for (const k of ch.keys) {
      if (k.frame < start) start = k.frame;
      if (k.frame > end) end = k.frame;
    }
  }
  if (!Number.isFinite(start)) return { start: 0, end: 0 };
  return { start, end };
}

/**
 * How strongly a strip applies at a timeline frame, and where inside its
 * action that frame lands.
 *
 * `null` when the strip is not playing at all, which is the common answer and
 * worth returning cheaply.
 */
export function stripAt(
  s: Strip, frame: number, range: { start: number; end: number } = { start: 0, end: 0 },
): { weight: number; local: number } | null {
  if (s.enabled === false) return null;
  const start = Math.min(s.start, s.end);
  const end = Math.max(s.start, s.end);
  if (frame < start || frame > end) return null;

  const scale = Number.isFinite(s.scale) && s.scale !== 0 ? s.scale : 1;
  const span = end - start;
  let into = (frame - start) * scale + (Number.isFinite(s.offset) ? s.offset : 0);

  // A looping strip wraps within its action's own range, so a two-second cycle
  // fills a ten-second strip without the animator copying it five times. The
  // wrap is about the action's first key rather than about zero: an action
  // that runs from frame 10 to 30 loops over those twenty frames, not over the
  // thirty that include the empty ones before it.
  const length = range.end - range.start;
  if (s.loop && length > 0) {
    into = range.start + (((into - range.start) % length) + length) % length;
  }

  let weight = Number.isFinite(s.weight) ? Math.max(0, Math.min(1, s.weight)) : 1;
  // Fades are in frames and are clamped against each other, so a strip shorter
  // than its own fades still reaches its peak in the middle rather than
  // producing a weight above one or a negative one.
  const fadeIn = Math.max(0, Number.isFinite(s.fadeIn) ? s.fadeIn : 0);
  const fadeOut = Math.max(0, Number.isFinite(s.fadeOut) ? s.fadeOut : 0);
  if (fadeIn > 0 && span > 0) weight *= Math.min(1, (frame - start) / fadeIn);
  if (fadeOut > 0 && span > 0) weight *= Math.min(1, (end - frame) / fadeOut);
  if (weight <= 0) return null;
  return { weight: Math.max(0, Math.min(1, weight)), local: into };
}

/** One blended result: every component that any strip had something to say about. */
export interface BlendedPose {
  /** path → per-component value, NaN where nothing drove it. */
  values: Map<ChannelPath, number[]>;
  /** True when at least one strip was playing. */
  any: boolean;
}

/**
 * Blend every strip that is playing at a frame.
 *
 * Strips are applied in order, each on top of the last, which is what makes
 * the list an order rather than a set. `replace` moves the running value
 * towards the strip's by its weight — so a half-weight strip is halfway
 * between what was already there and what it wants — and `add` adds the
 * strip's departure from rest, which is the thing that lets a wave ride on top
 * of a walk instead of cancelling it.
 */
export function blendStrips(strips: Strip[], actions: Action[], frame: number): BlendedPose {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const values = new Map<ChannelPath, number[]>();
  let any = false;

  for (const strip of strips) {
    const action = byId.get(strip.action);
    if (!action) continue;
    const at = stripAt(strip, frame, actionRange(action));
    if (!at) continue;
    const local = at.local;

    for (const ch of action.channels) {
      const sampled = sampleChannel(ch, local);
      if (sampled === null) continue;
      any = true;
      let slot = values.get(ch.path);
      if (!slot) {
        slot = new Array(pathComponents(ch.path)).fill(NaN);
        values.set(ch.path, slot);
      }
      if (ch.index >= slot.length) continue;
      const rest = channelDefault(ch.path)[ch.index] ?? 0;
      const current = Number.isNaN(slot[ch.index]) ? rest : slot[ch.index];
      slot[ch.index] = strip.blend === 'add'
        ? current + (sampled - rest) * at.weight
        : current + (sampled - current) * at.weight;
    }
  }
  return { values, any };
}

/** Split a blend into the transform half and the property half. */
export function splitBlend(pose: BlendedPose): {
  transform: Map<ChannelPath, number[]>;
  properties: Map<ChannelPath, number[]>;
} {
  const transform = new Map<ChannelPath, number[]>();
  const properties = new Map<ChannelPath, number[]>();
  for (const [path, values] of pose.values) {
    (PROPERTY_PATHS.includes(path) ? properties : transform).set(path, values);
  }
  return { transform, properties };
}

/** Clean actions and strips coming off disk, dropping what cannot be used. */
export function cloneActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id) continue;
    out.push({
      id: rec.id,
      name: typeof rec.name === 'string' ? rec.name : 'Action',
      channels: cloneChannels(Array.isArray(rec.channels) ? (rec.channels as Channel[]) : []),
    });
  }
  return out;
}

export function cloneStrips(raw: unknown): Strip[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const out: Strip[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    if (typeof rec.action !== 'string' || !rec.action) continue;
    out.push({
      action: rec.action,
      start: num(rec.start, 1),
      end: num(rec.end, 60),
      offset: num(rec.offset, 0),
      scale: num(rec.scale, 1) || 1,
      blend: rec.blend === 'add' ? 'add' : 'replace',
      weight: Math.max(0, Math.min(1, num(rec.weight, 1))),
      fadeIn: Math.max(0, num(rec.fadeIn, 0)),
      fadeOut: Math.max(0, num(rec.fadeOut, 0)),
      enabled: rec.enabled === undefined ? true : !!rec.enabled,
      loop: !!rec.loop,
    });
  }
  return out;
}
