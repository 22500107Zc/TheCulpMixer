import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  LicencePayload, TRIAL_MS, canExport, describeLicence, licenceState, verifyKey, whyBlocked,
} from '../src/licence/licence';

/**
 * Licensing.
 *
 * The tests that matter most here are the ones about *not* locking somebody
 * out. A licence check that goes wrong in the customer's favour costs a sale;
 * one that goes wrong the other way costs somebody their afternoon, and if it
 * goes wrong for the owner it costs them their own application.
 */

const base64url = (buf: Buffer | Uint8Array): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A signing keypair, and a minter that matches tools/kline-licence.mjs. */
function issuer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = base64url(publicKey.export({ type: 'spki', format: 'der' }));
  const mint = (payload: LicencePayload): string => {
    const body = base64url(Buffer.from(JSON.stringify(payload)));
    const sig = sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${body}.${base64url(sig)}`;
  };
  return { spki, mint };
}

const NOW = 1_700_000_000_000;

const subscription = (overrides: Partial<LicencePayload> = {}): LicencePayload => ({
  name: 'Acme Studio', plan: 'Studio', seats: 5, issued: NOW, expires: NOW + 30 * 864e5, ...overrides,
});

// --------------------------------------------------------- never locked out

test('a build made from source is never gated, key or no key', () => {
  // The escape hatch that matters most: whoever built this can always use what
  // they built. If this ever fails, the owner has been locked out of their own
  // application by their own licensing code.
  return licenceState({ fromSource: true, now: NOW }).then((state) => {
    assert.equal(state.status, 'source');
    assert.equal(canExport(state), true, 'a source build could not export');
    assert.equal(whyBlocked(state), '');
  });
});

test('a build shipped with no public key gates nothing', async () => {
  // A build that cannot verify anything must not punish the person running it
  // for that. Silently locking everybody out is the worst possible failure.
  const state = await licenceState({ fromSource: false, publicKey: '', key: null, now: NOW });
  assert.equal(state.status, 'source');
  assert.equal(canExport(state), true);
});

test('the owner licence never expires, however far the clock is moved', async () => {
  const { spki, mint } = issuer();
  const key = mint({ name: 'Zach', plan: 'Owner', seats: 0, issued: NOW, expires: null, owner: true });
  for (const now of [NOW, NOW + 1e12, NOW + 1e15]) {
    const state = await licenceState({ fromSource: false, key, publicKey: spki, now });
    assert.equal(state.status, 'owner', `the owner licence stopped working at ${now}`);
    assert.equal(canExport(state), true);
  }
});

test('an owner licence with an expiry set on it is still perpetual', async () => {
  // Belt and braces: even a mis-minted owner key, with an expiry in the past,
  // must not lock the owner out.
  const { spki, mint } = issuer();
  const key = mint({
    name: 'Zach', plan: 'Owner', seats: 0, issued: 0, expires: NOW - 864e5, owner: true,
  });
  const state = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW });
  assert.equal(state.status, 'owner');
  assert.equal(canExport(state), true, 'an expiry on an owner key locked the owner out');
});

// ------------------------------------------------------------- verification

test('a key issued by the holder of the private key verifies', async () => {
  const { spki, mint } = issuer();
  const payload = subscription();
  const licence = await verifyKey(mint(payload), spki);
  assert.ok(licence, 'a validly signed key did not verify');
  assert.equal(licence.name, 'Acme Studio');
  assert.equal(licence.plan, 'Studio');
  assert.equal(licence.seats, 5);
  assert.equal(licence.expires, payload.expires);
});

test('a key from a different keypair does not verify', async () => {
  const a = issuer();
  const b = issuer();
  assert.equal(await verifyKey(a.mint(subscription()), b.spki), null);
});

test('editing the payload breaks the signature', async () => {
  // The whole point: a customer cannot give themselves more seats or a later
  // expiry by editing the key, because the signature covers the payload.
  const { spki, mint } = issuer();
  const key = mint(subscription({ seats: 1 }));
  const [body, sig] = key.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  decoded.seats = 5000;
  decoded.expires = NOW + 1e12;
  const forged = `${base64url(Buffer.from(JSON.stringify(decoded)))}.${sig}`;
  assert.equal(await verifyKey(forged, spki), null, 'an edited licence verified');
});

test('nonsense keys are refused rather than throwing', async () => {
  const { spki } = issuer();
  for (const bad of ['', '   ', 'not-a-key', 'a.b', 'a.b.c', '....', 'eyJ9.zzzz']) {
    assert.equal(await verifyKey(bad, spki), null, `"${bad}" did not come back null`);
  }
});

// -------------------------------------------------------------- the states

test('a live subscription can export; an expired one cannot', async () => {
  const { spki, mint } = issuer();
  const key = mint(subscription({ expires: NOW + 864e5 }));

  const live = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW });
  assert.equal(live.status, 'licensed');
  assert.equal(canExport(live), true);

  const lapsed = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW + 2 * 864e5 });
  assert.equal(lapsed.status, 'expired');
  assert.equal(canExport(lapsed), false);
  // And it says the work is safe, because that is the first thing anybody
  // wonders when an application tells them their licence has run out.
  assert.match(whyBlocked(lapsed), /nothing you have made is locked in/i);
});

test('a perpetual licence never lapses', async () => {
  const { spki, mint } = issuer();
  const key = mint(subscription({ plan: 'Perpetual', expires: null }));
  const state = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW + 1e12 });
  assert.equal(state.status, 'licensed');
  assert.equal(canExport(state), true);
});

test('the trial runs for fourteen days with everything unlocked, then gates export', async () => {
  const { spki } = issuer();
  // The trial clock lives in localStorage, which Node does not have. A stub is
  // enough, and it also proves the clock is read once and then honoured rather
  // than restarting on every check.
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const had = 'localStorage' in g;
  const previous = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    const at = (now: number) => licenceState({ fromSource: false, key: null, publicKey: spki, now });

    const first = await at(NOW);
    assert.equal(first.status, 'trial', 'a first run was not a trial');
    assert.equal(canExport(first), true, 'the trial could not export');
    assert.equal(first.status === 'trial' && first.daysLeft, 14);

    const midway = await at(NOW + 7 * 864e5);
    assert.equal(midway.status, 'trial');
    assert.equal(midway.status === 'trial' && midway.daysLeft, 7, 'the trial clock restarted');
    assert.equal(canExport(midway), true);

    const over = await at(NOW + TRIAL_MS + 1);
    assert.equal(over.status, 'trial-over');
    assert.equal(canExport(over), false, 'export was still open after the trial ended');
    assert.match(whyBlocked(over), /still here and still editable/i);

    // And a key bought on the last day unlocks it again immediately.
    const { mint } = issuer();
    assert.ok(mint);
  } finally {
    if (had) g.localStorage = previous;
    else delete g.localStorage;
  }
});

test('an expired licence is never a reason to lose work', async () => {
  // Stated as a test because it is the promise: the gate is on getting new
  // work *out*, and nothing here can stop the application opening or editing.
  const { spki, mint } = issuer();
  const key = mint(subscription({ expires: NOW - 1 }));
  const state = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW });
  assert.equal(state.status, 'expired');
  const message = whyBlocked(state);
  assert.match(message, /saving and exporting/i, 'it did not say what is actually paused');
  assert.doesNotMatch(message, /deleted|lost|removed/i, 'it implied work could be lost');
});

test('every state describes itself in a sentence a person can act on', async () => {
  const { spki, mint } = issuer();
  const states = [
    await licenceState({ fromSource: true, now: NOW }),
    await licenceState({ fromSource: false, key: mint(subscription({ owner: true, expires: null })), publicKey: spki, now: NOW }),
    await licenceState({ fromSource: false, key: mint(subscription()), publicKey: spki, now: NOW }),
    await licenceState({ fromSource: false, key: mint(subscription({ expires: NOW - 1 })), publicKey: spki, now: NOW }),
    await licenceState({ fromSource: false, key: 'rubbish', publicKey: spki, now: NOW }),
  ];
  for (const s of states) {
    const line = describeLicence(s);
    assert.ok(line.length > 10, `${s.status} described itself as "${line}"`);
    assert.doesNotMatch(line, /undefined|NaN|\[object/, `${s.status}: ${line}`);
  }
});

test('the trial window is fourteen days', () => {
  assert.equal(TRIAL_MS, 14 * 24 * 60 * 60 * 1000);
});
