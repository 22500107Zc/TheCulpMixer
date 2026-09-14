/**
 * The founder console's back end.
 *
 * One login, held by the person who owns Kline. From it: make an account for
 * somebody, see who has one, take one away, and set the Stripe details that
 * make the Subscribe button work.
 *
 * Nothing here can be reached without the password. Every action except
 * `login` requires a session that was signed by a successful login, and the
 * password itself is only ever compared against a hash held in Vercel — it is
 * not in this repository and must never be.
 *
 * Configuration:
 *
 *   KLINE_FOUNDER_HASH   from `node tools/kline-founder.mjs "<password>"`.
 *                        Without it the console refuses every login rather
 *                        than falling open.
 *   KV_REST_API_URL      the store accounts live in. Without it the console
 *   KV_REST_API_TOKEN    says so instead of pretending to save.
 */

import {
  Account, checkPassword, deleteAccount, kvConfigured, listAccounts, mintSession, readJson,
  saveAccount, settings, validSession, writeJson, KEYS, env,
} from './_store';

interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(body?: string): void;
}

/** A month, for the default account length. */
const MONTH_MS = 30 * 24 * 3600000;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  // A console is not something to be framed, linked into, or indexed.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as
    Record<string, unknown> | null;
  const action = clean(body?.action, 40);

  if (!env('KLINE_FOUNDER_HASH')) {
    // Falling open here would mean anybody who found the URL could issue
    // themselves a licence, so it fails shut and says exactly what is wrong.
    res.status(503).json({
      error: 'no-founder-password',
      detail: 'KLINE_FOUNDER_HASH is not set in this deployment. Run '
        + 'node tools/kline-founder.mjs "<your password>" and paste the line it prints '
        + 'into Vercel, then redeploy.',
    });
    return;
  }

  if (action === 'login') {
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!checkPassword(password)) {
      // Deliberately vague and deliberately slow to be useful: one message for
      // every kind of wrong.
      await new Promise((done) => setTimeout(done, 400));
      res.status(401).json({ error: 'wrong-password' });
      return;
    }
    res.status(200).json({ session: mintSession(), storage: kvConfigured() });
    return;
  }

  if (!validSession(clean(body?.session, 300))) {
    res.status(401).json({ error: 'sign-in-again' });
    return;
  }

  // ------------------------------------------------------ signed in below

  if (!kvConfigured() && action !== 'state') {
    res.status(503).json({
      error: 'no-storage',
      detail: 'This deployment has no KV store, so accounts cannot be saved. Add one in '
        + 'Vercel under Storage, then redeploy.',
    });
    return;
  }

  try {
    switch (action) {
      case 'state': {
        const current = await settings();
        res.status(200).json({
          storage: kvConfigured(),
          // Never the secret itself — only whether one is set, and where it
          // came from. A console that echoes a live Stripe key back over the
          // wire is a console that leaks it to anything watching.
          stripe: {
            configured: !!current.stripeSecretKey,
            fromEnvironment: !!env('STRIPE_SECRET_KEY'),
            mode: current.stripeSecretKey.startsWith('sk_live') ? 'live'
              : current.stripeSecretKey.startsWith('sk_test') ? 'test' : 'unset',
            priceId: current.priceId,
            priceFromEnvironment: !!env('KLINE_PRICE_ID'),
          },
          accounts: kvConfigured() ? await listAccounts() : [],
        });
        return;
      }

      case 'accounts.create': {
        const email = clean(body?.email, 200).toLowerCase();
        if (!email.includes('@')) {
          res.status(400).json({ error: 'That does not look like an email address.' });
          return;
        }
        const months = Number(body?.months);
        const forever = body?.forever === true;
        const account: Account = {
          email,
          plan: clean(body?.plan, 60) || 'Subscription',
          expires: forever
            ? null
            : Date.now() + (Number.isFinite(months) && months > 0 ? months : 1) * MONTH_MS,
          created: Date.now(),
          ...(clean(body?.note, 300) ? { note: clean(body?.note, 300) } : {}),
        };
        await saveAccount(account);
        res.status(200).json({ account, accounts: await listAccounts() });
        return;
      }

      case 'accounts.delete': {
        const email = clean(body?.email, 200).toLowerCase();
        await deleteAccount(email);
        res.status(200).json({ accounts: await listAccounts() });
        return;
      }

      case 'settings.save': {
        const stored = (await readJson<Record<string, unknown>>(KEYS.settings)) ?? {};
        const secret = clean(body?.stripeSecretKey, 200);
        const priceId = clean(body?.priceId, 100);
        if (secret && !/^sk_(test|live)_/.test(secret)) {
          res.status(400).json({
            error: 'That is not a Stripe secret key. It starts with sk_test_ or sk_live_ and '
              + 'comes from Stripe > Developers > API keys.',
          });
          return;
        }
        if (priceId && !priceId.startsWith('price_')) {
          res.status(400).json({
            error: 'That is not a Stripe price ID. It starts with price_ and comes from the '
              + 'product you made in Stripe.',
          });
          return;
        }
        await writeJson(KEYS.settings, {
          ...stored,
          ...(secret ? { stripeSecretKey: secret } : {}),
          ...(priceId ? { priceId } : {}),
        });
        res.status(200).json({ saved: true });
        return;
      }

      default:
        res.status(400).json({ error: `unknown action: ${action}` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'error' });
  }
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
