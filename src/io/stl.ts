import { Vec3 } from '../core/math';
import { Scene } from '../scene/Scene';

/** Binary STL export. Triangle soup in world space, Z-up (STL has no axis convention). */
export function exportSTL(scene: Scene, selectionOnly = false): ArrayBuffer {
  interface Tri {
    n: Vec3;
    a: Vec3;
    b: Vec3;
    c: Vec3;
  }
  const tris: Tri[] = [];

  for (const obj of scene.objects.values()) {
    if (obj.type !== 'mesh' || !obj.mesh) continue;
    if (selectionOnly && !scene.selection.has(obj.id)) continue;
    const mesh = obj.evaluated();
    if (!mesh) continue;
    const model = obj.worldMatrix(scene);
    const normalMat = model.normalMatrix();
    const t = mesh.topology();
    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      const n = normalMat.transformDirection(t.faceNormals[f]).normalized();
      for (let i = 1; i + 1 < loop.length; i++) {
        tris.push({
          n,
          a: model.transformPoint(mesh.positions[loop[0]]),
          b: model.transformPoint(mesh.positions[loop[i]]),
          c: model.transformPoint(mesh.positions[loop[i + 1]]),
        });
      }
    }
  }

  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buffer);
  const header = 'Exported from The Culp Mixer';
  for (let i = 0; i < header.length && i < 80; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, tris.length, true);

  let o = 84;
  const put = (v: Vec3): void => {
    view.setFloat32(o, v.x, true);
    view.setFloat32(o + 4, v.y, true);
    view.setFloat32(o + 8, v.z, true);
    o += 12;
  };
  for (const t of tris) {
    put(t.n);
    put(t.a);
    put(t.b);
    put(t.c);
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buffer;
}
