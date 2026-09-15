/*
 * The sale, from the founder console to a working application.
 *
 * Everything else tests one half. The server tests call the handlers directly;
 * the app tests stub the server. This runs both for real, in a browser, over
 * HTTP, against the actual built bundle and the actual founder page:
 *
 *   sign in to the console  ->  make an account  ->  read the password it
 *   hands over  ->  open The Culp Mixer past its trial  ->  sign in with that email
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
  // public/ as well as src/: the founder console lives there and is copied at
  // build time, so watching only src meant editing it changed nothing that
  // the tests could see.
  const newest = Math.max(newestMtime(join(ROOT, 'src')), newestMtime(join(ROOT, 'public')));
  if (existsSync(index) && statSync(index).mtimeMs >= newest) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
}

/** Bundle the two handlers so this plain-ESM test can import the TypeScript. */
function buildHandlers() {
  execFileSync('npx', [
    'esbuild', 'api/licence.ts', 'api/admin.ts', 'api/account.ts',
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
  const accounts = (await import(join(BUILD, 'account.js'))).default;

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

    if (url === '/api/licence' || url === '/api/admin' || url === '/api/account') {
      const body = await readBody(req);
      const handler = url === '/api/admin' ? admin : url === '/api/account' ? accounts : licence;
      await handler({ method: req.method, body, headers: req.headers }, adapt(res));
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
  process.env.KLINE_FOUNDER_EMAIL = 'culpindustriesllc@gmail.com';
  process.env.KLINE_SIGNING_KEY = readFileSync(PEM, 'utf8');
  process.env.STRIPE_SECRET_KEY = '';
  process.env.KLINE_PRICE_ID = '';
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';
  process.env.KLINE_PAYMENT_LINK = '';

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
    process.env.KLINE_PAYMENT_LINK = 'https://buy.example.com/The Culp Mixer';
  });

  const carried = {};

  test('1 · the founder console refuses the wrong password', async () => {
    const page = await app.browser.newPage();
    await page.goto(`${app.origin}/founder.html`, { waitUntil: 'networkidle' });
    await page.fill('#founderEmail', 'culpindustriesllc@gmail.com');
    await page.fill('#password', 'not-the-password');
    await page.click('#signIn');
    // "Checking…" goes up first, so wait for whatever replaces it.
    await page.waitForFunction(() => {
      const text = document.querySelector('#gateNote')?.textContent ?? '';
      return text.length > 0 && !text.startsWith('Checking');
    }, { timeout: 8000 });
    const note = await page.textContent('#gateNote');
    assert.match(note, /do not open this console/i, `it said: ${note}`);
    // And the console stayed shut.
    assert.equal(await page.isHidden('#console'), true, 'the console opened anyway');
    await page.close();
  });

  test('2 · the right password opens the console', async () => {
    const page = await app.browser.newPage();
    await page.goto(`${app.origin}/founder.html`, { waitUntil: 'networkidle' });

    // The right password with the wrong address is still refused.
    await page.fill('#founderEmail', 'someone@else.com');
    await page.fill('#password', FOUNDER_PASSWORD);
    await page.click('#signIn');
    await page.waitForFunction(() => {
      const text = document.querySelector('#gateNote')?.textContent ?? '';
      return text.length > 0 && !text.startsWith('Checking');
    }, { timeout: 8000 });
    assert.equal(await page.isHidden('#console'), true, 'the wrong address opened the console');

    await page.fill('#founderEmail', 'culpindustriesllc@gmail.com');
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

  test('4 · a founder-made account logs in on the home page', async () => {
    const page = await app.browser.newContext().then((c) => c.newPage());
    carried.app = page;
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });

    // The front door, not the editor. Nobody gets in without an account.
    await page.waitForSelector('.home:not(.hidden)', { timeout: 8000 });
    await page.click('.home-tabs button:nth-child(2)');

    const fields = await page.$$('.home-field');
    assert.equal(fields.length, 2, 'logging in asked for something other than email and password');
    await fields[0].fill('journey-customer@example.com');
    await fields[1].fill(carried.password);
    await page.click('.home-go');

    // Waiting on the class, not on visibility: .hidden is display:none, so a
    // visibility wait can never resolve.
    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const state = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return {
        status: ed.account?.status,
        canUse: ed.canUse,
        added: ed.scene.objects.size - before,
      };
    });
    // Made by the founder means paid: no trial, straight in.
    assert.equal(state.status, 'paid', `they landed in "${state.status}"`);
    assert.equal(state.canUse, true);
    assert.equal(state.added, 1, 'The Culp Mixer let them in and then refused to work');
  });

  test('5 · the same details work on a second machine', async () => {
    const page = await app.browser.newContext().then((c) => c.newPage());
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const unlocked = await page.evaluate(async ({ email, password }) => {
      const ed = window.kline.editor;
      const result = await ed.logIn(email, password);
      return { ok: result.ok, message: result.message, canUse: ed.canUse };
    }, { email: 'journey-customer@example.com', password: carried.password });
    assert.equal(unlocked.ok, true, `a second machine was refused: ${unlocked.message}`);
    assert.equal(unlocked.canUse, true);
    await page.context().close();
  });

  test('6 · a wrong password is refused, and says so plainly', async () => {
    const page = await app.browser.newContext().then((c) => c.newPage());
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const refused = await page.evaluate(
      async () => window.kline.editor.logIn('journey-customer@example.com', 'definitely-not-it'),
    );
    assert.equal(refused.ok, false, 'a wrong password logged in');
    // Not "could not reach the server": that would send somebody to support
    // over a typo.
    assert.match(refused.message, /do not match/i, `it said: ${refused.message}`);
    await page.context().close();
  });

  test('7 · removing the account in the console takes The Culp Mixer away', async () => {
    const page = carried.page;
    page.once('dialog', (d) => void d.accept());
    const rows = await page.$$('#accounts tr');
    for (const row of rows) {
      if (!(await row.textContent()).includes('journey-customer@example.com')) continue;
      const buttons = await row.$$('button.danger');
      await buttons[buttons.length - 1].click();
      break;
    }
    await page.waitForFunction(
      () => !document.querySelector('#accounts')?.textContent?.includes('journey-customer'),
      { timeout: 5000 },
    );

    const fresh = await app.browser.newContext().then((c) => c.newPage());
    await fresh.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const after = await fresh.evaluate(
      async ({ email, password }) => window.kline.editor.logIn(email, password),
      { email: 'journey-customer@example.com', password: carried.password },
    );
    assert.equal(after.ok, false, 'a removed account still logged in');
    await fresh.context().close();
  });


  // ------------------------------------------------- the customer's own path

  test('9 · somebody signs themselves up on the home page', async () => {
    const page = await app.browser.newContext().then((c) => c.newPage());
    carried.customer = page;
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });

    // The front door is the first thing at the link, before any of the app.
    await page.waitForSelector('.home:not(.hidden)', { timeout: 8000 });
    const front = await page.textContent('.home-card');
    assert.match(front, /33 hours free/i, `the home page did not state the trial: ${front}`);
    assert.ok(front.includes('$199/month'), 'the home page did not state the price');
    assert.match(front, /One person runs The Culp Mixer/i, 'the home page did not say who is behind it');

    const fields = await page.$$('.home-field');
    assert.equal(fields.length, 3, 'sign-up did not ask for a username, email and password');
    await fields[0].fill('Journey Person');
    await fields[1].fill('selfserve@example.com');
    await fields[2].fill('my-own-password');
    await page.click('.home-go');

    // No confirmation step of any kind: the door closes and The Culp Mixer is there.
    // Waiting on the class, not on visibility: .hidden is display:none, so a
    // visibility wait can never resolve.
    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const state = await page.evaluate(() => ({
      status: window.kline.editor.account?.status,
      username: window.kline.editor.account?.username,
      canUse: window.kline.editor.canUse,
    }));
    assert.equal(state.status, 'trial');
    assert.equal(state.username, 'Journey Person');
    assert.equal(state.canUse, true, 'signing up did not actually unlock The Culp Mixer');

    // And the countdown is on screen, not hidden in a menu.
    const chip = await page.textContent('.trial-chip');
    assert.match(chip, /Trial —/, `no countdown in the status bar: ${chip}`);
    assert.ok(chip.includes('$199/month'), `the chip did not say the price: ${chip}`);
    assert.match(chip, /3[23]h/, `the countdown did not start at 33 hours: ${chip}`);
  });

  test('10 · during the 33 hours there is no pay screen at all', async () => {
    const page = carried.customer;
    const added = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return ed.scene.objects.size - before;
    });
    assert.equal(added, 1, 'a signed-up customer in trial could not use The Culp Mixer');

    // The thing that must not happen: being asked for money inside the trial.
    // Checked on a fresh load too, because a reload is where a wrongly-sticky
    // lock screen would come back.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => window.kline?.editor?.account?.status === 'trial',
      { timeout: 10000 },
    );
    const during = await page.evaluate(() => ({
      homeHidden: document.querySelector('.home')?.classList.contains('hidden') ?? false,
      wallHidden: document.querySelector('.licence-panel')?.classList.contains('hidden') ?? true,
      payButtons: document.querySelectorAll('a.home-go, .licence-buy').length,
      canUse: window.kline.editor.canUse,
    }));
    assert.equal(during.homeHidden, true, 'the pay screen showed during the trial');
    assert.equal(during.wallHidden, true, 'the licence wall showed during the trial');
    assert.equal(during.payButtons, 0, 'a pay button was on screen during the trial');
    assert.equal(during.canUse, true, 'The Culp Mixer was locked during the trial');
  });

  test('11 · when the 33 hours are up they meet the payment link', async () => {
    const page = carried.customer;
    // Wind their account's clock past the end, the way time would.
    await fetch(`${app.origin}/kv/get/${encodeURIComponent('kline:account:selfserve@example.com')}`)
      .then((r) => r.json())
      .then(({ result }) => {
        const raw = JSON.parse(result);
        return fetch(`${app.origin}/kv/set/${encodeURIComponent('kline:account:selfserve@example.com')}`, {
          method: 'POST',
          body: JSON.stringify({ ...raw, trialEndsAt: Date.now() - 1000 }),
        });
      });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.home:not(.hidden)', { timeout: 10000 });

    const locked = await page.evaluate(() => ({
      status: window.kline.editor.account?.status,
      text: document.querySelector('.home-card')?.textContent ?? '',
      href: document.querySelector('.home-card a.home-go')?.getAttribute('href') ?? '',
      canUse: window.kline.editor.canUse,
    }));
    assert.equal(locked.status, 'locked');
    assert.equal(locked.canUse, false, 'The Culp Mixer was still usable after the trial ended');
    assert.match(locked.text, /33 hours are up/i);
    assert.ok(locked.text.includes('$199/month'), `no price on the locked screen: ${locked.text}`);
    assert.equal(locked.href, 'https://buy.example.com/The Culp Mixer', 'the pay button led nowhere');
    assert.match(locked.text, /still on your disk, untouched/i);
    assert.match(locked.text, /One person runs The Culp Mixer/i);
  });

  test('12 · the founder sees their countdown run out, and switches them on', async () => {
    const console_ = carried.page;
    await console_.reload({ waitUntil: 'networkidle' });
    // The session survives a reload, so the gate may already be behind us.
    // Signing in again would be a thirty-second wait on a field that is not
    // there.
    if (!(await console_.isHidden('#gate'))) {
      await console_.fill('#founderEmail', 'culpindustriesllc@gmail.com');
      await console_.fill('#password', FOUNDER_PASSWORD);
      await console_.click('#signIn');
    }
    await console_.waitForSelector('#console:not(.hidden)', { timeout: 8000 });

    const before = await console_.textContent('#accounts');
    assert.match(before, /selfserve@example\.com/, 'the founder could not see the signup');
    assert.match(before, /waiting to pay/i, `the console did not show them as locked: ${before}`);

    // The whole payment system: one button, pressed by one person.
    const rows = await console_.$$('#accounts tr');
    let approved = false;
    for (const row of rows) {
      if (!(await row.textContent()).includes('selfserve@example.com')) continue;
      const mark = await row.$('button.primary');
      assert.ok(mark, 'no way to mark them paid');
      await mark.click();
      approved = true;
      break;
    }
    assert.ok(approved, 'never found the account to approve');
    await console_.waitForFunction(
      () => document.querySelector('#accounts')?.textContent?.includes('paid'),
      { timeout: 5000 },
    );
  });

  test('13 · and they are back in, on the same login', async () => {
    const page = carried.customer;
    await page.reload({ waitUntil: 'networkidle' });
    // Waiting on the class, not on visibility: .hidden is display:none, so a
    // visibility wait can never resolve.
    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const state = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return {
        status: ed.account?.status,
        canUse: ed.canUse,
        added: ed.scene.objects.size - before,
      };
    });
    assert.equal(state.status, 'paid', 'being marked paid did not let them back in');
    assert.equal(state.canUse, true);
    assert.equal(state.added, 1, 'The Culp Mixer said they were paid and still refused to work');
  });
}
