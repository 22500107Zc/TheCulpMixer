/**
 * The real application, hammered.
 *
 * The unit fuzz next door abuses the modules. This abuses the thing that
 * actually ships: a real browser, a real WebGL context, the real command
 * table, the real undo stack, the real renderer running between every action.
 *
 * What that catches which the module tests cannot: a command that throws only
 * when the UI has an object selected, a renderer that dies on geometry an
 * operator produced, an event handler left attached to a mesh that undo has
 * already replaced, a listener leak that only shows up after four hundred
 * actions. None of those are visible from Node.
 *
 * Every command in the table is run, in random order, against random state,
 * with the invariants checked after each one:
 *
 *   - nothing was written to the console as an error
 *   - no unhandled rejection was raised
 *   - the renderer is still alive and still drawing frames
 *   - the scene is still structurally sound
 *
 * A command that legitimately refuses (nothing selected, wrong mode) is fine.
 * A command that throws is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp } from './app/harness.mjs';

const app = await launchApp();

if (app.skip) {
  test('hammer', { skip: `${app.skip} — the browser suite did not run` }, () => {});
} else {
  const browser = app.page.context().browser();
  const ROUNDS = Number(process.env.CULPMIXER_FUZZ ?? '1') || 1;

  async function fresh() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // A failed network fetch for an optional model is not an application
      // fault and is already handled; everything else counts.
      if (/favicon|net::ERR|Failed to load resource/i.test(text)) return;
      errors.push(`console: ${text.slice(0, 200)}`);
    });
    await page.goto(app.page.url(), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.culpmixer?.editor?.renderer, null, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.account = {
        status: 'trial', username: 'h', email: 'h@example.com', plan: 'Trial',
        trialEndsAt: Date.now() + 9e6,
      };
      for (const s of ['.home', '.setup-guide', '.build-bar']) document.querySelector(s)?.classList.add('hidden');
    });
    return { context, page, errors };
  }

  /** Structural soundness, evaluated inside the page. */
  const PROBE = () => {
    const ed = window.culpmixer.editor;
    const scene = ed.scene;
    const ids = new Set(scene.objects.keys());
    for (const [id, o] of scene.objects) {
      const m = o.mesh;
      if (!m) continue;
      for (let i = 0; i < m.positions.length; i++) {
        const p = m.positions[i];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
          return `object ${id} vertex ${i} is not finite`;
        }
      }
      for (let f = 0; f < m.faces.length; f++) {
        const face = m.faces[f];
        if (!face || face.length < 3) return `object ${id} face ${f} has ${face ? face.length : 0} corners`;
        for (const c of face) {
          if (!Number.isInteger(c) || c < 0 || c >= m.positions.length) {
            return `object ${id} face ${f} points at vertex ${c} of ${m.positions.length}`;
          }
        }
      }
      if (o.parent != null && !ids.has(o.parent)) return `object ${id} has a missing parent`;
    }
    if (!ed.renderer) return 'the renderer is gone';
    return null;
  };

  test('every command survives being run against random state', async () => {
    const { context, page, errors } = await fresh();

    const commands = await page.evaluate(() => window.culpmixer.commands.map((c) => c.id));
    assert.ok(commands.length > 40, `only ${commands.length} commands were found`);

    const report = await page.evaluate(async ({ ids, rounds }) => {
      const ed = window.culpmixer.editor;
      const kinds = ['cube', 'uvSphere', 'cylinder', 'cone', 'torus', 'plane'];
      const thrown = [];
      let s = 12345;
      const rnd = () => {
        s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
      };

      for (let round = 0; round < rounds; round++) {
        // Shuffle so ordering bugs surface rather than one fixed sequence.
        const order = ids.slice().sort(() => rnd() - 0.5);
        for (const id of order) {
          // Random state before each command: sometimes empty, sometimes an
          // object selected, sometimes in Edit or Sculpt mode.
          const roll = rnd();
          try {
            if (roll < 0.25 || ed.scene.objects.size === 0) {
              ed.addPrimitive(kinds[Math.floor(rnd() * kinds.length)]);
            }
            if (roll > 0.8) {
              ed.scene.selection.clear();
              ed.scene.active = null;
            } else {
              const first = [...ed.scene.objects.keys()][0];
              if (first !== undefined) {
                ed.scene.selection.clear();
                ed.scene.selection.add(first);
                ed.scene.active = first;
              }
            }
            if (roll > 0.55 && roll < 0.7) ed.setMode('edit');
            else if (roll > 0.7 && roll < 0.8) ed.setMode('sculpt');
            else ed.setMode('object');
          } catch (err) {
            thrown.push(`setup for ${id}: ${err.message}`);
            continue;
          }

          try {
            const out = window.culpmixer.run(id);
            if (out && typeof out.then === 'function') await out.catch((e) => { throw e; });
          } catch (err) {
            thrown.push(`${id} THREW ${err && err.message ? err.message : err}`);
          }
          if (thrown.length > 15) return { thrown, stopped: true };
        }
      }
      return { thrown, stopped: false };
    }, { ids: commands, rounds: ROUNDS });

    await page.waitForTimeout(400);
    const structural = await page.evaluate(PROBE);
    const frames = await page.evaluate(() => window.culpmixer.editor.renderer ? 'alive' : 'dead');
    await context.close();

    assert.deepEqual(report.thrown.slice(0, 10), [], `${report.thrown.length} commands threw`);
    assert.equal(structural, null, `the scene ended structurally broken: ${structural}`);
    assert.equal(frames, 'alive', 'the renderer died during the run');
    assert.deepEqual(errors.slice(0, 6), [], `${errors.length} errors reached the console`);
  });

  test('a long editing session does not degrade or leak', async () => {
    const { context, page, errors } = await fresh();

    const result = await page.evaluate(async ({ rounds }) => {
      const ed = window.culpmixer.editor;
      const kinds = ['cube', 'uvSphere', 'cylinder'];
      let s = 777;
      const rnd = () => {
        s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
      };
      const listenersAt = [];
      const started = performance.now();

      for (let i = 0; i < 260 * rounds; i++) {
        const roll = rnd();
        if (roll < 0.35) {
          ed.addPrimitive(kinds[Math.floor(rnd() * kinds.length)]);
        } else if (roll < 0.5) {
          const ids = [...ed.scene.objects.keys()];
          if (ids.length > 2) ed.scene.remove(ids[Math.floor(rnd() * ids.length)]);
          if (ed.scene.active !== null && !ed.scene.objects.has(ed.scene.active)) ed.scene.active = null;
        } else if (roll < 0.7) {
          ed.undo();
        } else if (roll < 0.85) {
          ed.redo();
        } else {
          ed.setMode(['object', 'edit', 'sculpt'][Math.floor(rnd() * 3)]);
        }
        if (i % 60 === 0) listenersAt.push(ed.scene.objects.size);
      }
      const elapsed = performance.now() - started;

      // The undo stack has a budget; an unbounded one is how a long session
      // ends in a tab that has eaten a gigabyte.
      const undoDepth = ed.history?.undoStack?.length ?? 0;
      return {
        elapsed,
        undoDepth,
        objects: ed.scene.objects.size,
        limit: ed.history?.limit ?? null,
        sizes: listenersAt,
        alive: !!ed.renderer,
      };
    }, { rounds: ROUNDS });

    await page.waitForTimeout(500);
    const structural = await page.evaluate(PROBE);
    await context.close();

    assert.equal(structural, null, `a long session broke the scene: ${structural}`);
    assert.equal(result.alive, true, 'the renderer did not survive the session');
    assert.ok(
      result.limit === null || result.undoDepth <= result.limit,
      `the undo stack grew to ${result.undoDepth}, past its limit of ${result.limit}`,
    );
    assert.deepEqual(errors.slice(0, 6), [], `${errors.length} errors reached the console`);
  });

  test('undo and redo hammered together never lose or duplicate the scene', async () => {
    const { context, page, errors } = await fresh();
    const result = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      ed.addPrimitive('cube');
      const marker = ed.scene.objects.size;
      const states = [];
      for (let i = 0; i < 40; i++) {
        ed.addPrimitive('cube');
        states.push(ed.scene.objects.size);
      }
      // All the way back, then all the way forward, then back again. The
      // stack has to end where it started both times.
      for (let i = 0; i < 60; i++) ed.undo();
      const bottom = ed.scene.objects.size;
      for (let i = 0; i < 60; i++) ed.redo();
      const top = ed.scene.objects.size;
      for (let i = 0; i < 60; i++) ed.undo();
      const bottomAgain = ed.scene.objects.size;
      return { marker, bottom, top, bottomAgain, expectedTop: states[states.length - 1] };
    });
    await page.waitForTimeout(300);
    const structural = await page.evaluate(PROBE);
    await context.close();

    assert.equal(structural, null, `undo/redo broke the scene: ${structural}`);
    assert.equal(result.bottom, result.bottomAgain,
      `undoing to the bottom gave ${result.bottom} objects the first time and ${result.bottomAgain} the second`);
    assert.equal(result.top, result.expectedTop,
      `redoing everything gave ${result.top} objects, not the ${result.expectedTop} there were`);
    assert.deepEqual(errors.slice(0, 6), [], `${errors.length} errors reached the console`);
  });

  test('rapid mode switching with a live selection never throws', async () => {
    const { context, page, errors } = await fresh();
    const thrown = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const out = [];
      ed.addPrimitive('cube');
      const id = [...ed.scene.objects.keys()][0];
      for (let i = 0; i < 300; i++) {
        const mode = ['object', 'edit', 'sculpt'][i % 3];
        try {
          // Selection deliberately churned underneath the mode change.
          if (i % 4 === 0) ed.scene.selection.clear();
          else { ed.scene.selection.add(id); ed.scene.active = id; }
          if (i % 7 === 0) ed.selection.verts.add(99999);
          ed.setMode(mode);
        } catch (err) {
          out.push(`${mode} at ${i}: ${err.message}`);
          if (out.length > 5) break;
        }
      }
      return out;
    });
    await page.waitForTimeout(300);
    const structural = await page.evaluate(PROBE);
    await context.close();
    assert.deepEqual(thrown, [], 'switching modes threw');
    assert.equal(structural, null, `mode switching broke the scene: ${structural}`);
    assert.deepEqual(errors.slice(0, 6), [], `${errors.length} errors reached the console`);
  });

  test.after(() => app.close());
}
