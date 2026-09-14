import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  LicencePayload, PRICE, TERMS, TRIAL_MS, canExport, canUse, describeLicence, licenceState,
  verifyKey, whyBlocked,
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

test('a live subscription works; an expired one is locked out entirely', async () => {
  const { spki, mint } = issuer();
  const key = mint(subscription({ expires: NOW + 864e5 }));

  const live = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW });
  assert.equal(live.status, 'licensed');
  assert.equal(canExport(live), true);

  const lapsed = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW + 2 * 864e5 });
  assert.equal(lapsed.status, 'expired');
  assert.equal(canExport(lapsed), false);
  assert.equal(canUse(lapsed), false, 'an expired licence could still use Kline');
  // It names the price, because a lock that does not say what it costs is just
  // a dead end.
  assert.ok(whyBlocked(lapsed).includes(PRICE), whyBlocked(lapsed));
  // And it says the work is safe, because that is the first thing anybody
  // wonders when an application tells them their licence has run out.
  assert.match(whyBlocked(lapsed), /still on your disk, untouched/i);
});

test('a perpetual licence never lapses', async () => {
  const { spki, mint } = issuer();
  const key = mint(subscription({ plan: 'Perpetual', expires: null }));
  const state = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW + 1e12 });
  assert.equal(state.status, 'licensed');
  assert.equal(canExport(state), true);
});

test('the trial runs for thirty-three hours, then locks the whole application', async () => {
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
    const HOUR = 3600000;

    const first = await at(NOW);
    assert.equal(first.status, 'trial', 'a first run was not a trial');
    assert.equal(canUse(first), true, 'the trial could not be used');
    assert.equal(first.status === 'trial' && first.hoursLeft, 33);

    const midway = await at(NOW + 11 * HOUR);
    assert.equal(midway.status, 'trial');
    assert.equal(midway.status === 'trial' && midway.hoursLeft, 22, 'the trial clock restarted');
    assert.equal(canUse(midway), true);

    // Still inside the window one minute before it closes, and shut a minute
    // after. Thirty-three hours, not thirty-three days.
    const nearly = await at(NOW + TRIAL_MS - 60000);
    assert.equal(nearly.status, 'trial');
    const overnight = await at(NOW + 34 * HOUR);
    assert.equal(overnight.status, 'trial-over', 'the trial outlasted thirty-three hours');

    const over = await at(NOW + TRIAL_MS + 1);
    assert.equal(over.status, 'trial-over');
    assert.equal(canUse(over), false, 'Kline was still usable after the trial ended');
    assert.equal(canExport(over), false, 'export was still open after the trial ended');
    assert.match(whyBlocked(over), /locked/i);
    assert.ok(whyBlocked(over).includes(PRICE), whyBlocked(over));
    assert.match(whyBlocked(over), /still on your disk, untouched/i);
  } finally {
    if (had) g.localStorage = previous;
    else delete g.localStorage;
  }
});

test('the lock stops the application, never the work', async () => {
  // Stated as a test because it is the promise. After the trial Kline is
  // locked — that is what is being sold — but the lock is on the software, not
  // on anything a person made with it. Nothing is deleted, nothing is held.
  const { spki, mint } = issuer();
  const key = mint(subscription({ expires: NOW - 1 }));
  const state = await licenceState({ fromSource: false, key, publicKey: spki, now: NOW });
  assert.equal(state.status, 'expired');
  assert.equal(canUse(state), false);
  const message = whyBlocked(state);
  assert.match(message, /locked/i, 'it did not say the application is locked');
  assert.match(message, /untouched/i, 'it did not say the files are safe');
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

test('the trial window is thirty-three hours and the price is $199 a month', () => {
  assert.equal(TRIAL_MS, 33 * 60 * 60 * 1000);
  assert.equal(PRICE, '$199/month');
  assert.match(TERMS, /33-hour free trial/);
  assert.ok(TERMS.includes(PRICE), TERMS);
});

test('every surface a person can read states the price and the trial', async () => {
  // The terms went in six different places and came out of four of them by
  // accident over successive edits. This is the sweep that stops that: if a
  // file a customer can read does not say what Kline costs, it fails here.
  const { readFileSync } = await import('node:fs');
  const files = [
    'README.md', 'LICENSE', 'index.html', 'SELLING.md',
    'package.json', 'public/manifest.webmanifest',
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /199/, `${file} does not say what Kline costs`);
    assert.match(text, /33[ -](hour|hours)|thirty-three \(33\) hours|thirty-three hours/i,
      `${file} does not state the 33-hour trial`);
  }
  // And in the application itself, on the first card a new user sees.
  const guide = readFileSync('src/ui/SetupGuide.ts', 'utf8');
  assert.match(guide, /TERMS/, 'the setup guide does not state the terms');
});

test('nothing Kline ships describes Kline as open source or MIT', async () => {
  // This kept coming back. package.json said MIT while LICENSE said
  // proprietary; the README called it an open source alternative to Blender;
  // THIRD-PARTY-NOTICES.md — which is inside every build — opened with "Kline
  // itself is MIT licensed"; and the web manifest and package description said
  // open source too. Each was found separately, by a person reading the page
  // rather than by anything failing.
  const { readFileSync } = await import('node:fs');
  const files = [
    'package.json', 'README.md', 'index.html', 'SELLING.md', 'CONTRIBUTING.md',
    'public/manifest.webmanifest', 'THIRD-PARTY-NOTICES.md', 'LICENSE',
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      // A line saying Kline is NOT open source is the point, not a failure.
      if (/\bnot\b[^.]*open.?source|open.?source[^.]*\bnot\b/i.test(line)) continue;
      assert.ok(!/open.?source/i.test(line),
        `${file} calls Kline open source: ${line.trim()}`);
      // A third-party component's own MIT licence is legitimate and required
      // to be reproduced; a claim that *Kline* is MIT is not.
      if (/\bMIT\b/.test(line)) {
        assert.ok(!/\bKline\b/i.test(line),
          `${file} claims Kline is MIT licensed: ${line.trim()}`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.notEqual(pkg.license, 'MIT', 'package.json still declares MIT');
  assert.match(pkg.license, /SEE LICENSE/i, `package.json license is "${pkg.license}"`);
});
