/**
 * Accounts that work with no server at all.
 *
 * The Culp Mixer is meant to be sellable by one person, and for a long stretch
 * of that it will be hosted on whatever is cheapest and configured by
 * whoever has ten minutes. A backend that is not answering must not mean
 * nobody can sign up — that is the difference between a product and a
 * repository.
 *
 * So the account layer has two halves. When the account service answers, it
 * is the authority: one clock, one row, one truth across every machine. When
 * it does not, everything still works here, in the browser:
 *
 *   sign up  ->  33 hours  ->  locked  ->  pay  ->  a key unlocks it
 *
 * The honest limits of the local half, written down rather than glossed:
 *
 * - The clock is in this browser. Clearing site data starts it again. The
 *   server half closes that; this half cannot, and pretending otherwise would
 *   be worse than saying so.
 * - An account made here is on this machine. It does not follow somebody to
 *   their laptop until the service is up.
 * - A password kept here is checked here. It is stored only as a PBKDF2 hash,
 *   so it is not readable, but somebody determined and local can edit their
 *   own storage. The thing that actually gates the application after the
 *   trial is a signed key, which they cannot forge.
 *
 * Which is the whole design: the trial is convenience, and the signature is
 * the lock.
 */

const ACCOUNTS_KEY = 'culpmixer.local.accounts';
const CURRENT_KEY = 'culpmixer.local.current';

/** Thirty-three hours. The same number everywhere. */
const TRIAL_MS = 33 * 60 * 60 * 1000;

export interface LocalAccount {
  email: string;
  username: string;
  password: string;
  trialEndsAt: number;
  created: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing. Nothing persists, which the caller cannot fix. */
  }
}

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const unhex = (text: string): Uint8Array =>
  new Uint8Array((text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/**
 * PBKDF2, because it is what a browser has.
 *
 * Not as good as the server's scrypt, and the iteration count is a compromise
 * with somebody's patience on an old laptop. It is here so a password is
 * never sitting in storage in the clear, not because it is the thing holding
 * the gate shut.
 */
/**
 * The bytes of a password, or null if it is one no login form could produce.
 *
 * A trailing NUL byte is absorbed into HMAC's key padding, so PBKDF2 derives
 * the same bits for "secret" and "secret\0" — which would let "secret\0junk"
 * pass as "secret". No typed password contains a NUL, so it is refused here
 * rather than hashed into a value the comparison then treats as equal. The
 * server's scrypt path has the same hole for the same reason and the same fix.
 */
function passwordBytes(password: string): Uint8Array | null {
  const bytes = new TextEncoder().encode(password);
  return bytes.includes(0) ? null : bytes;
}

async function hashPassword(password: string, salt?: Uint8Array): Promise<string | null> {
  const material = passwordBytes(password);
  if (!material) return null;
  const use = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', material as BufferSource, 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: use as BufferSource, iterations: 120000, hash: 'SHA-256' },
    key, 256,
  );
  return `pbkdf2$${hex(use)}$${hex(bits)}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'pbkdf2' || !salt || !expected) return false;
  const again = await hashPassword(password, unhex(salt));
  if (!again) return false;
  // Constant time is not meaningful here — the attacker is already sitting at
  // the machine with the storage open — but comparing whole strings costs
  // nothing.
  return again.split('$')[2] === expected;
}

const accounts = (): Record<string, LocalAccount> => read(ACCOUNTS_KEY) ?? {};

const normalise = (email: string): string => email.trim().toLowerCase();

export function localAccountExists(email: string): boolean {
  return normalise(email) in accounts();
}

export async function localSignUp(
  username: string, email: string, password: string,
): Promise<{ ok: true; account: LocalAccount } | { ok: false; message: string }> {
  const key = normalise(email);
  const all = accounts();
  if (all[key]) {
    return { ok: false, message: 'There is already an account with that email on this machine. Log in instead.' };
  }
  const hashed = await hashPassword(password);
  if (!hashed) {
    return { ok: false, message: 'That password cannot be used. Choose one without control characters.' };
  }
  const now = Date.now();
  const account: LocalAccount = {
    email: key,
    username,
    password: hashed,
    // Counted once, from now. The clock belongs to the account, not to the
    // session — signing out does not buy another thirty-three hours.
    trialEndsAt: now + TRIAL_MS,
    created: now,
  };
  write(ACCOUNTS_KEY, { ...all, [key]: account });
  write(CURRENT_KEY, key);
  return { ok: true, account };
}

export async function localLogIn(
  email: string, password: string,
): Promise<{ ok: true; account: LocalAccount } | { ok: false; message: string }> {
  const account = accounts()[normalise(email)];
  if (!account || !(await passwordMatches(password, account.password))) {
    return { ok: false, message: 'That email and password do not match an account on this machine.' };
  }
  write(CURRENT_KEY, account.email);
  return { ok: true, account };
}

/** Who is signed in here, if anybody. */
export function localCurrent(): LocalAccount | null {
  const key = read<string>(CURRENT_KEY);
  return typeof key === 'string' ? accounts()[key] ?? null : null;
}

export function localSignOut(): void {
  try {
    localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* nothing to do */
  }
}
