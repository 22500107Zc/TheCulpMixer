import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { falloffWeight, proportionalWeights } from '../src/editor/proportional';
import { defaultSnap, snapToGrid } from '../src/editor/snapping';
import { COMMANDS, COMMANDS_BY_ID, KEYMAP, lookupKey } from '../src/editor/commands';
import { defaultPreferences } from '../src/editor/persistence';
import { AABB, Vec3 } from '../src/core/math';
import { ViewportCamera } from '../src/scene/ViewportCamera';
import { navModeForPress, pressGesture, wheelGesture, wheelPixels } from '../src/editor/navigation';
import { altKeyName, ctrlKeyName, navigationHint } from '../src/ui/platform';

test('every falloff runs from 1 to 0 and stays in range', () => {
  const types = ['smooth', 'sphere', 'root', 'inverseSquare', 'sharp', 'linear'] as const;
  for (const type of types) {
    assert.ok(Math.abs(falloffWeight(type, 0) - 1) < 1e-9, `${type} does not start at 1`);
    assert.ok(falloffWeight(type, 1) < 1e-9, `${type} does not reach 0`);
    for (let i = 0; i <= 10; i++) {
      const w = falloffWeight(type, i / 10);
      assert.ok(w >= 0 && w <= 1, `${type} left the 0..1 range`);
    }
  }
  assert.equal(falloffWeight('constant', 1), 1, 'constant falloff is deliberately flat');
});

test('proportional weights fall off with distance and stop at the radius', () => {
  const grid = buildPrimitive('grid');
  const centre = 0;
  const weights = proportionalWeights(grid, [centre], 0.5, 'smooth', false);
  assert.equal(weights.get(centre), 1);
  for (const [v, w] of weights) {
    const d = grid.positions[v].distanceTo(grid.positions[centre]);
    assert.ok(d <= 0.5 + 1e-9, `vertex ${v} at ${d} is outside the radius`);
    assert.ok(w > 0 && w <= 1);
  }
  const tighter = proportionalWeights(grid, [centre], 0.2, 'smooth', false);
  assert.ok(tighter.size < weights.size);
});

test('connected falloff measures along the surface, not through it', () => {
  // Two grids stacked close together but not joined.
  const mesh = buildPrimitive('grid');
  const far = mesh.clone();
  for (let i = 0; i < far.positions.length; i++) far.positions[i].z += 0.05;
  mesh.append(far);
  const seed = 0;
  const straight = proportionalWeights(mesh, [seed], 0.4, 'linear', false);
  const alongEdges = proportionalWeights(mesh, [seed], 0.4, 'linear', true);
  assert.ok(alongEdges.size < straight.size, 'connected mode should ignore the detached copy');
  for (const v of alongEdges.keys()) {
    assert.ok(v < mesh.positions.length / 2, 'reached the detached half through space');
  }
});

test('proportional editing scales to a dense mesh without going quadratic', () => {
  const dense = catmullClark(buildPrimitive('uvsphere'), 1);
  const started = Date.now();
  const weights = proportionalWeights(dense, [0], 0.3, 'smooth', false);
  assert.ok(weights.size > 1);
  assert.ok(Date.now() - started < 1500);
});

test('grid snapping rounds to the step', () => {
  const p = snapToGrid(new Vec3(1.31, -0.62, 0.04), 0.25);
  assert.equal(p.x, 1.25);
  assert.equal(p.y, -0.5);
  assert.equal(p.z, 0);
  assert.deepEqual(snapToGrid(new Vec3(1, 2, 3), 0).toArray(), [1, 2, 3]);
  assert.equal(defaultSnap().enabled, false);
});

test('every command id is unique and every keymap entry resolves', () => {
  const ids = new Set<string>();
  for (const cmd of COMMANDS) {
    assert.ok(!ids.has(cmd.id), `duplicate command id ${cmd.id}`);
    ids.add(cmd.id);
    assert.ok(cmd.label.length > 0);
  }
  for (const binding of KEYMAP) {
    assert.ok(COMMANDS_BY_ID.has(binding.command), `${binding.chord} points at a missing command`);
  }
});

test('mode-specific bindings win over the general ones', () => {
  assert.equal(lookupKey('x', 'edit'), 'mesh.delete');
  assert.equal(lookupKey('x', 'object'), 'object.delete');
  assert.equal(lookupKey('tab', 'sculpt'), 'edit.toggleMode', 'a general binding still applies in sculpt');
  assert.equal(lookupKey(']', 'sculpt'), 'sculpt.radiusUp');
  assert.equal(lookupKey(']', 'object'), null);
});

test('the new operators are reachable from the menus', () => {
  for (const id of [
    'mesh.bevel', 'mesh.bisect', 'mesh.bridge', 'mesh.spin', 'uv.unwrap',
    'object.booleanDifference', 'object.decimate', 'render.image', 'anim.insertKey',
    'mode.sculpt', 'transform.proportional', 'transform.snap',
  ]) {
    const cmd = COMMANDS_BY_ID.get(id);
    assert.ok(cmd, `${id} is missing`);
    assert.ok(
      ['File', 'Edit', 'Add', 'Object', 'Mesh', 'Select', 'View'].includes(cmd!.category),
      `${id} has no menu home`,
    );
  }
});

test('preference defaults are sane', () => {
  const p = defaultPreferences();
  assert.ok(p.autosaveSeconds >= 15);
  assert.ok(p.renderSamples > 0 && p.renderWidth > 0 && p.renderHeight > 0);
  assert.ok(p.snapIncrement > 0);
});

test('the panel windows are reachable by menu, palette and key, not only by key', () => {
  // Both spent a release openable only through an undocumented chord: no menu
  // entry, no palette hit, nothing in the shortcut sheet. Routing them through
  // commands is what puts them on all three at once, so that is what is
  // asserted here rather than the key handler alone.
  for (const [id, chord] of [['view.uvEditor', 'ctrl+u'], ['view.graphEditor', 'ctrl+g']]) {
    const command = COMMANDS_BY_ID.get(id);
    assert.ok(command, `${id} is not a command, so nothing can list it`);
    assert.equal(command.category, 'View', `${id} would not appear under any menu`);
    assert.ok(command.shortcut, `${id} has no shortcut to display`);
    assert.equal(lookupKey(chord, 'object'), id, `${chord} does not reach ${id}`);
  }
});

test('every command a menu would show can actually be run', () => {
  // A command with no `run` is a dead entry in the menu and the palette.
  for (const command of COMMANDS) {
    assert.equal(typeof command.run, 'function', `${command.id} has no run`);
    assert.ok(command.label, `${command.id} has no label`);
  }
  // And every key binding points at a command that exists.
  for (const binding of KEYMAP) {
    assert.ok(
      COMMANDS_BY_ID.has(binding.command),
      `${binding.chord} is bound to ${binding.command}, which does not exist`,
    );
  }
});

test('the guide is on by default and can be turned off for good', () => {
  // A first run with nothing stored has to be the guided one — a new user who
  // has never seen a 3D application is exactly who this exists for.
  assert.equal(defaultPreferences().showGuideOnStart, true);

  // And the choice has to be a real preference, not a session flag, or it
  // reappears on the next launch and becomes an annoyance instead of help.
  const off = { ...defaultPreferences(), showGuideOnStart: false };
  const roundTripped = { ...defaultPreferences(), ...JSON.parse(JSON.stringify(off)) };
  assert.equal(roundTripped.showGuideOnStart, false);

  // A preferences blob written before this setting existed must still open,
  // and should get the guide rather than silently losing it.
  const older = JSON.parse(JSON.stringify(defaultPreferences()));
  delete older.showGuideOnStart;
  const merged = { ...defaultPreferences(), ...older };
  assert.equal(merged.showGuideOnStart, true);
});

test('the guide is reachable from a menu and the palette, not only on first run', () => {
  // Onboarding you cannot get back is a dead end: someone who skipped it on
  // day one and wants it on day two has to be able to find it.
  const open = COMMANDS_BY_ID.get('help.guide');
  assert.ok(open, 'there is no command to open the guide');
  assert.equal(open.category, 'Help');
  const toggle = COMMANDS_BY_ID.get('help.guideOnStart');
  assert.ok(toggle, 'there is no command to change whether it opens on start');
  assert.equal(toggle.category, 'Help');
});

// --------------------------------------------------------------- navigation

/** A wheel event as the DOM would deliver it. */
function wheel(deltaY: number, deltaX = 0, deltaMode = 0) {
  return { deltaX, deltaY, deltaMode };
}

const NONE = { alt: false, shift: false, ctrl: false };

test('a press picks its navigation from the button and the modifiers', () => {
  assert.equal(navModeForPress(1, NONE), 'orbit', 'middle drag orbits');
  assert.equal(navModeForPress(1, { ...NONE, shift: true }), 'pan');
  assert.equal(navModeForPress(1, { ...NONE, ctrl: true }), 'zoom');

  // The trackpad half: no middle button exists, so Option stands in for it.
  assert.equal(navModeForPress(0, { ...NONE, alt: true }), 'orbit');
  assert.equal(navModeForPress(0, { ...NONE, alt: true, shift: true }), 'pan');
  assert.equal(navModeForPress(0, { ...NONE, alt: true, ctrl: true }), 'zoom');

  // A plain left press is selection, and must stay selection.
  assert.equal(navModeForPress(0, NONE), null);
  assert.equal(navModeForPress(0, { ...NONE, shift: true }), null);
  assert.equal(navModeForPress(2, { ...NONE, alt: true }), null, 'right press is not navigation');
});

test('wheel deltas are normalised to pixels whatever unit the device uses', () => {
  assert.deepEqual(wheelPixels(wheel(100, 20, 0), 800), { x: 20, y: 100 });
  // Firefox reports a plain mouse wheel in lines, about three per detent.
  assert.deepEqual(wheelPixels(wheel(3, 0, 1), 800), { x: 0, y: 48 });
  assert.deepEqual(wheelPixels(wheel(1, 0, 2), 800), { x: 0, y: 800 });
  // A device that reports nonsense should not send the camera to NaN.
  assert.deepEqual(wheelPixels({ deltaX: NaN, deltaY: Infinity, deltaMode: 0 }, 800), { x: 0, y: 0 });
});

test('one mouse-wheel detent is one zoom step', () => {
  const cam = new ViewportCamera();
  const before = cam.distance;
  const g = wheelGesture(wheel(-100), NONE, 800);
  assert.equal(g.kind, 'zoom');
  if (g.kind === 'zoom') cam.zoom(g.amount);
  // 10% closer, which is what a detent has always done.
  assert.ok(Math.abs(cam.distance - before * 0.9) < 1e-9, `${cam.distance} is not one step from ${before}`);
});

test('a trackpad flick glides instead of teleporting', () => {
  // The bug this exists to keep out: a two-finger scroll arrives as a stream
  // of small events, and treating each one as a whole detent multiplied the
  // distance by 0.9 a hundred times over. The camera hit the near clamp
  // before the fingers had finished moving, and the viewport was unusable on
  // a laptop — which is the machine most people will try The Culp Mixer on.
  const cam = new ViewportCamera();
  const before = cam.distance;
  // Roughly what one firm flick plus its momentum tail reports.
  for (let i = 0; i < 100; i++) {
    const g = wheelGesture(wheel(-4), NONE, 800);
    if (g.kind === 'zoom') cam.zoom(g.amount);
  }
  assert.ok(cam.distance < before, 'the flick should have zoomed in');
  assert.ok(cam.distance > before * 0.5, `100 events took the distance to ${cam.distance}, from ${before}`);
});

test('one enormous delta cannot jump the camera through the model', () => {
  const cam = new ViewportCamera();
  const before = cam.distance;
  const g = wheelGesture(wheel(1, 0, 2), NONE, 4000);
  if (g.kind === 'zoom') cam.zoom(g.amount);
  assert.ok(cam.distance > before * 0.5, `a single page-sized delta moved ${before} to ${cam.distance}`);
});

test('Option with a two-finger scroll orbits', () => {
  const cam = new ViewportCamera();
  const yaw = cam.yaw;
  const pitch = cam.pitch;
  // Fingers moving right report a negative deltaX, so the view should turn
  // the same way a rightward drag turns it.
  const right = wheelGesture(wheel(0, -60), { ...NONE, alt: true }, 800);
  assert.equal(right.kind, 'orbit');
  if (right.kind === 'orbit') cam.orbit(right.dx, right.dy);
  assert.ok(cam.yaw < yaw, 'a rightward scroll should turn the view right');

  const drag = new ViewportCamera();
  drag.orbit(...(() => { const g = pressGesture('orbit', 60, 0); return g.kind === 'orbit' ? [g.dx, g.dy] as const : [0, 0] as const; })());
  assert.ok(drag.yaw < yaw, 'a rightward drag turns the same way');

  const up = wheelGesture(wheel(-60), { ...NONE, alt: true }, 800);
  if (up.kind === 'orbit') cam.orbit(up.dx, up.dy);
  assert.notEqual(cam.pitch, pitch);
});

test('Shift scrolls pan and pinch zooms', () => {
  const pan = wheelGesture(wheel(30, 10), { ...NONE, shift: true }, 800);
  assert.deepEqual(pan, { kind: 'pan', dx: -10, dy: -30 });

  // A pinch reaches the page as a wheel event with ctrlKey set, reporting a
  // few units a frame. It has to move the camera enough to feel connected.
  const pinch = wheelGesture(wheel(-5), { ...NONE, ctrl: true }, 800);
  assert.equal(pinch.kind, 'zoom');
  if (pinch.kind === 'zoom') assert.ok(pinch.amount > 0.1, `a pinch of 5 gave ${pinch.amount}`);

  // Ctrl with a real mouse wheel comes through the same path and must not
  // become a leap: it is capped at a single step.
  const ctrlWheel = wheelGesture(wheel(-120), { ...NONE, ctrl: true }, 800);
  if (ctrlWheel.kind === 'zoom') assert.ok(ctrlWheel.amount <= 1 + 1e-9, `${ctrlWheel.amount} is more than one step`);
});

test('a latched drag keeps doing the same thing all the way through', () => {
  // The mode comes from the press, not from whatever the keys are doing when
  // a move event happens to arrive, so a finger slipping off Shift halfway
  // through a pan does not turn the rest of it into an orbit.
  assert.deepEqual(pressGesture('pan', 12, -7), { kind: 'pan', dx: 12, dy: -7 });
  const orbit = pressGesture('orbit', 12, -7);
  assert.equal(orbit.kind, 'orbit');
  const zoom = pressGesture('zoom', 0, -50);
  assert.equal(zoom.kind, 'zoom');
  if (zoom.kind === 'zoom') assert.ok(zoom.amount > 0, 'dragging up zooms in');
});

test('zooming holds the point under the cursor still', () => {
  // Zooming about the middle of the screen means whatever you are scrolling at
  // slides off as you approach it, and you spend the session chasing it back
  // with the pan gesture. The screen position of a world point is what has to
  // stay put, not the pivot.
  const cam = new ViewportCamera();
  const aspect = 16 / 9;

  /** Where a world point lands on screen, in the same -1..1 the zoom uses. */
  const project = (p: Vec3): [number, number] => {
    const rel = p.sub(cam.target);
    const h = cam.orthoHalfHeight();
    return [rel.dot(cam.right()) / (h * aspect), rel.dot(cam.up()) / h];
  };

  // A point off to one side, on the plane the camera is focused at.
  const h0 = cam.orthoHalfHeight();
  const cursor: [number, number] = [0.6, -0.35];
  const world = cam.target
    .add(cam.right().scale(cursor[0] * h0 * aspect))
    .add(cam.up().scale(cursor[1] * h0));

  cam.zoomAt(1.5, cursor[0], cursor[1], aspect);
  const after = project(world);
  assert.ok(Math.abs(after[0] - cursor[0]) < 1e-6, `x drifted from ${cursor[0]} to ${after[0]}`);
  assert.ok(Math.abs(after[1] - cursor[1]) < 1e-6, `y drifted from ${cursor[1]} to ${after[1]}`);

  // And zooming back out puts it back, rather than walking the pivot away.
  cam.zoomAt(-1.5, cursor[0], cursor[1], aspect);
  const back = project(world);
  assert.ok(Math.abs(back[0] - cursor[0]) < 1e-6 && Math.abs(back[1] - cursor[1]) < 1e-6);
  assert.ok(Math.abs(cam.distance - 11) < 1e-9, 'the round trip did not return to where it started');
});

test('zooming at the middle is still a plain zoom', () => {
  const cam = new ViewportCamera();
  const target = cam.target.clone();
  cam.zoomAt(1, 0, 0, 1.5);
  assert.ok(cam.distance < 11);
  assert.ok(cam.target.distanceTo(target) < 1e-9, 'zooming at the centre moved the pivot');
});

test('one bad number cannot wedge the camera for the rest of the session', () => {
  // NaN in a camera is not a bad frame, it is the end of the session: it
  // spreads through the view matrix in one step, the viewport goes blank, and
  // no gesture puts it back because every gesture is relative to the value
  // that is now NaN. clamp() does not catch it either — every comparison
  // against NaN is false, so it passes straight through the range check it
  // looks like it is guarded by.
  const rubbish = [NaN, Infinity, -Infinity];
  for (const v of rubbish) {
    const cam = new ViewportCamera();
    cam.orbit(v, v);
    cam.pan(v, v, v);
    cam.zoom(v);
    cam.dolly(v);
    cam.nudge(v, v);
    cam.zoomAt(v, v, v, v);
    cam.zoomAt(1, 0.5, 0.5, v);

    // A box can hold a NaN and still be "valid" — one vertex that went wrong
    // upstream is enough — so framing has to check what it worked out.
    const box = new AABB();
    box.expand(new Vec3(v, v, v));
    cam.frame(box);

    for (const n of [cam.distance, cam.yaw, cam.pitch, cam.target.x, cam.target.y, cam.target.z]) {
      assert.ok(Number.isFinite(n), `${v} left ${n} in the camera`);
    }
    for (const n of cam.viewProjection(1.6).m) assert.ok(Number.isFinite(n), `${v} reached the view matrix`);

    // Refusing rubbish must not also refuse the next real gesture.
    const before = cam.distance;
    cam.zoom(1);
    assert.ok(cam.distance < before, `the camera stopped zooming after being handed ${v}`);
    cam.orbit(0.2, 0.1);
    assert.notEqual(cam.yaw, -43 * (Math.PI / 180));
  }
});

test('the same two keys mean the same thing scrolled and dragged', () => {
  // Option and Shift together used to slide the view when held with a button
  // and turn it when scrolled, because a press reads Shift first and a scroll
  // read Option first. Two hands, two answers, and the hint on screen — which
  // said it slid — was wrong for the gesture a laptop user actually has.
  const both = { alt: true, shift: true, ctrl: false };
  assert.equal(navModeForPress(0, both), 'pan');
  assert.equal(wheelGesture({ deltaX: 0, deltaY: 40, deltaMode: 0 }, both, 800).kind, 'pan');
  // And each on its own still does what it did.
  assert.equal(wheelGesture({ deltaX: 0, deltaY: 40, deltaMode: 0 },
    { alt: true, shift: false, ctrl: false }, 800).kind, 'orbit');
  assert.equal(wheelGesture({ deltaX: 0, deltaY: 40, deltaMode: 0 },
    { alt: false, shift: true, ctrl: false }, 800).kind, 'pan');
});

test('the keys are named the way the machine names them', () => {
  // Every hint in the application was written on a Mac. A Windows laptop has
  // no Option key, so the one instruction telling somebody how to turn the
  // view was an instruction they could not follow — and nothing here runs on
  // Windows, which is why it stood.
  assert.equal(altKeyName(true), 'Option');
  assert.equal(altKeyName(false), 'Alt');
  assert.equal(ctrlKeyName(true), 'Cmd');
  assert.equal(ctrlKeyName(false), 'Ctrl');
  assert.match(navigationHint(true), /Option/);
  assert.match(navigationHint(false), /Alt/);
  // A desktop mouse has no second finger to scroll with.
  assert.doesNotMatch(navigationHint(false), /finger|pinch/i);
  assert.match(navigationHint(false), /wheel/);
  // Both name the key that actually pans, which is Shift.
  for (const hint of [navigationHint(true), navigationHint(false)]) {
    assert.match(hint, /Shift[^·]*slides/);
  }
});
