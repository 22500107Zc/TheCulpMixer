import { Mat4, Vec3, decomposeMatrix } from '../core/math';
import { ArmatureData, Bone, boneHead, boneTail } from './armature';

/**
 * Bone constraints, including inverse kinematics.
 *
 * A constraint is a rule the pose has to satisfy, worked out at evaluation
 * time rather than stored as a pose. That distinction is the whole point: a
 * hand that has to stay on a doorknob is a fact about the shot, and writing it
 * down as "the elbow is at 43.7°" loses it the moment anything else moves.
 *
 * Everything here is a function of one armature. Constraints name their target
 * by bone name inside the same armature, which keeps evaluation pure — no
 * scene lookups, no ordering problem between objects, and a rig that behaves
 * the same whether it is being posed, played back or rendered. The control a
 * person grabs is a bone that deforms nothing, which is how rigs are built
 * anyway.
 *
 * Order matters and is the authored order: constraints on a bone are applied
 * one after another, each seeing what the last one did, and bones are visited
 * parents first so a chain solved higher up is already settled by the time
 * anything below it is looked at.
 */

/** Which local axes a constraint acts on. */
export type Axes = [boolean, boolean, boolean];

export interface ConstraintBase {
  /** Off without deleting it — the usual way to check what a rule is doing. */
  enabled?: boolean;
  /** 0 is inert, 1 is the whole rule; between the two blends towards it. */
  influence?: number;
}

/**
 * Reach a target with a chain of bones.
 *
 * `chain` counts bones from this one upwards, so a two-bone arm is a
 * constraint on the forearm with `chain: 2`. The solver is cyclic coordinate
 * descent: repeatedly swing each bone in the chain so the tip moves towards
 * the target. It converges quickly on the short chains rigs actually use, it
 * cannot fall into the coplanar deadlock a two-bone analytic solution has, and
 * it degrades into "reach as far as you can" when the target is out of range
 * rather than snapping.
 */
export interface IKConstraint extends ConstraintBase {
  type: 'ik';
  /** Bone whose head the chain tip should reach. */
  target: string;
  /** How many bones, counting this one, the solver may move. */
  chain: number;
  /** Extra iterations buy accuracy on long chains; 12 is plenty for a limb. */
  iterations?: number;
  /**
   * Bone the chain should bend towards, if any.
   *
   * Without one, a chain solved from an arbitrary starting pose can settle
   * with the elbow pointing anywhere on a cone. This is the answer to "which
   * way does the knee face".
   */
  pole?: string;
}

/** Take another bone's rotation, on the axes chosen. */
export interface CopyRotationConstraint extends ConstraintBase {
  type: 'copyRotation';
  target: string;
  axes?: Axes;
  invert?: boolean;
}

/** Sit where another bone's head is, on the axes chosen. */
export interface CopyLocationConstraint extends ConstraintBase {
  type: 'copyLocation';
  target: string;
  axes?: Axes;
}

/** Point this bone at another one, without moving it. */
export interface TrackToConstraint extends ConstraintBase {
  type: 'trackTo';
  target: string;
}

/**
 * Stop a joint bending where a joint cannot bend.
 *
 * Limits are on the bone's own pose rotation, in radians, which is what a
 * person sets in the panel and what the solver is allowed to write.
 */
export interface LimitRotationConstraint extends ConstraintBase {
  type: 'limitRotation';
  use?: Axes;
  min?: [number, number, number];
  max?: [number, number, number];
}

export type BoneConstraint =
  | IKConstraint
  | CopyRotationConstraint
  | CopyLocationConstraint
  | TrackToConstraint
  | LimitRotationConstraint;

export const CONSTRAINT_KINDS: BoneConstraint['type'][] = [
  'ik', 'copyRotation', 'copyLocation', 'trackTo', 'limitRotation',
];

export function constraintLabel(kind: BoneConstraint['type']): string {
  switch (kind) {
    case 'ik': return 'Inverse Kinematics';
    case 'copyRotation': return 'Copy Rotation';
    case 'copyLocation': return 'Copy Location';
    case 'trackTo': return 'Track To';
    default: return 'Limit Rotation';
  }
}

export function createConstraint(kind: BoneConstraint['type']): BoneConstraint {
  switch (kind) {
    case 'ik':
      return { type: 'ik', target: '', chain: 2, iterations: 12, enabled: true, influence: 1 };
    case 'copyRotation':
      return { type: 'copyRotation', target: '', axes: [true, true, true], enabled: true, influence: 1 };
    case 'copyLocation':
      return { type: 'copyLocation', target: '', axes: [true, true, true], enabled: true, influence: 1 };
    case 'trackTo':
      return { type: 'trackTo', target: '', enabled: true, influence: 1 };
    default:
      return {
        type: 'limitRotation', use: [true, true, true],
        min: [-Math.PI, -Math.PI, -Math.PI], max: [Math.PI, Math.PI, Math.PI],
        enabled: true, influence: 1,
      };
  }
}

/**
 * Copy a constraint, keeping only what the type actually has.
 *
 * This is also the load path — a `.culpmixer` file can have been written by
 * anything — so it is deliberately a rebuild rather than a spread. An unknown
 * type comes back null and is dropped, which is better than handing the solver
 * a rule it cannot evaluate and finding out mid-render.
 */
export function cloneConstraint(raw: BoneConstraint): BoneConstraint | null {
  const c = raw as unknown as Record<string, unknown>;
  const base = {
    enabled: c.enabled === undefined ? true : !!c.enabled,
    influence: num(c.influence, 1, 0, 1),
  };
  const name = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (c.type) {
    case 'ik':
      return {
        type: 'ik', ...base,
        target: name(c.target),
        chain: Math.round(num(c.chain, 2, 1, 256)),
        iterations: Math.round(num(c.iterations, 12, 1, 64)),
        ...(typeof c.pole === 'string' && c.pole ? { pole: c.pole } : {}),
      };
    case 'copyRotation':
      return {
        type: 'copyRotation', ...base,
        target: name(c.target), axes: axes(c.axes), invert: !!c.invert,
      };
    case 'copyLocation':
      return { type: 'copyLocation', ...base, target: name(c.target), axes: axes(c.axes) };
    case 'trackTo':
      return { type: 'trackTo', ...base, target: name(c.target) };
    case 'limitRotation':
      return {
        type: 'limitRotation', ...base,
        use: axes(c.use),
        min: triple(c.min, -Math.PI),
        max: triple(c.max, Math.PI),
      };
    default:
      return null;
  }
}

/** Clean a whole bone's worth, dropping anything unrecognisable. */
export function cloneConstraints(list: unknown): BoneConstraint[] {
  if (!Array.isArray(list)) return [];
  const out: BoneConstraint[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const kept = cloneConstraint(c as BoneConstraint);
    if (kept) out.push(kept);
  }
  return out;
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function axes(v: unknown): Axes {
  const a = Array.isArray(v) ? v : [];
  return [a[0] === undefined ? true : !!a[0], a[1] === undefined ? true : !!a[1],
    a[2] === undefined ? true : !!a[2]];
}

function triple(v: unknown, fallback: number): [number, number, number] {
  const a = Array.isArray(v) ? v : [];
  const at = (i: number): number =>
    (typeof a[i] === 'number' && Number.isFinite(a[i]) ? a[i] : fallback);
  return [at(0), at(1), at(2)];
}

/** Whether anything on this armature would change the pose. */
export function hasConstraints(armature: ArmatureData): boolean {
  return armature.bones.some((b) => (b.constraints ?? []).some((c) => c.enabled !== false));
}

const influenceOf = (c: ConstraintBase): number => {
  const v = c.influence ?? 1;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * What a bone's own local transform is, before anything constrains it.
 *
 * Split out because the solver writes into a copy of these rather than into
 * the armature: a constraint is re-evaluated every frame from the authored
 * pose, so baking its result back into the bone would make it accumulate and
 * the rig would drift a little more each time it was drawn.
 */
export function localPose(b: Bone): Mat4 {
  return Mat4.compose(
    new Vec3(b.position[0], b.position[1], b.position[2]),
    new Vec3(b.rotation[0], b.rotation[1], b.rotation[2]),
    new Vec3(b.scale[0], b.scale[1], b.scale[2]),
  );
}

/**
 * Solve an armature, giving the rest and the constrained posed matrices.
 *
 * `rest` is untouched by constraints by definition — it is where the model was
 * built — so only `pose` differs from the unconstrained evaluation.
 */
export function solveArmature(armature: ArmatureData): { rest: Mat4[]; pose: Mat4[] } {
  const bones = armature.bones;
  const n = bones.length;
  const localRest: Mat4[] = new Array(n);
  const rest: Mat4[] = new Array(n);
  const pose: Mat4[] = new Array(n);
  /** Per-bone correction the constraints have decided on, in bone space. */
  const extra: Mat4[] = new Array(n);
  const local: Mat4[] = new Array(n);

  const byName = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    localRest[i] = restMatrixOf(bones[i]);
    extra[i] = Mat4.identity();
    local[i] = localPose(bones[i]);
    // First wins, so a duplicate name cannot silently retarget a constraint
    // that was set up against the original.
    if (!byName.has(bones[i].name)) byName.set(bones[i].name, i);
  }

  const parentOf = (i: number): number => {
    const p = bones[i].parent;
    return p >= 0 && p < i ? p : -1;
  };

  /** Recompute one bone's world pose from its parent and its corrections. */
  const compose = (i: number): void => {
    const p = parentOf(i);
    const base = p >= 0
      ? pose[p].multiply(localRest[p].inverse().multiply(localRest[i]))
      : localRest[i];
    pose[i] = base.multiply(local[i]).multiply(extra[i]);
  };

  /** Recompute a bone and everything under it. Bones are sorted parents-first. */
  const recompose = (from: number): void => {
    for (let i = from; i < n; i++) compose(i);
  };

  for (let i = 0; i < n; i++) {
    const p = parentOf(i);
    rest[i] = p >= 0 ? rest[p].multiply(localRest[p].inverse().multiply(localRest[i])) : localRest[i];
  }
  for (let i = 0; i < n; i++) compose(i);

  for (let i = 0; i < n; i++) {
    const list = bones[i].constraints;
    if (!list || list.length === 0) continue;
    for (const c of list) {
      if (c.enabled === false) continue;
      const influence = influenceOf(c);
      if (influence <= 0) continue;
      const changedFrom = apply(c, i, influence);
      if (changedFrom >= 0) recompose(changedFrom);
    }
  }

  return { rest, pose };

  /**
   * Apply one constraint. Returns the lowest bone index whose world pose may
   * have moved, so only what actually changed is recomputed.
   */
  function apply(c: BoneConstraint, i: number, influence: number): number {
    switch (c.type) {
      case 'ik': return solveIK(c, i, influence);
      case 'copyRotation': return copyRotation(c, i, influence);
      case 'copyLocation': return copyLocation(c, i, influence);
      case 'trackTo': return trackTo(c, i, influence);
      default: return limitRotation(c, i, influence);
    }
  }

  /** World-space head of a bone in its current solved pose. */
  function headOf(i: number): Vec3 {
    return pose[i].multiply(rest[i].inverse()).transformPoint(boneHead(bones[i]));
  }

  function tailOf(i: number): Vec3 {
    return pose[i].multiply(rest[i].inverse()).transformPoint(boneTail(bones[i]));
  }

  /**
   * Turn a bone by a world-space rotation about its own head.
   *
   * The correction has to live in the bone's own frame or it would be undone
   * the moment an ancestor moved. `pose[i] = A · extra[i]`, and a world
   * rotation `R` about the head satisfies `A · extra' = R · A · extra`, so the
   * correction is `A⁻¹ R A` — which, because `A` puts the origin at the head,
   * is a plain rotation about the axis carried into bone space.
   */
  function turn(i: number, axis: Vec3, angle: number): void {
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9) return;
    const len = axis.length();
    if (len < 1e-9) return;
    const world = axis.scale(1 / len);
    // The rotation part of `A`, which is `pose[i]` with `extra[i]` taken off.
    const a = pose[i].multiply(extra[i].inverse());
    const localAxis = a.inverse().transformDirection(world);
    if (localAxis.lengthSq() < 1e-18) return;
    extra[i] = Mat4.rotationAxis(localAxis.normalized(), angle).multiply(extra[i]);
  }

  function solveIK(c: IKConstraint, tip: number, influence: number): number {
    const target = byName.get(c.target);
    if (target === undefined || target === tip) return -1;

    // The chain, tip first. It stops at a root, or at the target itself —
    // a chain that contained its own target would chase a moving goal.
    const chainLength = Math.max(1, Math.min(Math.round(c.chain || 2), n));
    const chain: number[] = [];
    for (let b = tip, k = 0; b >= 0 && k < chainLength; b = parentOf(b), k++) {
      if (b === target) break;
      chain.push(b);
    }
    if (chain.length === 0) return -1;
    const lowest = chain[chain.length - 1];

    const goal = headOf(target);
    const iterations = Math.max(1, Math.min(Math.round(c.iterations ?? 12), 64));
    const pole = c.pole === undefined ? undefined : byName.get(c.pole);

    // A chain that is exactly straight and pointing exactly at a target nearer
    // than its own length has nowhere to go: every swing that would shorten
    // the reach is perpendicular to the one thing the solver measures, so it
    // sits there fully extended. Real rigs hit this constantly — it is the
    // rest pose of every limb — so the chain is given a small bend to work
    // from. Towards the pole when there is one, and otherwise about the
    // chain's own local X, which is deterministic rather than arbitrary.
    seedBend();

    for (let pass = 0; pass < iterations; pass++) {
      let moved = false;
      for (const b of chain) {
        const pivot = headOf(b);
        const effector = tailOf(tip);
        const from = effector.sub(pivot);
        const to = goal.sub(pivot);
        if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
        const u = from.normalized();
        const v = to.normalized();
        const dot = clamp(u.dot(v), -1, 1);
        const angle = Math.acos(dot);
        if (angle < 1e-6) continue;
        let axis = u.cross(v);
        if (axis.lengthSq() < 1e-12) {
          // Exactly opposite: any perpendicular turns it the right way round.
          axis = u.perpendicular();
        }
        turn(b, axis, angle * influence);
        recompose(b);
        moved = true;
      }
      if (!moved) break;
      if (tailOf(tip).distanceTo(goal) < 1e-5) break;
    }

    // The pole is applied after reaching, as a twist of the chain root about
    // the line from its head to the tip. Twisting about that line cannot move
    // the tip, so the reach that was just solved for survives it.
    if (pole !== undefined && chain.length >= 2) {
      const root = chain[chain.length - 1];
      const base = headOf(root);
      const line = tailOf(tip).sub(base);
      if (line.lengthSq() > 1e-12) {
        const axis = line.normalized();
        const knee = headOf(chain[chain.length - 2]);
        const have = reject(knee.sub(base), axis);
        const want = reject(headOf(pole).sub(base), axis);
        if (have.lengthSq() > 1e-12 && want.lengthSq() > 1e-12) {
          const hu = have.normalized();
          const wu = want.normalized();
          const angle = Math.atan2(hu.cross(wu).dot(axis), clamp(hu.dot(wu), -1, 1));
          turn(root, axis, angle * influence);
          recompose(root);
        }
      }
    }
    return lowest;

    function seedBend(): void {
      if (chain.length < 2) return;
      const root = chain[chain.length - 1];
      const base = headOf(root);
      const reach = tailOf(tip).sub(base);
      const want = goal.sub(base);
      if (reach.lengthSq() < 1e-12 || want.lengthSq() < 1e-12) return;
      // Already bent, or the target is off the line: the solver can proceed.
      if (reach.normalized().cross(want.normalized()).lengthSq() > 1e-8) return;
      if (want.length() >= reach.length() - 1e-6) return;

      let axis: Vec3 | null = null;
      if (pole !== undefined) {
        const toPole = reject(headOf(pole).sub(base), reach.normalized());
        if (toPole.lengthSq() > 1e-12) axis = reach.normalized().cross(toPole.normalized());
      }
      if (!axis || axis.lengthSq() < 1e-12) axis = reach.normalized().perpendicular();
      // A tenth of a radian is enough to give the descent a gradient and small
      // enough that it is gone by the second iteration.
      for (const b of chain) turn(b, axis, b === root ? 0.1 : -0.2);
      recompose(chain[chain.length - 1]);
    }
  }

  function copyRotation(c: CopyRotationConstraint, i: number, influence: number): number {
    const target = byName.get(c.target);
    if (target === undefined || target === i) return -1;
    const axes = c.axes ?? [true, true, true];
    const src = bones[target];
    const sign = c.invert ? -1 : 1;
    const wanted = new Vec3(
      axes[0] ? src.rotation[0] * sign : bones[i].rotation[0],
      axes[1] ? src.rotation[1] * sign : bones[i].rotation[1],
      axes[2] ? src.rotation[2] * sign : bones[i].rotation[2],
    );
    const own = new Vec3(bones[i].rotation[0], bones[i].rotation[1], bones[i].rotation[2]);
    const blended = own.lerp(wanted, influence);
    local[i] = Mat4.compose(
      new Vec3(bones[i].position[0], bones[i].position[1], bones[i].position[2]),
      blended,
      new Vec3(bones[i].scale[0], bones[i].scale[1], bones[i].scale[2]),
    );
    return i;
  }

  function copyLocation(c: CopyLocationConstraint, i: number, influence: number): number {
    const target = byName.get(c.target);
    if (target === undefined || target === i) return -1;
    const axes = c.axes ?? [true, true, true];
    const here = headOf(i);
    const there = headOf(target);
    const offset = new Vec3(
      axes[0] ? (there.x - here.x) * influence : 0,
      axes[1] ? (there.y - here.y) * influence : 0,
      axes[2] ? (there.z - here.z) * influence : 0,
    );
    if (offset.lengthSq() < 1e-18) return -1;
    // The move is in world space; the correction has to be in the bone's.
    const a = pose[i].multiply(extra[i].inverse());
    const localOffset = a.inverse().transformDirection(offset);
    extra[i] = Mat4.translation(localOffset).multiply(extra[i]);
    return i;
  }

  function trackTo(c: TrackToConstraint, i: number, influence: number): number {
    const target = byName.get(c.target);
    if (target === undefined || target === i) return -1;
    const pivot = headOf(i);
    const from = tailOf(i).sub(pivot);
    const to = headOf(target).sub(pivot);
    if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return -1;
    const u = from.normalized();
    const v = to.normalized();
    const angle = Math.acos(clamp(u.dot(v), -1, 1));
    if (angle < 1e-6) return -1;
    let axis = u.cross(v);
    if (axis.lengthSq() < 1e-12) axis = u.perpendicular();
    turn(i, axis, angle * influence);
    return i;
  }

  function limitRotation(c: LimitRotationConstraint, i: number, influence: number): number {
    const use = c.use ?? [true, true, true];
    const min = c.min ?? [-Math.PI, -Math.PI, -Math.PI];
    const max = c.max ?? [Math.PI, Math.PI, Math.PI];
    // What the bone is actually doing, corrections included: limiting only the
    // authored rotation would let an IK solver bend a knee backwards and call
    // the limit satisfied.
    // `pose[i] = base · local · extra`, so the bone's own transform is
    // `base⁻¹ · pose[i]`. Multiplying the other way round conjugates it, which
    // looks plausible, decomposes without complaint, and gives an angle that
    // is not the one the joint is actually at.
    const base = parentOf(i) >= 0
      ? pose[parentOf(i)].multiply(localRest[parentOf(i)].inverse().multiply(localRest[i]))
      : localRest[i];
    const total = base.inverse().multiply(pose[i]);
    const current = decomposeMatrix(total).rotation;
    const wanted = new Vec3(
      use[0] ? clamp(current.x, min[0], max[0]) : current.x,
      use[1] ? clamp(current.y, min[1], max[1]) : current.y,
      use[2] ? clamp(current.z, min[2], max[2]) : current.z,
    );
    const blended = current.lerp(wanted, influence);
    if (blended.equals(current, 1e-9)) return -1;
    // Replace the whole correction rather than adding to it: a limit is a
    // statement about where the bone ends up, not a nudge towards it.
    const kept = Mat4.compose(
      new Vec3(bones[i].position[0], bones[i].position[1], bones[i].position[2]),
      new Vec3(0, 0, 0),
      new Vec3(bones[i].scale[0], bones[i].scale[1], bones[i].scale[2]),
    );
    local[i] = kept;
    extra[i] = Mat4.rotationEuler(blended);
    return i;
  }
}

/** The component of `v` perpendicular to a unit axis. */
function reject(v: Vec3, axis: Vec3): Vec3 {
  return v.sub(axis.scale(v.dot(axis)));
}

/**
 * The bone's rest orientation at its head.
 *
 * Duplicated from `armature.ts` deliberately rather than imported in a circle:
 * the constraint solver is the lower layer here, and `armature.ts` calls into
 * it rather than the other way round.
 */
function restMatrixOf(b: Bone): Mat4 {
  const head = boneHead(b);
  const dir = boneTail(b).sub(head);
  const len = dir.length();
  const y = len > 1e-9 ? dir.scale(1 / len) : new Vec3(0, 1, 0);
  const helper = Math.abs(y.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  let x = helper.cross(y);
  if (x.lengthSq() < 1e-12) x = new Vec3(1, 0, 0);
  x = x.normalized();
  const z = x.cross(y).normalized();
  const c = Math.cos(b.roll);
  const s = Math.sin(b.roll);
  const rx = x.scale(c).add(z.scale(s));
  const rz = z.scale(c).sub(x.scale(s));
  return Mat4.fromBasis(rx, y, rz, head);
}
