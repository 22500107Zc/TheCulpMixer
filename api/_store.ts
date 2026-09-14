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

export interface Account {
  email: string;
  /** Free text — "Founder", "Studio", whoever they are. */
  plan: string;
  /** Epoch ms, or null for an account that never expires. */
  expires: number | null;
  created: number;
  note?: string;
}

/** Stripe details, when they are set from the console rather than the env. */
export interface Settings {
  stripeSecretKey?: string;
  priceId?: string;
}

export const kvConfigured = (): boolean => !!env('KV_REST_API_URL') && !!env('KV_REST_API_TOKEN');

async function kv(path: string, body?: string): Promise<unknown> {
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
  const result = await kv(`get/${encodeURIComponent(key)}`);
  return result == null ? null : String(result);
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  // The value goes in the body rather than the path: an email or a secret in
  // a URL ends up in every proxy log between here and the store.
  return (await kv(`set/${encodeURIComponent(key)}`, value)) != null;
}

export async function kvDel(key: string): Promise<void> {
  await kv(`del/${encodeURIComponent(key)}`);
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

/** An account that exists and has not run out. */
export async function liveAccount(email: string): Promise<Account | null> {
  if (!email) return null;
  const account = await readJson<Account>(KEYS.account(email));
  if (!account) return null;
  if (account.expires !== null && account.expires < Date.now()) return null;
  return account;
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
    stripeSecretKey: env('STRIPE_SECRET_KEY') || stored.stripeSecretKey || '',
    priceId: env('KLINE_PRICE_ID') || stored.priceId || '',
  };
}

// ------------------------------------------------------------ the founder

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
  const stored = env('KLINE_FOUNDER_HASH');
  if (!stored || !password) return false;
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  try {
    const actual = scryptSync(password, Buffer.from(salt, 'hex'), 32);
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
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
}

/**
 * A session, signed so the console can prove it logged in without sending the
 * password again on every request.
 *
 * Signed with a secret derived from the stored hash: no extra environment
 * variable to set, and changing the password invalidates every session.
 */
function sessionSecret(): string {
  return `kline-console:${env('KLINE_FOUNDER_HASH')}`;
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
