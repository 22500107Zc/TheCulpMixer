import { Mat4, Quat, Vec3, decomposeMatrix } from '../core/math';
import { Scene } from '../scene/Scene';
import { completeTransform, sampleChannels, setKey } from '../anim/animation';
import { PhysicsWorld, RigidBody, bodyForBounds, defaultWorld, refreshInertia } from './rigidbody';

/**
 * Turning a simulation into animation.
 *
 * A modelling application does not need physics at runtime; it needs the
 * answer physics gives. So the sim runs once, over the timeline, and the
 * result is written as keyframes — after which nothing depends on the solver
 * being deterministic, the same across machines, or even still present. The
 * animation is the artefact.
 */

export interface BakeResult {
  /** Objects that were simulated. */
  bodies: number;
  frames: number;
  /** Keys written across all channels. */
  keys: number;
}

/**
 * Build a world from whatever in the scene has been marked as a body.
 *
 * Shapes come from bounds rather than from the geometry itself. A box around a
 * chair settles it on a floor correctly, and an exact hull would cost far more
 * than the difference is worth in an application where the point is to get a
 * plausible resting arrangement quickly.
 */
export function worldFromScene(scene: Scene): PhysicsWorld {
  const world = new PhysicsWorld(defaultWorld());
  for (const obj of scene.objects.values()) {
    if (!obj.physics || !obj.visible) continue;
    const geo = obj.evaluated(false);
    if (!geo || geo.positions.length === 0) continue;
    const local = geo.bounds();
    if (!local.valid) continue;

    // The body is oriented, so it is sized from the object's *local* bounds
    // and given the object's rotation — measuring the axis-aligned extent of
    // an already-rotated object would give a box bigger than the object and
    // then rotate that too.
    const world4 = obj.worldMatrix(scene);
    const decomposed = decomposeMatrix(world4);
    const mass = obj.physics.kind === 'passive' ? 0 : Math.max(1e-3, obj.physics.mass);
    const body = bodyForBounds(
      obj.id, local.min, local.max, obj.physics.shape, mass,
      Quat.fromEuler(decomposed.rotation), decomposed.scale,
    );
    // `bodyForBounds` puts the body at the local centre; move that into world
    // space through the same transform the object uses.
    body.position = world4.transformPoint(local.min.add(local.max.sub(local.min).scale(0.5)));
    body.friction = obj.physics.friction;
    body.restitution = obj.physics.restitution;
    refreshInertia(body);
    world.add(body);
  }
  return world;
}

/**
 * Where an object's parent is, on a given frame.
 *
 * The solver works in world space and an animation channel is parent-relative.
 * Those are the same numbers only when there is no parent, so converting
 * between them needs the parent's world matrix — and if the parent is itself
 * animated, the one it has *on that frame* rather than the one it happens to
 * be showing now. Sampling the chain here is what lets a simulated object stay
 * where the simulation put it while the thing it hangs from moves underneath.
 */
function parentWorldAt(scene: Scene, objectId: number, frame: number): Mat4 {
  const chain: number[] = [];
  let at = scene.get(objectId)?.parent ?? null;
  let guard = 0;
  while (at !== null && guard++ < 64) {
    chain.push(at);
    at = scene.get(at)?.parent ?? null;
  }
  let m = new Mat4();
  // Root first, so each matrix multiplies on the right of its ancestors'.
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = scene.get(chain[i]);
    if (!node) continue;
    const posed = completeTransform(
      sampleChannels(node.animation, frame),
      { position: node.position, rotation: node.rotation, scale: node.scale },
      node.animation,
    );
    m = m.multiply(Mat4.compose(posed.position, posed.rotation, posed.scale));
  }
  return m;
}

/**
 * The world matrix an object must have for its body to sit where the solver
 * left it.
 *
 * The body is placed at the centre of the object's bounds, which is not
 * usually the object's origin. The vector between them belongs to the object
 * and therefore turns with it: treating it as a constant world offset — which
 * is what the previous code did — leaves a spinning object's origin tracing a
 * circle it should not. Composing it as a transform keeps it attached.
 */
function poseFor(
  centre: Vec3, rotation: Vec3, scale: Vec3, centreLocal: Vec3,
): Mat4 {
  return Mat4.translation(centre)
    .multiply(Mat4.rotationEuler(rotation))
    .multiply(Mat4.scaling(scale))
    .multiply(Mat4.translation(centreLocal.scale(-1)));
}

/**
 * Run the simulation across the timeline and write the result as keyframes.
 *
 * Existing position and rotation keys on the simulated objects are cleared
 * first: leaving them would blend the sim against whatever was there and
 * produce something that is neither.
 */
export function bakeToKeyframes(scene: Scene): BakeResult {
  const world = worldFromScene(scene);
  const active = world.bodies.filter((b) => b.mass > 0);
  if (active.length === 0) return { bodies: 0, frames: 0, keys: 0 };

  const start = Math.round(scene.timeline.start);
  const end = Math.round(scene.timeline.end);
  const frames = Math.max(0, end - start);
  const fps = Math.max(1, scene.timeline.fps);

  // Two things have to be carried from the scene into every baked frame, and
  // the old code carried neither correctly.
  //
  // The first is where the body sits inside its object: `bodyForBounds` puts
  // the body at the centre of the bounds, which is rarely the object's origin.
  // That vector is in the object's own space, so it turns and scales with the
  // object rather than staying put in the world.
  //
  // The second is the object's scale, which the solver does not carry and
  // which has to go back into the pose before it is handed to the hierarchy.
  const centreLocal = new Map<number, Vec3>();
  const localScale = new Map<number, Vec3>();
  for (const b of world.bodies) {
    const obj = scene.get(b.objectId);
    const geo = obj?.evaluated(false);
    const bounds = geo?.bounds();
    if (!obj || !bounds?.valid) continue;
    centreLocal.set(b.objectId, bounds.min.add(bounds.max.sub(bounds.min).scale(0.5)));
    localScale.set(b.objectId, decomposeMatrix(obj.worldMatrix(scene)).scale);
  }

  const track = world.simulate(frames, fps);
  let keys = 0;
  const simulated = new Set(active.map((b) => b.objectId));

  for (const id of simulated) {
    const obj = scene.get(id);
    if (!obj) continue;
    obj.animation = obj.animation.filter((c) => c.path !== 'position' && c.path !== 'rotation');
  }

  for (let f = 0; f < track.length; f++) {
    const frame = start + f;
    for (const state of track[f]) {
      if (!simulated.has(state.objectId)) continue;
      const obj = scene.get(state.objectId);
      if (!obj) continue;
      // The solver's answer, as a world matrix: the body's pose with the
      // object's own scale and its origin-to-centre offset composed back in.
      const worldPose = poseFor(
        new Vec3(state.position[0], state.position[1], state.position[2]),
        new Vec3(state.rotation[0], state.rotation[1], state.rotation[2]),
        localScale.get(state.objectId) ?? new Vec3(1, 1, 1),
        centreLocal.get(state.objectId) ?? new Vec3(),
      );
      // Then into the space the channels are actually expressed in. With no
      // parent this is the identity and the result is the world pose, which is
      // what the previous code assumed always — correct for the one case it
      // was tested on and wrong for every object hanging off anything.
      const local = parentWorldAt(scene, state.objectId, frame).inverse().multiply(worldPose);
      const placed = decomposeMatrix(local);
      const pos = [placed.position.x, placed.position.y, placed.position.z];
      const rot = [placed.rotation.x, placed.rotation.y, placed.rotation.z];
      for (let i = 0; i < 3; i++) {
        // Linear rather than bezier: the solver already produced a sample per
        // frame, and smoothing between them would round off the moment of an
        // impact, which is the one part nobody wants softened.
        setKey(obj.animation, 'position', i, frame, pos[i], 'linear');
        setKey(obj.animation, 'rotation', i, frame, rot[i], 'linear');
        keys += 2;
      }
    }
  }

  return { bodies: active.length, frames: track.length, keys };
}

/** Remove baked animation from every simulated object. */
export function clearBake(scene: Scene): number {
  let cleared = 0;
  for (const obj of scene.objects.values()) {
    if (!obj.physics) continue;
    const before = obj.animation.length;
    obj.animation = obj.animation.filter((c) => c.path !== 'position' && c.path !== 'rotation');
    if (obj.animation.length !== before) cleared++;
  }
  return cleared;
}

/** Where every body ends up, without writing anything — for a quick preview. */
export function settle(scene: Scene, seconds = 3): Map<number, RigidBody> {
  const world = worldFromScene(scene);
  const steps = Math.round(seconds / world.settings.step);
  for (let i = 0; i < steps; i++) world.step();
  const out = new Map<number, RigidBody>();
  for (const b of world.bodies) out.set(b.objectId, b);
  return out;
}
