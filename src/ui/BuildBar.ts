import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { BuildOrigin, captureBaseline, describePlan, executePlan, recordProvenance } from '../build/plan';
import { interpret, knownSubjects } from '../build/interpreter';
import { LLMConfig, generateProgram, loadConfig } from '../build/llm';
import { DEFAULT_LIMITS, RunResult, runProgramSandboxed } from '../build/sandbox';
import { generateProgram as writeProgram } from '../build/llm';
import {
  identifiedParts, parseRevision, programRevisionPrompt, proposedFromParts, rebuildRecipe,
  revisableSettings,
} from '../build/revise';
import { assetFingerprint, assetRootFor, revisability } from '../editor/revision';
import { SceneObject } from '../scene/Scene';
import { button, h } from './dom';

/**
 * Say what you want; get geometry.
 *
 * The built-in interpreter answers first because it is instant, offline and
 * free. A local model only gets asked when the interpreter does not recognise
 * the request — so the common cases never depend on anyone's server being up.
 */
export class BuildBar {
  readonly root = h('div', { class: 'build-bar' });

  private input = h('input', {
    class: 'build-input', type: 'text',
    placeholder: 'Build anything — "a spiral staircase", "a gear with 24 teeth", "a wooden table"',
  });
  private reviseButton = h('button', {
    class: 'btn build-revise',
    text: 'Revise Selected',
    title: 'Change the selected generated object, keeping your edits to it',
  });
  private target = h('div', { class: 'build-target dim small' });
  private reviseCodeButton = h('button', {
    class: 'btn',
    text: 'Preview Revision of Selected',
    title: 'Run this program as a revision of the selected asset, keeping your edits to it',
  });
  private codePanel = h('div', { class: 'build-code hidden' });
  /** Public so the code panel can be driven the way a person drives it. */
  codeArea = h('textarea', { class: 'code-area' });
  private codeLog = h('pre', { class: 'code-log' });
  private note = h('div', { class: 'build-note' });
  /**
   * Somewhere to say what happened, and a way to put the panel away.
   *
   * The build panel sits over the viewport, and until now it could not be
   * closed — so the thing you were building was permanently behind the thing
   * that built it.
   */
  private statusChip = h('span', { class: 'build-chip' });
  private closeButton = h('button', {
    class: 'icon-btn build-close', text: '✕', title: 'Close (Shift+Cmd+B reopens it)',
  });
  private config: LLMConfig = loadConfig();
  private modelReady = false;
  private running: AbortController | null = null;

  constructor(private editor: Editor) {
    this.input.addEventListener('keydown', (e) => {
      // Typing must not reach the viewport keymap, but the app-wide chords
      // (Cmd+K, Cmd+Shift+B) still have to work from inside the field.
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      if (e.key === 'Enter') void this.run();
      if (e.key === 'Escape') this.input.blur();
    });
    this.closeButton.addEventListener('click', () => this.hide());

    this.reviseButton.addEventListener('click', () => void this.revise());
    this.reviseCodeButton.addEventListener('click', () => void this.reviseFromCode());
    this.root.append(
      h('div', { class: 'build-row' }, [
        h('span', { class: 'build-mark', text: 'Build' }),
        this.input,
        // Two explicit actions rather than one that guesses. "Create New" and
        // "Revise Selected" are different intentions, and a single button that
        // decides between them by looking at the selection would eventually
        // build a second staircase when somebody meant to change the first.
        button('Create New', () => void this.run(), { class: 'primary build-go', title: 'Build a new object from these words' }),
        this.reviseButton,
        button('Code', () => this.toggleCode(), { title: 'Show and edit the program that builds it' }),
        this.statusChip,
        this.closeButton,
      ]),
      this.target,
      this.note,
      this.buildCodePanel(),
    );
    this.setChip('', 'idle');
    this.showHint();
    editor.on('change', () => this.showTarget());
    editor.on('revision', () => this.showTarget());
    this.showTarget();
  }

  // ------------------------------------------------------------------ revise

  /** The generated asset the selection belongs to, if any. */
  private selectedAsset(): SceneObject | null {
    const scene = this.editor.scene;
    return assetRootFor(scene, scene.activeObject ?? scene.selectedObjects()[0] ?? null);
  }

  /**
   * Say what Revise would act on, before it is pressed.
   *
   * Without this the button is a coin toss: the selection might be a generated
   * asset, might be one part of one, might be something modelled by hand, and
   * the three behave differently.
   */
  private showTarget(): void {
    const asset = this.selectedAsset();
    const state = revisability(asset);
    this.reviseButton.toggleAttribute('disabled', !state.can || this.editor.revision.active);
    this.reviseCodeButton.toggleAttribute(
      'disabled', !asset || this.editor.revision.active,
    );
    if (this.editor.revision.active) {
      this.target.textContent = 'A revision is waiting for Accept or Reject.';
      return;
    }
    if (!asset) {
      const selected = this.editor.scene.activeObject;
      this.target.textContent = selected
        ? `"${selected.name}" was not generated by The Culp Mixer, so there is nothing recorded to revise. Create New builds alongside it.`
        : 'Select a generated object to revise it.';
      return;
    }
    if (!state.can) {
      this.target.textContent = state.why;
      return;
    }
    const settings = revisableSettings(asset.provenance)
      .filter((s) => s.value !== null && s.value !== '')
      .map((s) => `${s.key} ${s.value}`)
      .join(', ');
    const blind = state.blind ? ' No baseline was recorded, so your edits cannot be told apart.' : '';
    this.target.textContent = `Revise "${asset.name}"${settings ? ` — ${settings}` : ''}.${blind}`;
  }

  /**
   * Change the selected asset rather than building another one.
   *
   * Everything is staged: the generator runs, the merge decides, the result is
   * previewed, and the scene as it was is held until Accept or Reject. Nothing
   * on the way here mutates the object being revised.
   */
  /** Change the selected generated asset. The Revise Selected button. */
  async revise(): Promise<void> {
    if (this.editor.revision.active) {
      this.editor.setStatus('A revision is already waiting — accept or reject it first');
      this.showTarget();
      return;
    }
    const request = this.input.value.trim();
    const asset = this.selectedAsset();
    if (!asset) {
      this.showTarget();
      return;
    }
    if (!request) {
      this.input.focus();
      this.editor.setStatus('Say what to change — "make it 30 steps", "make the top wider"');
      return;
    }
    const prov = asset.provenance!;
    const stamp = assetFingerprint(this.editor.scene, asset);

    if (prov.source === 'recipe') {
      const parsed = parseRevision(prov, request);
      if (parsed.empty) {
        this.note.textContent = `Nothing in "${request}" names a setting this object has. It has: `
          + `${revisableSettings(prov).map((s) => s.key).join(', ')}.`
          + (parsed.notes.length ? ` ${parsed.notes.join(' ')}` : '');
        return;
      }
      const rebuilt = rebuildRecipe(prov, parsed.params);
      if (!rebuilt) {
        this.note.textContent = 'The recipe that built this is not available in this version.';
        return;
      }
      // The revised settings become the record, so a second revision starts
      // from thirty steps rather than from twenty again.
      this.stage(asset, rebuilt.parts, `${request} (${parsed.summary})`, parsed.notes, stamp,
        undefined, parsed.params);
      return;
    }

    if (prov.source === 'program') {
      if (!this.modelReady) {
        this.note.textContent = 'This object was built by a program, so revising it means '
          + 'editing that program. Its program is below — change it and press '
          + '"Preview Revision of Selected". No model needed.';
        this.codePanel.classList.remove('hidden');
        this.codeArea.value = prov.code ?? this.codeArea.value;
        this.showTarget();
        return;
      }
      await this.reviseProgram(asset, prov.code ?? '', request, stamp);
      return;
    }

    this.note.textContent = 'Reference-built objects are revised from the Create panel, where the '
      + 'picture and its settings are.';
  }

  private async reviseProgram(
    asset: SceneObject, code: string, request: string, stamp: string,
  ): Promise<void> {
    if (this.running) {
      this.running.abort();
      return;
    }
    const controller = new AbortController();
    this.running = controller;
    this.setChip('revising…', 'busy');
    this.note.textContent = `${this.config.model} is editing the program…`;
    let result: RunResult | null = null;
    const verify = async (source: string): Promise<void> => {
      result = await runProgramSandboxed(source, DEFAULT_LIMITS);
    };
    try {
      const prov = asset.provenance!;
      const program = await writeProgram(
        this.config, programRevisionPrompt({ ...prov, code }, request), verify, controller.signal,
      );
      const run = result as RunResult | null;
      if (!run) throw new Error('The revised program produced nothing.');
      this.codeArea.value = program.code;
      this.codeLog.textContent = run.log.join('\n');
      this.setChip(this.config.model, 'ok');
      const live = this.editor.scene.get(asset.id);
      // A reply that outlived its question. The asset it was written against
      // is gone, so there is nothing it can safely be applied to — and
      // applying it to whatever now holds that id would be worse than useless.
      if (!live || live.provenance?.assetId !== prov.assetId) {
        this.note.textContent = 'That object was replaced while the model was working, so its '
          + 'answer was discarded. Nothing was changed.';
        this.setChip(this.config.model, 'idle');
        return;
      }
      const identified = identifiedParts(run.parts);
      const notes = [
        ...identified.problems,
        ...this.identityNote(identified.uncertain, identified.parts.length),
      ];
      this.stage(live, identified.parts, request, notes, stamp, program.code, undefined,
        prov.assetId);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setChip(this.config.model, aborted ? 'idle' : 'bad');
      this.note.textContent = aborted ? 'Revision cancelled — nothing was changed.' : (err as Error).message;
    } finally {
      this.running = null;
      this.showTarget();
    }
  }

  /**
   * Whether the object moved while the request was in flight.
   *
   * A model takes seconds, and people do not sit still for them. The merge is
   * three-way against the recorded baseline, so it copes with edits made in
   * the meantime — but the user should be told that is what happened rather
   * than left to notice.
   */
  private staleNote(asset: SceneObject, stamp: string): string[] {
    if (assetFingerprint(this.editor.scene, asset) === stamp) return [];
    return ['You changed this object while the revision was being generated. '
      + 'It was merged against your latest version, not the one you started from.'];
  }

  private stage(
    asset: SceneObject, parts: ReturnType<typeof proposedFromParts>, label: string,
    notes: string[], stamp: string, code?: string,
    params?: Record<string, number | string | boolean | null>,
    expectAssetId?: string,
  ): void {
    const withStale = [...notes, ...this.staleNote(asset, stamp)];
    const summary = this.editor.revision.preview(asset, parts, label, withStale, {
      ...(code === undefined ? {} : { code }),
      ...(params === undefined ? {} : { params }),
    }, expectAssetId);
    if (!summary) return;
    this.note.textContent = `${summary.headline}. Accept or reject it in the panel.`;
    this.showTarget();
  }

  /**
   * Put the cursor in the box, optionally with something already typed.
   *
   * The guide fills it rather than building for you: the point of that card
   * is to show where the box is and what it accepts, and a scene that appears
   * by itself teaches neither.
   */
  focus(prefill?: string): void {
    this.root.classList.remove('hidden');
    if (prefill !== undefined) this.input.value = prefill;
    this.input.focus();
    this.input.select();
  }

  /** Put it away. It covers the viewport, so it has to be dismissible. */
  hide(): void {
    this.root.classList.add('hidden');
  }

  toggle(): void {
    if (this.root.classList.contains('hidden')) this.focus();
    else this.hide();
  }

  private showHint(): void {
    const subjects = knownSubjects();
    this.note.textContent = `Type what you want — ${subjects.length} things are built in, `
      + 'and arrangements of them. Press Code to read or edit the program that builds it.';
  }

  private buildCodePanel(): HTMLElement {
    this.codeArea.spellcheck = false;
    this.codeArea.placeholder =
      "// Write a program, or press Go and let a model write one.\n// for (let i = 0; i < 12; i++) {\n//   const a = i / 12 * TAU;\n//   cyl(cos(a) * 2, sin(a) * 2, 1, 0.3, 0.3, 2, '#8b5e34');\n// }";
    this.codeArea.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.runCode(this.codeArea.value, 'your code');
      }
    });
    this.codePanel.append(
      this.codeArea,
      h('div', { class: 'btn-row' }, [
        // Two actions, because they are two intentions. "Run" used to be one
        // button that always built a second object — so the advice given to
        // anybody without a model ("edit the program and press Run") produced
        // a duplicate rather than a revision, which is the opposite of what it
        // promised.
        button('Run as New', () => void this.runCode(this.codeArea.value, 'your code'), {
          class: 'primary', title: 'Build a new object from this program',
        }),
        this.reviseCodeButton,
        button('Copy', () => void navigator.clipboard?.writeText(this.codeArea.value)),
        button('Hide', () => this.toggleCode()),
      ]),
      h('p', { class: 'dim small', text: 'Cmd/Ctrl+Enter runs it as a new object. Runs in a sandbox with no network and a 3 second limit.' }),
      this.codeLog,
    );
    return this.codePanel;
  }

  private toggleCode(): void {
    this.codePanel.classList.toggle('hidden');
    if (this.codePanel.classList.contains('hidden')) return;
    // Open it on the selected asset's own program rather than on whatever was
    // last in the box: "edit the program that made this" is the reason to open
    // it, and hunting for the program is not part of that.
    const asset = this.selectedAsset();
    const code = asset?.provenance?.code;
    if (code && !this.codeArea.value.trim()) this.codeArea.value = code;
    this.codeArea.focus();
    this.showTarget();
  }

  /**
   * Run the edited program as a revision of the selected asset.
   *
   * The same pipeline a model-written revision goes through — merge, preview,
   * accept or reject — with the program coming from the box instead of from a
   * model. It needs no model, no account and no network, which matters because
   * this is the path somebody lands on precisely when they have none of those.
   */
  /** Revise the selected asset with the program in the box. */
  async reviseFromCode(): Promise<void> {
    if (this.editor.revision.active) {
      this.editor.setStatus('A revision is already waiting — accept or reject it first');
      this.showTarget();
      return;
    }
    const asset = this.selectedAsset();
    if (!asset) {
      this.showTarget();
      this.editor.setStatus('Select a generated object to revise it with this program');
      return;
    }
    const code = this.codeArea.value.trim();
    if (!code) {
      this.codeArea.focus();
      return;
    }
    const stamp = assetFingerprint(this.editor.scene, asset);
    this.codeLog.textContent = '';
    try {
      const run = await runProgramSandboxed(code, DEFAULT_LIMITS);
      const identified = identifiedParts(run.parts);
      this.codeLog.textContent = run.log.join('\n');
      const live = this.editor.scene.get(asset.id);
      if (!live) {
        this.note.textContent = 'That object is gone; nothing was applied.';
        return;
      }
      this.stage(
        live, identified.parts, 'Your edited program',
        [...identified.problems, ...this.identityNote(identified.uncertain, identified.parts.length)],
        stamp, code,
      );
    } catch (err) {
      this.codeLog.textContent = (err as Error).message;
      this.editor.setStatus(`The program did not run: ${(err as Error).message}`);
    }
  }

  /** Say plainly when parts are being matched by position rather than identity. */
  private identityNote(uncertain: string[], total: number): string[] {
    if (!uncertain.length) return [];
    if (uncertain.length === total) {
      return ['This program does not give its parts identifiers, so they are matched by the '
        + 'order they are created in. Reordering or renaming them would attach your edits to '
        + 'the wrong part — add an id to each part({...}) to make that reliable.'];
    }
    return [`${uncertain.length} of ${total} parts have no identifier and are matched by position.`];
  }

  private setChip(text: string, state: 'ok' | 'bad' | 'idle' | 'busy'): void {
    this.statusChip.textContent = text;
    this.statusChip.className = `build-chip ${state}`;
  }

  // ------------------------------------------------------------------- build

  /** Build a new object from what is typed. The Create New button and Enter. */
  async run(): Promise<void> {
    const prompt = this.input.value.trim();
    if (!prompt) {
      // Pressing Go with an empty box used to do nothing and say nothing,
      // which reads as a broken button rather than as a missing sentence.
      // Put the cursor where the words go and ask for them.
      this.input.focus();
      this.editor.setStatus('Say what to build — "a spiral staircase with 20 steps", "12 cubes in a circle"');
      return;
    }
    if (this.running) {
      this.running.abort();
      return;
    }

    // With a model connected, everything goes through generated code — that is
    // what makes arbitrary requests possible. Without one, fall back to the
    // built-in subjects so the box is never simply dead.
    if (this.modelReady) {
      await this.runModel(prompt);
      return;
    }

    const offline = interpret(prompt);
    if (offline.plan) {
      this.apply(offline.plan, prompt, offline.origin);
      this.note.textContent += '  Connect a model (the chip on the right) to build things with no built-in recipe.';
      return;
    }
    this.note.textContent = `${offline.reason ?? 'Could not build that.'}`;
    this.editor.setStatus('Nothing built — connect a local model to build anything');
  }

  private async runModel(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    this.setChip('writing code…', 'busy');
    this.note.textContent = `${this.config.model} is writing a program…`;

    let result: RunResult | null = null;
    const verify = async (code: string): Promise<void> => {
      result = await runProgramSandboxed(code, DEFAULT_LIMITS);
    };

    try {
      const program = await generateProgram(this.config, prompt, verify, controller.signal);
      this.codeArea.value = program.code;
      const run = result as RunResult | null;
      if (!run) throw new Error('The program produced nothing.');
      this.apply(
        { name: prompt.slice(0, 30), parts: run.parts, source: `${this.config.model}` },
        prompt,
        { source: 'program', generator: `program:${this.config.model}`, prompt, code: program.code },
        `${program.seconds.toFixed(1)}s`,
      );
      this.codeLog.textContent = run.log.join('\n');
      this.setChip(this.config.model, 'ok');
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setChip(this.config.model, aborted ? 'idle' : 'bad');
      this.note.textContent = aborted ? 'Cancelled.' : (err as Error).message;
      if (!aborted && this.codeArea.value) {
        this.codePanel.classList.remove('hidden');
        this.codeLog.textContent = 'The last program is above — you can fix it and press Run.';
      }
    } finally {
      this.running = null;
    }
  }

  /** Run whatever is in the code box, whether a model or a person wrote it. */
  /** Build a new object from a program. The Run as New button. */
  async runCode(code: string, source: string): Promise<void> {
    if (!code.trim()) return;
    this.codeLog.textContent = '';
    try {
      const run = await runProgramSandboxed(code, DEFAULT_LIMITS);
      const prompt = this.input.value.trim();
      this.apply(
        { name: prompt.slice(0, 30) || 'Program', parts: run.parts, source },
        prompt || 'program',
        { source: 'program', generator: 'program:hand-written', prompt, code },
        `${run.ms}ms`,
      );
      this.codeLog.textContent = run.log.join('\n');
    } catch (err) {
      this.codeLog.textContent = (err as Error).message;
      this.editor.setStatus(`The program did not run: ${(err as Error).message}`);
    }
  }

  private apply(
    plan: ReturnType<typeof interpret>['plan'],
    prompt: string,
    made: BuildOrigin,
    timing?: string,
  ): void {
    if (!plan) return;
    if (!this.editor.beginUndo(`Build ${plan.name}`)) return;
    const at = this.editor.scene.cursor.clone();
    const existing = this.editor.scene.bounds(false);
    // Drop new builds beside what is already there rather than inside it.
    if (existing.valid) at.x = existing.max.x + 1;
    const { root, objects, keys } = executePlan(this.editor.scene, plan, new Vec3());
    root.position = at;
    // Recorded now, while the geometry is exactly what the generator made and
    // before anyone has touched it. Captured any later and the "baseline"
    // would already contain somebody's edits.
    recordProvenance(root, made, captureBaseline(objects, keys, this.editor.scene.materials));

    this.editor.selectObject(root.id);
    for (const id of this.editor.scene.objects.keys()) this.editor.renderer.invalidate(id);
    this.editor.emit('change');
    this.editor.frameSelected();

    const via = plan.source ? ` via ${plan.source}` : '';
    this.note.textContent = `${describePlan(plan)}${timing ? ` in ${timing}` : ''}${via}.`;
    this.editor.setStatus(`Built "${prompt}" — ${plan.parts.length} parts`);
  }

}
