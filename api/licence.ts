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
 *   KLINE_SIGNING_KEY   the P-256 private key, PEM, the same one that signs
 *                       keys by hand. Without it this refuses to pretend, and
 *                       says so, rather than handing out unsigned tokens.
 *   STRIPE_SECRET_KEY   a Stripe secret key (sk_live_... or sk_test_...).
 *   KLINE_PRICE_ID      the Stripe price for $199/month (price_...).
 *   KLINE_APP_URL       where to send somebody back to after paying.
 *                       Optional; defaults to the request's own origin.
 *   KV_REST_API_URL     optional. Any Upstash-compatible REST KV. With one,
 *   KV_REST_API_TOKEN   the trial clock lives on the server and clearing the
 *                       browser does not restart it. Without one, the trial
 *                       falls back to the client clock, which is the weaker
 *                       thing but still a trial.
 */

import { createPrivateKey, sign } from 'node:crypto';
import { KEYS, env, kvGet, kvSet, liveAccount, settings, signInAccount, standing } from './_store';

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
  const pem = env('KLINE_SIGNING_KEY');
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
    if (sub && typeof sub === 'object' && isLive(sub)) {
      return { name: emailOf(found) || email || 'The Culp Mixer subscriber', until: periodEnd(sub) };
    }
  }

  // 2. On any later launch, by the install id written into the subscription.
  if (install) {
    const found = await stripe('/subscriptions/search', {
      query: `metadata['install']:'${install}'`,
      limit: '1',
    });
    const sub = (found?.data as Record<string, unknown>[] | undefined)?.[0];
    if (sub && isLive(sub)) return { name: email || 'The Culp Mixer subscriber', until: periodEnd(sub) };
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
        if (isLive(sub)) return { name: email, until: periodEnd(sub) };
      }
    }
  }
  return null;
}

/** Paid up, or inside the window Stripe still calls good. */
function isLive(sub: Record<string, unknown>): boolean {
  return sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
}

function periodEnd(sub: Record<string, unknown>): number {
  const seconds = Number(sub.current_period_end);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now() + LEASE_MS;
}

function emailOf(session: Record<string, unknown> | null): string {
  const details = session?.customer_details as { email?: unknown } | undefined;
  return typeof details?.email === 'string' ? details.email : '';
}

/** Where the trial stands for this install. */
async function trialEndsAt(install: string, claimed: number, now: number): Promise<number> {
  const stored = await kvGet(KEYS.trial(install));
  const started = Number(stored);
  if (Number.isFinite(started) && started > 0) return started + TRIAL_MS;

  // First time this install has been seen. A clock the client claims is
  // honoured only when it makes the trial *shorter* — otherwise a wiped
  // browser would be a fresh thirty-three hours, which is the hole this
  // closes.
  const begin = Number.isFinite(claimed) && claimed > 0 && claimed < now ? claimed : now;
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
      const origin = env('KLINE_APP_URL') || originOf(req);
      const params: Record<string, string> = {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        client_reference_id: install,
        'subscription_data[metadata][install]': install,
        success_url: `${origin}/?kline_session={CHECKOUT_SESSION_ID}`,
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
      const account = await signInAccount(email, password);
      if (!account) {
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
  return name ? `https://${name}` : 'https://kline-flax.vercel.app';
}
