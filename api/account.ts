/**
 * Signing up, signing in, and finding out where you stand.
 *
 * The shape of the business, in one file:
 *
 *   Somebody makes an account with a username, an email and a password. No
 *   confirmation email, no verification link — they are asked to remember
 *   their login and that is the whole of it. From that moment they have
 *   thirty-three hours, counted from sign-up and shown to them as it runs
 *   down. When it runs out, Kline locks and offers them the link to pay.
 *
 *   They pay. The founder sees it, opens the console, and turns their account
 *   on. There is no payment API here on purpose: one person runs Kline, and
 *   approving somebody by hand is a thing one person can actually do.
 *
 *   If they paid from a different address than they signed up with, the
 *   founder gives access to the address that paid. One account covers a whole
 *   team, so that is a feature rather than a problem.
 *
 * Configuration: KLINE_SIGNING_KEY, plus a KV store. Nothing else is required
 * — in particular no Stripe key, because nothing here talks to Stripe.
 */

import { createPrivateKey, sign } from 'node:crypto';
import {
  Account, TRIAL_MS, env, findAccount, hashPassword, kvConfigured, mintAccountSession,
  readAccountSession, saveAccount, settings, signInAccount, standing,
} from './_store';

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

/** How long an entitlement is good for without asking again. */
const LEASE_MS = 7 * 24 * 60 * 60 * 1000;

const base64url = (b: Buffer | Uint8Array): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint the two-part key the application verifies offline. */
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

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * What to tell the application about an account.
 *
 * One shape for every answer, so the application has one thing to render and
 * the countdown cannot disagree with the lock.
 */
async function describe(account: Account, now: number): Promise<Record<string, unknown>> {
  const where = standing(account, now);
  const who = {
    username: account.username,
    email: account.email,
    plan: account.plan,
  };

  if (where.state === 'locked') {
    const { paymentLink } = await settings();
    return {
      status: 'locked',
      ...who,
      trialEndedAt: where.trialEndedAt,
      paymentLink,
      // Said here rather than only in the interface, so it is the same
      // sentence wherever somebody meets it.
      message: 'Your 33 hours are up. Kline is $199/month. One person runs Kline, '
        + 'so access is switched on by hand once you have paid — usually quickly.',
    };
  }

  const until = where.state === 'paid'
    ? (where.until ?? now + LEASE_MS)
    : where.endsAt;
  const expires = Math.min(until, now + LEASE_MS);
  return {
    status: where.state === 'paid' ? 'paid' : 'trial',
    ...who,
    ...(where.state === 'trial' ? { trialEndsAt: where.endsAt } : { paidUntil: where.until }),
    key: mint({
      name: account.username || account.email,
      plan: account.plan || (where.state === 'paid' ? 'Subscription' : 'Trial'),
      seats: 0,
      issued: now,
      expires,
    }),
    expires,
  };
}

export default async function handler(req: Req, res: Res): Promise<void> {
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
  const action = clean(body?.action, 40);
  const email = clean(body?.email, 200).toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';
  const now = Date.now();

  if (!kvConfigured()) {
    res.status(503).json({
      error: 'no-storage',
      detail: 'Kline cannot take accounts until a KV store is connected in Vercel.',
    });
    return;
  }

  try {
    switch (action) {
      case 'signup': {
        const username = clean(body?.username, 60);
        if (username.length < 2) {
          res.status(400).json({ error: 'Pick a username — two characters or more.' });
          return;
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          res.status(400).json({ error: 'That does not look like an email address.' });
          return;
        }
        if (password.length < 8) {
          res.status(400).json({ error: 'Your password needs at least 8 characters.' });
          return;
        }
        if (await findAccount(email)) {
          // Said plainly. Hiding it would only stop somebody signing in.
          res.status(409).json({
            error: 'There is already an account with that email. Log in instead.',
          });
          return;
        }
        const account: Account = {
          email,
          username,
          plan: 'Trial',
          expires: null,
          paid: false,
          // Counted from now, once. Signing out, clearing the browser or
          // moving to another machine does not buy a second thirty-three
          // hours, because the clock belongs to the account.
          trialEndsAt: now + TRIAL_MS,
          created: now,
          password: hashPassword(password),
        };
        await saveAccount(account);
        res.status(200).json({
          session: mintAccountSession(email),
          ...(await describe(account, now)),
        });
        return;
      }

      case 'signin': {
        const account = await signInAccount(email, password);
        if (!account) {
          // One answer at one cost for every kind of wrong, so this cannot be
          // used to find out which email addresses have accounts.
          await new Promise((done) => setTimeout(done, 400));
          res.status(401).json({ error: 'wrong-details' });
          return;
        }
        res.status(200).json({
          session: mintAccountSession(email),
          ...(await describe(account, now)),
        });
        return;
      }

      case 'refresh': {
        // Every launch, with the session rather than the password. This is
        // what notices that the founder has switched somebody on, and what
        // notices that a trial has run out.
        const who = readAccountSession(clean(body?.session, 500));
        if (!who) {
          res.status(401).json({ error: 'sign-in-again' });
          return;
        }
        const account = await findAccount(who);
        if (!account) {
          res.status(401).json({ error: 'sign-in-again' });
          return;
        }
        res.status(200).json(await describe(account, now));
        return;
      }

      default:
        res.status(400).json({ error: `unknown action: ${action}` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'error' });
  }
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
