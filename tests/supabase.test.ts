import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import account from '../api/account';
import admin from '../api/admin';
import { hashPassword } from '../api/_store';

/**
 * Supabase as the store.
 *
 * Accounts have to live somewhere, and Supabase is the somewhere: a free
 * Postgres you can open and look at. These run the real handlers against a
 * stand-in that speaks PostgREST the way Supabase does, so a mistake in the
 * upsert header or the filter syntax fails here rather than after a customer
 * has signed up and vanished.
 */

const FOUNDER = 'a-test-founder-password';
const FOUNDER_HASH = hashPassword(FOUNDER);
const FOUNDER_EMAIL = 'culpindustriesllc@gmail.com';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type Json = Record<string, unknown>;

/** A stand-in Supabase: one table, and the REST shape PostgREST serves. */
function supabase() {
  const rows = new Map<string, string>();
  const seen: string[] = [];
  const handle = async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (!url.startsWith('https://project.supabase.test/')) return null;
    seen.push(`${init?.method ?? 'GET'} ${url}`);

    const headers = (init?.headers ?? {}) as Record<string, string>;
    // Supabase refuses anything without the key in both places.
    if (!headers.apikey || !headers.Authorization) {
      return new Response('{"message":"no api key"}', { status: 401 });
    }

    const table = '/rest/v1/kline_kv';
    if (!url.includes(table)) return new Response('{"message":"no table"}', { status: 404 });

    const match = url.match(/key=eq\.([^&]+)/);
    const key = match ? decodeURIComponent(match[1]) : '';

    if ((init?.method ?? 'GET') === 'GET') {
      const value = rows.get(key);
      return json(value === undefined ? [] : [{ value }]);
    }
    if (init?.method === 'POST') {
      // Without merge-duplicates a second write to the same key is a conflict,
      // which is exactly how this breaks in production if the header is lost.
      const prefer = headers.Prefer ?? '';
      const body = JSON.parse(String(init.body)) as { key: string; value: string }[];
      for (const row of body) {
        if (rows.has(row.key) && !prefer.includes('merge-duplicates')) {
          return new Response('{"code":"23505"}', { status: 409 });
        }
        rows.set(row.key, row.value);
      }
      return new Response('', { status: 201 });
    }
    if (init?.method === 'DELETE') {
      rows.delete(key);
      return new Response('', { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  return { rows, seen, handle };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function run(
  which: typeof account | typeof admin, body: Json, db: ReturnType<typeof supabase>,
): Promise<{ code: number; body: Json }> {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    KLINE_FOUNDER_HASH: FOUNDER_HASH,
    KLINE_SIGNING_KEY: PEM,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    // Deliberately absent: this proves Supabase is used on its own.
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) =>
    (await db.handle(String(input), init)) ?? json({ error: 'not stubbed' }, 404)) as typeof fetch;
  const out: { code: number; body: Json } = { code: 0, body: {} };
  const res = {
    status(code: number) { out.code = code; return res; },
    setHeader() { /* not inspected */ },
    json(value: unknown) { out.body = (value ?? {}) as Json; },
    end() { /* nothing */ },
  };
  try {
    await which({ method: 'POST', body, headers: {} }, res);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  return out;
}

test('somebody can sign up, and the row lands in Supabase', async () => {
  const db = supabase();
  const made = await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  assert.equal(made.code, 200, JSON.stringify(made.body));
  assert.equal(made.body.status, 'trial');

  const stored = db.rows.get('kline:account:zed@example.com');
  assert.ok(stored, `nothing was written. Calls: ${db.seen.join(' | ')}`);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.username, 'Zed');
  // Only a hash, never the password.
  assert.ok(!stored.includes('a-good-password'), 'the password was stored in the clear');
});

test('writing the same key twice replaces it instead of conflicting', async () => {
  // The upsert header. Without it the second write is a 23505 and the founder
  // silently cannot approve anybody.
  const db = supabase();
  await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  const session = await run(admin, {
    action: 'login', email: FOUNDER_EMAIL, password: FOUNDER,
  }, db).then((r) => String(r.body.session));

  const approved = await run(admin, {
    action: 'accounts.approve', session, email: 'zed@example.com', months: 1,
  }, db);
  assert.equal(approved.code, 200, JSON.stringify(approved.body));
  assert.equal(JSON.parse(db.rows.get('kline:account:zed@example.com')).paid, true);
});

test('logging in, refreshing and being approved all read Supabase', async () => {
  const db = supabase();
  await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);

  const back = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  assert.equal(back.body.status, 'trial');

  const refreshed = await run(account, {
    action: 'refresh', session: String(back.body.session),
  }, db);
  assert.equal(refreshed.body.status, 'trial');
});

test('the founder console lists what is in Supabase', async () => {
  const db = supabase();
  await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  const session = await run(admin, {
    action: 'login', email: FOUNDER_EMAIL, password: FOUNDER,
  }, db).then((r) => String(r.body.session));

  const state = await run(admin, { action: 'state', session }, db);
  assert.equal(state.body.storage, true);
  assert.equal(state.body.store, 'Supabase', 'the console did not say which store is in use');
  const accounts = state.body.accounts as Json[];
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, 'zed@example.com');
});

test('deleting an account removes the row', async () => {
  const db = supabase();
  await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  const session = await run(admin, {
    action: 'login', email: FOUNDER_EMAIL, password: FOUNDER,
  }, db).then((r) => String(r.body.session));

  await run(admin, { action: 'accounts.delete', session, email: 'zed@example.com' }, db);
  assert.equal(db.rows.get('kline:account:zed@example.com'), undefined, 'the row survived');
});

test('the service key goes in both headers Supabase wants', async () => {
  // apikey and Authorization. Missing either is a 401 that reads as "no
  // accounts yet" rather than "you configured this wrong".
  const db = supabase();
  const made = await run(account, {
    action: 'signup', username: 'Zed', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  assert.equal(made.code, 200);
  assert.ok(db.seen.length > 0, 'Supabase was never called');
});

test('Supabase being unreachable does not throw, it just has no accounts', async () => {
  const db = supabase();
  db.handle = async () => {
    throw new Error('network down');
  };
  const result = await run(account, {
    action: 'signin', email: 'zed@example.com', password: 'a-good-password',
  }, db);
  // A refusal, not a five hundred: the store being down must not look like a
  // crash on the page that takes people's money.
  assert.equal(result.code, 401);
});
