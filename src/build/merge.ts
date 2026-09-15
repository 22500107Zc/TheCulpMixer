import { SerializedObject } from '../scene/Scene';
import { Baseline, BaselinePart, SerializedMesh, baselineProves } from './provenance';

/**
 * Keeping your work when the generator runs again.
 *
 * A regeneration has three versions of every part in play, not two: what the
 * generator made last time, what you made of it, and what the generator would
 * make now. Comparing only the first and last is what makes "regenerate" mean
 * "throw your work away" everywhere else — the new output simply overwrites,
 * and the two hours you spent on materials go with it.
 *
 * With the baseline in hand each field can be decided on its own:
 *
 *   - the generator changed it and you did not  -> take the generator's
 *   - you changed it and the generator did not  -> keep yours
 *   - neither changed it                        -> nothing to decide
 *   - both changed it, differently              -> a conflict, reported
 *
 * The last case is the important one and the one that must never be decided
 * silently. Sculpting a generated shape and then asking for a different
 * topology is a real disagreement about what the object is; there is no merge
 * that keeps both, and pretending otherwise loses the sculpt. So it comes back
 * as a conflict with the choices spelled out, and nothing is applied until
 * somebody picks.
 *
 * What this does *not* do is claim that arbitrary edits survive. A vertex
 * moved in Edit Mode, a sculpted crease, an unwrapped UV island and a painted
 * weight are all stored against a particular set of vertices; when a
 * regeneration produces a different set, the mapping is gone and no amount of
 * merging brings it back. Those are conflicts, and they are reported as
 * conflicts rather than quietly dropped.
 */

/** How one part came out of the merge. */
export type MergeAction =
  | 'unchanged'
  | 'updated'
  | 'kept-yours'
  | 'added'
  | 'removed'
  | 'conflict'
  | 'protected'
  /** The creator deleted it and the revision agrees, or does not disagree. */
  | 'stays-deleted'
  /** The revision brings back something the creator deleted. */
  | 'restored';

export type ConflictKind =
  | 'geometry'
  | 'topology'
  | 'removal'
  | 'protected'
  | 'transform'
  | 'material'
  /** You deleted it; the revision changes it. */
  | 'delete-vs-modify'
  /** You changed it; the revision deletes it. */
  | 'modify-vs-delete'
  /** Nothing recorded proves this is untouched, so it is not treated as safe. */
  | 'unverifiable'
  /** Two parts could correspond and there is no way to tell which. */
  | 'ambiguous-identity';

export interface MergeConflict {
  key: string;
  name: string;
  kind: ConflictKind;
  /** Plain-language account of what disagrees, shown to the user as-is. */
  detail: string;
  /** Object id in the live scene, when the part is still there. */
  objectId: number | null;
  /**
   * Which field this disagreement is about, when it is about one.
   *
   * A conflict over a name is not a reason to reconsider a shape. Resolving at
   * the narrowest scope that makes sense is what stops "use the revised
   * geometry" from also throwing away a placement nobody was arguing about.
   */
  field?: 'geometry' | 'name' | 'position' | 'rotation' | 'scale' | 'existence';
  /** What Use the revised one would put here, in words. */
  theirs?: string;
  /** What Keep mine would leave here, in words. */
  yours?: string;
}

/** One part's outcome, and the object it should become. */
export interface MergedPart {
  key: string;
  name: string;
  action: MergeAction;
  /** Fields taken from the generator's new output. */
  tookGenerator: string[];
  /** Fields kept from the user's version. */
  keptYours: string[];
  objectId: number | null;
}

export interface MergeReport {
  parts: MergedPart[];
  conflicts: MergeConflict[];
  /** Objects under the asset that the generator does not know about. */
  userAdded: { id: number; name: string }[];
  added: number;
  removed: number;
  updated: number;
  keptYours: number;
  unchanged: number;
  protectedParts: number;
  /** Parts the creator deleted that this revision leaves deleted. */
  staysDeleted: number;
  /**
   * True when the recorded baseline predates The Culp Mixer storing materials,
   * modifiers and animation, so "unedited" could not actually be established.
   */
  unverifiable: boolean;
  /**
   * True when the baseline was missing, so a user edit could not be told from
   * a generator change. Every field is then treated as the user's, and the
   * generator's version is offered as a whole rather than merged.
   */
  blind: boolean;
}

/** One part as the generator proposes it now. */
export interface ProposedPart {
  key: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mesh: SerializedMesh | null;
  color?: string;
}

/** What the merge decided for one part, ready to be applied to the scene. */
export interface PartPlan {
  key: string;
  /** Null for a part that does not exist yet. */
  objectId: number | null;
  action: MergeAction;
  /** The geometry to use, or null to leave the object's own alone. */
  mesh: SerializedMesh | null;
  name: string | null;
  position: [number, number, number] | null;
  rotation: [number, number, number] | null;
  scale: [number, number, number] | null;
  /** Present only when the part is new and needs a colour from the generator. */
  color?: string;
}

export interface MergePlan {
  report: MergeReport;
  parts: PartPlan[];
  /** Objects to delete: parts the generator dropped that you had not edited. */
  remove: number[];
  /**
   * Part keys that remain deliberately deleted after this revision.
   *
   * Written into the record on acceptance so the next revision, and the one
   * after a reload, do not offer them back again.
   */
  stillDeleted: string[];
}

/** How the user's copy of a part is presented to the merge. */
export interface CurrentPart {
  key: string;
  object: SerializedObject;
  /** Held back from regeneration at the user's request. */
  protectedFromRegen: boolean;
  /**
   * Objects the creator made that hang underneath this part.
   *
   * Removing a part removes its subtree, so these have to be known before the
   * removal is agreed to rather than discovered afterwards.
   */
  userDescendants: { id: number; name: string }[];
}

const ROUND = 1e-6;

function sameTriple(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b) return a === b;
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > ROUND) return false;
  }
  return true;
}

/**
 * Whether two meshes are the same geometry.
 *
 * Serialised form rather than a tolerance-based comparison: the question here
 * is "did this change since it was written down", and the two sides are either
 * the same recorded numbers or they are not. A geometric tolerance belongs in
 * the comparison view, where the question is "does this look different"; using
 * one here would let a real edit hide inside the tolerance.
 */
export function sameMesh(a: SerializedMesh | null, b: SerializedMesh | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two meshes have the same vertex and face structure, ignoring positions. */
export function sameTopology(a: SerializedMesh | null, b: SerializedMesh | null): boolean {
  if (!a || !b) return a === b;
  if (a.positions.length !== b.positions.length) return false;
  if (a.faces.length !== b.faces.length) return false;
  for (let f = 0; f < a.faces.length; f++) {
    const fa = a.faces[f];
    const fb = b.faces[f];
    if (fa.length !== fb.length) return false;
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return false;
  }
  return true;
}

/**
 * Attributes that are stored per-vertex or per-corner, and so are only
 * meaningful against the topology they were made for.
 *
 * Named individually because the honest answer to "does my unwrap survive"
 * depends on which of these the object actually carries: a plain generated box
 * has none of them and regenerates freely, and one that has been unwrapped,
 * painted and weighted has three separate things to lose.
 */
export function boundAttributes(mesh: SerializedMesh | null): string[] {
  if (!mesh) return [];
  const out: string[] = [];
  if (mesh.faceUV && mesh.faceUV.some((uv) => uv)) out.push('UV coordinates');
  if (mesh.colors && mesh.colors.length) out.push('vertex colours');
  if (mesh.skin && mesh.skin.bones.length) out.push('skin weights');
  if (mesh.seams && mesh.seams.length) out.push('seams');
  if (mesh.mask && mesh.mask.length) out.push('sculpt mask');
  return out;
}

/**
 * Decide what a regeneration should do to every part of an asset.
 *
 * Pure: it reads three descriptions and returns a plan. Nothing in the scene
 * is touched, which is what lets the result be shown as a preview and thrown
 * away without consequence.
 */
export interface MergeContext {
  /** Parts the creator has already deleted on purpose. */
  deleted?: string[];
  /** The scene's material list, so slot indices can be resolved to values. */
  materials?: unknown[];
}

export function mergeAsset(
  baseline: Baseline,
  current: CurrentPart[],
  proposed: ProposedPart[],
  userAdded: { id: number; name: string }[] = [],
  context: MergeContext = {},
): MergePlan {
  const deletedBefore = new Set(context.deleted ?? []);
  // Whether the baseline records enough to prove a part is untouched. When it
  // does not, "unchanged" is a guess, and the merge is not allowed to delete
  // anything on a guess.
  const proves = baselineProves(baseline);
  const stillDeleted = new Set<string>();
  const base = new Map<string, BaselinePart>();
  for (const p of baseline.parts ?? []) base.set(p.key, p);
  const mine = new Map<string, CurrentPart>();
  for (const p of current) mine.set(p.key, p);
  const theirs = new Map<string, ProposedPart>();
  for (const p of proposed) theirs.set(p.key, p);

  const blind = !(baseline.parts && baseline.parts.length);
  const parts: MergedPart[] = [];
  const plans: PartPlan[] = [];
  const conflicts: MergeConflict[] = [];
  const remove: number[] = [];

  const keys = new Set<string>([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  for (const key of keys) {
    const was = base.get(key) ?? null;
    const now = mine.get(key) ?? null;
    const next = theirs.get(key) ?? null;

    // ---- the creator deleted this part
    //
    // Five cases, and only one of them is "make it again". Getting this wrong
    // is what makes a deletion something you have to perform once per
    // revision, for ever.
    if (!now && was) {
      const deletedByCreator = deletedBefore.has(key) || true;
      const generatorAlsoDropped = !next;
      if (generatorAlsoDropped) {
        // Deleted by both: it stays gone, and stays recorded as gone.
        stillDeleted.add(key);
        parts.push({ key, name: was.name, action: 'stays-deleted', tookGenerator: [], keptYours: ['deletion'], objectId: null });
        continue;
      }
      const generatorChangedIt = !sameMesh(was.mesh, next.mesh)
        || !sameTriple(was.position, next.position)
        || !sameTriple(was.rotation, next.rotation)
        || !sameTriple(was.scale, next.scale)
        || was.name !== next.name;
      if (!generatorChangedIt) {
        // The revision has nothing new to say about it, so your deletion wins.
        stillDeleted.add(key);
        parts.push({ key, name: was.name, action: 'stays-deleted', tookGenerator: [], keptYours: ['deletion'], objectId: null });
        continue;
      }
      // Delete versus modify: you removed it, this revision changes it. Only
      // you can say which of those you meant, so it stays deleted until you do.
      void deletedByCreator;
      stillDeleted.add(key);
      conflicts.push({
        key, name: was.name, kind: 'delete-vs-modify', objectId: null, field: 'existence',
        yours: 'stays deleted',
        theirs: `brought back, ${describeChange(was, next)}`,
        detail: `You deleted "${was.name}", and this revision changes it. It stays deleted `
          + 'unless you ask for it back.',
      });
      parts.push({ key, name: was.name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: null });
      continue;
    }

    // The generator no longer makes this part.
    if (!next) {
      if (!now) continue;
      const name = now.object.name;
      if (now.protectedFromRegen) {
        conflicts.push({
          key, name, kind: 'protected', objectId: now.object.id,
          yours: 'kept', theirs: 'protection turned off, and it removed',
          detail: `"${name}" is protected, and this revision would remove it. It is being kept.`,
        });
        parts.push({ key, name, action: 'protected', tookGenerator: [], keptYours: ['everything'], objectId: now.object.id });
        continue;
      }
      // Missing evidence is not permission. A baseline that never recorded
      // materials cannot show that the material is untouched, so a removal
      // becomes a question rather than a deletion.
      if (blind || !was || !proves) {
        conflicts.push({
          key, name, kind: blind || !was ? 'removal' : 'unverifiable', objectId: now.object.id,
          field: 'existence', yours: 'kept as it is', theirs: 'removed',
          detail: blind || !was
            ? `This revision removes "${name}", and there is no record of what it looked like when it was generated, so your changes to it cannot be told apart.`
            : `This revision removes "${name}". Its record predates The Culp Mixer storing materials, `
              + 'modifiers and animation, so there is no way to show you have not changed those. '
              + 'It is kept until you say otherwise.',
        });
        parts.push({ key, name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: now.object.id });
        continue;
      }
      const touched = changesSinceBaseline(was, now.object, context.materials);
      if (touched.length) {
        conflicts.push({
          key, name, kind: 'modify-vs-delete', objectId: now.object.id,
          field: 'existence', yours: `kept, with your ${touched.join(', ')}`, theirs: 'removed',
          detail: `This revision removes "${name}", but you changed its ${touched.join(', ')} `
            + 'after it was generated.',
        });
        parts.push({ key, name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: now.object.id });
        continue;
      }
      if (now.userDescendants.length) {
        conflicts.push({
          key, name, kind: 'modify-vs-delete', objectId: now.object.id,
          field: 'existence',
          yours: `kept, along with ${now.userDescendants.length} object(s) of yours under it`,
          theirs: 'removed',
          detail: `This revision removes "${name}", and ${now.userDescendants.length} object(s) `
            + 'you made are attached to it.',
        });
        parts.push({ key, name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: now.object.id });
        continue;
      }
      remove.push(now.object.id);
      parts.push({ key, name, action: 'removed', tookGenerator: ['removal'], keptYours: [], objectId: now.object.id });
      continue;
    }

    // A part the generator makes now and did not before. Genuinely new: no
    // baseline entry, nothing deleted under this key.
    if (!now) {
      if (deletedBefore.has(key)) {
        // Deleted in an earlier revision and offered again. Your decision
        // stands; bringing it back is something you ask for.
        stillDeleted.add(key);
        conflicts.push({
          key, name: next.name, kind: 'delete-vs-modify', objectId: null, field: 'existence',
          yours: 'stays deleted', theirs: 'brought back',
          detail: `You deleted "${next.name}" in an earlier revision. This one would bring it `
            + 'back; it stays deleted unless you ask for it.',
        });
        parts.push({ key, name: next.name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: null });
        continue;
      }
      parts.push({ key, name: next.name, action: 'added', tookGenerator: ['everything'], keptYours: [], objectId: null });
      plans.push({
        key, objectId: null, action: 'added',
        mesh: next.mesh, name: next.name,
        position: next.position, rotation: next.rotation, scale: next.scale, color: next.color,
      });
      continue;
    }

    const obj = now.object;
    const name = obj.name;
    if (now.protectedFromRegen) {
      const wouldChange = !was || !sameMesh(was.mesh, next.mesh)
        || !sameTriple(was.position, next.position) || !sameTriple(was.rotation, next.rotation)
        || !sameTriple(was.scale, next.scale);
      if (wouldChange) {
        conflicts.push({
          key, name, kind: 'protected', objectId: obj.id,
          yours: 'left exactly as it is',
          theirs: 'protection turned off, and the generated version applied',
          detail: `"${name}" is protected from regeneration, and this revision would change it. `
            + 'It is being left alone.',
        });
      }
      parts.push({
        key, name, action: 'protected', tookGenerator: [],
        keptYours: ['everything'], objectId: obj.id,
      });
      continue;
    }

    const tookGenerator: string[] = [];
    const keptYours: string[] = [];
    // A disagreement about the shape is not a reason to stop asking about the
    // name and the placement: they are separate decisions, and rolling them
    // together is what makes "use the revised geometry" quietly reset a
    // custom name nobody was arguing about.
    let geometryConflict = false;
    const plan: PartPlan = {
      key, objectId: obj.id, action: 'unchanged',
      mesh: null, name: null, position: null, rotation: null, scale: null,
    };

    // ---- geometry
    const generatorMovedGeometry = !was || !sameMesh(was.mesh, next.mesh);
    const youMovedGeometry = !was || !sameMesh(was.mesh, obj.mesh ?? null);
    if (generatorMovedGeometry && !youMovedGeometry) {
      plan.mesh = next.mesh;
      tookGenerator.push('geometry');
    } else if (!generatorMovedGeometry && youMovedGeometry) {
      keptYours.push('geometry');
    } else if (generatorMovedGeometry && youMovedGeometry) {
      if (sameMesh(obj.mesh ?? null, next.mesh)) {
        // Both arrived at the same shape; there is nothing to disagree about.
        keptYours.push('geometry');
      } else {
        const lost = boundAttributes(obj.mesh ?? null);
        const topologyChanged = !sameTopology(obj.mesh ?? null, next.mesh);
        conflicts.push({
          key, name, objectId: obj.id, field: 'geometry',
          kind: topologyChanged ? 'topology' : 'geometry',
          yours: `your shape${lost.length ? `, with its ${lost.join(', ')}` : ''}`,
          theirs: 'the generated shape',
          detail: describeGeometryConflict(name, blind, topologyChanged, lost),
        });
        geometryConflict = true;
      }
    }

    // ---- name, transform, and everything else that is a plain value
    //
    // These merge field by field, which is what makes "keep its placement" and
    // "keep its materials" true rather than aspirational: moving a generated
    // logo and then changing its extrusion depth touches two different fields,
    // and only one of them has two opinions.
    let fieldConflict = false;
    const decide = (
      field: 'name' | 'position' | 'rotation' | 'scale',
      basedOn: boolean,        // generator changed it since the baseline
      yours: boolean,          // you changed it since the baseline
      agree: boolean,          // both landed on the same value
      show: { yours: string; theirs: string },
      take: () => void,
    ): void => {
      if (basedOn && yours && !agree) {
        // Both moved it, to different places. Nobody but the creator can say
        // which was meant, so it is asked rather than decided — silently
        // keeping one of them is the failure this whole feature exists to fix.
        conflicts.push({
          key, name, objectId: obj.id, kind: 'transform', field,
          yours: show.yours, theirs: show.theirs,
          detail: `You changed the ${field} of "${name}" and so did this revision, differently.`,
        });
        fieldConflict = true;
        return;
      }
      if (basedOn && !yours) {
        take();
        tookGenerator.push(field);
      } else if (yours) {
        keptYours.push(field);
      }
    };

    const trip = (v: readonly number[]): string => v.map((n) => round3(n)).join(', ');
    decide('name',
      !!was && was.name !== next.name,
      !!was && was.name !== obj.name,
      obj.name === next.name,
      { yours: `"${obj.name}"`, theirs: `"${next.name}"` },
      () => { plan.name = next.name; });
    decide('position',
      !was || !sameTriple(was.position, next.position),
      !was || !sameTriple(was.position, obj.position),
      sameTriple(obj.position, next.position),
      { yours: trip(obj.position), theirs: trip(next.position) },
      () => { plan.position = next.position; });
    decide('rotation',
      !was || !sameTriple(was.rotation, next.rotation),
      !was || !sameTriple(was.rotation, obj.rotation),
      sameTriple(obj.rotation, next.rotation),
      { yours: trip(obj.rotation), theirs: trip(next.rotation) },
      () => { plan.rotation = next.rotation; });
    decide('scale',
      !was || !sameTriple(was.scale, next.scale),
      !was || !sameTriple(was.scale, obj.scale),
      sameTriple(obj.scale, next.scale),
      { yours: trip(obj.scale), theirs: trip(next.scale) },
      () => { plan.scale = next.scale; });

    // Materials, modifiers, visibility, animation and hierarchy are never
    // taken from the generator: a re-run has no opinion about them beyond the
    // colour it asked for on a brand new part, and the whole point is that
    // what you did to them is yours.
    if (obj.materialSlots.length) keptYours.push('materials');
    if (obj.modifiers.length) keptYours.push('modifiers');
    if (obj.animation && obj.animation.length) keptYours.push('animation');
    if (!obj.visible || obj.locked) keptYours.push('visibility');

    const disputed = geometryConflict || fieldConflict;
    plan.action = disputed
      ? 'conflict'
      : tookGenerator.length ? 'updated' : keptYours.length ? 'kept-yours' : 'unchanged';
    parts.push({
      key, name, action: plan.action, tookGenerator, keptYours, objectId: obj.id,
    });
    // A disputed field is simply left out of the plan; the fields that agree
    // still apply. Nothing under dispute is written until somebody chooses.
    if (plan.action !== 'unchanged' && (plan.mesh || plan.name !== null || plan.position
      || plan.rotation || plan.scale)) {
      plans.push(plan);
    }
  }

  const count = (action: MergeAction): number => parts.filter((p) => p.action === action).length;
  return {
    parts: plans,
    remove,
    stillDeleted: [...stillDeleted],
    report: {
      parts,
      conflicts,
      userAdded,
      added: count('added'),
      removed: count('removed'),
      updated: count('updated'),
      keptYours: count('kept-yours'),
      unchanged: count('unchanged'),
      protectedParts: count('protected'),
      staysDeleted: count('stays-deleted'),
      blind,
      unverifiable: !proves,
    },
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** A short account of how the generator's version differs from the baseline. */
function describeChange(was: BaselinePart, next: ProposedPart): string {
  const bits: string[] = [];
  if (!sameMesh(was.mesh, next.mesh)) bits.push('a different shape');
  if (!sameTriple(was.position, next.position)) bits.push('a different position');
  if (!sameTriple(was.rotation, next.rotation)) bits.push('a different rotation');
  if (!sameTriple(was.scale, next.scale)) bits.push('a different scale');
  if (was.name !== next.name) bits.push(`renamed to "${next.name}"`);
  return bits.length ? `now with ${bits.join(', ')}` : 'unchanged';
}

/**
 * Everything about a part that the creator has changed since it was generated.
 *
 * Named individually rather than reduced to a yes/no, because the answer is
 * what the conflict says out loud: "you changed its material" is actionable
 * and "it has been edited" is not.
 *
 * Materials are the subtle one. A slot is an index into a list everything
 * shares, so recolouring a material changes what an object looks like without
 * touching the object at all. Comparing indices would miss it completely, so
 * the values behind the indices are compared too.
 */
export function changesSinceBaseline(
  was: BaselinePart, obj: SerializedObject, materials?: unknown[],
): string[] {
  const out: string[] = [];
  const json = (v: unknown): string => JSON.stringify(v ?? null);
  if (!sameMesh(was.mesh, obj.mesh ?? null)) {
    const attrs = differingAttributes(was.mesh, obj.mesh ?? null);
    out.push(attrs.length ? `shape and ${attrs.join(', ')}` : 'shape');
  } else {
    const attrs = differingAttributes(was.mesh, obj.mesh ?? null);
    if (attrs.length) out.push(attrs.join(', '));
  }
  if (!sameTriple(was.position, obj.position)) out.push('position');
  if (!sameTriple(was.rotation, obj.rotation)) out.push('rotation');
  if (!sameTriple(was.scale, obj.scale)) out.push('scale');
  if (was.name !== obj.name) out.push('name');
  if (was.materialSlots && json(was.materialSlots) !== json(obj.materialSlots)) {
    out.push('material');
  } else if (was.materials && materials) {
    const now = (obj.materialSlots ?? []).map((slot) => materials[slot] ?? null);
    if (json(was.materials) !== json(now)) out.push('material');
  }
  if (was.modifiers && json(was.modifiers) !== json(obj.modifiers)) out.push('modifiers');
  if (was.animation && json(was.animation) !== json(obj.animation ?? [])) out.push('animation');
  if (was.visible !== undefined && was.visible !== obj.visible) out.push('visibility');
  if (was.locked !== undefined && was.locked !== obj.locked) out.push('lock');
  return out;
}

/** Which mesh attributes differ, by name, for a message somebody can act on. */
function differingAttributes(a: SerializedMesh | null, b: SerializedMesh | null): string[] {
  if (!a || !b) return [];
  const json = (v: unknown): string => JSON.stringify(v ?? null);
  const out: string[] = [];
  if (json(a.faceUV) !== json(b.faceUV)) out.push('UVs');
  if (json(a.colors) !== json(b.colors)) out.push('vertex colours');
  if (json(a.skin) !== json(b.skin)) out.push('skin weights');
  if (json(a.seams) !== json(b.seams)) out.push('seams');
  if (json(a.faceSmooth) !== json(b.faceSmooth) || a.shadeSmooth !== b.shadeSmooth) {
    out.push('smoothing');
  }
  return out;
}

function describeGeometryConflict(
  name: string, blind: boolean, topologyChanged: boolean, lost: string[],
): string {
  if (blind) {
    return `"${name}" has no recorded baseline, so your edits to its shape cannot be told from `
      + 'the generator\'s. Applying the revision would replace the shape entirely.';
  }
  const what = lost.length
    ? ` Your ${lost.join(', ')} are stored against the vertices this would replace, so they cannot be carried over.`
    : '';
  return topologyChanged
    ? `You changed the shape of "${name}", and this revision rebuilds it with different topology. `
      + `There is no correspondence between the two, so one has to win.${what}`
    : `Both you and this revision moved the vertices of "${name}", differently.${what}`;
}

/** One line for a status bar; the panel shows the detail. */
export function summariseMerge(report: MergeReport): string {
  const bits: string[] = [];
  if (report.added) bits.push(`${report.added} added`);
  if (report.removed) bits.push(`${report.removed} removed`);
  if (report.updated) bits.push(`${report.updated} updated`);
  if (report.keptYours) bits.push(`${report.keptYours} kept as you had them`);
  if (report.unchanged) bits.push(`${report.unchanged} unchanged`);
  if (report.protectedParts) bits.push(`${report.protectedParts} protected`);
  if (report.staysDeleted) bits.push(`${report.staysDeleted} still deleted`);
  if (report.userAdded.length) bits.push(`${report.userAdded.length} of yours untouched`);
  if (report.conflicts.length) bits.push(`${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') : 'nothing to change';
}
