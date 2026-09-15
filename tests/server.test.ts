import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import handler from '../api/licence';
import { verifyKey } from '../src/licence/licence';

/**
 * The licence server.
 *
 * This is the piece that turns "send them a link" into money, so the tests
 * here are mostly about the ways it could quietly stop doing that: a paying
 * customer told they have not paid, a trial that restarts for ever, a token
 * that looks fine and does not verify in the application.
 *
 * Stripe is stubbed. What is *not* stubbed is the signing: every token this
 * mints is checked with the application's own `verifyKey`, because the one
 * bug that would waste a whole launch is a server that signs in a format the
 * application cannot read.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const HOUR = 3600000;

/** A response object that records what the handler said. */
function recorder() {
  const out: { code: number; body: unknown; headers: Record<string, string> } = {
    code: 0, body: null, headers: {},
  };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      out.body = body;
    },
    end() {
      /* nothing to record */
    },
  };
  return { res, out };
}

type Json = Record<string, unknown>;

/**
 * Run the handler with a given environment and a stubbed Stripe.
 *
 * `routes` maps a path prefix to the JSON Stripe would have returned.
 */
async function call(
  body: Json,
  options: { env?: Record<string, string>; routes?: Record<string, Json>; kv?: Map<string, string> } = {},
): Promise<{ code: number; body: Json }> {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    KLINE_SIGNING_KEY: PEM,
    STRIPE_SECRET_KEY: '',
    KLINE_PRICE_ID: '',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    ...options.env,
  });
  const kv = options.kv;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (kv && url.startsWith('https://kv.test/')) {
      // The value travels in the body, not the path: an email or a secret in
      // a URL ends up in every proxy log between here and the store.
      const [verb, key] = url.slice('https://kv.test/'.length).split('/').map(decodeURIComponent);
      if (verb === 'get') return json({ result: kv.get(key) ?? null });
      if (verb === 'set') {
        kv.set(key, String(init?.body ?? ''));
        return json({ result: 'OK' });
      }
      if (verb === 'del') {
        kv.delete(key);
        return json({ result: 1 });
      }
    }
    for (const [prefix, answer] of Object.entries(options.routes ?? {})) {
      if (url.includes(prefix)) return json(answer);
    }
    return json({ error: { message: 'no stub' } }, 404);
  }) as typeof fetch;

  const { res, out } = recorder();
  try {
    await handler({ method: 'POST', body, headers: { host: 'kline.test' } }, res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  return { code: out.code, body: (out.body ?? {}) as Json };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const live = (until: number): Json => ({
  status: 'active',
  current_period_end: Math.floor(until / 1000),
});

// ------------------------------------------------------------------ trials

test('a first visit starts a thirty-three hour trial', async () => {
  const answer = await call({ action: 'state', install: 'install-a' });
  assert.equal(answer.code, 200);
  assert.equal(answer.body.status, 'trial');
  const left = Number(answer.body.endsAt) - Date.now();
  assert.ok(left > 32 * HOUR && left <= 33 * HOUR, `trial was ${left / HOUR} hours`);
});

test('the trial does not restart when the browser is wiped', async () => {
  // The hole this closes: without a server clock, clearing site data is a
  // fresh thirty-three hours, for ever, and nobody ever pays.
  const kv = new Map<string, string>();
  const env = { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' };
  const first = await call({ action: 'state', install: 'install-b' }, { env, kv });
  assert.equal(first.body.status, 'trial');

  // Same install, but the client has forgotten everything and claims nothing.
  const wiped = await call({ action: 'state', install: 'install-b' }, { env, kv });
  assert.equal(wiped.body.endsAt, first.body.endsAt, 'a wiped client got a new trial');

  // And it cannot talk its way into a later deadline either.
  const lying = await call(
    { action: 'state', install: 'install-b', startedAt: Date.now() + 1e9 }, { env, kv },
  );
  assert.equal(lying.body.endsAt, first.body.endsAt, 'a claimed clock extended the trial');
});

test('a client clock is honoured only when it makes the trial shorter', async () => {
  const kv = new Map<string, string>();
  const env = { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' };
  const started = Date.now() - 30 * HOUR;
  const answer = await call({ action: 'state', install: 'install-c', startedAt: started }, { env, kv });
  const left = Number(answer.body.endsAt) - Date.now();
  assert.ok(left > 2.5 * HOUR && left < 3.5 * HOUR, `expected ~3 hours left, got ${left / HOUR}`);
});

test('a trial that has run out says expired, and says it every time', async () => {
  const kv = new Map<string, string>([['kline:trial:install-d', String(Date.now() - 40 * HOUR)]]);
  const env = { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' };
  for (let i = 0; i < 3; i++) {
    const answer = await call({ action: 'state', install: 'install-d' }, { env, kv });
    assert.equal(answer.body.status, 'expired');
  }
});

// ----------------------------------------------------------- subscriptions

test('a customer who just paid is recognised from the checkout session', async () => {
  // Stripe's search index lags by up to a minute, so paying and then being
  // told you have not paid is exactly the moment this avoids.
  const answer = await call(
    { action: 'state', install: 'install-e', session: 'cs_test_123' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: {
        '/checkout/sessions/cs_test_123': {
          subscription: live(Date.now() + 30 * 24 * HOUR),
          customer_details: { email: 'buyer@example.com' },
        },
      },
    },
  );
  assert.equal(answer.body.status, 'active');
  const licence = await verifyKey(String(answer.body.key), SPKI);
  assert.ok(licence, 'the token the server minted does not verify in the application');
  assert.equal(licence.name, 'buyer@example.com');
  assert.equal(licence.plan, 'Subscription');
});

test('a returning customer is recognised by the install id alone', async () => {
  const answer = await call(
    { action: 'state', install: 'install-f' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [live(Date.now() + 20 * 24 * HOUR)] } },
    },
  );
  assert.equal(answer.body.status, 'active');
  assert.ok(await verifyKey(String(answer.body.key), SPKI));
});

test('a second machine is unlocked by the email they paid with', async () => {
  const answer = await call(
    { action: 'state', install: 'install-new-laptop', email: 'Buyer@Example.com' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: {
        '/subscriptions/search': { data: [] },
        '/customers': { data: [{ id: 'cus_1' }] },
        '/subscriptions?': { data: [live(Date.now() + 10 * 24 * HOUR)] },
      },
    },
  );
  assert.equal(answer.body.status, 'active', 'a paying customer could not unlock a second machine');
  const licence = await verifyKey(String(answer.body.key), SPKI);
  assert.equal(licence?.name, 'buyer@example.com', 'the email was not normalised');
});

test('a cancelled subscription is not a licence', async () => {
  const answer = await call(
    { action: 'state', install: 'install-g' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: {
        '/subscriptions/search': { data: [{ status: 'canceled', current_period_end: 1 }] },
      },
    },
  );
  assert.equal(answer.body.status, 'trial', 'a cancelled subscription still unlocked The Culp Mixer');
});

test('the lease is capped at a week even on an annual subscription', async () => {
  // How long somebody keeps working after cancelling, and how long they keep
  // working on a plane. Both are this number.
  const answer = await call(
    { action: 'state', install: 'install-h' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [live(Date.now() + 365 * 24 * HOUR)] } },
    },
  );
  const licence = await verifyKey(String(answer.body.key), SPKI);
  const days = ((licence?.expires ?? 0) - Date.now()) / (24 * HOUR);
  assert.ok(days > 6.5 && days <= 7.5, `the lease ran for ${days} days`);
});

// ---------------------------------------------------------------- checkout

test('checkout hands back a Stripe page', async () => {
  const answer = await call(
    { action: 'checkout', install: 'install-i', email: 'buyer@example.com' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test', KLINE_PRICE_ID: 'price_199' },
      routes: { '/checkout/sessions': { url: 'https://checkout.stripe.com/c/pay/cs_test' } },
    },
  );
  assert.equal(answer.code, 200);
  assert.match(String(answer.body.url), /^https:\/\/checkout\.stripe\.com\//);
});

test('checkout refuses a page that is not Stripe', async () => {
  // The client only opens https Stripe URLs, and this is the other half of
  // that: a misconfigured or hijacked response cannot become a redirect.
  const answer = await call(
    { action: 'checkout', install: 'install-i2' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test', KLINE_PRICE_ID: 'price_199' },
      routes: { '/checkout/sessions': { error: { message: 'no such price' } } },
    },
  );
  assert.equal(answer.code, 502);
});

test('a build with no Stripe account says so instead of opening a broken page', async () => {
  const answer = await call({ action: 'checkout', install: 'install-j' });
  assert.equal(answer.code, 503);
  assert.equal(answer.body.error, 'not-selling-yet');
});

// ------------------------------------------------------------------ safety

test('a deployment with no signing key fails loudly', async () => {
  // The alternative is handing every visitor a trial for ever and nobody
  // noticing until the month's takings are zero.
  const answer = await call(
    { action: 'state', install: 'install-k' },
    {
      env: { KLINE_SIGNING_KEY: '', STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [live(Date.now() + 24 * HOUR)] } },
    },
  );
  assert.equal(answer.code, 500);
  assert.equal(answer.body.error, 'no-signing-key');
});

test('an install id is required, and nothing runs without one', async () => {
  const answer = await call({ action: 'state' });
  assert.equal(answer.code, 400);
});

test('Stripe being down leaves the trial answer standing', async () => {
  // Not "locked because we could not check" — that would take a working
  // application away from somebody mid-trial over somebody else's outage.
  const answer = await call(
    { action: 'state', install: 'install-l' },
    { env: { STRIPE_SECRET_KEY: 'sk_test' }, routes: {} },
  );
  assert.equal(answer.body.status, 'trial');
});

test('the browser is allowed to ask, and the answer is never cached', async () => {
  const previousEnv = { ...process.env };
  process.env.KLINE_SIGNING_KEY = PEM;
  const { res, out } = recorder();
  await handler({ method: 'OPTIONS', headers: {} }, res);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  assert.equal(out.code, 204);
  assert.equal(out.headers['access-control-allow-origin'], '*');
  // A cached "you are in trial" would outlive the payment that ended it.
  assert.match(out.headers['cache-control'], /no-store/);
});
