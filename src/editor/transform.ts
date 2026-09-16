import { Mat4, RAD2DEG, Vec3, rayPlane } from '../core/math';
import { ViewportCamera } from '../scene/ViewportCamera';

export type TransformKind = 'translate' | 'rotate' | 'scale';

export interface TransformModifiers {
  precision: boolean;
  snap: boolean;
}

export interface TransformOptions {
  /** Grid step used when snapping translation. */
  snapIncrement: number;
  /** Degrees used when snapping rotation. */
  snapAngle: number;
}

const DEFAULTS: TransformOptions = { snapIncrement: 0.25, snapAngle: 5 };

/**
 * A Blender-style modal transform: start it, feed it mouse moves and key
 * presses, and it hands back a world-space matrix to apply to the captured
 * original geometry. Axis constraints (X/Y/Z), plane constraints (Shift+axis),
 * precision (Shift), snapping (Ctrl) and typed numeric input all work the way
 * they do in Blender.
 */
export class TransformSession {
  axis: number | null = null;
  /** When true the constraint is the plane perpendicular to `axis`. */
  plane = false;
  /** Free-form constraint direction (e.g. a face normal for extrude). */
  custom: { vec: Vec3; label: string } | null = null;
  numeric = '';
  /** Geometry snap target; when set, translation lands the pivot exactly here. */
  snapPoint: Vec3 | null = null;
  /** Absolute-grid step; 0 disables. */
  gridStep = 0;
  private modifiers: TransformModifiers = { precision: false, snap: false };
  private lastMatrix = Mat4.identity();
  private value = new Vec3();
  private angle = 0;
  private factor = new Vec3(1, 1, 1);
  private startAngle: number;
  private startDist: number;

  constructor(
    public readonly kind: TransformKind,
    public readonly pivot: Vec3,
    private camera: ViewportCamera,
    private viewport: { width: number; height: number },
    private startX: number,
    private startY: number,
    public readonly options: TransformOptions = DEFAULTS,
  ) {
    const p = camera.worldToScreen(pivot, viewport.width, viewport.height);
    this.startAngle = Math.atan2(startY - p.y, startX - p.x);
    this.startDist = Math.max(8, Math.hypot(startX - p.x, startY - p.y));
  }

  /**
   * Move the gesture's origin to a new pixel, as if it had started there.
   *
   * A mouse has a position before the transform begins, so the delta can be
   * measured from wherever the pointer already was. A finger does not: the
   * screen is untouched until it lands, and by then the tool has been chosen
   * from a button somewhere else entirely. Without this, the first touch
   * teleported the selection by the distance between that button and the
   * finger — hundreds of pixels — before the drag had moved at all.
   *
   * Rotation and scale are re-anchored too, because both measure from the
   * pivot to the start point, and a stale start gives a rotation that jumps by
   * the opening angle and a scale factor that jumps by the opening distance.
   */
  reanchor(x: number, y: number): void {
    this.startX = x;
    this.startY = y;
    const p = this.camera.worldToScreen(this.pivot, this.viewport.width, this.viewport.height);
    this.startAngle = Math.atan2(y - p.y, x - p.x);
    this.startDist = Math.max(8, Math.hypot(x - p.x, y - p.y));
  }

  /** Constrain to an arbitrary direction, such as the extrude normal. */
  constrainTo(vec: Vec3, label: string): void {
    if (vec.lengthSq() < 1e-12) return;
    this.custom = { vec: vec.normalized(), label };
    this.axis = null;
    this.plane = false;
  }

  setAxis(axis: number | null, plane = false): void {
    this.custom = null;
    if (this.axis === axis && this.plane === plane) {
      this.axis = null;
      this.plane = false;
    } else {
      this.axis = axis;
      this.plane = plane;
    }
    this.numeric = '';
  }

  setModifiers(m: TransformModifiers): void {
    this.modifiers = m;
  }

  /** Feed a typed character; returns true if it was consumed. */
  typeChar(ch: string): boolean {
    if (/[0-9]/.test(ch)) {
      this.numeric += ch;
      return true;
    }
    if (ch === '.' && !this.numeric.includes('.')) {
      this.numeric += ch;
      return true;
    }
    if (ch === '-') {
      this.numeric = this.numeric.startsWith('-') ? this.numeric.slice(1) : `-${this.numeric}`;
      return true;
    }
    if (ch === 'Backspace' && this.numeric.length) {
      this.numeric = this.numeric.slice(0, -1);
      return true;
    }
    return false;
  }

  private numericValue(): number | null {
    if (!this.numeric || this.numeric === '-' || this.numeric === '.') return null;
    const v = parseFloat(this.numeric);
    return Number.isFinite(v) ? v : null;
  }

  /** The active linear constraint, or null when movement is unconstrained. */
  private constraint(): Vec3 | null {
    if (this.axis !== null && !this.plane) return Vec3.axis(this.axis);
    if (this.axis === null && this.custom) return this.custom.vec;
    return null;
  }

  private axisVector(): Vec3 {
    return this.constraint() ?? new Vec3(0, 0, 1);
  }

  /** Recompute from the current mouse position and return the transform matrix. */
  update(x: number, y: number): Mat4 {
    const precision = this.modifiers.precision ? 0.1 : 1;
    switch (this.kind) {
      case 'translate': this.lastMatrix = this.updateTranslate(x, y, precision); break;
      case 'rotate': this.lastMatrix = this.updateRotate(x, y, precision); break;
      case 'scale': this.lastMatrix = this.updateScale(x, y, precision); break;
    }
    return this.lastMatrix;
  }

  get matrix(): Mat4 {
    return this.lastMatrix;
  }

  private dragPlaneNormal(): Vec3 {
    if (this.axis !== null && this.plane) return Vec3.axis(this.axis);
    return this.camera.forward().neg();
  }

  /** Unproject a pixel onto the drag plane through the pivot. */
  private planePoint(x: number, y: number): Vec3 {
    const n = this.dragPlaneNormal();
    const ray = this.camera.screenRay(x, y, this.viewport.width, this.viewport.height);
    const t = rayPlane(ray.origin, ray.dir, this.pivot, n);
    if (t === null) return this.pivot.clone();
    return ray.origin.add(ray.dir.scale(t));
  }

  private updateTranslate(x: number, y: number, precision: number): Mat4 {
    const from = this.planePoint(this.startX, this.startY);
    const to = this.planePoint(x, y);
    let delta = to.sub(from).scale(precision);

    const typed = this.numericValue();
    const constraint = this.constraint();
    if (this.snapPoint && typed === null) {
      // Land the pivot on the snap target, still respecting any axis lock.
      const want = this.snapPoint.sub(this.pivot);
      delta = constraint ? constraint.scale(want.dot(constraint)) : want;
      this.value = delta;
      return Mat4.translation(delta);
    }
    if (this.gridStep > 0 && typed === null) {
      const s = this.gridStep;
      const target = this.pivot.add(delta);
      const snapped = new Vec3(
        Math.round(target.x / s) * s, Math.round(target.y / s) * s, Math.round(target.z / s) * s,
      );
      delta = snapped.sub(this.pivot);
      if (constraint) delta = constraint.scale(delta.dot(constraint));
      this.value = delta;
      return Mat4.translation(delta);
    }
    if (constraint) {
      delta = constraint.scale(typed !== null ? typed : delta.dot(constraint));
    } else if (typed !== null) {
      const dir = delta.lengthSq() > 1e-12 ? delta.normalized() : new Vec3(1, 0, 0);
      delta = dir.scale(typed);
    }

    if (this.modifiers.snap && typed === null) {
      const s = this.options.snapIncrement;
      delta = new Vec3(
        Math.round(delta.x / s) * s, Math.round(delta.y / s) * s, Math.round(delta.z / s) * s,
      );
    }
    this.value = delta;
    return Mat4.translation(delta);
  }

  private updateRotate(x: number, y: number, precision: number): Mat4 {
    const p = this.camera.worldToScreen(this.pivot, this.viewport.width, this.viewport.height);
    const cur = Math.atan2(y - p.y, x - p.x);
    let angle = (cur - this.startAngle) * precision;
    // Unwrap so a full sweep past ±180° keeps accumulating.
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;

    const axis = this.axis === null ? this.camera.forward() : Vec3.axis(this.axis);
    const typed = this.numericValue();
    if (typed !== null) {
      // A typed angle means exactly that, in the axis's own right-handed sense.
      this.angle = typed / RAD2DEG;
      return Mat4.translation(this.pivot)
        .multiply(Mat4.rotationAxis(axis, this.angle))
        .multiply(Mat4.translation(this.pivot.neg()));
    }
    if (this.modifiers.snap) {
      const step = this.options.snapAngle / RAD2DEG;
      angle = Math.round(angle / step) * step;
    }
    // Screen angles grow clockwise (y points down), which reads as a positive
    // right-handed rotation only when the axis points away from the camera.
    const sign = Math.sign(this.camera.forward().dot(axis)) || 1;
    this.angle = angle * sign;
    return Mat4.translation(this.pivot)
      .multiply(Mat4.rotationAxis(axis, this.angle))
      .multiply(Mat4.translation(this.pivot.neg()));
  }

  private updateScale(x: number, y: number, precision: number): Mat4 {
    const p = this.camera.worldToScreen(this.pivot, this.viewport.width, this.viewport.height);
    const dist = Math.hypot(x - p.x, y - p.y);
    let f = 1 + (dist / this.startDist - 1) * precision;

    const typed = this.numericValue();
    if (typed !== null) f = typed;
    else if (this.modifiers.snap) f = Math.round(f / 0.1) * 0.1;

    let s: Vec3;
    if (this.axis === null) s = new Vec3(f, f, f);
    else if (this.plane) {
      s = new Vec3(f, f, f);
      if (this.axis === 0) s.x = 1;
      if (this.axis === 1) s.y = 1;
      if (this.axis === 2) s.z = 1;
    } else {
      s = new Vec3(1, 1, 1);
      if (this.axis === 0) s.x = f;
      if (this.axis === 1) s.y = f;
      if (this.axis === 2) s.z = f;
    }
    this.factor = s;
    return Mat4.translation(this.pivot)
      .multiply(Mat4.scaling(s))
      .multiply(Mat4.translation(this.pivot.neg()));
  }

  /** Status-bar text, mirroring Blender's modal header. */
  header(): string {
    const axisName = this.axis === null
      ? (this.custom ? this.custom.label : '')
      : `global ${this.plane ? 'plane ' : ''}${['X', 'Y', 'Z'][this.axis]}`;
    const suffix = axisName ? ` along ${axisName}` : '';
    const typed = this.numeric ? `  [${this.numeric}]` : '';
    switch (this.kind) {
      case 'translate': {
        const v = this.value;
        const shown = this.constraint()
          ? v.dot(this.axisVector()).toFixed(4)
          : `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
        return `Move ${shown}${suffix}${typed}`;
      }
      case 'rotate':
        return `Rotate ${(this.angle * RAD2DEG).toFixed(2)}°${suffix}${typed}`;
      case 'scale': {
        const f = this.factor;
        return `Scale ${f.x.toFixed(3)}, ${f.y.toFixed(3)}, ${f.z.toFixed(3)}${suffix}${typed}`;
      }
    }
  }
}
