/**
 * The licence server.
 *
 * What this exists for, in one sentence: so that selling The Culp Mixer is sending
 * somebody a link, and nothing else.
 *
 * Everything here runs on Vercel next to the web app. There is no database to
 * run and no admin panel to log into — Stripe holds who is paying, and this
 * asks it. The client never sees a secret and never handles a licence key: it
 * sends an install id, and gets back either "you have this long left of the
 * trial" or a short-lived signed entitlement that the application already knows
 * how to verify offline.
 *
 * That last part is why this is small. The application has verified signed
 * licences since before this file existed, and that code is unchanged; this
 * just mints them automatically instead of somebody minting them by hand.
 *
 * Configuration, all of it in Vercel's environment variables:
 *
 *   CULPMIXER_SIGNING_KEY   the P-256 private key, PEM, the same one that signs
 *                       keys by hand. Without it this refuses to pretend, and
 *                       says so, rather than handing out unsigned tokens.
 *   STRIPE_SECRET_KEY   a Stripe secret key (sk_live_... or sk_test_...).
 *   CULPMIXER_PRICE_ID      the Stripe price for $199/month (price_...).
 *   CULPMIXER_APP_URL       where to send somebody back to after paying.
 *                       Optional; defaults to the request's own origin.
 *   KV_REST_API_URL     optional. Any Upstash-compatible REST KV. With one,
 *   KV_REST_API_TOKEN   the trial clock lives on the server and clearing the
 *                       browser does not restart it. Without one, the trial
 *                       falls back to the client clock, which is the weaker
 *                       thing but still a trial.
 */

import { createPrivateKey, sign } from 'node:crypto';
import {
  KEYS, callerKey, clearFailures, env, kvRead, kvSet, liveAccount, rateLimited, recordFailure,
  settings, signInAccount, standing,
} from './_store.js';

/** Thirty-three hours. The same number the application and the LICENCE state. */
const TRIAL_MS = 33 * 60 * 60 * 1000;

/**
 * How long an entitlement is good for without asking again.
 *
 * A subscriber who goes on a plane keeps working. A subscriber who cancels
 * keeps working until this runs out, which is a week of somebody's goodwill
 * and much cheaper than an application that locks the moment a café's wifi
 * drops.
 */
const LEASE_MS = 7 * 24 * 60 * 60 * 1000;

const STRIPE = 'https://api.stripe.com/v1';

/** Minimal shapes, so this needs no framework types to compile. */
interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(body?: string): void;
}

const base64url = (b: Buffer | Uint8Array): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Mint the two-part key the application verifies.
 *
 * P-1363 rather than DER, because WebCrypto's ECDSA verify wants raw r||s and
 * Node defaults to DER. Getting this wrong produces a key that looks perfectly
 * well formed and never verifies.
 */
function mint(payload: Record<string, unknown>): string {
  const pem = env('CULPMIXER_SIGNING_KEY');
  if (!pem) throw new Error('no-signing-key');
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const signature = sign('sha256', Buffer.from(body), {
    key: createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${body}.${base64url(signature)}`;
}

/** Stripe, over plain fetch. No SDK: The Culp Mixer ships no runtime dependencies. */
async function stripe(
  path: string, params?: Record<string, string>, method: 'GET' | 'POST' = 'GET',
): Promise<Record<string, unknown> | null> {
  // The environment first, then whatever was typed into the founder console.
  const key = (await settings()).stripeSecretKey;
  if (!key) return null;
  const query = params && method === 'GET' ? `?${new URLSearchParams(params)}` : '';
  const response = await fetch(`${STRIPE}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    ...(method === 'POST' && params ? { body: new URLSearchParams(params).toString() } : {}),
  });
  const json = (await response.json()) as Record<string, unknown>;
  // A Stripe error is data here, not an exception: the caller decides whether
  // a missing customer means "not paying" or "something is broken".
  return response.ok ? json : { error: json.error ?? true };
}

/** An active subscription for this install, or for this email. Null if none. */
async function findSubscription(
  install: string, email: string, session: string,
): Promise<{ name: string; until: number; plan?: string } | null> {
  // 0. An account the founder made by hand, which beats everything else.
  //    This is how somebody gets in without paying Stripe at all — a partner,
  //    a reviewer, a customer who paid by bank transfer — and it is checked
  //    first so that granting one always works, whatever Stripe thinks.
  const granted = await liveAccount(email);
  if (granted) {
    return {
      name: granted.email,
      until: granted.expires ?? Date.now() + 365 * 24 * 3600000,
      plan: granted.plan,
    };
  }

  // 1. Straight after checkout, by the session the browser came back with.
  //    Stripe's search index lags by up to a minute, so paying and then being
  //    told you have not paid is exactly the moment this avoids.
  if (session) {
    const found = await stripe(`/checkout/sessions/${encodeURIComponent(session)}`, {
      'expand[]': 'subscription',
    });
    const sub = found?.subscription as Record<string, unknown> | undefined;
    const until = sub && typeof sub === 'object' ? liveUntil(sub) : null;
    if (until !== null) {
      return { name: emailOf(found) || email || 'The Culp Mixer subscriber', until };
    }
  }

  // 2. On any later launch, by the install id written into the subscription.
  if (install) {
    const found = await stripe('/subscriptions/search', {
      query: `metadata['install']:'${install}'`,
      limit: '1',
    });
    const sub = (found?.data as Record<string, unknown>[] | undefined)?.[0];
    const until = sub ? liveUntil(sub) : null;
    if (until !== null) return { name: email || 'The Culp Mixer subscriber', until };
  }

  // 3. By email, which is how somebody who already paid unlocks a second
  //    machine, or the same machine after reinstalling it.
  if (email) {
    const customers = await stripe('/customers', { email, limit: '10' });
    for (const customer of (customers?.data as Record<string, unknown>[] | undefined) ?? []) {
      const subs = await stripe('/subscriptions', {
        customer: String(customer.id), status: 'all', limit: '10',
      });
      for (const sub of (subs?.data as Record<string, unknown>[] | undefined) ?? []) {
        const until = liveUntil(sub);
        if (until !== null) return { name: email, until };
      }
    }
  }
  return null;
}

/**
 * How long a failing card keeps working.
 *
 * Stripe puts a subscription into `past_due` the moment a payment fails and
 * leaves it there for the whole retry cycle. If every retry fails and no
 * automatic cancellation is configured, it can sit in `past_due` for ever —
 * so treating `past_due` as simply "live", which is what this used to do,
 * handed somebody whose card was cancelled in March a free product in
 * December, renewed a week at a time, for as long as they kept opening it.
 *
 * Two weeks past the end of the period they actually paid for. Long enough
 * that an expired card, a bank's fraud hold or a holiday does not interrupt
 * somebody's work; short enough that it is a grace period rather than a gift.
 */
const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * When the period Stripe says was paid for ends, or null if it does not say.
 *
 * Returning null rather than a default is the point. This used to answer
 * `now + LEASE_MS` when the field was missing or unparseable, which meant a
 * malformed or unexpected Stripe response granted a week's access — and
 * because every poll asked again, a week each time, indefinitely. A response
 * that does not say what was paid for is not evidence that anything was.
 */
function periodEnd(sub: Record<string, unknown>): number | null {
  const seconds = Number(sub.current_period_end);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Whether this subscription entitles its owner to use The Culp Mixer, right now.
 *
 * Every state Stripe defines is named, deliberately, rather than left to fall
 * through a default. A state nobody has considered must mean "no": the failure
 * that costs a sale is recoverable by signing in again, and the one that gives
 * the product away is not.
 */
function liveUntil(sub: Record<string, unknown>, now = Date.now()): number | null {
  const ends = periodEnd(sub);
  if (ends === null) return null;
  switch (sub.status) {
    // Paid, or inside a Stripe-run trial. Entitled until the period ends.
    case 'active':
    case 'trialing':
      return ends > now ? ends : null;
    // Payment failed and Stripe is retrying. Entitled, but only through the
    // grace window above — not for as long as Stripe happens to keep the
    // subscription in this state.
    case 'past_due':
      return ends + PAST_DUE_GRACE_MS > now ? ends + PAST_DUE_GRACE_MS : null;
    // Retries are over and it was never paid; the customer cancelled; the
    // first payment never completed; the checkout was abandoned; the
    // subscription is deliberately stopped. None of these is entitlement.
    case 'unpaid':
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return null;
    default:
      return null;
  }
}

function emailOf(session: Record<string, unknown> | null): string {
  const details = session?.customer_details as { email?: unknown } | undefined;
  return typeof details?.email === 'string' ? details.email : '';
}

/**
 * Where the trial stands for this install.
 *
 * There are two clocks, and this prefers the better one without ever
 * requiring it.
 *
 * When a persistent store is configured and answering, it keeps the start
 * time, which is the stronger clock because the customer cannot reach it. When
 * there is no store at all, or it is having a bad five minutes, the clock the
 * client keeps stands instead and the trial still starts. That is deliberate:
 * The Culp Mixer requires no database, no dashboard, no account and no setup
 * step, so a brand-new visitor must get their thirty-three hours the moment
 * they open the page — an outage in something optional must never become a
 * paywall in front of somebody who has not even tried the product yet.
 *
 * Somebody determined can clear their browser and take another thirty-three
 * hours. Accepted, and cheaper than the alternative. The line this must never
 * cross is the other one: it grants a TRIAL and only a trial. Paid access is a
 * signed entitlement minted from a real Stripe subscription in the lookup
 * above, which never touches this store, and nothing on this path can forge,
 * substitute or extend one.
 */
async function trialEndsAt(install: string, claimed: number, now: number): Promise<number> {
  const { reached, value } = await kvRead(KEYS.trial(install));
  if (!reached) {
    // No store configured, or it is not answering: the client's clock stands
    // and the trial starts anyway. Never a refusal — see above.
    return (Number.isFinite(claimed) && claimed > 0 && claimed < now ? claimed : now) + TRIAL_MS;
  }

  const started = Number(value);
  if (Number.isFinite(started) && started > 0) return started + TRIAL_MS;

  // First time this install has been seen. A clock the client claims is
  // honoured only when it makes the trial *shorter* — otherwise a wiped
  // browser would be a fresh thirty-three hours, which is the hole this
  // closes.
  const begin = Number.isFinite(claimed) && claimed > 0 && claimed < now ? claimed : now;
  // A write that does not land leaves this install on the client clock, the
  // same as having no store at all. The trial still starts.
  await kvSet(KEYS.trial(install), String(begin));
  return begin + TRIAL_MS;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  // The desktop build is not served from this origin, so it has to be allowed
  // to ask. Nothing here is secret to the caller: the answer is about the
  // caller's own install and is signed, so it cannot be edited into a licence.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as
    Record<string, unknown> | null;
  const action = String(body?.action ?? 'state');
  const install = clean(body?.install, 80);
  const email = clean(body?.email, 200).toLowerCase();
  const session = clean(body?.session, 200);
  const claimed = Number(body?.startedAt);
  const now = Date.now();

  if (!install) {
    res.status(400).json({ error: 'install is required' });
    return;
  }

  try {
    if (action === 'checkout') {
      const { priceId: price, stripeSecretKey } = await settings();
      if (!price || !stripeSecretKey) {
        res.status(503).json({ error: 'not-selling-yet' });
        return;
      }
      const origin = env('CULPMIXER_APP_URL') || originOf(req);
      const params: Record<string, string> = {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        client_reference_id: install,
        'subscription_data[metadata][install]': install,
        success_url: `${origin}/?culpmixer_session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/`,
        allow_promotion_codes: 'true',
      };
      if (email) params.customer_email = email;
      const created = await stripe('/checkout/sessions', params, 'POST');
      const url = created?.url;
      if (typeof url !== 'string') {
        res.status(502).json({ error: 'checkout-failed' });
        return;
      }
      res.status(200).json({ url });
      return;
    }

    if (action === 'signin') {
      // An account the founder made, with the password they were given. This
      // is the whole of "log in": one request, and what comes back is the
      // same signed entitlement everything else returns.
      const password = typeof body?.password === 'string' ? body.password : '';
      // A ceiling on guessing, checked before the password is so that a source
      // over the line costs nothing to turn away.
      const who = callerKey(req.headers);
      if (rateLimited(who)) {
        res.status(429).json({
          error: 'too-many-attempts',
          message: 'Too many failed sign-ins from this address. Wait ten minutes and try again.',
        });
        return;
      }
      const account = await signInAccount(email, password);
      if (!account) {
        recordFailure(who);
        // One answer for every kind of wrong, at the same cost, so this
        // cannot be used to find out which emails have accounts.
        await new Promise((done) => setTimeout(done, 400));
        res.status(401).json({ error: 'wrong-details' });
        return;
      }
      // Right password, trial over, not paid. That is not a failed sign-in and
      // must not be reported as one — but it is emphatically not a key
      // either. signInAccount deliberately stops filtering these out, so the
      // check has to happen here.
      clearFailures(who);
      const where = standing(account, now);
      if (where.state === 'locked') {
        const { paymentLink } = await settings();
        res.status(200).json({
          status: 'locked',
          email: account.email,
          trialEndedAt: where.trialEndedAt,
          paymentLink,
          message: 'Your 33 hours are up. The Culp Mixer is $199/month. One person runs The Culp Mixer, so '
            + 'access is switched on by hand once you have paid.',
        });
        return;
      }
      const expires = Math.min(account.expires ?? now + LEASE_MS, now + LEASE_MS);
      res.status(200).json({
        status: 'active',
        key: mint({
          name: account.email,
          plan: account.plan || 'Subscription',
          seats: 1,
          issued: now,
          expires,
        }),
        expires,
      });
      return;
    }

    // action === 'state'
    const subscription = await findSubscription(install, email, session);
    if (subscription) {
      // A lease, not the subscription's whole length: if they cancel, this is
      // how long before the application notices. A week.
      const expires = Math.min(subscription.until, now + LEASE_MS);
      res.status(200).json({
        status: 'active',
        key: mint({
          name: subscription.name,
          plan: subscription.plan ?? 'Subscription',
          seats: 1,
          issued: now,
          expires,
        }),
        expires,
      });
      return;
    }

    const endsAt = await trialEndsAt(install, claimed, now);
    res.status(200).json(
      now < endsAt
        ? { status: 'trial', endsAt }
        : { status: 'expired', endsAt },
    );
  } catch (error) {
    // "no-signing-key" means somebody deployed this without the key. Saying so
    // is better than quietly handing every visitor a trial for ever.
    const reason = error instanceof Error ? error.message : 'error';
    res.status(500).json({ error: reason });
  }
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function originOf(req: Req): string {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const name = Array.isArray(host) ? host[0] : host;
  return name ? `https://${name}` : 'https://theculpmixer.vercel.app';
}
