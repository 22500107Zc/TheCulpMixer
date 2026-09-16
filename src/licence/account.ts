import { clearLicence, storeLicence } from './licence';
import { LocalAccount, localCurrent, localLogIn, localSignOut, localSignUp } from './local';

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

const FALLBACK_API = 'https://theculpmixer.vercel.app/api/account';
const SESSION_KEY = 'culpmixer.session';
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
  /** True when this is the owner signed in with the founder login. */
  founder?: boolean;
  /**
   * True when this account lives only in this browser.
   *
   * Said out loud in the interface rather than hidden: it is the difference
   * between an account that follows somebody to their laptop and one that
   * does not, and somebody should know which they have.
   */
  local?: boolean;
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
    .env?.VITE_CULPMIXER_ACCOUNT_API;
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
  localSignOut();
  clearLicence();
}

/** Turn a browser-held account into the state the application renders. */
function fromLocal(account: LocalAccount): AccountState {
  const now = Date.now();
  if (now < account.trialEndsAt) {
    return {
      status: 'trial',
      username: account.username,
      email: account.email,
      plan: 'Trial',
      trialEndsAt: account.trialEndsAt,
      local: true,
    };
  }
  return {
    status: 'locked',
    username: account.username,
    email: account.email,
    plan: 'Trial',
    trialEndedAt: account.trialEndsAt,
    local: true,
    message: 'Your 33 hours are up. The Culp Mixer is $199/month. One person runs it, so '
      + 'access is switched on by hand once you have paid.',
  };
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
    // "Reached" means the account service answered *as itself*, not that some
    // HTTP response came back. A 404 page from a host that has not deployed
    // the functions is not this service, and treating it as one was the whole
    // bug: the front door went up because something replied, and nothing
    // behind that door could ever succeed. Locked out of your own
    // application by a hosting setting is the wrong way round.
    return { reached: body !== null, ok: response.ok, body };
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
    ...(body.founder === true ? { founder: true } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

export type AccountResult =
  | { ok: true; account: AccountState }
  | { ok: false; message: string };

/**
 * Turn a failed answer into a sentence that says what is actually wrong.
 *
 * The generic "could not log you in" was worse than useless: it was shown for
 * a wrong password, for a server that had not been deployed yet, and for a
 * database that was not connected — three completely different problems, one
 * of which is the person's fault and two of which are ours. Somebody staring
 * at it has no idea whether to retype their password or go and fix Vercel.
 */
function explain(body: Record<string, unknown> | null): string {
  const error = typeof body?.error === 'string' ? body.error : '';
  if (error === 'wrong-details') return 'That email and password do not match an account.';
  if (error === 'no-storage') {
    return 'The Culp Mixer is not finished being set up: it has nowhere to keep accounts yet. '
      + 'Nobody can sign up until Supabase is connected.';
  }
  if (error === 'no-signing-key') {
    return 'The Culp Mixer is not finished being set up: the signing key is missing, so no '
      + 'account can be issued.';
  }
  if (typeof body?.detail === 'string') return body.detail;
  if (error) return error;
  // No JSON came back at all. Nearly always the API is not deployed and a
  // stock 404 page arrived instead.
  return 'The account service is not answering. If you have just deployed, it may still be '
    + 'building; if this is a fresh setup, /api/account is not live yet.';
}

export async function signUp(
  username: string, email: string, password: string,
): Promise<AccountResult> {
  const { reached, ok, body } = await post({ action: 'signup', username, email, password });
  // No account service here. Rather than telling somebody to come back when
  // the hosting is sorted out, the account is made in this browser and the
  // thirty-three hours start now. They can work, and the lock at the end is
  // the same lock.
  if (!reached) {
    const made = await localSignUp(username, email, password);
    return made.ok
      ? { ok: true, account: fromLocal(made.account) }
      : { ok: false, message: made.message };
  }
  if (!ok || !body) return { ok: false, message: explain(body) };
  const account = adopt(body);
  return account ? { ok: true, account } : { ok: false, message: 'Could not make that account.' };
}

export async function logIn(email: string, password: string): Promise<AccountResult> {
  const { reached, ok, body } = await post({ action: 'signin', email, password });
  if (!reached) {
    const back = await localLogIn(email, password);
    return back.ok
      ? { ok: true, account: fromLocal(back.account) }
      : { ok: false, message: back.message };
  }
  if (!ok || !body) return { ok: false, message: explain(body) };
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
  if (!reached) {
    // No service. Whoever is signed in here still is, and their clock keeps
    // running — including past the end of it.
    const here = localCurrent();
    return { reached: false, account: here ? fromLocal(here) : null };
  }
  if (!ok || !body) {
    if (body?.error === 'sign-in-again') forgetSession();
    // A deployment with no storage cannot hold accounts, so there is nothing
    // to sign up for and the older install-based trial stands.
    return { reached: body?.error !== 'no-storage', account: null };
  }
  return { reached: true, account: adopt(body) };
}
