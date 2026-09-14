import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import admin from '../api/admin';
import licence from '../api/licence';
import { hashPassword } from '../api/_store';
import { verifyKey } from '../src/licence/licence';

/**
 * The founder console.
 *
 * One login that can issue licences and read every customer, so most of these
 * are about it staying shut: no password set, wrong password, no session, a
 * forged session, an expired one. The rest are about the thing it exists for —
 * making somebody an account without Stripe, and having that actually unlock
 * Kline.
 */

const PASSWORD = 'a-test-password-not-the-real-one';
const HASH = hashPassword(PASSWORD);

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Json = Record<string, unknown>;

function recorder() {
  const out: { code: number; body: Json; headers: Record<string, string> } = {
    code: 0, body: {}, headers: {},
  };
  const res = {
    status(code: number) { out.code = code; return res; },
    setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = value; },
    json(body: unknown) { out.body = (body ?? {}) as Json; },
    end() { /* nothing */ },
  };
  return { res, out };
}

/** A KV that lives in a Map, wired to the same REST shape Upstash speaks. */
function store() {
  const data = new Map<string, string>();
  const handle = async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (!url.startsWith('https://kv.test/')) return null;
    const [verb, key] = url.slice('https://kv.test/'.length).split('/').map(decodeURIComponent);
    if (verb === 'get') return json({ result: data.get(key) ?? null });
    if (verb === 'set') {
      data.set(key, String(init?.body ?? ''));
      return json({ result: 'OK' });
    }
    if (verb === 'del') {
      data.delete(key);
      return json({ result: 1 });
    }
    return json({ result: null });
  };
  return { data, handle };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

interface RunOptions {
  env?: Record<string, string>;
  kv?: ReturnType<typeof store>;
  routes?: Record<string, Json>;
}

async function run(
  which: typeof admin | typeof licence, body: Json, options: RunOptions = {},
): Promise<{ code: number; body: Json; headers: Record<string, string> }> {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    KLINE_FOUNDER_HASH: HASH,
    KLINE_SIGNING_KEY: PEM,
    STRIPE_SECRET_KEY: '',
    KLINE_PRICE_ID: '',
    KV_REST_API_URL: options.kv ? 'https://kv.test' : '',
    KV_REST_API_TOKEN: options.kv ? 'token' : '',
    ...options.env,
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const fromKv = options.kv ? await options.kv.handle(url, init) : null;
    if (fromKv) return fromKv;
    for (const [prefix, answer] of Object.entries(options.routes ?? {})) {
      if (url.includes(prefix)) return json(answer);
    }
    return json({ error: { message: 'no stub' } }, 404);
  }) as typeof fetch;

  const { res, out } = recorder();
  try {
    await which({ method: 'POST', body, headers: { host: 'kline.test' } }, res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  return out;
}

/** Sign in and hand back the session, so the tests below read as one action. */
async function signIn(options: RunOptions = {}): Promise<string> {
  const result = await run(admin, { action: 'login', password: PASSWORD }, options);
  assert.equal(result.code, 200, `login failed: ${JSON.stringify(result.body)}`);
  return String(result.body.session);
}

// --------------------------------------------------------------- staying shut

test('the console refuses every login when no password is configured', async () => {
  // Falling open here would mean anybody who found the URL could issue
  // themselves a licence.
  for (const action of ['login', 'state', 'accounts.create', 'settings.save']) {
    const result = await run(admin, { action, password: PASSWORD }, { env: { KLINE_FOUNDER_HASH: '' } });
    assert.equal(result.code, 503, `${action} did not fail shut`);
    assert.equal(result.body.error, 'no-founder-password');
  }
});

test('a wrong password does not get in, and says nothing useful', async () => {
  for (const attempt of ['', 'wrong', PASSWORD.toUpperCase(), `${PASSWORD} `, 'scrypt$']) {
    const result = await run(admin, { action: 'login', password: attempt });
    assert.equal(result.code, 401, `"${attempt}" was accepted`);
    assert.equal(result.body.error, 'wrong-password');
  }
});

test('the right password gets in', async () => {
  const result = await run(admin, { action: 'login', password: PASSWORD });
  assert.equal(result.code, 200);
  assert.match(String(result.body.session), /^\d+\.[0-9a-f]{64}$/);
});

test('no session, a forged one, or an expired one is not a session', async () => {
  const real = await signIn();
  const [expires, signature] = real.split('.');
  const forged = [
    '',
    'nonsense',
    `${Date.now() + 1e7}.${'0'.repeat(64)}`,
    // The right signature, a later expiry: the classic attempt.
    `${Number(expires) + 1e7}.${signature}`,
    // A real signature that has run out.
    `${Date.now() - 1000}.${signature}`,
  ];
  for (const session of forged) {
    const result = await run(admin, { action: 'state', session });
    assert.equal(result.code, 401, `a session of "${session}" was accepted`);
  }
});

test('changing the password signs every open console out', async () => {
  const session = await signIn();
  const after = await run(admin, { action: 'state', session }, {
    env: { KLINE_FOUNDER_HASH: hashPassword('a completely different password') },
  });
  assert.equal(after.code, 401, 'an old session survived a password change');
});

test('the console is never framed, indexed, or cached', async () => {
  const result = await run(admin, { action: 'login', password: PASSWORD });
  assert.equal(result.headers['x-frame-options'], 'DENY');
  assert.match(result.headers['x-robots-tag'], /noindex/);
  assert.match(result.headers['cache-control'], /no-store/);
});

test('a live Stripe key is never sent back to the browser', async () => {
  const kv = store();
  const session = await signIn({ kv });
  await run(admin, {
    action: 'settings.save', session, stripeSecretKey: 'sk_live_supersecret', priceId: 'price_1',
  }, { kv });

  const state = await run(admin, { action: 'state', session }, { kv });
  const serialised = JSON.stringify(state.body);
  assert.ok(!serialised.includes('sk_live_supersecret'), 'the console echoed the secret key back');
  const stripe = state.body.stripe as Json;
  assert.equal(stripe.configured, true);
  assert.equal(stripe.mode, 'live');
});

// ------------------------------------------------------------ what it is for

test('an account made in the console unlocks Kline for that email', async () => {
  // The whole point of the founder login: somebody gets in without Stripe.
  const kv = store();
  const session = await signIn({ kv });

  const made = await run(admin, {
    action: 'accounts.create', session, email: 'Partner@Example.com', months: 3, plan: 'Partner',
  }, { kv });
  assert.equal(made.code, 200, JSON.stringify(made.body));

  const state = await run(licence, {
    action: 'state', install: 'install-partner', email: 'partner@example.com',
  }, { kv });
  assert.equal(state.body.status, 'active', 'a granted account did not unlock Kline');
  const parsed = await verifyKey(String(state.body.key), SPKI);
  assert.equal(parsed?.name, 'partner@example.com');
  assert.equal(parsed?.plan, 'Partner');
});

test('an account that never expires keeps working', async () => {
  const kv = store();
  const session = await signIn({ kv });
  await run(admin, {
    action: 'accounts.create', session, email: 'forever@example.com', forever: true,
  }, { kv });
  const state = await run(licence, {
    action: 'state', install: 'i', email: 'forever@example.com',
  }, { kv });
  assert.equal(state.body.status, 'active');
});

test('removing an account takes the access away', async () => {
  const kv = store();
  const session = await signIn({ kv });
  await run(admin, { action: 'accounts.create', session, email: 'gone@example.com' }, { kv });
  assert.equal(
    (await run(licence, { action: 'state', install: 'i', email: 'gone@example.com' }, { kv })).body.status,
    'active',
  );

  const removed = await run(admin, { action: 'accounts.delete', session, email: 'gone@example.com' }, { kv });
  assert.deepEqual(removed.body.accounts, []);
  assert.equal(
    (await run(licence, { action: 'state', install: 'i', email: 'gone@example.com' }, { kv })).body.status,
    'trial',
    'a removed account still unlocked Kline',
  );
});

test('an account that ran out is not an account', async () => {
  const kv = store();
  kv.data.set('kline:account:lapsed@example.com', JSON.stringify({
    email: 'lapsed@example.com', plan: 'Studio', expires: Date.now() - 1000, created: 0,
  }));
  const state = await run(licence, {
    action: 'state', install: 'i', email: 'lapsed@example.com',
  }, { kv });
  assert.equal(state.body.status, 'trial');
});

test('accounts are listed for the console, newest first', async () => {
  const kv = store();
  const session = await signIn({ kv });
  for (const email of ['one@example.com', 'two@example.com', 'three@example.com']) {
    await run(admin, { action: 'accounts.create', session, email }, { kv });
  }
  const state = await run(admin, { action: 'state', session }, { kv });
  const accounts = state.body.accounts as { email: string; created: number }[];
  assert.equal(accounts.length, 3);
  for (let i = 1; i < accounts.length; i++) {
    assert.ok(accounts[i - 1].created >= accounts[i].created, 'accounts were not newest first');
  }
});

test('Stripe details typed into the console are used by checkout', async () => {
  const kv = store();
  const session = await signIn({ kv });
  await run(admin, {
    action: 'settings.save', session, stripeSecretKey: 'sk_test_fromconsole', priceId: 'price_199',
  }, { kv });

  const checkout = await run(licence, { action: 'checkout', install: 'install-x' }, {
    kv,
    routes: { '/checkout/sessions': { url: 'https://checkout.stripe.com/c/pay/cs_1' } },
  });
  assert.equal(checkout.code, 200, 'console-entered Stripe details were ignored');
  assert.match(String(checkout.body.url), /^https:\/\/checkout\.stripe\.com\//);
});

test('Vercel beats the console, so a variable cannot be overridden from a browser', async () => {
  const kv = store();
  const session = await signIn({ kv, env: { STRIPE_SECRET_KEY: 'sk_live_fromvercel' } });
  await run(admin, {
    action: 'settings.save', session, stripeSecretKey: 'sk_test_fromconsole',
  }, { kv, env: { STRIPE_SECRET_KEY: 'sk_live_fromvercel' } });

  const state = await run(admin, { action: 'state', session }, {
    kv, env: { STRIPE_SECRET_KEY: 'sk_live_fromvercel' },
  });
  const stripe = state.body.stripe as Json;
  assert.equal(stripe.fromEnvironment, true);
  assert.equal(stripe.mode, 'live', 'the console overrode a key set in Vercel');
});

test('rubbish Stripe details are refused with the reason', async () => {
  const kv = store();
  const session = await signIn({ kv });
  const bad = await run(admin, {
    action: 'settings.save', session, stripeSecretKey: 'pk_live_thisisapublishablekey',
  }, { kv });
  assert.equal(bad.code, 400);
  assert.match(String(bad.body.error), /sk_test_|sk_live_/);

  const worse = await run(admin, { action: 'settings.save', session, priceId: 'prod_123' }, { kv });
  assert.equal(worse.code, 400);
  assert.match(String(worse.body.error), /price_/);
});

test('a deployment with no storage says so rather than losing an account', async () => {
  const session = await signIn();
  const result = await run(admin, {
    action: 'accounts.create', session, email: 'nowhere@example.com',
  });
  assert.equal(result.code, 503);
  assert.equal(result.body.error, 'no-storage');
});

test('the thirty-three hours cannot be changed from the console', async () => {
  // Asked for explicitly: the trial is fixed. There is no action that moves
  // it, and a request that tries is simply unknown.
  const kv = store();
  const session = await signIn({ kv });
  for (const action of ['trial.set', 'settings.trial', 'trial', 'settings.save.trial']) {
    const result = await run(admin, { action, session, trialMs: 999 * 3600000, months: 999 }, { kv });
    assert.notEqual(result.code, 200, `${action} was accepted`);
  }
  // And the trial the licence server hands out is still thirty-three hours.
  const state = await run(licence, { action: 'state', install: 'fresh-install' }, { kv });
  const hours = (Number(state.body.endsAt) - Date.now()) / 3600000;
  assert.ok(hours > 32.5 && hours <= 33, `the trial was ${hours} hours`);
});

test('no password or password hash is ever committed to this repository', async () => {
  // The guard on the rule that matters most here. The founder login can issue
  // licences and read every customer, and this repository has been public, so
  // a credential in a tracked file is a credential everybody has. The
  // password lives in Vercel as a hash and nowhere else; this fails if a
  // hash-shaped literal, or an obvious password assignment, lands in source.
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

  const sources = [...walk('src'), ...walk('api'), ...walk('tools'), ...walk('public')]
    .filter((path) => /\.(ts|mjs|js|html|json)$/.test(path));

  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    // A stored scrypt hash, committed.
    assert.ok(!/scrypt\$[0-9a-f]{20,}\$[0-9a-f]{20,}/.test(text),
      `${path} contains a committed password hash`);
    // A password assigned to a literal rather than read from the environment.
    for (const line of text.split('\n')) {
      if (/\/\/|\*/.test(line)) continue;
      assert.ok(!/(FOUNDER_PASSWORD|founderPassword|PASSWORD)\s*[=:]\s*['\`"][^'\`"$]{6,}/.test(line),
        `${path} hard-codes a password: ${line.trim()}`);
    }
  }
});
