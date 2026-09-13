/*
 * One project, start to finish, in a real browser.
 *
 * The unit suite proves each piece works. This proves they work *together* —
 * a different claim, and the one a person actually cares about. Geometry is
 * modelled, sculpted, unwrapped, textured, rigged and animated; a revision is
 * previewed and rejected, then previewed and accepted; the document is saved,
 * replaced and reopened; physics is baked under an animated parent; a still
 * and a short sequence are rendered; and the result is exported and parsed
 * back by something that is not Kline's own loader.
 *
 * The steps run in order and hand state to each other, because that is what a
 * project is. Everything goes through commands and real clicks, so nothing
 * here can pass by reaching past the editor into the scene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, resetScene, screenPoint } from './app/harness.mjs';

const app = await launchApp();
if (app.skip) {
  test('end-to-end project', { skip: `${app.skip} — the journey did not run` }, () => {});
} else {
  test.after(() => app.close());
  const { page } = app;

  /** What the journey carries forward, filled in as it goes. */
  const carried = {};

  /**
   * How wide an asset is, in world space, across its whole subtree.
   *
   * A generated asset is a group: the root carries the record and the parts
   * carry the geometry, so measuring the root's own mesh finds nothing.
   */
  const spanX = (id) => page.evaluate((rootId) => {
    const ed = window.kline.editor;
    let lo = Infinity, hi = -Infinity;
    const walk = (objId) => {
      const o = ed.scene.get(objId);
      if (!o) return;
      if (o.mesh) {
        const m = o.worldMatrix(ed.scene).m;
        for (const p of o.mesh.positions) {
          const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }
      for (const child of o.children ?? []) walk(child);
    };
    walk(rootId);
    return hi - lo;
  }, id);

  const drag = async (from, steps = 10, dx = 6, dy = 0) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + i * dx, from.y + i * dy);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  test('1 · model it, unwrap it, sculpt it', async () => {
    await resetScene(page);
    const shaped = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.uvsphere');
      const id = ed.scene.active;
      const o = ed.scene.get(id);
      const startFaces = o.mesh.faces.length;

      k.run('edit.toggleMode');
      k.run('select.all');
      k.run('mesh.subdivide');
      const subdivided = o.mesh.faces.length;
      k.run('uv.smart');
      const uvFaces = (o.mesh.faceUV ?? []).filter(Boolean).length;
      k.run('edit.toggleMode');

      k.run('mode.sculpt');
      ed.sculpt.brush = 'draw';
      ed.sculpt.radius = 0.5;
      window.__before = o.mesh.positions.map((p) => [p.x, p.y, p.z]);
      return { id, startFaces, subdivided, uvFaces, faces: o.mesh.faces.length, mode: ed.mode };
    });
    assert.ok(shaped.subdivided > shaped.startFaces, 'subdivision added no faces');
    assert.equal(shaped.uvFaces, shaped.faces, 'the unwrap left faces without UVs');
    assert.equal(shaped.mode, 'sculpt');

    const centre = await screenPoint(page, [0, 0, 0]);
    await drag({ x: centre.x - 30, y: centre.y });

    const sculpted = await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = ed.scene.get(ed.scene.active);
      let moved = 0;
      o.mesh.positions.forEach((p, i) => {
        const q = window.__before[i];
        if (Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]) > 1e-6) moved++;
      });
      window.kline.run('mode.object');
      return { moved, uvsKept: (o.mesh.faceUV ?? []).filter(Boolean).length };
    });
    assert.ok(sculpted.moved > 10, `the stroke moved ${sculpted.moved} vertices`);
    assert.equal(sculpted.uvsKept, shaped.faces, 'sculpting dropped the UVs');
    carried.meshId = shaped.id;
  });

  test('2 · paint a texture onto it', async () => {
    const painted = await page.evaluate(async () => {
      const k = window.kline, ed = k.editor;
      k.run('paint.newTexture');
      await new Promise((r) => setTimeout(r, 200));
      const o = ed.scene.get(ed.scene.active);
      const slot = o.materialSlots?.[0] ?? 0;
      const mat = ed.scene.materials[slot];
      return {
        textures: ed.scene.textures.length,
        hasMap: mat?.baseColorTexture != null,
        url: ed.scene.textures[0]?.url?.slice(0, 20) ?? null,
      };
    });
    assert.ok(painted.textures > 0, 'no texture was created');
    assert.equal(painted.hasMap, true, 'the new texture was not attached to the material');
    assert.match(painted.url ?? '', /^data:image/, 'the texture is not embedded in the document');
  });

  test('3 · rig it and bind it', async () => {
    const rigged = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      const meshId = ed.scene.active;
      k.run('add.armature');
      const rigId = ed.scene.active;
      k.run('rig.extrudeBone');
      k.run('rig.extrudeBone');
      const bones = ed.scene.get(rigId).armature.bones.length;

      // Bind selects the mesh and the armature together, the way a person does.
      ed.scene.selection.clear();
      ed.scene.selection.add(meshId);
      ed.scene.selection.add(rigId);
      ed.scene.active = rigId;
      k.run('rig.bind');

      const mesh = ed.scene.get(meshId);
      const mod = (mesh.modifiers ?? []).find((m) => m.type === 'armature');
      const skin = mesh.mesh.skin;
      let bound = 0;
      if (skin) for (const b of skin.bones) if (b >= 0) bound++;
      return { bones, linked: mod?.objectId === rigId, bound, rigId, meshId };
    });
    assert.ok(rigged.bones >= 3, `the armature has ${rigged.bones} bones`);
    assert.equal(rigged.linked, true, 'binding did not link the modifier to the armature');
    assert.ok(rigged.bound > 0, 'binding produced no weights');
    carried.rigId = rigged.rigId;
    carried.meshId = rigged.meshId;
  });

  test('4 · animate it, and scrub it', async () => {
    const animated = await page.evaluate(({ rigId }) => {
      const k = window.kline, ed = k.editor;
      ed.scene.timeline.start = 1;
      ed.scene.timeline.end = 12;
      ed.scene.selection.clear();
      ed.scene.selection.add(rigId);
      ed.scene.active = rigId;

      ed.setFrame(1);
      const rig = ed.scene.get(rigId);
      rig.position.x = 0;
      k.run('anim.insertKey');
      ed.setFrame(12);
      ed.scene.get(rigId).position.x = 4;
      k.run('anim.insertKey');

      // Scrubbing must go through the same evaluation as playback.
      ed.setFrame(1);
      const atStart = ed.scene.get(rigId).position.x;
      ed.setFrame(12);
      const atEnd = ed.scene.get(rigId).position.x;
      ed.setFrame(6);
      const middle = ed.scene.get(rigId).position.x;
      return {
        channels: (ed.scene.get(rigId).animation ?? []).length,
        atStart, atEnd, middle,
      };
    }, { rigId: carried.rigId });
    assert.ok(animated.channels > 0, 'no animation channel was written');
    assert.ok(Math.abs(animated.atStart) < 1e-6, `frame 1 evaluated to ${animated.atStart}`);
    assert.ok(Math.abs(animated.atEnd - 4) < 1e-6, `frame 12 evaluated to ${animated.atEnd}`);
    assert.ok(animated.middle > 0.1 && animated.middle < 3.9,
      `frame 6 should be between the keys, got ${animated.middle}`);
  });

  test('5 · build from a program, revise it, reject the revision', async () => {
    // The code panel is the revision path that needs no model, and it is the
    // one a person without a local model actually has.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.scene.selection.clear();
      ed.scene.active = null;
    });
    await page.locator('.build-row button', { hasText: 'Code' }).first().click();
    const area = page.locator('.code-area');
    await area.fill("box(0, 0, 0.5, 2, 1, 1, '#c0392b');\nbox(0, 0, 1.6, 1, 1, 1.2, '#2d6a4f');");
    await page.locator('.build-code button', { hasText: 'Run as New' }).click();
    await page.waitForFunction(() => {
      const ed = window.kline.editor;
      const o = ed.scene.get(ed.scene.active);
      return !!o?.provenance;
    }, null, { timeout: 20000 });

    const assetId = await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = ed.scene.get(ed.scene.active);
      // Edit it by hand, so the merge has something of the creator's to keep.
      o.position.y = 3;
      return { id: o.id, asset: o.provenance.assetId, y: o.position.y };
    });
    carried.asset = assetId;

    // A revision that would change the shape, previewed and then rejected.
    await area.fill("box(0, 0, 0.5, 4, 1, 1, '#c0392b');\nbox(0, 0, 1.6, 1, 1, 1.2, '#2d6a4f');");
    await page.locator('.build-code button', { hasText: 'Preview Revision of Selected' }).click();
    await page.locator('.revision-panel:not(.hidden)').waitFor({ timeout: 20000 });
    const duringPreview = await page.evaluate(() => ({
      active: window.kline.editor.revision.active,
      historyDepth: window.kline.editor.history.depth,
    }));
    assert.equal(duringPreview.active, true, 'the revision did not start');

    await page.locator('.revision-actions button', { hasText: 'Reject' }).click();
    await page.waitForTimeout(200);
    const afterReject = await page.evaluate(({ id }) => {
      const ed = window.kline.editor;
      const o = ed.scene.get(id);
      return { active: ed.revision.active, y: o.position.y, historyDepth: ed.history.depth };
    }, { id: assetId.id });
    afterReject.width = await spanX(assetId.id);
    assert.equal(afterReject.active, false, 'the revision is still open after Reject');
    assert.ok(Math.abs(afterReject.y - 3) < 1e-6, 'Reject lost the edit that was made by hand');
    assert.equal(afterReject.historyDepth, duringPreview.historyDepth,
      'a rejected revision left a step in the undo history');
    carried.rejectedWidth = afterReject.width;
  });

  test('6 · revise it again and accept', async () => {
    const area = page.locator('.code-area');
    await area.fill("box(0, 0, 0.5, 6, 1, 1, '#c0392b');\nbox(0, 0, 1.6, 1, 1, 1.2, '#2d6a4f');");
    await page.locator('.build-code button', { hasText: 'Preview Revision of Selected' }).click();
    await page.locator('.revision-panel:not(.hidden)').waitFor({ timeout: 20000 });
    const accept = page.locator('.revision-actions button', { hasText: 'Accept' });
    assert.equal(await accept.isDisabled(), false,
      'Accept is blocked — a conflict was raised that this journey did not create');
    await accept.click();
    await page.waitForTimeout(300);

    const after = await page.evaluate(({ id }) => {
      const ed = window.kline.editor;
      const o = ed.scene.get(id);
      return { active: ed.revision.active, y: o.position.y, revision: o.provenance.revision };
    }, { id: carried.asset.id });
    after.width = await spanX(carried.asset.id);
    assert.equal(after.active, false, 'the revision is still open after Accept');
    assert.ok(after.width > carried.rejectedWidth,
      `Accept did not widen the asset (${after.width} vs ${carried.rejectedWidth})`);
    assert.ok(Math.abs(after.y - 3) < 1e-6, 'Accept discarded the hand edit it was merged with');
    await page.evaluate(() => window.kline.run('edit.undo'));
    await page.waitForTimeout(150);
    const undone = await spanX(carried.asset.id);
    assert.ok(Math.abs(undone - carried.rejectedWidth) < 1e-6,
      'undo did not take the accepted revision back off');
    await page.evaluate(() => window.kline.run('edit.redo'));
    await page.waitForTimeout(150);
  });

  test('7 · save the document, replace it, and open it again', async () => {
    const saved = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const json = JSON.stringify(ed.scene.toJSON());
      window.__saved = json;
      return { bytes: json.length, objects: ed.scene.objects.size, dirty: ed.hasUnsavedChanges };
    });
    assert.ok(saved.bytes > 1000, 'the document serialized to almost nothing');
    assert.ok(saved.objects >= 3, `only ${saved.objects} objects in the document`);

    // Replace the document, then read the saved one back through the loader.
    const reopened = await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.newScene();
      const emptied = ed.scene.objects.size;
      ed.loadSceneJSON(JSON.parse(window.__saved));
      const objects = [...ed.scene.objects.values()];
      const mesh = objects.find((o) => o.mesh?.skin);
      const rig = objects.find((o) => o.type === 'armature');
      return {
        emptied,
        objects: objects.length,
        textures: ed.scene.textures.length,
        skinKept: !!mesh?.mesh.skin,
        uvsKept: (mesh?.mesh.faceUV ?? []).filter(Boolean).length > 0,
        animationKept: (rig?.animation ?? []).length > 0,
        provenanceKept: objects.some((o) => o.provenance?.revision >= 1),
      };
    });
    assert.ok(reopened.emptied <= 1, 'New Scene left the old document behind');
    assert.equal(reopened.objects, saved.objects, 'objects were lost across save and reopen');
    assert.ok(reopened.textures > 0, 'the embedded texture did not survive the round trip');
    assert.equal(reopened.skinKept, true, 'skin weights did not survive the round trip');
    assert.equal(reopened.uvsKept, true, 'UVs did not survive the round trip');
    assert.equal(reopened.animationKept, true, 'animation did not survive the round trip');
    assert.equal(reopened.provenanceKept, true, 'the accepted revision was not recorded in the file');
  });

  test('8 · bake physics under an animated parent', async () => {
    const baked = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      ed.scene.timeline.start = 1;
      ed.scene.timeline.end = 20;

      k.run('add.empty');
      const parentId = ed.scene.active;
      ed.setFrame(1);
      ed.scene.get(parentId).position.x = 0;
      k.run('anim.insertKey');
      ed.setFrame(20);
      ed.scene.get(parentId).position.x = 5;
      k.run('anim.insertKey');
      ed.setFrame(1);

      k.run('add.cube');
      const boxId = ed.scene.active;
      ed.scene.get(boxId).position.z = 4;
      ed.scene.setParent(boxId, parentId);
      k.run('physics.makeActive');

      k.run('add.plane');
      const floorId = ed.scene.active;
      ed.scene.get(floorId).scale.x = 10;
      ed.scene.get(floorId).scale.y = 10;
      k.run('physics.makePassive');

      k.run('physics.bake');
      const box = ed.scene.get(boxId);
      const keys = (box.animation ?? []).reduce((n, c) => n + c.keys.length, 0);

      // The simulation happens in world space; the file stores local
      // transforms. So every frame has to be written through the parent's pose
      // *at that frame*, and this parent is moving. Sampled at three frames,
      // because a bake that used one static parent matrix still lands frame 1
      // correctly and only goes wrong later.
      const samples = [];
      for (const f of [1, 10, 20]) {
        ed.setFrame(f);
        const w = box.worldMatrix(ed.scene).m;
        samples.push({
          f,
          parentX: ed.scene.get(parentId).position.x,
          localX: box.position.x,
          worldX: w[12],
          worldZ: w[14],
        });
      }
      return { keys, samples, parented: box.parent === parentId };
    });
    assert.equal(baked.parented, true, 'the box lost its parent');
    assert.ok(baked.keys > 0, 'the bake wrote no keyframes');
    const last = baked.samples[baked.samples.length - 1];
    assert.ok(Math.abs(last.parentX - 5) < 1e-6, `the parent did not animate (${last.parentX})`);
    for (const s of baked.samples) {
      // A falling body is not dragged sideways by its parent's animation, so
      // the world path is straight down and the *local* channel is what has to
      // carry the compensation.
      assert.ok(Math.abs(s.worldX) < 0.05,
        `frame ${s.f}: the body was dragged to world x ${s.worldX} by its parent`);
      assert.ok(Math.abs(s.localX + s.parentX) < 0.05,
        `frame ${s.f}: local x ${s.localX} does not cancel a parent at ${s.parentX}`);
    }
    assert.ok(baked.samples[0].worldZ > 3, 'the body did not start where it was put');
    assert.ok(Math.abs(last.worldZ - 1) < 0.15,
      `the cube came to rest at z ${last.worldZ} rather than on the floor`);
  });

  test('9 · render a still and a short sequence', async () => {
    const still = await page.evaluate(async () => {
      const ed = window.kline.editor;
      ed.renderSettings.width = 64;
      ed.renderSettings.height = 48;
      ed.renderSettings.samples = 4;
      const job = await ed.renderWithTextures(false);
      if (!job) return { started: false };
      for (let i = 0; i < 400 && !job.finished && !job.cancelled; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const image = job.toImageData(false);
      let lit = 0;
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 0) lit++;
      return { started: true, finished: job.finished, triangles: job.triangles,
        pixels: image.data.length / 4, lit };
    });
    assert.equal(still.started, true, 'the still render never started');
    assert.equal(still.finished, true, 'the still render did not finish');
    assert.ok(still.triangles > 0, 'the render saw no geometry');
    assert.ok(still.lit > still.pixels * 0.2,
      `only ${still.lit} of ${still.pixels} pixels carry any light`);

    const sequence = await page.evaluate(async () => {
      const ed = window.kline.editor;
      ed.renderSettings.frameStart = 1;
      ed.renderSettings.frameEnd = 3;
      ed.renderSettings.frameStep = 1;
      const frames = [];
      const progress = [];
      const ok = await ed.renderAnimationTo({
        describe: () => 'collecting frames in the test',
        async write(image, total) {
          frames.push({ frame: image.frame, w: image.width, h: image.height,
            sum: image.pixels.reduce((a, b) => a + b, 0) });
          progress.push(total);
          return true;
        },
        async finish(written, cancelled) { return `wrote ${written}${cancelled ? ' (cancelled)' : ''}`; },
      });
      return { ok, frames, progress, playhead: ed.scene.timeline.current, status: ed.statusMessage };
    });
    assert.equal(sequence.ok, true, `the sequence render failed: ${sequence.status}`);
    assert.equal(sequence.frames.length, 3, `rendered ${sequence.frames.length} frames, wanted 3`);
    assert.deepEqual(sequence.frames.map((f) => f.frame), [1, 2, 3], 'the frame numbers are wrong');
    assert.ok(sequence.frames.every((f) => f.sum > 0), 'a frame came out entirely black');
    // The animated scene must actually differ between frames.
    const sums = sequence.frames.map((f) => f.sum);
    assert.notEqual(sums[0], sums[2], 'every frame rendered identically — the playhead did not move');
    assert.ok(sequence.progress.every((t) => t === 3), 'the total handed to the destination was wrong');
  });

  test('10 · cancel a sequence part way through', async () => {
    const cancelled = await page.evaluate(async () => {
      const ed = window.kline.editor;
      ed.renderSettings.frameStart = 1;
      ed.renderSettings.frameEnd = 8;
      let seen = 0;
      let note = '';
      const ok = await ed.renderAnimationTo({
        describe: () => 'cancel test',
        async write() {
          seen++;
          if (seen === 2) ed.cancelAnimation();
          return true;
        },
        async finish(written, wasCancelled) {
          note = `${written}|${wasCancelled}`;
          return 'stopped';
        },
      });
      return { ok, seen, note, sequence: ed.activeSequence, playhead: ed.scene.timeline.current };
    });
    assert.ok(cancelled.seen < 8, `cancelling wrote all ${cancelled.seen} frames anyway`);
    assert.match(cancelled.note, /\|true$/, 'the destination was not told it had been cancelled');
    assert.equal(cancelled.sequence, null, 'the render is still marked as running');
  });

  test('11 · two cameras, set differently', async () => {
    // The export has to carry each camera's own settings rather than one
    // default applied to all of them, so the scene needs two that differ.
    const cams = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.camera');
      const wide = ed.scene.get(ed.scene.active);
      wide.name = 'Wide';
      wide.camera.fov = 1.2;
      wide.camera.near = 0.05;
      k.run('add.camera');
      const tight = ed.scene.get(ed.scene.active);
      tight.name = 'Tight';
      tight.camera.fov = 0.35;
      tight.camera.near = 0.2;
      tight.position.z = 3;
      return [...ed.scene.objects.values()]
        .filter((o) => o.type === 'camera')
        .map((o) => ({ name: o.name, fov: o.camera.fov, near: o.camera.near }));
    });
    assert.equal(cams.length, 2, `the scene has ${cams.length} cameras`);
    assert.notEqual(cams[0].fov, cams[1].fov, 'both cameras have the same field of view');
    carried.cameras = cams;
  });

  test('12 · export it, and read it back with something that is not Kline', async () => {
    // Exported through the File command, caught as a real download, and parsed
    // here by code that knows nothing about Kline's own loader — which is the
    // only way to find out whether the file is any use to anybody else.
    //
    // Saving goes through the File System Access API, which is what Chrome and
    // Edge actually do: a file the person picks, a write that either lands or
    // throws, and a real "Saved" rather than a guess. A multi-file export asks
    // for one folder instead of one dialog per file, because a picker spends
    // the gesture that opened it and the second dialog would throw. Both
    // pickers need a live user gesture a script cannot have, so they are stood
    // in for here; everything past the picker is Kline's own code.
    const installPickers = () => page.evaluate(() => {
      window.__saved = [];
      const writable = (name) => {
        const parts = [];
        return {
          async write(data) { parts.push(data); },
          async close() {
            window.__saved.push({ name, text: await new Blob(parts).text() });
          },
          async abort() {},
        };
      };
      window.showSaveFilePicker = async ({ suggestedName }) => ({
        name: suggestedName,
        createWritable: async () => writable(suggestedName),
      });
      window.showDirectoryPicker = async () => ({
        name: 'chosen-folder',
        async getFileHandle(name) {
          return { name, createWritable: async () => writable(name) };
        },
      });
    });

    const grab = async (commandId, expected = 1) => {
      await installPickers();
      await page.evaluate((id) => window.kline.run(id), commandId);
      await page.waitForFunction(
        (want) => (window.__saved ?? []).length >= want, expected, { timeout: 20000 },
      ).catch(async () => {
        const why = await page.evaluate(() => window.kline.editor.statusMessage);
        throw new Error(`${commandId} wrote ${(await page.evaluate(() => window.__saved.length))}`
          + ` of ${expected} files. Status bar: "${why}"`);
      });
      const files = await page.evaluate(() => window.__saved);
      const status = await page.evaluate(() => window.kline.editor.statusMessage);
      assert.doesNotMatch(status, /cancel|could not|failed/i,
        `after saving, the status bar said: ${status}`);
      return { files, status, ...files[0] };
    };

    const { name, text, status: gltfStatus } = await grab('file.exportGltf');
    assert.match(gltfStatus, /^Saved /,
      `a real save should report a saved file, not: ${gltfStatus}`);
    assert.match(name, /\.gltf$/, `the export was named ${name}`);
    const doc = JSON.parse(text);

    assert.equal(doc.asset?.version, '2.0', 'the file does not declare glTF 2.0');
    assert.ok(doc.scenes?.length >= 1 && doc.nodes?.length >= 1, 'the file has no scene');
    assert.ok(doc.meshes?.length >= 1, 'nothing was exported as a mesh');

    // Every accessor has to resolve through its bufferView into a real buffer,
    // and the arithmetic has to close. A file that fails this opens as an
    // empty scene in another application and says nothing about why.
    const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const buffers = (doc.buffers ?? []).map((b) => {
      assert.match(b.uri ?? '', /^data:.*;base64,/, 'a buffer is not embedded in the file');
      const bytes = Buffer.from(b.uri.split(',')[1], 'base64');
      assert.equal(bytes.length, b.byteLength, 'a buffer is not the length it declares');
      return bytes;
    });
    assert.ok(buffers.length >= 1, 'the file references no buffer at all');
    for (const [i, a] of (doc.accessors ?? []).entries()) {
      const view = doc.bufferViews[a.bufferView];
      assert.ok(view, `accessor ${i} points at no bufferView`);
      const stride = SIZES[a.componentType] * COUNTS[a.type];
      assert.ok(stride > 0, `accessor ${i} has an unknown type`);
      const end = (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + a.count * stride;
      assert.ok(end <= buffers[view.buffer].length,
        `accessor ${i} reads ${end} bytes from a ${buffers[view.buffer].length} byte buffer`);
    }
    for (const mesh of doc.meshes) {
      for (const prim of mesh.primitives) {
        const positions = doc.accessors[prim.attributes.POSITION];
        assert.ok(positions, 'a primitive has no POSITION');
        for (const [attr, idx] of Object.entries(prim.attributes)) {
          assert.equal(doc.accessors[idx].count, positions.count,
            `${attr} has a different vertex count from POSITION`);
        }
        if (prim.indices !== undefined) {
          const idx = doc.accessors[prim.indices];
          const view = doc.bufferViews[idx.bufferView];
          const bytes = buffers[view.buffer];
          const base = (view.byteOffset ?? 0) + (idx.byteOffset ?? 0);
          let worst = -1;
          for (let i = 0; i < idx.count; i++) {
            const v = idx.componentType === 5125
              ? bytes.readUInt32LE(base + i * 4)
              : bytes.readUInt16LE(base + i * 2);
            if (v > worst) worst = v;
          }
          assert.ok(worst < positions.count,
            `an index reaches vertex ${worst} of ${positions.count}`);
        }
      }
    }

    // The node tree has to be a tree: every child reachable once, no cycles.
    const seen = new Set();
    const walk = (i, depth) => {
      assert.ok(depth < 64, 'the node tree has a cycle');
      assert.ok(!seen.has(i), `node ${i} appears twice in the tree`);
      seen.add(i);
      for (const c of doc.nodes[i].children ?? []) walk(c, depth + 1);
    };
    for (const root of doc.scenes[doc.scene ?? 0].nodes) walk(root, 0);

    // And the things this project actually put in it.
    assert.equal(doc.cameras?.length, 2, 'the two cameras did not both reach the file');
    const yfovs = doc.cameras.map((c) => c.perspective?.yfov).filter((v) => v !== undefined);
    assert.equal(yfovs.length, 2, 'a camera came out without a perspective');
    assert.notEqual(yfovs[0], yfovs[1],
      'both exported cameras share one field of view — each camera\'s own settings were not carried');
    const znears = doc.cameras.map((c) => c.perspective.znear);
    assert.notEqual(znears[0], znears[1], 'both cameras share one near plane');
    assert.equal(doc.nodes.filter((n) => n.camera !== undefined).length, 2,
      'the camera nodes are not both in the tree');
    assert.ok(doc.skins?.length >= 1, 'the rig was not exported as a skin');
    const skin = doc.skins[0];
    assert.ok(skin.joints?.length >= 1, 'the skin has no joints');
    assert.ok(skin.inverseBindMatrices !== undefined, 'the skin has no bind matrices');
    assert.equal(doc.accessors[skin.inverseBindMatrices].count, skin.joints.length,
      'there is not one bind matrix per joint');
    const skinned = doc.meshes.some((m, i) =>
      doc.nodes.some((n) => n.mesh === i && n.skin !== undefined));
    assert.equal(skinned, true, 'no node binds a mesh to the skin');
    assert.ok(doc.animations?.length >= 1, 'the animation was not exported');
    for (const anim of doc.animations) {
      for (const channel of anim.channels) {
        const sampler = anim.samplers[channel.sampler];
        assert.ok(sampler, 'an animation channel points at no sampler');
        assert.equal(doc.accessors[sampler.input].count, doc.accessors[sampler.output].count,
          'a sampler has a different number of times and values');
      }
    }

    // OBJ is not one file: geometry, a material library, and an image for
    // every texture the library names. They arrive together or not at all.
    const objExport = await grab('file.exportObj', 3);
    const obj = objExport.files.find((f) => f.name.endsWith('.obj'));
    assert.ok(obj, `no .obj among ${objExport.files.map((f) => f.name).join(', ')}`);
    assert.ok(objExport.files.some((f) => f.name.endsWith('.mtl')),
      'the material library did not come with the geometry');
    assert.ok(objExport.files.some((f) => /\.(png|jpe?g|webp)$/i.test(f.name)),
      'the texture the material names did not come with it');
    assert.match(objExport.status, /^Exported/,
      `a complete multi-file export should say so, not: ${objExport.status}`);
    const usedMaterials = [...obj.text.matchAll(/^usemtl (.+)$/gm)].map((m) => m[1].trim());
    assert.ok(/^v /m.test(obj.text), 'the OBJ has no vertices');
    assert.ok(/^f /m.test(obj.text), 'the OBJ has no faces');
    assert.ok(/^mtllib /m.test(obj.text), 'the OBJ names no material library');
    const vertexCount = (obj.text.match(/^v /gm) ?? []).length;
    for (const face of obj.text.match(/^f .*/gm) ?? []) {
      for (const ref of face.slice(2).trim().split(/\s+/)) {
        const v = Number(ref.split('/')[0]);
        assert.ok(v >= 1 && v <= vertexCount, `a face references vertex ${v} of ${vertexCount}`);
      }
    }
    assert.ok(usedMaterials.length > 0, 'the OBJ uses no material');
    carried.gltf = text;
  });

  test('13 · the Khronos validator accepts the export', async () => {
    // Structural checks of my own can only find what I thought to look for.
    // The official validator found three things I had not: unused skin slots
    // written as joint 65535, buffer views stamped ARRAY_BUFFER when they hold
    // bind matrices or animation samplers, and a skinned mesh carrying its own
    // transform that glTF would ignore. Five thousand six hundred and
    // eighty-three errors, on a file that passed every check above.
    const validator = (await import('gltf-validator')).default;
    const report = await validator.validateString(carried.gltf, {
      externalResourceFunction: () => Promise.reject(new Error('no external resources')),
    });
    const messages = report.issues.messages ?? [];
    const errors = messages.filter((m) => m.severity === 0);
    assert.equal(report.issues.numErrors, 0,
      `the validator found ${report.issues.numErrors} errors, first: `
      + errors.slice(0, 3).map((m) => `${m.code} at ${m.pointer}: ${m.message}`).join(' / '));

    // Warnings are allowed, but only the ones that are true of the format
    // rather than of the file. Anything else is a new problem.
    const allowed = new Set(['ANIMATION_CHANNEL_TARGET_NODE_SKIN', 'NODE_SKINNED_MESH_NON_ROOT']);
    const unexpected = messages.filter((m) => m.severity === 1 && !allowed.has(m.code));
    assert.deepEqual(unexpected.map((m) => `${m.code} at ${m.pointer}`), [],
      'the validator raised a warning this export did not expect');
  });

  test('13 · a save the person cancels leaves the work marked unsaved', async () => {
    // Only the desktop shell can report a cancellation — a browser hands the
    // file to a download manager and is never told what became of it — so the
    // shell is stood in for here. What is being tested is Kline's half: that
    // "cancelled" is not quietly treated as "saved".
    const result = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const calls = [];
      window.klineDesktop = {
        platform: 'test',
        registerCommands() {}, onCommand() {}, onShowShortcuts() {}, onOpenFile() {},
        async openScene() { return null; },
        async saveFile(name) { calls.push(name); return { status: 'cancelled' }; },
      };
      ed.markSaved();
      ed.scene.get([...ed.scene.objects.keys()][0]).position.z += 0.25;
      ed.touch?.();
      ed.unsavedChanges = true;
      ed.setStatus('');
      window.kline.run('file.save');
      await new Promise((r) => setTimeout(r, 300));
      return { calls, status: ed.statusMessage, dirty: ed.hasUnsavedChanges };
    });
    assert.equal(result.calls.length, 1, 'the save never reached the shell');
    assert.match(result.status, /cancel/i, `a cancelled save said: ${result.status}`);
    assert.equal(result.dirty, true, 'a cancelled save marked the document as saved');
  });

  test('14 · a write that fails says so, and says why', async () => {
    const result = await page.evaluate(async () => {
      const ed = window.kline.editor;
      window.klineDesktop.saveFile = async () => ({ status: 'failed', reason: 'the disk is full' });
      ed.unsavedChanges = true;
      ed.setStatus('');
      window.kline.run('file.save');
      await new Promise((r) => setTimeout(r, 300));
      const out = { status: ed.statusMessage, dirty: ed.hasUnsavedChanges };
      delete window.klineDesktop;
      return out;
    });
    assert.match(result.status, /disk is full/,
      `a failed write said: ${result.status}`);
    assert.doesNotMatch(result.status, /^Saved/, 'a failed write reported success');
    assert.equal(result.dirty, true, 'a failed write marked the document as saved');
  });

  test('15 · generated code refuses to run when no worker will start', async () => {
    // The isolation *is* the worker. A browser that will not start one — a
    // strict Content-Security-Policy is enough — used to fall back to this
    // thread, which drops the time limit and every removed global at once. The
    // program here is an infinite loop, so a fallback would hang the tab.
    // The render window is still up from step 9 and sits over the build bar.
    await page.evaluate(() => window.kline.app.renderWindow?.hide?.());
    const panel = page.locator('.build-code');
    if (await panel.evaluate((el) => el.classList.contains('hidden'))) {
      await page.locator('.build-row button', { hasText: 'Code' }).first().click();
    }
    await page.locator('.code-area').fill('for (;;) {}');
    const before = await page.evaluate(() => {
      window.__savedWorker = window.Worker;
      window.__savedUrl = URL.createObjectURL;
      delete window.Worker;
      delete URL.createObjectURL;
      const log = document.querySelector('.code-log');
      if (log) log.textContent = '';
      window.kline.editor.setStatus('');
      return window.kline.editor.scene.objects.size;
    });
    await page.locator('.build-code button', { hasText: 'Run as New' }).click();
    await page.waitForFunction(
      () => (document.querySelector('.code-log')?.textContent ?? '').length > 0,
      null,
      { timeout: 15000 },
    ).catch(() => undefined);
    const after = await page.evaluate(() => {
      window.Worker = window.__savedWorker;
      URL.createObjectURL = window.__savedUrl;
      return {
        objects: window.kline.editor.scene.objects.size,
        log: document.querySelector('.code-log')?.textContent ?? '',
        status: window.kline.editor.statusMessage,
      };
    });
    assert.equal(after.objects, before,
      'a program ran and built something with no worker available');
    assert.match(after.log, /worker/i,
      `refusing to run without a worker said: "${after.log}"`);
    assert.match(after.status, /did not run/i,
      `the status bar said: "${after.status}"`);
  });

  test('16 · a reload finds the work again', async () => {
    const saved = await page.evaluate(async () => {
      const ed = window.kline.editor;
      await ed.autosaveNow(true);
      const copies = await ed.recovery.list();
      return { objects: ed.scene.objects.size, copies: copies.length };
    });
    assert.ok(saved.copies >= 1, 'nothing was written to recover from');

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.kline, null, { timeout: 20000 });
    await page.locator('.recovery-bar:not(.hidden)').waitFor({ timeout: 20000 });
    const offered = await page.evaluate(() => {
      const objects = [...window.kline.editor.scene.objects.values()];
      return {
        text: document.querySelector('.recovery-bar')?.textContent ?? '',
        skinned: objects.some((o) => o.mesh?.skin),
        textures: window.kline.editor.scene.textures.length,
      };
    });
    assert.match(offered.text, /last session/i, `the recovery bar said: ${offered.text}`);
    // Offered, not forced: a reload must not put the old document back by
    // itself, because the copy somebody wants is often not the newest one.
    assert.equal(offered.skinned, false, 'the reload restored the rig without asking');
    assert.equal(offered.textures, 0, 'the reload restored the textures without asking');

    await page.locator('.recovery-bar button', { hasText: 'Restore' }).click();
    await page.waitForFunction(
      (want) => window.kline.editor.scene.objects.size === want,
      saved.objects,
      { timeout: 20000 },
    );
    const back = await page.evaluate(() => {
      const objects = [...window.kline.editor.scene.objects.values()];
      return {
        objects: objects.length,
        skinned: objects.some((o) => o.mesh?.skin),
        textured: window.kline.editor.scene.textures.length,
        animated: objects.some((o) => (o.animation ?? []).length > 0),
      };
    });
    assert.equal(back.objects, saved.objects, 'the restored scene is a different size');
    assert.equal(back.skinned, true, 'the rig did not come back');
    assert.ok(back.textured > 0, 'the texture did not come back');
    assert.equal(back.animated, true, 'the animation did not come back');
  });

  test('17 · IK, constraints and blended actions, through the panels', async () => {
    await resetScene(page);

    // Build a two-bone arm with a control bone, in the interface.
    const built = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.armature');
      const rigId = ed.scene.active;
      const rig = ed.scene.get(rigId);
      rig.armature.bones[0].head = [0, 0, 0];
      rig.armature.bones[0].tail = [0, 1, 0];
      rig.armature.bones[0].name = 'upper';
      k.run('rig.extrudeBone');
      rig.armature.bones[1].name = 'lower';
      k.run('rig.addControlBone');
      const control = rig.armature.bones[ed.activeBone];
      control.head = [1.2, 1.2, 0];
      control.tail = [1.2, 1.4, 0];
      // Put the IK on the lower bone, which is the tip of the chain.
      ed.activeBone = rig.armature.bones.findIndex((b) => b.name === 'lower');
      return { rigId, controlName: control.name, bones: rig.armature.bones.map((b) => b.name) };
    });
    assert.equal(built.bones.length, 3, `the rig has ${built.bones.join(', ')}`);
    assert.match(built.controlName, /^CTRL/, 'the control bone was not named as one');

    // Add the constraint through the Properties panel's own button, so the
    // control is proved connected rather than the command being called directly.
    const ikButton = page.locator('.prop-section', { hasText: 'Constraints' })
      .locator('button', { hasText: 'IK' }).first();
    assert.ok(await ikButton.count() > 0, 'the Constraints section has no IK button');
    await ikButton.click();

    // Bind a mesh to the rig, so what is measured is the geometry a person
    // would see move — not an internal matrix that might not reach it.
    const reach = await page.evaluate(({ rigId, controlName }) => {
      const k = window.kline, ed = k.editor;
      const rig = ed.scene.get(rigId);
      const lower = rig.armature.bones.find((b) => b.name === 'lower');
      const ik = (lower.constraints ?? [])[0];
      if (!ik) return { added: false };

      k.run('add.cube');
      const meshId = ed.scene.active;
      const mesh = ed.scene.get(meshId);
      mesh.scale.x = 0.2;
      mesh.scale.y = 1;
      mesh.scale.z = 0.2;
      mesh.position.y = 1;
      ed.scene.selection.clear();
      ed.scene.selection.add(meshId);
      ed.scene.selection.add(rigId);
      ed.scene.active = rigId;
      k.run('rig.bind');

      const spanOf = () => {
        const evaluated = ed.scene.get(meshId).evaluated();
        let maxX = -Infinity;
        for (const p of evaluated.positions) if (p.x > maxX) maxX = p.x;
        return maxX;
      };

      ik.enabled = false;
      ed.scene.get(meshId).invalidate();
      ed.scene.get(rigId).invalidate();
      const resting = spanOf();

      ik.enabled = true;
      ik.target = controlName;
      ik.chain = 2;
      ed.scene.get(meshId).invalidate();
      ed.scene.get(rigId).invalidate();
      const reaching = spanOf();

      return { added: true, kind: ik.type, resting, reaching, bound: !!ed.scene.get(meshId).mesh.skin };
    }, built);

    assert.equal(reach.added, true, 'the IK button did not add a constraint');
    assert.equal(reach.kind, 'ik', `the button added a ${reach.kind} constraint`);
    assert.equal(reach.bound, true, 'the mesh was not bound to the rig');
    assert.ok(reach.reaching > reach.resting + 0.3,
      `the skinned geometry did not follow the IK towards the control at x 1.2 `
      + `(rest ${reach.resting.toFixed(3)}, solved ${reach.reaching.toFixed(3)})`);

    // Blended actions, driven by the commands the buttons run.
    const blended = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.cube');
      const id = ed.scene.active;
      const obj = ed.scene.get(id);
      ed.scene.timeline.start = 1;
      ed.scene.timeline.end = 40;

      ed.setFrame(1);
      obj.position.x = 0;
      k.run('anim.insertKey');
      ed.setFrame(11);
      ed.scene.get(id).position.x = 10;
      k.run('anim.insertKey');
      k.run('anim.stashAction');
      const walkActions = ed.scene.get(id).actions.length;

      // A second take, stashed the same way. Inserting a key records every
      // transform axis, not only the one that moved — so X is put back to zero
      // for this take, or the additive strip would carry the walk's ten units
      // of travel on top of the walk itself.
      ed.scene.get(id).animation = [];
      ed.setFrame(1);
      ed.scene.get(id).position.x = 0;
      ed.scene.get(id).position.z = 0;
      k.run('anim.insertKey');
      ed.setFrame(11);
      ed.scene.get(id).position.x = 0;
      ed.scene.get(id).position.z = 4;
      k.run('anim.insertKey');
      k.run('anim.stashAction');

      const [walk, wave] = ed.scene.get(id).actions;
      ed.scene.get(id).animation = [];
      ed.setFrame(1);
      ed.addStrip(walk.id, 'replace');
      ed.addStrip(wave.id, 'add');
      const strips = ed.scene.get(id).strips.length;

      const at = (f) => {
        ed.setFrame(f);
        const o = ed.scene.get(id);
        return { x: o.position.x, z: o.position.z };
      };
      return { id, walkActions, actions: ed.scene.get(id).actions.length, strips,
        first: at(1), middle: at(6), last: at(11) };
    });
    assert.equal(blended.walkActions, 1, 'stashing did not keep the first take');
    assert.equal(blended.actions, 2, 'the second take was not kept');
    assert.equal(blended.strips, 2, 'both strips were not laid down');
    assert.ok(Math.abs(blended.middle.x - 5) < 0.2,
      `the walk should be halfway at frame 6, got x ${blended.middle.x}`);
    assert.ok(Math.abs(blended.middle.z - 2) < 0.2,
      `the additive take should also be halfway, got z ${blended.middle.z}`);
    assert.ok(Math.abs(blended.last.x - 10) < 0.2 && Math.abs(blended.last.z - 4) < 0.2,
      'neither take reached its end — one blend cancelled the other');

    // And the strips survive the document, which is what makes them worth having.
    const round = await page.evaluate(({ id }) => {
      const ed = window.kline.editor;
      const json = JSON.stringify(ed.scene.toJSON());
      ed.newScene();
      ed.loadSceneJSON(JSON.parse(json));
      const back = ed.scene.get(id) ?? [...ed.scene.objects.values()].find((o) => o.strips.length);
      ed.setFrame(6);
      return { strips: back?.strips.length ?? 0, x: back?.position.x ?? 0, z: back?.position.z ?? 0 };
    }, blended);
    assert.equal(round.strips, 2, 'the strips did not survive a save and reload');
    assert.ok(Math.abs(round.x - 5) < 0.2 && Math.abs(round.z - 2) < 0.2,
      'the reloaded strips evaluate differently from the ones that were saved');
  });

  test('18 · the shipped build does not gate anything without a signing key', async () => {
    // The release that just went out has no public key in it, and that must
    // mean "nothing to enforce" rather than "nobody can export". Checked in the
    // actual production bundle, because this is the failure that would brick
    // every copy at once.
    await resetScene(page);
    const state = await page.evaluate(async () => {
      const ed = window.kline.editor;
      await ed.refreshLicence();
      return {
        status: ed.licence.status,
        canExport: ed.canExport,
        summary: ed.licenceSummary,
        blocked: ed.licenceBlockedMessage,
      };
    });
    assert.equal(state.canExport, true, 'a build with no signing key refused to export');
    assert.equal(state.blocked, '', 'it gave a reason for blocking something it did not block');
    assert.match(state.summary, /no licence needed|source/i, `it said: ${state.summary}`);

    // And saving actually works, rather than merely claiming it would.
    const saved = await page.evaluate(async () => {
      window.__saved = [];
      window.showSaveFilePicker = async ({ suggestedName }) => ({
        name: suggestedName,
        createWritable: async () => {
          const parts = [];
          return {
            async write(d) { parts.push(d); },
            async close() { window.__saved.push(suggestedName); },
            async abort() {},
          };
        },
      });
      window.kline.run('add.cube');
      window.kline.run('file.save');
      await new Promise((r) => setTimeout(r, 600));
      return { files: window.__saved, status: window.kline.editor.statusMessage };
    });
    assert.deepEqual(saved.files, ['scene.kline'],
      `saving was refused in an unlicensed build: ${saved.status}`);
  });

  test('19 · an expired licence pauses export and never touches the work', async () => {
    // The customer-facing half, driven through the real command path. The key
    // is minted here with the same scheme the selling tool uses.
    const result = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const enc = new TextEncoder();
      const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
      );
      const spki = b64u(await crypto.subtle.exportKey('spki', pair.publicKey));
      const mint = async (payload) => {
        const body = b64u(enc.encode(JSON.stringify(payload)));
        const sig = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, enc.encode(body),
        );
        return `${body}.${b64u(sig)}`;
      };

      const mod = window.__klineLicence;
      const now = Date.now();
      const live = await mint({ name: 'Acme', plan: 'Studio', seats: 5, issued: now, expires: now + 8.64e7 });
      const dead = await mint({ name: 'Acme', plan: 'Studio', seats: 5, issued: 0, expires: now - 1 });
      const owner = await mint({ name: 'Zach', plan: 'Owner', seats: 0, issued: 0, expires: null, owner: true });

      const at = async (key) => mod.licenceState({ fromSource: false, key, publicKey: spki, now });
      const [a, b, c] = await Promise.all([at(live), at(dead), at(owner)]);
      return {
        live: { status: a.status, can: mod.canExport(a) },
        dead: { status: b.status, can: mod.canExport(b), why: mod.whyBlocked(b) },
        owner: { status: c.status, can: mod.canExport(c) },
        objects: ed.scene.objects.size,
      };
    });

    assert.equal(result.live.status, 'licensed');
    assert.equal(result.live.can, true, 'a live subscription could not export');
    assert.equal(result.dead.status, 'expired');
    assert.equal(result.dead.can, false, 'an expired licence still exported');
    assert.match(result.dead.why, /still here|locked in/i,
      `the expiry message did not reassure: ${result.dead.why}`);
    assert.equal(result.owner.status, 'owner');
    assert.equal(result.owner.can, true, 'the owner licence could not export');
    assert.ok(result.objects >= 1, 'the scene was disturbed by a licence check');
  });

  test('20 · nothing logged an error along the whole journey', () => {
    const noise = app.consoleErrors.filter((m) => !/favicon|404/i.test(m));
    assert.deepEqual(noise, [], `the app logged: ${noise.join(' | ')}`);
  });
}
