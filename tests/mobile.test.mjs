/**
 * The application on a phone.
 *
 * Everything here was broken at once, and none of it was visible from a
 * desktop run — the suite was green while the product was unusable on the
 * device most people would first open it on:
 *
 * - Turning the view needed the middle mouse button or Option+drag. A phone
 *   has neither, so navModeForPress returned null for every touch and the 3D
 *   view could not be orbited, panned or zoomed at all.
 * - The closed panel drawer sat off the right edge and still counted toward
 *   the page width, making the document 690px wide on a 390px screen. The
 *   browser zoomed out to fit and every control came back shrunken.
 * - Nine menu labels, a mode switch and eight view toggles shared one 34px
 *   row. The menu bar was squeezed to zero width and the mode switch was
 *   painted on top of all nine labels, so File, Add, Object, Mesh, Rig and
 *   Select took no taps: there was no way to add an object on a phone.
 *
 * A second pass found the half that navigation had been hiding:
 *
 * - Move, Rotate and Scale could not be done at all. A modal operator is
 *   driven by hover on a desktop — press G, move the mouse with no button
 *   held, click to commit — and a finger cannot hover. The touch arrived as
 *   button 0 with a modal open, which confirmed it instantly at zero
 *   distance: the tool began and ended in the same event.
 * - Sculpting never started. beginStroke sat below the touch branch in
 *   pointerdown and was simply never reached, so a finger orbited the view
 *   over a mesh it could not mark.
 * - There was no way to cancel. Confirm and cancel were Enter and Esc, and a
 *   phone has neither, so every operator was one-way.
 * - Vertices were nearly unhittable. The pick radius was 14px — a 28px
 *   target, against the 44px every touch platform asks for — under a
 *   fingertip that covers what it is aiming at.
 *
 * These are asserted against a real touch context rather than a narrow desktop
 * window, because `hasTouch` is what decides whether any of it is reachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp } from './app/harness.mjs';

const app = await launchApp();

if (app.skip) {
  test('mobile tests', { skip: `${app.skip} — the browser suite did not run` }, () => {});
} else {
  const browser = app.page.context().browser();

  /** A phone: real touch input, real phone width. */
  async function phone() {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(app.page.url(), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.kline?.editor?.renderer, null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    // Past the front door, and with the panels that overlay the viewport out
    // of the way, so what is measured is the application itself.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.account = {
        status: 'trial', username: 'm', email: 'm@example.com', plan: 'Trial',
        trialEndsAt: Date.now() + 9e6,
      };
      document.querySelector('.home')?.classList.add('hidden');
      document.querySelector('.setup-guide')?.classList.add('hidden');
      document.querySelector('.build-bar')?.classList.add('hidden');
    });
    await page.waitForTimeout(500);
    return { context, page };
  }

  /**
   * A finger, or several, moving across the canvas.
   *
   * Dispatched as pointer events with pointerType 'touch', which is what a
   * phone actually sends and what the editor listens for.
   */
  async function drag(page, fingers, steps = 10) {
    await page.evaluate(async ({ fingers, steps }) => {
      const c = document.querySelector('.viewport-canvas');
      // Pointer capture on a synthetic id throws; the editor does not need it
      // to be real for the gesture to be handled.
      c.setPointerCapture = () => {};
      const send = (type, id, x, y, buttons) => c.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1,
        clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
      }));
      for (const f of fingers) send('pointerdown', f.id, f.x0, f.y0, 1);
      for (let s = 1; s <= steps; s++) {
        for (const f of fingers) {
          send('pointermove', f.id, f.x0 + (f.x1 - f.x0) * s / steps, f.y0 + (f.y1 - f.y0) * s / steps, 1);
        }
        await new Promise((done) => setTimeout(done, 8));
      }
      for (const f of fingers) send('pointerup', f.id, f.x1, f.y1, 0);
    }, { fingers, steps });
    await page.waitForTimeout(200);
  }

  const cameraState = (page) => page.evaluate(() => {
    const c = window.kline.editor.camera;
    return JSON.stringify([c.yaw ?? c.theta, c.pitch ?? c.phi, c.distance ?? c.radius, c.target]);
  });

  test('a phone screen is not made wider than the phone', async () => {
    const { context, page } = await phone();
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    await context.close();
    assert.equal(size.scroll, size.view,
      `the document is ${size.scroll}px wide on a ${size.view}px screen, so the browser zooms out to fit`);
  });

  test('one finger turns the view, two slide and pinch it', async () => {
    const { context, page } = await phone();
    const box = await (await page.$('.viewport-canvas')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const beforeOrbit = await cameraState(page);
    await drag(page, [{ id: 1, x0: cx, y0: cy, x1: cx + 90, y1: cy + 30 }]);
    const afterOrbit = await cameraState(page);
    assert.notEqual(afterOrbit, beforeOrbit, 'one finger does not turn the view');

    const beforePan = await cameraState(page);
    await drag(page, [
      { id: 1, x0: cx - 50, y0: cy, x1: cx - 10, y1: cy },
      { id: 2, x0: cx + 50, y0: cy, x1: cx + 90, y1: cy },
    ]);
    assert.notEqual(await cameraState(page), beforePan, 'two fingers do not slide the view');

    const beforePinch = await cameraState(page);
    await drag(page, [
      { id: 1, x0: cx - 40, y0: cy, x1: cx - 110, y1: cy },
      { id: 2, x0: cx + 40, y0: cy, x1: cx + 110, y1: cy },
    ]);
    assert.notEqual(await cameraState(page), beforePinch, 'pinching does not zoom');
    await context.close();
  });

  test('a tap still selects instead of turning the view', async () => {
    const { context, page } = await phone();
    const box = await (await page.$('.viewport-canvas')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
    });
    await page.waitForTimeout(200);
    const before = await cameraState(page);
    // A finger that barely moves is a tap, not a drag.
    await drag(page, [{ id: 1, x0: cx, y0: cy, x1: cx + 1, y1: cy }], 2);
    const selected = await page.evaluate(() => window.kline.editor.scene.active);
    const after = await cameraState(page);
    await context.close();
    assert.notEqual(selected, null, 'tapping an object on a phone did not select it');
    assert.equal(after, before, 'a tap moved the camera, so nothing can be picked without turning the view');
  });

  test('every menu is reachable on a phone and its items are thumb-sized', async () => {
    const { context, page } = await phone();
    const labels = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.menu-label')) {
        // The bar scrolls sideways; a label a person can scroll to counts.
        el.scrollIntoView({ block: 'nearest', inline: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.push({
          text: el.textContent,
          reachable: hit === el || el.contains(hit),
          covered: hit ? String(hit.className || hit.tagName).slice(0, 30) : 'nothing',
          width: Math.round(r.width),
        });
      }
      return out;
    });
    const blocked = labels.filter((l) => !l.reachable);
    assert.equal(blocked.length, 0,
      `menus no finger can reach: ${blocked.map((b) => `${b.text} (under ${b.covered})`).join(', ')}`);
    assert.ok(labels.length >= 8, `only ${labels.length} menus are present`);
    // Squeezed to a stub is the failure this replaced, so width is asserted.
    for (const l of labels) {
      assert.ok(l.width >= 30, `the "${l.text}" menu is ${l.width}px wide, which is not a target`);
    }

    await page.tap('.menu-label:text-is("Add")');
    await page.waitForTimeout(350);
    const sheet = await page.evaluate(() => {
      const drop = document.querySelector('.menu.open .menu-items');
      if (!drop) return null;
      const b = drop.getBoundingClientRect();
      const items = [...drop.querySelectorAll('.menu-item')]
        .filter((e) => e.getBoundingClientRect().width > 0);
      return {
        width: Math.round(b.width),
        viewportWidth: window.innerWidth,
        bottom: Math.round(b.bottom),
        viewportHeight: window.innerHeight,
        items: items.length,
        rowHeight: Math.round(items[0].getBoundingClientRect().height),
      };
    });
    await context.close();
    assert.ok(sheet, 'the Add menu did not open on a phone');
    assert.equal(sheet.width, sheet.viewportWidth, 'the menu is not a full-width sheet');
    assert.equal(sheet.bottom, sheet.viewportHeight, 'the menu is not anchored to the bottom of the screen');
    assert.ok(sheet.rowHeight >= 36, `menu rows are ${sheet.rowHeight}px, too small to tap reliably`);
  });

  test('adding an object works from a phone', async () => {
    const { context, page } = await phone();
    await page.tap('.menu-label:text-is("Add")');
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => window.kline.editor.scene.objects.size);
    // Tapped at its real position: the sheet animates, and a locator tap can
    // refuse a moving target that a finger hits perfectly well.
    const at = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.menu.open .menu-item')]
        .find((e) => e.textContent.trim() === 'Cube');
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.kline.editor.scene.objects.size);
    const stillOpen = await page.evaluate(() => !!document.querySelector('.menu.open'));
    await context.close();
    assert.equal(after, before + 1, `Add > Cube on a phone went from ${before} objects to ${after}`);
    assert.equal(stillOpen, false, 'the menu stayed open over the model after choosing from it');
  });

  test('the panels drawer opens and closes with a finger', async () => {
    const { context, page } = await phone();
    const toggle = await page.$('.sidebar-toggle');
    assert.ok(toggle, 'there is no way to reach the outliner and properties on a phone');
    await toggle.tap();
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(() => document.querySelector('.sidebar').classList.contains('open')),
      true, 'the panels drawer did not open',
    );
    // Tapping the dimmed area behind it puts it away again.
    await page.touchscreen.tap(50, 400);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      open: document.querySelector('.sidebar').classList.contains('open'),
      blocking: getComputedStyle(document.querySelector('.sidebar-scrim')).pointerEvents === 'auto',
    }));
    await context.close();
    assert.equal(after.open, false, 'tapping outside the drawer did not close it');
    assert.equal(after.blocking, false, 'the dimmed layer kept swallowing taps after the drawer closed');
  });

  test('Move, Rotate and Scale can be done with a finger', async () => {
    const { context, page } = await phone();
    const box = await (await page.$('.viewport-canvas')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const results = [];
    for (const kind of ['translate', 'rotate', 'scale']) {
      const before = await page.evaluate(() => {
        const ed = window.kline.editor;
        const o = [...ed.scene.objects.values()][0];
        ed.scene.selection.clear();
        ed.scene.selection.add(o.id);
        ed.scene.active = o.id;
        return JSON.stringify([o.position, o.rotation, o.scale]);
      });
      await page.evaluate((k) => window.kline.editor.startTransform(k), kind);
      // A drag that starts nowhere near where the tool was chosen, which is
      // the normal case on a phone: the button is in the header, the finger
      // lands in the middle of the model.
      await drag(page, [{ id: 1, x0: cx - 60, y0: cy - 40, x1: cx + 80, y1: cy + 60 }]);
      const after = await page.evaluate(() => {
        const ed = window.kline.editor;
        const o = [...ed.scene.objects.values()][0];
        return JSON.stringify([o.position, o.rotation, o.scale]);
      });
      results.push({ kind, changed: before !== after, open: await page.evaluate(() => window.kline.editor.modalLabel ?? null) });
    }
    await context.close();
    for (const r of results) {
      assert.equal(r.changed, true, `${r.kind} with a finger left the object exactly where it was`);
      assert.equal(r.open, null, `${r.kind} did not commit when the finger lifted`);
    }
  });

  test('an open operator can be confirmed or cancelled without a keyboard', async () => {
    const { context, page } = await phone();
    const box = await (await page.$('.viewport-canvas')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const before = await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = [...ed.scene.objects.values()][0];
      ed.scene.selection.clear();
      ed.scene.selection.add(o.id);
      ed.scene.active = o.id;
      return JSON.stringify(o.position);
    });
    await page.evaluate(() => window.kline.editor.startTransform('translate'));
    await page.waitForTimeout(150);
    const targets = await page.evaluate(() => {
      const size = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
      };
      return { confirm: size('.modal-act.confirm'), cancel: size('.modal-act.cancel'), viewH: window.innerHeight };
    });
    assert.ok(targets.confirm, 'there is no way to confirm an operator without a keyboard');
    assert.ok(targets.cancel, 'there is no way to cancel an operator without a keyboard');
    for (const [name, t] of [['Confirm', targets.confirm], ['Cancel', targets.cancel]]) {
      assert.ok(t.h >= 34, `${name} is ${t.h}px tall, too small for a thumb`);
      assert.ok(t.bottom <= targets.viewH, `${name} is off the bottom of the screen`);
    }

    // Mid-drag, with the finger still down: cancelling has to put it back.
    await page.evaluate(({ cx, cy }) => {
      const c = document.querySelector('.viewport-canvas');
      c.setPointerCapture = () => {};
      const send = (t, x, y, b) => c.dispatchEvent(new PointerEvent(t, {
        pointerId: 1, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: b, bubbles: true, cancelable: true,
      }));
      send('pointerdown', cx - 60, cy, 1);
      send('pointermove', cx + 60, cy, 1);
    }, { cx, cy });
    await page.waitForTimeout(150);
    const moved = await page.evaluate(() => JSON.stringify([...window.kline.editor.scene.objects.values()][0].position));
    await page.click('.modal-act.cancel');
    await page.waitForTimeout(250);
    const restored = await page.evaluate(() => ({
      position: JSON.stringify([...window.kline.editor.scene.objects.values()][0].position),
      modal: window.kline.editor.modalLabel ?? null,
    }));
    await context.close();
    assert.notEqual(moved, before, 'the drag never moved anything, so cancelling proves nothing');
    assert.equal(restored.position, before, 'cancelling did not put the object back');
    assert.equal(restored.modal, null, 'cancelling left the operator open');
  });

  test('a finger sculpts instead of orbiting in Sculpt Mode', async () => {
    const { context, page } = await phone();
    const box = await (await page.$('.viewport-canvas')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const before = await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = [...ed.scene.objects.values()][0];
      ed.scene.selection.clear();
      ed.scene.selection.add(o.id);
      ed.scene.active = o.id;
      ed.setMode('sculpt');
      return JSON.stringify([...o.mesh.positions]);
    });
    await page.waitForTimeout(400);
    await drag(page, [{ id: 1, x0: cx - 20, y0: cy, x1: cx + 20, y1: cy }], 16);
    const after = await page.evaluate(
      () => JSON.stringify([...[...window.kline.editor.scene.objects.values()][0].mesh.positions]),
    );
    await context.close();
    assert.notEqual(after, before, 'a finger dragged across the mesh in Sculpt Mode changed nothing');
  });

  test('a fingertip can hit a vertex in Edit Mode', async () => {
    const { context, page } = await phone();
    await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = [...ed.scene.objects.values()][0];
      ed.scene.selection.clear();
      ed.scene.selection.add(o.id);
      ed.scene.active = o.id;
      ed.setMode('edit');
    });
    await page.waitForTimeout(500);
    // Swept rather than aimed: what matters is how much of the screen selects
    // something, because that is what decides whether a tap lands.
    const area = await page.evaluate(() => {
      const ed = window.kline.editor;
      const c = ed.canvas;
      c.setPointerCapture = () => {};
      const rect = c.getBoundingClientRect();
      const tap = (x, y, type) => {
        const send = (t, px, py, b) => c.dispatchEvent(new PointerEvent(t, {
          pointerId: 1, pointerType: type, isPrimary: true,
          clientX: px, clientY: py, button: 0, buttons: b, bubbles: true, cancelable: true,
        }));
        ed.selection.verts.clear();
        send('pointerdown', x + rect.left, y + rect.top, 1);
        send('pointermove', x + rect.left + 1, y + rect.top, 1);
        send('pointerup', x + rect.left + 1, y + rect.top, 0);
        return ed.selection.verts.size > 0;
      };
      let touch = 0;
      let mouse = 0;
      for (let y = 10; y < c.clientHeight - 10; y += 8) {
        for (let x = 10; x < c.clientWidth - 10; x += 8) {
          if (tap(x, y, 'touch')) touch++;
          if (tap(x, y, 'mouse')) mouse++;
        }
      }
      ed.selection.verts.clear();
      return { touch, mouse };
    });
    await context.close();
    assert.ok(area.touch > 0, 'no tap anywhere on the screen selected a vertex in Edit Mode');
    assert.ok(area.touch > area.mouse,
      `a fingertip hits ${area.touch} points and a cursor ${area.mouse}: the finger is not given the larger target`);
  });

  test('a phone held sideways is usable too', async () => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(app.page.url(), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.kline?.editor?.renderer, null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      for (const s of ['.home', '.setup-guide', '.build-bar']) document.querySelector(s)?.classList.add('hidden');
    });
    await page.waitForTimeout(400);
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
      canvas: Math.round(document.querySelector('.viewport-canvas').getBoundingClientRect().height),
    }));
    await context.close();
    assert.equal(size.scroll, size.view, `landscape is ${size.scroll}px wide on a ${size.view}px screen`);
    // Two header rows, a timeline and a status bar on a 390px-tall screen can
    // leave the model almost nothing; the chrome has to give height back.
    assert.ok(size.canvas >= 140, `the model gets only ${size.canvas}px of a 390px-tall screen`);
  });

  test.after(() => app.close());
}
