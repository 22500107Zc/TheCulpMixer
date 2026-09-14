/*
 * The sale, from the founder console to a working application.
 *
 * Everything else tests one half. The server tests call the handlers directly;
 * the app tests stub the server. This runs both for real, in a browser, over
 * HTTP, against the actual built bundle and the actual founder page:
 *
 *   sign in to the console  ->  make an account  ->  read the password it
 *   hands over  ->  open Kline past its trial  ->  sign in with that email
 *   and password  ->  the wall comes down and the application works.
 *
 * That is the whole of the business, and until this existed no test covered
 * the seams between its pieces — the console posting to the admin handler, the
 * handler signing with the real key, and the application verifying it with the
 * public half baked into the bundle.
 *
 * It needs the real signing key, because the built bundle verifies against the
 * real public one. Without kline-private-key.pem it says so and skips rather
 * than pretending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PEM = join(ROOT, 'kline-private-key.pem');
const BUILD = join(ROOT, '.test-build', 'api');

const FOUNDER_PASSWORD = 'console-test-founder-password';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

function hash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
}

/**
 * Rebuild when the sources are newer than the bundle.
 *
 * Learnt the hard way: this ran against a stale dist and reported a fault that
 * had already been fixed in the working tree. A test that quietly exercises
 * last week's build is worse than no test.
 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuild() {
  const index = join(DIST, 'index.html');
  if (existsSync(index) && statSync(index).mtimeMs >= newestMtime(join(ROOT, 'src'))) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
}

/** Bundle the two handlers so this plain-ESM test can import the TypeScript. */
function buildHandlers() {
  execFileSync('npx', [
    'esbuild', 'api/licence.ts', 'api/admin.ts',
    '--bundle', '--platform=node', '--format=esm', `--outdir=${relative(ROOT, BUILD)}`,
    '--log-level=warning',
  ], { cwd: ROOT, stdio: 'inherit' });
}

/** The raw request body, as text. */
function rawBody(req) {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => done(raw));
  });
}

/** Read a JSON body the way a serverless platform would before handing it on. */
async function readBody(req) {
  try {
    return JSON.parse((await rawBody(req)) || '{}');
  } catch {
    return {};
  }
}

/** The platform's response object, as the handlers expect it. */
function adapt(res) {
  let code = 200;
  return {
    status(next) { code = next; return this; },
    setHeader(name, value) { res.setHeader(name, value); },
    json(body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    end(body) { res.writeHead(code); res.end(body ?? ''); },
  };
}

const app = await (async () => {
  if (!existsSync(PEM)) {
    return { skip: 'kline-private-key.pem is not on this machine' };
  }
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    return { skip: 'playwright-core is not installed' };
  }
  const { chromium } = playwright;
  let executablePath;
  for (const candidate of [process.env.CHROME_PATH, '/opt/pw-browsers/chromium']) {
    if (candidate && existsSync(candidate)) { executablePath = candidate; break; }
  }
  try {
    executablePath ??= chromium.executablePath();
  } catch { /* fall through to the skip below */ }
  if (!executablePath || !existsSync(executablePath)) return { skip: 'no Chromium build was found' };

  ensureBuild();
  buildHandlers();

  const licence = (await import(join(BUILD, 'licence.js'))).default;
  const admin = (await import(join(BUILD, 'admin.js'))).default;

  // An in-memory store speaking the REST shape the handlers expect, so the
  // trial clock and the accounts behave exactly as they will on Vercel.
  const kv = new Map();

  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url.startsWith('/kv/')) {
      const [verb, key] = url.slice(4).split('/').map(decodeURIComponent);
      if (verb === 'get') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: kv.get(key) ?? null }));
        return;
      }
      if (verb === 'set') {
        kv.set(key, await rawBody(req));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
        return;
      }
      if (verb === 'del') {
        kv.delete(key);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 1 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: null }));
      return;
    }

    if (url === '/api/licence' || url === '/api/admin') {
      const body = await readBody(req);
      await (url === '/api/admin' ? admin : licence)(
        { method: req.method, body, headers: req.headers }, adapt(res),
      );
      return;
    }

    const path = join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, ''));
    if (!path.startsWith(DIST) || !existsSync(path) || statSync(path).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });

  const port = await new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok(server.address().port));
  });

  process.env.KLINE_FOUNDER_HASH = hash(FOUNDER_PASSWORD);
  process.env.KLINE_SIGNING_KEY = readFileSync(PEM, 'utf8');
  process.env.STRIPE_SECRET_KEY = '';
  process.env.KLINE_PRICE_ID = '';
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';

  const browser = await chromium.launch({
    executablePath,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const origin = `http://127.0.0.1:${port}`;
  return { browser, server, origin, close: async () => { await browser.close(); server.close(); } };
})();

if (app.skip) {
  test('console to application', { skip: `${app.skip} — the console journey did not run` }, () => {});
} else {
  test.after(() => app.close());

  /**
   * The accounts store needs somewhere to live. Without a KV the console
   * correctly refuses to pretend it saved anything, so this journey runs with
   * one wired to the same server.
   */
  test.before(() => {
    process.env.KV_REST_API_URL = `${app.origin}/kv`;
    process.env.KV_REST_API_TOKEN = 'test-token';
  });

  const carried = {};

  test('1 · the founder console refuses the wrong password', async () => {
    const page = await app.browser.newPage();
    await page.goto(`${app.origin}/founder.html`, { waitUntil: 'networkidle' });
    await page.fill('#password', 'not-the-password');
    await page.click('#signIn');
    // "Checking…" goes up first, so wait for whatever replaces it.
    await page.waitForFunction(() => {
      const text = document.querySelector('#gateNote')?.textContent ?? '';
      return text.length > 0 && !text.startsWith('Checking');
    }, { timeout: 8000 });
    const note = await page.textContent('#gateNote');
    assert.match(note, /not the password/i, `it said: ${note}`);
    // And the console stayed shut.
    assert.equal(await page.isHidden('#console'), true, 'the console opened anyway');
    await page.close();
  });

  test('2 · the right password opens the console', async () => {
    const page = await app.browser.newPage();
    await page.goto(`${app.origin}/founder.html`, { waitUntil: 'networkidle' });
    await page.fill('#password', FOUNDER_PASSWORD);
    await page.click('#signIn');
    await page.waitForSelector('#console:not(.hidden)', { timeout: 5000 });
    carried.page = page;
  });

  test('3 · making an account hands over an email and a password to send', async () => {
    const page = carried.page;
    await page.fill('#email', 'journey-customer@example.com');
    await page.selectOption('#length', '12');
    await page.fill('#plan', 'Studio');
    await page.click('#createAccount');
    await page.waitForSelector('#handout:not(.hidden)', { timeout: 5000 });

    const handout = await page.textContent('#handoutText');
    assert.match(handout, /journey-customer@example\.com/);
    assert.match(handout, /Help > Licence/i, `the handout did not say where to go: ${handout}`);

    const password = handout.match(/Password:\s+(\S+)/)?.[1] ?? '';
    assert.ok(password.length >= 12, `no usable password in the handout: ${handout}`);
    // Nothing a person has to squint at: no l, I, 1, O or 0.
    assert.ok(!/[lI1O0]/.test(password), `the password is hard to read: ${password}`);
    carried.password = password;

    // And they are listed.
    const table = await page.textContent('#accounts');
    assert.match(table, /journey-customer@example\.com/);
  });

  test('4 · past the trial, Kline is locked', async () => {
    const page = await app.browser.newPage();
    carried.app = page;
    // Land as somebody whose thirty-three hours ran out: the server is the
    // authority on that, so the clock is wound back in the store rather than
    // faked in the page.
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const install = await page.evaluate(() => localStorage.getItem('kline.install'));
    assert.ok(install, 'the application never registered an install id');

    await fetch(`${app.origin}/kv/set/${encodeURIComponent(`kline:trial:${install}`)}`, {
      method: 'POST', body: String(Date.now() - 40 * 3600000),
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.licence-wall:not(.hidden)', { timeout: 8000 });
    const wall = await page.textContent('.licence-panel');
    assert.ok(wall.includes('$199/month'), `the wall did not say the price: ${wall}`);
  });

  test('5 · the account signs in, and Kline works again', async () => {
    const page = carried.app;
    await page.fill('.licence-email', 'journey-customer@example.com');
    await page.fill('input[type="password"].licence-email', carried.password);
    await page.click('.licence-signin .btn.primary');

    // The wall comes down of its own accord once the licence verifies.
    await page.waitForFunction(
      () => document.querySelector('.licence-panel')?.classList.contains('hidden')
        || !document.querySelector('.licence-panel')?.classList.contains('licence-wall'),
      { timeout: 10000 },
    );

    const state = await page.evaluate(() => ({
      status: window.kline.editor.licence.status,
      canUse: window.kline.editor.canUse,
      summary: window.kline.editor.licenceSummary,
    }));
    assert.equal(state.canUse, true, `still locked: ${state.summary}`);
    assert.equal(state.status, 'licensed');
    assert.match(state.summary, /journey-customer@example\.com/);

    // And the application actually does something, rather than merely
    // reporting that it could.
    const works = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return ed.scene.objects.size - before;
    });
    assert.equal(works, 1, 'Kline said it was unlocked and still refused to work');
  });

  test('6 · the same details work on a second machine', async () => {
    // A different browser context is a different install id and an empty
    // localStorage: the same thing as their laptop at home.
    const second = await app.browser.newContext();
    const page = await second.newPage();
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });

    const unlocked = await page.evaluate(async ({ email, password }) => {
      const ed = window.kline.editor;
      const result = await ed.signInToKline(email, password);
      return { ok: result.ok, message: result.message, canUse: ed.canUse };
    }, { email: 'journey-customer@example.com', password: carried.password });

    assert.equal(unlocked.ok, true, `a second machine was refused: ${unlocked.message}`);
    assert.equal(unlocked.canUse, true);
    await second.close();
  });

  test('7 · a wrong password is refused in the application too', async () => {
    const third = await app.browser.newContext();
    const page = await third.newPage();
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const refused = await page.evaluate(async () => {
      const ed = window.kline.editor;
      return ed.signInToKline('journey-customer@example.com', 'definitely-not-it');
    });
    assert.equal(refused.ok, false, 'a wrong password signed in');
    assert.match(refused.message, /do not match/i);
    await third.close();
  });

  test('8 · removing the account in the console takes Kline away', async () => {
    const page = carried.page;
    page.once('dialog', (d) => void d.accept());
    await page.click('#accounts button.danger');
    await page.waitForFunction(
      () => !document.querySelector('#accounts')?.textContent?.includes('journey-customer'),
      { timeout: 5000 },
    );

    const fourth = await app.browser.newContext();
    const fresh = await fourth.newPage();
    await fresh.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const after = await fresh.evaluate(async ({ email, password }) => {
      const ed = window.kline.editor;
      return ed.signInToKline(email, password);
    }, { email: 'journey-customer@example.com', password: carried.password });
    assert.equal(after.ok, false, 'a removed account still signed in');
    await fourth.close();
  });
}
