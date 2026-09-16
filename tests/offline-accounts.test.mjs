/*
 * Signing up with no server at all.
 *
 * The situation this exists for is not hypothetical: the application was
 * deployed to a host that served the page and not the functions, and the
 * result was a sign-up form that could never be completed — a product nobody
 * could buy, including the person who wrote it.
 *
 * So the account layer falls back to the browser. This drives the real built
 * bundle in Chromium against a server that answers 404 for /api/* — exactly
 * what a half-configured host does — and walks the whole thing: sign up, work,
 * run out of time, meet the way to pay, and unlock with a key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PEM = join(ROOT, 'kline-private-key.pem');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const app = await (async () => {
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
  } catch { /* fall through */ }
  if (!executablePath || !existsSync(executablePath)) return { skip: 'no Chromium build was found' };

  const index = join(DIST, 'index.html');
  const newest = Math.max(newestMtime(join(ROOT, 'src')), newestMtime(join(ROOT, 'public')));
  if (!existsSync(index) || statSync(index).mtimeMs < newest) {
    execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
  }

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    // The whole point: a host that serves the page and not the functions.
    // A stock HTML 404, which is what they actually send.
    if (url.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>404</title><h1>Not Found</h1>');
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
  const browser = await chromium.launch({
    executablePath,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  return {
    browser, origin: `http://127.0.0.1:${port}`,
    close: async () => { await browser.close(); server.close(); },
  };
})();

if (app.skip) {
  test('offline accounts', { skip: `${app.skip} — the offline journey did not run` }, () => {});
} else {
  test.after(() => app.close());
  const carried = {};

  test('1 · the front door is there even though the API is not', async () => {
    const page = await app.browser.newContext().then((c) => c.newPage());
    carried.page = page;
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.home:not(.hidden)', { timeout: 10000 });
    const text = await page.textContent('.home-card');
    assert.match(text, /33 hours free/i);
    assert.ok(text.includes('$199/month'));
  });

  test('2 · somebody signs up, with nothing behind the page but a 404', async () => {
    const page = carried.page;
    const fields = await page.$$('.home-field');
    assert.equal(fields.length, 3, 'sign-up did not ask for three things');
    await fields[0].fill('Offline Person');
    await fields[1].fill('offline@example.com');
    await fields[2].fill('a-good-password');
    await page.click('.home-go');

    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const state = await page.evaluate(() => ({
      status: window.kline.editor.account?.status,
      local: window.kline.editor.account?.local,
      canUse: window.kline.editor.canUse,
    }));
    assert.equal(state.status, 'trial', 'signing up did not start a trial');
    assert.equal(state.local, true, 'it did not say the account is on this machine');
    assert.equal(state.canUse, true, 'signing up did not unlock the application');
  });

  test('3 · the application works, and the countdown is on screen', async () => {
    const page = carried.page;
    const added = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return ed.scene.objects.size - before;
    });
    assert.equal(added, 1, 'a signed-up person could not use it');
    const chip = await page.textContent('.trial-chip');
    assert.match(chip, /Trial —/);
    assert.match(chip, /3[23]h/, `the countdown did not start at 33 hours: ${chip}`);
  });

  test('4 · logging back in works, and a wrong password does not', async () => {
    const page = carried.page;
    const results = await page.evaluate(async () => {
      const ed = window.kline.editor;
      ed.signOutOfKline();
      const wrong = await ed.logIn('offline@example.com', 'not-it');
      const right = await ed.logIn('offline@example.com', 'a-good-password');
      return { wrong, right, canUse: ed.canUse };
    });
    assert.equal(results.wrong.ok, false, 'a wrong password logged in');
    assert.match(results.wrong.message, /do not match/i);
    assert.equal(results.right.ok, true, `the right password failed: ${results.right.message}`);
    assert.equal(results.canUse, true);
  });

  test('5 · the same email cannot sign up twice', async () => {
    const again = await carried.page.evaluate(
      async () => window.kline.editor.createAccount('Someone', 'offline@example.com', 'another-one'),
    );
    assert.equal(again.ok, false);
    assert.match(again.message, /already an account/i);
  });

  test('6 · when the 33 hours are up, it locks and offers a way to pay', async () => {
    const page = carried.page;
    // Wind the account's own clock back, the way time would.
    await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('kline.local.accounts'));
      all['offline@example.com'].trialEndsAt = Date.now() - 1000;
      localStorage.setItem('kline.local.accounts', JSON.stringify(all));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.home:not(.hidden)', { timeout: 10000 });

    const locked = await page.evaluate(() => ({
      status: window.kline.editor.account?.status,
      canUse: window.kline.editor.canUse,
      text: document.querySelector('.home-card')?.textContent ?? '',
      href: document.querySelector('.home-card a.home-go')?.getAttribute('href') ?? '',
    }));
    assert.equal(locked.status, 'locked');
    assert.equal(locked.canUse, false, 'it was still usable after the trial ended');
    assert.match(locked.text, /33 hours are up/i);
    assert.ok(locked.text.includes('$199/month'));
    // With no payment link configured there is still a way to buy it: the one
    // address behind the product.
    assert.match(locked.href, /^mailto:culpindustriesllc@gmail\.com/,
      `no way to pay on the locked screen: "${locked.href}"`);
  });

  test('7 · a licence key unlocks it, with no server involved', async () => {
    if (!existsSync(PEM)) return; // the key lives with the owner, not in CI
    const { createPrivateKey, sign } = await import('node:crypto');
    const b64u = (b) => Buffer.from(b).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = {
      name: 'offline@example.com', plan: 'Subscription', seats: 1,
      issued: Date.now(), expires: Date.now() + 30 * 24 * 3600000,
    };
    const body = b64u(Buffer.from(JSON.stringify(payload)));
    const signature = sign('sha256', Buffer.from(body), {
      key: createPrivateKey(readFileSync(PEM, 'utf8')),
      dsaEncoding: 'ieee-p1363',
    });
    const key = `${body}.${b64u(signature)}`;

    const page = carried.page;
    await page.click('.home-advanced summary');
    await page.fill('.home-key', key);
    await page.click('.home-key-apply');

    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const works = await page.evaluate(() => {
      const ed = window.kline.editor;
      const before = ed.scene.objects.size;
      window.kline.run('add.cube');
      return { added: ed.scene.objects.size - before, canUse: ed.canUse };
    });
    assert.equal(works.canUse, true, 'a valid key did not unlock it');
    assert.equal(works.added, 1, 'it said unlocked and still refused to work');
  });

  test('8 · the founder logs in with their email and password, no server', async () => {
    // The whole point of this one. The person who owns The Culp Mixer must be
    // able to open it with the two things they know, on a deployment where
    // nothing is answering at /api. Being locked out of your own product by a
    // hosting setting is the failure this prevents.
    const page = await app.browser.newContext().then((c) => c.newPage());
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.home:not(.hidden)', { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const wrong = await ed.logIn('culpindustriesllc@gmail.com', 'not-the-password');
      const right = await ed.logIn('culpindustriesllc@gmail.com', 'founder10082004');
      return {
        wrong: wrong.ok,
        right: right.ok,
        founder: ed.account?.founder,
        status: ed.account?.status,
        licence: ed.licence.status,
        canUse: ed.canUse,
      };
    });

    assert.equal(result.wrong, false, 'a wrong founder password got in');
    assert.equal(result.right, true, 'the founder could not log in');
    assert.equal(result.founder, true, 'they were not marked as the founder');
    assert.equal(result.status, 'paid');
    // And what they hold is a real signed owner licence, not a flag somebody
    // could flip in the console.
    assert.equal(result.licence, 'owner', `they hold a "${result.licence}" licence`);
    assert.equal(result.canUse, true);

    // The front door is gone and the console is one button away.
    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 5000 },
    );
    const chip = await page.textContent('.founder-chip');
    assert.match(chip, /Founder console/i, 'no way through to the console');

    // It survives a reload, because the key is stored and verified offline.
    await page.reload({ waitUntil: 'networkidle' });
    const after = await page.evaluate(() => ({
      canUse: window.kline.editor.canUse,
      licence: window.kline.editor.licence.status,
      home: document.querySelector('.home')?.classList.contains('hidden'),
    }));
    assert.equal(after.canUse, true, 'the founder was locked out by a reload');
    assert.equal(after.licence, 'owner');
    assert.equal(after.home, true, 'the front door came back after a reload');
    await page.context().close();
  });

  test('9 · the sealed key is useless without the password', async () => {
    // The ciphertext ships to everybody. What must not be possible is getting
    // a key out of it without knowing the password.
    const page = await app.browser.newContext().then((c) => c.newPage());
    await page.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    const attempts = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const tried = [];
      for (const guess of ['', 'password', 'founder', 'Founder10082004', 'founder1008200']) {
        const r = await ed.logIn('culpindustriesllc@gmail.com', guess);
        tried.push({ guess, ok: r.ok, licence: ed.licence.status });
      }
      return tried;
    });
    for (const attempt of attempts) {
      assert.equal(attempt.ok, false, `"${attempt.guess}" unsealed the owner key`);
      assert.notEqual(attempt.licence, 'owner', `"${attempt.guess}" produced an owner licence`);
    }
    await page.context().close();
  });

  test('10 · the Founder tab is hidden from customers and reachable by the owner', async () => {
    // It used to be a third tab on the first screen every customer sees.
    // Whatever it does, what it SAYS to somebody deciding whether to pay is
    // that they are looking at one person's back office. So: still its own
    // named way in, still not a customer login that happens to accept the
    // owner — but only for the person who asked for it by address.
    const plain = await app.browser.newContext().then((c) => c.newPage());
    await plain.goto(`${app.origin}/`, { waitUntil: 'networkidle' });
    await plain.waitForSelector('.home:not(.hidden)', { timeout: 10000 });
    const customerTabs = await plain.$$eval('.home-tab', (els) => els.map((e) => e.textContent));
    await plain.context().close();
    assert.deepEqual(customerTabs, ['Create an account', 'Log in'],
      `a paying stranger is shown: ${customerTabs.join(', ')}`);

    const page = await app.browser.newContext().then((c) => c.newPage());
    await page.goto(`${app.origin}/?founder`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.home:not(.hidden)', { timeout: 10000 });

    const tabs = await page.$$eval('.home-tab', (els) => els.map((e) => e.textContent));
    assert.deepEqual(tabs, ['Create an account', 'Log in', 'Founder'],
      `the tabs are: ${tabs.join(', ')}`);

    await page.click('.home-tab:nth-child(3)');
    // The address is filled in already — there is only one that opens it.
    const prefilled = await page.inputValue('.home-field[type="email"]');
    assert.equal(prefilled, 'culpindustriesllc@gmail.com', 'the founder email was not filled in');

    const label = await page.textContent('.home-go');
    assert.match(label, /founder/i, `the button says "${label}"`);

    await page.fill('.home-field[type="password"]', 'founder10082004');
    await page.click('.home-go');

    await page.waitForFunction(
      () => document.querySelector('.home')?.classList.contains('hidden'),
      { timeout: 10000 },
    );
    const state = await page.evaluate(() => ({
      founder: window.kline.editor.account?.founder,
      licence: window.kline.editor.licence.status,
      canUse: window.kline.editor.canUse,
    }));
    assert.equal(state.founder, true, 'the Founder tab did not sign in the founder');
    assert.equal(state.licence, 'owner', `they hold a "${state.licence}" licence`);
    assert.equal(state.canUse, true);
    await page.context().close();
  });
}
