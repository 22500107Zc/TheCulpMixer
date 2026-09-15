import { clearLicence, storeLicence } from './licence';

/**
 * The customer's account, from the application's side.
 *
 * Sign up, log in, and one call on every launch that asks where they stand.
 * That last one is what notices the founder has switched somebody on after
 * they paid, and what notices thirty-three hours have gone by.
 *
 * Nothing here holds a password after the moment it is used. What is kept is
 * a signed session — "remember your login" — and the signed entitlement the
 * application already knew how to verify offline.
 */

const FALLBACK_API = 'https://kline-flax.vercel.app/api/account';
const SESSION_KEY = 'kline.session';
const TIMEOUT_MS = 8000;

/** What the application knows about who is signed in. */
export interface AccountState {
  status: 'trial' | 'paid' | 'locked';
  username: string;
  email: string;
  plan: string;
  /** When the trial runs out, for the countdown. Trial only. */
  trialEndsAt?: number;
  trialEndedAt?: number;
  paidUntil?: number | null;
  /** Where to send them to pay. Locked only. */
  paymentLink?: string;
  message?: string;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browsing: they will have to log in again next time. */
  }
}

export function accountApi(): string {
  const configured = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_KLINE_ACCOUNT_API;
  if (configured) return configured;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return origin.startsWith('http') ? `${origin}/api/account` : FALLBACK_API;
}

export const hasSession = (): boolean => !!read(SESSION_KEY);

export function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to do */
  }
  clearLicence();
}

async function post(
  payload: Record<string, unknown>,
): Promise<{ reached: boolean; ok: boolean; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(accountApi(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      /* Not JSON is the same as nothing here. */
    }
    return { reached: true, ok: response.ok, body };
  } catch {
    return { reached: false, ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a server answer into what the application holds, storing the key. */
function adopt(body: Record<string, unknown>): AccountState | null {
  const status = body.status;
  if (status !== 'trial' && status !== 'paid' && status !== 'locked') return null;
  if (typeof body.session === 'string') write(SESSION_KEY, body.session);

  if (status === 'locked') {
    // The entitlement goes, so the offline check agrees with the server
    // rather than letting a stale key outlive the trial.
    clearLicence();
  } else if (typeof body.key === 'string') {
    storeLicence(body.key);
  }

  return {
    status,
    username: String(body.username ?? ''),
    email: String(body.email ?? ''),
    plan: String(body.plan ?? ''),
    ...(typeof body.trialEndsAt === 'number' ? { trialEndsAt: body.trialEndsAt } : {}),
    ...(typeof body.trialEndedAt === 'number' ? { trialEndedAt: body.trialEndedAt } : {}),
    ...(body.paidUntil === null || typeof body.paidUntil === 'number'
      ? { paidUntil: body.paidUntil as number | null }
      : {}),
    ...(typeof body.paymentLink === 'string' ? { paymentLink: body.paymentLink } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

export type AccountResult =
  | { ok: true; account: AccountState }
  | { ok: false; message: string };

const OFFLINE = 'Could not reach The Culp Mixer just now. Check the connection and try again.';

export async function signUp(
  username: string, email: string, password: string,
): Promise<AccountResult> {
  const { reached, ok, body } = await post({ action: 'signup', username, email, password });
  if (!reached) return { ok: false, message: OFFLINE };
  if (!ok || !body) {
    return { ok: false, message: String(body?.error ?? 'Could not make that account.') };
  }
  const account = adopt(body);
  return account ? { ok: true, account } : { ok: false, message: 'Could not make that account.' };
}

export async function logIn(email: string, password: string): Promise<AccountResult> {
  const { reached, ok, body } = await post({ action: 'signin', email, password });
  if (!reached) return { ok: false, message: OFFLINE };
  if (!ok || !body) {
    return {
      ok: false,
      message: body?.error === 'wrong-details'
        ? 'That email and password do not match an account.'
        : String(body?.error ?? 'Could not log you in.'),
    };
  }
  const account = adopt(body);
  return account ? { ok: true, account } : { ok: false, message: 'Could not log you in.' };
}

/**
 * Where this account stands, asked on every launch.
 *
 * Returns null when there is nobody signed in, or when the server cannot be
 * reached — the caller keeps whatever it already had rather than throwing
 * somebody out over a dropped connection.
 */
export async function refreshAccount(): Promise<{
  reached: boolean;
  account: AccountState | null;
}> {
  // Asked even with no session. A 401 comes back in milliseconds and is the
  // cheapest way to learn the one thing the interface needs to know before it
  // puts a sign-up form in somebody's way: whether there is an account service
  // here at all. A desktop build with no network, or a deployment with no
  // store, must not show a form that can never be completed.
  const session = read(SESSION_KEY) ?? '';
  const { reached, ok, body } = await post({ action: 'refresh', session });
  if (!reached) return { reached: false, account: null };
  if (!ok || !body) {
    if (body?.error === 'sign-in-again') forgetSession();
    // A deployment with no storage cannot hold accounts, so there is nothing
    // to sign up for and the older install-based trial stands.
    return { reached: body?.error !== 'no-storage', account: null };
  }
  return { reached: true, account: adopt(body) };
}
