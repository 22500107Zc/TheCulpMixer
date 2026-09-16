/**
 * Knowing what machine this is running on.
 *
 * The rules being asserted here, because they are easy to get subtly wrong
 * and the failure mode is silent — an application that works, but tells
 * everybody to press a button their hardware does not have:
 *
 * - Capabilities are facts and are read, never guessed. `any-pointer` is
 *   asked rather than `pointer`, so a laptop with a touch screen is seen to
 *   have both and not only its primary one.
 * - The device LABEL is a guess and is used for wording only. Nothing is
 *   withheld because of it.
 * - Mouse versus trackpad has no API — it is an open issue against the
 *   Pointer Events spec — so it is inferred from the shape of wheel events,
 *   and until one arrives the answer is an assumption that says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUSE_PICK_RADIUS, TOUCH_PICK_RADIUS, WHEEL_EVIDENCE_NEEDED, WheelWatcher,
  navigationFor, profileFrom, readCapabilities, summarise,
} from '../src/editor/device';

/** A platform that answers media queries from a set of truths. */
function platform(truths: string[], maxTouchPoints = 0, width = 1920, height = 1080) {
  return {
    matchMedia: (q: string) => ({ matches: truths.includes(q) }),
    maxTouchPoints,
    width,
    height,
  };
}

const DESKTOP = platform(['(any-pointer: fine)', '(any-hover: hover)']);
const PHONE = platform(['(any-pointer: coarse)'], 5, 390, 844);
const TABLET = platform(['(any-pointer: coarse)'], 5, 834, 1194);
// The machine that breaks every naive check: a fine pointer AND a touch
// screen, both real, neither one the whole story.
const TOUCH_LAPTOP = platform(
  ['(any-pointer: fine)', '(any-pointer: coarse)', '(any-hover: hover)'], 10, 1536, 960,
);

test('capabilities are read rather than guessed', () => {
  const desktop = readCapabilities(DESKTOP);
  assert.equal(desktop.fine, true);
  assert.equal(desktop.coarse, false);
  assert.equal(desktop.hover, true);

  const phone = readCapabilities(PHONE);
  assert.equal(phone.fine, false);
  assert.equal(phone.coarse, true);
  assert.equal(phone.hover, false);
  assert.equal(phone.touchPoints, 5);
});

test('a touch screen counts even when it is not the primary pointer', () => {
  const caps = readCapabilities(TOUCH_LAPTOP);
  assert.equal(caps.fine, true, 'the trackpad was not seen');
  assert.equal(caps.coarse, true,
    'the touch screen was not seen — asking `pointer` instead of `any-pointer` hides it');
});

test('a screen that reports touch points is touchable even if it says nothing else', () => {
  // Some browsers report maxTouchPoints without matching the coarse query.
  const caps = readCapabilities(platform(['(any-pointer: fine)'], 10));
  assert.equal(caps.coarse, true);
});

test('a machine with no pointer at all does not crash or claim one', () => {
  const caps = readCapabilities({});
  assert.equal(caps.fine, false);
  assert.equal(caps.coarse, false);
  assert.equal(caps.shortSide, 0);
});

test('a media query the browser refuses to answer is treated as no', () => {
  const caps = readCapabilities({
    matchMedia: () => { throw new Error('unsupported'); },
    maxTouchPoints: 0,
  });
  assert.equal(caps.fine, false, 'a thrown media query must not take the process with it');
});

test('a phone and a tablet are told apart by the short side, not the long one', () => {
  // Both are held either way round, so the long side says nothing.
  assert.equal(profileFrom(readCapabilities(PHONE), null, false).label, 'phone');
  assert.equal(profileFrom(readCapabilities(TABLET), null, false).label, 'tablet');
  const sideways = platform(['(any-pointer: coarse)'], 5, 844, 390);
  assert.equal(profileFrom(readCapabilities(sideways), null, false).label, 'phone',
    'a phone turned sideways was called a tablet');
});

test('a finger gets the bigger target and a cursor does not', () => {
  assert.equal(profileFrom(readCapabilities(PHONE), null, false).pickRadius, TOUCH_PICK_RADIUS);
  assert.equal(profileFrom(readCapabilities(DESKTOP), null, false).pickRadius, MOUSE_PICK_RADIUS);
});

test('touch is certain immediately; mouse versus trackpad is not', () => {
  const phone = profileFrom(readCapabilities(PHONE), null, false);
  assert.equal(phone.pointing, 'touch');
  assert.equal(phone.certain, true, 'a device with no fine pointer is not a guess');

  const desktop = profileFrom(readCapabilities(DESKTOP), null, false);
  assert.equal(desktop.certain, false, 'claiming certainty before a single scroll is a lie');
  assert.match(summarise(desktop), /assumed/);
});

test('wheel evidence settles it, and saying so is the point', () => {
  const observed = profileFrom(readCapabilities(DESKTOP), 'trackpad', false);
  assert.equal(observed.pointing, 'trackpad');
  assert.equal(observed.label, 'laptop');
  assert.equal(observed.certain, true);
  assert.doesNotMatch(summarise(observed), /assumed/);
});

test('wheel evidence never overrules a device that has no mouse to plug in', () => {
  // A phone can produce wheel events — a Bluetooth mouse, a trackpad case.
  // What it cannot do is stop being touchable, and the touch bindings must
  // not be taken away because of one scroll.
  const phone = profileFrom(readCapabilities(PHONE), 'mouse', false);
  assert.equal(phone.pointing, 'touch', 'a scroll took the touch bindings off a phone');
  assert.equal(phone.pickRadius, TOUCH_PICK_RADIUS);
});

test('a touchscreen laptop is a laptop that is also touchable', () => {
  const p = profileFrom(readCapabilities(TOUCH_LAPTOP), 'trackpad', false);
  assert.equal(p.label, 'laptop', 'the touch screen demoted it to a tablet');
  assert.equal(p.coarse, true, 'the touch screen was forgotten once it was called a laptop');
  assert.equal(p.keyboard, true);
});

test('the opening guess follows the platform', () => {
  assert.equal(profileFrom(readCapabilities(DESKTOP), null, true).pointing, 'trackpad',
    'a Mac is more likely a trackpad');
  assert.equal(profileFrom(readCapabilities(DESKTOP), null, false).pointing, 'mouse');
});

test('a keyboard is assumed only where one can actually be held down', () => {
  assert.equal(profileFrom(readCapabilities(DESKTOP), null, false).keyboard, true);
  assert.equal(profileFrom(readCapabilities(PHONE), null, false).keyboard, false,
    'you cannot hold Shift and drag on an on-screen keyboard');
});

// ------------------------------------------------------- wheel inference ----

const WHEEL = { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false };

test('a pinch is conclusive on its own', () => {
  const w = new WheelWatcher();
  // ctrlKey set that the person did not ask for: only a trackpad does this.
  assert.equal(w.observe({ ...WHEEL, deltaY: 4, ctrlKey: true }, false, 0), 'trackpad');
});

test('a deliberate Ctrl+scroll is not mistaken for a pinch', () => {
  const w = new WheelWatcher();
  // Ctrl+scroll is a zoom binding here, and the editor knows the key is down.
  assert.equal(w.observe({ ...WHEEL, ctrlKey: true }, true, 0), null,
    'holding Ctrl and using a wheel was read as a trackpad pinch');
});

test('a fractional delta can only be a glide', () => {
  const w = new WheelWatcher();
  assert.equal(w.observe({ ...WHEEL, deltaY: 3.4000000953674316 }, false, 0), 'trackpad');
});

test('movement on both axes at once can only be a glide', () => {
  const w = new WheelWatcher();
  assert.equal(w.observe({ ...WHEEL, deltaX: 7, deltaY: 3 }, false, 0), 'trackpad');
});

test('round single-axis detents add up to a mouse', () => {
  const w = new WheelWatcher();
  let decided: string | null = null;
  for (let i = 0; i < WHEEL_EVIDENCE_NEEDED; i++) {
    decided = w.observe(WHEEL, false, i * 120) ?? decided;
  }
  assert.equal(decided, 'mouse');
});

test('one detent is not enough to decide', () => {
  const w = new WheelWatcher();
  assert.equal(w.observe(WHEEL, false, 0), null,
    'a single event decided the input device, which a fast flick can fake');
});

test('small steps at display rate add up to a trackpad', () => {
  const w = new WheelWatcher();
  let decided: string | null = null;
  for (let i = 0; i < WHEEL_EVIDENCE_NEEDED; i++) {
    // ~60Hz, a handful of pixels each: a hand cannot turn a wheel like this.
    decided = w.observe({ ...WHEEL, deltaY: 6 }, false, i * 8) ?? decided;
  }
  assert.equal(decided, 'trackpad');
});

test('line units come from a real wheel', () => {
  const w = new WheelWatcher();
  let decided: string | null = null;
  for (let i = 0; i < WHEEL_EVIDENCE_NEEDED; i++) {
    decided = w.observe({ ...WHEEL, deltaY: 3, deltaMode: 1 }, false, i * 8) ?? decided;
  }
  assert.equal(decided, 'mouse', 'DOM_DELTA_LINE was read as a trackpad');
});

test('the conclusion is reported once, not on every event after', () => {
  const w = new WheelWatcher();
  const seen: (string | null)[] = [];
  for (let i = 0; i < 8; i++) seen.push(w.observe(WHEEL, false, i * 120));
  assert.equal(seen.filter((x) => x !== null).length, 1,
    'the same conclusion was announced repeatedly, which re-renders the UI for nothing');
  assert.equal(w.conclusion, 'mouse');
});

test('plugging a mouse into a laptop changes the answer back', () => {
  const w = new WheelWatcher();
  assert.equal(w.observe({ ...WHEEL, deltaY: 3.5 }, false, 0), 'trackpad');
  let decided: string | null = null;
  for (let i = 1; i <= WHEEL_EVIDENCE_NEEDED; i++) {
    decided = w.observe(WHEEL, false, i * 200) ?? decided;
  }
  assert.equal(decided, 'mouse',
    'the first conclusion was permanent, so swapping the pointing device never took effect');
});

// -------------------------------------------------------------- wording ----

test('every device is told to do something it can actually do', () => {
  const touch = navigationFor(profileFrom(readCapabilities(PHONE), null, false), false);
  assert.match(touch, /pinch/i);
  assert.doesNotMatch(touch, /middle|wheel|Alt|Option/i,
    'a phone was told to press a button or a key it does not have');

  const laptop = navigationFor(profileFrom(readCapabilities(DESKTOP), 'trackpad', true), true);
  assert.match(laptop, /Option/);
  assert.doesNotMatch(laptop, /middle/i, 'a trackpad was told to hold a middle button');

  const desktop = navigationFor(profileFrom(readCapabilities(DESKTOP), 'mouse', false), false);
  assert.match(desktop, /middle/i);
  assert.match(desktop, /wheel/i);
});

test('the key is named the way it is printed on this keyboard', () => {
  const mac = navigationFor(profileFrom(readCapabilities(DESKTOP), 'trackpad', true), true);
  const pc = navigationFor(profileFrom(readCapabilities(DESKTOP), 'trackpad', false), false);
  assert.match(mac, /Option/);
  assert.match(pc, /Alt/);
});
