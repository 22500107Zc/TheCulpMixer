import { RAD2DEG, DEG2RAD, Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { runCommand } from '../editor/commands';
import { MODIFIER_LABELS, Modifier, ModifierType, createModifier } from '../modifiers';
import { createMaterial, hexToLinear, linearToHex } from '../scene/Material';
import { LightType, SceneObject } from '../scene/Scene';
import { button, checkbox, clear, h, numberField, row, select } from './dom';
import { CreatePanel } from './CreatePanel';
import { icon } from './icons';
import { assetRootFor } from '../editor/revision';
import { Bone } from '../anim/armature';
import { constraintLabel } from '../anim/constraints';

type Tab = 'create' | 'object' | 'modifiers' | 'material' | 'world';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'create', label: 'Create', icon: 'reference' },
  { id: 'object', label: 'Object', icon: 'mesh' },
  { id: 'modifiers', label: 'Modifiers', icon: 'modifier' },
  { id: 'material', label: 'Material', icon: 'material' },
  { id: 'world', label: 'Scene', icon: 'world' },
];

/** The right-hand properties editor. Rebuilds on every change — it is small. */
export class Properties {
  readonly root = h('div', { class: 'panel properties' });
  private tab: Tab = 'object';
  private body = h('div', { class: 'prop-body' });
  private tabBar = h('div', { class: 'tab-bar' });
  /** Kept alive across refreshes so a loaded reference survives tab switches. */
  readonly create: CreatePanel;

  constructor(private editor: Editor) {
    this.create = new CreatePanel(editor);
    this.root.appendChild(this.tabBar);
    this.root.appendChild(this.body);
    this.buildTabs();
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private buildTabs(): void {
    clear(this.tabBar);
    for (const t of TABS) {
      this.tabBar.appendChild(h('button', {
        class: `tab${this.tab === t.id ? ' active' : ''}`,
        title: t.label,
        on: {
          click: () => {
            this.tab = t.id;
            this.buildTabs();
            this.refresh();
          },
        },
      }, [icon(t.icon), h('span', { text: t.label })]));
    }
  }

  /** Switch to the Create tab, optionally handing it a dropped file. */
  openCreate(file?: File): void {
    this.tab = 'create';
    this.buildTabs();
    this.refresh();
    if (file) void this.create.loadFile(file);
  }

  refresh(): void {
    clear(this.body);
    const obj = this.editor.scene.activeObject;
    switch (this.tab) {
      case 'create': this.body.appendChild(this.create.root); break;
      case 'object': this.buildObjectTab(obj); break;
      case 'modifiers': this.buildModifierTab(obj); break;
      case 'material': this.buildMaterialTab(obj); break;
      case 'world': this.buildWorldTab(); break;
    }
  }

  /**
   * The rules on one bone.
   *
   * Every constraint gets its target as a dropdown of bone names rather than a
   * typed string: a mistyped target is inert and looks exactly like a broken
   * rig, and there is no reason to make that possible.
   */
  private constraintSection(
    ed: Editor, obj: SceneObject, bone: Bone, boneIndex: number,
  ): HTMLElement {
    const bones = obj.armature?.bones ?? [];
    const names = [{ value: '', label: '— none —' },
      ...bones.filter((b) => b !== bone).map((b) => ({ value: b.name, label: b.name }))];
    const list = bone.constraints ?? [];

    const edit = (label: string, apply: () => void): void => {
      if (!ed.beginUndo(label)) return;
      apply();
      this.repose(ed, obj.id);
    };

    const rows: HTMLElement[] = [];
    list.forEach((c, i) => {
      const fields: (HTMLElement | null)[] = [
        h('div', { class: 'constraint-head' }, [
          h('span', { class: 'constraint-name', text: constraintLabel(c.type) }),
          h('button', {
            class: 'icon-btn', text: '✕', title: 'Remove this constraint',
            on: { click: () => ed.removeBoneConstraint(boneIndex, i) },
          }),
        ]),
        checkbox('Enabled', c.enabled !== false, (v) => edit('Constraint enabled', () => { c.enabled = v; })),
        row('Influence', numberField({
          label: '', value: c.influence ?? 1, step: 0.05, min: 0, max: 1, precision: 2,
          onChange: (v) => edit('Constraint influence', () => { c.influence = v; }),
        })),
      ];

      if ('target' in c) {
        fields.push(row('Target', select(names, c.target,
          (v) => edit('Constraint target', () => { (c as { target: string }).target = v; }))));
      }
      if (c.type === 'ik') {
        fields.push(row('Chain length', numberField({
          label: 'bones', value: c.chain, step: 1, min: 1, max: 64, precision: 0,
          onChange: (v) => edit('IK chain', () => { c.chain = Math.round(v); }),
        })));
        fields.push(row('Pole', select(names, c.pole ?? '',
          (v) => edit('IK pole', () => { if (v) c.pole = v; else delete c.pole; }))));
        fields.push(h('p', {
          class: 'dim small',
          text: 'Chain counts bones upwards from this one. A pole decides which way the joint bends.',
        }));
      }
      if (c.type === 'copyRotation' || c.type === 'copyLocation') {
        fields.push(row('Axes', h('div', { class: 'btn-row' }, (['X', 'Y', 'Z'] as const).map((axis, a) =>
          h('button', {
            class: `btn${(c.axes ?? [true, true, true])[a] ? ' primary' : ''}`, text: axis,
            on: {
              click: () => edit('Constraint axes', () => {
                const axes = [...(c.axes ?? [true, true, true])] as [boolean, boolean, boolean];
                axes[a] = !axes[a];
                c.axes = axes;
              }),
            },
          })))));
      }
      if (c.type === 'limitRotation') {
        const limit = (label: string, key: 'min' | 'max', fallback: number): HTMLElement =>
          row(label, h('div', { class: 'nf-group' }, [0, 1, 2].map((a) => numberField({
            label: ['x', 'y', 'z'][a], step: 5, precision: 1,
            value: ((c[key] ?? [fallback, fallback, fallback])[a]) * RAD2DEG,
            onChange: (v) => edit('Rotation limit', () => {
              const next = [...(c[key] ?? [fallback, fallback, fallback])] as [number, number, number];
              next[a] = v * DEG2RAD;
              c[key] = next;
            }),
          }))));
        fields.push(limit('Minimum', 'min', -Math.PI));
        fields.push(limit('Maximum', 'max', Math.PI));
      }
      rows.push(h('div', { class: 'constraint' }, fields.filter((f): f is HTMLElement => f !== null)));
    });

    return this.section(`Constraints — ${bone.name}`, [
      ...rows,
      list.length === 0
        ? h('p', { class: 'dim small', text: 'None. IK makes a chain reach a target bone; the rest copy, track or limit one.' })
        : null,
      h('div', { class: 'btn-row' }, [
        h('button', { class: 'btn primary', text: 'IK', title: 'Reach a target with a chain of bones', on: { click: () => runCommand(ed, 'rig.addIK') } }),
        h('button', { class: 'btn', text: 'Copy rot', on: { click: () => runCommand(ed, 'rig.addCopyRotation') } }),
        h('button', { class: 'btn', text: 'Track to', on: { click: () => runCommand(ed, 'rig.addTrackTo') } }),
        h('button', { class: 'btn', text: 'Limit', on: { click: () => runCommand(ed, 'rig.addLimitRotation') } }),
      ]),
      h('div', { class: 'btn-row' }, [
        h('button', {
          class: 'btn', text: 'Add control bone',
          title: 'An unparented bone that deforms nothing, for a constraint to aim at',
          on: { click: () => runCommand(ed, 'rig.addControlBone') },
        }),
      ]),
    ]);
  }

  /**
   * Actions laid onto the timeline.
   *
   * Order is the blend order, which is why the rows can be moved: a wave added
   * on top of a walk is not the same as a walk added on top of a wave.
   */
  private stripSection(ed: Editor, obj: SceneObject): HTMLElement {
    const options = obj.actions.map((a) => ({ value: a.id, label: a.name }));
    const edit = (label: string, apply: () => void): void => {
      if (!ed.beginUndo(label)) return;
      apply();
      ed.scene.setFrame(ed.scene.timeline.current);
      ed.requestRender();
      ed.emit('change');
    };

    const rows = obj.strips.map((strip, i) => h('div', { class: 'constraint' }, [
      h('div', { class: 'constraint-head' }, [
        h('span', {
          class: 'constraint-name',
          text: obj.actions.find((a) => a.id === strip.action)?.name ?? 'Missing action',
        }),
        h('button', {
          class: 'icon-btn', text: '✕', title: 'Remove this strip',
          on: { click: () => ed.removeStrip(i) },
        }),
      ]),
      row('Action', select(options, strip.action, (v) => edit('Strip action', () => { strip.action = v; }))),
      row('Frames', h('div', { class: 'nf-group' }, [
        numberField({
          label: 'from', value: strip.start, step: 1, precision: 0,
          onChange: (v) => edit('Strip start', () => { strip.start = Math.round(v); }),
        }),
        numberField({
          label: 'to', value: strip.end, step: 1, precision: 0,
          onChange: (v) => edit('Strip end', () => { strip.end = Math.round(v); }),
        }),
      ])),
      row('Blend', select(
        [{ value: 'replace', label: 'Replace' }, { value: 'add', label: 'Add on top' }],
        strip.blend,
        (v) => edit('Strip blend', () => { strip.blend = v === 'add' ? 'add' : 'replace'; }),
      )),
      row('Weight', numberField({
        label: '', value: strip.weight, step: 0.05, min: 0, max: 1, precision: 2,
        onChange: (v) => edit('Strip weight', () => { strip.weight = v; }),
      })),
      row('Fade', h('div', { class: 'nf-group' }, [
        numberField({
          label: 'in', value: strip.fadeIn, step: 1, min: 0, precision: 0,
          onChange: (v) => edit('Strip fade in', () => { strip.fadeIn = Math.max(0, v); }),
        }),
        numberField({
          label: 'out', value: strip.fadeOut, step: 1, min: 0, precision: 0,
          onChange: (v) => edit('Strip fade out', () => { strip.fadeOut = Math.max(0, v); }),
        }),
      ])),
      row('Speed', numberField({
        label: '×', value: strip.scale, step: 0.1, precision: 2,
        onChange: (v) => edit('Strip speed', () => { strip.scale = v || 1; }),
      })),
      checkbox('Loop the action', !!strip.loop, (v) => edit('Strip loop', () => { strip.loop = v; })),
      checkbox('Enabled', strip.enabled !== false, (v) => edit('Strip enabled', () => { strip.enabled = v; })),
    ]));

    return this.section('Actions', [
      ...obj.actions.map((a) => h('div', { class: 'outliner-row' }, [
        h('span', { class: 'outliner-name', text: a.name }),
        h('span', { class: 'outliner-badge', text: `${a.channels.length} ch` }),
      ])),
      ...rows,
      obj.strips.length === 0
        ? h('p', {
          class: 'dim small',
          text: 'This object plays its own keys. Add a strip to play a stashed action instead, '
            + 'or several to blend them.',
        })
        : null,
      h('div', { class: 'btn-row' }, [
        h('button', { class: 'btn', text: 'Stash keys', title: 'Keep the current keys as a named action', on: { click: () => runCommand(ed, 'anim.stashAction') } }),
        h('button', { class: 'btn primary', text: 'Add strip', on: { click: () => runCommand(ed, 'anim.addStrip') } }),
        obj.strips.length
          ? h('button', { class: 'btn', text: 'Clear', on: { click: () => runCommand(ed, 'anim.clearStrips') } })
          : null,
      ].filter((b) => b !== null) as HTMLElement[]),
    ]);
  }

  private section(title: string, children: (HTMLElement | null)[]): HTMLElement {
    return h('section', { class: 'prop-section' }, [
      h('h3', { class: 'prop-heading', text: title }),
      ...children,
    ]);
  }

  private emptyState(message: string, hint: string): HTMLElement {
    return h('div', { class: 'empty-state' }, [
      h('p', { text: message }),
      h('p', { class: 'dim', text: hint }),
    ]);
  }

  // ------------------------------------------------------------------ object

  private buildObjectTab(obj: SceneObject | null): void {
    if (!obj) {
      this.body.appendChild(this.emptyState(
        'No active object.',
        'Click an object in the viewport or the outliner to edit it.',
      ));
      return;
    }
    const ed = this.editor;

    const nameInput = h('input', { class: 'text-input', value: obj.name, type: 'text' });
    nameInput.addEventListener('change', () => {
      if (!ed.beginUndo('Rename object')) return;
      obj.name = nameInput.value.trim() || obj.name;
      ed.emit('change');
    });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());

    const identity: (HTMLElement | null)[] = [
      row('Name', nameInput),
      checkbox('Visible in viewport', obj.visible, (v) => {
        if (!ed.beginUndo('Toggle visibility')) return;
        obj.visible = v;
        ed.requestRender();
        ed.emit('change');
      }),
    ];

    // Only offered where it can mean something. On an object no generator will
    // ever touch, a "protect from regeneration" switch is a promise about
    // nothing, and a control that does nothing teaches people to distrust the
    // ones that do.
    const asset = assetRootFor(ed.scene, obj);
    if (asset) {
      identity.push(checkbox('Protect from regeneration', obj.protectedFromRegen, (v) => {
        if (!ed.beginUndo(v ? 'Protect part' : 'Unprotect part')) return;
        obj.protectedFromRegen = v;
        ed.emit('change');
      }));
      const prov = asset.provenance!;
      const how = prov.generator.replace(/^recipe:/, 'the ').replace(/^recipe$/, 'a recipe')
        + (prov.generator.startsWith('recipe:') ? ' recipe' : '');
      const made = obj === asset
        ? `Built by ${how}${prov.prompt ? ` from "${prov.prompt}"` : ''}.`
        : `Part of "${asset.name}", built by ${how}.`;
      const revised = prov.revision > 0
        ? ` Revised ${prov.revision} time${prov.revision === 1 ? '' : 's'}.`
        : '';
      const missing = prov.reference?.missing
        ? ` The picture it came from (${prov.reference.name}) is not stored in this file, so it cannot be rebuilt.`
        : '';
      identity.push(h('p', { class: 'dim small', text: `${made}${revised}${missing}` }));
    }
    this.body.appendChild(this.section('Identity', identity.filter((e): e is HTMLElement => e !== null)));

    const vectorRow = (
      label: string, get: () => Vec3, set: (v: Vec3) => void, step: number, scale = 1,
    ): HTMLElement => {
      const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
      const fields = axes.map((axis) => numberField({
        label: axis.toUpperCase(),
        value: get()[axis] * scale,
        step,
        axis,
        onLive: (value) => {
          const v = get().clone();
          v[axis] = value / scale;
          set(v);
          ed.requestRender();
        },
        onChange: (value) => {
          if (!ed.beginUndo(`Set ${label.toLowerCase()}`)) return;
          const v = get().clone();
          v[axis] = value / scale;
          set(v);
          ed.requestRender();
          ed.emit('change');
        },
      }));
      return h('div', { class: 'prop-vector' }, [
        h('label', { class: 'prop-label', text: label }),
        h('div', { class: 'nf-group' }, fields),
      ]);
    };

    this.body.appendChild(this.section('Transform', [
      vectorRow('Location', () => obj.position, (v) => { obj.position = v; }, 0.01),
      vectorRow('Rotation', () => obj.rotation, (v) => { obj.rotation = v; }, 0.5, RAD2DEG),
      vectorRow('Scale', () => obj.scale, (v) => { obj.scale = v; }, 0.01),
    ]));

    if (obj.type === 'mesh' && obj.mesh) {
      const evaluated = obj.evaluated();
      this.body.appendChild(this.section('Mesh', [
        h('div', { class: 'stat-grid' }, [
          h('span', { text: 'Vertices' }), h('b', { text: `${obj.mesh.vertCount}` }),
          h('span', { text: 'Edges' }), h('b', { text: `${obj.mesh.edgeCount}` }),
          h('span', { text: 'Faces' }), h('b', { text: `${obj.mesh.faceCount}` }),
          h('span', { text: 'Evaluated tris' }), h('b', { text: `${evaluated?.triCount ?? 0}` }),
        ]),
        h('div', { class: 'btn-row' }, [
          button('Shade Smooth', () => {
            if (!ed.beginUndo('Shade smooth')) return;
            obj.mesh?.setAllSmooth(true);
            ed.markGeometryDirty(obj);
          }),
          button('Shade Flat', () => {
            if (!ed.beginUndo('Shade flat')) return;
            obj.mesh?.setAllSmooth(false);
            ed.markGeometryDirty(obj);
          }),
        ]),
      ]));
    }

    if (obj.type === 'light' && obj.light) {
      const light = obj.light;
      this.body.appendChild(this.section('Light', [
        row('Type', select(
          (['point', 'sun', 'spot', 'area'] as LightType[]).map((t) => ({ value: t, label: t })),
          light.type,
          (v) => {
            if (!ed.beginUndo('Change light type')) return;
            light.type = v as LightType;
            ed.requestRender();
            ed.emit('change');
          },
        )),
        row('Colour', this.colorInput(light.color, (c) => {
          light.color = c;
          ed.requestRender();
        })),
        row('Power', numberField({
          label: 'W', value: light.energy, step: 5, precision: 1, min: 0,
          onLive: (v) => { light.energy = v; ed.requestRender(); },
          onChange: (v) => { light.energy = v; ed.requestRender(); ed.emit('change'); },
        })),
        light.type === 'spot' ? row('Cone', numberField({
          label: '°', value: light.spotAngle * RAD2DEG, step: 1, precision: 1, min: 1, max: 89,
          onLive: (v) => { light.spotAngle = v * DEG2RAD; ed.requestRender(); },
          onChange: (v) => { light.spotAngle = v * DEG2RAD; ed.requestRender(); ed.emit('change'); },
        })) : null,
      ]));
    }

    if (obj.type === 'mesh' && obj.physics) {
      const body = obj.physics;
      const passive = body.kind === 'passive';
      this.body.appendChild(this.section('Rigid Body', [
        row('Kind', select(
          [{ value: 'active', label: 'Active — falls' }, { value: 'passive', label: 'Passive — held still' }],
          body.kind,
          (v) => {
            if (!ed.beginUndo('Rigid body kind')) return;
            body.kind = v === 'passive' ? 'passive' : 'active';
            body.mass = body.kind === 'passive' ? 0 : Math.max(0.001, body.mass || 1);
            ed.emit('change');
          },
        )),
        row('Shape', select(
          [{ value: 'box', label: 'Box' }, { value: 'sphere', label: 'Sphere' }],
          body.shape,
          (v) => {
            if (!ed.beginUndo('Rigid body shape')) return;
            body.shape = v === 'sphere' ? 'sphere' : 'box';
            ed.emit('change');
          },
        )),
        ...(passive ? [] : [row('Mass', numberField({
          label: 'kg', value: body.mass, step: 0.1, min: 0.001, precision: 3,
          onChange: (v) => { body.mass = v; ed.emit('change'); },
        }))]),
        row('Friction', numberField({
          label: '', value: body.friction, step: 0.05, min: 0, max: 1, precision: 2,
          onChange: (v) => { body.friction = v; ed.emit('change'); },
        })),
        row('Bounce', numberField({
          label: '', value: body.restitution, step: 0.05, min: 0, max: 1, precision: 2,
          onChange: (v) => { body.restitution = v; ed.emit('change'); },
        })),
        h('div', { class: 'btn-row' }, [
          h('button', { class: 'btn primary', text: 'Bake', on: { click: () => runCommand(ed, 'physics.bake') } }),
          h('button', { class: 'btn', text: 'Clear bake', on: { click: () => runCommand(ed, 'physics.clearBake') } }),
          h('button', { class: 'btn', text: 'Remove', on: { click: () => runCommand(ed, 'physics.remove') } }),
        ]),
        h('p', {
          class: 'dim small',
          text: 'Baking writes the simulation to keyframes over the timeline range and replaces any location or rotation animation on these objects.',
        }),
      ]));
    }

    if (obj.type === 'armature' && obj.armature) {
      const arm = obj.armature;
      const rows: HTMLElement[] = [];
      arm.bones.forEach((bone, i) => {
        const active = i === ed.activeBone;
        rows.push(h('div', { class: `slot${active ? ' active' : ''}` }, [
          h('button', {
            class: 'outliner-name', text: bone.name,
            title: bone.parent >= 0 ? `Child of ${arm.bones[bone.parent]?.name ?? '?'}` : 'Root bone',
            on: {
              click: () => {
                ed.activeBone = i;
                ed.emit('change');
                ed.requestRender();
              },
            },
          }),
          h('span', { class: 'outliner-badge', text: bone.parent >= 0 ? `→${bone.parent}` : 'root' }),
        ]));
      });
      this.body.appendChild(this.section('Bones', [
        h('div', { class: 'slot-list' }, rows),
        h('div', { class: 'btn-row' }, [
          h('button', { class: 'btn', text: 'Add bone', on: { click: () => runCommand(ed, 'rig.extrudeBone') } }),
          h('button', { class: 'btn', text: 'Clear pose', on: { click: () => runCommand(ed, 'rig.clearPose') } }),
        ]),
        h('p', {
          class: 'dim small',
          text: 'Select the armature and the meshes, then Rig → Bind to give them automatic weights.',
        }),
      ]));

      const bone = arm.bones[Math.min(ed.activeBone, arm.bones.length - 1)];
      if (bone) {
        const vec = (
          label: string, get: () => [number, number, number], set: (v: [number, number, number]) => void,
          step: number,
        ): HTMLElement => row(label, h('div', { class: 'nf-group' }, (['x', 'y', 'z'] as const).map((axis, a) =>
          numberField({
            label: axis, value: get()[a], step, precision: 3,
            onChange: (v) => {
              if (!ed.beginUndo(`Bone ${label.toLowerCase()}`)) return;
              const next = [...get()] as [number, number, number];
              next[a] = v;
              set(next);
              this.repose(ed, obj.id);
            },
          }))));
        this.body.appendChild(this.section(`Bone — ${bone.name}`, [
          vec('Head', () => bone.head, (v) => { bone.head = v; }, 0.05),
          vec('Tail', () => bone.tail, (v) => { bone.tail = v; }, 0.05),
          vec('Pose rotation', () => bone.rotation.map((r) => r * RAD2DEG) as [number, number, number],
            (v) => { bone.rotation = v.map((d) => d * DEG2RAD) as [number, number, number]; }, 5),
          vec('Pose offset', () => bone.position, (v) => { bone.position = v; }, 0.05),
          row('Envelope', numberField({
            label: '', value: bone.envelope, step: 0.05, min: 0, precision: 3,
            onChange: (v) => {
              if (!ed.beginUndo('Bone envelope')) return;
              bone.envelope = v;
              this.repose(ed, obj.id);
            },
          })),
          h('p', { class: 'dim small', text: 'Envelope 0 works it out from the bone length.' }),
        ]));

        this.body.appendChild(this.constraintSection(ed, obj, bone, arm.bones.indexOf(bone)));
      }
    }

    if (obj.actions.length || obj.strips.length) {
      this.body.appendChild(this.stripSection(ed, obj));
    }

    if (obj.type === 'camera' && obj.camera) {
      const cam = obj.camera;
      this.body.appendChild(this.section('Camera', [
        row('Focal FOV', numberField({
          label: '°', value: cam.fov * RAD2DEG, step: 1, precision: 1, min: 5, max: 160,
          onLive: (v) => { cam.fov = v * DEG2RAD; ed.requestRender(); },
          onChange: (v) => { cam.fov = v * DEG2RAD; ed.requestRender(); ed.emit('change'); },
        })),
        row('Clip start', numberField({
          label: 'm', value: cam.near, step: 0.01, min: 0.001,
          onChange: (v) => { cam.near = v; ed.requestRender(); },
        })),
        row('Clip end', numberField({
          label: 'm', value: cam.far, step: 10, min: 1,
          onChange: (v) => { cam.far = v; ed.requestRender(); },
        })),
        row('Aperture', numberField({
          label: 'm', value: cam.aperture ?? 0, step: 0.005, precision: 3, min: 0,
          onChange: (v) => { cam.aperture = v; ed.requestRender(); ed.emit('change'); },
        })),
        row('Focus distance', numberField({
          label: 'm', value: cam.focusDistance ?? 8, step: 0.1, precision: 2, min: 0.01,
          onChange: (v) => { cam.focusDistance = v; ed.requestRender(); ed.emit('change'); },
        })),
        h('p', {
          class: 'dim small',
          text: 'An aperture above zero blurs everything off the focus distance, in a full render (F12).',
        }),
      ]));
    }
  }

  /** Re-evaluate anything bound to this rig, so the viewport follows the edit. */
  private repose(ed: Editor, rigId: number): void {
    for (const o of ed.scene.objects.values()) {
      if (o.modifiers.some((m) => m.type === 'armature' && m.objectId === rigId)) {
        o.invalidate();
        ed.markGeometryDirty(o);
      }
    }
    ed.requestRender();
    ed.emit('change');
  }

  private colorInput(
    color: [number, number, number], onChange: (c: [number, number, number]) => void,
  ): HTMLElement {
    const input = h('input', { type: 'color', class: 'color-input', value: linearToHex(color) });
    input.addEventListener('input', () => onChange(hexToLinear(input.value)));
    return input;
  }

  // --------------------------------------------------------------- modifiers

  private buildModifierTab(obj: SceneObject | null): void {
    if (!obj || obj.type !== 'mesh') {
      this.body.appendChild(this.emptyState(
        'Modifiers apply to mesh objects.',
        'Select a mesh to build a non-destructive stack.',
      ));
      return;
    }
    const ed = this.editor;

    const addSelect = select(
      [{ value: '', label: 'Add Modifier…' },
        ...(Object.keys(MODIFIER_LABELS) as ModifierType[]).map((t) => ({ value: t, label: MODIFIER_LABELS[t] }))],
      '',
      (v) => {
        if (!v) return;
        if (!ed.beginUndo(`Add ${v} modifier`)) return;
        obj.modifiers.push(createModifier(v as ModifierType));
        ed.markGeometryDirty(obj);
        addSelect.value = '';
      },
    );
    this.body.appendChild(h('div', { class: 'prop-section' }, [addSelect]));

    if (obj.modifiers.length === 0) {
      this.body.appendChild(this.emptyState(
        'The stack is empty.',
        'Modifiers evaluate top to bottom and never touch your original mesh.',
      ));
      return;
    }

    obj.modifiers.forEach((mod, index) => {
      this.body.appendChild(this.modifierCard(obj, mod, index));
    });
  }

  private modifierCard(obj: SceneObject, mod: Modifier, index: number): HTMLElement {
    const ed = this.editor;
    const update = (label: string): void => {
      if (!ed.beginUndo(label)) return;
      ed.markGeometryDirty(obj);
    };
    const live = (): void => {
      obj.invalidate();
      ed.renderer.invalidate(obj.id);
      ed.requestRender();
    };

    const header = h('div', { class: 'mod-header' }, [
      icon('modifier'),
      h('span', { class: 'mod-name', text: mod.name }),
      h('button', {
        class: `icon-btn small${mod.enabled ? '' : ' off'}`, title: 'Enable in viewport',
        on: { click: () => { update('Toggle modifier'); mod.enabled = !mod.enabled; ed.markGeometryDirty(obj); } },
      }, [icon(mod.enabled ? 'eye' : 'eyeOff')]),
      h('button', {
        class: 'icon-btn small', title: 'Move up', disabled: index === 0,
        on: {
          click: () => {
            update('Reorder modifiers');
            const [m] = obj.modifiers.splice(index, 1);
            obj.modifiers.splice(index - 1, 0, m);
            ed.markGeometryDirty(obj);
          },
        },
      }, [h('span', { text: '↑' })]),
      h('button', {
        class: 'icon-btn small', title: 'Move down', disabled: index === obj.modifiers.length - 1,
        on: {
          click: () => {
            update('Reorder modifiers');
            const [m] = obj.modifiers.splice(index, 1);
            obj.modifiers.splice(index + 1, 0, m);
            ed.markGeometryDirty(obj);
          },
        },
      }, [h('span', { text: '↓' })]),
      h('button', {
        class: 'icon-btn small danger', title: 'Remove modifier',
        on: {
          click: () => {
            update('Remove modifier');
            obj.modifiers.splice(index, 1);
            ed.markGeometryDirty(obj);
          },
        },
      }, [icon('del')]),
    ]);

    const body = h('div', { class: 'mod-body' });
    const num = (
      label: string, value: number, step: number, set: (v: number) => void,
      opts: { min?: number; max?: number; precision?: number } = {},
    ): HTMLElement => row(label, numberField({
      label: '', value, step, precision: opts.precision ?? 3, min: opts.min, max: opts.max,
      onLive: (v) => { set(v); live(); },
      onChange: (v) => { update(`Set ${label.toLowerCase()}`); set(v); ed.markGeometryDirty(obj); },
    }));

    switch (mod.type) {
      case 'subsurf':
        body.appendChild(num('Levels', mod.levels, 1, (v) => { mod.levels = Math.round(v); }, { min: 0, max: 4, precision: 0 }));
        body.appendChild(checkbox('Show in Edit Mode', mod.showInEdit, (v) => {
          update('Toggle edit-mode display');
          mod.showInEdit = v;
          ed.markGeometryDirty(obj);
        }));
        break;
      case 'mirror': {
        const axisRow = h('div', { class: 'btn-row' }, (['X', 'Y', 'Z'] as const).map((axis, i) =>
          h('button', {
            class: `btn toggle${mod.axis[i] ? ' on' : ''}`,
            text: axis,
            on: {
              click: () => {
                update('Toggle mirror axis');
                mod.axis[i] = !mod.axis[i];
                ed.markGeometryDirty(obj);
              },
            },
          })));
        body.appendChild(row('Axis', axisRow));
        body.appendChild(checkbox('Merge at centre', mod.merge, (v) => {
          update('Toggle mirror merge');
          mod.merge = v;
          ed.markGeometryDirty(obj);
        }));
        body.appendChild(num('Threshold', mod.mergeThreshold, 0.001, (v) => { mod.mergeThreshold = v; }, { min: 0, precision: 4 }));
        break;
      }
      case 'array':
        body.appendChild(num('Count', mod.count, 1, (v) => { mod.count = Math.max(1, Math.round(v)); }, { min: 1, precision: 0 }));
        body.appendChild(row('Relative offset', h('div', { class: 'nf-group' },
          (['x', 'y', 'z'] as const).map((axis, i) => numberField({
            label: axis.toUpperCase(), value: mod.relativeOffset[i], step: 0.05, axis,
            onLive: (v) => { mod.relativeOffset[i] = v; live(); },
            onChange: (v) => { update('Set array offset'); mod.relativeOffset[i] = v; ed.markGeometryDirty(obj); },
          })))));
        body.appendChild(checkbox('Merge ends', mod.mergeEnds, (v) => {
          update('Toggle array merge');
          mod.mergeEnds = v;
          ed.markGeometryDirty(obj);
        }));
        break;
      case 'solidify':
        body.appendChild(num('Thickness', mod.thickness, 0.01, (v) => { mod.thickness = v; }));
        body.appendChild(num('Offset', mod.offset, 0.1, (v) => { mod.offset = v; }, { min: -1, max: 1 }));
        break;
      case 'weld':
        body.appendChild(num('Distance', mod.distance, 0.001, (v) => { mod.distance = Math.max(1e-6, v); }, { precision: 4 }));
        break;
      case 'smooth':
        body.appendChild(num('Factor', mod.factor, 0.05, (v) => { mod.factor = v; }, { min: 0, max: 1 }));
        body.appendChild(num('Repeat', mod.iterations, 1, (v) => { mod.iterations = Math.round(v); }, { min: 1, max: 20, precision: 0 }));
        break;
      case 'triangulate':
        body.appendChild(h('p', { class: 'dim small', text: 'Converts every n-gon to triangles at render time.' }));
        break;
      case 'boolean': {
        const others = [...ed.scene.objects.values()]
          .filter((o) => o.type === 'mesh' && o.id !== obj.id)
          .map((o) => ({ value: String(o.id), label: o.name }));
        body.appendChild(row('Operation', select(
          [
            { value: 'difference', label: 'Difference' },
            { value: 'union', label: 'Union' },
            { value: 'intersect', label: 'Intersect' },
          ],
          mod.operation,
          (v) => {
            update('Set boolean operation');
            mod.operation = v as typeof mod.operation;
            ed.markGeometryDirty(obj);
          },
        )));
        body.appendChild(row('Cutter', select(
          [{ value: '', label: '— none —' }, ...others],
          mod.objectId === null ? '' : String(mod.objectId),
          (v) => {
            update('Set boolean cutter');
            mod.objectId = v === '' ? null : Number(v);
            ed.markGeometryDirty(obj);
          },
        )));
        if (others.length === 0) {
          body.appendChild(h('p', { class: 'dim small', text: 'Add another mesh object to cut with.' }));
        }
        break;
      }
      case 'decimate': {
        body.appendChild(num('Ratio', mod.ratio, 0.02, (v) => {
          mod.ratio = Math.max(0.01, Math.min(1, v));
        }, { min: 0.01, max: 1 }));
        body.appendChild(checkbox('Keep open borders', mod.preserveBorder, (v) => {
          update('Toggle border preservation');
          mod.preserveBorder = v;
          ed.markGeometryDirty(obj);
        }));
        const evaluated = obj.evaluated(false);
        body.appendChild(h('p', {
          class: 'dim small',
          text: `${obj.mesh?.triCount ?? 0} → ${evaluated?.triCount ?? 0} triangles`,
        }));
        break;
      }
      case 'bevel':
        body.appendChild(num('Width', mod.width, 0.005, (v) => { mod.width = Math.max(0, v); }, { min: 0, precision: 4 }));
        body.appendChild(num('Segments', mod.segments, 1, (v) => {
          mod.segments = Math.max(1, Math.min(16, Math.round(v)));
        }, { min: 1, max: 16, precision: 0 }));
        body.appendChild(num('Profile', mod.profile, 0.05, (v) => {
          mod.profile = Math.max(0, Math.min(1, v));
        }, { min: 0, max: 1 }));
        body.appendChild(num('Angle limit', mod.angleLimit, 1, (v) => {
          mod.angleLimit = Math.max(0, Math.min(180, v));
        }, { min: 0, max: 180, precision: 0 }));
        break;
    }

    body.appendChild(h('div', { class: 'btn-row' }, [
      button('Apply', () => {
        const mesh = obj.mesh;
        if (!mesh) return;
        update('Apply modifier');
        const applied = obj.evaluated(false);
        if (applied) {
          obj.mesh = applied.clone();
          obj.modifiers.splice(index, 1);
        }
        ed.markGeometryDirty(obj);
      }, { title: 'Bake this modifier into the mesh' }),
    ]));

    return h('div', { class: `mod-card${mod.enabled ? '' : ' disabled'}` }, [header, body]);
  }

  // ---------------------------------------------------------------- material

  private buildMaterialTab(obj: SceneObject | null): void {
    const ed = this.editor;
    const scene = ed.scene;
    if (!obj || obj.type !== 'mesh') {
      this.body.appendChild(this.emptyState(
        'Materials belong to mesh objects.',
        'Select a mesh to edit its slots.',
      ));
      return;
    }
    if (obj.materialSlots.length === 0) obj.materialSlots.push(scene.ensureDefaultMaterial());

    const slots = h('div', { class: 'slot-list' }, obj.materialSlots.map((matIndex, slot) => {
      const mat = scene.materials[matIndex];
      return h('div', {
        class: `slot${slot === 0 ? ' active' : ''}`,
      }, [
        h('span', { class: 'swatch', style: { background: linearToHex(mat?.color ?? [1, 0, 1]) } }),
        h('span', { text: mat?.name ?? 'Missing' }),
      ]);
    }));

    this.body.appendChild(this.section('Slots', [
      slots,
      h('div', { class: 'btn-row' }, [
        button('New Material', () => {
          if (!ed.beginUndo('New material')) return;
          const idx = scene.addMaterial(createMaterial());
          obj.materialSlots = [idx];
          ed.requestRender();
          ed.emit('change');
        }),
      ]),
    ]));

    const mat = scene.materials[obj.materialSlots[0]];
    if (!mat) return;
    const live = (): void => ed.requestRender();

    const nameInput = h('input', { class: 'text-input', value: mat.name, type: 'text' });
    nameInput.addEventListener('change', () => {
      if (!ed.beginUndo('Rename material')) return;
      mat.name = nameInput.value || mat.name;
      ed.emit('change');
    });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());

    this.body.appendChild(this.section('Surface', [
      row('Name', nameInput),
      row('Base colour', this.colorInput(mat.color, (c) => { mat.color = c; live(); })),
      row('Metallic', numberField({
        label: '', value: mat.metallic, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.metallic = v; live(); },
        onChange: (v) => { mat.metallic = v; live(); ed.emit('change'); },
      })),
      row('Roughness', numberField({
        label: '', value: mat.roughness, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.roughness = v; live(); },
        onChange: (v) => { mat.roughness = v; live(); ed.emit('change'); },
      })),
      row('Alpha', numberField({
        label: '', value: mat.alpha, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.alpha = v; live(); },
        onChange: (v) => { mat.alpha = v; live(); ed.emit('change'); },
      })),
      row('Transmission', numberField({
        label: '', value: mat.transmission, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.transmission = v; live(); },
        onChange: (v) => { mat.transmission = v; live(); ed.emit('change'); },
      })),
      row('IOR', numberField({
        label: '', value: mat.ior, step: 0.01, min: 1, max: 3,
        onLive: (v) => { mat.ior = v; live(); },
        onChange: (v) => { mat.ior = v; live(); ed.emit('change'); },
      })),
      row('Emission', this.colorInput(mat.emission, (c) => { mat.emission = c; live(); })),
      row('Emission strength', numberField({
        label: '', value: mat.emissionStrength, step: 0.1, min: 0,
        onLive: (v) => { mat.emissionStrength = v; live(); },
        onChange: (v) => { mat.emissionStrength = v; live(); ed.emit('change'); },
      })),
      h('p', {
        class: 'dim small',
        text: 'Transmission and emission are traced in a full render (F12); the viewport approximates them.',
      }),
      h('p', { class: 'dim small', text: 'Material shading shows in the Material and Rendered viewport modes (press Z).' }),
    ]));

    const textureOptions = [
      { value: '', label: '— none —' },
      ...scene.textures.map((t) => ({ value: String(t.id), label: t.name })),
    ];
    const preview = scene.textures.find((t) => t.id === mat.baseColorTexture);
    this.body.appendChild(this.section('Texture', [
      row('Base colour map', select(textureOptions, mat.baseColorTexture === null ? '' : String(mat.baseColorTexture), (v) => {
        if (!ed.beginUndo('Set texture')) return;
        mat.baseColorTexture = v === '' ? null : Number(v);
        ed.requestRender();
        ed.emit('change');
      })),
      preview ? h('img', { class: 'tex-preview', value: '' , title: preview.name }) as HTMLElement : null,
      row('Tiling', h('div', { class: 'nf-group' }, (['x', 'y'] as const).map((axis, i) => numberField({
        label: axis.toUpperCase(), value: mat.uvScale[i], step: 0.05, axis,
        onLive: (v) => { mat.uvScale[i] = v; live(); },
        onChange: (v) => { mat.uvScale[i] = v; live(); ed.emit('change'); },
      })))),
      row('Offset', h('div', { class: 'nf-group' }, (['x', 'y'] as const).map((axis, i) => numberField({
        label: axis.toUpperCase(), value: mat.uvOffset[i], step: 0.01, axis,
        onLive: (v) => { mat.uvOffset[i] = v; live(); },
        onChange: (v) => { mat.uvOffset[i] = v; live(); ed.emit('change'); },
      })))),
      h('div', { class: 'btn-row' }, [
        button('Add checker', () => runCommand(ed, 'material.checker')),
        button('Load image…', () => runCommand(ed, 'material.loadTexture')),
      ]),
      obj.mesh && !obj.mesh.hasUV
        ? h('p', { class: 'dim small', text: 'This mesh has no UVs yet — unwrap it in Edit Mode (U) before texturing.' })
        : null,
    ].filter(Boolean) as HTMLElement[]));
    if (preview) {
      const img = this.body.querySelector('.tex-preview') as HTMLImageElement | null;
      if (img) img.src = preview.url;
    }
  }

  // ------------------------------------------------------------------- world

  private buildWorldTab(): void {
    const ed = this.editor;
    const world = ed.scene.world;
    const stats = ed.scene.stats();

    this.body.appendChild(this.section('World', [
      row('Background', this.colorInput(world.background, (c) => {
        world.background = c;
        ed.requestRender();
      })),
      row('Ambient', numberField({
        label: '', value: world.ambient, step: 0.01, min: 0, max: 2,
        onLive: (v) => { world.ambient = v; ed.requestRender(); },
        onChange: (v) => { world.ambient = v; ed.requestRender(); ed.emit('change'); },
      })),
      row('Sky', numberField({
        label: '', value: world.sky, step: 0.02, min: 0, max: 4,
        onLive: (v) => { world.sky = v; },
        onChange: (v) => { world.sky = v; ed.emit('change'); },
      })),
      h('p', { class: 'dim small', text: 'Sky lights a path-traced render and shows behind it. Ambient is the viewport fill.' }),
      h('div', { class: 'btn-row' }, [
        button('Render image', () => runCommand(ed, 'render.image')),
      ]),
    ]));

    this.body.appendChild(this.section('Viewport', [
      checkbox('Grid floor', ed.options.showGrid, (v) => { ed.options.showGrid = v; ed.requestRender(); }),
      checkbox('Overlays', ed.options.showOverlays, (v) => { ed.options.showOverlays = v; ed.requestRender(); }),
      checkbox('Object wireframes', ed.options.showObjectWireframe, (v) => {
        ed.options.showObjectWireframe = v;
        for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
        ed.requestRender();
      }),
      checkbox('Backface culling', ed.options.backfaceCulling, (v) => {
        ed.options.backfaceCulling = v;
        ed.requestRender();
      }),
      checkbox('X-ray', ed.options.xray, (v) => { ed.options.xray = v; ed.requestRender(); }),
      checkbox('Orthographic', ed.camera.orthographic, (v) => {
        ed.camera.orthographic = v;
        ed.requestRender();
      }),
    ]));

    this.body.appendChild(this.section('Statistics', [
      h('div', { class: 'stat-grid' }, [
        h('span', { text: 'Objects' }), h('b', { text: `${stats.objects}` }),
        h('span', { text: 'Vertices' }), h('b', { text: stats.verts.toLocaleString() }),
        h('span', { text: 'Edges' }), h('b', { text: stats.edges.toLocaleString() }),
        h('span', { text: 'Faces' }), h('b', { text: stats.faces.toLocaleString() }),
        h('span', { text: 'Triangles' }), h('b', { text: stats.tris.toLocaleString() }),
      ]),
    ]));
  }
}
