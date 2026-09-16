import { Editor } from '../editor/Editor';
import { ObjectDiff, summarise } from '../diff';
import { openTextFile } from '../io/files';
import { h } from './dom';

/**
 * Review what changed between this version of the model and another one.
 *
 * The version to compare against comes from wherever it is easiest to reach:
 * a step in the undo history, a crash-recovery slot, or a scene file on disk.
 * All three arrive as the same serialised scene, so the panel does not care
 * which was picked.
 *
 * The list here is the summary; the viewport is where the answer actually is.
 * Clicking an object frames it, because "twelve faces added" means very little
 * until you are looking at which twelve.
 */
export class DiffPanel {
  readonly root = h('div', { class: 'diff-panel hidden' });
  private sources = h('div', { class: 'diff-sources' });
  private body = h('div', { class: 'diff-body' });
  private headline = h('div', { class: 'diff-headline' });

  constructor(private editor: Editor) {
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'Compare Versions' }),
        h('button', {
          class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.hide() },
        }),
      ]),
      this.sources,
      this.headline,
      this.body,
      h('div', { class: 'diff-legend' }, [
        h('span', { class: 'diff-swatch diff-added' }),
        h('span', { text: 'added' }),
        h('span', { class: 'diff-swatch diff-moved' }),
        h('span', { text: 'moved' }),
        h('span', { class: 'diff-swatch diff-removed' }),
        h('span', { text: 'removed' }),
        h('span', { class: 'dim', text: '· click an object to frame it' }),
      ]),
    );

    editor.on('diff', () => this.refresh());
    // Editing while a comparison is open should update it, not stale it.
    editor.on('change', () => {
      if (this.visible && this.editor.comparison) this.editor.refreshComparison();
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.refresh();
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.editor.stopComparing();
  }

  // ------------------------------------------------------------------ render

  private refresh(): void {
    this.buildSources();
    const comparison = this.editor.comparison;
    if (!comparison) {
      this.headline.textContent = 'Pick a version to compare this one against.';
      this.body.replaceChildren();
      return;
    }
    const { diff, label } = comparison;
    this.headline.replaceChildren(
      h('strong', { text: `vs ${label}` }),
      h('span', { class: 'dim', text: ` — ${summarise(diff)}` }),
    );

    const rows: HTMLElement[] = diff.objects
      .filter((o) => o.status !== 'unchanged')
      .map((o) => this.row(o));

    // Said whether or not anything else is listed. "Every object is identical"
    // over an unread texture or an unevaluated modifier stack is a claim the
    // comparison has not earned, and it is exactly the kind of claim someone
    // acts on.
    for (const note of diff.notExamined) {
      rows.push(h('p', { class: 'diff-caveat', text: `Not compared: ${note}.` }));
    }
    if (diff.materialsChanged && !diff.objects.some((o) => o.materialValuesChanged)) {
      rows.push(h('p', { class: 'diff-caveat', text: 'The material list changed; no object uses the materials that differ.' }));
    }
    if (rows.length === 0) {
      this.body.replaceChildren(h('p', {
        class: 'dim',
        text: 'Identical in everything compared: geometry, transforms, materials, modifiers, '
          + 'visibility, animation, UVs, vertex colours, weights and seams.',
      }));
      return;
    }
    this.body.replaceChildren(...rows);
  }

  private row(entry: ObjectDiff): HTMLElement {
    const notes: string[] = [];
    if (entry.previousName) notes.push(`renamed from ${entry.previousName}`);
    if (entry.transformChanged) notes.push('moved');
    if (entry.materialChanged) notes.push('material slot');
    if (entry.materialValuesChanged) notes.push('material changed');
    if (entry.modifiersChanged) notes.push('modifiers');
    if (entry.visibilityChanged) notes.push('visibility');
    if (entry.animationChanged) notes.push('animation');
    if (entry.hierarchyChanged) notes.push('re-parented');
    if (entry.mesh?.attributes.uv) notes.push('UVs');
    if (entry.mesh?.attributes.colors) notes.push('vertex colours');
    if (entry.mesh?.attributes.skin) notes.push('weights');
    if (entry.mesh?.attributes.seams) notes.push('seams');
    if (entry.mesh?.attributes.smoothing) notes.push('smoothing');

    const mesh = entry.mesh;
    const counts: HTMLElement[] = [];
    if (mesh) {
      if (mesh.added) counts.push(h('span', { class: 'diff-count diff-added-text', text: `+${mesh.added}` }));
      if (mesh.removed) counts.push(h('span', { class: 'diff-count diff-removed-text', text: `−${mesh.removed}` }));
      if (mesh.moved) counts.push(h('span', { class: 'diff-count diff-moved-text', text: `~${mesh.moved}` }));
      if (mesh.vertsBefore !== mesh.vertsAfter) {
        const delta = mesh.vertsAfter - mesh.vertsBefore;
        counts.push(h('span', { class: 'dim', text: `${delta > 0 ? '+' : ''}${delta} verts` }));
      }
    }

    return h('div', {
      class: `diff-row diff-${entry.status}`,
      on: { click: () => this.frame(entry) },
    }, [
      h('span', { class: 'diff-status', text: entry.status[0].toUpperCase() }),
      h('span', { class: 'diff-name', text: entry.name }),
      ...counts,
      notes.length ? h('span', { class: 'dim diff-notes', text: notes.join(', ') }) : null,
      entry.uncertain
        ? h('span', { class: 'diff-uncertain', text: '?', title: `Uncertain: ${entry.uncertainty ?? 'this pairing may be wrong'}` })
        : null,
    ]);
  }

  /** Select the object and put the camera on it. */
  private frame(entry: ObjectDiff): void {
    const obj = this.editor.scene.get(entry.id);
    // A removed object is not there to select; the ghost outline is already
    // drawn where it stood, so the camera is left alone.
    if (!obj) return;
    this.editor.scene.selection = new Set([obj.id]);
    this.editor.scene.active = obj.id;
    this.editor.frameSelected();
  }

  // ----------------------------------------------------------------- sources

  private buildSources(): void {
    const steps = this.editor.history.steps();
    const controls: HTMLElement[] = [];

    if (steps.length > 0) {
      const select = h('select', { class: 'diff-select', title: 'A step in this session' });
      select.append(h('option', { value: '', text: `Undo history (${steps.length} steps)` }));
      // Newest first: "what did the last few operations do" is asked far more
      // often than "what has changed since I opened the file".
      for (const step of [...steps].reverse()) {
        const back = steps.length - step.index;
        select.append(h('option', {
          value: String(step.index),
          text: `${back} step${back === 1 ? '' : 's'} back — before ${step.label}`,
        }));
      }
      select.addEventListener('change', () => {
        const index = Number(select.value);
        if (select.value === '' || Number.isNaN(index)) return;
        const step = steps[index];
        if (!step) return;
        const back = steps.length - index;
        this.editor.compareAgainst(step.scene, `${back} step${back === 1 ? '' : 's'} back`);
        select.value = '';
      });
      controls.push(select);
    }

    controls.push(h('button', {
      class: 'btn', text: 'A file…', title: 'Compare against a scene saved on disk',
      on: { click: () => void this.compareWithFile() },
    }));

    if (this.editor.comparison) {
      controls.push(h('button', {
        class: 'btn', text: 'Stop', title: 'Close the comparison and un-tint the viewport',
        on: { click: () => this.editor.stopComparing() },
      }));
    }
    this.sources.replaceChildren(...controls);
  }

  private async compareWithFile(): Promise<void> {
    const file = await openTextFile('.mixer,.culpmixer,.kiln,application/json');
    if (!file) return;
    try {
      const parsed = JSON.parse(file.text);
      this.editor.compareAgainst(parsed, file.name);
    } catch {
      this.editor.setStatus(`${file.name} is not a scene this can read`);
    }
  }
}
