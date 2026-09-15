/**
 * Issuing a licence key, in the browser, with no server of any kind.
 *
 * This is the piece that makes the business run today rather than after a
 * deployment is finished. The rest of selling The Culp Mixer already works
 * with nothing configured: somebody signs up, gets thirty-three hours, and is
 * shown how to pay. What did not work was the step after the money arrives —
 * turning a paying customer on. That needed the account service, which needed
 * a signing key on the host, a database, and environment variables, and until
 * all three were set up a customer could pay and still not get in.
 *
 * So the founder signs keys here instead. Same private key, same signature,
 * same verification against the public key built into every copy — just done
 * on the founder's own machine, from the running application, and emailed to
 * the customer as a line of text.
 *
 * Where the private key lives, and why not in the bundle
 * -----------------------------------------------------
 * The founder pastes it once and it is kept in this browser's localStorage,
 * on the founder's machine only. It is deliberately NOT sealed into the
 * application the way the owner's own licence is.
 *
 * That difference matters. The owner licence is one key that unlocks one
 * copy; if its ciphertext were ever broken the damage is bounded by what one
 * licence is worth. The *signing* key mints unlimited licences for everybody
 * forever. Shipping that to every visitor encrypted with a password somebody
 * might guess would put the whole product behind one passphrase, and a
 * passphrase is not a thing to bet a business on when there is a better
 * option sitting right there: never ship it at all.
 *
 * So it never leaves the founder's machine, and no customer ever receives it.
 */

import { LicencePayload, encodePayload } from './licence';

const SIGNING_KEY_STORE = 'kline.signing.key';

const bytesToBase64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Strip the PEM armour and decode the body to DER. */
function pemToDer(pem: string): Uint8Array | null {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  if (!body) return null;
  try {
    const binary = atob(body);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Load the signing key, if this machine has been given one.
 *
 * Returns null rather than throwing: not having one is the ordinary state of
 * every machine that is not the founder's.
 */
export function storedSigningKey(): string | null {
  try {
    return localStorage.getItem(SIGNING_KEY_STORE);
  } catch {
    return null;
  }
}

export function hasSigningKey(): boolean {
  return !!storedSigningKey();
}

export function forgetSigningKey(): void {
  try {
    localStorage.removeItem(SIGNING_KEY_STORE);
  } catch {
    /* Private browsing. There was nothing to remove. */
  }
}

/**
 * Import a PEM into something the browser can sign with.
 *
 * Also the validity check: a key that will not import is a key that would
 * have failed silently at the worst moment, so it is rejected now, while
 * somebody is looking at the screen.
 */
async function importSigningKey(pem: string): Promise<CryptoKey | null> {
  const der = pemToDer(pem);
  if (!der) return null;
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch {
    return null;
  }
}

/**
 * Remember the signing key on this machine, after proving it works.
 *
 * Proving means actually signing something and checking the shape of what
 * comes out. A key that imports but produces the wrong signature length is a
 * key for a different curve, and that would mint keys nothing could verify.
 */
export async function rememberSigningKey(
  pem: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = await importSigningKey(pem);
  if (!key) {
    return {
      ok: false,
      message: 'That is not a P-256 private key. Paste the whole file, including the '
        + 'BEGIN and END lines.',
    };
  }
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode('probe'),
  );
  if (signature.byteLength !== 64) {
    return { ok: false, message: 'That key is the wrong curve — keys it signs would not verify.' };
  }
  try {
    localStorage.setItem(SIGNING_KEY_STORE, pem.trim());
  } catch {
    return {
      ok: false,
      message: 'This browser will not keep the key — private browsing, most likely. '
        + 'Keys can still be issued in this session.',
    };
  }
  return { ok: true };
}

export interface IssueRequest {
  /** Who it is for. Shown to them in the About box. */
  name: string;
  email: string;
  /** How long, in months. Null issues a licence that never expires. */
  months: number | null;
  plan?: string;
  seats?: number;
}

/**
 * Sign a licence key.
 *
 * WebCrypto produces the raw r||s signature the verifier expects — the same
 * thing Node has to be told to make with dsaEncoding: 'ieee-p1363', since it
 * would otherwise write DER. Getting that wrong is the classic way to mint
 * keys that look right and verify nowhere, so it is worth naming.
 */
export async function issueKey(
  request: IssueRequest, pem: string | null = storedSigningKey(),
): Promise<{ ok: true; key: string; payload: LicencePayload } | { ok: false; message: string }> {
  if (!pem) {
    return { ok: false, message: 'No signing key on this machine. Add one first.' };
  }
  const email = request.email.trim();
  if (!email.includes('@')) return { ok: false, message: 'That is not an email address.' };

  const key = await importSigningKey(pem);
  if (!key) return { ok: false, message: 'The stored signing key will not load. Add it again.' };

  const now = Date.now();
  const payload: LicencePayload = {
    name: request.name.trim() || email.split('@')[0],
    email,
    plan: request.plan?.trim() || 'Subscription',
    // One account covers a whole team, which is the thing being sold. Nothing
    // here counts machines, so this is a statement rather than a limit.
    seats: request.seats ?? 0,
    issued: now,
    expires: request.months === null
      ? null
      : new Date(new Date(now).setMonth(new Date(now).getMonth() + request.months)).getTime(),
  };

  const body = encodePayload(payload);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body),
  );
  return { ok: true, key: `${body}.${bytesToBase64url(new Uint8Array(signature))}`, payload };
}

/** The message to send them, so nothing has to be written out by hand. */
export function handoutFor(payload: LicencePayload, key: string, url: string): string {
  const until = payload.expires === null
    ? 'It does not expire.'
    : `It runs until ${new Date(payload.expires).toLocaleDateString()}, and I will send you `
      + 'a new one each month.';
  return [
    'Your licence for The Culp Mixer.',
    '',
    `  Open:   ${url}`,
    '  Then:   open "Have a licence key?" on the first screen, paste the key below,',
    '          and press Apply key.',
    '',
    '  Key:',
    `  ${key}`,
    '',
    until,
    'One key covers your whole team.',
    '',
    '— Zach, The Culp Mixer',
  ].join('\n');
}
