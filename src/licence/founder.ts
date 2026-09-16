/**
 * The founder's way in, with no server.
 *
 * The founder must be able to open their own application with nothing but
 * their email and password — on any machine, on a deployment that is only
 * half configured, with nothing answering at /api. That is not a nicety: a
 * person who cannot get into the thing they built cannot sell it, cannot
 * demonstrate it, and cannot check that it works.
 *
 * A password hash in the bundle would not do it. A hash can only say yes or
 * no, and a yes from code the reader can edit is not a lock — anybody could
 * flip the comparison in the devtools console. So the owner licence key
 * itself is encrypted with the founder password. Typing the password is what
 * *produces* a real, signed key; without it this file holds nothing usable.
 * The lock is still the signature, which nobody can forge.
 *
 * AES-GCM, PBKDF2-SHA256, 310,000 iterations — about as much work as a
 * browser will do without a pause somebody notices.
 *
 * The honest limit, because it matters: this ciphertext ships to everybody
 * who loads the page. The only thing between a determined stranger and the
 * owner key is how hard the password is to guess. A long passphrase holds. A
 * word joined to a date does not — it is worth changing, and
 * `tools/kline-founder-seal.mjs` reseals this with a new one in one command.
 */

export const FOUNDER_EMAIL = 'culpindustriesllc@gmail.com';

/** The owner key, sealed with the founder password. */
export const SEALED_OWNER_KEY = {
  salt: 'DKQ9YAqnH6diCfTz3Ambkg==',
  iv: 'iqhhqwB4oT/O3HmC',
  data: 'Do2BJgQXRuiKqzdKM1G+FR43uOH2bPxyEPiPy3wWe5g6D5Za/KDCTx0kQwHZdNPQgf7Hrci8vX6lXPRRcJbuv1ux75cmg76taGvPTp3rv2oTX1JPowNsk3HIDQMUTGfiEcXUT+XIRFV8bofD1rFU5N4p9/AqsdSViezEwPiyAntDiX+d+89fCUPQpGg1LjHEzayB4zZ9d47RTBqD2jLQW8TD5VnoFMSezkFYB4U1BmRZDw1wqHTiYQ3j2qKW9JHYZO/x7LCdk6cx7GtV7cqGtEub4cIUEuH6Iwl1+oDcLwVK/3csZQ==',
  iterations: 310000,
};

/**
 * The signing key, sealed with the same founder password.
 *
 * Issuing a licence means signing one, and signing needs the private key.
 * That used to mean holding a .pem file and pasting it in before the Issue
 * button would do anything — a file to keep, a file to lose, and a file to go
 * looking for on a phone at the moment somebody wants to pay. Losing it is
 * unrecoverable: the public half is baked into every shipped build, so a
 * replacement keypair invalidates every licence already sold.
 *
 * Signing in as the founder is what makes issuing possible now. No file.
 *
 * The honest limit, and it is a real one: this ciphertext ships to everybody
 * who loads the site. The owner key sealed above only ever unlocked one
 * person's own copy; this one MINTS LICENCES. The password is therefore the
 * whole security of the product and has to be chosen like it — see
 * tools/kline-seal-signing-key.mjs, which re-seals under a new password
 * without changing the keypair, so nothing already issued breaks.
 */
export const SEALED_SIGNING_KEY = {
  salt: 'yWlC8i1R0Ysux2YemAKOrA==',
  iv: 'qOBfwWj1GK7tjQyE',
  data: 'hefSz+9gPcuSYwjNcuQ1/2NuRiSVMxrKildsGxu4Xt1UOJrvKy3lhyE9aUvTYAwkj+7ou5QHQkr2AWY6Fft8n+lzYohmSs0trUaDNzLa/zZ2M6mGpdPR1QZyvl6Kr021brHep60tBsVrtQD2LdQ2GkWWvUi10m44X/PoQy2V7nvMI4p2T9pGeNJzug7hHyp3KYGGZOIUi7L127k12FnHVlvkSi6gejTRoYANGUXcODbIdU+vFcXTiJQU2z5U6hqtx6ShxJLALKufenZ9j4BcBKRBRsJjBZ8DncJ0WtT1wUIpq28GzgMM8onoCcAC9alSIRwO6cvDdFRL2Gyp/tBQdg==',
  iterations: 310000,
};

const bytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** Whether an address is the founder's. Case and spacing do not matter. */
export const isFounderEmail = (email: string): boolean =>
  email.trim().toLowerCase() === FOUNDER_EMAIL;

/**
 * Unseal the owner key with the founder password.
 *
 * Returns null for the wrong password — AES-GCM's tag check fails and throws,
 * which is the whole point: there is no "close enough", and no boolean to
 * flip. Either the password produces the key or nothing comes out.
 */
export async function unsealOwnerKey(password: string): Promise<string | null> {
  return unseal(SEALED_OWNER_KEY, password);
}

/**
 * Unseal the signing key with the founder password.
 *
 * Returns the private key in PEM form, ready to sign licences with, or null
 * for the wrong password. Same guarantee as the owner key: there is no "close
 * enough" and no boolean to flip, because AES-GCM's tag check either produces
 * the plaintext or throws.
 */
export async function unsealSigningKey(password: string): Promise<string | null> {
  const pem = await unseal(SEALED_SIGNING_KEY, password);
  // Shape-checked before it is handed on: a blob that decrypts to something
  // that is not a key would otherwise fail later, at the moment somebody is
  // waiting to be given a licence they have already paid for.
  if (!pem || !pem.includes('PRIVATE KEY')) return null;
  return pem;
}

interface Sealed { salt: string; iv: string; data: string; iterations: number }

async function unseal(blob: Sealed, password: string): Promise<string | null> {
  if (!password) return null;
  // A trailing NUL is absorbed into HMAC's key padding, so PBKDF2 derives the
  // same key for "pw" and "pw\0" — which would let "pw\0junk" unseal what "pw"
  // does. No typed password has a NUL, so refuse it rather than derive a key
  // the ciphertext will then happily open.
  if (new TextEncoder().encode(password).includes(0)) return null;
  try {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: bytes(blob.salt) as BufferSource,
        iterations: blob.iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(blob.iv) as BufferSource },
      key,
      bytes(blob.data) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
