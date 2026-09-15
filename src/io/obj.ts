import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene } from '../scene/Scene';
import { SceneTexture } from '../scene/Texture';

/**
 * Wavefront OBJ. The Culp Mixer is Z-up like Blender, while OBJ is conventionally Y-up,
 * so both directions convert axes the way Blender's default importer/exporter
 * does: (x, y, z)_kline <-> (x, z, -y)_obj.
 */

function toObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, p.z, -p.y);
}

function fromObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, -p.z, p.y);
}

export function exportOBJ(scene: Scene, selectionOnly = false): string {
  // Without this line the .mtl beside the .obj is never opened: an importer
  // has no other way to know it exists, so every material — and with them
  // every texture — was silently dropped on the way into any other
  // application. The name matches what the export command writes out.
  const lines: string[] = [
    '# Exported from The Culp Mixer',
    `# ${new Date().toISOString()}`,
    `mtllib ${MTL_FILENAME}`,
  ];
  let vertexOffset = 1;
  let uvOffset = 1;

  for (const obj of scene.objects.values()) {
    if (obj.type !== 'mesh' || !obj.mesh) continue;
    if (selectionOnly && !scene.selection.has(obj.id)) continue;
    const mesh = obj.evaluated();
    if (!mesh) continue;
    const model = obj.worldMatrix(scene);
    const normalMat = model.normalMatrix();
    const t = mesh.topology();

    lines.push(`o ${obj.name.replace(/\s+/g, '_')}`);
    for (const p of mesh.positions) {
      const w = toObjAxes(model.transformPoint(p));
      lines.push(`v ${w.x.toFixed(6)} ${w.y.toFixed(6)} ${w.z.toFixed(6)}`);
    }
    for (const n of t.vertNormals) {
      const w = toObjAxes(normalMat.transformDirection(n)).normalized();
      lines.push(`vn ${w.x.toFixed(6)} ${w.y.toFixed(6)} ${w.z.toFixed(6)}`);
    }
    // Texture coordinates are per corner, so they get their own index space.
    const uvIndex: number[][] = [];
    let uvCount = 0;
    for (let f = 0; f < mesh.faces.length; f++) {
      const uv = mesh.uvFor(f);
      if (!uv) {
        uvIndex.push([]);
        continue;
      }
      const row: number[] = [];
      for (let i = 0; i < mesh.faces[f].length; i++) {
        lines.push(`vt ${uv[i * 2].toFixed(6)} ${uv[i * 2 + 1].toFixed(6)}`);
        row.push(uvOffset + uvCount);
        uvCount++;
      }
      uvIndex.push(row);
    }

    let lastSlot = -1;
    for (let f = 0; f < mesh.faces.length; f++) {
      const slot = mesh.faceMaterial[f] ?? 0;
      if (slot !== lastSlot) {
        const matIndex = obj.materialSlots[slot] ?? 0;
        const mat = scene.materials[matIndex];
        if (mat) lines.push(`usemtl ${materialName(mat.name)}`);
        lastSlot = slot;
      }
      lines.push(`s ${mesh.isFaceSmooth(f) ? 1 : 'off'}`);
      const uvRow = uvIndex[f];
      const corners = mesh.faces[f].map((v, i) => (
        uvRow.length
          ? `${v + vertexOffset}/${uvRow[i]}/${v + vertexOffset}`
          : `${v + vertexOffset}//${v + vertexOffset}`
      ));
      lines.push(`f ${corners.join(' ')}`);
    }
    vertexOffset += mesh.positions.length;
    uvOffset += uvCount;
  }
  return lines.join('\n') + '\n';
}

/** The name the .obj points at, and the name the export command saves it under. */
export const MTL_FILENAME = 'scene.mtl';

function materialName(name: string): string {
  return name.replace(/\s+/g, '_') || 'Material';
}

/**
 * The filename a texture is written beside the .obj under.
 *
 * MTL cannot embed an image the way glTF can — it can only name a file next to
 * it — so the images have to be saved too, and both sides have to agree on
 * what they are called. Derived from the id so two textures that were given
 * the same name do not overwrite each other.
 */
export function textureFilename(texture: SceneTexture): string {
  const base = texture.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.[^.]*$/, '') || 'texture';
  return `${base}-${texture.id}.png`;
}

/** Every image the .mtl refers to, with the bytes to write beside it. */
export function texturesForMTL(scene: Scene): { filename: string; url: string }[] {
  const used = new Set<number>();
  for (const m of scene.materials) if (m.baseColorTexture != null) used.add(m.baseColorTexture);
  return scene.textures
    .filter((t) => used.has(t.id) && !!t.url)
    .map((t) => ({ filename: textureFilename(t), url: t.url }));
}

export function exportMTL(scene: Scene): string {
  const out: string[] = ['# Exported from The Culp Mixer'];
  const byId = new Map(scene.textures.map((t) => [t.id, t]));
  for (const mat of scene.materials) {
    out.push(
      `newmtl ${materialName(mat.name)}`,
      `Kd ${mat.color.map((c) => c.toFixed(6)).join(' ')}`,
      `Ke ${mat.emission.map((c) => (c * mat.emissionStrength).toFixed(6)).join(' ')}`,
      `Pm ${mat.metallic.toFixed(4)}`,
      `Pr ${mat.roughness.toFixed(4)}`,
      `d ${mat.alpha.toFixed(4)}`,
    );
    // The whole point of a model built from a photograph is that it is wearing
    // the photograph. Exporting the coordinates and not the picture hands
    // somebody a grey shape and no way to tell what was lost.
    const tex = mat.baseColorTexture == null ? undefined : byId.get(mat.baseColorTexture);
    if (tex?.url) out.push(`map_Kd ${textureFilename(tex)}`);
    out.push('');
  }
  return out.join('\n');
}

export interface ImportedObject {
  name: string;
  mesh: Mesh;
}

/** A coordinate that is missing, misspelt or overflowed reads as zero. */
function num(text: string | undefined): number {
  const v = Number(text);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Parse an OBJ file into one mesh per `o`/`g` group.
 *
 * OBJ is a text format that arrives from everywhere — other applications,
 * half-finished exports, files truncated by a failed download — so this parser
 * treats every line as a suggestion. Nothing it returns can contain a
 * non-finite coordinate or an index that does not name a vertex.
 */
export function importOBJ(text: string): ImportedObject[] {
  const positions: Vec3[] = [];
  const uvs: [number, number][] = [];
  const objects: ImportedObject[] = [];
  let current: {
    name: string;
    faces: number[][];
    smooth: boolean[];
    /** Per face, one coordinate index per corner, or null when it had none. */
    uv: (number[] | null)[];
  } | null = null;

  const flush = (): void => {
    if (!current || current.faces.length === 0) return;
    // Re-index so each object only carries the vertices it uses. Every corner
    // here has already been checked against the vertex table, so the lookup
    // cannot miss.
    const map = new Map<number, number>();
    const localPositions: Vec3[] = [];
    const faces = current.faces.map((f) =>
      f.map((v) => {
        let idx = map.get(v);
        if (idx === undefined) {
          idx = localPositions.length;
          map.set(v, idx);
          localPositions.push(positions[v]);
        }
        return idx;
      }),
    );
    const mesh = new Mesh(localPositions, faces);
    mesh.faceSmooth = current.smooth.slice();
    mesh.shadeSmooth = current.smooth.some(Boolean);
    // Texture coordinates, if the file carried any. The Culp Mixer round-tripped its
    // own OBJ export and lost them every time, which meant a model built from
    // a photograph came back untextured from a file that had the coordinates
    // written in it.
    if (current.uv.some(Boolean)) {
      mesh.faceUV = current.uv.map((row, f) => {
        if (!row || row.length !== faces[f].length) return null;
        const flat: number[] = [];
        for (const i of row) {
          const uv = uvs[i];
          flat.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
        }
        return flat;
      });
    }
    mesh.cleanDegenerate();
    // A group whose faces were all degenerate or all unindexable leaves nothing
    // to show; an empty entry in the outliner is worse than no entry.
    if (mesh.faces.length) objects.push({ name: current.name, mesh });
  };

  let smooth = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      // A vertex line always produces a vertex, even when its numbers are
      // unreadable: face indices count `v` lines, so skipping one would shift
      // every index after it and quietly rebuild the model wrong. A bad
      // component becomes zero instead, which is visible and local.
      positions.push(fromObjAxes(new Vec3(num(parts[1]), num(parts[2]), num(parts[3]))));
    } else if (tag === 'vt') {
      // Same reasoning as `v`: face corners index these by position, so an
      // unreadable one still has to occupy its slot.
      uvs.push([num(parts[1]), num(parts[2])]);
    } else if (tag === 'o' || tag === 'g') {
      flush();
      current = { name: parts.slice(1).join(' ') || 'Object', faces: [], smooth: [], uv: [] };
    } else if (tag === 's') {
      smooth = parts[1] !== 'off' && parts[1] !== '0';
    } else if (tag === 'f') {
      if (!current) current = { name: 'Object', faces: [], smooth: [], uv: [] };
      const loop: number[] = [];
      const loopUV: number[] = [];
      let everyCornerHasUV = true;
      for (let i = 1; i < parts.length; i++) {
        const spec = parts[i].split('/');
        let idx = parseInt(spec[0], 10);
        if (Number.isNaN(idx)) continue;
        // Negative indices count back from the vertices seen so far, positive
        // ones are 1-based from the top of the file. Either way the result has
        // to name a vertex that exists: OBJ requires vertices before the faces
        // that use them, so anything else is a corrupt or truncated file, and
        // the corner is dropped rather than pointed at an invented origin.
        if (idx < 0) idx = positions.length + idx;
        else idx -= 1;
        if (idx < 0 || idx >= positions.length) continue;
        loop.push(idx);

        // `v//vn` is legal and means no coordinate for this corner, so a face
        // is only textured when every one of its corners names a real one.
        let uvIdx = spec.length > 1 ? parseInt(spec[1], 10) : NaN;
        if (Number.isNaN(uvIdx)) { everyCornerHasUV = false; continue; }
        if (uvIdx < 0) uvIdx = uvs.length + uvIdx;
        else uvIdx -= 1;
        if (uvIdx < 0 || uvIdx >= uvs.length) { everyCornerHasUV = false; continue; }
        loopUV.push(uvIdx);
      }
      if (loop.length >= 3) {
        current.faces.push(loop);
        current.smooth.push(smooth);
        current.uv.push(everyCornerHasUV && loopUV.length === loop.length ? loopUV : null);
      }
    }
  }
  flush();
  return objects;
}

/** Bake an object's world transform into its geometry (used on import/export). */
export function applyTransformToMesh(mesh: Mesh, m: Mat4): Mesh {
  const out = mesh.clone();
  out.transform(m);
  return out;
}
