/**
 * The bits the licence server and the founder console both need.
 *
 * Storage is an Upstash-compatible REST KV — the one Vercel provisions from
 * its Storage tab. Everything here degrades rather than throws when it is not
 * configured, because a missing KV should mean "no founder accounts yet", not
 * a five hundred on the page that takes people's money.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const env = (name: string): string =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name] ?? '';

/** Keys, kept in one place so the console and the server cannot disagree. */
export const KEYS = {
  trial: (install: string) => `kline:trial:${install}`,
  account: (email: string) => `kline:account:${email.trim().toLowerCase()}`,
  accountList: 'kline:accounts',
  settings: 'kline:settings',
};

/** Thirty-three hours. The one number the whole business runs on. */
export const TRIAL_MS = 33 * 60 * 60 * 1000;

export interface Account {
  email: string;
  /** What they called themselves when they signed up. */
  username: string;
  /** Free text — "Founder", "Studio", whoever they are. */
  plan: string;
  /**
   * Paid through, epoch ms — or null for access that never runs out.
   *
   * Only meaningful when `paid` is true. The Culp Mixer is approved by hand, so this
   * is whatever the founder decided, not something a card reader set.
   */
  expires: number | null;
  /**
   * Whether the founder has let them in.
   *
   * There is no payment API here on purpose. Somebody pays through whatever
   * link is set, tells the founder, and the founder turns this on. One person
   * runs The Culp Mixer; this is what that looks like in the data.
   */
  paid: boolean;
  /** When their thirty-three hours run out. Set once, at sign-up. */
  trialEndsAt: number;
  created: number;
  note?: string;
  /**
   * Their password, hashed the same way the founder's is.
   *
   * Never the password itself. The founder sees it once, when the account is
   * made, to send it on; after that nobody can read it back — not the
   * console, not the server, not whoever gets into the store.
   */
  password?: string;
}

/** What the founder has configured. */
export interface Settings {
  /**
   * Where somebody is sent to pay.
   *
   * A plain link — a Stripe payment link, a Buy Me a Coffee page, a PayPal
   * button, anything. No API key, no webhook, no integration: the application
   * opens it, they pay, and the founder marks the account paid by hand.
   */
  paymentLink?: string;
  stripeSecretKey?: string;
  priceId?: string;
}

/**
 * Where accounts live.
 *
 * Two backends, picked by whichever is configured. Supabase is the one to
 * use — its free tier is generous, it is a real database you can open and look
 * at, and setting it up is a table and two environment variables. The
 * Upstash-shaped one stays because it costs nothing to keep and some
 * deployments already have it.
 *
 * Everything here degrades rather than throws when nothing is configured: a
 * missing store means "no accounts yet", not a five hundred on the page that
 * takes people's money.
 */
const supabaseUrl = (): string => env('SUPABASE_URL').replace(/\/+$/, '');
const supabaseKey = (): string =>
  env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_KEY') || env('SUPABASE_KEY');

/** The table the rows live in. Created once, by the SQL in SELLING.md. */
const TABLE = env('SUPABASE_TABLE') || 'kline_kv';

const supabaseConfigured = (): boolean => !!supabaseUrl() && !!supabaseKey();
const upstashConfigured = (): boolean => !!env('KV_REST_API_URL') && !!env('KV_REST_API_TOKEN');

export const kvConfigured = (): boolean => supabaseConfigured() || upstashConfigured();

/** Which store is in use, for the console to show. */
export const storeName = (): string =>
  supabaseConfigured() ? 'Supabase' : upstashConfigured() ? 'Upstash' : '';

function supabaseHeaders(): Record<string, string> {
  const key = supabaseKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseGet(key: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${supabaseUrl()}/rest/v1/${TABLE}?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: supabaseHeaders() },
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as { value?: unknown }[];
    const value = rows?.[0]?.value;
    return value == null ? null : String(value);
  } catch {
    return null;
  }
}

async function supabaseSet(key: string, value: string): Promise<boolean> {
  try {
    // merge-duplicates makes this an upsert on the primary key, so a second
    // write to the same key replaces it rather than failing.
    const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ key, value }]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function supabaseDel(key: string): Promise<void> {
  try {
    await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?key=eq.${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: supabaseHeaders(),
    });
  } catch {
    /* Nothing to do: a delete that did not happen leaves the row, not a crash. */
  }
}

async function upstash(path: string, body?: string): Promise<unknown> {
  const url = env('KV_REST_API_URL');
  const token = env('KV_REST_API_TOKEN');
  if (!url || !token) return null;
  try {
    const response = await fetch(`${url}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: unknown };
    return json.result ?? null;
  } catch {
    return null;
  }
}

export async function kvGet(key: string): Promise<string | null> {
  if (supabaseConfigured()) return supabaseGet(key);
  const result = await upstash(`get/${encodeURIComponent(key)}`);
  return result == null ? null : String(result);
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  if (supabaseConfigured()) return supabaseSet(key, value);
  // The value goes in the body rather than the path: an email or a secret in
  // a URL ends up in every proxy log between here and the store.
  return (await upstash(`set/${encodeURIComponent(key)}`, value)) != null;
}

export async function kvDel(key: string): Promise<void> {
  if (supabaseConfigured()) {
    await supabaseDel(key);
    return;
  }
  await upstash(`del/${encodeURIComponent(key)}`);
}

export async function readJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const writeJson = (key: string, value: unknown): Promise<boolean> =>
  kvSet(key, JSON.stringify(value));

/** Every account the founder has made, newest first. */
export async function listAccounts(): Promise<Account[]> {
  const emails = (await readJson<string[]>(KEYS.accountList)) ?? [];
  const accounts: Account[] = [];
  for (const email of emails) {
    const account = await readJson<Account>(KEYS.account(email));
    if (account) accounts.push(account);
  }
  return accounts.sort((a, b) => b.created - a.created);
}

export async function saveAccount(account: Account): Promise<void> {
  const email = account.email.trim().toLowerCase();
  await writeJson(KEYS.account(email), { ...account, email });
  const emails = (await readJson<string[]>(KEYS.accountList)) ?? [];
  if (!emails.includes(email)) await writeJson(KEYS.accountList, [...emails, email]);
}

export async function deleteAccount(email: string): Promise<void> {
  const wanted = email.trim().toLowerCase();
  await kvDel(KEYS.account(wanted));
  const emails = (await readJson<string[]>(KEYS.accountList)) ?? [];
  await writeJson(KEYS.accountList, emails.filter((one) => one !== wanted));
}

/** An account that exists and is allowed in right now — paid, or in trial. */
export async function liveAccount(email: string): Promise<Account | null> {
  if (!email) return null;
  const account = await readJson<Account>(KEYS.account(email));
  if (!account) return null;
  return standing(account).state === 'locked' ? null : account;
}

/**
 * Stripe details, environment first.
 *
 * An environment variable beats anything typed into the console, so a value
 * set in Vercel cannot be silently overridden by whoever is logged in.
 */
export async function settings(): Promise<Required<Settings>> {
  const stored = (await readJson<Settings>(KEYS.settings)) ?? {};
  return {
    paymentLink: env('KLINE_PAYMENT_LINK') || stored.paymentLink || '',
    stripeSecretKey: env('STRIPE_SECRET_KEY') || stored.stripeSecretKey || '',
    priceId: env('KLINE_PRICE_ID') || stored.priceId || '',
  };
}

/** Where an account stands, in one place so nothing can answer differently. */
export type AccountStanding =
  | { state: 'paid'; until: number | null }
  | { state: 'trial'; endsAt: number }
  | { state: 'locked'; trialEndedAt: number };

export function standing(account: Account, now = Date.now()): AccountStanding {
  if (account.paid && (account.expires === null || account.expires > now)) {
    return { state: 'paid', until: account.expires };
  }
  if (now < account.trialEndsAt) return { state: 'trial', endsAt: account.trialEndsAt };
  return { state: 'locked', trialEndedAt: account.trialEndsAt };
}

/** Any account with this email, expired or not. The founder sees everything. */
export const findAccount = (email: string): Promise<Account | null> =>
  readJson<Account>(KEYS.account(email));

// ------------------------------------------------------------ the founder

/**
 * Somebody signing in.
 *
 * Deliberately returns the account even when it is locked: being past the
 * trial is not a failed sign-in, it is a signed-in person who has to pay. The
 * caller decides what that means, and the difference matters — telling
 * somebody their password is wrong when it is right would be a support email
 * and a lost customer.
 */
export async function signInAccount(email: string, password: string): Promise<Account | null> {
  if (!email || !password) return null;
  const account = await findAccount(email);
  if (!account?.password) return null;
  return verifyHash(password, account.password) ? account : null;
}

/**
 * A password somebody can actually type, for an account the founder makes.
 *
 * No l, I, 1, O or 0: this gets read off a screen and typed into another
 * machine, and a password that turns into a support email is not a feature.
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3 || i === 7 || i === 11) out += '-';
  }
  return out;
}

/**
 * The founder password, as a hash.
 *
 * Never the password itself, and never a literal in this repository. A
 * password in source is a password every reader of the repository has, and
 * this repository has been public. `tools/kline-founder.mjs` prints the value
 * to paste into Vercel.
 *
 * Format: scrypt$<salt hex>$<hash hex>
 */
export function checkPassword(password: string): boolean {
  return verifyHash(password, env('KLINE_FOUNDER_HASH'));
}

/**
 * The one address that can open the console.
 *
 * Not a secret — it is the address on the licence and the one customers write
 * to — so it has a default rather than being another thing to configure. It
 * is a second thing to get right on the way in, not a second password.
 */
export const founderEmail = (): string =>
  (env('KLINE_FOUNDER_EMAIL') || 'culpindustriesllc@gmail.com').trim().toLowerCase();

/** Both halves of the founder login, checked at one cost. */
export function checkFounder(email: string, password: string): boolean {
  const wanted = founderEmail();
  const given = String(email ?? '').trim().toLowerCase();
  // The password is checked either way, so a wrong address does not come back
  // faster than a wrong password and give away which half was wrong.
  const passwordOk = checkPassword(password);
  return given === wanted && passwordOk;
}

/**
 * A NUL byte truncates a string password inside the scrypt binding, so
 * "secret\0anything" hashes identically to "secret". That turns one password
 * into an infinite family that all verify, which is not a thing a password
 * check may allow. No legitimate password contains a NUL — it cannot be typed
 * into a login form — so the honest move is to refuse it outright, in both the
 * making and the checking of a hash, rather than to hash something the
 * comparison will then treat as a different string than was stored.
 */
function passwordBytes(password: string): Buffer | null {
  if (!password) return null;
  const bytes = Buffer.from(password, 'utf8');
  if (bytes.includes(0)) return null;
  return bytes;
}

/** Compare a password against a stored scrypt hash, in constant time. */
export function verifyHash(password: string, stored: string): boolean {
  if (!stored) return false;
  const bytes = passwordBytes(password);
  if (!bytes) return false;
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  try {
    const actual = scryptSync(bytes, Buffer.from(salt, 'hex'), 32);
    const wanted = Buffer.from(expected, 'hex');
    // Length-checked first: timingSafeEqual throws on a mismatch, and a throw
    // here would be a slower answer for a wrong-length password.
    return wanted.length === actual.length && timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}

/** Make a hash to store. Used by the tool, and by the tests. */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const bytes = passwordBytes(password);
  if (!bytes) throw new Error('A password cannot contain a NUL byte.');
  return `scrypt$${salt.toString('hex')}$${scryptSync(bytes, salt, 32).toString('hex')}`;
}

/**
 * A session, signed so the console can prove it logged in without sending the
 * password again on every request.
 *
 * Signed with a secret derived from the stored hash: no extra environment
 * variable to set, and changing the password invalidates every session.
 */
function sessionSecret(): string {
  return `The Culp Mixer-console:${founderEmail()}:${env('KLINE_FOUNDER_HASH')}`;
}

/**
 * A customer's session, so the application does not hold their password.
 *
 * Signed with the signing key, which every deployment already has. Long-lived
 * on purpose: this is "remember your login", and somebody who signed up on
 * Tuesday should not be asked again on Wednesday.
 */
export function mintAccountSession(email: string, days = 180): string {
  const expires = Date.now() + days * 24 * 3600000;
  const body = `${Buffer.from(email).toString('base64url')}.${expires}`;
  return `${body}.${createHmac('sha256', accountSecret()).update(body).digest('hex')}`;
}

/** The email behind a session, or empty when it does not check out. */
export function readAccountSession(token: string): string {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return '';
  const [encoded, expires, signature] = parts;
  if (!(Number(expires) > Date.now())) return '';
  const wanted = createHmac('sha256', accountSecret()).update(`${encoded}.${expires}`).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(wanted, 'hex'))) return '';
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function accountSecret(): string {
  return `The Culp Mixer-account:${env('KLINE_SIGNING_KEY')}`;
}

export function mintSession(hours = 12): string {
  const expires = Date.now() + hours * 3600000;
  const signature = createHmac('sha256', sessionSecret()).update(String(expires)).digest('hex');
  return `${expires}.${signature}`;
}

export function validSession(token: string): boolean {
  if (!env('KLINE_FOUNDER_HASH')) return false;
  const [expires, signature] = String(token ?? '').split('.');
  if (!expires || !signature) return false;
  if (!(Number(expires) > Date.now())) return false;
  const wanted = createHmac('sha256', sessionSecret()).update(expires).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(wanted, 'hex'));
  } catch {
    return false;
  }
}
