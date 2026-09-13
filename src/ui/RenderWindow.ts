import { Editor } from '../editor/Editor';
import { clear, h } from './dom';
import { framesFor } from '../render/pathtrace/sequence';

/**
 * The render window: a progressive preview of the path-traced image with the
 * settings that matter and a way to save the result. It repaints once per
 * completed pass rather than per band, so the image sharpens in visible steps
 * instead of tearing.
 */
export class RenderWindow {
  readonly root = h('div', { class: 'render-window hidden' });
  private canvas = h('canvas', { class: 'render-canvas' });
  private ctx: CanvasRenderingContext2D | null;
  private status = h('span', { class: 'render-status' });
  private bar = h('div', { class: 'render-bar-fill' });
  private settingsRow = h('div', { class: 'render-settings' });
  private actions = h('div', { class: 'render-actions' });
  /** What the inputs currently show, so a running job can correct them. */
  private shownSettings = '';

  constructor(private editor: Editor) {
    this.ctx = this.canvas.getContext('2d');
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'Render' }),
        h('button', {
          class: 'icon-btn', text: '✕', title: 'Close',
          on: { click: () => this.hide() },
        }),
      ]),
      this.settingsRow,
      h('div', { class: 'render-stage' }, [this.canvas]),
      h('div', { class: 'render-bar' }, [this.bar]),
      h('div', { class: 'render-foot' }, [this.status, this.actions]),
    );

    editor.on('render', () => this.refresh());
    this.buildSettings();
  }

  private buildSettings(): void {
    clear(this.settingsRow);
    const s = this.editor.renderSettings;
    this.shownSettings = `${s.width}x${s.height}x${s.samples}x${s.maxBounces}`;
    const stops = h('input', {
      class: 'sp-slider', type: 'range', min: '-4', max: '4', step: '0.1', value: String(s.exposure),
    });
    const stopsLabel = h('span', { class: 'sp-value', text: `${s.exposure.toFixed(1)} EV` });
    stops.addEventListener('input', () => {
      s.exposure = Number(stops.value);
      stopsLabel.textContent = `${s.exposure.toFixed(1)} EV`;
      // The running job holds its own copy of the settings; exposure is the
      // one field worth pushing across mid-render, because it is a post step
      // that re-grades what has already accumulated.
      const job = this.editor.activeRender;
      if (job) job.settings.exposure = s.exposure;
      this.repaint();
    });
    stops.addEventListener('keydown', (e) => e.stopPropagation());
    const num = (label: string, value: number, onChange: (v: number) => void): HTMLElement => {
      const input = h('input', { class: 'tl-num', type: 'number', value: String(value) });
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        if (Number.isFinite(v) && v > 0) onChange(v);
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return h('label', { class: 'tl-range' }, [h('span', { text: label }), input]);
    };
    // Denoising is a post step over what has already accumulated, so it can be
    // toggled mid-render and the result repainted without starting over.
    const dn = h('input', { type: 'checkbox', checked: s.denoise }) as HTMLInputElement;
    dn.addEventListener('change', () => {
      s.denoise = dn.checked;
      const job = this.editor.activeRender;
      if (job) job.settings.denoise = s.denoise;
      this.repaint();
    });
    dn.addEventListener('keydown', (e) => e.stopPropagation());

    this.settingsRow.append(
      num('Width', s.width, (v) => { s.width = Math.min(4096, v); }),
      num('Height', s.height, (v) => { s.height = Math.min(4096, v); }),
      num('Samples', s.samples, (v) => { s.samples = Math.min(8192, v); }),
      num('Bounces', s.maxBounces, (v) => { s.maxBounces = Math.min(32, v); }),
      h('label', { class: 'tl-range exposure' }, [h('span', { text: 'Exposure' }), stops, stopsLabel]),
      h('label', { class: 'tl-range', title: 'Edge-aware filter over the accumulated samples' },
        [h('span', { text: 'Denoise' }), dn]),
      // The frame range an animation render covers. Shown next to the image
      // settings rather than hidden behind the animation button, so what is
      // about to be rendered is visible before it starts — a range is the one
      // setting where getting it wrong costs the whole wait.
      num('From', s.frameStart ?? this.editor.scene.timeline.start,
        (v) => { s.frameStart = v; }),
      num('To', s.frameEnd ?? this.editor.scene.timeline.end, (v) => { s.frameEnd = v; }),
      num('Every', s.frameStep ?? 1, (v) => { s.frameStep = Math.max(1, v); }),
    );
  }

  /** Re-grade the accumulated samples without restarting the render. */
  private repaint(): void {
    const job = this.editor.activeRender;
    if (job && this.ctx && job.samplesDone > 0) this.ctx.putImageData(job.toImageData(), 0, 0);
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.buildSettings();
    this.refresh();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private refresh(): void {
    const job = this.editor.activeRender;
    const sequence = this.editor.activeSequence;
    if ((job || sequence) && !this.visible) this.root.classList.remove('hidden');
    clear(this.actions);

    // An animation render owns the panel while it runs: its progress is
    // counted in frames, not in samples, and the still-image controls would be
    // describing a job that is only one step of it.
    if (sequence) {
      const frames = framesFor(this.editor.scene, this.editor.renderSettings).length;
      this.status.textContent = this.editor.statusMessage || `Rendering ${frames} frame(s)…`;
      this.actions.appendChild(h('button', {
        class: 'btn', text: 'Stop', on: { click: () => this.editor.cancelAnimation() },
      }));
      return;
    }

    if (!job) {
      this.status.textContent = 'No render yet — press F12.';
      this.bar.style.width = '0%';
      this.actions.append(
        h('button', {
          class: 'btn primary', text: 'Render',
          on: { click: () => void this.editor.renderWithTextures(true) },
        }),
        h('button', {
          class: 'btn', text: 'Render animation',
          title: 'Render the frame range below and write it out as a sequence.',
          on: { click: () => void this.editor.renderAnimation('frames') },
        }),
        h('button', {
          class: 'btn', text: 'Record video',
          title: 'Record the frame range as a video, where this runtime supports it.',
          on: { click: () => void this.editor.renderAnimation('video') },
        }),
      );
      return;
    }

    // Exposure is deliberately left out: it is a post step the user can move
    // mid-render without invalidating what the fields show.
    const sig = `${job.settings.width}x${job.settings.height}x${job.settings.samples}x${job.settings.maxBounces}`;
    if (sig !== this.shownSettings) {
      // A render started with settings the fields do not reflect (a script, or
      // a change made while the window was closed).
      Object.assign(this.editor.renderSettings, job.settings);
      this.buildSettings();
    }
    if (this.canvas.width !== job.settings.width || this.canvas.height !== job.settings.height) {
      this.canvas.width = job.settings.width;
      this.canvas.height = job.settings.height;
    }
    if (this.ctx && job.samplesDone > 0) this.ctx.putImageData(job.toImageData(), 0, 0);

    const pct = Math.round(job.progress * 100);
    this.bar.style.width = `${pct}%`;
    const secs = (Date.now() - job.startedAt) / 1000;
    this.status.textContent = job.finished
      ? `Done — ${job.samplesDone} samples, ${job.triangles.toLocaleString()} triangles, ${secs.toFixed(1)}s`
      : `${pct}% — ${job.samplesDone}/${job.settings.samples} samples, ${secs.toFixed(0)}s elapsed`;

    if (!job.finished) {
      this.actions.appendChild(h('button', {
        class: 'btn', text: 'Cancel', on: { click: () => this.editor.cancelRender() },
      }));
    } else {
      this.actions.append(
        h('button', {
          class: 'btn', text: 'Render again', on: { click: () => void this.editor.renderWithTextures(true) },
        }),
        h('button', { class: 'btn primary', text: 'Save PNG', on: { click: () => this.savePNG() } }),
      );
    }
  }

  private savePNG(): void {
    this.canvas.toBlob((blob) => {
      if (!blob) {
        this.editor.setStatus('Could not encode the image');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kline-render.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.editor.setStatus('Saved kline-render.png');
    }, 'image/png');
  }
}
