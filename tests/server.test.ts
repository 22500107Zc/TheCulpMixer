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
  options: {
    env?: Record<string, string>;
    routes?: Record<string, Json>;
    kv?: Map<string, string>;
    /** Deliberately deploy with no licence store, which is a supported way to run. */
    noStore?: boolean;
  } = {},
): Promise<{ code: number; body: Json }> {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  // A store by default, because it is the stronger of the two trial clocks.
  // Tests that want the unconfigured deployment ask for it by name rather than
  // getting it by omission, so it is always obvious which one is under test.
  const kv = options.noStore ? undefined : (options.kv ?? new Map<string, string>());
  Object.assign(process.env, {
    CULPMIXER_SIGNING_KEY: PEM,
    STRIPE_SECRET_KEY: '',
    CULPMIXER_PRICE_ID: '',
    ...(kv ? { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' }
      : { KV_REST_API_URL: '', KV_REST_API_TOKEN: '' }),
    ...options.env,
  });
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
    await handler({ method: 'POST', body, headers: { host: 'culpmixer.test' } }, res);
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
  const kv = new Map<string, string>([['culpmixer:trial:install-d', String(Date.now() - 40 * HOUR)]]);
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
      env: { STRIPE_SECRET_KEY: 'sk_test', CULPMIXER_PRICE_ID: 'price_199' },
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
      env: { STRIPE_SECRET_KEY: 'sk_test', CULPMIXER_PRICE_ID: 'price_199' },
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
      env: { CULPMIXER_SIGNING_KEY: '', STRIPE_SECRET_KEY: 'sk_test' },
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
  process.env.CULPMIXER_SIGNING_KEY = PEM;
  const { res, out } = recorder();
  await handler({ method: 'OPTIONS', headers: {} }, res);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  assert.equal(out.code, 204);
  assert.equal(out.headers['access-control-allow-origin'], '*');
  // A cached "you are in trial" would outlive the payment that ended it.
  assert.match(out.headers['cache-control'], /no-store/);
});

/**
 * No store is a supported deployment, not a broken one.
 *
 * The Culp Mixer requires no database, no dashboard and no account to sign up
 * for. A brand-new visitor opens the page and their thirty-three hours start,
 * whether or not a persistent store is configured and whether or not it is
 * answering. When there is one it keeps the clock, because that clock is the
 * stronger of the two; when there is not, the client's own clock stands.
 *
 * Somebody determined can clear their browser and take another thirty-three
 * hours. That is an accepted business cost, not a hole to plug. What matters
 * is the line this must never cross: it grants a TRIAL and only a trial. Paid
 * access stays a signed entitlement minted from a real Stripe subscription,
 * and nothing on this path can forge, substitute or extend one.
 */
test('a deployment with no licence store still starts a trial', async () => {
  const answer = await call({ action: 'state', install: 'no-store-1' }, { noStore: true });
  assert.equal(answer.code, 200, 'an unconfigured deployment refused a new visitor');
  assert.equal(answer.body.status, 'trial', 'a brand-new visitor was not put in trial');
  const endsAt = Number(answer.body.endsAt);
  assert.ok(endsAt > Date.now() + 32 * HOUR && endsAt < Date.now() + 34 * HOUR,
    `the trial ran for the wrong length: ends at ${endsAt}`);
  assert.ok(!('key' in answer.body), 'a store outage minted an entitlement');
});

test('a store that is down still starts a trial rather than blocking', async () => {
  // Configured, but every request to it fails. The application must open
  // anyway: an outage in something optional cannot become a paywall.
  const answer = await call({ action: 'state', install: 'down-1' }, {
    env: { KV_REST_API_URL: 'https://kv.unreachable', KV_REST_API_TOKEN: 't' },
    noStore: true,
  });
  assert.equal(answer.code, 200, 'an unreachable store locked a new visitor out');
  assert.equal(answer.body.status, 'trial');
  assert.ok(!('key' in answer.body), 'a store outage minted an entitlement');
});

test('with no store the trial runs from the clock the client already had', async () => {
  // Mid-trial, no store. The client says when it started, and that must be
  // honoured rather than reset — otherwise every reload is a fresh 33 hours
  // even for somebody who is not trying to cheat.
  const started = Date.now() - 20 * HOUR;
  const answer = await call(
    { action: 'state', install: 'no-store-2', startedAt: started },
    { noStore: true },
  );
  assert.equal(answer.body.status, 'trial');
  assert.equal(Number(answer.body.endsAt), started + 33 * HOUR,
    'the client clock was ignored, restarting the trial');
});

test('with no store an expired trial is still over', async () => {
  const started = Date.now() - 40 * HOUR;
  const answer = await call(
    { action: 'state', install: 'no-store-3', startedAt: started },
    { noStore: true },
  );
  assert.equal(answer.body.status, 'expired', 'an ended trial came back alive');
  assert.ok(!('key' in answer.body), 'an ended trial was handed an entitlement');
});

test('a paying customer is unaffected by the store being down', async () => {
  // A subscriber's access has nothing to do with the trial store: their
  // subscription is answered by Stripe and their entitlement is a signed key.
  const answer = await call(
    { action: 'state', install: 'paid-nostore' },
    {
      noStore: true,
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [live(Date.now() + 30 * 24 * HOUR)] } },
    },
  );
  assert.equal(answer.code, 200, 'a subscriber was locked out by a store outage');
  assert.equal(answer.body.status, 'active');
  assert.ok(typeof answer.body.key === 'string' && String(answer.body.key).includes('.'),
    'the subscriber got no entitlement');
});

test('a trial already under way survives the store going down mid-trial', async () => {
  // Started while the store was up, then the store fails. The customer is
  // mid-trial and must not be told to try again later on every keystroke —
  // but the server also must not invent a NEW trial for them.
  const kv = new Map<string, string>();
  const started = await call({ action: 'state', install: 'midtrial' }, { kv });
  assert.equal(started.body.status, 'trial');
  const again = await call({ action: 'state', install: 'midtrial' }, { kv });
  assert.equal(again.body.endsAt, started.body.endsAt, 'the deadline moved');
});

/**
 * Stripe states, named deliberately rather than left to a default.
 *
 * Two fail-opens lived here. `past_due` was simply "live", with no time bound,
 * and Stripe will leave a subscription in `past_due` for as long as its retry
 * settings say — indefinitely, if no automatic cancellation is configured. And
 * a subscription whose `current_period_end` was missing or unparseable was
 * granted `now + one week`, re-granted on every poll, for ever.
 *
 * Together: a card cancelled in March kept the product free in December.
 */
const pastDue = (endsAt: number): Json =>
  ({ status: 'past_due', current_period_end: Math.floor(endsAt / 1000) });

test('a failing card keeps working through the grace window', async () => {
  // Three days past the end of the period they paid for. A bank fraud hold or
  // an expired card must not interrupt somebody mid-project.
  const answer = await call(
    { action: 'state', install: 'pd-grace' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [pastDue(Date.now() - 3 * 24 * HOUR)] } },
    },
  );
  assert.equal(answer.body.status, 'active', 'a card that failed three days ago locked somebody out');
});

test('a failing card does not keep working for ever', async () => {
  // Sixty days past the period end. Stripe may still say past_due; that is not
  // a reason to keep handing over a $199/month product.
  const answer = await call(
    { action: 'state', install: 'pd-forever' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: { '/subscriptions/search': { data: [pastDue(Date.now() - 60 * 24 * HOUR)] } },
    },
  );
  assert.notEqual(answer.body.status, 'active',
    'a subscription that has been past_due for two months still unlocked The Culp Mixer');
});

test('a subscription that does not say what was paid for is not an entitlement', async () => {
  for (const [label, sub] of [
    ['no period end', { status: 'active' }],
    ['unparseable period end', { status: 'active', current_period_end: 'soon' }],
    ['zero period end', { status: 'active', current_period_end: 0 }],
  ] as [string, Json][]) {
    const answer = await call(
      { action: 'state', install: `noend-${label.replace(/\W+/g, '')}` },
      { env: { STRIPE_SECRET_KEY: 'sk_test' }, routes: { '/subscriptions/search': { data: [sub] } } },
    );
    assert.notEqual(answer.body.status, 'active', `${label} was treated as a paid subscription`);
  }
});

test('every other Stripe state is refused', async () => {
  // Named one by one so a state nobody has considered cannot be admitted by a
  // default that says yes.
  for (const status of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    const answer = await call(
      { action: 'state', install: `st-${status}` },
      {
        env: { STRIPE_SECRET_KEY: 'sk_test' },
        routes: {
          '/subscriptions/search': {
            data: [{ status, current_period_end: Math.floor((Date.now() + 30 * 24 * HOUR) / 1000) }],
          },
        },
      },
    );
    assert.notEqual(answer.body.status, 'active', `a ${status} subscription unlocked The Culp Mixer`);
  }
});

test('an expired period is not an entitlement even while Stripe says active', async () => {
  const answer = await call(
    { action: 'state', install: 'st-stale-active' },
    {
      env: { STRIPE_SECRET_KEY: 'sk_test' },
      routes: {
        '/subscriptions/search': {
          data: [{ status: 'active', current_period_end: Math.floor((Date.now() - HOUR) / 1000) }],
        },
      },
    },
  );
  assert.notEqual(answer.body.status, 'active', 'a period that already ended still unlocked The Culp Mixer');
});
