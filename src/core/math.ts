/**
 * Minimal linear algebra for The Culp Mixer. Column-major 4x4 matrices, right-handed
 * coordinate system, +Z up (Blender convention) so imported/exported data and
 * user muscle memory line up.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPS = 1e-9;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A number from outside, held to a range, with anything unusable replaced.
 *
 * Not the same job as `clamp`, which is for numbers that are already known to
 * be numbers and deliberately lets NaN through — every comparison against NaN
 * is false, so it falls out of the middle unchanged. That is the right
 * behaviour inside a solver and a trap at the edge of one.
 *
 * Settings arrive from number fields a user can empty, from sliders, and from
 * scene files written by older versions or by nothing at all. A NaN among
 * them used to travel straight into vertex positions and produce a mesh that
 * renders as nothing, exports as garbage and gives no clue where it came
 * from; an absurd value could put a smoothing loop into a million passes and
 * hang the window. This is what every generator's options go through.
 */
export function setting(value: number | null | undefined, fallback: number, lo: number, hi: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static of(x: number, y: number, z: number): Vec3 {
    return new Vec3(x, y, z);
  }
  static zero(): Vec3 {
    return new Vec3(0, 0, 0);
  }
  static one(): Vec3 {
    return new Vec3(1, 1, 1);
  }
  static axis(i: number): Vec3 {
    return new Vec3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  }
  static fromArray(a: ArrayLike<number>, o = 0): Vec3 {
    return new Vec3(a[o], a[o + 1], a[o + 2]);
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  mul(v: Vec3): Vec3 {
    return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z);
  }
  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }
  neg(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }
  addInPlace(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  scaleInPlace(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }
  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  distanceTo(v: Vec3): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  normalized(): Vec3 {
    const l = this.length();
    return l > EPS ? new Vec3(this.x / l, this.y / l, this.z / l) : new Vec3(0, 0, 0);
  }
  lerp(v: Vec3, t: number): Vec3 {
    return new Vec3(lerp(this.x, v.x, t), lerp(this.y, v.y, t), lerp(this.z, v.z, t));
  }
  equals(v: Vec3, eps = 1e-6): boolean {
    return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps && Math.abs(this.z - v.z) < eps;
  }
  /** Any unit vector perpendicular to this one. */
  perpendicular(): Vec3 {
    const a = Math.abs(this.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
    return this.cross(a).normalized();
  }
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return new Vec3(x, y, z);
}

/**
 * Unit quaternion.
 *
 * Euler angles are the right thing in the transform panel — people think in
 * "rotate 30 degrees about Z" — and the wrong thing everywhere a rotation has
 * to be *integrated*. Adding angular velocity to three angles is not rotation:
 * the axes are not independent, so the result depends on the order they are
 * applied in and drifts further from the truth every step. A quaternion has
 * neither problem, so anything that spins over time uses one and converts back
 * at the edges.
 */
export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  static identity(): Quat {
    return new Quat(0, 0, 0, 1);
  }

  static fromAxisAngle(axis: Vec3, angle: number): Quat {
    const n = axis.normalized();
    const h = angle * 0.5;
    const s = Math.sin(h);
    return new Quat(n.x * s, n.y * s, n.z * s, Math.cos(h));
  }

  /**
   * From intrinsic XYZ euler, matching `Mat4.rotationEuler` exactly.
   *
   * Composed rather than written as a closed form. The closed form is three
   * lines shorter and one sign error away from silently disagreeing with the
   * matrix everything else uses, which is the kind of bug that surfaces as a
   * baked animation being subtly wrong rather than as anything failing.
   */
  static fromEuler(e: Vec3): Quat {
    const qx = Quat.fromAxisAngle(new Vec3(1, 0, 0), e.x);
    const qy = Quat.fromAxisAngle(new Vec3(0, 1, 0), e.y);
    const qz = Quat.fromAxisAngle(new Vec3(0, 0, 1), e.z);
    // Z last, matching Rz · Ry · Rx.
    return qz.multiply(qy).multiply(qx);
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  /** this * o — apply `o` first. */
  multiply(o: Quat): Quat {
    return new Quat(
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w,
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
    );
  }

  normalized(): Quat {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    // A zero quaternion is not a rotation; identity is the only safe answer.
    if (l < 1e-12) return Quat.identity();
    return new Quat(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  conjugate(): Quat {
    return new Quat(-this.x, -this.y, -this.z, this.w);
  }

  rotate(v: Vec3): Vec3 {
    // v + 2w(q × v) + 2(q × (q × v)), the standard shortcut that avoids
    // building a matrix for a single vector.
    const q = new Vec3(this.x, this.y, this.z);
    const t = q.cross(v).scale(2);
    return v.add(t.scale(this.w)).add(q.cross(t));
  }

  /**
   * Integrate an angular velocity for `dt`.
   *
   * The derivative of orientation is ½ ω q, so a step is that scaled by dt and
   * added — first order, then renormalised, because the addition takes the
   * quaternion very slightly off the unit sphere every time and the error
   * compounds into a visible shear if it is left there.
   */
  integrate(omega: Vec3, dt: number): Quat {
    const wq = new Quat(omega.x, omega.y, omega.z, 0);
    const d = wq.multiply(this);
    return new Quat(
      this.x + d.x * 0.5 * dt,
      this.y + d.y * 0.5 * dt,
      this.z + d.z * 0.5 * dt,
      this.w + d.w * 0.5 * dt,
    ).normalized();
  }

  /** The three axes of the frame this quaternion describes. */
  basis(): [Vec3, Vec3, Vec3] {
    return [
      this.rotate(new Vec3(1, 0, 0)),
      this.rotate(new Vec3(0, 1, 0)),
      this.rotate(new Vec3(0, 0, 1)),
    ];
  }

  /**
   * Back to intrinsic XYZ euler, so a baked rotation can go into the same
   * three numbers the transform panel edits.
   *
   * Read off the rotated basis vectors, which are the columns of the matrix
   * `fromEuler` builds, so the two are inverses by construction.
   */
  toEuler(): Vec3 {
    const [c0, c1, c2] = this.basis();
    // c0.z is -sin(β), so a magnitude near one means the Y rotation is a
    // quarter turn and the X and Z rotations have become the same rotation.
    const sinBeta = clamp(-c0.z, -1, 1);
    if (Math.abs(sinBeta) > 0.999999) {
      const beta = (Math.PI / 2) * Math.sign(sinBeta);
      // Put the whole of the degenerate pair on X and leave Z at zero, which
      // is what keeps the result continuous as it passes through.
      const alpha = sinBeta > 0 ? Math.atan2(c1.x, c1.y) : Math.atan2(-c1.x, c1.y);
      return new Vec3(alpha, beta, 0);
    }
    return new Vec3(
      Math.atan2(c1.z, c2.z),
      Math.asin(sinBeta),
      Math.atan2(c0.y, c0.x),
    );
  }
}

/** 4x4 matrix, column-major (m[col * 4 + row]) to match WebGL upload order. */
export class Mat4 {
  m: Float32Array;

  constructor(values?: ArrayLike<number>) {
    this.m = new Float32Array(16);
    if (values) this.m.set(values);
    else this.identity();
  }

  static identity(): Mat4 {
    return new Mat4();
  }

  identity(): this {
    const m = this.m;
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    return this;
  }

  clone(): Mat4 {
    return new Mat4(this.m);
  }

  static translation(v: Vec3): Mat4 {
    const r = new Mat4();
    r.m[12] = v.x;
    r.m[13] = v.y;
    r.m[14] = v.z;
    return r;
  }

  static scaling(v: Vec3): Mat4 {
    const r = new Mat4();
    r.m[0] = v.x;
    r.m[5] = v.y;
    r.m[10] = v.z;
    return r;
  }

  static rotationAxis(axis: Vec3, angle: number): Mat4 {
    const a = axis.normalized();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const { x, y, z } = a;
    const r = new Mat4();
    const m = r.m;
    m[0] = t * x * x + c;
    m[1] = t * x * y + s * z;
    m[2] = t * x * z - s * y;
    m[4] = t * x * y - s * z;
    m[5] = t * y * y + c;
    m[6] = t * y * z + s * x;
    m[8] = t * x * z + s * y;
    m[9] = t * y * z - s * x;
    m[10] = t * z * z + c;
    return r;
  }

  /** Intrinsic XYZ euler (radians), matching the transform panel ordering. */
  static rotationEuler(e: Vec3): Mat4 {
    return Mat4.rotationAxis(new Vec3(0, 0, 1), e.z)
      .multiply(Mat4.rotationAxis(new Vec3(0, 1, 0), e.y))
      .multiply(Mat4.rotationAxis(new Vec3(1, 0, 0), e.x));
  }

  /**
   * A matrix from three axes and an origin, columns in that order.
   *
   * Handy wherever a frame is already known as axes — a bone's rest
   * orientation, a tangent basis — rather than as euler angles.
   */
  static fromBasis(x: Vec3, y: Vec3, z: Vec3, origin: Vec3 = new Vec3()): Mat4 {
    const r = new Mat4();
    const m = r.m;
    m[0] = x.x; m[1] = x.y; m[2] = x.z; m[3] = 0;
    m[4] = y.x; m[5] = y.y; m[6] = y.z; m[7] = 0;
    m[8] = z.x; m[9] = z.y; m[10] = z.z; m[11] = 0;
    m[12] = origin.x; m[13] = origin.y; m[14] = origin.z; m[15] = 1;
    return r;
  }

  static compose(position: Vec3, rotation: Vec3, scale: Vec3): Mat4 {
    return Mat4.translation(position)
      .multiply(Mat4.rotationEuler(rotation))
      .multiply(Mat4.scaling(scale));
  }

  /** this * other (apply `other` first). */
  multiply(o: Mat4): Mat4 {
    const a = this.m;
    const b = o.m;
    const r = new Mat4();
    const c = r.m;
    for (let col = 0; col < 4; col++) {
      const b0 = b[col * 4 + 0];
      const b1 = b[col * 4 + 1];
      const b2 = b[col * 4 + 2];
      const b3 = b[col * 4 + 3];
      for (let row = 0; row < 4; row++) {
        c[col * 4 + row] =
          a[0 * 4 + row] * b0 + a[1 * 4 + row] * b1 + a[2 * 4 + row] * b2 + a[3 * 4 + row] * b3;
      }
    }
    return r;
  }

  transformPoint(v: Vec3): Vec3 {
    const m = this.m;
    const w = m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] || 1;
    return new Vec3(
      (m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]) / w,
      (m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]) / w,
      (m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]) / w,
    );
  }

  transformDirection(v: Vec3): Vec3 {
    const m = this.m;
    return new Vec3(
      m[0] * v.x + m[4] * v.y + m[8] * v.z,
      m[1] * v.x + m[5] * v.y + m[9] * v.z,
      m[2] * v.x + m[6] * v.y + m[10] * v.z,
    );
  }

  determinant(): number {
    const m = this.m;
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  }

  inverse(): Mat4 {
    const m = this.m;
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-20) return new Mat4();
    det = 1 / det;
    return new Mat4([
      (a11 * b11 - a12 * b10 + a13 * b09) * det,
      (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det,
      (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det,
      (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det,
      (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det,
      (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det,
      (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det,
      (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det,
      (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ]);
  }

  transpose(): Mat4 {
    const m = this.m;
    return new Mat4([
      m[0], m[4], m[8], m[12],
      m[1], m[5], m[9], m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15],
    ]);
  }

  /** Inverse-transpose of the upper 3x3, for transforming normals. */
  normalMatrix(): Mat4 {
    const inv = this.inverse().transpose();
    inv.m[3] = inv.m[7] = inv.m[11] = inv.m[12] = inv.m[13] = inv.m[14] = 0;
    inv.m[15] = 1;
    return inv;
  }

  static perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    const r = new Mat4();
    const m = r.m;
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return r;
  }

  static orthographic(
    left: number, right: number, bottom: number, top: number, near: number, far: number,
  ): Mat4 {
    const r = new Mat4();
    const m = r.m;
    m.fill(0);
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -2 / (far - near);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(far + near) / (far - near);
    m[15] = 1;
    return r;
  }

  static lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const f = target.sub(eye).normalized();
    let s = f.cross(up).normalized();
    if (s.lengthSq() < 1e-12) s = f.perpendicular();
    const u = s.cross(f);
    return new Mat4([
      s.x, u.x, -f.x, 0,
      s.y, u.y, -f.y, 0,
      s.z, u.z, -f.z, 0,
      -s.dot(eye), -u.dot(eye), f.dot(eye), 1,
    ]);
  }
}

/** Axis-aligned bounding box. */
export class AABB {
  constructor(
    public min = new Vec3(Infinity, Infinity, Infinity),
    public max = new Vec3(-Infinity, -Infinity, -Infinity),
  ) {}

  get valid(): boolean {
    return this.min.x <= this.max.x;
  }

  expand(p: Vec3): this {
    this.min.set(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y), Math.min(this.min.z, p.z));
    this.max.set(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y), Math.max(this.max.z, p.z));
    return this;
  }

  union(o: AABB): this {
    if (o.valid) {
      this.expand(o.min);
      this.expand(o.max);
    }
    return this;
  }

  center(): Vec3 {
    return this.valid ? this.min.add(this.max).scale(0.5) : new Vec3();
  }

  size(): Vec3 {
    return this.valid ? this.max.sub(this.min) : new Vec3();
  }

  radius(): number {
    return this.valid ? this.size().length() * 0.5 : 0;
  }
}

/** Closest point on segment ab to the ray (origin o, unit dir d); returns distance and t. */
/**
 * Closest point on a triangle to `p`, with its barycentric coordinates
 * (Ericson, Real-Time Collision Detection). Used by UV transfer, the boolean
 * classifier and anything else that needs "how far is this from the surface".
 */
/** The point on segment `a`-`b` nearest to `p`. */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = b.sub(a);
  const len = ab.lengthSq();
  if (len < 1e-20) return a.clone();
  const t = clamp(p.sub(a).dot(ab) / len, 0, 1);
  return a.add(ab.scale(t));
}

export function closestPointOnTriangle(
  p: Vec3, a: Vec3, b: Vec3, c: Vec3,
): { point: Vec3; u: number; v: number; w: number } {
  const ab = b.sub(a);
  const ac = c.sub(a);
  const ap = p.sub(a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, u: 1, v: 0, w: 0 };

  const bp = p.sub(b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, u: 0, v: 1, w: 0 };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: a.add(ab.scale(v)), u: 1 - v, v, w: 0 };
  }

  const cp = p.sub(c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, u: 0, v: 0, w: 1 };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: a.add(ac.scale(w)), u: 1 - w, v: 0, w };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return { point: b.add(c.sub(b).scale(w)), u: 0, v: 1 - w, w };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return { point: a.add(ab.scale(v)).add(ac.scale(w)), u: 1 - v - w, v, w };
}

export function raySegmentDistance(
  o: Vec3, d: Vec3, a: Vec3, b: Vec3,
): { dist: number; t: number } {
  const ab = b.sub(a);
  const ao = a.sub(o);
  const abab = ab.dot(ab);
  const abd = ab.dot(d);
  const abao = ab.dot(ao);
  const aod = ao.dot(d);
  const denom = abab - abd * abd;
  let t: number;
  if (Math.abs(denom) < 1e-12) t = 0;
  else t = clamp((abd * aod - abao) / denom, 0, 1);
  const pointOnSeg = a.add(ab.scale(t));
  const rel = pointOnSeg.sub(o);
  const along = Math.max(rel.dot(d), 0);
  const closestOnRay = o.add(d.scale(along));
  return { dist: pointOnSeg.distanceTo(closestOnRay), t };
}

/** Möller–Trumbore. Returns ray parameter, or null on miss. */
export function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = b.sub(a);
  const e2 = c.sub(a);
  const p = d.cross(e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const tv = o.sub(a);
  const u = tv.dot(p) * invDet;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const q = tv.cross(e1);
  const v = d.dot(q) * invDet;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = e2.dot(q) * invDet;
  return t > 1e-6 ? t : null;
}

/** Intersect a ray with the plane through `p` with normal `n`. */
export function rayPlane(o: Vec3, d: Vec3, p: Vec3, n: Vec3): number | null {
  const denom = d.dot(n);
  if (Math.abs(denom) < 1e-9) return null;
  return p.sub(o).dot(n) / denom;
}

/** Split a transform matrix into translation, XYZ euler rotation and scale. */
export function decomposeMatrix(mat: Mat4): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const m = mat.m;
  const position = new Vec3(m[12], m[13], m[14]);
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (mat.determinant() < 0) sx = -sx;
  const scale = new Vec3(sx || 1e-8, sy || 1e-8, sz || 1e-8);

  const r = [
    m[0] / scale.x, m[1] / scale.x, m[2] / scale.x,
    m[4] / scale.y, m[5] / scale.y, m[6] / scale.y,
    m[8] / scale.z, m[9] / scale.z, m[10] / scale.z,
  ];
  // Column-major: r[col * 3 + row]. Matches Mat4.rotationEuler's Rz * Ry * Rx.
  const r20 = r[2], r21 = r[5], r22 = r[8], r10 = r[1], r00 = r[0], r12 = r[7], r11 = r[4];
  const b = Math.asin(clamp(-r20, -1, 1));
  let a: number;
  let c: number;
  if (Math.abs(r20) < 0.99999) {
    a = Math.atan2(r21, r22);
    c = Math.atan2(r10, r00);
  } else {
    a = Math.atan2(-r12, r11);
    c = 0;
  }
  return { position, rotation: new Vec3(a, b, c), scale };
}
