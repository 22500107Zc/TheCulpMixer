/**
 * The founder console's back end.
 *
 * One login, held by the person who owns The Culp Mixer. From it: make an account for
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
 *   CULPMIXER_FOUNDER_HASH   from `node tools/culpmixer-founder.mjs "<password>"`.
 *                        Without it the console refuses every login rather
 *                        than falling open.
 *   KV_REST_API_URL      the store accounts live in. Without it the console
 *   KV_REST_API_TOKEN    says so instead of pretending to save.
 */

import {
  Account, TRIAL_MS, checkFounder, deleteAccount, findAccount, founderEmail, generatePassword,
  hashPassword, kvConfigured, listAccounts, mintSession, readJson, saveAccount, settings,
  standing, storeName, validSession, writeJson, KEYS, env,
} from './_store.js';

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

/**
 * Accounts as the console sees them: never the password hash.
 *
 * The console has no use for it, and a hash on the wire is a hash somebody
 * can work on offline at their leisure.
 */
async function visibleAccounts(): Promise<unknown[]> {
  const now = Date.now();
  return (await listAccounts()).map((one) => ({
    ...one,
    password: undefined,
    // Worked out here so the console and the application cannot disagree
    // about whether somebody is in their trial, and so the founder sees the
    // same countdown the customer does.
    standing: standing(one, now),
    msLeft: one.paid ? null : Math.max(0, one.trialEndsAt - now),
  }));
}

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

  if (!env('CULPMIXER_FOUNDER_HASH')) {
    // Falling open here would mean anybody who found the URL could issue
    // themselves a licence, so it fails shut and says exactly what is wrong.
    res.status(503).json({
      error: 'no-founder-password',
      detail: 'CULPMIXER_FOUNDER_HASH is not set in this deployment. Run '
        + 'node tools/culpmixer-founder.mjs "<your password>" and paste the line it prints '
        + 'into Vercel, then redeploy.',
    });
    return;
  }

  if (action === 'login') {
    const password = typeof body?.password === 'string' ? body.password : '';
    const email = clean(body?.email, 200);
    if (!checkFounder(email, password)) {
      // Deliberately vague and deliberately slow to be useful: one message for
      // every kind of wrong.
      await new Promise((done) => setTimeout(done, 400));
      res.status(401).json({ error: 'wrong-password' });
      return;
    }
    res.status(200).json({
      session: mintSession(),
      storage: kvConfigured(),
      store: storeName(),
      founder: founderEmail(),
    });
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
      detail: 'This deployment has nowhere to keep accounts. Connect Supabase — set '
        + 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel and make the culpmixer_kv '
        + 'table — then redeploy. SELLING.md has the SQL.',
    });
    return;
  }

  try {
    switch (action) {
      case 'state': {
        const current = await settings();
        res.status(200).json({
          storage: kvConfigured(),
          store: storeName(),
          founder: founderEmail(),
          // Never the secret itself — only whether one is set, and where it
          // came from. A console that echoes a live Stripe key back over the
          // wire is a console that leaks it to anything watching.
          paymentLink: current.paymentLink,
          stripe: {
            configured: !!current.stripeSecretKey,
            fromEnvironment: !!env('STRIPE_SECRET_KEY'),
            mode: current.stripeSecretKey.startsWith('sk_live') ? 'live'
              : current.stripeSecretKey.startsWith('sk_test') ? 'test' : 'unset',
            priceId: current.priceId,
            priceFromEnvironment: !!env('CULPMIXER_PRICE_ID'),
          },
          accounts: kvConfigured() ? await visibleAccounts() : [],
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
        // Their password: whatever was typed, or one made here. Either way it
        // is returned exactly once, in this response, for the founder to send
        // on — and stored only as a hash, so it can never be read back.
        const chosen = clean(body?.password, 200);
        if (chosen && chosen.length < 8) {
          res.status(400).json({ error: 'A password needs at least 8 characters.' });
          return;
        }
        const password = chosen || generatePassword();
        const account: Account = {
          email,
          username: clean(body?.username, 60) || email.split('@')[0],
          plan: clean(body?.plan, 60) || 'Subscription',
          // Made by the founder means paid by definition: this is the button
          // for somebody who has already handed over money, or who is being
          // let in for nothing.
          paid: true,
          expires: forever
            ? null
            : Date.now() + (Number.isFinite(months) && months > 0 ? months : 1) * MONTH_MS,
          trialEndsAt: Date.now() + TRIAL_MS,
          created: Date.now(),
          password: hashPassword(password),
          ...(clean(body?.note, 300) ? { note: clean(body?.note, 300) } : {}),
        };
        await saveAccount(account);
        res.status(200).json({
          account: { ...account, password: undefined },
          // Shown once. Nothing can retrieve it afterwards.
          password,
          accounts: await visibleAccounts(),
        });
        return;
      }

      case 'accounts.resetPassword': {
        const email = clean(body?.email, 200).toLowerCase();
        const existing = await readJson<Account>(KEYS.account(email));
        if (!existing) {
          res.status(404).json({ error: 'No account with that email.' });
          return;
        }
        const password = clean(body?.password, 200) || generatePassword();
        if (password.length < 8) {
          res.status(400).json({ error: 'A password needs at least 8 characters.' });
          return;
        }
        await saveAccount({ ...existing, password: hashPassword(password) });
        res.status(200).json({ password, accounts: await visibleAccounts() });
        return;
      }

      case 'accounts.approve': {
        // The whole payment system, in one button. Somebody paid through
        // whatever link is set, said so, and this is the founder agreeing.
        const wanted = clean(body?.email, 200).toLowerCase();
        const existing = await findAccount(wanted);
        if (!existing) {
          res.status(404).json({ error: 'No account with that email.' });
          return;
        }
        const months = Number(body?.months);
        const forever = body?.forever === true;
        await saveAccount({
          ...existing,
          paid: true,
          plan: clean(body?.plan, 60) || (existing.plan === 'Trial' ? 'Subscription' : existing.plan),
          expires: forever
            ? null
            : Date.now() + (Number.isFinite(months) && months > 0 ? months : 1) * MONTH_MS,
        });
        res.status(200).json({ accounts: await visibleAccounts() });
        return;
      }

      case 'accounts.revoke': {
        // Turned off without being deleted: they keep their login and their
        // history, and are simply back to needing to pay.
        const wanted = clean(body?.email, 200).toLowerCase();
        const existing = await findAccount(wanted);
        if (!existing) {
          res.status(404).json({ error: 'No account with that email.' });
          return;
        }
        await saveAccount({ ...existing, paid: false, expires: null });
        res.status(200).json({ accounts: await visibleAccounts() });
        return;
      }

      case 'accounts.delete': {
        const email = clean(body?.email, 200).toLowerCase();
        await deleteAccount(email);
        res.status(200).json({ accounts: await visibleAccounts() });
        return;
      }

      case 'settings.save': {
        const stored = (await readJson<Record<string, unknown>>(KEYS.settings)) ?? {};
        const secret = clean(body?.stripeSecretKey, 200);
        const priceId = clean(body?.priceId, 100);
        const paymentLink = clean(body?.paymentLink, 500);
        if (paymentLink && !/^https:\/\//.test(paymentLink)) {
          res.status(400).json({
            error: 'The payment link has to be a full https:// address — the one people '
              + 'land on to pay you.',
          });
          return;
        }
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
          ...(paymentLink ? { paymentLink } : {}),
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
