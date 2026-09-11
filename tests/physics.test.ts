import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld, createBody, defaultWorld } from '../src/physics/rigidbody';
import { bakeToKeyframes, clearBake, settle, worldFromScene } from '../src/physics/bake';
import { Scene, createPhysicsBody } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import { sampleChannels } from '../src/anim/animation';
import { Quat, Vec3 } from '../src/core/math';

function ground(): ReturnType<typeof createBody> {
  return createBody(0, {
    shape: 'box', halfExtents: new Vec3(20, 20, 0.5),
    position: new Vec3(0, 0, -0.5), mass: 0, restitution: 0.9,
  });
}

test('a body falls under gravity', () => {
  const w = new PhysicsWorld();
  const b = w.add(createBody(1, { position: new Vec3(0, 0, 10) }));
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(b.position.z < 10, 'it did not fall');
  // Half a second of freefall from rest is about 1.2 metres.
  const dropped = 10 - b.position.z;
  assert.ok(dropped > 0.8 && dropped < 1.6, `fell ${dropped.toFixed(3)}m in half a second`);
});

test('a passive body never moves', () => {
  const w = new PhysicsWorld();
  const floor = w.add(ground());
  w.add(createBody(1, { position: new Vec3(0, 0, 3) }));
  for (let i = 0; i < 400; i++) w.step();
  assert.deepEqual(
    [floor.position.x, floor.position.y, floor.position.z],
    [0, 0, -0.5],
    'the floor moved',
  );
});

test('a box lands on the floor and stops there', () => {
  const w = new PhysicsWorld();
  w.add(ground());
  const box = w.add(createBody(1, {
    shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5), position: new Vec3(0, 0, 5),
  }));
  for (let i = 0; i < 600; i++) w.step();
  // Resting on a floor whose top is at z = 0 puts its centre at 0.5.
  assert.ok(Math.abs(box.position.z - 0.5) < 0.05, `settled at z = ${box.position.z.toFixed(4)}`);
  assert.ok(box.velocity.length() < 0.1, `still moving at ${box.velocity.length().toFixed(4)}`);
  assert.ok(box.sleeping, 'a settled body should stop being simulated');
});

test('a stack of boxes holds still rather than sinking or jittering', () => {
  // The property iteration buys: a single resolution pass leaves this
  // shuffling for the whole bake.
  const w = new PhysicsWorld();
  w.add(ground());
  const boxes = [];
  for (let i = 0; i < 4; i++) {
    boxes.push(w.add(createBody(i + 1, {
      shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5),
      position: new Vec3(0, 0, 0.5 + i * 1.02),
    })));
  }
  for (let i = 0; i < 900; i++) w.step();
  boxes.forEach((b, i) => {
    const want = 0.5 + i;
    assert.ok(
      Math.abs(b.position.z - want) < 0.12,
      `box ${i} settled at ${b.position.z.toFixed(3)}, wanted about ${want}`,
    );
  });
  // Nothing sank through anything.
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i].position.z > boxes[i - 1].position.z, 'the stack fell through itself');
  }
});

test('two spheres pushed together separate', () => {
  const w = new PhysicsWorld({ ...defaultWorld(), gravity: new Vec3() });
  const a = w.add(createBody(1, { shape: 'sphere', halfExtents: new Vec3(1, 0, 0), position: new Vec3(-0.4, 0, 0) }));
  const b = w.add(createBody(2, { shape: 'sphere', halfExtents: new Vec3(1, 0, 0), position: new Vec3(0.4, 0, 0) }));
  for (let i = 0; i < 200; i++) w.step();
  const gap = b.position.distanceTo(a.position);
  assert.ok(gap > 1.9, `they are still overlapping at ${gap.toFixed(3)}`);
});

test('a sphere rolls off nothing and rests on a box', () => {
  const w = new PhysicsWorld();
  w.add(ground());
  const ball = w.add(createBody(1, {
    shape: 'sphere', halfExtents: new Vec3(0.5, 0, 0), position: new Vec3(0, 0, 4),
  }));
  for (let i = 0; i < 600; i++) w.step();
  assert.ok(Math.abs(ball.position.z - 0.5) < 0.06, `settled at ${ball.position.z.toFixed(4)}`);
});

test('restitution decides how much a body bounces', () => {
  const drop = (restitution: number): number => {
    const w = new PhysicsWorld();
    w.add(ground());
    const b = w.add(createBody(1, { shape: 'sphere', halfExtents: new Vec3(0.5, 0, 0), position: new Vec3(0, 0, 4), restitution }));
    let peak = 0;
    let landed = false;
    for (let i = 0; i < 400; i++) {
      w.step();
      if (b.position.z < 0.6) landed = true;
      if (landed) peak = Math.max(peak, b.position.z);
    }
    return peak;
  };
  const dead = drop(0);
  const bouncy = drop(0.8);
  assert.ok(bouncy > dead + 0.3, `bouncy peaked at ${bouncy.toFixed(3)}, dead at ${dead.toFixed(3)}`);
});

test('a fixed timestep gives the same answer every run', () => {
  const run = (): number => {
    const w = new PhysicsWorld();
    w.add(ground());
    const b = w.add(createBody(1, { position: new Vec3(0.1, -0.2, 3), velocity: new Vec3(1, 0.5, 0) }));
    for (let i = 0; i < 300; i++) w.step();
    return b.position.x * 1e6 + b.position.y * 1e3 + b.position.z;
  };
  assert.equal(run(), run());
});

// ------------------------------------------------------------------- baking

function droppingScene(): Scene {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 40;
  const floor = scene.add('mesh', 'Floor', buildPrimitive('cube'));
  floor.scale = new Vec3(10, 10, 0.1);
  floor.position = new Vec3(0, 0, -0.1);
  floor.physics = createPhysicsBody('passive');
  const box = scene.add('mesh', 'Box', buildPrimitive('cube'));
  box.position = new Vec3(0, 0, 6);
  box.physics = createPhysicsBody('active');
  return scene;
}

test('a scene turns into a world of bodies', () => {
  const scene = droppingScene();
  const w = worldFromScene(scene);
  assert.equal(w.bodies.length, 2);
  assert.equal(w.bodies.filter((b) => b.mass === 0).length, 1, 'the floor should be immovable');
});

test('objects without a body are not simulated', () => {
  const scene = droppingScene();
  scene.add('mesh', 'Bystander', buildPrimitive('uvsphere'));
  assert.equal(worldFromScene(scene).bodies.length, 2);
});

test('baking writes keyframes that show the object falling', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  const result = bakeToKeyframes(scene);
  assert.equal(result.bodies, 1);
  assert.ok(result.keys > 0);
  assert.ok(box.animation.length > 0, 'no channels were written');

  const atStart = sampleChannels(box.animation, scene.timeline.start);
  const atEnd = sampleChannels(box.animation, scene.timeline.end);
  assert.ok(atStart.position, 'no position at the first frame');
  assert.ok(atEnd.position, 'no position at the last frame');
  assert.ok(atStart.position!.z > atEnd.position!.z + 1, 'the box did not fall over the bake');
  // And it landed rather than falling through: a 2-unit cube on a floor whose
  // top is at zero rests with its origin at 1.
  assert.ok(Math.abs(atEnd.position!.z - 1) < 0.3, `ended at z = ${atEnd.position!.z.toFixed(3)}`);
});

test('the floor is not keyframed', () => {
  const scene = droppingScene();
  bakeToKeyframes(scene);
  const floor = [...scene.objects.values()].find((o) => o.name === 'Floor')!;
  assert.equal(floor.animation.length, 0, 'a passive body should not be animated');
});

test('baking twice does not stack two takes on top of each other', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  bakeToKeyframes(scene);
  const first = box.animation.map((c) => c.keys.length);
  bakeToKeyframes(scene);
  assert.deepEqual(box.animation.map((c) => c.keys.length), first, 'the second bake piled on');
});

test('an existing hand animation is replaced, not blended with', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  box.animation = [{ path: 'position', index: 2, keys: [{ frame: 1, value: 99, interp: 'linear' }] }];
  bakeToKeyframes(scene);
  const at1 = sampleChannels(box.animation, 1);
  assert.ok(Math.abs(at1.position!.z - 99) > 1, 'the old key survived the bake');
});

test('clearing a bake removes what it wrote', () => {
  const scene = droppingScene();
  bakeToKeyframes(scene);
  assert.ok(clearBake(scene) > 0);
  for (const o of scene.objects.values()) {
    assert.equal(o.animation.filter((c) => c.path === 'position').length, 0);
  }
});

test('settling gives an answer without touching the scene', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  const before = box.position.clone();
  const result = settle(scene, 4);
  assert.ok(result.get(box.id)!.position.z < 3, 'it did not settle');
  assert.equal(box.position.z, before.z, 'settling moved the scene object');
  assert.equal(box.animation.length, 0, 'settling wrote keyframes');
});

test('rigid body settings survive a save and load', () => {
  const scene = droppingScene();
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const bodies = [...back.objects.values()].filter((o) => o.physics);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.some((b) => b.physics!.kind === 'passive'));
  assert.ok(bodies.some((b) => b.physics!.kind === 'active'));
});

// ------------------------------------------------- orientation and tipping

test('a box balanced on its corner falls over', () => {
  // Nothing axis-aligned can produce this: the contact is a single corner, the
  // weight is off to one side of it, and the box has to rotate about it.
  const w = new PhysicsWorld();
  w.add(ground());
  const box = w.add(createBody(1, {
    shape: 'box',
    halfExtents: new Vec3(0.5, 0.5, 0.5),
    // Tipped well past its balance point.
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), 0.6),
    position: new Vec3(0, 0, 0.9),
  }));
  for (let i = 0; i < 900; i++) w.step();
  const up = box.orientation.rotate(new Vec3(0, 0, 1));
  assert.ok(up.z > 0.9, `it should have settled flat, up is now (${up.x.toFixed(2)}, ${up.y.toFixed(2)}, ${up.z.toFixed(2)})`);
  assert.ok(Math.abs(box.position.z - 0.5) < 0.08, `resting at z ${box.position.z.toFixed(3)}`);
  assert.ok(box.sleeping, 'it never settled');
});

test('a box tipped only slightly rocks back rather than falling', () => {
  const w = new PhysicsWorld();
  w.add(ground());
  const box = w.add(createBody(1, {
    shape: 'box',
    halfExtents: new Vec3(0.5, 0.5, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), 0.15),
    position: new Vec3(0, 0, 0.75),
  }));
  for (let i = 0; i < 900; i++) w.step();
  const up = box.orientation.rotate(new Vec3(0, 0, 1));
  assert.ok(up.z > 0.95, `it should be flat again, up.z is ${up.z.toFixed(3)}`);
});

test('a rotated box rests flush on a rotated floor', () => {
  // A ramp at 20 degrees. An axis-aligned test would have the box hovering
  // above the ramp's bounding box; an oriented one puts it on the surface.
  const tilt = 0.35;
  const w = new PhysicsWorld({ ...defaultWorld(), gravity: new Vec3(0, 0, -9.81) });
  const ramp = w.add(createBody(0, {
    shape: 'box',
    halfExtents: new Vec3(6, 6, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 0),
    mass: 0,
    friction: 1,
  }));
  const box = w.add(createBody(1, {
    shape: 'box',
    halfExtents: new Vec3(0.5, 0.5, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 2),
    friction: 1,
  }));
  for (let i = 0; i < 600; i++) w.step();
  // Distance from the box's centre to the ramp's surface plane, measured along
  // the ramp's own normal: should be half the box plus half the ramp.
  const n = ramp.orientation.rotate(new Vec3(0, 0, 1));
  const gap = box.position.sub(ramp.position).dot(n);
  assert.ok(Math.abs(gap - 1) < 0.12, `centre sits ${gap.toFixed(3)} from the ramp, wanted 1`);
  // And it stayed aligned with the ramp rather than twisting.
  const boxUp = box.orientation.rotate(new Vec3(0, 0, 1));
  assert.ok(boxUp.dot(n) > 0.97, `the box came out of alignment: ${boxUp.dot(n).toFixed(3)}`);
});

test('a box on a frictionless slope slides down it', () => {
  const tilt = 0.4;
  const w = new PhysicsWorld();
  const ramp = w.add(createBody(0, {
    shape: 'box',
    halfExtents: new Vec3(10, 10, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 0),
    mass: 0,
    friction: 0,
  }));
  const box = w.add(createBody(1, {
    shape: 'box',
    halfExtents: new Vec3(0.5, 0.5, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 1.5),
    friction: 0,
  }));
  const startY = box.position.y;
  // A second and a half. Longer and it slides off the end of the ramp, which
  // is a fine thing for it to do and a useless thing to assert about.
  for (let i = 0; i < 90; i++) w.step();
  assert.ok(box.position.y < startY - 0.5, `it did not slide: y went ${startY} -> ${box.position.y.toFixed(3)}`);
  // Down the slope, not through it.
  const n = ramp.orientation.rotate(new Vec3(0, 0, 1));
  assert.ok(box.position.sub(ramp.position).dot(n) > 0.8, 'it sank into the ramp');
});

test('friction can hold a box on the same slope', () => {
  const tilt = 0.25;
  const w = new PhysicsWorld();
  w.add(createBody(0, {
    shape: 'box', halfExtents: new Vec3(10, 10, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 0), mass: 0, friction: 1,
  }));
  const box = w.add(createBody(1, {
    shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5),
    orientation: Quat.fromAxisAngle(new Vec3(1, 0, 0), tilt),
    position: new Vec3(0, 0, 1.2), friction: 1,
  }));
  for (let i = 0; i < 600; i++) w.step();
  const settled = box.position.y;
  for (let i = 0; i < 300; i++) w.step();
  assert.ok(Math.abs(box.position.y - settled) < 0.02, `it crept ${(box.position.y - settled).toFixed(4)} after settling`);
});

test('a spinning body keeps spinning in free fall', () => {
  // No contacts, so nothing should slow the spin but the small drag.
  const w = new PhysicsWorld({ ...defaultWorld(), gravity: new Vec3() });
  const box = w.add(createBody(1, {
    shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5),
    angularVelocity: new Vec3(0, 0, 2),
  }));
  for (let i = 0; i < 60; i++) w.step();
  const spun = box.orientation.rotate(new Vec3(1, 0, 0));
  const angle = Math.atan2(spun.y, spun.x);
  // A second at 2 rad/s, less a little drag: comfortably past a quarter turn.
  assert.ok(angle > 1.2 && angle < 2.1, `turned ${angle.toFixed(3)} radians`);
  assert.ok(box.angularVelocity.z > 1.5, 'the spin died away');
});

test('an immovable body cannot be set spinning', () => {
  const w = new PhysicsWorld();
  const floor = w.add(ground());
  w.add(createBody(1, { shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5), position: new Vec3(0.3, 0.2, 3) }));
  for (let i = 0; i < 400; i++) w.step();
  assert.equal(floor.angularVelocity.length(), 0, 'the floor started turning');
  assert.deepEqual(
    [floor.position.x, floor.position.y, floor.position.z],
    [0, 0, -0.5],
    'the floor moved',
  );
});

test('a face contact gives more than one point', () => {
  // The whole reason a resting box does not rock: four corners, not one.
  const w = new PhysicsWorld();
  w.add(ground());
  w.add(createBody(1, { shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5), position: new Vec3(0, 0, 0.49) }));
  // findContacts is private; step once and read the effect instead — with one
  // contact point a flat box picks up spin, with four it does not.
  for (let i = 0; i < 120; i++) w.step();
  const box = w.bodies[1];
  assert.ok(box.angularVelocity.length() < 0.05, `a flat landing set it spinning at ${box.angularVelocity.length().toFixed(4)}`);
  const up = box.orientation.rotate(new Vec3(0, 0, 1));
  assert.ok(up.z > 0.999, 'a flat landing tilted it');
});

test('euler conversion round-trips through a quaternion', () => {
  for (const e of [
    new Vec3(0, 0, 0),
    new Vec3(0.3, -0.7, 1.1),
    new Vec3(-1.2, 0.4, -0.9),
    new Vec3(Math.PI / 4, Math.PI / 3, -Math.PI / 6),
  ]) {
    const back = Quat.fromEuler(e).toEuler();
    // Compare the rotations, not the angles: different triples can name the
    // same orientation, and only the orientation matters.
    for (const v of [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)]) {
      const before = Quat.fromEuler(e).rotate(v);
      const after = Quat.fromEuler(back).rotate(v);
      assert.ok(before.distanceTo(after) < 1e-6, `${e.toArray()} did not round-trip`);
    }
  }
});

test('a quaternion stays a unit quaternion under integration', () => {
  let q = Quat.identity();
  const omega = new Vec3(3, -2, 1.5);
  for (let i = 0; i < 5000; i++) q = q.integrate(omega, 1 / 60);
  assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9, 'it drifted off the unit sphere');
});

test('a baked rotation reaches the scene as euler angles', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  // Drop it tilted, so the bake has a rotation worth recording.
  box.rotation = new Vec3(0.5, 0.3, 0);
  bakeToKeyframes(scene);
  const rot = box.animation.filter((c) => c.path === 'rotation');
  assert.equal(rot.length, 3, 'all three rotation channels should be keyed');
  for (const c of rot) for (const key of c.keys) assert.ok(Number.isFinite(key.value));
});

// ------------------------------------------------ baking under a parent

/**
 * A body under a parent that is moved, turned and scaled.
 *
 * The solver works in world space; an animation channel is parent-relative.
 * Those are the same numbers only when the parent is the identity, and this
 * fixture makes sure it is not.
 */
function parentedFall(): { scene: Scene; parent: ReturnType<Scene['add']>; box: ReturnType<Scene['add']> } {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 40;

  const floor = scene.add('mesh', 'Floor', buildPrimitive('cube'));
  floor.scale = new Vec3(10, 10, 0.1);
  floor.position = new Vec3(0, 0, -0.1);
  floor.physics = createPhysicsBody('passive');

  const parent = scene.add('empty', 'Rig');
  parent.position = new Vec3(5, -3, 2);
  parent.rotation = new Vec3(0, 0, Math.PI / 2);
  parent.scale = new Vec3(2, 2, 2);

  const box = scene.add('mesh', 'Box', buildPrimitive('cube'));
  box.position = new Vec3(0, 0, 4);
  box.physics = createPhysicsBody('active');
  scene.setParent(box.id, parent.id);
  return { scene, parent, box };
}

/** Where an object actually ends up on a frame, after the whole hierarchy. */
function worldAt(scene: Scene, id: number, frame: number): Vec3 {
  scene.timeline.current = frame;
  const obj = scene.get(id)!;
  const sampled = sampleChannels(obj.animation, frame);
  const before = { p: obj.position, r: obj.rotation };
  if (sampled.position) obj.position = sampled.position;
  if (sampled.rotation) obj.rotation = sampled.rotation;
  const m = obj.worldMatrix(scene);
  obj.position = before.p;
  obj.rotation = before.r;
  return new Vec3(m.m[12], m.m[13], m.m[14]);
}

test('a baked body under a transformed parent lands where the simulation put it', () => {
  const { scene, box } = parentedFall();

  // Where the simulation says it goes, independent of any hierarchy.
  const settled = settle(scene, 2.5);
  const simulated = settled.get(box.id)!;

  bakeToKeyframes(scene);

  // The keys are parent-relative, so the only fair comparison is the world
  // placement they produce once the parent has been applied.
  const last = Math.round(scene.timeline.end);
  const baked = worldAt(scene, box.id, last);

  assert.ok(
    Math.abs(baked.z - simulated.position.z) < 0.25,
    `baked world height ${baked.z.toFixed(3)} does not match the simulation's `
    + `${simulated.position.z.toFixed(3)}`,
  );
  assert.ok(
    Math.hypot(baked.x - simulated.position.x, baked.y - simulated.position.y) < 0.25,
    `baked world position (${baked.x.toFixed(2)}, ${baked.y.toFixed(2)}) does not match the `
    + `simulation's (${simulated.position.x.toFixed(2)}, ${simulated.position.y.toFixed(2)})`,
  );
});

test('an unparented bake is unchanged by the parent-aware path', () => {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 40;
  const floor = scene.add('mesh', 'Floor', buildPrimitive('cube'));
  floor.scale = new Vec3(10, 10, 0.1);
  floor.position = new Vec3(0, 0, -0.1);
  floor.physics = createPhysicsBody('passive');
  const box = scene.add('mesh', 'Box', buildPrimitive('cube'));
  box.position = new Vec3(0, 0, 6);
  box.physics = createPhysicsBody('active');

  const simulated = settle(scene, 2.5).get(box.id)!;
  bakeToKeyframes(scene);
  const baked = worldAt(scene, box.id, Math.round(scene.timeline.end));
  assert.ok(Math.abs(baked.z - simulated.position.z) < 0.25,
    `unparented bake drifted: ${baked.z.toFixed(3)} vs ${simulated.position.z.toFixed(3)}`);
});

test('a spinning body keeps its origin offset attached to it as it turns', () => {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 20;
  const floor = scene.add('mesh', 'Floor', buildPrimitive('cube'));
  floor.scale = new Vec3(10, 10, 0.1);
  floor.position = new Vec3(0, 0, -0.1);
  floor.physics = createPhysicsBody('passive');

  // Geometry pushed well off its own origin, so origin and centre of mass are
  // different points and the vector between them turns with the body.
  const mesh = buildPrimitive('cube');
  for (let i = 0; i < mesh.positions.length; i++) {
    mesh.positions[i] = mesh.positions[i].add(new Vec3(3, 0, 0));
  }
  mesh.markDirty();
  const box = scene.add('mesh', 'Offset', mesh);
  box.position = new Vec3(0, 0, 5);
  box.rotation = new Vec3(0.3, 0.4, 0.2);
  box.physics = createPhysicsBody('active');

  const simulated = settle(scene, 2.5).get(box.id)!;
  bakeToKeyframes(scene);

  // The body's own centre, reconstructed from the baked origin pose.
  const last = Math.round(scene.timeline.end);
  scene.timeline.current = last;
  const obj = scene.get(box.id)!;
  const sampled = sampleChannels(obj.animation, last);
  if (sampled.position) obj.position = sampled.position;
  if (sampled.rotation) obj.rotation = sampled.rotation;
  const local = obj.evaluated(false)!.bounds();
  const centre = obj.worldMatrix(scene)
    .transformPoint(local.min.add(local.max.sub(local.min).scale(0.5)));

  assert.ok(centre.sub(simulated.position).length() < 0.35,
    `baked centre (${centre.x.toFixed(2)}, ${centre.y.toFixed(2)}, ${centre.z.toFixed(2)}) `
    + `drifted from the simulated centre (${simulated.position.x.toFixed(2)}, `
    + `${simulated.position.y.toFixed(2)}, ${simulated.position.z.toFixed(2)})`);
});
