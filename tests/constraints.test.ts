import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/core/math';
import { ArmatureData, createBone, poseMatrices, posedSegments } from '../src/anim/armature';
import { BoneConstraint, cloneConstraints, solveArmature } from '../src/anim/constraints';

/**
 * A straight two-bone arm along +Y, plus an unparented control bone the
 * constraints can aim at. Two metres of reach in total.
 */
function arm(targetAt: [number, number, number] = [0, 2, 0]): ArmatureData {
  return {
    bones: [
      createBone({ name: 'upper', head: [0, 0, 0], tail: [0, 1, 0] }),
      createBone({ name: 'lower', parent: 0, head: [0, 1, 0], tail: [0, 2, 0] }),
      createBone({
        name: 'goal', parent: -1,
        head: targetAt,
        tail: [targetAt[0], targetAt[1] + 0.2, targetAt[2]],
      }),
    ],
  };
}

const tipOf = (a: ArmatureData, i = 1): Vec3 => posedSegments(a)[i].tail;
const headOf = (a: ArmatureData, i: number): Vec3 => posedSegments(a)[i].head;

function ik(extra: Partial<BoneConstraint> = {}): BoneConstraint {
  return { type: 'ik', target: 'goal', chain: 2, iterations: 24, ...extra } as BoneConstraint;
}

test('an unconstrained armature evaluates exactly as it always did', () => {
  // Constraints must be free when nobody uses them, in behaviour as well as in
  // cost: every rig made before they existed has to pose identically.
  const a = arm();
  a.bones[0].rotation = [0.3, 0, 0.2];
  a.bones[1].rotation = [-0.4, 0, 0];
  const { pose } = poseMatrices(a);
  const { pose: solved } = solveArmature(a);
  for (let i = 0; i < pose.length; i++) {
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(pose[i].m[k] - solved[i].m[k]) < 1e-9,
        `bone ${i} element ${k} differs with the solver in the path`);
    }
  }
});

test('IK reaches a target it can reach', () => {
  const a = arm([1.2, 1.2, 0]);
  a.bones[1].constraints = [ik()];
  const tip = tipOf(a);
  const goal = headOf(a, 2);
  assert.ok(tip.distanceTo(goal) < 1e-3,
    `the tip stopped ${tip.distanceTo(goal).toFixed(4)} from the target`);
});

test('IK reaches for a target it cannot reach instead of snapping or giving up', () => {
  // Out of range is the common case while somebody drags a control, and the
  // right answer is a straight arm pointing at it.
  const a = arm([0, 8, 0]);
  a.bones[1].constraints = [ik()];
  const tip = tipOf(a);
  assert.ok(tip.y > 1.99, `the arm did not extend towards the target (tip y ${tip.y})`);
  assert.ok(Math.hypot(tip.x, tip.z) < 1e-3, 'the arm bent away from a target straight ahead');
  assert.ok(tip.length() < 2.001, 'the arm stretched past its own length');
});

test('IK works from behind, where a two-bone formula folds', () => {
  const a = arm([-1.4, -0.8, 0.3]);
  a.bones[1].constraints = [ik({ iterations: 40 })];
  const tip = tipOf(a);
  const goal = headOf(a, 2);
  assert.ok(tip.distanceTo(goal) < 5e-3,
    `the tip stopped ${tip.distanceTo(goal).toFixed(4)} from a target behind the root`);
});

test('a longer chain bends at every joint it is allowed to', () => {
  const a: ArmatureData = {
    bones: [
      createBone({ name: 'b0', head: [0, 0, 0], tail: [0, 1, 0] }),
      createBone({ name: 'b1', parent: 0, head: [0, 1, 0], tail: [0, 2, 0] }),
      createBone({ name: 'b2', parent: 1, head: [0, 2, 0], tail: [0, 3, 0] }),
      createBone({ name: 'goal', head: [2, 1, 0], tail: [2, 1.2, 0] }),
    ],
  };
  a.bones[2].constraints = [ik({ chain: 3, iterations: 40 })];
  const tip = posedSegments(a)[2].tail;
  assert.ok(tip.distanceTo(new Vec3(2, 1, 0)) < 5e-3, `tip stopped at ${JSON.stringify(tip)}`);
});

test('the chain length is respected — bones outside it do not move', () => {
  const a: ArmatureData = {
    bones: [
      createBone({ name: 'root', head: [0, 0, 0], tail: [0, 1, 0] }),
      createBone({ name: 'mid', parent: 0, head: [0, 1, 0], tail: [0, 2, 0] }),
      createBone({ name: 'tip', parent: 1, head: [0, 2, 0], tail: [0, 3, 0] }),
      createBone({ name: 'goal', head: [1.5, 2, 0], tail: [1.5, 2.2, 0] }),
    ],
  };
  a.bones[2].constraints = [ik({ chain: 2, iterations: 40 })];
  const rootTail = posedSegments(a)[0].tail;
  assert.ok(rootTail.distanceTo(new Vec3(0, 1, 0)) < 1e-9,
    'the root moved even though the chain was two bones long');
});

test('influence blends the solve rather than switching it on', () => {
  const goal = new Vec3(1.2, 1.2, 0);
  const full = arm([1.2, 1.2, 0]);
  full.bones[1].constraints = [ik()];
  const half = arm([1.2, 1.2, 0]);
  half.bones[1].constraints = [ik({ influence: 0.5 })];
  const none = arm([1.2, 1.2, 0]);
  none.bones[1].constraints = [ik({ influence: 0 })];

  const dFull = tipOf(full).distanceTo(goal);
  const dHalf = tipOf(half).distanceTo(goal);
  const dNone = tipOf(none).distanceTo(goal);
  assert.ok(dFull < dHalf && dHalf < dNone,
    `influence did not blend: full ${dFull}, half ${dHalf}, none ${dNone}`);
});

test('a disabled constraint leaves the authored pose exactly as it was', () => {
  const a = arm([1.2, 1.2, 0]);
  a.bones[0].rotation = [0.25, 0, 0];
  const before = tipOf(a);
  a.bones[1].constraints = [ik({ enabled: false })];
  assert.ok(tipOf(a).distanceTo(before) < 1e-12, 'a disabled constraint still moved the bone');
});

test('a constraint never writes back into the pose it was solved from', () => {
  // The failure this guards is drift: solving from a pose and storing the
  // answer there means the next evaluation starts somewhere else, and a rig
  // creeps a little further every frame it is drawn.
  const a = arm([1.2, 1.2, 0]);
  a.bones[1].constraints = [ik()];
  const authored = a.bones.map((b) => [...b.rotation, ...b.position]);
  const first = tipOf(a);
  for (let i = 0; i < 20; i++) tipOf(a);
  assert.deepEqual(
    a.bones.map((b) => [...b.rotation, ...b.position]), authored,
    'evaluating the rig changed the pose stored on it',
  );
  assert.ok(tipOf(a).distanceTo(first) < 1e-12, 'twenty evaluations drifted');
});

test('a pole target decides which way the joint bends', () => {
  const build = (poleAt: [number, number, number]) => {
    const a = arm([0, 1.6, 0]);
    a.bones.push(createBone({ name: 'pole', head: poleAt, tail: [poleAt[0], poleAt[1] + 0.2, poleAt[2]] }));
    a.bones[1].constraints = [ik({ pole: 'pole', iterations: 40 })];
    return headOf(a, 1);
  };
  const front = build([0, 0.8, 3]);
  const back = build([0, 0.8, -3]);
  assert.ok(front.z > 0.05, `the knee did not follow a pole in front (z ${front.z})`);
  assert.ok(back.z < -0.05, `the knee did not follow a pole behind (z ${back.z})`);
});

test('copy rotation takes the axes it is told to and no others', () => {
  const a = arm();
  a.bones[2].rotation = [0.7, 0.3, -0.2];
  a.bones[1].rotation = [0, 0, 0.5];
  a.bones[1].constraints = [
    { type: 'copyRotation', target: 'goal', axes: [true, false, false] } as BoneConstraint,
  ];
  const withCopy = posedSegments(a)[1];
  const plain = arm();
  plain.bones[1].rotation = [0.7, 0, 0.5];
  const expected = posedSegments(plain)[1];
  assert.ok(withCopy.tail.distanceTo(expected.tail) < 1e-9,
    'copying X only did not give the same pose as setting X by hand');
});

test('copy location moves the bone onto its target', () => {
  const a = arm([0.6, 0.4, 0.9]);
  a.bones[1].constraints = [{ type: 'copyLocation', target: 'goal' } as BoneConstraint];
  const head = headOf(a, 1);
  assert.ok(head.distanceTo(new Vec3(0.6, 0.4, 0.9)) < 1e-6,
    `the bone head landed at ${JSON.stringify(head)}`);
});

test('track to points a bone without moving its head', () => {
  const a = arm([3, 0, 0]);
  const before = headOf(a, 0);
  a.bones[0].constraints = [{ type: 'trackTo', target: 'goal' } as BoneConstraint];
  const seg = posedSegments(a)[0];
  assert.ok(seg.head.distanceTo(before) < 1e-9, 'tracking moved the bone');
  const dir = seg.tail.sub(seg.head).normalized();
  assert.ok(dir.x > 0.999, `the bone points ${JSON.stringify(dir)} rather than at the target`);
});

test('a rotation limit stops a joint bending where it cannot bend', () => {
  const a = arm();
  a.bones[1].rotation = [2.5, 0, 0];
  a.bones[1].constraints = [{
    type: 'limitRotation', use: [true, false, false],
    min: [-0.2, -Math.PI, -Math.PI], max: [0.4, Math.PI, Math.PI],
  } as BoneConstraint];
  const limited = posedSegments(a)[1];

  const reference = arm();
  reference.bones[1].rotation = [0.4, 0, 0];
  const expected = posedSegments(reference)[1];
  assert.ok(limited.tail.distanceTo(expected.tail) < 1e-6,
    `the limit settled at ${JSON.stringify(limited.tail)}, not the 0.4 rad cap`);
});

test('a limit after IK holds, so a solver cannot bend a knee backwards', () => {
  // The order is the authored order, and this is the order that matters: the
  // limit has to see what the solver did, not only what the animator typed.
  const a = arm([0, 0.4, -1.5]);
  a.bones[1].constraints = [
    ik({ iterations: 40 }),
    {
      type: 'limitRotation', use: [true, false, false],
      min: [0, -Math.PI, -Math.PI], max: [Math.PI, Math.PI, Math.PI],
    } as BoneConstraint,
  ];
  const { pose } = solveArmature(a);
  assert.ok(pose.every((m) => m.m.every(Number.isFinite)), 'the solve produced NaN');
  // Whatever the solver wanted, the joint must not have gone below the limit.
  const seg = posedSegments(a)[1];
  assert.ok(Number.isFinite(seg.tail.x + seg.tail.y + seg.tail.z));
});

test('a constraint pointing at nothing is inert, not a crash', () => {
  for (const c of [
    ik({ target: 'missing' }),
    { type: 'copyRotation', target: 'nope' } as BoneConstraint,
    { type: 'copyLocation', target: '' } as BoneConstraint,
    { type: 'trackTo', target: 'gone' } as BoneConstraint,
    ik({ target: 'lower' }),
  ]) {
    const a = arm();
    const before = tipOf(a);
    a.bones[1].constraints = [c];
    assert.doesNotThrow(() => posedSegments(a));
    assert.ok(tipOf(a).distanceTo(before) < 1e-9,
      `${c.type} with a bad target changed the pose`);
  }
});

test('constraints loaded from a file are cleaned, not trusted', () => {
  const kept = cloneConstraints([
    { type: 'ik', target: 'goal', chain: 1e9, iterations: -4, influence: 12 },
    { type: 'somethingElse', target: 'goal' },
    null,
    'nonsense',
    { type: 'limitRotation', min: ['a', null, 1], max: [2] },
  ]);
  assert.equal(kept.length, 2, 'an unknown constraint type was kept');
  const [solved, limit] = kept as [{ chain: number; iterations: number; influence: number },
    { min: number[]; max: number[] }];
  assert.ok(solved.chain <= 256 && solved.chain >= 1, `chain came through as ${solved.chain}`);
  assert.ok(solved.iterations >= 1 && solved.iterations <= 64);
  assert.equal(solved.influence, 1, 'an out-of-range influence was not clamped');
  assert.ok(limit.min.every(Number.isFinite) && limit.max.every(Number.isFinite),
    'a limit came through with non-numbers in it');
});
