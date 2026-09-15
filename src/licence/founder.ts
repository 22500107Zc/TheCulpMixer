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
  if (!password) return null;
  try {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: bytes(SEALED_OWNER_KEY.salt) as BufferSource,
        iterations: SEALED_OWNER_KEY.iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(SEALED_OWNER_KEY.iv) as BufferSource },
      key,
      bytes(SEALED_OWNER_KEY.data) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
