/**
 * What the user actually sees, asserted against a real browser.
 *
 * The suite in `tests/*.test.ts` covers the geometry, the solvers and the file
 * format, and covers them well — but every one of those tests stops at the
 * edge of the renderer. Three bugs shipped through that gap: a shadow pass
 * that silently drew nothing, a click that threw away the selection it had
 * just confirmed, and an axis whose labels ran together. None of them were
 * findable from data alone; all three are findable from here.
 *
 * Each test below is written against a specific failure that reached a user,
 * not against the implementation that happens to be there now.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, luma, resetScene, samplePixels, screenPoint } from './app/harness.mjs';

const app = await launchApp();

if (app.skip) {
  test('viewport and interaction tests', { skip: `${app.skip} — the browser suite did not run` }, () => {});
} else {
  test.after(() => app.close());

  const { page, centre } = app;

  /** A floor, a box above it, and a sun: the smallest scene that casts. */
  const shadowScene = async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 8;
      floor.scale.y = 8;
      k.run('add.cube');
      S.get(S.active).position.z = 2;
      k.run('add.light.sun');
      const sun = S.get(S.active);
      sun.position.z = 8;
      sun.rotation.x = -0.9;
      if (sun.light) sun.light.energy = 5;
      S.selection.clear();
      S.active = null;
      for (let i = 0; i < 4 && ed.options.shading !== 'material'; i++) k.run('view.shading');
      ed.options.showGrid = false;
      ed.options.showOverlays = false;
    });
  };

  /** A lattice of points across the lower half of the frame, where the floor is. */
  const floorGrid = () => {
    const pts = [];
    for (let y = 0.55; y <= 0.92; y += 0.06) {
      for (let x = 0.12; x <= 0.88; x += 0.06) pts.push([x, y]);
    }
    return pts;
  };

  test('the shadow pass writes depth rather than leaving the map empty', async () => {
    await shadowScene();
    const depth = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const r = ed.renderer;
      const gl = r.gl;
      ed.renderNow();
      const tex = r.shadowMap;
      if (!tex) return { error: 'no shadow map was allocated' };

      // The depth attachment cannot be read directly, so it is sampled into a
      // small colour target through a plain (non-comparison) lookup.
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, `#version 300 es
in vec2 aP; out vec2 vT;
void main(){ vT = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; uniform sampler2D uD; in vec2 vT; out vec4 o;
void main(){ float d = texture(uD, vT).r; o = vec4(d, d, d, 1.0); }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog) };

      const N = 128;
      const colour = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, colour);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, N, N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, 'uD'), 2);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aP');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, N, N);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const px = new Uint8Array(N * N * 4);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let min = 255;
      let occupied = 0;
      for (let i = 0; i < N * N; i++) {
        const v = px[i * 4];
        if (v < min) min = v;
        if (v < 250) occupied++;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(colour);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.disableVertexAttribArray(loc);
      window.culpmixer.editor.requestRender();
      return { min, occupied, of: N * N };
    });

    assert.equal(depth.error, undefined, `depth read failed: ${depth.error}`);
    // An all-white map is a cleared one — the case where every shadow draw was
    // rejected and the pass produced nothing at all.
    assert.ok(
      depth.occupied > 0,
      `the shadow map is empty: every one of ${depth.of} texels is at the clear value`,
    );
  });

  test('a box above a floor casts a visible shadow onto it', async () => {
    await shadowScene();
    const points = floorGrid();

    await page.evaluate(() => { window.culpmixer.editor.options.shadows = true; });
    const lit = (await samplePixels(page, points)).map(luma);

    await page.evaluate(() => { window.culpmixer.editor.options.shadows = false; });
    const flat = (await samplePixels(page, points)).map(luma);

    // Only points that are on the floor at all — the frame also contains the
    // box itself and the background above the horizon.
    const onFloor = flat.map((v, i) => [v, i]).filter(([v]) => v > 60).map(([, i]) => i);
    assert.ok(onFloor.length > 20, `expected a floor to sample, found ${onFloor.length} lit points`);

    const spread = (values) => {
      const v = onFloor.map((i) => values[i]);
      return Math.max(...v) - Math.min(...v);
    };

    // Without shadows the floor is one flat tone; with them, part of it is
    // markedly darker. The gap between those two spreads is the shadow.
    assert.ok(
      spread(flat) < 25,
      `the unshadowed floor should be near-uniform, but its brightness ranges over ${spread(flat).toFixed(1)}`,
    );
    assert.ok(
      spread(lit) > 40,
      `no shadow reached the floor: brightness ranges over only ${spread(lit).toFixed(1)}`,
    );

    await page.evaluate(() => { window.culpmixer.editor.options.shadows = true; });
  });

  test('no pass leaves a GL error behind, in any mode', async () => {
    await resetScene(page);
    const errors = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      const gl = ed.renderer.gl;
      k.run('add.uvsphere');
      const ball = S.get(S.active);
      ball.mesh.shadeSmooth = true;
      ball.mesh.markDirty();
      k.run('add.light.sun');
      S.selection = new Set([ball.id]);
      S.active = ball.id;
      ed.options.showGrid = true;
      ed.options.showOverlays = true;

      const found = [];
      const drain = () => { while (gl.getError() !== gl.NO_ERROR) { /* clear */ } };
      const frame = (label) => {
        drain();
        ed.renderNow();
        const e = gl.getError();
        if (e !== gl.NO_ERROR) found.push(`${label}: 0x${e.toString(16)}`);
      };

      for (const shading of ['solid', 'material', 'wireframe']) {
        ed.options.shading = shading;
        frame(`object/${shading}`);
      }
      ed.options.shading = 'material';
      k.run('mode.edit');
      k.run('select.all');
      for (const mode of ['vertex', 'edge', 'face']) {
        ed.setSelectMode(mode);
        frame(`edit/${mode}`);
      }
      // Deleting an object leaves attribute arrays pointing at freed buffers,
      // which is exactly how the shadow pass came to draw nothing.
      k.run('mode.object');
      S.remove(ball.id);
      frame('after a delete');
      k.run('add.cube');
      frame('after a delete then an add');
      return found;
    });
    assert.deepEqual(errors, [], `GL errors were raised during rendering: ${errors.join(', ')}`);
  });

  test('edit-mode overlays draw through their own vertex layout', async () => {
    await resetScene(page);
    // Vertex dots and wires read their attributes from buffers packed far
    // tighter than a surface vertex. Handing them the surface layout leaves
    // the stride wrong, and the overlay does not vanish — it scatters, which
    // is why counting pixels is not enough. Where they land is the test.
    const check = async (selectMode) => page.evaluate((mode) => {
      const k = window.culpmixer, ed = k.editor;
      ed.setSelectMode(mode);
      k.run('select.all');
      ed.options.showOverlays = true;
      ed.renderNow();

      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      // Where the mesh actually is on screen, from its own bounds.
      const obj = ed.editObject;
      const b = obj.mesh.bounds();
      const model = obj.worldMatrix(ed.scene);
      const V = ed.camera.target.constructor;
      let lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
      for (let i = 0; i < 8; i++) {
        const p = model.transformPoint(new V(
          i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z,
        ));
        const s = ed.camera.worldToScreen(p, w, h);
        lo = { x: Math.min(lo.x, s.x), y: Math.min(lo.y, s.y) };
        hi = { x: Math.max(hi.x, s.x), y: Math.max(hi.y, s.y) };
      }
      // Half a dot of slack, plus a little for the projection being coarse.
      const pad = 14;

      let orange = 0, stray = 0;
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], bl = px[i * 4 + 2];
        if (!(r > 180 && g > 100 && g < 200 && bl < 90)) continue;
        orange++;
        const x = i % w;
        // readPixels counts rows from the bottom; worldToScreen from the top.
        const y = h - 1 - Math.floor(i / w);
        if (x < lo.x - pad || x > hi.x + pad || y < lo.y - pad || y > hi.y + pad) stray++;
      }
      return { orange, stray, box: [lo.x | 0, lo.y | 0, hi.x | 0, hi.y | 0] };
    }, selectMode);

    await page.evaluate(() => {
      const k = window.culpmixer;
      k.run('add.uvsphere');
      k.run('mode.edit');
    });

    for (const mode of ['vertex', 'edge']) {
      const r = await check(mode);
      assert.ok(
        r.orange > 500,
        `${mode} overlay is not being drawn: only ${r.orange} overlay pixels in the frame`,
      );
      // A mis-strided buffer walks off the end of its data and throws the
      // overlay across the frame; a correct one keeps it on the mesh.
      assert.ok(
        r.stray < r.orange * 0.02,
        `${mode} overlay is scattered: ${r.stray} of ${r.orange} pixels fall outside `
        + `the mesh at [${r.box}] — the buffer is being read at the wrong stride`,
      );
    }
  });

  /** Put a cube in edit mode with its top face picked, ready for an operator. */
  const cubeWithTopFacePicked = async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer;
      k.run('add.cube');
      k.run('mode.edit');
      k.run('select.face');
      k.run('select.none');
    });
    // The centre of the top face, projected through the app's own camera.
    const top = await screenPoint(page, [0, 0, 0.5]);
    await page.mouse.move(top.x, top.y);
    await page.mouse.click(top.x, top.y);
    return top;
  };

  test('confirming a modal with a click keeps the selection', async () => {
    await cubeWithTopFacePicked();
    assert.equal(
      await page.evaluate(() => window.culpmixer.editor.selection.faces.size), 1,
      'clicking the top face should select exactly it',
    );

    // Confirm well below the cube, over empty space. That is the case that
    // matters: a modal is sized by dragging away from what it acts on, so the
    // confirming click routinely lands on nothing. Confirming back over the
    // face hides the bug, because the stray pick simply finds it again.
    const empty = await screenPoint(page, [0, 0, -3]);
    await page.keyboard.press('i');
    await page.mouse.move(empty.x, empty.y - 120);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.up();

    const after = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      return { faces: ed.selection.faces.size, modal: ed.modal ? ed.modal.type : null };
    });
    assert.equal(after.modal, null, 'the click should have confirmed the inset');
    // The release used to be read as a click on empty space, and deselect.
    assert.equal(after.faces, 1, 'the inset face should still be selected after confirming');
  });

  test('inset then extrude chains, which is the whole point of keeping it', async () => {
    const top = await cubeWithTopFacePicked();
    const faces = () => page.evaluate(() => window.culpmixer.editor.editObject.mesh.faceCount);
    const start = await faces();

    await page.keyboard.press('i');
    await page.mouse.move(top.x + 40, top.y);
    await page.mouse.down();
    await page.mouse.up();
    const inset = await faces();
    assert.ok(inset > start, `inset added no geometry (${start} -> ${inset})`);

    await page.keyboard.press('e');
    await page.mouse.move(top.x, top.y - 60);
    await page.mouse.down();
    await page.mouse.up();
    const extruded = await faces();
    assert.ok(extruded > inset, `extrude after inset did nothing (${inset} -> ${extruded})`);
  });

  test('the ordinary ways of selecting still work', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, S = k.editor.scene;
      k.run('add.cube');
      S.get(S.active).position.x = -2.2;
      k.run('add.cube');
      S.get(S.active).position.x = 2.2;
      S.selection.clear();
      S.active = null;
      k.editor.requestRender();
    });
    const count = () => page.evaluate(() => window.culpmixer.editor.scene.selection.size);

    const left = await screenPoint(page, [-2.2, 0, 0]);
    await page.mouse.click(left.x, left.y);
    assert.equal(await count(), 1, 'a click should select the object under it');

    const right = await screenPoint(page, [2.2, 0, 0]);
    await page.keyboard.down('Shift');
    await page.mouse.click(right.x, right.y);
    await page.keyboard.up('Shift');
    assert.equal(await count(), 2, 'shift-click should extend the selection');

    // The origin: the gap between the two cubes, and dead centre of frame, so
    // it is certainly on the canvas rather than under a panel.
    const empty = await screenPoint(page, [0, 0, 0]);
    await page.mouse.click(empty.x, empty.y);
    assert.equal(await count(), 0, 'a click on empty space should deselect');

    // A rectangle drawn around both cubes, with room to spare on each side.
    const pad = 60;
    await page.mouse.move(Math.min(left.x, right.x) - pad, Math.min(left.y, right.y) - pad);
    await page.mouse.down();
    await page.mouse.move(Math.max(left.x, right.x) + pad, Math.max(left.y, right.y) + pad, { steps: 8 });
    await page.mouse.up();
    assert.equal(await count(), 2, 'a drag across both objects should select both');
  });

  test('escape cancels a transform and puts the value back', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, S = k.editor.scene;
      k.run('add.cube');
      S.selection = new Set([S.active]);
      k.editor.requestRender();
    });
    const x = () => page.evaluate(
      () => +window.culpmixer.editor.scene.get(window.culpmixer.editor.scene.active).position.x,
    );
    const origin = await screenPoint(page, [0, 0, 0]);
    const before = await x();

    await page.mouse.move(origin.x, origin.y);
    await page.keyboard.press('g');
    await page.mouse.move(origin.x + 120, origin.y);
    await page.keyboard.press('Escape');
    assert.ok(Math.abs((await x()) - before) < 1e-6, 'escape left the object moved');

    await page.mouse.move(origin.x, origin.y);
    await page.keyboard.press('g');
    await page.mouse.move(origin.x + 120, origin.y);
    await page.mouse.down();
    await page.mouse.up();
    assert.ok(Math.abs((await x()) - before) > 0.1, 'a confirmed move did not move anything');
  });

  /** Drag across the middle of the viewport, the way a stroke is made. */
  const dragAcross = async (from, steps = 10, dx = 6, dy = 0) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + i * dx, from.y + i * dy);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  test('a sculpt stroke moves the surface it is dragged over', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.uvsphere');
      k.run('mode.sculpt');
      ed.sculpt.brush = 'draw';
      ed.sculpt.radius = 0.5;
      const o = ed.scene.get(ed.scene.active);
      window.__before = o.mesh.positions.map((p) => [p.x, p.y, p.z]);
    });
    const centre = await screenPoint(page, [0, 0, 0]);
    await dragAcross({ x: centre.x - 30, y: centre.y });

    const moved = await page.evaluate(() => {
      const o = window.culpmixer.editor.scene.get(window.culpmixer.editor.scene.active);
      let n = 0, worst = 0, nan = 0;
      o.mesh.positions.forEach((p, i) => {
        if (!Number.isFinite(p.x + p.y + p.z)) { nan++; return; }
        const q = window.__before[i];
        const d = Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);
        if (d > 1e-6) n++;
        if (d > worst) worst = d;
      });
      return { n, worst, nan };
    });
    assert.equal(moved.nan, 0, 'the stroke put NaN into the mesh');
    assert.ok(moved.n > 10, `the stroke moved only ${moved.n} vertices — it is not reaching the surface`);
    assert.ok(moved.worst > 0.005, `the stroke barely displaced anything (${moved.worst})`);
  });

  test('a mask holds back the brush where it was painted', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.uvsphere');
      k.run('mode.sculpt');
      ed.sculpt.brush = 'mask';
      ed.sculpt.radius = 0.8;
      ed.sculpt.strength = 1;
    });
    const centre = await screenPoint(page, [0, 0, 0]);
    // Several passes, so a region actually reaches full mask rather than a
    // falloff value that is supposed to move a little.
    for (let i = 0; i < 5; i++) await dragAcross({ x: centre.x - 20, y: centre.y }, 8, 4);

    const painted = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const o = ed.scene.get(ed.scene.active);
      if (!o.mesh.mask) return { held: 0 };
      window.__mask = [...o.mesh.mask];
      window.__before = o.mesh.positions.map((p) => [p.x, p.y, p.z]);
      ed.sculpt.brush = 'draw';
      return { held: window.__mask.filter((v) => v > 0.9).length };
    });
    assert.ok(painted.held > 5, `the mask brush painted only ${painted.held} vertices to full strength`);

    await dragAcross({ x: centre.x - 20, y: centre.y }, 8, 4);
    const byLevel = await page.evaluate(() => {
      const o = window.culpmixer.editor.scene.get(window.culpmixer.editor.scene.active);
      const masked = [], partial = [];
      o.mesh.positions.forEach((p, i) => {
        const q = window.__before[i];
        const d = Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);
        const m = window.__mask[i] ?? 0;
        if (m > 0.9) masked.push(d);
        else if (m > 0.1) partial.push(d);
      });
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
      return { masked: mean(masked), partial: mean(partial), partialCount: partial.length };
    });
    assert.ok(byLevel.partialCount > 0, 'no partly-masked vertices to compare against');
    // A mask is a falloff, so the test is the ratio, not that masked is zero.
    assert.ok(
      byLevel.masked < byLevel.partial * 0.1,
      `masked vertices moved ${byLevel.masked.toFixed(5)} against ${byLevel.partial.toFixed(5)} `
      + 'for partly-masked ones — the mask is not holding them',
    );
  });

  test('posing a bound rig changes what is on screen', async () => {
    await resetScene(page);
    const bound = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      k.run('add.cylinder');
      const tube = S.get(S.active);
      tube.scale.z = 3;
      k.run('add.armature');
      const arm = [...S.objects.values()].find((o) => o.type === 'armature');
      k.run('rig.extrudeBone');
      k.run('rig.extrudeBone');
      S.selection = new Set([tube.id, arm.id]);
      S.active = arm.id;
      k.run('rig.bind');
      window.__tube = tube.id;
      window.__arm = arm.id;
      const skin = tube.skin ?? tube.mesh.skin;
      if (!skin) return { influences: 0 };
      let influences = 0;
      for (let i = 0; i < skin.bones.length; i++) if (skin.bones[i] >= 0 && skin.weights[i] > 0) influences++;
      // Weights are a partition of unity wherever anything is bound at all.
      const per = skin.bones.length / tube.mesh.positions.length;
      let badSums = 0;
      for (let v = 0; v < tube.mesh.positions.length; v++) {
        let sum = 0;
        for (let i = 0; i < per; i++) sum += skin.weights[v * per + i];
        if (sum > 1e-6 && Math.abs(sum - 1) > 1e-4) badSums++;
      }
      return { influences, badSums };
    });
    assert.ok(bound.influences > 0, 'binding produced no weights at all');
    assert.equal(bound.badSums, 0, 'some vertices have weights that do not sum to one');

    // Same camera, same everything, only the bone moves — so the mesh must
    // change, and so must the frame. Whole-frame difference rather than a few
    // sample points: on a flat-shaded surface two very different silhouettes
    // can happen to share a colour anywhere you happen to look.
    const deformed = await page.evaluate(() => {
      const ed = window.culpmixer.editor, S = ed.scene;
      const tube = S.get(window.__tube);
      const arm = S.get(window.__arm);
      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const frame = () => {
        ed.renderNow();
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const rest = tube.evaluated(false).positions.map((p) => [p.x, p.y, p.z]);
      const restFrame = frame();

      arm.armature.bones[arm.armature.bones.length - 1].rotation = [0, 0.9, 0];
      tube.invalidate?.();
      arm.invalidate?.();

      const posed = tube.evaluated(false).positions.map((p) => [p.x, p.y, p.z]);
      let moved = 0, still = 0, nan = 0;
      posed.forEach((p, i) => {
        if (!Number.isFinite(p[0] + p[1] + p[2])) { nan++; return; }
        const d = Math.hypot(p[0] - rest[i][0], p[1] - rest[i][1], p[2] - rest[i][2]);
        if (d > 1e-6) moved++; else still++;
      });

      const posedFrame = frame();
      let changed = 0;
      for (let i = 0; i < w * h; i++) {
        const d = Math.abs(restFrame[i * 4] - posedFrame[i * 4])
          + Math.abs(restFrame[i * 4 + 1] - posedFrame[i * 4 + 1])
          + Math.abs(restFrame[i * 4 + 2] - posedFrame[i * 4 + 2]);
        if (d > 12) changed++;
      }
      return { moved, still, nan, changed, pixels: w * h };
    });
    assert.equal(deformed.nan, 0, 'posing put NaN into the mesh');
    assert.ok(deformed.moved > 0, 'posing a bone moved nothing');
    assert.ok(deformed.still > 0, 'posing one bone moved the entire mesh — the weights are not localised');
    // The evaluated mesh changing is not enough: a modifier stack returns a
    // fresh mesh every run, and one keyed only by revision looks identical to
    // the last, so the viewport went on showing the rest pose.
    assert.ok(
      deformed.changed > deformed.pixels * 0.005,
      `only ${deformed.changed} of ${deformed.pixels} pixels changed — the deformed mesh `
      + 'is not reaching the screen',
    );
  });

  test('a physics bake drops a box onto a floor and keys where it lands', async () => {
    await resetScene(page);
    const baked = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 8;
      floor.scale.y = 8;
      floor.physics = { kind: 'passive', mass: 0, shape: 'box', friction: 0.6, restitution: 0.1 };
      k.run('add.cube');
      const box = S.get(S.active);
      box.position.z = 5;
      box.rotation.x = 0.4;
      box.rotation.y = 0.3;
      box.physics = { kind: 'active', mass: 1, shape: 'box', friction: 0.6, restitution: 0.1 };
      k.run('physics.bake');
      const z = box.animation.find((c) => c.path === 'position' && c.index === 2);
      const rot = box.animation.filter((c) => c.path === 'rotation');
      return {
        keyed: !!z && z.keys.length > 1,
        startZ: z ? z.keys[0].value : null,
        endZ: z ? z.keys[z.keys.length - 1].value : null,
        rotationChannels: rot.length,
        rotationMoved: rot.some((c) => Math.abs(c.keys[c.keys.length - 1].value - c.keys[0].value) > 1e-3),
        status: ed.statusMessage,
      };
    });
    assert.ok(baked.keyed, 'the bake wrote no position keys');
    assert.ok(baked.endZ < baked.startZ - 2, `the box did not fall (${baked.startZ} -> ${baked.endZ})`);
    assert.ok(baked.endZ > 0.2, `the box fell through the floor to ${baked.endZ}`);
    assert.equal(baked.rotationChannels, 3, 'rotation was not baked');
    // A box dropped at an angle onto a floor has to rotate as it settles;
    // it used to collide as though it were axis-aligned and never would.
    assert.ok(baked.rotationMoved, 'the box never rotated — the solver is ignoring orientation');
  });

  test('the path tracer produces an image, not a blank canvas', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 6;
      floor.scale.y = 6;
      k.run('add.uvsphere');
      S.get(S.active).position.z = 1.2;
      k.run('add.light.sun');
      S.get(S.active).position.z = 6;
      ed.renderSettings.width = 96;
      ed.renderSettings.height = 64;
      ed.renderSettings.samples = 8;
      ed.renderSettings.maxBounces = 3;
      k.run('render.image');
    });
    await page.waitForFunction(
      () => window.culpmixer.editor.activeRender && window.culpmixer.editor.activeRender.samplesDone > 0,
      null, { timeout: 60_000 },
    );
    const image = await page.evaluate(() => {
      const job = window.culpmixer.editor.activeRender;
      const data = job.toImageData();
      let min = 255, max = 0, sum = 0;
      const n = data.width * data.height;
      for (let i = 0; i < n; i++) {
        const v = 0.2126 * data.data[i * 4] + 0.7152 * data.data[i * 4 + 1] + 0.0722 * data.data[i * 4 + 2];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const nan = [...data.data].some((v) => !Number.isFinite(v));
      window.culpmixer.run('render.cancel');
      return { samples: job.samplesDone, triangles: job.triangles, min, max, mean: sum / n, nan };
    });
    assert.equal(image.nan, false, 'the render contains non-finite pixels');
    assert.ok(image.triangles > 0, 'the tracer was handed no geometry');
    // A frame that is one flat tone means nothing was hit, or everything was.
    assert.ok(
      image.max - image.min > 30,
      `the render is a flat field (${image.min.toFixed(0)}..${image.max.toFixed(0)}) — nothing was traced`,
    );
    assert.ok(image.mean > 5, `the render came back essentially black (mean ${image.mean.toFixed(1)})`);
  });

  test('a comparison tints changed geometry and ghosts what was removed', async () => {
    await resetScene(page);
    const counts = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor, S = ed.scene;
      k.run('add.cube');
      const block = S.get(S.active);
      for (let i = 0; i < 4 && ed.options.shading !== 'material'; i++) k.run('view.shading');
      ed.options.showGrid = false;
      ed.options.showOverlays = false;
      const before = JSON.parse(JSON.stringify(S.toJSON()));

      // Subdivide: every original face is replaced, so the comparison should
      // report new geometry and have old loops left over to ghost.
      S.selection = new Set([block.id]);
      S.active = block.id;
      k.run('mode.edit');
      k.run('select.face');
      k.run('select.all');
      k.run('mesh.subdivide');
      k.run('mode.object');
      S.selection.clear();
      S.active = null;

      const diff = ed.compareAgainst(before, 'before subdividing');
      const entry = diff.objects.find((o) => o.id === block.id);
      return {
        added: entry?.mesh?.added ?? 0,
        removed: entry?.mesh?.removed ?? 0,
        status: entry?.status,
      };
    });
    assert.equal(counts.status, 'changed', 'the edited object was not reported as changed');
    assert.ok(counts.added > 0, 'subdividing reported no new faces');
    assert.ok(counts.removed > 0, 'subdividing reported nothing removed');

    // The whole point is that it reaches the screen, so the frames are
    // compared with the comparison shown and hidden.
    const pixels = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const frame = () => {
        ed.renderNow();
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      ed.options.showDiff = false;
      const plain = frame();
      ed.options.showDiff = true;
      const shown = frame();
      let green = 0, red = 0;
      for (let i = 0; i < w * h; i++) {
        const dr = shown[i * 4] - plain[i * 4];
        const dg = shown[i * 4 + 1] - plain[i * 4 + 1];
        const db = shown[i * 4 + 2] - plain[i * 4 + 2];
        if (dg > 25 && dg > dr && dg > db) green++;
        if (dr > 25 && dr > dg && dr > db) red++;
      }
      return { green, red, of: w * h };
    });
    assert.ok(pixels.green > 400, `added geometry is not tinted: only ${pixels.green} greener pixels`);
    // Removed faces cannot be tinted — they are gone — so they are drawn as
    // outlines where they used to be, which is the other half of a diff.
    assert.ok(pixels.red > 40, `removed geometry left no ghost: only ${pixels.red} redder pixels`);

    await page.evaluate(() => window.culpmixer.editor.stopComparing());
  });

  test('a comparison against an unchanged scene reports nothing', async () => {
    await resetScene(page);
    const result = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.uvsphere');
      const before = JSON.parse(JSON.stringify(ed.scene.toJSON()));
      const diff = ed.compareAgainst(before, 'itself');
      const out = { identical: diff.identical, status: ed.statusMessage };
      ed.stopComparing();
      return out;
    });
    assert.ok(result.identical, `comparing a scene with itself found differences: ${result.status}`);
  });

  test('the comparison panel opens on its shortcut and lists the changes', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.culpmixer;
      k.run('add.cube');
      window.__snapshot = JSON.parse(JSON.stringify(k.editor.scene.toJSON()));
      k.run('add.uvsphere');
      k.editor.scene.get(k.editor.scene.active).name = 'Newcomer';
    });
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(250);
    const opened = await page.evaluate(() => {
      const panel = document.querySelector('.diff-panel');
      return { present: !!panel, hidden: panel?.classList.contains('hidden') };
    });
    assert.ok(opened.present, 'the comparison panel is not in the document');
    assert.equal(opened.hidden, false, 'ctrl+D did not open the comparison panel');

    const rows = await page.evaluate(() => {
      window.culpmixer.editor.compareAgainst(window.__snapshot, 'a moment ago');
      return [...document.querySelectorAll('.diff-row')].map((r) => r.textContent);
    });
    assert.ok(
      rows.some((r) => r.includes('Newcomer')),
      `the added object is not listed; rows were ${JSON.stringify(rows)}`,
    );

    await page.evaluate(() => window.culpmixer.editor.stopComparing());
    await page.keyboard.press('Escape');
  });

  test('the setup guide opens on a first run and stays shut once dismissed', async () => {
    // A fresh profile has no stored preference, which is what a genuine first
    // run looks like.
    const first = await page.evaluate(() => {
      const el = document.querySelector('.setup-guide');
      return {
        present: !!el,
        preference: window.culpmixer.editor.preferences.showGuideOnStart,
      };
    });
    assert.ok(first.present, 'the guide is not in the document at all');

    // Open it explicitly, since earlier tests in this file have already been
    // through the boot sequence.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: true });
      if (!document.querySelector('.setup-guide').classList.contains('hidden')) return;
      window.culpmixer.run('help.guide');
    });
    await page.waitForTimeout(200);

    const opened = await page.evaluate(() => {
      const el = document.querySelector('.setup-guide');
      return {
        open: !el.classList.contains('hidden'),
        title: el.querySelector('h2')?.textContent,
        cards: el.querySelectorAll('.setup-dot').length,
        hasAction: !!el.querySelector('.setup-try'),
        hasCheckbox: !!el.querySelector('.setup-again input'),
      };
    });
    assert.ok(opened.open, 'the guide did not open');
    assert.ok(opened.cards >= 3, `only ${opened.cards} cards — that is not a guide`);
    assert.ok(opened.hasAction, 'the first card has nothing to try');
    assert.ok(opened.hasCheckbox, 'there is no way to turn it off');

    // The demonstrations have to act on the real scene, or they teach nothing.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      for (const id of [...ed.scene.objects.keys()]) ed.scene.remove(id);
    });
    await page.click('.setup-try');
    await page.waitForTimeout(300);
    const built = await page.evaluate(() => window.culpmixer.editor.scene.objects.size);
    assert.ok(built > 0, 'the first card\'s button did nothing to the scene');

    // Ticking the box must persist, not just hide the panel for this session.
    await page.click('.setup-again input');
    await page.waitForTimeout(200);
    const off = await page.evaluate(() => ({
      preference: window.culpmixer.editor.preferences.showGuideOnStart,
      stored: JSON.parse(localStorage.getItem('culpmixer.preferences') ?? '{}').showGuideOnStart,
    }));
    assert.equal(off.preference, false, 'the checkbox did not change the preference');
    assert.equal(off.stored, false, 'the choice was not written to storage, so it will come back');

    // And it must still be openable afterwards — onboarding you cannot get
    // back is a dead end.
    await page.evaluate(() => {
      document.querySelector('.setup-guide').classList.add('hidden');
      window.culpmixer.run('help.guide');
    });
    await page.waitForTimeout(200);
    const reopened = await page.evaluate(
      () => !document.querySelector('.setup-guide').classList.contains('hidden'),
    );
    assert.ok(reopened, 'the guide could not be reopened from the Help command');

    await page.evaluate(() => {
      document.querySelector('.setup-guide').classList.add('hidden');
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
    });
  });

  test('a pending crash recovery does not suppress the guide', async () => {
    // These were mutually exclusive at first, on the theory that a recovery
    // offer is more urgent. It backfired: closing the tab writes an autosave,
    // so almost every launch after the first has something to offer, and
    // anyone who quit without ticking the box never saw the guide again.
    // They occupy different corners and can both be up.
    const both = await page.evaluate(() => {
      const bar = document.querySelector('.recovery-bar');
      const guide = document.querySelector('.setup-guide');
      if (!bar || !guide) return { missing: true };
      // Stand both up the way a boot with a recovery copy would.
      bar.classList.remove('hidden');
      guide.classList.remove('hidden');
      const barBox = bar.getBoundingClientRect();
      const guideBox = guide.getBoundingClientRect();
      const overlap = !(barBox.bottom <= guideBox.top || guideBox.bottom <= barBox.top
        || barBox.right <= guideBox.left || guideBox.right <= barBox.left);
      bar.classList.add('hidden');
      guide.classList.add('hidden');
      return { missing: false, overlap, barHeight: barBox.height, guideTop: guideBox.top };
    });
    assert.equal(both.missing, false, 'the recovery bar or the guide is not in the document');
    assert.equal(both.overlap, false, 'the recovery bar and the guide cover each other');
  });

  test('walking the guide to the end closes it without touching the preference', async () => {
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: true });
      document.querySelector('.setup-guide').classList.add('hidden');
      window.culpmixer.run('help.guide');
    });
    await page.waitForTimeout(200);
    const cards = await page.evaluate(() => document.querySelectorAll('.setup-dot').length);
    for (let i = 0; i < cards; i++) {
      await page.click('.setup-foot .btn.primary');
      await page.waitForTimeout(120);
    }
    const after = await page.evaluate(() => ({
      open: !document.querySelector('.setup-guide').classList.contains('hidden'),
      preference: window.culpmixer.editor.preferences.showGuideOnStart,
    }));
    assert.equal(after.open, false, 'reaching the last card did not close the guide');
    // Finishing it is not the same as asking never to see it again; only the
    // checkbox means that.
    assert.equal(after.preference, true, 'finishing the guide silently turned it off');

    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
    });
  });

  // --------------------------------------------------------- navigation
  //
  // The Culp Mixer is used on laptops, and a laptop has no middle mouse button. Every
  // one of these drives the real canvas through real input events, because
  // the failure being guarded against was never in the camera maths — it was
  // in what the browser reports and what the app does with it.

  /** The camera's orbit state, as the app currently holds it. */
  const cameraState = () => page.evaluate(() => {
    const c = window.culpmixer.editor.camera;
    return { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: [c.target.x, c.target.y, c.target.z] };
  });

  test('a two-finger flick zooms smoothly instead of slamming into the model', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    // A trackpad reports a flick as a long stream of small deltas. Treating
    // each as a full wheel detent took the distance from 11 to the near
    // clamp in a fraction of a second, and there was no way back out.
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4);
    const after = await cameraState();
    assert.ok(after.distance < before.distance, 'the flick did not zoom in at all');
    assert.ok(
      after.distance > before.distance * 0.5,
      `40 trackpad events took the camera from ${before.distance} to ${after.distance}`,
    );
  });

  test('scrolling zooms towards the cursor, not the middle of the screen', async () => {
    await resetScene(page);
    const before = await cameraState();
    // Off to one side, well inside the viewport.
    await page.mouse.move(centre.x - 260, centre.y + 120);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -30);
    const off = await cameraState();
    const moved = (s) => Math.hypot(...s.target.map((v, i) => v - before.target[i]));
    assert.ok(off.distance < before.distance, 'scrolling did not zoom');
    assert.ok(moved(off) > 0.5, `zooming at a corner barely moved the pivot: ${moved(off)}`);

    // And the middle stays the middle. Not to the last decimal — a real
    // pointer lands on a whole pixel and the middle of the canvas may not be
    // one — but nowhere near what an off-centre scroll does.
    await resetScene(page);
    await page.mouse.move(Math.round(centre.x), Math.round(centre.y));
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -30);
    const middle = await cameraState();
    assert.ok(middle.distance < before.distance);
    assert.ok(moved(middle) < 0.02, `zooming at the centre moved the pivot by ${moved(middle)}`);
  });

  test('Option with a two-finger scroll turns the view', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    await page.keyboard.down('Alt');
    for (let i = 0; i < 10; i++) await page.mouse.wheel(-20, 0);
    await page.keyboard.up('Alt');
    const after = await cameraState();
    assert.notEqual(after.yaw, before.yaw, 'Option + scroll did not orbit');
    assert.ok(
      Math.abs(after.distance - before.distance) < 1e-6,
      `orbiting also changed the distance, ${before.distance} to ${after.distance}`,
    );
  });

  test('Option and Shift with a scroll slides the view', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    await page.keyboard.down('Shift');
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 30);
    await page.keyboard.up('Shift');
    const after = await cameraState();
    assert.notDeepEqual(after.target, before.target, 'Shift + scroll did not pan');
    assert.ok(Math.abs(after.yaw - before.yaw) < 1e-9, 'panning also turned the view');
  });

  test('Option and drag orbits, and letting go of Option does not eat the selection', async () => {
    // Navigation used to be re-read from the keys on every move event, so a
    // finger coming off Option part way through an orbit turned the rest of
    // the drag into a box select — which then applied on release and wiped
    // whatever was selected.
    await resetScene(page);
    await page.evaluate(() => {
      window.culpmixer.run('add.cube');
      window.culpmixer.editor.frameSelected();
    });
    await page.waitForTimeout(120);
    const before = await cameraState();
    const selected = await page.evaluate(() => window.culpmixer.editor.scene.selection.size);
    assert.equal(selected, 1, 'the cube should start selected');

    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(centre.x + 60, centre.y + 10, { steps: 6 });
    await page.keyboard.up('Alt');
    await page.mouse.move(centre.x + 120, centre.y + 20, { steps: 6 });
    await page.mouse.up();

    const after = await cameraState();
    assert.notEqual(after.yaw, before.yaw, 'Option + drag did not orbit');
    assert.equal(
      await page.evaluate(() => window.culpmixer.editor.scene.selection.size),
      1,
      'releasing Option mid-orbit threw the selection away',
    );
    assert.equal(
      await page.evaluate(() => !!window.culpmixer.editor.boxSelectRect),
      false,
      'a box select was left running after the orbit',
    );
  });

  // ----------------------------------------------------- photograph to model

  test('a photograph comes out as a closed, textured, three-dimensional model', async () => {
    await resetScene(page);
    const built = await page.evaluate(async () => {
      // A blue object on a warm floor, mixed so the two are the same
      // brightness to within a point. No threshold anywhere separates them —
      // the only thing that tells them apart is colour, which is exactly the
      // photograph the old mask could not do anything with.
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 300;
      const g = c.getContext('2d');
      const image = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 120) / 70) ** 2 + ((y - 150) / 100) ** 2 < 1;
          const n = ((x * 7 + y * 13) % 29) - 14;
          image.data[o] = (inside ? 60 : 150) + n;
          image.data[o + 1] = (inside ? 80 : 70) + n;
          image.data[o + 2] = (inside ? 200 : 40) + n;
          image.data[o + 3] = 255;
        }
      }
      g.putImageData(image, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      const file = new File([blob], 'subject.png', { type: 'image/png' });
      window.culpmixer.app.properties.openCreate(file);

      const editor = window.culpmixer.editor;
      for (let i = 0; i < 200 && editor.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const object = [...editor.scene.objects.values()][0];
      if (!object || !object.mesh) return { ok: false };
      const mesh = object.mesh;
      const box = mesh.bounds();

      // Every edge shared by exactly two faces: a shell that only looks solid
      // fails at the first boolean or export.
      const edges = new Map();
      for (const loop of mesh.faces) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      const material = editor.scene.materials[object.materialSlots[0] ?? 0];
      return {
        ok: true,
        faces: mesh.faceCount,
        hasUV: mesh.hasUV,
        openEdges: [...edges.values()].filter((n) => n !== 2).length,
        depth: box.max.y - box.min.y,
        height: box.max.z - box.min.z,
        width: box.max.x - box.min.x,
        floor: box.min.z,
        textures: editor.scene.textures.length,
        texture: material ? material.baseColorTexture : null,
      };
    });

    assert.equal(built.ok, true, 'no object was created from the photograph');
    assert.ok(built.faces > 500, `only ${built.faces} faces came out of the photograph`);
    assert.equal(built.hasUV, true, 'the model has no texture coordinates, so the photo cannot go on it');
    assert.equal(built.openEdges, 0, `${built.openEdges} edges are not shared by exactly two faces`);
    assert.equal(built.textures, 1, 'the photograph was not stored as a texture');
    assert.ok(built.texture !== null, 'the material is not using the photograph');
    // A cut-out would be flat. This has to have depth, and it has to come
    // from the subject's own width rather than a number someone typed.
    assert.ok(built.depth > 0.3, `the model is ${built.depth.toFixed(3)} deep, which is a sticker`);
    // Upright and on the floor: the scene is Z-up and its front view looks
    // along +Y, so a photograph has to stand rather than lie face up.
    assert.ok(Math.abs(built.height - 2) < 0.01, `the model stands ${built.height}, not the 2 asked for`);
    assert.ok(built.height > built.width, 'a subject taller than it is wide came out lying down');
    assert.ok(Math.abs(built.floor) < 1e-6, 'the model is not standing on the floor');
  });

  test('the photographed model actually renders, with the photograph on it', async () => {
    // The mesh existing and the mesh being drawn are different claims, and
    // the texture path in particular can fail without saying anything.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      // Material shading is the only mode that shows a texture, and it lights
      // the scene from the scene's own lights — of which a wiped scene has
      // none. Both are set here rather than assumed: this test is about what
      // is on the surface, so it is lit flat by ambient and the question is
      // only whether the photograph's own colours come through.
      ed.options.shading = 'material';
      ed.options.showDiff = false;
      ed.options.xray = false;
      ed.stopComparing();
      ed.scene.world.ambient = 1;
      // Framed on the model, then deselected: the selection outline is drawn
      // over the model and would otherwise be what got sampled.
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);
      ed.frameSelected();
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
    });
    await page.waitForTimeout(400);
    const [middle, left, corner] = await samplePixels(page, [[0.5, 0.5], [0.44, 0.52], [0.03, 0.04]]);
    assert.ok(
      luma(middle) > luma(corner) + 12 || luma(left) > luma(corner) + 12,
      `nothing drew where the model should be: ${JSON.stringify({ middle, left, corner })}`,
    );
    // The subject in the photograph is strongly blue. A model wearing its own
    // photograph comes out blue; one that dropped the texture comes out the
    // default grey, where the channels sit on top of each other.
    assert.ok(
      middle[2] > middle[0] * 1.3,
      `the model rendered ${JSON.stringify(middle)}, which is not the blue of the photograph`,
    );
  });

  test('selecting the model does not paint over the photograph', async () => {
    // Selecting an object tints it, and the tint used to be mixed into linear
    // radiance using an interface colour written for the screen. In linear
    // terms that colour is far brighter than a lit surface, so a tint of a
    // tenth put in most of the pixel: a model wearing a photograph turned
    // into a flat orange wash the moment it was selected — which is the
    // moment it is created, so the headline feature showed its result and hid
    // it in the same frame. Nobody noticed for weeks because the test above
    // deselects before it looks.
    //
    // The same sample, taken with the model selected. It still has to be the
    // blue of the photograph.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      // At the flat white ambient the test above uses, the surface is bright
      // enough to survive even a tint that is wrong, so the bug hides. This
      // is a brightness a lit scene actually produces.
      ed.scene.world.ambient = 0.3;
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);
      ed.requestRender();
    });
    await page.waitForTimeout(400);
    const [middle, left] = await samplePixels(page, [[0.5, 0.5], [0.44, 0.52]]);
    for (const [name, px] of [['middle', middle], ['left', left]]) {
      assert.ok(
        px[2] > px[0] * 1.3,
        `selected, the ${name} of the model rendered ${JSON.stringify(px)} — the photograph is under a wash`,
      );
    }
  });

  test('the selection outline stays outside the model it outlines', async () => {
    // The outline is an inverted hull: the mesh again, pushed out along its
    // normals, back faces only, so what is left over is a rim. On a dense
    // organic mesh with a thin lip round it — which is exactly what a
    // photograph produces — the pushed-out far side comes through the near
    // side, and the model wears a hatch of orange slivers that reads as
    // broken geometry rather than as selection.
    //
    // Where the model is on screen is read out of the picture rather than
    // guessed at, because the slivers do not appear in the middle: they
    // gather where the surface turns edge-on, which is off to the side and
    // moves with the framing.
    const hits = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      // Lit flat and bright, so "is this pixel the model" is not a judgement
      // call. Whether the hull comes through does not depend on the lighting
      // — the outline is drawn over the top of it — and the orange it is
      // drawn in is nothing a blue subject on a brown floor produces.
      ed.scene.world.ambient = 1;
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);

      // Drawn and read in the same task: a WebGL drawing buffer is discarded
      // the moment the browser composites, so anything later sees an empty
      // canvas — which reads as "no model on screen" rather than as a failure
      // to look.
      const gl = ed.renderer.gl;
      ed.renderNow();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      // The viewport behind the model is nearly black with a dim grid.
      const model_ = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) model_[j] = luma(i) > 60 ? 1 : 0;

      // Well inside the silhouette: the rim is a few pixels wide, so a pixel
      // with model this far away on all four sides is not on the rim.
      const R = 10;
      const interior = (x, y) => (
        x >= R && y >= R && x + R < w && y + R < h
        && model_[y * w + x] && model_[y * w + x - R] && model_[y * w + x + R]
        && model_[(y - R) * w + x] && model_[(y + R) * w + x]
      );

      let orange = 0;
      let inside = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!interior(x, y)) continue;
          inside++;
          const i = (y * w + x) * 4;
          // The outline colour is a strong orange: red well ahead of green,
          // green well ahead of blue. Nothing in a photograph of a blue
          // subject on a brown floor reaches it.
          if (px[i] > 170 && px[i] > px[i + 1] * 1.35 && px[i + 1] > px[i + 2] * 1.6) orange++;
        }
      }
      return { orange, inside };
    });

    assert.ok(hits.inside > 5000, `only ${hits.inside} pixels of model to look at`);
    assert.ok(
      hits.orange <= hits.inside * 0.002,
      `${hits.orange} of ${hits.inside} pixels inside the model are outline coloured — the hull is coming through`,
    );
  });

  test('rebuilding a photo does not pile up materials and textures', async () => {
    // The object is rebuilt on every settings change, and the texture is
    // applied on every rebuild. Making a fresh material each time meant one
    // per slider event — hundreds of identical orphans in the material list
    // and every one of them written into the saved file.
    const counts = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const panel = window.culpmixer.app.properties.create;
      const before = { materials: ed.scene.materials.length, textures: ed.scene.textures.length };
      for (let i = 0; i < 12; i++) {
        panel.photo.depthScale = 0.5 + i * 0.05;
        panel.generate(true);
      }
      await new Promise((ok) => setTimeout(ok, 400));
      const object = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      const material = ed.scene.materials[object.materialSlots[0]];
      return {
        before,
        after: { materials: ed.scene.materials.length, textures: ed.scene.textures.length },
        slots: object.materialSlots.length,
        textured: material ? material.baseColorTexture : null,
      };
    });

    assert.equal(counts.after.materials, counts.before.materials, `twelve rebuilds added ${counts.after.materials - counts.before.materials} materials`);
    assert.equal(counts.after.textures, counts.before.textures, `twelve rebuilds added ${counts.after.textures - counts.before.textures} textures`);
    // And the model still wears the photograph after all of that.
    assert.equal(counts.slots, 1);
    assert.ok(counts.textured !== null, 'the model lost its texture while being rebuilt');
  });

  test('Cut Out wears the photograph and takes the correction brush', async () => {
    // Cut Out is the fastest route and the one people reach for first. It
    // used to hand back bare grey geometry: no coordinates, no picture, and
    // a brush that did nothing because this route finds its subject with a
    // brightness threshold rather than the colour models the brush fed.
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const panel = window.culpmixer.app.properties.create;
      const buttons = [...document.querySelectorAll('.mode-btn')];
      const cutOut = buttons.find((b) => b.textContent.trim() === 'Cut Out');
      if (!cutOut) return { ok: false, why: 'no Cut Out button' };
      const saved = { ...panel.mask };
      // Start the cut-out from nothing. Left in place, the photo model's own
      // material would still be on the object and the test would pass on a
      // build that never textured anything.
      ed.scene.remove(panel.targetId);
      panel.targetId = null;
      panel.photoMaterial = null;
      cutOut.click();
      // Nothing about this picture's brightness separates the subject from
      // the floor — that is what it was drawn for — but its blue channel
      // does, so the threshold route has something to work with.
      panel.mask.channel = 'blue';
      panel.mask.threshold = 0.5;
      panel.generate(true);
      await new Promise((ok) => setTimeout(ok, 300));

      const object = ed.scene.get(panel.targetId);
      if (!object || !object.mesh) return { ok: false, why: 'nothing was built' };
      const cut = object.mesh;
      const material = ed.scene.materials[object.materialSlots[0] ?? 0];

      // Every coordinate has to be on the picture, and the brush has to move
      // the outline. Painting a wide band of background over the left half
      // should take that side off the model.
      let offPicture = 0;
      for (let f = 0; f < cut.faces.length; f++) {
        const uv = cut.uvFor(f);
        if (!uv) { offPicture++; continue; }
        for (const t of uv) if (!(t >= 0 && t <= 1)) offPicture++;
      }
      const before = cut.bounds().size().x;

      const bitmap = panel.bitmap;
      panel.brush.mode = 'background';
      const hints = new Uint8Array(bitmap.width * bitmap.height);
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width / 2; x++) hints[y * bitmap.width + x] = 2;
      }
      panel.hints = hints;
      panel.generate(true);
      await new Promise((ok) => setTimeout(ok, 300));
      const after = ed.scene.get(panel.targetId)?.mesh?.bounds().size().x ?? 0;

      const result = {
        ok: true,
        faces: cut.faceCount,
        hasUV: cut.hasUV,
        offPicture,
        texture: material ? material.baseColorTexture : null,
        // A cut-out is a flat slab of exactly the depth asked for. The photo
        // route's inflated shell is not, so this says which one was measured.
        slab: cut.bounds().size().y,
        depth: panel.silhouette.depth,
        before,
        after,
      };

      // Hand the panel back exactly as it was found: the tests after this one
      // share this reference, and a stray mark or threshold would be their
      // failure rather than this one's.
      panel.hints = null;
      Object.assign(panel.mask, saved);
      buttons.find((b) => b.textContent.trim() === 'Photo').click();
      await new Promise((ok) => setTimeout(ok, 600));
      return result;
    });

    assert.equal(out.ok, true, out.why);
    assert.ok(out.faces > 20, `only ${out.faces} faces came out of the cut-out`);
    assert.ok(Math.abs(out.slab - out.depth) < 1e-6,
      `the object measured is ${out.slab} deep, not the ${out.depth} slab Cut Out makes`);
    assert.equal(out.hasUV, true, 'the cut-out has no texture coordinates');
    assert.equal(out.offPicture, 0, `${out.offPicture} coordinates are off the picture`);
    assert.ok(out.texture !== null, 'the cut-out is not wearing the photograph');
    assert.ok(out.after < out.before * 0.75,
      `marking half the frame as background left the model ${out.after.toFixed(2)} wide, was ${out.before.toFixed(2)}`);
  });

  // ------------------------------------------------ the mode buttons work

  const modeButtons = () => page.evaluate(() => [...document.querySelectorAll('.mode-opt')].map((b) => ({
    label: b.textContent.trim(),
    active: b.classList.contains('active'),
    dimmed: b.classList.contains('unavailable'),
    title: b.title,
  })));
  const clickMode = async (label) => {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll('.mode-opt')].find((x) => x.textContent.trim() === l);
      if (!b) throw new Error(`no ${l} button`);
      b.click();
    }, label);
    await page.waitForTimeout(150);
  };

  test('Edit and Sculpt work on the one object in the scene without selecting it first', async () => {
    // Reported as "these buttons don't work". They were wired correctly and
    // did nothing, because The Culp Mixer starts with nothing active and clicking empty
    // space puts it back there — and with nothing active they refused, looked
    // exactly like buttons that work, and said so only in a line at the bottom
    // of a crowded status bar.
    await resetScene(page);
    await page.evaluate(() => window.culpmixer.run('add.cube'));
    await page.waitForTimeout(120);
    // Deselect, the way clicking empty space does.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.changed();
    });
    await page.waitForTimeout(120);

    assert.deepEqual(
      (await modeButtons()).map((b) => b.dimmed),
      [false, false, false],
      'the buttons look unavailable when there is an obvious object to use',
    );

    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.culpmixer.editor.mode), 'edit', 'Edit did nothing');
    // And it selected what it chose, so leaving Edit Mode does not drop back
    // into a scene with nothing selected and a dead button again.
    assert.equal(await page.evaluate(() => window.culpmixer.editor.scene.selection.size), 1);

    await clickMode('Sculpt');
    assert.equal(await page.evaluate(() => window.culpmixer.editor.mode), 'sculpt', 'Sculpt did nothing');
    await clickMode('Object');
    assert.equal(await page.evaluate(() => window.culpmixer.editor.mode), 'object');
  });

  test('a button that cannot act looks like it and says why', async () => {
    await resetScene(page);
    const empty = await modeButtons();
    assert.equal(empty.find((b) => b.label === 'Edit').dimmed, true, 'Edit looks usable with an empty scene');
    assert.equal(empty.find((b) => b.label === 'Sculpt').dimmed, true);
    assert.equal(empty.find((b) => b.label === 'Object').dimmed, false, 'Object Mode is always available');
    assert.match(empty.find((b) => b.label === 'Edit').title, /Add a mesh first/);

    // Clicking anyway still answers, rather than swallowing the press: a
    // disabled button would explain nothing to the one person who tries it.
    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.culpmixer.editor.mode), 'object');
    assert.match(
      await page.evaluate(() => window.culpmixer.editor.statusMessage ?? ''),
      /Add a mesh first/,
    );

    // Two meshes and nothing selected is a real question, so it is asked.
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      window.culpmixer.run('add.cube');
      window.culpmixer.run('add.uvsphere');
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.changed();
    });
    await page.waitForTimeout(150);
    const ambiguous = await modeButtons();
    assert.equal(ambiguous.find((b) => b.label === 'Edit').dimmed, true, 'two candidates should not be guessed between');
    assert.match(ambiguous.find((b) => b.label === 'Edit').title, /Click the object/);
    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.culpmixer.editor.mode), 'object');
  });

  test('an empty Build box asks for a sentence instead of doing nothing', async () => {
    await resetScene(page);
    const result = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const input = document.querySelector('.build-bar input, input.build-input');
      if (input) input.value = '';
      document.querySelector('button.build-go')?.click();
      return { status: ed.statusMessage, focused: document.activeElement === input, objects: ed.scene.objects.size };
    });
    assert.match(result.status, /Say what to build/, 'Go with an empty box said nothing');
    assert.equal(result.focused, true, 'the cursor was not put where the words go');
    assert.equal(result.objects, 0, 'an empty prompt built something anyway');
  });

  test('opening a file gives you that file, not the last one mixed into it', async () => {
    // Undo and File > Open both replaced the whole scene by assigning a
    // remembered list of fields, and both lists were missing textures and the
    // timeline. So opening a file kept the previous scene's images and threw
    // the file's away — and because a material names its texture by id,
    // opening a photo model while a checker happened to hold id 1 put the
    // checker on the model.
    await resetScene(page);
    const result = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const settle = () => new Promise((ok) => setTimeout(ok, 120));

      window.culpmixer.run('add.cube');
      window.culpmixer.run('material.checker');
      await settle();
      ed.scene.timeline.end = 90;
      const file = JSON.parse(JSON.stringify(ed.scene.toJSON()));

      // Work on something else in between, as anyone would.
      ed.loadSceneJSON({ objects: [], order: [], materials: [], textures: [] });
      await settle();
      window.culpmixer.run('add.uvsphere');
      window.culpmixer.run('material.checker');
      await settle();
      // Two more images than the file carries, pushed straight in so the test
      // is about what opening a file does rather than about which command
      // happens to create a texture.
      ed.scene.textures.push(
        { id: 900, name: 'leftover A', url: 'data:image/png;base64,AAAA', width: 8, height: 8 },
        { id: 901, name: 'leftover B', url: 'data:image/png;base64,BBBB', width: 8, height: 8 },
      );
      const between = ed.scene.textures.length;

      ed.loadSceneJSON(file);
      await settle();
      return {
        between,
        fileTextures: file.textures.length,
        fileTimelineEnd: file.timeline.end,
        openedTextures: ed.scene.textures.length,
        openedNames: ed.scene.textures.map((t) => t.name),
        openedTimelineEnd: ed.scene.timeline.end,
        danglingMaterials: ed.scene.materials.filter(
          (m) => m.baseColorTexture !== null && !ed.scene.textures.some((t) => t.id === m.baseColorTexture),
        ).length,
      };
    });

    assert.ok(result.between > result.fileTextures, 'the in-between scene needs more images than the file for this to test anything');
    assert.equal(result.openedTextures, result.fileTextures, `opened a ${result.fileTextures}-image file and got ${result.openedTextures} images`);
    assert.equal(result.danglingMaterials, 0, 'a material points at an image that is not in the scene — that surface renders untextured');
    assert.equal(result.openedTimelineEnd, result.fileTimelineEnd, 'the previous scene\'s frame range survived the open');
  });

  test('undoing a texture takes the texture with it', async () => {
    // Adding a UV checker and undoing left a 33 KB embedded PNG in the
    // document for good, and in every save from then on.
    await resetScene(page);
    const counts = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      window.culpmixer.run('add.cube');
      const before = ed.scene.textures.length;
      for (let i = 0; i < 3; i++) {
        window.culpmixer.run('material.checker');
        await new Promise((ok) => setTimeout(ok, 80));
        window.culpmixer.run('edit.undo');
        await new Promise((ok) => setTimeout(ok, 80));
      }
      return { before, after: ed.scene.textures.length, saved: ed.scene.toJSON().textures.length };
    });
    assert.equal(counts.after, counts.before, `three add-and-undo cycles left ${counts.after - counts.before} images behind`);
    assert.equal(counts.saved, counts.before, 'the leftover images would have been written into the saved file');
  });

  test('the whole journey: photo in, model out, saved, reopened, edited, exported', async () => {
    // Each step of this has a test of its own. This one is the chain, because
    // the chain is what somebody actually does, and every fault found in this
    // session lived in a seam between two steps that each worked.
    await resetScene(page);
    const journey = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));

      // 1. Drop a photograph on the window.
      const c = document.createElement('canvas');
      c.width = 160; c.height = 220;
      const g = c.getContext('2d');
      const img = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 80) / 48) ** 2 + ((y - 110) / 78) ** 2 < 1;
          const n = ((x * 7 + y * 13) % 29) - 14;
          img.data[o] = (inside ? 60 : 150) + n;
          img.data[o + 1] = (inside ? 80 : 70) + n;
          img.data[o + 2] = (inside ? 200 : 40) + n;
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.culpmixer.app.properties.openCreate(new File([blob], 'thing.png', { type: 'image/png' }));
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) await settle(50);
      const built = {
        faces: [...ed.scene.objects.values()][0]?.mesh?.faceCount ?? 0,
        textures: ed.scene.textures.length,
      };

      // 2. Save it.
      const file = JSON.parse(JSON.stringify(ed.scene.toJSON()));

      // 3. Do something else, then reopen it — the seam that was broken.
      ed.loadSceneJSON({ objects: [], order: [], materials: [], textures: [] });
      await settle();
      window.culpmixer.run('add.cube');
      window.culpmixer.run('material.checker');
      await settle();
      ed.loadSceneJSON(file);
      await settle(250);

      const object = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      const material = ed.scene.materials[object.materialSlots[0] ?? 0];
      const reopened = {
        faces: object.mesh.faceCount,
        hasUV: object.mesh.hasUV,
        textures: ed.scene.textures.length,
        textureName: ed.scene.textures[0]?.name,
        materialTexture: material?.baseColorTexture ?? null,
        dangling: material && material.baseColorTexture !== null
          && !ed.scene.textures.some((t) => t.id === material.baseColorTexture),
      };

      // 4. Edit it, the way the header button does.
      ed.selectObject(null);
      ed.setMode('edit');
      const editing = { mode: ed.mode, selected: ed.scene.selection.size };
      window.culpmixer.run('select.all');
      window.culpmixer.run('mesh.subdivide');
      await settle();
      const subdivided = ed.editMesh?.faceCount ?? 0;
      window.culpmixer.run('edit.undo');
      await settle();
      const afterUndo = ed.editMesh?.faceCount ?? 0;
      ed.setMode('object');

      // 5. Export it, through the real command, and read what it wrote.
      //
      // Chrome saves to a file the person picks, and that picker needs a live
      // user gesture it cannot have inside a script. This is the documented
      // fallback path — the one Firefox and Safari always take — so it is
      // taken here on purpose rather than worked around.
      const realPicker = window.showSaveFilePicker;
      delete window.showSaveFilePicker;
      const written = [];
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { written.push(blob); return realCreate.call(URL, blob); };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      window.culpmixer.run('file.exportGltf');
      await settle();
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
      if (realPicker) window.showSaveFilePicker = realPicker;
      const gltf = JSON.parse(await written[written.length - 1].text());
      return {
        built, reopened, editing, subdivided, afterUndo,
        gltf: {
          images: gltf.images?.length ?? 0,
          uv: gltf.meshes?.[0]?.primitives?.[0]?.attributes?.TEXCOORD_0 !== undefined,
          // Whichever material carries the picture — the default one is
          // still in the list and is not it.
          usesTexture: (gltf.materials ?? [])
            .map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index)
            .find((i) => i !== undefined),
          materials: gltf.materials?.length ?? 0,
        },
      };
    });

    assert.ok(journey.built.faces > 500, `the photograph produced ${journey.built.faces} faces`);
    assert.equal(journey.built.textures, 1, 'the photograph was not stored with the model');

    assert.equal(journey.reopened.faces, journey.built.faces, 'reopening changed the model');
    assert.equal(journey.reopened.hasUV, true, 'reopening lost the texture coordinates');
    assert.equal(journey.reopened.textures, 1, `reopening left ${journey.reopened.textures} images in a one-image scene`);
    assert.equal(journey.reopened.textureName, 'thing', 'the reopened model is wearing the wrong picture');
    assert.equal(journey.reopened.dangling, false, 'the material points at an image that is not there');

    assert.equal(journey.editing.mode, 'edit', 'Edit Mode refused the model that was just opened');
    assert.ok(journey.subdivided > journey.built.faces, 'subdividing did nothing');
    assert.equal(journey.afterUndo, journey.built.faces, 'undo did not put the model back');

    assert.equal(journey.gltf.images, 1, 'the export dropped the photograph');
    assert.equal(journey.gltf.uv, true, 'the export dropped the texture coordinates');
    assert.equal(
      journey.gltf.usesTexture, 0,
      `none of the ${journey.gltf.materials} exported materials uses the photograph`,
    );
  });

  test('New Scene leaves nothing of the last one behind', async () => {
    // It removed the objects and stopped, so the materials and the embedded
    // images of whatever had been open stayed — and went into the next file
    // saved. Start something new after a photo model and you shipped the old
    // photograph inside it.
    const after = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      window.culpmixer.run('add.cube');
      window.culpmixer.run('material.checker');
      await new Promise((ok) => setTimeout(ok, 120));
      const loaded = { materials: ed.scene.materials.length, textures: ed.scene.textures.length };
      // New Scene now asks before throwing away unsaved work, so this answers
      // it the way somebody starting fresh would.
      window.culpmixer.run('file.new');
      await new Promise((ok) => setTimeout(ok, 60));
      const asked = document.querySelector('.unsaved-dialog');
      if (asked) {
        [...asked.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Discard').click();
      }
      await new Promise((ok) => setTimeout(ok, 120));
      const doc = ed.scene.toJSON();
      return {
        loaded,
        asked: !!asked,
        objects: ed.scene.objects.size,
        materials: ed.scene.materials.length,
        textures: ed.scene.textures.length,
        savedTextures: doc.textures.length,
        undoable: ed.history.steps().length > 0,
      };
    });

    assert.equal(after.asked, true, 'New Scene threw away unsaved work without asking');
    assert.ok(after.loaded.textures > 0, 'the scene under test had no image to leave behind');
    assert.equal(after.objects, 0);
    assert.equal(after.textures, 0, `New Scene kept ${after.textures} image(s) from the previous one`);
    assert.equal(after.materials, 0, `New Scene kept ${after.materials} material(s) from the previous one`);
    assert.equal(after.savedTextures, 0, 'those images would have been written into the next file saved');
    // Starting a new document is one of the things people most want to undo.
    assert.equal(after.undoable, true, 'New Scene cannot be undone');
  });

  // ------------------------------------------------ the ways in

  test('dropping a photograph on the window builds a model', async () => {
    // The way anybody actually starts. Every test above reached the panel
    // through its own method; nothing had ever fired a real drop, so the
    // handler that turns a dragged file into a model was the one step of the
    // headline feature with no cover on it at all.
    await resetScene(page);
    const dropped = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 140; c.height = 190;
      const g = c.getContext('2d');
      const im = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 70) / 40) ** 2 + ((y - 95) / 62) ** 2 < 1;
          im.data[o] = inside ? 60 : 150;
          im.data[o + 1] = inside ? 85 : 72;
          im.data[o + 2] = inside ? 200 : 42;
          im.data[o + 3] = 255;
        }
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));

      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
      const mount = document.getElementById('app');
      const veil = () => document.querySelector('.drop-veil')?.classList.contains('visible');
      const fire = (type) => mount.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );

      fire('dragenter');
      const whileDragging = veil();
      fire('dragover');
      fire('drop');
      const afterDrop = veil();

      const ed = window.culpmixer.editor;
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const object = [...ed.scene.objects.values()][0];
      return {
        whileDragging,
        afterDrop,
        objects: ed.scene.objects.size,
        faces: object?.mesh?.faceCount ?? 0,
        textures: ed.scene.textures.length,
        tab: document.querySelector('.tab.active')?.textContent?.trim(),
      };
    });

    assert.equal(dropped.whileDragging, true, 'nothing showed the window would take the file');
    assert.equal(dropped.afterDrop, false, 'the drop highlight stayed up afterwards');
    assert.equal(dropped.objects, 1, 'the drop produced no model');
    assert.ok(dropped.faces > 500, `the drop produced ${dropped.faces} faces`);
    assert.equal(dropped.textures, 1, 'the dropped photograph was not kept as a texture');
    assert.equal(dropped.tab, 'Create', 'the panel did not come forward to show the result');
  });

  test('the keys people actually press do what they say', async () => {
    await resetScene(page);
    const press = async (key, opts = {}) => {
      await page.evaluate(([k, o]) => {
        document.activeElement?.blur?.();
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: k,
          code: o.code ?? `Key${k.toUpperCase()}`,
          bubbles: true,
          cancelable: true,
          ctrlKey: !!o.ctrl,
          metaKey: !!o.meta,
          shiftKey: !!o.shift,
        }));
      }, [key, opts]);
      await page.waitForTimeout(120);
    };
    const mode = () => page.evaluate(() => window.culpmixer.editor.mode);
    const count = () => page.evaluate(() => window.culpmixer.editor.scene.objects.size);

    await page.evaluate(() => window.culpmixer.run('add.cube'));
    await page.waitForTimeout(120);

    await press('Tab', { code: 'Tab' });
    assert.equal(await mode(), 'edit', 'Tab did not enter Edit Mode');
    await press('Tab', { code: 'Tab' });
    assert.equal(await mode(), 'object', 'Tab did not come back out');

    await press('k', { ctrl: true });
    assert.equal(
      await page.evaluate(() => !!document.querySelector('.palette:not(.hidden), .command-palette:not(.hidden)')),
      true,
      'Ctrl+K did not open the command palette',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);

    const before = await count();
    await press('x');
    assert.equal(await count(), before - 1, 'X did not delete the selected object');
    await press('z', { ctrl: true });
    assert.equal(await count(), before, 'Ctrl+Z did not bring it back');
  });

  test('a crash gives the work back, textures included', async () => {
    // Recovery replaces the whole scene, so it went through the same door
    // that was dropping textures and the timeline — meaning a recovered
    // session came back with the geometry and none of the pictures on it.
    await resetScene(page);
    const recovery = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));
      window.culpmixer.run('add.cube');
      window.culpmixer.run('material.checker');
      await settle();
      const saved = { objects: ed.scene.objects.size, textures: ed.scene.textures.length };

      const wrote = await ed.autosaveNow(false);
      const slots = await ed.recovery.list();

      // What a crash and restart looks like from here.
      ed.newScene();
      await settle(80);
      const wiped = { objects: ed.scene.objects.size, textures: ed.scene.textures.length };

      const doc = slots[0] ? await ed.recovery.load(slots[0].id) : null;
      if (doc) ed.loadSceneJSON(doc.scene ?? doc);
      await settle();
      return {
        wrote, saved, wiped, slots: slots.length,
        back: { objects: ed.scene.objects.size, textures: ed.scene.textures.length },
      };
    });

    assert.equal(recovery.wrote, true, 'autosave reported failure');
    assert.ok(recovery.slots > 0, 'autosave left nothing to recover from');
    assert.equal(recovery.wiped.objects, 0, 'the scene was not actually cleared before recovering');
    assert.equal(recovery.back.objects, recovery.saved.objects, 'recovery lost objects');
    assert.equal(
      recovery.back.textures, recovery.saved.textures,
      `recovery came back with ${recovery.back.textures} of ${recovery.saved.textures} pictures`,
    );
  });

  test('the recovery prompt is a strip, not the whole window', async () => {
    // The application's shell is a grid, and it declared four rows for six
    // children. The extras were auto-placed, so the moment the recovery bar
    // appeared it took the row meant for the workspace and stretched to the
    // full height of the window: opening The Culp Mixer with a recovered scene showed
    // a wall of empty brown with two enormous buttons floating in the middle
    // of it, and the 3D view squeezed into what was left.
    //
    // Nothing caught it because every test here starts from a clean store and
    // never sees the bar. This one puts a scene in the store, asks for the
    // prompt, and then measures the shell.
    const shape = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const shell = window.culpmixer.app;
      ed.addPrimitive('cube');
      await ed.autosaveNow(false);
      shell.offerRecovery();
      await new Promise((ok) => setTimeout(ok, 400));

      const bar = document.querySelector('.recovery-bar');
      const shown = bar && !bar.classList.contains('hidden');
      const rect = bar.getBoundingClientRect();
      const work = document.querySelector('.workspace').getBoundingClientRect();
      const view = document.querySelector('.viewport').getBoundingClientRect();
      return {
        shown,
        bar: Math.round(rect.height),
        workspace: Math.round(work.height),
        viewport: Math.round(view.height),
        viewportBottom: Math.round(view.bottom),
        workspaceBottom: Math.round(work.bottom),
        window: window.innerHeight,
        buttons: [...bar.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().width)),
        pageWidth: window.innerWidth,
      };
    });

    assert.equal(shape.shown, true, 'the recovery prompt never appeared, so nothing was measured');
    // One line of controls. It was the better part of 600px.
    assert.ok(
      shape.bar < shape.window * 0.12,
      `the recovery bar is ${shape.bar}px of a ${shape.window}px window`,
    );
    // And the workspace still gets the window, which is the half that matters:
    // the bar being small is no use if it pushed the 3D view off the bottom.
    assert.ok(
      shape.workspace > shape.window * 0.7,
      `the workspace was left ${shape.workspace}px of a ${shape.window}px window`,
    );
    // Buttons in this application grow to fill their container, which is right
    // in a sidebar and wrong in a strip the width of the screen.
    assert.ok(shape.buttons.length >= 2, 'the prompt has no buttons to check');
    for (const w of shape.buttons) {
      assert.ok(
        w < shape.pageWidth * 0.2,
        `a button is ${w}px wide in a ${shape.pageWidth}px window — they are stretching to fill`,
      );
    }

    // And the 3D view fits the room it was given.
    //
    // A grid item will not shrink below its own content, and this one's
    // content is a canvas with a pixel size of its own — so the viewport sized
    // itself to the canvas while the canvas sized itself to the viewport, and
    // the pair settled on whatever the first frame measured. It came out 31px
    // taller than its slot with no bar and 68px taller with one, which put the
    // bottom of the render underneath the timeline where nobody could see it.
    assert.ok(
      shape.viewportBottom <= shape.workspaceBottom + 1,
      `the 3D view runs ${shape.viewportBottom - shape.workspaceBottom}px past the bottom of its container`,
    );
    assert.ok(
      shape.viewport <= shape.workspace + 1,
      `the 3D view is ${shape.viewport}px tall in a ${shape.workspace}px space`,
    );

    await page.evaluate(() => {
      document.querySelector('.recovery-bar').classList.add('hidden');
    });
  });

  test('two strokes on the preview rescue a photograph colour cannot separate', async () => {
    // The honest limit of the photo feature is that a subject photographed
    // against something its own colour cannot be found by colour. The unit
    // tests prove the segmentation obeys a correction; this proves the
    // correction can actually be made — that a drag on the preview reaches the
    // segmenter and the model is rebuilt from it. That path is a canvas, a
    // letterboxed placement and a pointer capture, and none of it is reachable
    // from Node.
    const out = await page.evaluate(async () => {
      const W = 300, H = 380;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      const inSubject = (x, y) => ((x - 150) / 85) ** 2 + ((y - 190) / 150) ** 2 <= 1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const n = ((x * 5 + y * 11) % 17) - 8;
        // Six values apart: a difference you would struggle to see.
        const b = inSubject(x, y) ? [150, 126, 104] : [144, 120, 98];
        im.data[o] = b[0] + n; im.data[o + 1] = b[1] + n; im.data[o + 2] = b[2] + n;
        im.data[o + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.culpmixer.app.properties.openCreate(new File([blob], 'shoe.png', { type: 'image/png' }));
      const ed = window.culpmixer.editor;
      const started = ed.scene.objects.size;
      for (let i = 0; i < 300 && ed.scene.objects.size === started; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 700));

      const panel = window.culpmixer.app.properties.create;
      const verdictText = () => document.querySelector('.create-verdict')?.textContent ?? '';
      const before = {
        coverage: panel.lastCoverage,
        verdict: verdictText(),
        bad: !!document.querySelector('.create-verdict.bad'),
        hasBrush: !!document.querySelector('.brush-controls'),
      };

      const pv = document.querySelector('.ref-preview');
      const rect = pv.getBoundingClientRect();
      const stroke = async (mode, from, to) => {
        // Chosen the way a person chooses it: by pressing the button.
        const btn = [...document.querySelectorAll('.brush-modes .seg')]
          .find((b) => b.textContent.trim().toLowerCase() === mode);
        btn.click();
        const at = (t) => ({
          clientX: rect.left + (from[0] + (to[0] - from[0]) * t) * rect.width,
          clientY: rect.top + (from[1] + (to[1] - from[1]) * t) * rect.height,
        });
        pv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, ...at(0) }));
        for (let i = 1; i <= 12; i++) {
          pv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true, ...at(i / 12) }));
        }
        pv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, ...at(1) }));
        await new Promise((ok) => setTimeout(ok, 700));
      };
      await stroke('subject', [0.42, 0.5], [0.58, 0.5]);
      await stroke('background', [0.06, 0.1], [0.24, 0.1]);

      const model = [...ed.scene.objects.values()].find((o) => o.name.startsWith('Photo'));
      return {
        before,
        after: {
          coverage: panel.lastCoverage,
          verdict: verdictText(),
          good: !!document.querySelector('.create-verdict.good'),
          faces: model ? model.mesh.faceCount : 0,
        },
      };
    });

    assert.equal(out.before.hasBrush, true, 'photo mode offered no way to correct the subject');
    // Unaided, the segmenter gives up and calls the whole frame subject, and
    // the panel has to say so rather than presenting the blob as a result.
    assert.ok(out.before.coverage > 0.95, `unaided coverage was ${out.before.coverage}, expected the whole frame`);
    assert.equal(out.before.bad, true, `the panel did not report the failure: "${out.before.verdict}"`);

    // The subject really covers about 35% of that frame.
    assert.ok(
      Math.abs(out.after.coverage - 0.35) < 0.06,
      `after two strokes the subject came out at ${(out.after.coverage * 100).toFixed(1)}%, not about 35%`,
    );
    assert.equal(out.after.good, true, `the panel still reports a problem: "${out.after.verdict}"`);
    assert.ok(out.after.faces > 500, `the corrected model has ${out.after.faces} faces`);
  });

  test('a photograph with no subject to cut out still becomes geometry', async () => {
    // This is the claim the application is sold on, and it is the one thing
    // the silhouette pipeline cannot do: a picture with no single object to
    // find — a corridor, two things at different distances, converging walls.
    // There is nothing to segment and no outline to inflate, so it goes to the
    // depth network instead. If this test fails, the headline feature is gone.
    //
    // It really loads the 26MB model and really runs it, because the point is
    // that the model is bundled and works with nothing fetched from anywhere.
    const out = await page.evaluate(async () => {
      const W = 480, H = 360;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const t = y / H, horizon = 0.42;
        let r, gg, b;
        if (t < horizon) { r = 130 - t * 50; gg = 145 - t * 50; b = 170 - t * 40; }
        else {
          const f = (t - horizon) / (1 - horizon);
          r = 95 + f * 55; gg = 85 + f * 50; b = 72 + f * 40;
          if (Math.floor(f * 12) % 2 === 0) { r -= 12; gg -= 12; b -= 10; }
        }
        const edge = 0.5 - Math.abs(x / W - 0.5);
        if (t > horizon && edge < 0.06 + (1 - (t - horizon) / (1 - horizon)) * 0.18) {
          r *= 0.55; gg *= 0.55; b *= 0.6;
        }
        if (x > 300 && x < 440 && y > 250 && y < 340) { r = 195; gg = 95; b = 70; }
        if (x > 215 && x < 255 && y > 175 && y < 215) { r = 70; gg = 155; b = 195; }
        im.data[i] = r; im.data[i + 1] = gg; im.data[i + 2] = b; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.culpmixer.app.properties.openCreate(new File([blob], 'corridor.png', { type: 'image/png' }));
      const ed = window.culpmixer.editor;
      const started = ed.scene.objects.size;
      for (let i = 0; i < 300 && ed.scene.objects.size === started; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));

      // Chosen and pressed the way a person does it.
      const mode = [...document.querySelectorAll('.mode-btn')]
        .find((b) => b.textContent.trim() === 'Whole Scene');
      if (!mode) return { error: 'there is no Whole Scene mode' };
      mode.click();
      await new Promise((r) => setTimeout(r, 300));
      const build = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Build the scene');
      if (!build) return { error: 'there is no button to build a scene' };
      build.click();

      const panel = window.culpmixer.app.properties.create;
      for (let i = 0; i < 1500; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const note = panel.sceneNote?.textContent ?? '';
        if (/could not run|no surface/.test(note)) return { error: note };
        if (!/joined up/.test(note)) continue;
        // The object the panel itself built. Searching the scene for "a mesh
        // with a lot of faces" finds whatever an earlier test left lying
        // around, and then measures that instead — which is exactly what it
        // did, and reported the depth ordering backwards for an object that
        // has no depth ordering.
        const model = ed.scene.get(panel.targetId);
        if (!model || !model.mesh) return { error: `reported "${note}" but built nothing` };
        const box = model.mesh.bounds();
        // Where the two boxes ended up, in the model's own coordinates.
        const near = { x: (370 / W - 0.5), z: (0.5 - 295 / H) };
        const far = { x: (235 / W - 0.5), z: (0.5 - 195 / H) };
        const depthNear = (p) => {
          let best = null;
          let bestD = Infinity;
          for (const v of model.mesh.positions) {
            const d = (v.x / (box.max.x - box.min.x) - p.x) ** 2
              + (v.z / (box.max.z - box.min.z) - p.z) ** 2;
            if (d < bestD) { bestD = d; best = v; }
          }
          return best ? best.y : 0;
        };
        return {
          note,
          faces: model.mesh.faceCount,
          hasUV: model.mesh.hasUV,
          width: +(box.max.x - box.min.x).toFixed(2),
          depth: +(box.max.y - box.min.y).toFixed(2),
          nearBoxY: depthNear(near),
          farBoxY: depthNear(far),
          textures: ed.scene.textures.length,
          // Building over an object that already exists throws its mesh away,
          // and that used to happen with no undo step: press the button twice
          // and the first result was gone for good.
          undoRestored: (() => {
            const before = model.mesh.faceCount;
            window.culpmixer.run('edit.undo');
            const after = ed.scene.get(panel.targetId);
            const restored = !!after && !!after.mesh && after.mesh.faceCount !== before;
            window.culpmixer.run('edit.redo');
            return restored;
          })(),
          textured: (() => {
            const slot = model.materialSlots[0];
            const mat = ed.scene.materials[slot];
            return !!mat && mat.baseColorTexture != null;
          })(),
        };
      }
      return { error: 'the depth model never finished' };
    });

    assert.equal(out.error, undefined, `the scene route failed: ${out.error}`);
    assert.ok(out.faces > 5000, `the scene came out with only ${out.faces} faces`);
    assert.equal(out.hasUV, true, 'the scene has no texture coordinates, so the photo cannot go on it');
    assert.ok(out.textures >= 1, 'the photograph was not kept as a texture');
    assert.equal(out.textured, true, 'the scene is not wearing the photograph it was built from');
    assert.ok(out.depth > 0.2, `the scene is ${out.depth} deep, which is a flat sheet`);
    // The whole point: the near box has to come out nearer than the far one.
    // Nearest is towards -Y, so the near box's depth must be the smaller.
    assert.equal(out.undoRestored, true,
      'building a scene over an existing object could not be undone — the old mesh was lost');
    assert.ok(
      out.nearBoxY < out.farBoxY,
      `the near box came out at y=${out.nearBoxY.toFixed(3)} and the far one at `
      + `y=${out.farBoxY.toFixed(3)} — the depth ordering is wrong`,
    );
  });

  test('nothing runs off the side of the window, at any width', async () => {
    // The whole right-hand side of the application used to sit past the edge
    // of the screen: property fields cut in half, a Restore button reading
    // "Re", the shading controls gone entirely. Two causes, both the same
    // mistake — a box that will not shrink below its own content.
    //
    // The workspace is a 42px toolbar, a viewport and a 262px sidebar, so its
    // minimum is over a thousand pixels; as a grid item that minimum grew the
    // shell's only column, and every row stretched to match. It looked like
    // the header overflowing. The header was being dragged along by the row
    // underneath it. Separately, five labelled tabs are wider than the
    // sidebar, and that overflow widened the document by another 71px.
    //
    // Checked at several widths because each fault appeared at a different
    // one, and the wide case looked fine while the narrow case was unusable.
    const widths = [1400, 1180, 980, 880];
    const report = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(250);
      report.push(await page.evaluate(() => {
        const past = [];
        for (const el of document.querySelectorAll('#app *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // The status hint is deliberately allowed to run under its own
          // clip and ellipsis; everything else has to fit.
          if (el.closest('.status-right')) continue;
          if (r.right > window.innerWidth + 1) {
            past.push(`${el.className || el.tagName} +${Math.round(r.right - window.innerWidth)}px`);
          }
        }
        // A tab with neither an icon nor a label is a blank patch you switch
        // panels by guessing at. Hiding the labels on a narrow sidebar was
        // meant to leave the icons; the icon is a span too, so it hid those
        // as well and left five empty 12px tabs at every width up to 1180.
        const tabs = [...document.querySelectorAll('.tab')].map((t) => {
          const r = t.getBoundingClientRect();
          const visible = [...t.children].some((k) => {
            const kr = k.getBoundingClientRect();
            return kr.width > 0 && kr.height > 0;
          });
          return { h: Math.round(r.height), visible };
        });
        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          past: [...new Set(past)].slice(0, 6),
          tabs,
        };
      }));
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(250);

    for (const r of report) {
      assert.deepEqual(r.past, [], `at ${r.width}px these are off the right edge: ${r.past.join(', ')}`);
      assert.equal(
        r.documentWidth, r.width,
        `at ${r.width}px the document is ${r.documentWidth}px wide, so the layout is pushed sideways`,
      );
      assert.ok(r.tabs.length > 0, `no properties tabs found at ${r.width}px`);
      for (const t of r.tabs) {
        assert.equal(t.visible, true, `a properties tab is blank at ${r.width}px — nothing to read or aim at`);
        assert.ok(t.h > 18, `a properties tab is ${t.h}px tall at ${r.width}px`);
      }
    }
  });

  // ------------------------------------------- generate, edit, revise, review

  test('a staircase is revised to thirty steps with your work still on it', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;

      bar.focus('a staircase with 20 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      if (!root) return { ok: false, why: 'nothing was built with a record of how' };
      const steps = root.children.map((id) => ed.scene.get(id));

      // Make it yours: recolour one step, move another, add a handrail.
      const slot = ed.scene.addMaterial();
      ed.scene.materials[slot].color = [0.9, 0.1, 0.1];
      steps[0].materialSlots = [slot];
      const movedName = steps[1].name;
      steps[1].position.z += 0.5;
      const rail = ed.scene.add('mesh', 'My handrail', steps[0].mesh.clone());
      ed.scene.setParent(rail.id, root.id);
      const otherId = ed.scene.add('mesh', 'Unrelated cube', steps[0].mesh.clone()).id;
      const unrelatedBefore = JSON.stringify(ed.scene.get(otherId).mesh.toJSON());

      ed.selectObject(root.id);
      bar.focus('change this staircase from 20 steps to 30');
      await bar.revise();

      const staged = ed.revision.summary;
      if (!staged) return { ok: false, why: 'no revision was staged' };
      // Steps only: the handrail is a child too, and it is meant to be.
      const previewCount = ed.scene.get(root.id).children
        .map((id) => ed.scene.get(id))
        .filter((k) => k.partKey && k.partKey.startsWith('step#')).length;
      ed.revision.accept();

      const after = ed.scene.get(root.id);
      const kids = after.children.map((id) => ed.scene.get(id));
      const moved = kids.find((k) => k.name === movedName);
      return {
        ok: true,
        previewCount,
        stepCount: kids.filter((k) => k.partKey && k.partKey.startsWith('step#')).length,
        recolouredKept: ed.scene.materials[steps[0].materialSlots[0]].color[0] > 0.8,
        movedKept: moved ? moved.position.z : null,
        railKept: kids.some((k) => k.name === 'My handrail' && k.partKey === null),
        unrelatedUntouched: JSON.stringify(ed.scene.get(otherId).mesh.toJSON()) === unrelatedBefore,
        conflicts: staged.report.conflicts.length,
        revision: after.provenance.revision,
        undoDepth: ed.history.depth,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.previewCount, 30, 'the preview was not visible in the scene');
    assert.equal(out.stepCount, 30, 'the revision did not reach thirty steps');
    assert.equal(out.recolouredKept, true, 'the step you recoloured lost its material');
    assert.ok(out.movedKept !== null && out.movedKept > 0.4, 'the step you moved was moved back');
    assert.equal(out.railKept, true, 'your own handrail was thrown away');
    assert.equal(out.unrelatedUntouched, true, 'an unrelated object was touched');
    assert.equal(out.conflicts, 0, 'nothing here actually disagreed');
    assert.equal(out.revision, 1);
  });

  test('a sculpted object reports a conflict instead of losing the sculpt', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      const target = ed.scene.get(root.children[3]);

      // Sculpt it, and unwrap it, so there is something with nowhere to go.
      for (const p of target.mesh.positions) p.z += 0.2;
      target.mesh.faceUV = target.mesh.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]);
      target.mesh.markDirty();
      const sculpted = JSON.stringify(target.mesh.toJSON());

      ed.selectObject(root.id);
      bar.focus('make it much bigger');
      await bar.revise();
      const staged = ed.revision.summary;
      if (!staged) return { ok: false, why: 'no revision was staged' };
      const conflict = staged.report.conflicts.find((c) => c.objectId === target.id);
      const keptDuringPreview = JSON.stringify(ed.scene.get(target.id).mesh.toJSON()) === sculpted;
      ed.revision.accept();
      return {
        ok: true,
        conflict: conflict ? { kind: conflict.kind, detail: conflict.detail } : null,
        keptDuringPreview,
        keptAfterAccept: JSON.stringify(ed.scene.get(target.id).mesh.toJSON()) === sculpted,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.ok(out.conflict, 'the sculpt was replaced with no conflict reported');
    assert.match(out.conflict.detail, /UV coordinates/,
      'the conflict did not say what could not come across');
    assert.equal(out.keptDuringPreview, true, 'the preview overwrote the sculpt');
    assert.equal(out.keptAfterAccept, true, 'accepting a revision destroyed a conflicted object');
  });

  test('rejecting a revision leaves the scene untouched; accepting it is one undo', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 12 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      ed.selectObject(root.id);

      const strip = (s) => { const d = JSON.parse(s); delete d.nextId; return JSON.stringify(d); };
      const before = strip(JSON.stringify(ed.scene.toJSON()));
      const depthBefore = ed.history.depth;

      bar.focus('make it 20 steps');
      await bar.revise();
      const previewed = ed.scene.get(root.id).children.length;
      ed.revision.reject();
      const afterReject = strip(JSON.stringify(ed.scene.toJSON()));

      bar.focus('make it 20 steps');
      await bar.revise();
      ed.revision.accept();
      const afterAccept = ed.scene.get(root.id).children.length;
      const depthAfter = ed.history.depth;

      ed.undo();
      const afterUndo = strip(JSON.stringify(ed.scene.toJSON()));
      const undoneCount = [...ed.scene.objects.values()].find((o) => o.provenance).children.length;
      ed.redo();
      const redoneCount = [...ed.scene.objects.values()].find((o) => o.provenance).children.length;

      // Save, reopen, and check the record came back with the geometry.
      const doc = JSON.parse(JSON.stringify(ed.scene.toJSON()));
      ed.loadSceneJSON(doc);
      const reopened = [...ed.scene.objects.values()].find((o) => o.provenance);
      const outliner = [...ed.scene.walk()].map((w) => w.obj.id);
      return {
        previewed,
        rejectRestored: afterReject === before,
        rejectAddedHistory: ed.history.depth !== depthBefore && afterReject === before,
        afterAccept,
        oneStep: depthAfter - depthBefore,
        undoRestored: afterUndo === before,
        undoneCount,
        redoneCount,
        reopened: reopened
          ? {
            steps: reopened.children.length,
            revision: reopened.provenance.revision,
            count: reopened.provenance.params.count,
            keys: reopened.children.map((id) => ed.scene.get(id).partKey).filter(Boolean).length,
          }
          : null,
        duplicatedInOutliner: outliner.length !== new Set(outliner).size,
      };
    });

    assert.equal(out.previewed, 20, 'the preview was not applied to the scene');
    assert.equal(out.rejectRestored, true, 'rejecting changed the scene');
    assert.equal(out.afterAccept, 20);
    assert.equal(out.oneStep, 1, `accepting a 20-part revision cost ${out.oneStep} undo steps`);
    assert.equal(out.undoRestored, true, 'undo did not restore geometry, records and relationships together');
    assert.equal(out.undoneCount, 12);
    assert.equal(out.redoneCount, 20, 'redo did not put the revision back');
    assert.ok(out.reopened, 'the reopened file had no generated asset');
    assert.equal(out.reopened.steps, 20, 'the geometry did not survive save and reopen');
    assert.equal(out.reopened.revision, 1, 'the revision count did not survive');
    assert.equal(out.reopened.count, 20, 'the settings did not survive');
    assert.equal(out.reopened.keys, 20, 'the part identities did not survive');
    assert.equal(out.duplicatedInOutliner, false, 'reopening listed a child twice in the outliner');
  });

  test('a logo keeps its placement and material through a depth revision', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      // A white mark on black: the Cut Out route's own case, and the one
      // people bring a logo to.
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(80, 80, 52, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#000';
      g.beginPath();
      g.arc(80, 80, 22, 0, Math.PI * 2);
      g.fill();
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.culpmixer.app.properties.openCreate(new File([blob], 'logo.png', { type: 'image/png' }));

      const ed = window.culpmixer.editor;
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const panel = window.culpmixer.app.properties.create;
      // Cut Out, so the setting being revised is an extrusion depth.
      [...document.querySelectorAll('.mode-btn')].find((b) => b.textContent.trim() === 'Cut Out').click();
      panel.mask.channel = 'luma';
      panel.mask.threshold = 0.5;
      panel.generate(true);
      await new Promise((ok) => setTimeout(ok, 300));

      const object = ed.scene.get(panel.targetId);
      if (!object || !object.provenance) return { ok: false, why: 'no reference asset with a record' };

      // Make it yours: move it and give it a material of your own.
      object.position.x = 4.25;
      object.rotation.z = 0.5;
      const slot = ed.scene.addMaterial();
      ed.scene.materials[slot].color = [0.1, 0.7, 0.2];
      object.materialSlots = [slot];
      const placement = [object.position.x, object.rotation.z];
      const depthBefore = object.mesh.bounds().size().y;

      // Revise the extrusion depth, preview it, accept it.
      panel.silhouette.depth = 1.2;
      panel.reviseFromSettings();
      const staged = ed.revision.summary;
      if (!staged) return { ok: false, why: 'the rebuild was not staged for review' };
      const undoBefore = ed.history.depth;
      ed.revision.accept();

      const after = ed.scene.get(panel.targetId);
      return {
        ok: true,
        source: after.provenance.source,
        generator: after.provenance.generator,
        referenceName: after.provenance.reference ? after.provenance.reference.name : null,
        referenceEmbedded: after.provenance.reference ? !after.provenance.reference.missing : false,
        depthBefore,
        depthAfter: after.mesh.bounds().size().y,
        recordedDepth: after.provenance.params.depth,
        placementKept: after.position.x === placement[0] && after.rotation.z === placement[1],
        materialKept: after.materialSlots[0] === slot,
        conflicts: staged.report.conflicts.length,
        oneStep: ed.history.depth - undoBefore,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.source, 'reference');
    assert.equal(out.generator, 'reference:silhouette');
    assert.equal(out.referenceName, 'logo.png', 'the picture it came from was not recorded');
    assert.equal(out.referenceEmbedded, true, 'the picture is not in the file, so it cannot be rebuilt');
    assert.ok(Math.abs(out.depthBefore - 0.4) < 0.01, `started at ${out.depthBefore} deep`);
    assert.ok(Math.abs(out.depthAfter - 1.2) < 0.01, `the revision did not change the depth (${out.depthAfter})`);
    assert.equal(out.recordedDepth, 1.2, 'the new setting was not recorded for next time');
    assert.equal(out.placementKept, true, 'the revision moved the logo you had placed');
    assert.equal(out.materialKept, true, 'the revision replaced the material you gave it');
    assert.equal(out.conflicts, 0, 'a rebuild with no edits to lose should not conflict');
    assert.equal(out.oneStep, 1);
  });

  test('the review panel appears with a revision and leaves with it', async () => {
    // Logic tests all pass while a panel sits on screen over a decision that
    // has already been made, because none of them look at the screen.
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      const panel = () => document.querySelector('.revision-panel');
      const shown = () => {
        const el = panel();
        if (!el) return false;
        const box = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && box.width > 0 && box.height > 0;
      };

      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      const beforeAny = shown();

      ed.selectObject(root.id);
      bar.focus('make it 14 steps');
      await bar.revise();
      const duringPreview = shown();
      const hasAccept = [...document.querySelectorAll('.revision-actions button')]
        .some((b) => /Accept/.test(b.textContent));
      ed.revision.accept();
      const afterAccept = shown();
      const staleText = (document.querySelector('.revision-headline')?.textContent ?? '').trim();

      // And again, then rejected.
      bar.focus('make it 20 steps');
      await bar.revise();
      const duringSecond = shown();
      ed.revision.reject();
      const afterReject = shown();
      return {
        beforeAny, duringPreview, hasAccept, afterAccept, staleText, duringSecond, afterReject,
      };
    });

    assert.equal(out.beforeAny, false, 'the review panel is on screen with no revision pending');
    assert.equal(out.duringPreview, true, 'the review panel did not appear for a staged revision');
    assert.equal(out.hasAccept, true, 'the panel has no Accept button');
    assert.equal(out.afterAccept, false, 'the review panel stayed on screen after Accept');
    assert.equal(out.staleText, '', 'the panel kept the last revision\'s summary');
    assert.equal(out.duringSecond, true, 'the panel did not come back for a second revision');
    assert.equal(out.afterReject, false, 'the review panel stayed on screen after Reject');
  });

  test('the viewport retints when different faces move, not just when more do', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const obj = ed.scene.add('mesh', 'Bar', window.culpmixer.buildPrimitive('grid'));
      ed.selectObject(obj.id);
      ed.renderNow();
      const before = JSON.parse(JSON.stringify(ed.scene.toJSON()));

      // Move exactly one face's worth of vertices, always from the pristine
      // grid so the two passes are the same edit in two places.
      const pristine = ed.scene.get(obj.id).mesh.toJSON();
      const nudge = (from) => {
        const scene = ed.scene.get(obj.id);
        scene.mesh = window.culpmixer.meshFromJSON(pristine);
        const mesh = scene.mesh;
        for (const v of mesh.faces[from]) mesh.positions[v].z += 0.6;
        mesh.markDirty();
        ed.markGeometryDirty(scene);
      };

      // Two interior faces of the grid, so each nudge moves the same nine
      // faces — the case where a cache keyed on counts alone cannot tell the
      // two comparisons apart.
      nudge(22);
      ed.compareAgainst(before, 'before');
      ed.renderNow();
      const first = ed.renderer.diffDigest();
      const firstMoved = ed.comparison.diff.objects.find((o) => o.id === obj.id).mesh.moved;

      nudge(77);
      ed.refreshComparison();
      ed.renderNow();
      const second = ed.renderer.diffDigest();
      const secondMoved = ed.comparison.diff.objects.find((o) => o.id === obj.id).mesh.moved;
      return { first, second, firstMoved, secondMoved };
    });

    assert.ok(out.firstMoved > 0, 'nothing registered as moved at all');
    assert.equal(out.firstMoved, out.secondMoved,
      'the test needs the same number of faces moved in both passes');
    assert.notEqual(out.first, out.second,
      'the renderer kept its cached tints when a different set of faces moved');
  });

  // ------------------------------------- the document is held during a review

  test('only the asset under review is held; the rest of the scene is yours', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      ed.selectObject(root.id);
      bar.focus('make it 14 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };

      // The selection is part of a serialised scene, so compare what actually
      // matters: the objects and their geometry, not what happens to be
      // highlighted.
      const shape = () => JSON.stringify([...ed.scene.objects.values()]
        .map((o) => [o.id, o.name, o.position.toArray(), o.mesh ? o.mesh.faceCount : 0]));
      const before = shape();
      const blocked = {};

      // The asset under review is showing a proposal, so editing it is held —
      // an edit there would be destroyed whichever button came next.
      ed.selectObject(root.children[0]);
      blocked.editingTheAsset = ed.beginUndo('nudge a proposed step') === false;
      blocked.editableFlag = ed.editable === false;
      window.culpmixer.run('object.delete');
      blocked.deletingAPart = shape() === before;

      // Anything that would take the proposal out of the review is held too:
      // a file containing a version nobody agreed to is the whole problem.
      window.culpmixer.run('file.new');
      blocked.newDocument = ed.revision.active && shape() === before;
      // Recovery is *not* held any more, and that is the repair: refusing it
      // for as long as a review was open meant the work underneath had no
      // recovery copy for exactly as long as somebody deliberated. What it
      // writes is the committed document, with the proposal taken back out.
      const saved = await ed.autosaveNow(false);
      const recovered = await ed.recovery.latest();
      const proposalEscaped = recovered
        ? JSON.stringify(recovered.scene).includes('"partKey"')
          && recovered.scene.objects.filter((o) => o.partKey).length !== 8
        : true;

      // Another revision request must not silently replace this one.
      bar.focus('make it 20 steps');
      await bar.revise();
      blocked.secondRevision = ed.revision.summary.label.includes('14');

      const untouched = shape() === before;
      ed.revision.reject();
      return {
        ok: true, blocked, untouched, saved, proposalEscaped,
        afterReject: ed.scene.get(root.id).children.length,
      };
    });

    assert.equal(out.ok, true, out.why);
    for (const [what, held] of Object.entries(out.blocked)) {
      assert.equal(held, true, `${what} was not held while a revision was waiting`);
    }
    assert.equal(out.untouched, true, 'something changed the document during a review');
    assert.equal(out.saved, true, 'recovery was refused while a revision was waiting');
    assert.equal(out.proposalEscaped, false,
      'the recovery copy contains the proposal rather than the committed document');
    assert.equal(out.afterReject, 8, 'reject did not put the staircase back');
  });

  test('a deleted part stays deleted through revisions, save and reload', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 20 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      const victim = ed.scene.get(root.children[5]);
      const key = victim.partKey;
      ed.scene.remove(victim.id);

      const stepKeys = () => ed.scene.get(root.id).children
        .map((id) => ed.scene.get(id).partKey)
        .filter((k) => k && k.startsWith('step#'));

      ed.selectObject(root.id);
      bar.focus('make it red');
      await bar.revise();
      const conflicts = ed.revision.summary ? ed.revision.summary.report.conflicts.length : -1;
      ed.revision.accept();
      const afterFirst = stepKeys().includes(key);

      bar.focus('make it 22 steps');
      await bar.revise();
      if (ed.revision.summary.report.conflicts.length) ed.revision.keepMineForAll();
      ed.revision.accept();
      const afterSecond = stepKeys().includes(key);

      const doc = JSON.parse(JSON.stringify(ed.scene.toJSON()));
      ed.loadSceneJSON(doc);
      const reopened = [...ed.scene.objects.values()].find((o) => o.provenance);
      return {
        key,
        conflicts,
        afterFirst,
        afterSecond,
        recorded: reopened.provenance.deletedParts || [],
      };
    });

    assert.equal(out.conflicts, 0, 'recolouring is no reason to argue about a deletion');
    assert.equal(out.afterFirst, false, 'the deleted step came back on the first revision');
    assert.equal(out.afterSecond, false, 'the deleted step came back on the second revision');
    assert.ok(out.recorded.includes(out.key), 'the deletion did not survive save and reload');
  });

  test('an edited program revises the selected asset with no model connected', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      // Build from a program by hand — no model, which is the whole point.
      bar.codeArea.value =
        "part({shape:'cube', id:'top', name:'Top', at:[0,0,1], size:[2,1,0.1], color:'#8b5e34'});\n"
        + "part({shape:'cube', id:'leg', name:'Leg', at:[0,0,0.5], size:[0.1,0.1,1], color:'#8b5e34'});";
      await bar.runCode(bar.codeArea.value, 'your code');
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      if (!root) return { ok: false, why: 'the program built nothing with a record' };
      const top = root.children.map((id) => ed.scene.get(id)).find((o) => o.name === 'Top');
      const slot = ed.scene.addMaterial();
      ed.scene.materials[slot].color = [0.1, 0.8, 0.3];
      top.materialSlots = [slot];
      const widthBefore = top.mesh.bounds().size().x;

      // Edit the program and revise the same asset with it.
      ed.selectObject(root.id);
      bar.codeArea.value = bar.codeArea.value.replace('size:[2,1,0.1]', 'size:[5,1,0.1]');
      const hasButton = [...document.querySelectorAll('.build-code .btn-row button')]
        .some((b) => /Preview Revision/.test(b.textContent));
      await bar.reviseFromCode();
      const staged = !!ed.revision.summary;
      const undoBefore = ed.history.depth;
      if (staged && ed.revision.summary.report.conflicts.length) ed.revision.keepMineForAll();
      ed.revision.accept();

      const after = ed.scene.get(root.id);
      const topAfter = after.children.map((id) => ed.scene.get(id)).find((o) => o.name === 'Top');
      const result = {
        ok: true,
        hasButton,
        staged,
        sameObject: topAfter.id === top.id,
        widthBefore,
        widthAfter: topAfter.mesh.bounds().size().x,
        materialKept: topAfter.materialSlots[0] === slot,
        oneStep: ed.history.depth - undoBefore,
        codeRecorded: (after.provenance.code || '').includes('5,1,0.1'),
      };
      ed.undo();
      result.undoneWidth = ed.scene.get(root.id).children
        .map((id) => ed.scene.get(id)).find((o) => o.name === 'Top').mesh.bounds().size().x;
      ed.redo();
      result.redoneWidth = ed.scene.get(root.id).children
        .map((id) => ed.scene.get(id)).find((o) => o.name === 'Top').mesh.bounds().size().x;
      return result;
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.hasButton, true, 'there is no button to revise from the code panel');
    assert.equal(out.staged, true, 'the edited program did not stage a revision');
    assert.equal(out.sameObject, true, 'it built a new object instead of revising this one');
    assert.ok(out.widthAfter > out.widthBefore + 2, 'the edited program was not applied');
    assert.equal(out.materialKept, true, 'your material was lost');
    assert.equal(out.oneStep, 1, `accepting cost ${out.oneStep} undo steps`);
    assert.equal(out.codeRecorded, true, 'the accepted program was not recorded');
    assert.ok(Math.abs(out.undoneWidth - out.widthBefore) < 1e-6, 'undo did not restore the shape');
    assert.ok(Math.abs(out.redoneWidth - out.widthAfter) < 1e-6, 'redo did not reapply it');
  });

  test('a transform disagreement offers both values and settles at that scope', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      const moved = ed.scene.get(root.children[3]);
      moved.position.x = 7;
      moved.name = 'My step';

      ed.selectObject(root.id);
      bar.focus('make it much bigger');
      await bar.revise();
      const summary = ed.revision.summary;
      const conflict = summary.report.conflicts.find(
        (c) => c.objectId === moved.id && c.field === 'position',
      );
      // The panel must show what each choice costs, not just its name.
      const labels = [...document.querySelectorAll('.revision-conflict .btn')]
        .map((b) => b.textContent);
      const acceptDisabled = !!document.querySelector('.revision-actions .btn.primary.disabled');
      const hasKeepAll = [...document.querySelectorAll('.revision-actions button')]
        .some((b) => /Keep my versions for all/.test(b.textContent));
      return {
        found: !!conflict,
        yours: conflict && conflict.yours,
        theirs: conflict && conflict.theirs,
        labels: labels.filter((t) => /Keep mine|Use revised/.test(t)).slice(0, 4),
        acceptDisabled,
        hasKeepAll,
        nameStillMine: ed.scene.get(moved.id).name === 'My step',
        positionUntouched: ed.scene.get(moved.id).position.x === 7,
      };
    });

    assert.equal(out.found, true, 'the placement disagreement was decided silently');
    assert.ok(out.yours && /7/.test(out.yours), `"keep mine" does not show your value: ${out.yours}`);
    assert.ok(out.theirs, '"use revised" does not show what it would set');
    assert.ok(out.labels.some((t) => /Keep mine —/.test(t)),
      `the buttons do not say what they will do: ${out.labels.join(' | ')}`);
    assert.equal(out.acceptDisabled, true, 'accept was offered with conflicts open');
    assert.equal(out.hasKeepAll, true, 'there is no way to settle the rest in one action');
    assert.equal(out.positionUntouched, true, 'a disputed value was written before it was settled');
    assert.equal(out.nameStillMine, true, 'an undisputed field was reset');
  });

  test('an image-derived asset is reopened and revised from the saved file alone', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(80, 80, 52, 0, Math.PI * 2); g.fill();
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.culpmixer.app.properties.openCreate(new File([blob], 'badge.png', { type: 'image/png' }));

      const ed = window.culpmixer.editor;
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const panel = window.culpmixer.app.properties.create;
      [...document.querySelectorAll('.mode-btn')].find((b) => b.textContent.trim() === 'Cut Out').click();
      panel.mask.channel = 'luma';
      panel.mask.threshold = 0.5;
      // Two correction marks, which are what rescue a picture colour cannot
      // separate — and which must therefore survive the file.
      const bm = panel.bitmap;
      const hints = new Uint8Array(bm.width * bm.height);
      for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) hints[y * bm.width + x] = 2;
      panel.hints = hints;
      panel.generate(true);
      await new Promise((ok) => setTimeout(ok, 300));

      const object = ed.scene.get(panel.targetId);
      if (!object || !object.provenance) return { ok: false, why: 'no reference asset was recorded' };
      object.position.x = 3.5;
      const slot = ed.scene.addMaterial();
      ed.scene.materials[slot].color = [0.2, 0.4, 0.9];
      object.materialSlots = [slot];
      const depthBefore = object.mesh.bounds().size().y;

      // Save, and reopen as a completely fresh document — the panel keeps no
      // bitmap, no target and no reference across this.
      const doc = JSON.parse(JSON.stringify(ed.scene.toJSON()));
      ed.loadSceneJSON(doc);
      panel.reference = null;
      panel.bitmap = null;
      panel.targetId = null;
      panel.hints = null;

      const reopened = [...ed.scene.objects.values()].find(
        (o) => o.provenance && o.provenance.source === 'reference',
      );
      if (!reopened) return { ok: false, why: 'the reference asset did not survive the reload' };
      ed.selectObject(reopened.id);

      const adopted = await panel.adoptAsset(reopened);
      const marks = panel.hints ? panel.hints.reduce((n, v) => n + (v === 2 ? 1 : 0), 0) : 0;

      // Revise its extrusion depth from the reopened settings.
      panel.silhouette.depth = 1.4;
      panel.reviseFromSettings();
      const staged = !!ed.revision.summary;
      if (staged && ed.revision.summary.report.conflicts.length) ed.revision.keepMineForAll();
      ed.revision.accept();
      const after = ed.scene.get(reopened.id);
      return {
        ok: true,
        adopted,
        mode: panel.mode,
        threshold: panel.mask.threshold,
        marks,
        staged,
        depthBefore,
        depthAfter: after.mesh.bounds().size().y,
        placementKept: Math.abs(after.position.x - 3.5) < 1e-6,
        materialKept: after.materialSlots[0] === slot,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.adopted, true, 'the saved asset could not be reopened from the file');
    assert.equal(out.mode, 'silhouette', 'the conversion mode did not come back');
    assert.equal(out.threshold, 0.5, 'the conversion settings did not come back');
    assert.ok(out.marks > 50, `the correction marks did not survive the file (${out.marks} left)`);
    assert.equal(out.staged, true, 'the rebuild was not staged for review');
    assert.ok(Math.abs(out.depthAfter - 1.4) < 0.01, `the revision did not apply (${out.depthAfter})`);
    assert.equal(out.placementKept, true, 'your placement was reset');
    assert.equal(out.materialKept, true, 'your material was replaced');
  });

  test('you can keep modelling while a revision waits, and Reject spares it', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      const bar = window.culpmixer.app.buildBar;
      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      ed.selectObject(root.id);
      bar.focus('make it 14 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };

      // Carry on working on something else entirely, through the real
      // commands a person would use.
      const made = ed.addPrimitive('cube');
      const worked = made !== null;
      if (made) made.position.x = 5;
      ed.selectObject(made.id);
      window.culpmixer.run('object.duplicate');
      // Duplicate leaves you dragging the copy; confirming keeps it, and
      // cancelling would roll the whole compound operation back.
      ed.confirmModal();
      const copies = [...ed.scene.objects.values()].filter((o) => o.name.startsWith('Cube')).length;

      // Editing the asset under review is the one thing still held.
      ed.selectObject(root.children[0]);
      const assetHeld = ed.beginUndo('nudge a proposed step') === false;
      // And saving a proposal into a file is still refused.
      const savedDuring = await ed.autosaveNow(false);

      ed.selectObject(made.id);
      ed.revision.reject();
      const survivor = ed.scene.get(made.id);
      return {
        ok: true,
        worked,
        copies,
        assetHeld,
        saveHeld: savedDuring === true,
        survived: !!survivor,
        keptPosition: survivor ? survivor.position.x : null,
        copiesAfter: [...ed.scene.objects.values()].filter((o) => o.name.startsWith('Cube')).length,
        assetBack: ed.scene.get(root.id).children.length,
        historyClean: ed.history.canUndo,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.worked, true, 'adding an unrelated object during a review was blocked');
    assert.ok(out.copies >= 2, 'duplicating an unrelated object during a review was blocked');
    assert.equal(out.assetHeld, true, 'the asset under review was editable');
    assert.equal(out.saveHeld, true,
      'recovery should keep working during a review, writing the committed document');
    assert.equal(out.survived, true, 'Reject deleted work made during the review');
    assert.equal(out.keptPosition, 5, 'Reject undid unrelated work');
    assert.equal(out.copiesAfter, out.copies, 'Reject removed copies made during the review');
    assert.equal(out.assetBack, 8, 'Reject did not put the asset back');
  });

  test('a rejected revision cannot be brought back by undoing something else', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;
      bar.focus('a staircase with 12 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      const stepsBefore = ed.scene.get(root.id).children.length;

      // Something of your own, standing well clear of the asset.
      ed.selectObject(root.id);
      k.run('add.cube');
      const mine = ed.scene.get(ed.scene.active);
      mine.position.x = 12;
      const mineId = mine.id;

      // Stage a revision, then — while it is on screen and undecided — do some
      // ordinary work elsewhere, through the real commands.
      ed.selectObject(root.id);
      bar.focus('make it 20 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };
      const previewed = ed.scene.get(root.id).children.length;

      ed.selectObject(mineId);
      k.run('object.duplicate');
      const copyId = ed.scene.active;
      k.run('add.uvsphere');
      const sphereId = ed.scene.active;

      ed.revision.reject();
      const afterReject = ed.scene.get(root.id).children.length;

      // The moment of truth: stepping back through your own work must not put
      // the rejected proposal back on the screen.
      const seen = [];
      for (let i = 0; i < 4; i++) {
        ed.undo();
        const asset = [...ed.scene.objects.values()].find((o) => o.provenance);
        seen.push(asset ? asset.children.length : -1);
      }
      const redone = [];
      for (let i = 0; i < 4; i++) {
        ed.redo();
        const asset = [...ed.scene.objects.values()].find((o) => o.provenance);
        redone.push(asset ? asset.children.length : -1);
      }
      return {
        ok: true,
        stepsBefore,
        previewed,
        afterReject,
        seen,
        redone,
        survived: !!ed.scene.get(copyId) && !!ed.scene.get(sphereId),
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.previewed, 20, 'the preview did not apply');
    assert.equal(out.afterReject, 12, 'rejecting did not put the asset back');
    assert.deepEqual(
      out.seen.filter((n) => n !== 12 && n !== -1), [],
      `undoing unrelated work brought a rejected 20-step revision back: saw ${out.seen.join(', ')}`,
    );
    assert.deepEqual(
      out.redone.filter((n) => n !== 12 && n !== -1), [],
      `redoing unrelated work brought a rejected revision back: saw ${out.redone.join(', ')}`,
    );
  });

  test('accepting after unrelated work is one step, and the work below it is still undoable', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;
      bar.focus('a staircase with 12 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);

      ed.selectObject(root.id);
      k.run('add.cube');
      const mineId = ed.scene.active;
      ed.scene.get(mineId).position.x = 12;

      ed.selectObject(root.id);
      bar.focus('make it 20 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };
      const depthBefore = ed.history.depth;

      // Unrelated work during the review, through a real command.
      ed.selectObject(mineId);
      k.run('object.duplicate');
      const copyId = ed.scene.active;
      const depthAfterEdit = ed.history.depth;

      ed.revision.accept();
      const cost = ed.history.depth - depthAfterEdit;
      const accepted = ed.scene.get(root.id).children.length;

      ed.undo();                                     // the revision
      const afterFirst = [...ed.scene.objects.values()].find((o) => o.provenance);
      const revisionUndone = afterFirst.children.length;
      const copyStillThere = !!ed.scene.get(copyId);

      ed.undo();                                     // your duplicate
      const copyGone = !ed.scene.get(copyId);

      ed.redo();
      ed.redo();
      const back = [...ed.scene.objects.values()].find((o) => o.provenance);
      return {
        ok: true,
        stagedCost: depthAfterEdit - depthBefore,
        cost,
        accepted,
        revisionUndone,
        copyStillThere,
        copyGone,
        redoneSteps: back.children.length,
        redoneRevision: back.provenance.revision,
        redoneCopy: !!ed.scene.get(copyId),
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.stagedCost, 1, 'the unrelated edit did not record exactly one step');
    assert.equal(out.cost, 1, `accepting cost ${out.cost} undo steps instead of one`);
    assert.equal(out.accepted, 20, 'accepting did not keep the revision');
    assert.equal(out.revisionUndone, 12, 'undoing the revision did not take it back');
    assert.equal(out.copyStillThere, true, 'undoing the revision also undid your unrelated work');
    assert.equal(out.copyGone, true, 'your unrelated work was not undoable after the revision');
    assert.equal(out.redoneSteps, 20, 'redo did not put the revision back');
    assert.equal(out.redoneRevision, 1, 'the record did not come back with it');
    assert.equal(out.redoneCopy, true, 'redo did not put your work back');
  });

  test('undo during a live review moves your work and leaves the proposal on screen', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;
      bar.focus('a staircase with 12 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);

      ed.selectObject(root.id);
      k.run('add.cube');
      const mineId = ed.scene.active;

      ed.selectObject(root.id);
      bar.focus('make it 20 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };

      ed.undo();
      const stillReviewing = ed.revision.active;
      const asset = [...ed.scene.objects.values()].find((o) => o.provenance);
      const stepsDuring = asset ? asset.children.length : -1;
      const cubeGone = !ed.scene.get(mineId);

      ed.redo();
      const cubeBack = !!ed.scene.get(mineId);
      const stepsAfterRedo = [...ed.scene.objects.values()]
        .find((o) => o.provenance).children.length;

      // And the review can still be answered from there.
      ed.revision.reject();
      return {
        ok: true,
        stillReviewing,
        stepsDuring,
        cubeGone,
        cubeBack,
        stepsAfterRedo,
        afterReject: [...ed.scene.objects.values()].find((o) => o.provenance).children.length,
        rejectKeptYourCube: !!ed.scene.get(mineId),
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.equal(out.cubeGone, true, 'undo did not undo your own work');
    assert.equal(out.stillReviewing, true, 'an undo cancelled the review');
    assert.equal(out.stepsDuring, 20, 'undoing your work took the proposal off the screen');
    assert.equal(out.cubeBack, true, 'redo did not put your work back');
    assert.equal(out.stepsAfterRedo, 20, 'redo took the proposal off the screen');
    assert.equal(out.afterReject, 12, 'Reject stopped working after stepping through history');
    assert.equal(out.rejectKeptYourCube, true, 'Reject destroyed work you did during the review');
  });

  test('a material edited during a review is undone and redone like any other work', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;

      // Something of your own, with a material of its own, parked where the
      // camera can see it and well clear of the asset.
      k.run('add.cube');
      const mine = ed.scene.get(ed.scene.active);
      mine.position.x = 0;
      if (!ed.beginUndo('New material')) return { ok: false, why: 'could not add a material' };
      const slot = ed.scene.addMaterial({
        ...ed.scene.materials[0], name: 'Mine', color: [0.9, 0.1, 0.1],
      });
      mine.materialSlots = [slot];
      const mineId = mine.id;

      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      // Out of the way, so the sampled pixel is the cube and only the cube.
      root.position.x = 40;
      ed.selectObject(root.id);

      const colourOf = () => [...ed.scene.materials[slot].color];
      const red = colourOf();

      bar.focus('make it 14 steps');
      await bar.revise();
      if (!ed.revision.active) return { ok: false, why: 'no revision was staged' };

      // An ordinary edit to an existing material, while the review is up. The
      // object that carries it is selected, the way it would be to reach the
      // material panel at all — the asset under review is not.
      ed.selectObject(mineId);
      if (!ed.beginUndo('Edit material')) return { ok: false, why: 'the edit was blocked' };
      ed.scene.materials[slot].color = [0.1, 0.2, 0.9];
      ed.requestRender();
      const blue = colourOf();

      ed.undo();
      const afterUndo = colourOf();
      ed.redo();
      const afterRedo = colourOf();

      // Still reviewing, and the proposal is still on screen.
      const stillReviewing = ed.revision.active;
      const stepsDuring = ed.scene.get(root.id).children.length;

      ed.revision.reject();
      const afterReject = colourOf();
      ed.undo();
      const afterRejectUndo = colourOf();
      ed.redo();
      const afterRejectRedo = colourOf();

      return {
        ok: true, mineId, slot, red, blue, afterUndo, afterRedo,
        stillReviewing, stepsDuring, afterReject, afterRejectUndo, afterRejectRedo,
      };
    });

    assert.equal(out.ok, true, out.why);
    assert.deepEqual(out.blue.map((n) => +n.toFixed(3)), [0.1, 0.2, 0.9]);
    // The whole finding: undoing an edit made during a review has to undo it.
    assert.deepEqual(out.afterUndo, out.red,
      `undoing a material edit made during a review kept the new colour: ${out.afterUndo}`);
    assert.deepEqual(out.afterRedo.map((n) => +n.toFixed(3)), [0.1, 0.2, 0.9],
      'redo did not put the material edit back');
    assert.equal(out.stillReviewing, true, 'stepping through history cancelled the review');
    assert.equal(out.stepsDuring, 14, 'stepping through history took the proposal off the screen');
    // Rejecting the revision is not a reason to lose your material edit.
    assert.deepEqual(out.afterReject.map((n) => +n.toFixed(3)), [0.1, 0.2, 0.9],
      'rejecting the revision undid your material edit');
    assert.deepEqual(out.afterRejectUndo, out.red,
      'the material edit was not undoable after the revision was rejected');
    assert.deepEqual(out.afterRejectRedo.map((n) => +n.toFixed(3)), [0.1, 0.2, 0.9],
      'the material edit was not redoable after the revision was rejected');
  });

  test('the viewport shows the undone material, not just the record of it', async () => {
    await resetScene(page);
    const setup = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;
      k.run('add.cube');
      const mine = ed.scene.get(ed.scene.active);
      ed.beginUndo('New material');
      const slot = ed.scene.addMaterial({
        ...ed.scene.materials[0], name: 'Mine', color: [0.9, 0.05, 0.05], roughness: 0.9,
      });
      mine.materialSlots = [slot];
      bar.focus('a staircase with 8 steps');
      await bar.run();
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      root.position.x = 40;
      // Look at the cube, not at the staircase the build bar just framed, so
      // the sampled pixel is the surface whose material is under test.
      ed.selectObject(mine.id);
      k.run('view.frameSelected');
      // Deselect so the selection outline does not colour the sample.
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
      return { slot, root: root.id, mine: mine.id };
    });

    const patch = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) patch.push([0.42 + i * 0.04, 0.42 + j * 0.04]);
    }
    /** Mean blue-minus-red across the patch: which way the surface leans. */
    const lean = (pixels) =>
      pixels.reduce((sum, px) => sum + (px[2] - px[0]), 0) / pixels.length;

    const before = lean(await samplePixels(page, patch));

    await page.evaluate(async ({ slot, mine }) => {
      const k = window.culpmixer, ed = k.editor;
      const bar = k.app.buildBar;
      const root = [...ed.scene.objects.values()].find((o) => o.provenance);
      ed.selectObject(root.id);
      bar.focus('make it 14 steps');
      await bar.revise();
      // Select your own cube, as you would to reach its material — and look
      // back at it, because staging a revision frames the asset.
      ed.selectObject(mine);
      k.run('view.frameSelected');
      ed.beginUndo('Edit material');
      ed.scene.materials[slot].color = [0.05, 0.05, 0.9];
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
    }, setup);

    const edited = lean(await samplePixels(page, patch));

    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.undo();
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
    });

    const undone = lean(await samplePixels(page, patch));
    const reviewing = await page.evaluate(() => window.culpmixer.editor.revision.active);

    // Warm key light, so the surface is never a flat swatch of its base colour
    // and "is this pixel blue" is the wrong question. What the screen can
    // answer is which way it moved: turning a red material blue has to lift the
    // blue channel and drop the red, and undoing that has to put both back.
    assert.ok(edited > before + 30,
      `the edit did not reach the screen: lean went ${before.toFixed(1)} -> ${edited.toFixed(1)}`);
    assert.ok(Math.abs(undone - before) < 8,
      'undoing the material edit during a review left it on screen: lean went '
      + `${before.toFixed(1)} -> ${edited.toFixed(1)} -> ${undone.toFixed(1)}`);
    assert.equal(reviewing, true, 'the undo cancelled the review');
  });

  test('a placement that had to be approximated is still on screen afterwards', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      const V = ed.scene.cursor.constructor;

      // An asset of one part, and a proposal that adds a badly skewed one.
      const root = ed.scene.add('empty', 'Rig');
      const anchor = ed.scene.add('mesh', 'Anchor', ed.scene.get(ed.scene.active)?.mesh?.clone()
        ?? null);
      return { needsFixture: true, root: root.id, anchor: anchor.id, hasV: !!V };
    });
    assert.equal(out.needsFixture, true);

    const result = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      // Build the fixture through the real application: a cube asset, then a
      // hand-written proposal that introduces a non-uniformly scaled part.
      ed.newScene();
      k.run('add.cube');
      const part = ed.scene.get(ed.scene.active);
      const V = part.position.constructor;
      const root = ed.scene.add('empty', 'Rig');
      ed.scene.setParent(part.id, root.id);
      part.partKey = 'anchor#1';
      part.name = 'Anchor';
      root.provenance = {
        schema: 2, source: 'program', assetId: 'shear-1', generator: 'program',
        generatorVersion: 1, params: {}, createdAt: Date.now(), revision: 0,
        baseline: {
          version: 2,
          parts: [{
            key: 'anchor#1', name: 'Anchor', position: [0, 0, 0], rotation: [0, 0, 0],
            scale: [1, 1, 1], mesh: part.mesh.toJSON(), materialSlots: [], materials: [],
            modifiers: [], animation: [], visible: true, locked: false,
          }],
        },
      };

      const proposed = [
        {
          key: 'anchor#1', name: 'Anchor', position: [0, 0, 0], rotation: [0, 0, 0],
          scale: [1, 1, 1], mesh: part.mesh.toJSON(),
        },
        {
          key: 'skew#1', name: 'Skew', position: [3, 1, 2], rotation: [0, 0, 0],
          scale: [5, 1, 0.25], mesh: part.mesh.toJSON(),
        },
      ];
      ed.selectObject(root.id);
      const summary = ed.revision.preview(root, proposed, 'add a skewed mount');
      if (!summary) return { ok: false, why: 'the preview was refused' };

      // Your own rotated object, hung on the skewed part.
      const skew = [...ed.scene.objects.values()].find((o) => o.partKey === 'skew#1');
      k.run('add.cube');
      const tag = ed.scene.get(ed.scene.active);
      tag.position = new V(0.4, 0.2, 0.1);
      tag.rotation = new V(0, 0, Math.PI / 4);
      ed.scene.setParent(tag.id, skew.id);
      const wanted = [...tag.worldMatrix(ed.scene).m];

      ed.revision.reject();

      const survivor = ed.scene.get(tag.id);
      const got = survivor ? [...survivor.worldMatrix(ed.scene).m] : null;
      const worst = got ? Math.max(...got.map((n, i) => Math.abs(n - wanted[i]))) : Infinity;

      const panel = document.querySelector('.revision-panel');
      const visible = !!panel && !panel.classList.contains('hidden');
      return {
        ok: true,
        survived: !!survivor,
        skewGone: !ed.scene.get(skew.id),
        worst,
        outcome: ed.revision.outcome,
        notice: ed.notice,
        visible,
        panelText: panel ? panel.innerText : '',
      };
    });

    assert.equal(result.ok, true, result.why);
    assert.equal(result.skewGone, true, 'the proposed part survived a rejection');
    assert.equal(result.survived, true, 'your work went with the part it hung on');
    assert.ok(result.outcome, 'the finished revision left no record');
    assert.equal(result.outcome.action, 'rejected');

    if (result.worst > 1e-6) {
      // It could not be placed exactly — so it has to say so, and the saying
      // has to outlive the panel that Reject just closed.
      assert.ok(result.outcome.warnings.length > 0,
        `placement was off by ${result.worst} with nothing said about it`);
      assert.equal(result.visible, true,
        'the warning was recorded but the panel that would show it was hidden');
      assert.match(result.panelText, /shear|as closely as/);
      assert.ok(result.notice, 'no notice was raised');
    } else {
      assert.deepEqual(result.outcome.warnings, [],
        'an exact placement was reported as an approximation');
    }
  });

  test('an animation renders a frame sequence, reports progress, and can be stopped', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.uvsphere');
      const ball = ed.scene.get(ed.scene.active);
      ball.animation = [{
        path: 'position', index: 0,
        keys: [
          { frame: 1, value: -2, interp: 'linear' },
          { frame: 4, value: 2, interp: 'linear' },
        ],
      }];
      k.run('add.light.sun');
      ed.scene.timeline.start = 1;
      ed.scene.timeline.end = 4;
      ed.scene.setFrame(2);
      Object.assign(ed.renderSettings, {
        width: 24, height: 18, samples: 1, samplesPerPass: 1, denoise: false,
        frameStart: 1, frameEnd: 3, frameStep: 1,
      });

      // Drive the real engine with the delivery replaced, so the test does
      // not depend on a download folder. Everything above the write is the
      // code the buttons run.
      const frames = [];
      const progress = [];
      const originalStatus = ed.setStatus.bind(ed);
      ed.setStatus = (m) => { progress.push(m); originalStatus(m); };
      const ok = await ed.renderAnimationTo({
        describe: () => 'test sink',
        write: async (image) => { frames.push(image.frame); return true; },
        finish: async (written, cancelled) => `wrote ${written}${cancelled ? ' (cancelled)' : ''}`,
      });
      ed.setStatus = originalStatus;
      return {
        ok, frames,
        sawProgress: progress.some((m) => /Rendering frame/.test(m)),
        closing: ed.statusMessage,
        playhead: ed.scene.timeline.current,
      };
    });

    assert.deepEqual(out.frames, [1, 2, 3], `frames rendered: ${JSON.stringify(out.frames)}`);
    assert.equal(out.ok, true, 'the animation render did not report success');
    assert.equal(out.sawProgress, true, 'no per-frame progress was reported');
    assert.match(out.closing, /wrote 3/, `closing message was "${out.closing}"`);
    assert.equal(out.playhead, 2, 'the render moved the user timeline');
  });

  test('an animation render stops when asked and says how far it got', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.cube');
      k.run('add.light.sun');
      ed.scene.timeline.start = 1;
      ed.scene.timeline.end = 8;
      Object.assign(ed.renderSettings, {
        width: 16, height: 12, samples: 1, samplesPerPass: 1, denoise: false,
        frameStart: 1, frameEnd: 8, frameStep: 1,
      });
      const frames = [];
      const ok = await ed.renderAnimationTo({
        describe: () => 'test sink',
        write: async (image) => {
          frames.push(image.frame);
          if (frames.length === 2) ed.cancelAnimation();
          return true;
        },
        finish: async (written, cancelled) => `wrote ${written}${cancelled ? ' (cancelled)' : ''}`,
      });
      return { ok, frames, closing: ed.statusMessage, running: !!ed.activeSequence };
    });

    assert.equal(out.ok, false, 'a cancelled render reported success');
    assert.ok(out.frames.length < 8, `stopping did not stop it: ${out.frames.length} frames`);
    assert.match(out.closing, /cancelled/i, `closing message was "${out.closing}"`);
    assert.equal(out.running, false, 'the render was left marked as running');
  });

  test('generated code cannot reach the network or storage, even through a fresh realm', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor, bar = k.app.buildBar;
      // Function('return this')() hands back the real global whatever the
      // parameter list says, so it is the route that matters: shadowing a name
      // only hides one spelling of it. Several of these live on
      // WorkerGlobalScope.prototype rather than on the global itself, which is
      // why deleting them off `self` was not enough.
      const probes = {
        fetch: 'fetch("/x");',
        fetchViaRealm: 'Function("return this")().fetch("/x");',
        indexedDbViaRealm: 'Function("return this")().indexedDB.open("x");',
        cachesViaRealm: 'Function("return this")().caches.open("x");',
        beaconViaRealm: 'Function("return this")().navigator.sendBeacon("/x");',
        importScriptsViaRealm: 'Function("return this")().importScripts("/x");',
        webSocketViaRealm: 'new (Function("return this")().WebSocket)("ws://x");',
      };
      const results = {};
      for (const [name, src] of Object.entries(probes)) {
        k.run('file.new');
        const full = `${src} box(0,0,0.5,1,1,1);`;
        bar.codeArea.value = full;
        try {
          await bar.runCode(full, 'probe');
          // Reaching here without an error message means it ran.
          results[name] = /did not run/.test(ed.statusMessage) ? 'blocked' : 'RAN';
        } catch {
          results[name] = 'blocked';
        }
      }
      // The control: an ordinary program still builds, so the lockdown has not
      // simply broken the feature.
      k.run('file.new');
      const ok = 'box(0,0,0.5,1,1,1,"#ff0000");';
      bar.codeArea.value = ok;
      await bar.runCode(ok, 'probe');
      const built = [...ed.scene.objects.values()].some((o) => o.provenance);
      return { results, built };
    });

    for (const [name, verdict] of Object.entries(out.results)) {
      assert.equal(verdict, 'blocked', `generated code reached the host through ${name}`);
    }
    assert.equal(out.built, true, 'the lockdown broke ordinary program building');
  });

  test('a cancelled save never says the work is safe', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.cube');

      // Stand in for the desktop shell, which is the only place a save can be
      // cancelled or fail: a browser tab only ever starts a download.
      const answers = [];
      window.culpMixerDesktop = {
        platform: 'test',
        registerCommands: () => {},
        onCommand: () => {},
        onShowShortcuts: () => {},
        onOpenFile: () => {},
        openScene: async () => null,
        saveFile: async () => answers.shift(),
      };

      const results = {};
      answers.push({ status: 'cancelled' });
      k.run('file.save');
      await new Promise((r) => setTimeout(r, 60));
      results.cancelled = ed.statusMessage;
      results.stillDirtyAfterCancel = ed.hasUnsavedChanges;

      answers.push({ status: 'failed', reason: 'disk full' });
      k.run('file.save');
      await new Promise((r) => setTimeout(r, 60));
      results.failed = ed.statusMessage;
      results.stillDirtyAfterFailure = ed.hasUnsavedChanges;

      answers.push({ status: 'saved', path: '/tmp/scene.mixer' });
      k.run('file.save');
      await new Promise((r) => setTimeout(r, 60));
      results.saved = ed.statusMessage;
      results.cleanAfterSave = ed.hasUnsavedChanges === false;

      delete window.culpMixerDesktop;
      return results;
    });

    assert.doesNotMatch(out.cancelled, /^Saved/, `a cancelled save reported "${out.cancelled}"`);
    assert.match(out.cancelled, /cancelled/i);
    assert.equal(out.stillDirtyAfterCancel, true, 'a cancelled save marked the document clean');

    assert.doesNotMatch(out.failed, /^Saved/, `a failed save reported "${out.failed}"`);
    assert.match(out.failed, /disk full/);
    assert.equal(out.stillDirtyAfterFailure, true, 'a failed save marked the document clean');

    assert.match(out.saved, /^Saved/, `a real save reported "${out.saved}"`);
    assert.equal(out.cleanAfterSave, true, 'a completed save left the document dirty');
  });

  test('a recovery copy does not count as saving the project', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      window.culpmixer.run('add.cube');
      const dirtyBefore = ed.hasUnsavedChanges;
      const wrote = await ed.autosaveNow(false);
      return { dirtyBefore, wrote, dirtyAfter: ed.hasUnsavedChanges };
    });
    assert.equal(out.dirtyBefore, true, 'adding a cube did not mark the document unsaved');
    assert.equal(out.wrote, true, 'the recovery copy was not written');
    assert.equal(out.dirtyAfter, true,
      'an autosave marked the document saved — it has a name nobody chose and vanishes with the profile');
  });

  test('replacing the document asks first, and Cancel really cancels', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.uvsphere');
      const before = ed.scene.objects.size;

      const press = (label) => new Promise((resolve) => {
        const tick = () => {
          const dialog = document.querySelector('.unsaved-dialog');
          if (!dialog) { requestAnimationFrame(tick); return; }
          const button = [...dialog.querySelectorAll('button')]
            .find((b) => b.textContent.trim() === label);
          button.click();
          resolve(true);
        };
        requestAnimationFrame(tick);
      });

      // Cancel: the scene must be exactly as it was.
      const cancelling = press('Cancel');
      k.run('file.new');
      await cancelling;
      await new Promise((r) => setTimeout(r, 60));
      const afterCancel = ed.scene.objects.size;

      // Discard: now it goes.
      const discarding = press('Discard');
      k.run('file.new');
      await discarding;
      await new Promise((r) => setTimeout(r, 60));
      const afterDiscard = ed.scene.objects.size;

      return {
        before, afterCancel, afterDiscard,
        dialogGone: !document.querySelector('.unsaved-dialog'),
      };
    });

    assert.equal(out.afterCancel, out.before, 'Cancel still replaced the document');
    assert.ok(out.afterDiscard < out.before, 'Discard did not start a new scene');
    assert.equal(out.dialogGone, true, 'the dialog was left on screen');
  });

  test('a clean document is replaced without being asked', async () => {
    await resetScene(page);
    const out = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      // resetScene leaves a freshly loaded document, which is not unsaved work.
      const dirty = ed.hasUnsavedChanges;
      window.culpmixer.run('file.new');
      await new Promise((r) => setTimeout(r, 60));
      return { dirty, asked: !!document.querySelector('.unsaved-dialog') };
    });
    assert.equal(out.dirty, false, 'a freshly loaded document counted as unsaved work');
    assert.equal(out.asked, false, 'a clean document was still challenged');
  });

  test('the outliner and properties are reachable on a narrow window', async () => {
    // They used to be display:none below 820px with nothing to open them:
    // a laptop with a palette open beside the browser is enough to hit that,
    // and the application silently lost half its controls.
    const wide = page.viewportSize();
    await page.setViewportSize({ width: 720, height: 800 });
    await resetScene(page);
    await page.evaluate(() => window.culpmixer.run('add.cube'));
    // The drawer slides, so give the transition time to land before measuring
    // where it is; reading mid-transition says nothing about either state.
    await new Promise((r) => setTimeout(r, 400));

    const closed = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar');
      return {
        display: getComputedStyle(sb).display,
        // Asserted as state rather than as pixels: the drawer slides, so its
        // position mid-transition says nothing about either end of it.
        open: sb.classList.contains('open'),
        shifted: getComputedStyle(sb).transform !== 'none',
        toggleShown: getComputedStyle(document.querySelector('.sidebar-toggle')).display,
      };
    });
    assert.notEqual(closed.display, 'none', 'the sidebar is hidden with no way to reach it');
    assert.equal(closed.open, false, 'the drawer starts open and covers the viewport');
    assert.equal(closed.shifted, true, 'the closed drawer is not moved off the viewport at all');
    assert.equal(closed.toggleShown, 'block', 'no control to open the panels');

    // A real click, and real use of what it reveals.
    //
    // Waited for rather than slept through. The drawer slides over 140ms and
    // the first version of this gave it a flat 250 and then measured pixels —
    // which is fine on a quiet machine and failed about one build in ten on a
    // loaded runner, reporting "the drawer did not open" about a drawer that
    // was opening. The condition is the thing being waited for.
    await page.click('.sidebar-toggle');
    await page.waitForFunction(() => {
      const sb = document.querySelector('.sidebar');
      if (!sb.classList.contains('open')) return false;
      const r = sb.getBoundingClientRect();
      return r.left < window.innerWidth - 10 && r.width > 100;
    }, null, { timeout: 30000 }).catch(() => undefined);

    const open = await page.evaluate(() => {
      const r = document.querySelector('.sidebar').getBoundingClientRect();
      const row = [...document.querySelectorAll('.outliner *')]
        .find((e) => e.textContent.trim() === 'Cube');
      if (row) row.click();
      // The identity field, found by what it holds rather than by position:
      // the sidebar carries several text inputs and which one comes first
      // depends on the tab.
      // The Object tab explicitly: a previous test may have left the panel on
      // Create, and which tab is showing is not what this is about.
      const objectTab = document.querySelectorAll('.sidebar .tab')[1];
      if (objectTab) objectTab.click();
      const named = [...document.querySelectorAll('.sidebar input')]
        .some((i) => i.value === 'Cube');
      return {
        onScreen: r.left < window.innerWidth - 10 && r.width > 100,
        sawRow: !!row,
        active: window.culpmixer.editor.scene.active,
        named,
      };
    });
    assert.equal(open.onScreen, true, 'the drawer did not open');
    assert.equal(open.sawRow, true, 'the outliner is empty inside the drawer');
    assert.ok(open.active !== null, 'clicking a row in the drawer selected nothing');
    assert.equal(open.named, true, 'the properties panel is not usable inside the drawer');

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('.sidebar').classList.contains('open'),
      null, { timeout: 30000 },
    ).catch(() => undefined);
    const shut = await page.evaluate(() =>
      !document.querySelector('.sidebar').classList.contains('open'));
    assert.equal(shut, true, 'Escape did not close the drawer');

    await page.setViewportSize(wide);
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sidebar-toggle')).display === 'none',
      null, { timeout: 30000 },
    ).catch(() => undefined);
    const back = await page.evaluate(() => ({
      position: getComputedStyle(document.querySelector('.sidebar')).position,
      toggle: getComputedStyle(document.querySelector('.sidebar-toggle')).display,
    }));
    assert.equal(back.toggle, 'none', 'the drawer button is still there on a wide window');
    assert.notEqual(back.position, 'absolute', 'the sidebar stayed a drawer on a wide window');
  });

  test('a command scoped to a mode says so instead of pretending it worked', async () => {
    // Every path in the interface filters on mode — the palette greys the row,
    // the menu hides it, the keymap resolves per mode — so the check was never
    // in the one place that catches the paths that do not filter. Unwrap in
    // Object Mode answered "Unwrapped into 0 islands", which is the language of
    // success for something that could not have done anything.
    await resetScene(page);
    const said = await page.evaluate(() => {
      const k = window.culpmixer, ed = k.editor;
      k.run('add.cube');
      const out = {};
      for (const id of ['uv.unwrap', 'mesh.extrude', 'sculpt.cycleBrush']) {
        ed.setStatus('');
        k.run(id);
        out[id] = ed.statusMessage;
      }
      out.mode = ed.mode;
      // And the same command in its own mode still works.
      k.run('edit.toggleMode');
      k.run('select.all');
      ed.setStatus('');
      k.run('uv.unwrap');
      out.inEditMode = ed.statusMessage;
      k.run('edit.toggleMode');
      return out;
    });
    assert.equal(said.mode, 'object');
    assert.match(said['uv.unwrap'], /Edit Mode command/,
      `Unwrap in Object Mode said: ${said['uv.unwrap']}`);
    assert.doesNotMatch(said['uv.unwrap'], /0 islands/, 'it still reported a successful unwrap');
    assert.match(said['mesh.extrude'], /Edit Mode command/);
    assert.match(said['sculpt.cycleBrush'], /Sculpt Mode command/,
      `Cycling the sculpt brush in Object Mode said: ${said['sculpt.cycleBrush']}`);
    assert.match(said.inEditMode, /island/i,
      `Unwrap in Edit Mode should still unwrap, but said: ${said.inEditMode}`);
  });

  test('every menu opens to something a person can actually see and click', async () => {
    // The one that made the whole application look dead.
    //
    // .menu-bar carried `overflow: hidden` so it could shrink at a narrow
    // window without shoving the mode switch off the right-hand edge. But
    // overflow clips both axes, and that bar is 33px tall while every dropdown
    // hangs below it — so all nine menus opened to nothing. The label lit up,
    // the panel was display:block and 848px tall, and the screen showed an
    // empty viewport. 108 items, every one of them invisible and unclickable:
    // File, Add, Object, Mesh, Rig, Select, View, Help.
    //
    // Nothing in the unit suite could see it. The commands all worked; it was
    // only the way in that was gone. So the check is the one a person makes:
    // open it, and is the thing under the cursor the item itself.
    await resetScene(page);
    const broken = [];
    for (const name of ['File', 'Add', 'Object', 'Mesh', 'Rig', 'Select', 'View', 'Help']) {
      await page.click(`.menu-label:text-is("${name}")`);
      await page.waitForTimeout(120);
      const bad = await page.evaluate(() => {
        const drop = document.querySelector('.menu.open .menu-items');
        if (!drop) return ['the menu did not open'];
        const out = [];
        for (const item of drop.querySelectorAll('.menu-item')) {
          const box = item.getBoundingClientRect();
          if (!box.width) continue;
          // A long menu is allowed to scroll; what it may not do is put an
          // item where nothing can ever reach it.
          item.scrollIntoView({ block: 'nearest' });
          const r = item.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit !== item && !item.contains(hit)) {
            out.push(`${item.textContent.trim().slice(0, 24)} (${hit ? hit.className || hit.tagName : 'off screen'})`);
          }
        }
        return out;
      });
      if (bad.length) broken.push(`${name}: ${bad.join(', ')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
    }
    assert.deepEqual(broken, [], `menu items nobody can click — ${broken.join(' | ')}`);
  });

  test('a menu item does its work from a real click', async () => {
    // Not k.run(): the point is the path from the cursor to the operator,
    // which is exactly the part that was severed.
    await resetScene(page);
    await page.evaluate(() => window.culpmixer.run('add.cube'));
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => window.culpmixer.editor.scene.objects.size);
    await page.click('.menu-label:text-is("Object")');
    await page.waitForTimeout(120);
    await page.click('.menu-item:has-text("Duplicate")');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => window.culpmixer.editor.scene.objects.size);
    assert.equal(after, before + 1,
      `clicking Object > Duplicate went from ${before} objects to ${after}`);
  });

  test('the menu bar still gives way first at a narrow window', async () => {
    // The rule that broke the menus was protecting something real: the nine
    // labels held their full width and pushed Object/Edit/Sculpt and the view
    // controls off the screen. Clipping moved onto the labels themselves, so
    // this has to keep holding.
    await page.setViewportSize({ width: 760, height: 800 });
    await page.waitForTimeout(250);
    const modes = await page.evaluate(() => [...document.querySelectorAll('.mode-opt')].map((e) => {
      const r = e.getBoundingClientRect();
      return { label: e.textContent.trim(), onScreen: r.left >= 0 && r.right <= innerWidth };
    }));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(250);
    assert.ok(modes.length >= 3, 'the mode switch went missing entirely');
    for (const m of modes) assert.ok(m.onScreen, `"${m.label}" was pushed off the window`);
  });

  test('licence issuing is not sitting out on the dashboard for a customer', async () => {
    // The thing being protected is not the panel, it is the ability to mint
    // licences for other people. Four ways in are checked, because "the button
    // is hidden" is not a security property on its own.
    await resetScene(page);
    // The precondition is "this is an ordinary customer, not the founder".
    //
    // It used to be spelled `licence.status === 'trial'`, which was incidental
    // rather than the point: a signed-in account is the authority on access
    // and deliberately does not consult the licence server at all, so its
    // licence status is legitimately not 'trial'. What has to be true before
    // the four checks below mean anything is that this session holds no owner
    // licence — which is the thing issuing is gated on.
    const asCustomer = await page.evaluate(() => ({
      licence: window.culpmixer.editor.licence.status,
      canUse: window.culpmixer.editor.canUse,
      button: !!document.querySelector('.issue-chip'),
    }));
    assert.notEqual(asCustomer.licence, 'owner', 'the harness user holds an owner licence');
    assert.equal(asCustomer.canUse, true, 'the harness user cannot use the application at all');
    assert.equal(asCustomer.button, false, 'a trial user can see the issuing button');

    // Opening the panel by hand from the console gets a refusal, not a form.
    const forced = await page.evaluate(() => {
      window.culpmixer.editor.panels.toggleIssue?.();
      const panel = document.querySelector('.issue-panel');
      return {
        open: panel ? !panel.classList.contains('hidden') : false,
        text: (panel?.textContent || '').replace(/\s+/g, ' '),
        form: !!document.querySelector('.issue-field[type=email]'),
        pem: !!document.querySelector('.issue-pem'),
      };
    });
    assert.equal(forced.form, false, 'the issuing form was reachable without an owner licence');
    assert.equal(forced.pem, false, 'the signing-key box was reachable without an owner licence');
    assert.match(forced.text, /Only the founder issues licences/);

    // The signer is not hung off the page object for anybody to call.
    const reachable = await page.evaluate(() => !!window.culpmixer.__issue || !!window.issueKey);
    assert.equal(reachable, false, 'the signing function is exposed on the page');

    // And the honest case: somebody edits licence.status in devtools. They
    // reach the setup screen — which asks them for the signing key, the one
    // thing that is never shipped — and can mint nothing without it.
    const flipped = await page.evaluate(async () => {
      window.culpmixer.editor.licence = {
        status: 'owner',
        licence: { name: 'x', plan: 'x', seats: 0, issued: 0, expires: null, owner: true },
      };
      document.querySelector('.issue-panel')?.classList.add('hidden');
      window.culpmixer.editor.panels.toggleIssue?.();
      document.querySelector('.issue-go')?.click();
      await new Promise((done) => setTimeout(done, 400));
      const out = document.querySelector('.issue-out');
      return {
        asksForAKey: !!document.querySelector('.issue-pem'),
        note: document.querySelector('.issue-note')?.textContent || '',
        minted: !!out && !out.classList.contains('hidden'),
      };
    });
    assert.equal(flipped.asksForAKey, true, 'it offered to issue without asking for a key');
    assert.equal(flipped.minted, false, 'a flipped licence minted a key with no signing key');
    assert.match(flipped.note, /not a P-256 private key/);

    // The flip does not outlive the page: the real state is recomputed from a
    // stored signature at startup, so it is gone on the next load.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.culpmixer?.editor?.renderer, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    const afterReload = await page.evaluate(() => ({
      licence: window.culpmixer.editor.licence.status,
      button: !!document.querySelector('.issue-chip'),
    }));
    assert.notEqual(afterReload.licence, 'owner', 'an edited licence survived a reload');
    assert.equal(afterReload.button, false, 'the issuing button came back after a reload');
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
      document.querySelector('.setup-guide')?.classList.add('hidden');
    });
  });

  test('the founder sets where people pay, and the locked screen sends them there', async () => {
    // The whole point of the trial ending. A customer who hits the wall and
    // finds no way to pay is a customer who does not pay, so the link behind
    // that button is the founder's to set from inside the application — not a
    // thing to be edited in code and redeployed.
    await resetScene(page);
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.licence = {
        status: 'owner',
        licence: { name: 'x', plan: 'x', seats: 0, issued: 0, expires: null, owner: true },
      };
      document.querySelector('.issue-panel')?.classList.add('hidden');
      ed.panels.toggleIssue?.();
    });
    await page.waitForTimeout(200);
    const field = await page.$('.issue-pay input[type=url]');
    assert.ok(field, 'the founder has nowhere to put a payment link');

    // A link people click has to be a link, so this one is refused outright.
    await field.fill('javascript:alert(1)');
    await page.click('.issue-pay .issue-go');
    await page.waitForTimeout(200);
    const refused = await page.$eval('.issue-pay .issue-note', (e) => e.textContent);
    assert.match(refused, /not a link people can pay through/,
      `a javascript: link was accepted: ${refused}`);

    await field.fill('https://buy.stripe.com/test_culp199');
    await page.click('.issue-pay .issue-go');
    await page.waitForTimeout(250);
    const how = await page.$eval('.issue-pay .issue-out', (e) => e.textContent);
    assert.match(how, /CULPMIXER_PAYMENT_LINK/, 'it does not say how to publish the link');
    assert.match(how, /pay\.json/, 'it does not offer the no-backend way to publish it');

    // And the screen a customer actually meets when their time is up.
    const seen = await page.evaluate(async () => {
      const ed = window.culpmixer.editor;
      ed.account = { status: 'locked', username: 'Dana', email: 'd@e.co', plan: 'Trial' };
      ed.previewLocked();
      await new Promise((done) => setTimeout(done, 600));
      const link = document.querySelector('.home-go[href]');
      return {
        title: (document.querySelector('.home-locked-title')?.textContent || '').trim(),
        label: (link?.textContent || '').trim(),
        href: link?.getAttribute('href') || null,
        newTab: link?.getAttribute('target') === '_blank',
      };
    });
    assert.match(seen.title, /33 hours are up/);
    assert.equal(seen.href, 'https://buy.stripe.com/test_culp199',
      `the pay button went to ${seen.href}`);
    assert.match(seen.label, /Pay/);
    assert.equal(seen.newTab, true, 'paying should not navigate away from their work');

    // Put it back so nothing after this meets a lock screen.
    await page.evaluate(() => {
      try { localStorage.removeItem('culpmixer.payment.link'); } catch { /* ignore */ }
      document.querySelector('.home')?.classList.add('hidden');
      document.querySelector('.issue-panel')?.classList.add('hidden');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.culpmixer?.editor?.renderer, null, { timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
      document.querySelector('.setup-guide')?.classList.add('hidden');
    });
  });

  test('a refusal always says why, whether it is the key or the account', async () => {
    // Two silent failures found by driving the real thing rather than by any
    // test. Both are the same shape, and it is the shape that made the whole
    // application feel broken: press something, nothing happens, nothing said.
    //
    // 1. A command id that does not exist returned in silence, so a generated
    //    program naming one did nothing and reported success.
    // 2. whyBlocked reads the licence, but the block can come from the
    //    account — a locked account usually still carries an ordinary offline
    //    trial licence, so it returned '' and every refusal after the trial
    //    ended was mute.
    await resetScene(page);
    const unknown = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      ed.setStatus('');
      window.culpmixer.run('add.thisIsNotACommand');
      return ed.statusMessage;
    });
    assert.match(unknown, /no command called/i,
      `an unknown command said: "${unknown}"`);

    const locked = await page.evaluate(() => {
      const ed = window.culpmixer.editor;
      const wasAccount = ed.account;
      ed.account = { status: 'locked', username: 'x', email: 'x@y.co', plan: 'Trial' };
      const message = ed.licenceBlockedMessage;
      ed.setStatus('');
      const before = ed.scene.objects.size;
      window.culpmixer.run('add.cube');
      const out = { message, said: ed.statusMessage, added: ed.scene.objects.size - before };
      ed.account = wasAccount;
      return out;
    });
    assert.equal(locked.added, 0, 'a locked account could still add geometry');
    assert.match(locked.message, /33-hour free trial has ended/,
      `a locked account explained itself as: "${locked.message}"`);
    assert.match(locked.message, /\$199/, 'the refusal does not say what it costs');
    assert.equal(locked.said, locked.message, 'the refusal was not put on screen');
  });

  test('nothing logged an error to the console along the way', () => {
    assert.deepEqual(app.consoleErrors, [], `the app logged: ${app.consoleErrors.join(' | ')}`);
  });
}
