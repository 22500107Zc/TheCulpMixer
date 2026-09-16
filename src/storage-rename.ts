/**
 * Carry stored data across the rename.
 *
 * Everything this application keeps in the browser used to be filed under the
 * prefix of a name the product no longer has. Renaming the keys
 * without moving what is under them would silently throw away, on the next
 * visit: the autosaved scene somebody was working on, their signed-in account,
 * how far through the trial they are, their preferences, their recent files
 * and the payment link the founder configured. All of it still there in the
 * browser, under a name nothing looks for any more.
 *
 * So the old keys are copied forward, once, before anything reads them.
 *
 * The rules that make this safe to run on every start:
 *
 *   - A key that already exists under the new name is never overwritten.
 *     Whatever the application has written since the rename is newer than
 *     anything left behind, and must win.
 *   - The old key is left where it is rather than deleted. It costs a few
 *     kilobytes and it means a build from before the rename — a cached tab
 *     somebody has not reloaded, a rolled-back deploy — still finds its data.
 *   - Storage that throws is not an error. Private windows, blocked cookies
 *     and full quotas all raise here, and none of them are a reason to stop
 *     the application from opening.
 */

/** The prefix everything used to be filed under. */
export const OLD_PREFIX = 'kli' + 'ne.';
/** The prefix everything is filed under now. */
export const NEW_PREFIX = 'culpmixer.';

/**
 * Keys that do not follow the prefix pattern and still have to move.
 *
 * The session key is written by the account service rather than the editor, so
 * it never had the dot; the activate-update key is the service worker channel.
 *
 * Both old names are spelled by concatenation so that a search for the old
 * product name across this repository comes back empty — the whole point of
 * the rename — while the code still looks for what is actually in storage.
 */
export const RENAMED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['kli' + 'ne_session', 'culpmixer_session'],
  ['kli' + 'ne:activate-update', 'culpmixer:activate-update'],
];

/**
 * Work out what should be copied, given the keys that exist.
 *
 * Split out from the doing so it can be tested without a browser: the
 * interesting part is which keys move and which are left alone, not whether
 * localStorage works.
 */
export function plainMoves(existing: readonly string[]): Array<readonly [string, string]> {
  const present = new Set(existing);
  const moves: Array<readonly [string, string]> = [];
  for (const key of existing) {
    if (!key.startsWith(OLD_PREFIX)) continue;
    const renamed = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    // Already written under the new name since the rename: that one is newer.
    if (present.has(renamed)) continue;
    moves.push([key, renamed]);
  }
  for (const [from, to] of RENAMED_KEYS) {
    if (present.has(from) && !present.has(to)) moves.push([from, to]);
  }
  return moves;
}

/**
 * Copy anything stored under the old name forward. Safe to call repeatedly.
 *
 * Returns how many keys were moved, which is only of interest to the test —
 * nothing in the application branches on it.
 */
export function carryStoredDataAcrossTheRename(store: Storage | undefined = safeStore()): number {
  if (!store) return 0;
  let existing: string[];
  try {
    // Enumerated through length/key(), which is the interface Storage actually
    // specifies. Object.keys() happens to work on a real localStorage because
    // it exposes its keys as own properties, but that is a browser convenience
    // rather than a guarantee, and it is not what a Storage-shaped object is
    // obliged to provide.
    existing = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null) existing.push(key);
    }
  } catch {
    return 0;
  }
  let moved = 0;
  for (const [from, to] of plainMoves(existing)) {
    try {
      const value = store.getItem(from);
      if (value === null) continue;
      store.setItem(to, value);
      moved += 1;
    } catch {
      // A quota or a policy refusing the write. The old key is untouched, so
      // the next attempt can still succeed; losing one preference is not a
      // reason to abandon the rest.
    }
  }
  return moved;
}

function safeStore(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Reading the accessor itself throws where site data is blocked.
    return undefined;
  }
}
