/**
 * Stored data survives the rename.
 *
 * The product was called something else, and everything it kept in the browser
 * was filed under that name. Renaming the keys is cosmetic; failing to move
 * what is under them is not. On the next visit it would silently lose the
 * autosaved scene somebody was in the middle of, the account they were signed
 * in to, how far through their thirty-three hours they are, their preferences,
 * their recent files, and the payment link the founder configured — all of it
 * still sitting in the browser under a name nothing looks for any more.
 *
 * That is a data-loss bug that no amount of renaming tests would catch, so it
 * gets its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_PREFIX, carryStoredDataAcrossTheRename, plainMoves,
} from '../src/storage-rename';

/** Just enough localStorage to exercise the real function. */
function fakeStore(initial: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  const store = {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return store as unknown as Storage & { map: Map<string, string> };
}

const OLD = (name: string): string => `kli${'ne.'}${name}`;

test('every old key is carried forward under the new name', () => {
  const store = fakeStore({
    [OLD('autosave')]: '{"scene":"in progress"}',
    [OLD('session')]: 'signed-in-token',
    [OLD('trial.start')]: '1700000000000',
    [OLD('preferences')]: '{"theme":"dark"}',
    [OLD('payment.link')]: 'https://buy.stripe.com/abc',
  });
  const moved = carryStoredDataAcrossTheRename(store);
  assert.equal(moved, 5, 'not everything was carried across');
  assert.equal(store.getItem(`${NEW_PREFIX}autosave`), '{"scene":"in progress"}',
    'somebody would have opened the application to find their work gone');
  assert.equal(store.getItem(`${NEW_PREFIX}session`), 'signed-in-token');
  assert.equal(store.getItem(`${NEW_PREFIX}trial.start`), '1700000000000',
    'the trial clock restarted, which hands everybody another 33 free hours');
  assert.equal(store.getItem(`${NEW_PREFIX}payment.link`), 'https://buy.stripe.com/abc',
    'the founder would have had to set their payment link up again');
});

test('the old key is left in place, so an older build still finds it', () => {
  const store = fakeStore({ [OLD('preferences')]: '{"a":1}' });
  carryStoredDataAcrossTheRename(store);
  assert.equal(store.getItem(OLD('preferences')), '{"a":1}',
    'a cached tab on the previous build would come back to nothing');
});

test('newer data is never overwritten by what was left behind', () => {
  // The application has been used since the rename. What it wrote is newer
  // than the leftover, and copying over it would undo real work.
  const store = fakeStore({
    [OLD('autosave')]: 'stale',
    [`${NEW_PREFIX}autosave`]: 'current',
  });
  const moved = carryStoredDataAcrossTheRename(store);
  assert.equal(moved, 0);
  assert.equal(store.getItem(`${NEW_PREFIX}autosave`), 'current',
    'a stale copy clobbered the current one');
});

test('running it twice changes nothing the second time', () => {
  const store = fakeStore({ [OLD('recent')]: '["a.mixer"]' });
  assert.equal(carryStoredDataAcrossTheRename(store), 1);
  assert.equal(carryStoredDataAcrossTheRename(store), 0, 'it is not idempotent');
});

test('keys that never had the dot move too', () => {
  const store = fakeStore({ [`kli${'ne'}_session`]: 'tok' });
  carryStoredDataAcrossTheRename(store);
  assert.equal(store.getItem('culpmixer_session'), 'tok',
    'the account session did not move, so everybody is signed out by the rename');
});

test('keys belonging to anything else are left alone', () => {
  const store = fakeStore({ 'someone.elses.app': 'theirs', 'culpmixer.mine': 'ours' });
  const moved = carryStoredDataAcrossTheRename(store);
  assert.equal(moved, 0);
  assert.equal(store.getItem('someone.elses.app'), 'theirs',
    'another application on the same origin had its data touched');
});

test('storage that refuses to work is not a reason to fail to start', () => {
  // Private windows and blocked site data throw on access rather than
  // returning empty, and the application still has to open.
  const hostile = {
    get length(): number { throw new Error('blocked'); },
    key: () => { throw new Error('blocked'); },
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
    clear: () => { throw new Error('blocked'); },
  } as unknown as Storage;
  assert.doesNotThrow(() => carryStoredDataAcrossTheRename(hostile));
  assert.equal(carryStoredDataAcrossTheRename(undefined), 0, 'no storage at all must be fine');
});

test('a write that fails does not abandon the remaining keys', () => {
  const store = fakeStore({ [OLD('a')]: '1', [OLD('b')]: '2', [OLD('c')]: '3' });
  let calls = 0;
  const original = store.setItem.bind(store);
  store.setItem = (k: string, v: string) => {
    calls += 1;
    if (calls === 2) throw new Error('quota');
    original(k, v);
  };
  const moved = carryStoredDataAcrossTheRename(store);
  assert.equal(moved, 2, 'one failed write took the others with it');
});

test('the plan is computable without touching a browser', () => {
  const moves = plainMoves([OLD('one'), 'unrelated', `${NEW_PREFIX}two`, OLD('two')]);
  assert.deepEqual(moves, [[OLD('one'), `${NEW_PREFIX}one`]],
    'the plan either missed a key or proposed clobbering a newer one');
});
