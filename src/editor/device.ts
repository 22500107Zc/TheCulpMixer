/**
 * What is this being used on, and what can it actually do.
 *
 * Three machines turn up and they want three different applications:
 *
 *   a desktop  — a mouse with a wheel and a middle button, a keyboard always
 *                present, a cursor that is one pixel wide
 *   a laptop   — a trackpad with no middle button, where scrolling is a
 *                two-finger glide and zooming is a pinch, and where the
 *                mouse idioms are physically impossible
 *   a phone    — a finger, no hover, no keyboard, and a contact patch about
 *                nine millimetres across
 *
 * The honest position on detecting these, because it decides the design:
 *
 * Touch is detectable. `(pointer: coarse)` and `(hover: none)` are exactly
 * the questions worth asking and every browser answers them.
 *
 * A desktop tower versus a laptop chassis is NOT detectable, by any API, on
 * purpose — it is fingerprinting surface and no browser exposes it. Trying to
 * read it out of the user-agent string gives an answer that is wrong for
 * every machine with an external mouse plugged into a laptop, or a trackpad
 * plugged into a desktop.
 *
 * But chassis is not the thing that matters. What matters is the pointing
 * device, because that is what decides whether "hold the middle button" is an
 * instruction somebody can follow. And mouse-versus-trackpad has no API
 * either: it is an open issue against the Pointer Events spec, unresolved as
 * of 2026, and every application that gets this right does it the same way —
 * by watching the wheel events and inferring from their shape.
 *
 * So this module does two separate things and does not confuse them:
 *
 *   - It reads capabilities, which are facts. Coarse or fine, hover or not,
 *     touch points, a keyboard. Behaviour hangs off these.
 *   - It infers a device label, which is a guess that improves. The label is
 *     used for wording — which key to name, which gesture to describe — and
 *     never to withhold a capability the machine demonstrably has.
 *
 * That split is the whole point. A Surface has a fine pointer AND a touch
 * screen; an iPad with a keyboard case has a trackpad AND a touch screen. Any
 * design that picks one label and disables the other input is broken on both,
 * and those are not rare machines.
 */

/** How the person is pointing at things, which is what the bindings hang off. */
export type Pointing = 'mouse' | 'trackpad' | 'touch';

/** What to call the machine, for wording only. Never gates a feature. */
export type DeviceLabel = 'desktop' | 'laptop' | 'tablet' | 'phone';

/** The facts, read from the platform rather than guessed. */
export interface Capabilities {
  /** A pointer that can resolve a single pixel — a mouse, trackpad or stylus. */
  fine: boolean;
  /** A pointer that cannot — a fingertip. */
  coarse: boolean;
  /** Whether the primary pointer can hover, which modal operators rely on. */
  hover: boolean;
  /** Simultaneous contacts the screen reports; 0 on a machine with no touch. */
  touchPoints: number;
  /** The shorter side of the screen in CSS pixels, for phone versus tablet. */
  shortSide: number;
}

export interface DeviceProfile extends Capabilities {
  pointing: Pointing;
  label: DeviceLabel;
  /** Whether a keyboard can be assumed to exist for shortcuts and hints. */
  keyboard: boolean;
  /** How near a press has to land to pick a vertex, edge or face. */
  pickRadius: number;
  /**
   * Whether `pointing` was observed or merely assumed.
   *
   * A trackpad cannot be told from a mouse until one of them is used, so the
   * application opens on an assumption and corrects itself on the first
   * scroll. Callers that show a hint want to know, so they can re-render
   * rather than leaving a laptop reading mouse instructions for ever.
   */
  certain: boolean;
  /** Why this conclusion was reached, in words, for the diagnostics panel. */
  why: string;
}

/** A cursor sits on one pixel; a fingertip covers about forty-four of them. */
export const MOUSE_PICK_RADIUS = 14;
export const TOUCH_PICK_RADIUS = 22;

/** Below this on the shorter side it is a phone, above it a tablet. */
export const PHONE_SHORT_SIDE = 600;

/** Ask the platform what it can do. Pure given its argument, for testing. */
export function readCapabilities(env: {
  matchMedia?: (q: string) => { matches: boolean };
  maxTouchPoints?: number;
  width?: number;
  height?: number;
}): Capabilities {
  const ask = (q: string): boolean => {
    try {
      return env.matchMedia?.(q).matches ?? false;
    } catch {
      // Media queries that a browser does not understand throw in some
      // engines rather than reporting false. An unknown answer is "no".
      return false;
    }
  };
  const touchPoints = env.maxTouchPoints ?? 0;
  // `any-pointer` rather than `pointer`, deliberately: a laptop with a touch
  // screen has a fine PRIMARY pointer and a coarse one as well, and the
  // primary-only question would hide the touch screen entirely.
  const fine = ask('(any-pointer: fine)');
  const coarse = ask('(any-pointer: coarse)') || touchPoints > 0;
  const w = env.width ?? 0;
  const h = env.height ?? 0;
  return {
    fine,
    coarse,
    hover: ask('(any-hover: hover)'),
    touchPoints,
    shortSide: w && h ? Math.min(w, h) : 0,
  };
}

/**
 * The starting guess, before any scroll has been seen.
 *
 * `mac` is passed in rather than read here because the wording helpers take it
 * the same way, and because the guess for a platform nobody on this end runs
 * is exactly the guess that needs testing.
 */
export function profileFrom(caps: Capabilities, pointing: Pointing | null, mac: boolean): DeviceProfile {
  // A machine that cannot hover and has no fine pointer is being touched, and
  // no amount of wheel evidence changes that.
  const touchOnly = caps.coarse && !caps.fine;
  const resolved: Pointing = touchOnly
    ? 'touch'
    : pointing ?? (mac ? 'trackpad' : 'mouse');

  let label: DeviceLabel;
  if (resolved === 'touch') {
    label = caps.shortSide > 0 && caps.shortSide >= PHONE_SHORT_SIDE ? 'tablet' : 'phone';
  } else {
    label = resolved === 'trackpad' ? 'laptop' : 'desktop';
  }

  return {
    ...caps,
    pointing: resolved,
    label,
    // A hoverable fine pointer effectively always comes with a keyboard; a
    // phone's on-screen keyboard is not one you can hold Shift on while
    // dragging, which is what the shortcuts actually need.
    keyboard: caps.fine && caps.hover,
    // Radius follows the coarse pointer, not the label. A laptop with a touch
    // screen is still touched with a finger, and that finger deserves the
    // bigger target even though the machine is called a laptop.
    pickRadius: resolved === 'touch' ? TOUCH_PICK_RADIUS : MOUSE_PICK_RADIUS,
    certain: touchOnly || pointing !== null,
    why: describe(caps, resolved, pointing !== null, mac),
  };
}

function describe(caps: Capabilities, pointing: Pointing, observed: boolean, mac: boolean): string {
  if (pointing === 'touch') {
    return `a coarse pointer with no fine one${caps.touchPoints ? ` and ${caps.touchPoints} touch points` : ''}`;
  }
  if (observed) {
    return pointing === 'trackpad'
      ? 'the scroll events have the shape a trackpad produces'
      : 'the scroll events have the shape a wheel produces';
  }
  return mac
    ? 'assumed from the platform, pending a first scroll'
    : 'assumed from the platform, pending a first scroll';
}

/* ------------------------------------------------------- wheel inference ---- */

/**
 * Evidence needed before the assumption is overturned.
 *
 * One event is not enough for the weak signals: a mouse wheel spun fast on a
 * machine with smooth scrolling can produce one small delta, and a trackpad
 * flicked hard can produce one large round one. The definitive signals below
 * bypass this entirely, because nothing but a trackpad produces them.
 */
export const WHEEL_EVIDENCE_NEEDED = 3;

/** A detent is about this much; anything far below it is a glide. */
export const DETENT_PIXELS = 40;

/**
 * Watches wheel events and works out what produced them.
 *
 * Three signals are conclusive on their own, because a wheel cannot make them:
 *
 *   - `ctrlKey` set on a wheel event the person did not hold Ctrl for. That
 *     is the browser reporting a trackpad pinch; there is no other source.
 *   - A delta with a fractional part. A wheel reports whole detents.
 *   - Movement on both axes at once. A wheel has one axis.
 *
 * Everything else is accumulated: large round single-axis deltas look like
 * detents, small ones arriving faster than a person can flick look like a
 * glide. Whichever side reaches the threshold first wins, and it can be
 * overturned later — plugging a mouse into a laptop should change the hints,
 * and it does, because the evidence starts favouring the other side.
 */
export class WheelWatcher {
  private trackpad = 0;
  private mouse = 0;
  private lastAt = 0;
  private decided: Pointing | null = null;

  /**
   * Feed one wheel event.
   *
   * `ctrlHeld` is whether the person is actually holding the key, which the
   * editor already tracks — without it a pinch cannot be told from a
   * deliberate Ctrl+scroll, and Ctrl+scroll is a zoom binding here.
   *
   * Returns the conclusion when it changes, and null when nothing has.
   */
  observe(
    e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
    ctrlHeld: boolean,
    now: number,
  ): Pointing | null {
    const gap = this.lastAt ? now - this.lastAt : Infinity;
    this.lastAt = now;

    // A pinch the person did not ask for by holding a key. Conclusive.
    if (e.ctrlKey && !ctrlHeld) return this.settle('trackpad');
    // A wheel counts whole detents. A fraction can only be a glide.
    if (!Number.isInteger(e.deltaY) || !Number.isInteger(e.deltaX)) return this.settle('trackpad');
    // One axis at a time is all a wheel has.
    if (e.deltaX !== 0 && e.deltaY !== 0) return this.settle('trackpad');

    // Line and page units come from a real wheel; a trackpad reports pixels.
    if (e.deltaMode !== 0) {
      this.mouse += 2;
    } else if (Math.abs(e.deltaY) >= DETENT_PIXELS && e.deltaX === 0) {
      this.mouse += 1;
    } else if (Math.abs(e.deltaY) < DETENT_PIXELS || e.deltaX !== 0) {
      // A step far shorter than a detent is a glide. Worth more when it also
      // arrives inside a frame, because a wheel cannot be turned at display
      // refresh rate — but the magnitude counts on its own, since the first
      // event of every gesture has no previous one to be measured against and
      // would otherwise never be evidence of anything.
      this.trackpad += gap < 16 ? 2 : 1;
    }

    if (this.trackpad >= WHEEL_EVIDENCE_NEEDED && this.trackpad > this.mouse) return this.settle('trackpad');
    if (this.mouse >= WHEEL_EVIDENCE_NEEDED && this.mouse > this.trackpad) return this.settle('mouse');
    return null;
  }

  /** What has been concluded so far, or null if nothing yet. */
  get conclusion(): Pointing | null {
    return this.decided;
  }

  private settle(p: Pointing): Pointing | null {
    if (this.decided === p) return null;
    this.decided = p;
    // Both tallies are cleared, not just the loser's.
    //
    // Keeping the winner's pinned at the threshold looked like sensible
    // hysteresis and silently made the first conclusion permanent: the
    // challenger had to exceed a score it could only ever equal, so plugging
    // a mouse into a laptop never changed anything. A switch now costs the
    // same fresh evidence the first decision did, which is hysteresis enough.
    this.trackpad = 0;
    this.mouse = 0;
    return p;
  }
}

/* ------------------------------------------------------------- wording ---- */

/**
 * How to turn the view, in terms this particular machine can actually obey.
 *
 * The old hint named Option and two fingers on every machine, because it was
 * written on a Mac. On a desktop with a mouse that describes a gesture the
 * hardware cannot make.
 */
export function navigationFor(profile: DeviceProfile, mac: boolean): string {
  const alt = mac ? 'Option' : 'Alt';
  switch (profile.pointing) {
    case 'touch':
      return 'drag to turn · two fingers slide · pinch to zoom';
    case 'trackpad':
      return `hold ${alt} and scroll with two fingers to turn · Shift scrolls to slide · pinch to zoom`;
    case 'mouse':
    default:
      return `middle-drag to turn · Shift middle-drag to slide · the wheel zooms`;
  }
}

/** The one-line summary for the status bar and the about panel. */
export function summarise(profile: DeviceProfile): string {
  const name = { desktop: 'Desktop', laptop: 'Laptop', tablet: 'Tablet', phone: 'Phone' }[profile.label];
  const by = { mouse: 'mouse', trackpad: 'trackpad', touch: 'touch' }[profile.pointing];
  return `${name} · ${by}${profile.certain ? '' : ' (assumed)'}`;
}

/**
 * Whether this is a Mac.
 *
 * `navigator.platform` is deprecated and still the only thing every browser
 * agrees on; `userAgentData` is asked first where it exists. Nothing is
 * load-bearing on it — being wrong names a key badly, it does not break
 * anything — so there is no fallback beyond assuming the majority platform.
 *
 * This lives here rather than with the wording helpers because the device
 * profile needs it too, and the editor must not reach up into the UI layer
 * to ask what machine it is running on.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? '';
  if (platform) return /mac/i.test(platform);
  return /mac/i.test(navigator.userAgent ?? '');
}
