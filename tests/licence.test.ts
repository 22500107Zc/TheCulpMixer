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
  assert.equal(canUse(lapsed), false, 'an expired licence could still use The Culp Mixer');
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
    assert.equal(canUse(over), false, 'The Culp Mixer was still usable after the trial ended');
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
  // Stated as a test because it is the promise. After the trial The Culp Mixer is
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
  // file a customer can read does not say what The Culp Mixer costs, it fails here.
  const { readFileSync } = await import('node:fs');
  const files = [
    'README.md', 'LICENSE', 'index.html', 'SELLING.md',
    'package.json', 'public/manifest.webmanifest',
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /199/, `${file} does not say what The Culp Mixer costs`);
    assert.match(text, /33[ -](hour|hours)|thirty-three \(33\) hours|thirty-three hours/i,
      `${file} does not state the 33-hour trial`);
  }
  // And in the application itself, on the first card a new user sees.
  const guide = readFileSync('src/ui/SetupGuide.ts', 'utf8');
  assert.match(guide, /TERMS/, 'the setup guide does not state the terms');
});

test('nothing The Culp Mixer ships describes The Culp Mixer as open source or MIT', async () => {
  // This kept coming back. package.json said MIT while LICENSE said
  // proprietary; the README called it an open source alternative to Blender;
  // THIRD-PARTY-NOTICES.md — which is inside every build — opened with "The Culp Mixer
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
      // A line saying The Culp Mixer is NOT open source is the point, not a failure.
      if (/\bnot\b[^.]*open.?source|open.?source[^.]*\bnot\b/i.test(line)) continue;
      assert.ok(!/open.?source/i.test(line),
        `${file} calls The Culp Mixer open source: ${line.trim()}`);
      // A third-party component's own MIT licence is legitimate and required
      // to be reproduced; a claim that *The Culp Mixer* is MIT is not.
      if (/\bMIT\b/.test(line)) {
        assert.ok(!/\bKline\b/i.test(line),
          `${file} claims The Culp Mixer is MIT licensed: ${line.trim()}`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.notEqual(pkg.license, 'MIT', 'package.json still declares MIT');
  assert.match(pkg.license, /SEE LICENSE/i, `package.json license is "${pkg.license}"`);
});

test('the API is built with rules that let it actually run on the host', async () => {
  // This is the test for a failure nobody could see from here: every request
  // to /api/* came back 500 FUNCTION_INVOCATION_FAILED on the deployment while
  // the same handlers passed every test locally.
  //
  // The host compiles each api/*.ts with the tsconfig it finds by walking up
  // from the file. With no config in api/ it reached the root one — the
  // browser config — which has no Node types and noEmit: true. So the
  // functions were compiled with the wrong rules and Node was then asked to
  // load a module graph whose relative imports it could not resolve, because
  // ESM needs the .js extension and "bundler" resolution does not write one.
  //
  // Both halves are asserted, because either one alone brings the API down and
  // neither shows up in a local run.
  const { readFileSync, readdirSync } = await import('node:fs');

  const config = JSON.parse(
    readFileSync('api/tsconfig.json', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  const options = config.compilerOptions;
  assert.ok(!options.noEmit, 'api/tsconfig.json has noEmit, so nothing is compiled to run');
  assert.deepEqual(options.types, ['node'], 'the API is compiled without Node types');
  assert.equal(options.moduleResolution, 'NodeNext',
    'the API must resolve modules the way Node does at runtime');

  for (const file of readdirSync('api').filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(`api/${file}`, 'utf8');
    for (const [, specifier] of text.matchAll(/from '(\.[^']*)'/g)) {
      assert.match(specifier, /\.js$/,
        `api/${file} imports "${specifier}" — Node cannot resolve that at runtime`);
    }
  }
});

test('the founder can issue a working licence with no server anywhere', async () => {
  // The last thing that needed a backend, and the one that decides whether
  // this is a business: somebody pays, and somebody has to turn them on.
  // Everything else — signing up, the 33 hours, the lock, the way to pay —
  // already worked with nothing configured. Switching a paying customer on
  // did not: it wanted a signing key on the host, a database and a set of
  // environment variables, so a customer could pay and still be locked out.
  //
  // Now the founder signs the key on their own machine and emails it. Same
  // signature, checked against the public key built into every copy, so it
  // holds offline on both sides.
  const { generateKeyPairSync } = await import('node:crypto');
  const { issueKey, handoutFor } = await import('../src/licence/issue');

  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const issued = await issueKey(
    { name: 'Dana Reyes', email: 'dana@studio.example', months: 1 }, pem,
  );
  assert.ok(issued.ok, `issuing failed: ${issued.ok ? '' : issued.message}`);

  // The customer's side, which is the only side that matters.
  const seen = await verifyKey(issued.key, spki);
  assert.ok(seen, 'a key the founder just issued did not verify');
  assert.equal(seen.email, 'dana@studio.example');
  assert.equal(seen.name, 'Dana Reyes');
  assert.ok(seen.expires && seen.expires > Date.now(), 'it was issued already expired');
  assert.ok(canUse(await Promise.resolve({ status: 'licensed', licence: seen } as const)),
    'a freshly issued licence does not allow use');

  // A licence that never expires, for somebody who buys outright.
  const forever = await issueKey({ name: '', email: 'a@b.co', months: null }, pem);
  assert.ok(forever.ok);
  assert.equal((await verifyKey(forever.key, spki))?.expires, null);

  // And the lock still holds: a signature nobody can forge is the whole
  // mechanism, so an edited payload has to fail against the real key.
  const [body] = issued.key.split('.');
  assert.equal(await verifyKey(`${body}.${'A'.repeat(86)}`, spki), null,
    'a forged signature was accepted');
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherSpki = other.publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(await verifyKey(issued.key, otherSpki), null,
    'a key verified against somebody else’s public key');

  // The message that gets sent has the key in it and tells them what to do.
  const note = handoutFor(seen, issued.key, 'https://example.com');
  assert.ok(note.includes(issued.key), 'the handout does not contain the key');
  assert.match(note, /Apply key/, 'the handout does not say what to press');
});

test('a bad signing key is refused before it can mint anything', async () => {
  // A key that imports but is the wrong curve would produce licences that
  // verify nowhere — discovered by a customer, at the worst moment.
  const { issueKey } = await import('../src/licence/issue');
  const notAKey = await issueKey({ name: '', email: 'a@b.co', months: 1 }, 'not a pem at all');
  assert.equal(notAKey.ok, false);
  const noKey = await issueKey({ name: '', email: 'a@b.co', months: 1 }, null);
  assert.equal(noKey.ok, false);
  const { generateKeyPairSync } = await import('node:crypto');
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const noEmail = await issueKey({ name: '', email: 'nonsense', months: 1 }, pem);
  assert.equal(noEmail.ok, false, 'it issued a licence to something that is not an address');
});

test('a payment link is taken from the right place and refuses a dangerous one', async () => {
  // The lock screen is the one screen that has to work perfectly, because it
  // is the only one standing between a customer and paying. The link behind
  // its button is the founder's to choose and must not mean editing code.
  //
  // The order matters and is asserted rather than assumed: the account service
  // outranks everything because it is the one source that is the same for
  // every customer; then the file served next to the application, which needs
  // no backend at all; then this browser, which is the founder's own machine
  // and reaches nobody else — which is exactly why it is last.
  const { safePaymentLink, resolvePaymentLink, forgetPublishedPaymentLink } =
    await import('../src/licence/payment');

  assert.equal(safePaymentLink('https://buy.stripe.com/abc'), 'https://buy.stripe.com/abc');
  assert.equal(safePaymentLink('  https://paypal.me/zach  '), 'https://paypal.me/zach');
  assert.equal(safePaymentLink('mailto:a@b.co'), 'mailto:a@b.co');

  // A link on the lock screen is a link people click, so these are refused
  // outright rather than cleaned up. There is no version of them that belongs
  // on a payment button.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', '', '   ', 'not a url']) {
    assert.equal(safePaymentLink(bad), null, `"${bad}" was accepted as a payment link`);
  }

  // The service wins when it has one.
  forgetPublishedPaymentLink();
  globalThis.fetch = (async () => ({
    ok: true, json: async () => ({ paymentLink: 'https://pay.example/file' }),
  })) as unknown as typeof fetch;
  assert.equal(
    await resolvePaymentLink('https://pay.example/service'),
    'https://pay.example/service',
    'the served file overruled the account service',
  );

  // And the file is used when the service has nothing.
  forgetPublishedPaymentLink();
  assert.equal(await resolvePaymentLink(null), 'https://pay.example/file');
  forgetPublishedPaymentLink();
  assert.equal(await resolvePaymentLink(''), 'https://pay.example/file');

  // A service that answers with something dangerous does not get to set it.
  forgetPublishedPaymentLink();
  assert.equal(await resolvePaymentLink('javascript:alert(1)'), 'https://pay.example/file',
    'a javascript: link from the service was used');

  // A missing file is the ordinary state of a fresh deployment, not an error.
  forgetPublishedPaymentLink();
  globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
  assert.equal(await resolvePaymentLink(null), null);
});

test('the payment link file ships with the build and is shaped right', async () => {
  // It is fetched at runtime by the locked screen, so a rename or a bad edit
  // would take the pay button off the one screen that needs it.
  const { readFileSync, existsSync } = await import('node:fs');
  assert.ok(existsSync('public/pay.json'), 'public/pay.json is missing');
  const file = JSON.parse(readFileSync('public/pay.json', 'utf8'));
  assert.ok('paymentLink' in file, 'pay.json has no paymentLink field');
  assert.equal(typeof file.paymentLink, 'string', 'paymentLink must be a string');
});
