import { LICENCE_KEY, TRIAL_KEY, TRIAL_MS, clearLicence, storeLicence } from './licence';

/**
 * Turning a link into a paying customer, without anybody touching a key.
 *
 * The whole of selling Kline is meant to be: send somebody the link. They get
 * thirty-three hours. Then the application says $199/month and shows them a
 * button, they pay, and it keeps working — on the web and on the desktop
 * build, on that machine and on their next one.
 *
 * So this talks to `api/licence`, which talks to Stripe. Three things it is
 * careful about, because each one is a way to lose a customer or lock one out:
 *
 * 1. **It never blocks.** Every call is on a timeout, and every failure is
 *    silent. No network means the last answer stands, which is what lets
 *    somebody work on a plane rather than being locked out by an airport.
 * 2. **It never downgrades what is already held.** A verified key on disk
 *    outlives a server that is down, a domain that moved, or a Stripe outage.
 * 3. **It never shows anybody a licence key.** The key exists — it is what the
 *    application has always verified — but it arrives on its own and is stored
 *    on its own, and nobody is ever asked to copy one.
 */

/** Where the server lives. Same origin on the web; the web app for desktop. */
const FALLBACK_API = 'https://kline-flax.vercel.app/api/licence';

/** This installation, so the server can keep one trial clock for it. */
const INSTALL_KEY = 'kline.install';

/** The query parameter Stripe sends people back with after paying. */
const SESSION_PARAM = 'kline_session';

/** Long enough for a cold serverless function, short enough not to be felt. */
const TIMEOUT_MS = 6000;

export interface SyncResult {
  status: 'active' | 'trial' | 'expired' | 'offline';
  endsAt?: number;
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
    /* Private browsing. Everything below still works, just not across visits. */
  }
}

/**
 * A stable id for this copy.
 *
 * Not a fingerprint and not an identity: a random number, kept locally, whose
 * only job is to let the server hold one trial clock per installation instead
 * of one per browser session.
 */
export function installId(): string {
  const existing = read(INSTALL_KEY);
  if (existing && existing.length >= 8) return existing;
  const fresh = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  write(INSTALL_KEY, fresh);
  return fresh;
}

export function licenceApi(): string {
  const configured = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_KLINE_LICENCE_API;
  if (configured) return configured;
  // The web app asks its own origin, so this keeps working if the domain
  // changes. A desktop build has no useful origin and asks the web app.
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return origin.startsWith('http') ? `${origin}/api/licence` : FALLBACK_API;
}

async function post(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(licenceApi(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The session id Stripe hands back after a successful payment.
 *
 * Read once and then wiped from the address bar, so a reload is not a second
 * activation attempt and so nobody is looking at a URL full of machinery.
 */
export function takeCheckoutSession(): string {
  if (typeof location === 'undefined' || !location.search) return '';
  const params = new URLSearchParams(location.search);
  const session = params.get(SESSION_PARAM) ?? '';
  if (!session) return '';
  params.delete(SESSION_PARAM);
  const query = params.toString();
  try {
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch {
    /* Not fatal — worst case the parameter stays in the bar. */
  }
  return session;
}

/**
 * Ask the server where this copy stands, and write down the answer.
 *
 * Returns what happened, mostly so the interface can say something useful.
 * Nothing here throws, and nothing here blocks for longer than the timeout.
 */
export async function syncLicence(options: { email?: string; session?: string } = {}): Promise<SyncResult> {
  const startedAt = Number(read(TRIAL_KEY));
  const answer = await post({
    action: 'state',
    install: installId(),
    ...(options.email ? { email: options.email } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
  });
  if (!answer) return { status: 'offline' };

  if (answer.status === 'active' && typeof answer.key === 'string') {
    storeLicence(answer.key);
    return { status: 'active' };
  }

  const endsAt = Number(answer.endsAt);
  if (!Number.isFinite(endsAt) || endsAt <= 0) return { status: 'offline' };

  // The server owns the trial clock. It is written back in the form the
  // offline check already reads, so there is one notion of "when does this
  // run out" rather than two that can disagree.
  write(TRIAL_KEY, String(endsAt - TRIAL_MS));
  // Anything stored from a lapsed subscription is cleared here rather than
  // left to expire, so the application says "your trial ended" instead of
  // arguing with a stale key.
  if (answer.status === 'expired' && read(LICENCE_KEY)) clearLicence();
  return { status: answer.status === 'expired' ? 'expired' : 'trial', endsAt };
}

/**
 * Start paying.
 *
 * Returns the Stripe page to send them to, or null when this build has not
 * been pointed at a Stripe account yet — in which case the interface says so
 * plainly instead of opening a broken tab.
 */
export async function checkoutUrl(email?: string): Promise<string | null> {
  const answer = await post({
    action: 'checkout',
    install: installId(),
    ...(email ? { email } : {}),
  });
  const url = answer?.url;
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}
