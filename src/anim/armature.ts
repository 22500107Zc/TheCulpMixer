import { Mat4, Vec3 } from '../core/math';
import { BoneConstraint, cloneConstraints, hasConstraints, solveArmature } from './constraints';

/**
 * Armatures.
 *
 * A bone is a segment from a head to a tail plus a pose transform applied on
 * top of it. Splitting those two apart is what makes a rig work: the head and
 * tail describe where the bone rests inside the model and never move, while
 * posing accumulates in a separate transform, so the deformation is always
 * "how far is this bone from its rest position" rather than an absolute that
 * would drift as soon as you re-parented anything.
 *
 * Bones are stored flat with parent indices rather than as a tree. A flat list
 * serializes without cycles, survives an edit that re-parents a bone without
 * rebuilding anything, and — as long as it stays topologically sorted — lets
 * the pose evaluate in one pass.
 */

export interface Bone {
  name: string;
  /** Index of the parent bone, or -1 for a root. */
  parent: number;
  /** Rest position of the joint this bone pivots about. */
  head: [number, number, number];
  /** Rest position of the far end. */
  tail: [number, number, number];
  /** Twist about the head-to-tail axis, in radians. */
  roll: number;
  /** Pose translation, relative to the rest pose. */
  position: [number, number, number];
  /** Pose rotation in radians, XYZ. */
  rotation: [number, number, number];
  /** Pose scale. */
  scale: [number, number, number];
  /**
   * Envelope radius used when generating weights. Zero means "work it out from
   * the bone's own length", which is right far more often than not.
   */
  envelope: number;
  /**
   * Rules the pose has to satisfy — IK, copy rotation, limits.
   *
   * Applied in order at evaluation time and never written back, so the
   * authored pose stays the authored pose and a constraint can be switched off
   * to get it back exactly. Absent on almost every bone, so it is optional
   * rather than an empty array everywhere.
   */
  constraints?: BoneConstraint[];
}

export interface ArmatureData {
  bones: Bone[];
}

export function createBone(partial: Partial<Bone> = {}): Bone {
  return {
    name: partial.name ?? 'Bone',
    parent: partial.parent ?? -1,
    head: partial.head ?? [0, 0, 0],
    tail: partial.tail ?? [0, 0, 1],
    roll: partial.roll ?? 0,
    position: partial.position ?? [0, 0, 0],
    rotation: partial.rotation ?? [0, 0, 0],
    scale: partial.scale ?? [1, 1, 1],
    envelope: partial.envelope ?? 0,
    ...(partial.constraints?.length ? { constraints: cloneConstraints(partial.constraints) } : {}),
  };
}

export function createArmature(): ArmatureData {
  return { bones: [createBone({ name: 'Bone' })] };
}

export function cloneArmature(a: ArmatureData): ArmatureData {
  return {
    bones: a.bones.map((b) => ({
      ...b,
      head: [...b.head] as [number, number, number],
      tail: [...b.tail] as [number, number, number],
      position: [...b.position] as [number, number, number],
      rotation: [...b.rotation] as [number, number, number],
      scale: [...b.scale] as [number, number, number],
      ...(b.constraints?.length ? { constraints: cloneConstraints(b.constraints) } : {}),
    })),
  };
}

export function boneHead(b: Bone): Vec3 {
  return new Vec3(b.head[0], b.head[1], b.head[2]);
}

export function boneTail(b: Bone): Vec3 {
  return new Vec3(b.tail[0], b.tail[1], b.tail[2]);
}

export function boneLength(b: Bone): number {
  return boneTail(b).distanceTo(boneHead(b));
}

/** Envelope radius, falling back to a fraction of the bone's length. */
export function boneEnvelope(b: Bone): number {
  return b.envelope > 0 ? b.envelope : Math.max(1e-4, boneLength(b) * 0.5);
}

/**
 * The bone's rest orientation as a matrix at its head.
 *
 * The bone points along +Y by convention. Roll turns it about that axis, which
 * matters because it decides which way a bend goes when the pose rotates
 * around X or Z.
 */
export function restMatrix(b: Bone): Mat4 {
  const head = boneHead(b);
  const dir = boneTail(b).sub(head);
  const len = dir.length();
  const y = len > 1e-9 ? dir.scale(1 / len) : new Vec3(0, 1, 0);
  // Any perpendicular will do as a starting point; roll then fixes it.
  const helper = Math.abs(y.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  let x = helper.cross(y);
  if (x.lengthSq() < 1e-12) x = new Vec3(1, 0, 0);
  x = x.normalized();
  let z = x.cross(y).normalized();
  const c = Math.cos(b.roll);
  const s = Math.sin(b.roll);
  const rx = x.scale(c).add(z.scale(s));
  const rz = z.scale(c).sub(x.scale(s));
  return Mat4.fromBasis(rx, y, rz, head);
}

/**
 * Rest and posed world matrices for every bone, in armature space.
 *
 * A bone's pose is applied about its own head, in its own rest frame, so
 * rotating a forearm bends the elbow rather than swinging the whole arm about
 * the armature's origin.
 */
export function poseMatrices(armature: ArmatureData): { rest: Mat4[]; pose: Mat4[] } {
  // A constrained rig goes through the solver, which is the same evaluation
  // with the rules applied on top. Kept behind a check so an unconstrained
  // armature — which is most of them, and every one made before constraints
  // existed — costs exactly what it did before.
  if (hasConstraints(armature)) return solveArmature(armature);
  const n = armature.bones.length;
  const rest: Mat4[] = new Array(n);
  const pose: Mat4[] = new Array(n);
  const localRest: Mat4[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const b = armature.bones[i];
    localRest[i] = restMatrix(b);
  }
  for (let i = 0; i < n; i++) {
    const b = armature.bones[i];
    // A parent must be evaluated first. Bones are kept sorted so a parent's
    // index is always lower; anything else is treated as a root rather than
    // read half-computed.
    const p = b.parent >= 0 && b.parent < i ? b.parent : -1;
    rest[i] = p >= 0 ? rest[p].multiply(relativeRest(localRest[p], localRest[i])) : localRest[i];
    const local = Mat4.compose(
      new Vec3(b.position[0], b.position[1], b.position[2]),
      new Vec3(b.rotation[0], b.rotation[1], b.rotation[2]),
      new Vec3(b.scale[0], b.scale[1], b.scale[2]),
    );
    const posedLocal = p >= 0
      ? pose[p].multiply(relativeRest(localRest[p], localRest[i])).multiply(local)
      : localRest[i].multiply(local);
    pose[i] = posedLocal;
  }
  return { rest, pose };
}

function relativeRest(parent: Mat4, child: Mat4): Mat4 {
  return parent.inverse().multiply(child);
}

/**
 * The matrix each bone applies to skinned geometry: undo the rest pose, then
 * apply the posed one. A bone that has not been posed comes out as identity,
 * which is the property that makes a rig safe to attach to a finished model.
 */
export function skinMatrices(armature: ArmatureData): Mat4[] {
  const { rest, pose } = poseMatrices(armature);
  return rest.map((r, i) => pose[i].multiply(r.inverse()));
}

/** Head and tail of every bone in its posed position, for drawing. */
export function posedSegments(armature: ArmatureData): { head: Vec3; tail: Vec3 }[] {
  const { rest, pose } = poseMatrices(armature);
  return armature.bones.map((b, i) => {
    const m = pose[i].multiply(rest[i].inverse());
    return { head: m.transformPoint(boneHead(b)), tail: m.transformPoint(boneTail(b)) };
  });
}

/** Reset every bone to its rest pose. */
export function clearPose(armature: ArmatureData): void {
  for (const b of armature.bones) {
    b.position = [0, 0, 0];
    b.rotation = [0, 0, 0];
    b.scale = [1, 1, 1];
  }
}

/**
 * Keep bones ordered parents-first, remapping the parent indices as it goes.
 *
 * Everything here evaluates in one pass on that assumption, and a single
 * re-parent from the UI can break it. Sorting once after an edit is cheaper
 * and much harder to get wrong than making every consumer handle any order.
 */
export function sortBones(armature: ArmatureData): void {
  const bones = armature.bones;
  const order: number[] = [];
  const placed = new Set<number>();
  let guard = 0;
  while (order.length < bones.length && guard++ < bones.length + 2) {
    for (let i = 0; i < bones.length; i++) {
      if (placed.has(i)) continue;
      const p = bones[i].parent;
      if (p < 0 || p >= bones.length || placed.has(p)) {
        placed.add(i);
        order.push(i);
      }
    }
  }
  // A cycle would leave bones unplaced; treat those as roots rather than drop
  // them, since losing a bone silently is far worse than an odd hierarchy.
  for (let i = 0; i < bones.length; i++) {
    if (!placed.has(i)) {
      bones[i].parent = -1;
      order.push(i);
    }
  }
  const remap = new Int32Array(bones.length);
  order.forEach((old, next) => {
    remap[old] = next;
  });
  const sorted = order.map((i) => bones[i]);
  for (const b of sorted) if (b.parent >= 0) b.parent = remap[b.parent];
  armature.bones = sorted;
}
