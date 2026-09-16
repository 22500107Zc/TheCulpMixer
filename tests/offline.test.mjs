/*
 * Offline use, in a real browser.
 *
 * These are about the service worker, and they run in their own contexts
 * because that is the only way to see what a *fresh* visitor gets: a context
 * that has already been to the site has a warm cache and hides the failure
 * that mattered most — the app opened once, the creator went offline, and the
 * tab would not load at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBare, rebuild } from './app/harness.mjs';

const app = await launchBare();
if (app.skip) {
  test('offline support', { skip: app.skip }, () => {});
} else {
  test.after(() => app.close());
}

/** A fresh context, at the app, with its worker installed and in charge. */
async function freshVisit() {
  const context = await app.browser.newContext();
  const page = await context.newPage();
  await page.goto(app.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.culpmixer, null, { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The precache runs during install, which finishes before `ready` resolves,
  // but the claim that puts this page under the worker can land just after.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  return { context, page };
}

const cacheNames = (page) => page.evaluate(() => caches.keys());

/** Poll until `check` accepts the cache list, or give up and report what it saw. */
async function waitForCaches(page, what, check, timeout = 30000, between = null) {
  const until = Date.now() + timeout;
  let seen = [];
  for (;;) {
    seen = await cacheNames(page);
    if (check(seen)) return seen;
    if (Date.now() > until) throw new Error(`${what} — caches were: ${seen.join(', ')}`);
    if (between) await between();
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Ask the browser to look for a new worker.
 *
 * Asked repeatedly rather than once: a rebuild writes `dist` in place while
 * the test server is reading from it, so an update check that lands in the
 * middle of that can fetch a half-written script, fail to install, and leave
 * nothing waiting. One retry a quarter second later is enough, and a check
 * that finds nothing new costs a conditional request.
 */
const askForUpdate = (page) => page.evaluate(() => navigator.serviceWorker
  .getRegistration()
  .then((reg) => (reg ? reg.update() : undefined))
  .catch(() => undefined));

async function bootsOffline(context, page) {
  await context.setOffline(true);
  try {
    await page.goto(app.origin, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => !!window.culpmixer, null, { timeout: 15000 });
    return true;
  } catch {
    return false;
  } finally {
    await context.setOffline(false);
  }
}

test('the app opens offline after a single visit', { skip: app.skip }, async () => {
  // The case this was failing on. Nothing caches the page load that registers
  // a worker, so a worker that only fills its cache from traffic is still
  // empty when a first visit ends.
  const { context, page } = await freshVisit();
  try {
    const [name] = await cacheNames(page);
    assert.match(name ?? '', /^The Culp Mixer-shell-/, 'no shell cache was written during install');
    const held = await page.evaluate(async (n) => {
      const keys = await (await caches.open(n)).keys();
      return keys.map((r) => new URL(r.url).pathname);
    }, name);
    assert.ok(held.includes('/'), 'the page itself was not precached');
    assert.ok(held.some((p) => p.endsWith('.js')), 'the script was not precached');
    assert.ok(held.some((p) => p.endsWith('.css')), 'the stylesheet was not precached');

    assert.ok(await bootsOffline(context, page), 'the app would not open offline after one visit');
  } finally {
    await context.close();
  }
});

test('the cache is named for the build', { skip: app.skip }, async () => {
  // A constant name means a rebuild writes new files beside the old ones in
  // the same box, and nothing ever clears them.
  const { context, page } = await freshVisit();
  try {
    const [name] = await cacheNames(page);
    assert.match(name, /^The Culp Mixer-shell-[0-9a-f]{8,}$/, `cache name "${name}" is not keyed to a build`);
  } finally {
    await context.close();
  }
});

test('an update clears The Culp Mixer’s old caches and nothing else', { skip: app.skip }, async () => {
  const { context, page } = await freshVisit();
  try {
    const before = (await cacheNames(page))[0];

    // Two caches that are none of this worker's business, and one stale build
    // of its own. The old activate step deleted every key it did not
    // recognise, which on a shared host is somebody else's application.
    await page.evaluate(async () => {
      await caches.open('someone-elses-app-v3');
      await caches.open('The Culp Mixer-large-v1');
      const stale = await caches.open('The Culp Mixer-shell-0000000000000000');
      await stale.put('/stale', new Response('old'));
    });

    rebuild(`update ${Date.now()}`);
    // An update only takes effect for a page that asks for it, so that a
    // running tab is never swapped out from under itself.
    const release = () => page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      await reg.update().catch(() => undefined);
      const waiting = reg.waiting ?? reg.installing;
      if (waiting) waiting.postMessage({ type: 'culpmixer:activate-update' });
    });
    await release();
    const after = await waitForCaches(
      page,
      'the new build never took over',
      (names) => names.some((n) => n.startsWith('The Culp Mixer-shell-') && n !== before
        && n !== 'The Culp Mixer-shell-0000000000000000')
        && !names.includes(before),
      30000,
      release,
    );
    assert.ok(after.includes('someone-elses-app-v3'), 'the update deleted an unrelated cache');
    assert.ok(after.includes('The Culp Mixer-large-v1'),
      'the update threw away the forty megabytes of depth model');
    assert.ok(!after.includes('The Culp Mixer-shell-0000000000000000'),
      `a stale build cache was left behind: ${after.join(', ')}`);
    assert.equal(after.filter((n) => n.startsWith('The Culp Mixer-shell-')).length, 1,
      `shell caches accumulated: ${after.join(', ')}`);

    // And the new build is still usable without a network.
    assert.ok(await bootsOffline(context, page), 'the app would not open offline after an update');
  } finally {
    await context.close();
  }
});

test('a waiting update is offered to the creator, not forced on them', { skip: app.skip }, async () => {
  // The worker holds a new build back on purpose, so there has to be a control
  // that releases it — otherwise the new version sits there until every tab
  // has been closed, and the message handler in the worker is unreachable.
  const { context, page } = await freshVisit();
  try {
    const before = (await cacheNames(page))[0];
    assert.ok(await page.locator('.update-bar.hidden').count() === 1,
      'the update bar was showing before there was an update');

    rebuild(`offered ${Date.now()}`);
    const bar = page.locator('.update-bar:not(.hidden)');
    for (let tries = 0; tries < 12 && await bar.count() === 0; tries++) {
      await askForUpdate(page);
      await new Promise((r) => setTimeout(r, 500));
    }
    await bar.waitFor({ timeout: 20000 });
    assert.match(await page.locator('.update-bar').innerText(), /new version/i);

    // Nothing has changed yet: the old build is still the one in charge.
    assert.deepEqual(
      (await cacheNames(page)).filter((n) => n === before), [before],
      'the update took effect before it was accepted',
    );

    await page.locator('.update-bar .btn.primary').click();
    await page.waitForFunction(() => !!window.culpmixer, null, { timeout: 25000 });
    await waitForCaches(page, 'the reload did not land on the new build',
      (names) => !names.includes(before) && names.some((n) => n.startsWith('The Culp Mixer-shell-')));
  } finally {
    await context.close();
  }
});

test('a clean build is left behind', { skip: app.skip }, () => {
  // The update test builds a marked version; the suite must not leave that
  // sitting in dist for whatever runs next.
  rebuild();
});
