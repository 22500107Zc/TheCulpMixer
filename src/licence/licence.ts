/**
 * Licensing.
 *
 * Three things this must never do, in order of importance:
 *
 * 1. **Lock the owner out of their own application.** The person who holds the
 *    signing key issues themselves a perpetual licence for nothing, and a
 *    build made from source is never gated at all. Nobody has to buy anything
 *    to run the thing they wrote.
 * 2. **Take money.** There is no payment code here and there never should be.
 *    This file checks a signature. Selling happens somewhere else entirely —
 *    any processor, or a bank transfer, or a handshake — and ends with a key
 *    being minted by `tools/culpmixer-licence.mjs`.
 * 3. **Destroy somebody's work.** The trial ends by locking the application,
 *    not by deleting anything. Files already on disk stay on disk, and a key
 *    unlocks everything again immediately.
 *
 * The scheme is an offline signed token: ECDSA P-256 over a JSON payload, the
 * public key baked into the build, the private key held by whoever sells it.
 * No server, no account, no call home — which is both the honest fit for an
 * application whose selling point is that nothing leaves your machine, and the
 * only design where a customer on a plane can still work.
 */

/** What a licence says. */
export interface LicencePayload {
  /** Who it is for, shown in the About box. */
  name: string;
  email?: string;
  /** Free text: "Studio", "Indie", whatever is being sold. */
  plan: string;
  /** How many people it covers. Informational; nothing here counts machines. */
  seats: number;
  /** Issued at, epoch ms. */
  issued: number;
  /**
   * Expires at, epoch ms — or null for a licence that never expires.
   *
   * A subscription is a licence with an expiry, reissued each period. That is
   * the whole of the subscription mechanism, and it means a lapsed customer
   * keeps every file they made and simply stops getting new keys.
   */
  expires: number | null;
  /**
   * The owner's own licence.
   *
   * Perpetual by construction and never counted against anything. This exists
   * so the person who wrote the application can never be charged to use it,
   * and so that fact is written down in the code rather than in a promise.
   */
  owner?: boolean;
}

export type LicenceState =
  | { status: 'owner'; licence: LicencePayload }
  | { status: 'licensed'; licence: LicencePayload }
  | { status: 'expired'; licence: LicencePayload }
  | { status: 'trial'; hoursLeft: number; endsAt: number }
  | { status: 'trial-over'; endsAt: number }
  | { status: 'unsigned'; reason: string }
  /** Built from source. Not a licence state so much as the absence of one. */
  | { status: 'source' };

/** Thirty-three hours, in milliseconds. */
export const TRIAL_MS = 33 * 60 * 60 * 1000;

/** What The Culp Mixer costs, in one place so nothing can quote a different figure. */
export const PRICE = '$199/month';

/** The one sentence, used everywhere the terms are stated. */
export const TERMS = `33-hour free trial. After that ${PRICE} to use The Culp Mixer at all.`;

export const LICENCE_KEY = 'culpmixer.licence';
export const TRIAL_KEY = 'culpmixer.trial.start';

/**
 * The public half of the signing key, as base64 SPKI.
 *
 * Replaced by whoever ships the build, using `tools/culpmixer-licence.mjs keygen`.
 * Empty means no key was ever installed — in which case nothing is gated,
 * because a build that cannot verify anything must not punish the person
 * running it for that.
 */
export const PUBLIC_KEY_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE_pma6h_dx9SqshCzfIOF_Ok2IFKU5-2eHuXUnvGqNfcw-eAhM7903DVTwLWgZ1iOo0IYnopraxnMfky2QtPv0Q';

/**
 * Whether this build was made by running the repository.
 *
 * `import.meta.env.DEV` is Vite's own answer and is true for `npm run dev` and
 * anything not built for production. It is deliberately checked defensively:
 * if the flag cannot be read at all, the answer is "yes, from source", because
 * the failure that costs somebody their own application is the other one.
 */
export function builtFromSource(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env;
    if (!env) return true;
    return env.DEV === true || env.PROD !== true;
  } catch {
    return true;
  }
}

const textEncoder = new TextEncoder();

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode a payload the way the signing tool does, so both sides agree. */
export function encodePayload(payload: LicencePayload): string {
  return bytesToBase64url(textEncoder.encode(JSON.stringify(payload)));
}

/**
 * Check a key and hand back what it says.
 *
 * Returns null for anything that does not verify — a typo, a key for another
 * product, a payload somebody edited. Deliberately not an exception: a bad key
 * is an ordinary thing a person does, not an error condition.
 */
export async function verifyKey(
  key: string, publicKeySpki: string = PUBLIC_KEY_SPKI,
): Promise<LicencePayload | null> {
  if (!key || !publicKeySpki) return null;
  const parts = key.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 2) return null;
  try {
    const crypto = globalThis.crypto?.subtle;
    if (!crypto) return null;
    const spki = base64urlToBytes(publicKeySpki.replace(/-/g, '+').replace(/_/g, '/'));
    const publicKey = await crypto.importKey(
      'spki', spki.slice().buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    // Copied into plain ArrayBuffers: a Uint8Array's buffer may be a
    // SharedArrayBuffer as far as the types are concerned, and WebCrypto will
    // not take one.
    const signature = base64urlToBytes(parts[1]);
    const signed = textEncoder.encode(parts[0]);
    const ok = await crypto.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature.slice().buffer as ArrayBuffer,
      signed.slice().buffer as ArrayBuffer,
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0])));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.name !== 'string' || typeof payload.plan !== 'string') return null;
    return {
      name: payload.name,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      plan: payload.plan,
      seats: Number.isFinite(payload.seats) ? payload.seats : 1,
      issued: Number.isFinite(payload.issued) ? payload.issued : 0,
      expires: Number.isFinite(payload.expires) ? payload.expires : null,
      ...(payload.owner === true ? { owner: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Where the trial clock is kept, tolerating storage that will not answer. */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browsing. The trial then restarts, which is the kind way round. */
  }
}

/** Forget the stored licence. */
export function clearLicence(): void {
  try {
    localStorage.removeItem(LICENCE_KEY);
  } catch {
    /* nothing to do */
  }
}

export function storeLicence(key: string): void {
  writeStorage(LICENCE_KEY, key.trim());
}

export function storedLicence(): string | null {
  return readStorage(LICENCE_KEY);
}

/**
 * When the trial started, starting it if it has not been.
 *
 * A clock that has been wound back is not fought: somebody determined enough
 * to change their system time has already decided not to pay, and every trick
 * for catching them also catches a person whose laptop battery died.
 */
export function trialStart(now = Date.now()): number {
  const stored = Number(readStorage(TRIAL_KEY));
  if (Number.isFinite(stored) && stored > 0) return stored;
  writeStorage(TRIAL_KEY, String(now));
  return now;
}

/** When the trial started, or null if this copy has never started one. */
export function trialStartedAt(): number | null {
  const stored = Number(readStorage(TRIAL_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/**
 * Record when the trial started, as the server said it did.
 *
 * The server's clock is the better one when there is a server with a store
 * behind it, so `activation` writes what it was told. When there is not — no
 * store configured, or it is not answering — nothing calls this and the local
 * clock above stands. That is deliberate: The Culp Mixer requires no database,
 * no dashboard and no account to sign up for, and a brand-new visitor must get
 * their thirty-three hours the moment the page opens, not after a round trip
 * to something that may not exist.
 *
 * Somebody determined can clear browser storage and take another thirty-three
 * hours. That is an accepted cost, not a hole to plug. This path grants a
 * TRIAL and only ever a trial; paid access is a signed entitlement minted from
 * a real payment, and nothing here can forge one.
 */
export function beginTrialAt(started: number): void {
  if (!Number.isFinite(started) || started <= 0) return;
  writeStorage(TRIAL_KEY, String(started));
}

/**
 * Work out where this copy stands.
 *
 * `fromSource` is the escape hatch that matters most: a build made by running
 * the repository is never gated, so the owner and every contributor can always
 * use what they have built without a key existing at all.
 */
export async function licenceState(options: {
  key?: string | null;
  publicKey?: string;
  fromSource?: boolean;
  now?: number;
} = {}): Promise<LicenceState> {
  const now = options.now ?? Date.now();
  const publicKey = options.publicKey ?? PUBLIC_KEY_SPKI;

  // Built from source, or shipped without a signing key at all. Either way
  // there is nothing to enforce and nobody to enforce it against.
  const fromSource = options.fromSource ?? builtFromSource();
  if (fromSource || !publicKey) return { status: 'source' };

  const key = options.key === undefined ? storedLicence() : options.key;
  if (key) {
    const licence = await verifyKey(key, publicKey);
    if (!licence) return { status: 'unsigned', reason: 'That key is not valid for this build.' };
    if (licence.owner) return { status: 'owner', licence };
    if (licence.expires !== null && licence.expires < now) return { status: 'expired', licence };
    return { status: 'licensed', licence };
  }

  const endsAt = trialStart(now) + TRIAL_MS;
  if (now >= endsAt) return { status: 'trial-over', endsAt };
  return { status: 'trial', hoursLeft: Math.ceil((endsAt - now) / 3600000), endsAt };
}

/**
 * Whether The Culp Mixer may be used at all.
 *
 * After the trial the application is locked, not merely restricted: no
 * modelling, no rendering, no export. That is the product decision, and it is
 * one line so it cannot drift apart from what the licence says.
 *
 * Two exemptions survive it, and they are not loopholes — they are the reason
 * the owner can never be locked out of their own application. A build made
 * from source is never gated, and the owner's own key is perpetual.
 */
export function canUse(state: LicenceState): boolean {
  return state.status === 'source'
    || state.status === 'owner'
    || state.status === 'licensed'
    || state.status === 'trial';
}

/**
 * Whether finished work can leave the application.
 *
 * The same answer as `canUse`: after the trial there is nothing to export
 * from, because there is nothing running. Kept as its own name because the
 * command gate reads better for it, and because the two could diverge again if
 * a lighter tier is ever sold.
 */
export const canExport = canUse;

/** One line for the status bar or the About box. */
export function describeLicence(state: LicenceState): string {
  switch (state.status) {
    case 'source':
      return 'Built from source — no licence needed';
    case 'owner':
      return `Owner licence — ${state.licence.name}`;
    case 'licensed':
      return state.licence.expires === null
        ? `Licensed to ${state.licence.name} (${state.licence.plan})`
        : `Licensed to ${state.licence.name} — renews ${new Date(state.licence.expires).toLocaleDateString()}`;
    case 'expired':
      return `The subscription for ${state.licence.name} ended on `
        + `${new Date(state.licence.expires ?? 0).toLocaleDateString()}. `
        + `${PRICE} to continue. Your files are untouched.`;
    case 'trial':
      return `Free trial — ${timeLeft(state.endsAt)} left of 33 hours. Then ${PRICE}.`;
    case 'trial-over':
      return `Your 33-hour free trial has ended. The Culp Mixer is ${PRICE} to keep using.`;
    default:
      return state.reason;
  }
}

/** How much of the trial is left, in words. */
function timeLeft(endsAt: number, now = Date.now()): string {
  const ms = Math.max(0, endsAt - now);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** What to say when The Culp Mixer is locked. Never a dead end. */
export function whyBlocked(state: LicenceState): string {
  if (canUse(state)) return '';
  if (state.status === 'unsigned') {
    return 'The licence key stored on this machine does not verify against this build, so '
      + `The Culp Mixer is locked. Paste the key again, or ask for a new one — it is ${PRICE}. `
      + 'Every file you have made is still on your disk, untouched.';
  }
  if (state.status === 'expired') {
    return `The subscription for ${state.licence.name} has ended, so The Culp Mixer is locked. `
      + `It is ${PRICE} to continue. Every file you have made is still on your disk, `
      + 'untouched, and a new key unlocks everything immediately.';
  }
  return `Your 33-hour free trial has ended, so The Culp Mixer is locked. It is ${PRICE} to keep using it. `
    + 'Every file you have made is still on your disk, untouched, and a licence key unlocks '
    + 'everything immediately.';
}
