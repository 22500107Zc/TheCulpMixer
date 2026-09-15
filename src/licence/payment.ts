/**
 * Where people pay, and how that reaches them.
 *
 * When somebody's thirty-three hours run out they get one screen with one
 * button on it, and that button has to go somewhere. The link behind it is the
 * founder's to choose — Stripe, PayPal, an invoice page, anything that takes
 * money — and changing it must not mean editing code.
 *
 * There is one honest constraint to design around: a browser cannot publish a
 * value to other browsers. Whatever the founder types has to be served from
 * somewhere before a customer's copy can read it. So the link is looked for in
 * three places, most authoritative first, and the founder's own machine is
 * deliberately last:
 *
 *   1. The account service, if it is answering. It reads KLINE_PAYMENT_LINK,
 *      an environment variable and nothing more — no database involved — so
 *      this works on a deployment with one variable set and nothing else.
 *   2. /pay.json, a plain file served next to the application. No functions,
 *      no store, nothing to configure; it is edited in the repository and is
 *      live on the next deploy. This is the path that works when there is no
 *      backend at all.
 *   3. This browser's own storage, which is where the founder settings panel
 *      writes. It is what makes the field take effect the moment it is typed,
 *      so the lock screen can be looked at before it is ever shown to anybody.
 *      It reaches nobody else, which is exactly why it is last.
 *
 * With none of them set the lock screen still works: it falls back to a
 * mailto, which is a real way for one person to sell something.
 */

const LOCAL_KEY = 'kline.payment.link';

/** Only http(s) and mailto. A link on the lock screen is a link people click. */
export function safePaymentLink(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return url.href;
    }
    // Anything else — javascript:, data: — is refused rather than sanitised.
    // There is no version of those that belongs on a payment button.
    return null;
  } catch {
    return null;
  }
}

/** What the founder set on this machine, if anything. */
export function localPaymentLink(): string | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? safePaymentLink(raw) : null;
  } catch {
    return null;
  }
}

export function setLocalPaymentLink(value: string): { ok: true; link: string | null } | { ok: false; message: string } {
  const text = value.trim();
  if (!text) {
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch { /* nothing to remove */ }
    return { ok: true, link: null };
  }
  const link = safePaymentLink(text);
  if (!link) {
    return {
      ok: false,
      message: 'That is not a link people can pay through. It should start with https://',
    };
  }
  try {
    localStorage.setItem(LOCAL_KEY, link);
  } catch {
    return { ok: false, message: 'This browser will not keep it — private browsing, most likely.' };
  }
  return { ok: true, link };
}

/**
 * The link published to everybody, from the static file.
 *
 * Fetched once and remembered. A missing file is the ordinary case on a fresh
 * deployment and is not an error — it just means nothing has been published
 * yet, and the caller falls through to the next source.
 */
let published: string | null | undefined;

export async function publishedPaymentLink(): Promise<string | null> {
  if (published !== undefined) return published;
  try {
    const response = await fetch('./pay.json', { cache: 'no-store' });
    if (!response.ok) { published = null; return null; }
    const body = await response.json() as { paymentLink?: unknown };
    published = typeof body.paymentLink === 'string' ? safePaymentLink(body.paymentLink) : null;
  } catch {
    // Offline, or the file is not there. Neither is worth a message.
    published = null;
  }
  return published;
}

/**
 * The link to put on the lock screen, from whichever source has one.
 *
 * `fromService` is what the account service said, which outranks everything
 * because it is the one source that is the same for every customer and can be
 * changed without a deploy.
 */
export async function resolvePaymentLink(fromService?: string | null): Promise<string | null> {
  const served = fromService ? safePaymentLink(fromService) : null;
  if (served) return served;
  return (await publishedPaymentLink()) ?? localPaymentLink();
}

/** Only for tests: forget what was fetched. */
export function forgetPublishedPaymentLink(): void {
  published = undefined;
}
