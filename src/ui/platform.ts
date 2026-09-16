/**
 * What to call the keys, on the machine this is actually running on.
 *
 * The Culp Mixer ships installers for macOS, Windows and Linux, and every hint it
 * shows was written on a Mac: "hold Option and scroll with two fingers". A
 * Windows laptop has no Option key and a desktop has no two fingers, so the
 * one instruction telling somebody how to turn the view was an instruction
 * they could not follow. The navigation itself is identical everywhere — the
 * browser reports the same `altKey` for Option and for Alt — so only the
 * wording needs to differ.
 */

// Which machine this is now lives with the device profile, which needs it
// too; imported back here so every existing caller of platform.ts still works
// and so the defaults below can keep reading it.
import { isMac } from '../editor/device';

export { isMac };

/**
 * The key that turns the view, by the name printed on it.
 *
 * Every one of these takes the platform as an argument, defaulting to this
 * machine's. Without that the only way to test the Windows wording is to be
 * on Windows, and the wording for the platform nobody here runs is exactly
 * the wording that goes wrong.
 */
export function altKeyName(mac = isMac()): string {
  return mac ? 'Option' : 'Alt';
}

/**
 * How to say "scroll", for the pointing device this machine probably has.
 *
 * A Mac laptop is a trackpad; everything else is more likely a wheel. Both
 * arrive as the same wheel events, so this is only about which one to name
 * first.
 */
export function scrollPhrase(mac = isMac()): string {
  return mac ? 'scroll with two fingers' : 'scroll';
}

/** One line describing how to move around, in this machine's own terms. */
export function navigationHint(mac = isMac()): string {
  const alt = altKeyName(mac);
  const scroll = scrollPhrase(mac);
  const zoom = mac ? 'pinch or scroll zooms' : 'the wheel zooms';
  return `hold ${alt} and ${scroll} to turn the view · Shift ${scroll}s slides it · ${zoom}`;
}

/** The key that means "the modifier", by the name printed on it. */
export function ctrlKeyName(mac = isMac()): string {
  return mac ? 'Cmd' : 'Ctrl';
}
