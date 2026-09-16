import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import account from '../api/account';
import admin from '../api/admin';
import { hashPassword } from '../api/_store';
import { verifyKey } from '../src/licence/licence';

/**
 * Signing up, the thirty-three hours, and being let in by hand.
 *
 * This is the business as the customer meets it: they make an account on the
 * home page, they get thirty-three hours, it runs out, they pay through a
 * link, and one person turns them on. No payment API anywhere in it.
 */

const FOUNDER = 'a-test-founder-password';
// Hashed once. Hashing per call would salt differently every time, and the
// console's session signature is derived from the hash — so every session
// would be invalid the moment it was used.
const FOUNDER_HASH = hashPassword(FOUNDER);
const HOUR = 3600000;

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Json = Record<string, unknown>;

function recorder() {
  const out: { code: number; body: Json } = { code: 0, body: {} };
  const res = {
    status(code: number) { out.code = code; return res; },
    setHeader() { /* not inspected here */ },
    json(body: unknown) { out.body = (body ?? {}) as Json; },
    end() { /* nothing */ },
  };
  return { res, out };
}

/** A KV in a Map, speaking the REST shape the handlers expect. */
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

async function run(
  which: typeof account | typeof admin,
  body: Json,
  kv: ReturnType<typeof store>,
  env: Record<string, string> = {},
): Promise<{ code: number; body: Json }> {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    CULPMIXER_FOUNDER_HASH: FOUNDER_HASH,
    CULPMIXER_SIGNING_KEY: PEM,
    KV_REST_API_URL: 'https://kv.test',
    KV_REST_API_TOKEN: 'token',
    STRIPE_SECRET_KEY: '',
    CULPMIXER_PRICE_ID: '',
    CULPMIXER_PAYMENT_LINK: '',
    ...env,
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) =>
    (await kv.handle(String(input), init)) ?? json({ error: 'no stub' }, 404)) as typeof fetch;
  const { res, out } = recorder();
  try {
    await which({ method: 'POST', body, headers: {} }, res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  return out;
}

const signUp = (kv: ReturnType<typeof store>, over: Json = {}) => run(account, {
  action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password', ...over,
}, kv);

/** Move an account's clock so a trial can be watched running out. */
function windBack(kv: ReturnType<typeof store>, email: string, hours: number): void {
  const key = `culpmixer:account:${email}`;
  const raw = JSON.parse(kv.data.get(key) as string);
  kv.data.set(key, JSON.stringify({ ...raw, trialEndsAt: Date.now() - hours * HOUR }));
}

async function founderSession(kv: ReturnType<typeof store>): Promise<string> {
  const result = await run(
    admin, { action: 'login', email: 'culpindustriesllc@gmail.com', password: FOUNDER }, kv,
  );
  assert.equal(result.code, 200);
  return String(result.body.session);
}

// ----------------------------------------------------------------- signing up

test('signing up takes a username, an email and a password, and nothing else', async () => {
  const kv = store();
  const result = await signUp(kv);
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'trial');
  assert.equal(result.body.username, 'Zed');
  assert.equal(result.body.email, 'zed@example.com');
  // No confirmation step of any kind: they are in, with a working key, now.
  assert.ok(await verifyKey(String(result.body.key), SPKI), 'the key did not verify');
  assert.ok(String(result.body.session).length > 20, 'no session to remember them by');
});

test('the trial is thirty-three hours from the moment they sign up', async () => {
  const kv = store();
  const result = await signUp(kv);
  const left = Number(result.body.trialEndsAt) - Date.now();
  assert.ok(left > 32.9 * HOUR && left <= 33 * HOUR, `the trial was ${left / HOUR} hours`);
});

test('rubbish is refused with a sentence that says what to fix', async () => {
  const kv = store();
  const cases: [Json, RegExp][] = [
    [{ username: 'a' }, /username/i],
    [{ email: 'not-an-email' }, /email address/i],
    [{ password: 'short' }, /8 characters/i],
  ];
  for (const [over, expected] of cases) {
    const result = await signUp(kv, over);
    assert.equal(result.code, 400, `${JSON.stringify(over)} was accepted`);
    assert.match(String(result.body.error), expected);
  }
});

test('the same email cannot sign up twice', async () => {
  const kv = store();
  await signUp(kv);
  const again = await signUp(kv, { username: 'Someone else' });
  assert.equal(again.code, 409);
  assert.match(String(again.body.error), /already an account/i);
});

test('logging back in works, here and on another machine', async () => {
  const kv = store();
  await signUp(kv);
  for (const install of ['laptop', 'desktop']) {
    const back = await run(account, {
      action: 'signin', email: 'zed@example.com', password: 'a-good-password', install,
    }, kv);
    assert.equal(back.code, 200, `${install} was refused`);
    assert.equal(back.body.status, 'trial');
    assert.ok(await verifyKey(String(back.body.key), SPKI));
  }
});

test('a wrong password is refused, and says nothing about who exists', async () => {
  const kv = store();
  await signUp(kv);
  for (const [email, password] of [
    ['zed@example.com', 'wrong'],
    ['zed@example.com', ''],
    ['nobody@example.com', 'a-good-password'],
  ]) {
    const result = await run(account, { action: 'signin', email, password }, kv);
    assert.equal(result.code, 401, `${email}/${password} got in`);
    assert.equal(result.body.error, 'wrong-details');
  }
});

// ------------------------------------------------------- the thirty-three hours

test('when the trial runs out they are locked and sent to the link', async () => {
  const kv = store();
  await signUp(kv);
  windBack(kv, 'zed@example.com', 1);

  const after = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv, { CULPMIXER_PAYMENT_LINK: 'https://buy.stripe.com/test' });

  // Still a correct sign-in — being out of trial is not a wrong password.
  assert.equal(after.code, 200, 'a real password was refused after the trial');
  assert.equal(after.body.status, 'locked');
  assert.equal(after.body.paymentLink, 'https://buy.stripe.com/test');
  assert.equal(after.body.key, undefined, 'a locked account was handed a working key');
  assert.match(String(after.body.message), /199/);
  // And it says why it is by hand, so nobody is left wondering.
  assert.match(String(after.body.message), /one person runs The Culp Mixer/i);
});

test('the trial does not restart by signing out, or on another machine', async () => {
  const kv = store();
  const first = await signUp(kv);
  const endsAt = Number(first.body.trialEndsAt);

  const elsewhere = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv);
  assert.equal(Number(elsewhere.body.trialEndsAt), endsAt, 'a second machine got a fresh trial');
});

test('refresh is what notices the trial running out', async () => {
  const kv = store();
  const start = await signUp(kv);
  const session = String(start.body.session);

  const during = await run(account, { action: 'refresh', session }, kv);
  assert.equal(during.body.status, 'trial');

  windBack(kv, 'zed@example.com', 2);
  const after = await run(account, { action: 'refresh', session }, kv);
  assert.equal(after.body.status, 'locked', 'the trial never ran out');
});

test('a forged or expired session is not a session', async () => {
  const kv = store();
  const start = await signUp(kv);
  const real = String(start.body.session);
  const [who, expires, signature] = real.split('.');
  for (const session of [
    '', 'nonsense', `${who}.${expires}.${'0'.repeat(64)}`,
    `${who}.${Number(expires) + 1e7}.${signature}`,
    `${Buffer.from('someone@else.com').toString('base64url')}.${expires}.${signature}`,
  ]) {
    const result = await run(account, { action: 'refresh', session }, kv);
    assert.equal(result.code, 401, `a session of "${session}" was accepted`);
  }
});

// ------------------------------------------------------ letting somebody in

test('marking somebody paid lets them straight back in', async () => {
  // The whole payment system: they pay through the link, say so, and this is
  // the founder agreeing. No API, no webhook, no card data anywhere near it.
  const kv = store();
  await signUp(kv);
  windBack(kv, 'zed@example.com', 1);

  const locked = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv);
  assert.equal(locked.body.status, 'locked');

  const session = await founderSession(kv);
  const approved = await run(admin, {
    action: 'accounts.approve', session, email: 'zed@example.com', months: 1,
  }, kv);
  assert.equal(approved.code, 200, JSON.stringify(approved.body));

  const back = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv);
  assert.equal(back.body.status, 'paid', 'paying did not let them back in');
  assert.ok(await verifyKey(String(back.body.key), SPKI));
});

test('revoking puts them back to needing to pay, without deleting anything', async () => {
  const kv = store();
  await signUp(kv);
  const session = await founderSession(kv);
  await run(admin, { action: 'accounts.approve', session, email: 'zed@example.com' }, kv);
  await run(admin, { action: 'accounts.revoke', session, email: 'zed@example.com' }, kv);
  windBack(kv, 'zed@example.com', 1);

  const after = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv);
  assert.equal(after.body.status, 'locked');
  // Their login still works — the account is intact, they simply have to pay.
  assert.equal(after.code, 200, 'revoking destroyed the login');
});

test('somebody who paid from another address is let in on that address', async () => {
  // Said in the interface and true in the data: the founder makes an account
  // on whichever address paid, and it is on from the start.
  const kv = store();
  const session = await founderSession(kv);
  const made = await run(admin, {
    action: 'accounts.create', session, email: 'thecard@example.com', username: 'Zed', months: 1,
  }, kv);
  assert.equal(made.code, 200);

  const back = await run(account, {
    action: 'signin', email: 'thecard@example.com', password: String(made.body.password),
  }, kv);
  assert.equal(back.body.status, 'paid', 'an account the founder made was not already paid');
});

test('the founder sees the same countdown the customer does', async () => {
  const kv = store();
  await signUp(kv);
  const session = await founderSession(kv);
  const state = await run(admin, { action: 'state', session }, kv);
  const accounts = state.body.accounts as Json[];
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'Zed');
  assert.equal((accounts[0].standing as Json).state, 'trial');
  const hours = Number(accounts[0].msLeft) / HOUR;
  assert.ok(hours > 32.9 && hours <= 33, `the console showed ${hours} hours`);
  // And never the password hash.
  assert.ok(!JSON.stringify(state.body).includes('scrypt$'), 'a hash reached the console');
});

test('a paid account with no expiry never lapses', async () => {
  const kv = store();
  await signUp(kv);
  const session = await founderSession(kv);
  await run(admin, { action: 'accounts.approve', session, email: 'zed@example.com', forever: true }, kv);
  windBack(kv, 'zed@example.com', 10000);
  const after = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, kv);
  assert.equal(after.body.status, 'paid');
});

test('with no storage, accounts are refused rather than silently lost', async () => {
  const kv = store();
  const result = await run(account, {
    action: 'signup', username: 'Zed', email: 'z@example.com', password: 'a-good-password',
  }, kv, { KV_REST_API_URL: '', KV_REST_API_TOKEN: '' });
  assert.equal(result.code, 503);
  assert.equal(result.body.error, 'no-storage');
});

test('nothing here ever talks to Stripe', async () => {
  // Stated as a test because it is the design: one person approves people by
  // hand, and no payment API is involved at any point.
  const kv = store();
  const reached: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    CULPMIXER_SIGNING_KEY: PEM,
    KV_REST_API_URL: 'https://kv.test',
    KV_REST_API_TOKEN: 'token',
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    reached.push(String(input));
    return (await kv.handle(String(input), init)) ?? json({ error: 'no stub' }, 404);
  }) as typeof fetch;
  const { res } = recorder();
  try {
    await account({
      method: 'POST',
      body: { action: 'signup', username: 'Z', email: 'z@example.com', password: 'a-good-password' },
      headers: {},
    }, res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  assert.ok(!reached.some((url) => url.includes('stripe.com')), `it called ${reached.join(', ')}`);
});

test('opening the endpoint in a browser says what is still missing', async () => {
  // The fastest way to answer "is it deployed and finished?", and the one a
  // person will actually use — a URL in a browser rather than a curl with
  // headers. Booleans only: nothing here is a secret.
  const kv = store();
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    CULPMIXER_SIGNING_KEY: '',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    CULPMIXER_PAYMENT_LINK: '',
  });
  globalThis.fetch = (async () => json({ result: null })) as typeof fetch;
  const bare = recorder();
  try {
    await account({ method: 'GET', headers: {} }, bare.res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  assert.equal(bare.out.code, 200, 'a browser got an error rather than an answer');
  assert.equal(bare.out.body.ready, false);
  assert.equal(bare.out.body.storage, false);
  assert.equal(bare.out.body.signingKey, false);
  assert.equal(bare.out.body.trialHours, 33);
  const missing = bare.out.body.missing as string[];
  assert.ok(missing.some((m) => /SUPABASE/.test(m)), `it did not name Supabase: ${missing}`);
  assert.ok(missing.some((m) => /SIGNING_KEY/.test(m)), `it did not name the key: ${missing}`);
  // And no secret leaks out of it, whatever is set.
  assert.ok(!JSON.stringify(bare.out.body).includes('BEGIN'), 'the health check leaked a key');

  // Fully configured, it simply says ready.
  const full = await run(account, { action: '__health__' }, kv);
  assert.ok(full.code === 200 || full.code === 400, 'configured lookup failed unexpectedly');
  const good = recorder();
  const env2 = { ...process.env };
  Object.assign(process.env, {
    CULPMIXER_SIGNING_KEY: PEM,
    KV_REST_API_URL: 'https://kv.test',
    KV_REST_API_TOKEN: 'token',
    CULPMIXER_PAYMENT_LINK: 'https://buy.example.com/x',
  });
  const f2 = globalThis.fetch;
  globalThis.fetch = (async (i: string | URL, init?: RequestInit) =>
    (await kv.handle(String(i), init)) ?? json({ result: null })) as typeof fetch;
  try {
    await account({ method: 'GET', headers: {} }, good.res);
  } finally {
    globalThis.fetch = f2;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env2);
  }
  assert.equal(good.out.body.ready, true, JSON.stringify(good.out.body));
  assert.deepEqual(good.out.body.missing, []);
});

test('the founder logs in through the ordinary form, with no database at all', async () => {
  // The point of this one: the person who owns The Culp Mixer must be able to
  // open it on a deployment that is only half set up — which is exactly when
  // they most need to get in and look at it. No store, no account row, no
  // trial, just the two things they already know.
  const kv = store();
  const result = await run(account, {
    action: 'signin', email: 'culpindustriesllc@gmail.com', password: FOUNDER,
  }, kv, { KV_REST_API_URL: '', KV_REST_API_TOKEN: '' });

  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'paid');
  assert.equal(result.body.founder, true);
  assert.equal(result.body.plan, 'Founder');
  const parsed = await verifyKey(String(result.body.key), SPKI);
  assert.ok(parsed, 'the founder was handed a key that does not verify');

  // And the session keeps working on the next launch, still with no store.
  const later = await run(account, {
    action: 'refresh', session: String(result.body.session),
  }, kv, { KV_REST_API_URL: '', KV_REST_API_TOKEN: '' });
  assert.equal(later.body.status, 'paid');
  assert.equal(later.body.founder, true);
});

test('the founder login is the founder password, and nothing else is', async () => {
  const kv = store();
  const attempts: [string, string][] = [
    ['culpindustriesllc@gmail.com', 'wrong'],
    ['culpindustriesllc@gmail.com', ''],
    ['someone@else.com', FOUNDER],
    ['', FOUNDER],
  ];
  for (const [email, password] of attempts) {
    const result = await run(account, { action: 'signin', email, password }, kv);
    assert.notEqual(result.body.founder, true, `"${email}" / "${password}" got the founder in`);
  }
});

test('a customer cannot become the founder by signing up as that address', async () => {
  // Signing up with the founder address must not mint a founder session: the
  // founder branch is the password, not the email.
  const kv = store();
  const made = await run(account, {
    action: 'signup', username: 'Impostor', email: 'culpindustriesllc@gmail.com',
    password: 'not-the-founder-password',
  }, kv);
  assert.equal(made.code, 200);
  assert.notEqual(made.body.founder, true, 'signing up as that address granted founder access');
  assert.equal(made.body.status, 'trial', 'they got more than a trial');

  // And the real founder password still wins on that address.
  const real = await run(account, {
    action: 'signin', email: 'culpindustriesllc@gmail.com', password: FOUNDER,
  }, kv);
  assert.equal(real.body.founder, true, 'the founder was locked out by a squatted row');
});

test('a host that has not deployed the functions is not an account service', async () => {
  // The fault this is here for: a 404 page came back, the application took
  // that as "the service answered", put the front door up, and then nothing
  // behind that door could ever succeed. Locked out of your own application
  // by a hosting setting.
  const { refreshAccount } = await import('../src/licence/account');
  const previousFetch = globalThis.fetch;
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    // A stock 404 page: HTML, not JSON.
    globalThis.fetch = (async () => new Response('<!doctype html><h1>404</h1>', {
      status: 404, headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;
    const missing = await refreshAccount();
    assert.equal(missing.reached, false, 'a 404 page was taken for the account service');

    // A real answer, even a refusal, is the service.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'sign-in-again' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const real = await refreshAccount();
    assert.equal(real.reached, true, 'a genuine refusal was taken for a missing service');
  } finally {
    globalThis.fetch = previousFetch;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
