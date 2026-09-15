import { Editor } from '../editor/Editor';
import { keyFrames } from '../anim/animation';
import { clear, h } from './dom';
import { icon } from './icons';

/**
 * The timeline strip.
 *
 * Keyframe diamonds come from the selected objects only — showing every key in
 * the scene at once turns the track into noise the moment more than a couple
 * of things are animated.
 */
export class Timeline {
  readonly root = h('div', { class: 'timeline' });
  private track = h('div', { class: 'tl-track' });
  private playhead = h('div', { class: 'tl-playhead' });
  private marks = h('div', { class: 'tl-marks' });
  private frameLabel = h('span', { class: 'tl-frame' });
  private controls = h('div', { class: 'tl-controls' });
  private ranges = h('div', { class: 'tl-ranges' });
  private scrubbing = false;

  /**
   * The controls, built once and kept.
   *
   * They used to be torn down and rebuilt on every 'frame' event — which
   * during playback is every animation frame. A click needs its press and its
   * release on the *same* element, so the pause button was being replaced out
   * from under the cursor twenty-four times a second and the click never
   * completed. From the outside that reads as "the button does nothing", and
   * with the timeline sitting across the bottom of the window it read as the
   * whole interface being dead.
   *
   * The same applied to the Start, End and FPS fields: rebuilding them threw
   * away focus and the half-typed value with it.
   *
   * So refresh() now only changes what actually changed — an icon, a class, a
   * label, a position.
   */
  private playButton!: HTMLElement;
  private loopButton!: HTMLElement;
  private startInput!: HTMLInputElement;
  private endInput!: HTMLInputElement;
  private fpsInput!: HTMLInputElement;

  constructor(private editor: Editor) {
    this.track.append(this.marks, this.playhead);
    this.root.append(this.controls, this.track, this.ranges);
    this.buildControls();

    this.track.addEventListener('pointerdown', (e) => {
      this.scrubbing = true;
      this.track.setPointerCapture(e.pointerId);
      this.scrubTo(e.clientX);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.scrubTo(e.clientX);
    });
    this.track.addEventListener('pointerup', (e) => {
      this.scrubbing = false;
      this.track.releasePointerCapture(e.pointerId);
    });

    editor.on('frame', () => this.refresh());
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private scrubTo(clientX: number): void {
    const rect = this.track.getBoundingClientRect();
    const tl = this.editor.scene.timeline;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    this.editor.setFrame(Math.round(tl.start + t * (tl.end - tl.start)));
  }

  private frameToPercent(frame: number): number {
    const tl = this.editor.scene.timeline;
    const span = Math.max(1, tl.end - tl.start);
    return ((frame - tl.start) / span) * 100;
  }

  /** Built once, in the constructor. Never rebuilt. */
  private buildControls(): void {
    const ed = this.editor;
    const tl = ed.scene.timeline;

    const btn = (
      name: Parameters<typeof icon>[0], title: string, onClick: () => void,
    ): HTMLElement => h('button', {
      class: 'tl-btn', title, on: { click: onClick },
    }, [icon(name)]);

    this.playButton = btn('play', 'Play / pause (Space)', () => ed.togglePlayback());

    this.controls.append(
      btn('skipStart', 'Jump to start (Shift+Left)', () => ed.setFrame(ed.scene.timeline.start)),
      btn('stepBack', 'Previous frame (Left)', () => ed.stepFrame(-1)),
      this.playButton,
      btn('stepForward', 'Next frame (Right)', () => ed.stepFrame(1)),
      btn('skipEnd', 'Jump to end (Shift+Right)', () => ed.setFrame(ed.scene.timeline.end)),
      btn('key', 'Insert keyframe (I)', () => ed.insertKeyframe('all')),
      this.frameLabel,
    );

    const numeric = (
      label: string, value: number, onChange: (v: number) => void, min: number, max: number,
    ): { wrap: HTMLElement; input: HTMLInputElement } => {
      const input = h('input', {
        class: 'tl-num', type: 'number', value: String(value),
        min: String(min), max: String(max),
      }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return { wrap: h('label', { class: 'tl-range' }, [h('span', { text: label }), input]), input };
    };

    const start = numeric('Start', tl.start, (v) => {
      tl.start = Math.min(v, tl.end - 1);
      ed.emit('frame');
    }, 0, 100000);
    const end = numeric('End', tl.end, (v) => {
      tl.end = Math.max(v, tl.start + 1);
      ed.emit('frame');
    }, 1, 100000);
    const fps = numeric('FPS', tl.fps, (v) => {
      tl.fps = Math.max(1, v);
      ed.emit('frame');
    }, 1, 240);
    this.startInput = start.input;
    this.endInput = end.input;
    this.fpsInput = fps.input;

    this.loopButton = h('button', {
      class: 'tl-btn', title: 'Loop playback',
      on: {
        click: () => {
          ed.scene.timeline.loop = !ed.scene.timeline.loop;
          ed.emit('frame');
        },
      },
    }, [icon('loop')]);

    this.ranges.append(start.wrap, end.wrap, fps.wrap, this.loopButton);
  }

  refresh(): void {
    const ed = this.editor;
    const tl = ed.scene.timeline;

    // The play button changes its icon, not its identity.
    const wantPause = tl.playing;
    if (this.playButton.dataset.state !== String(wantPause)) {
      this.playButton.dataset.state = String(wantPause);
      clear(this.playButton);
      this.playButton.appendChild(icon(wantPause ? 'pause' : 'play'));
    }
    this.playButton.classList.toggle('active', tl.playing);
    this.loopButton.classList.toggle('active', tl.loop);

    this.frameLabel.textContent = `${tl.current}`;

    // A field being typed into is left alone: writing over it would eat the
    // keystroke somebody is in the middle of.
    const active = document.activeElement;
    if (active !== this.startInput) this.startInput.value = String(tl.start);
    if (active !== this.endInput) this.endInput.value = String(tl.end);
    if (active !== this.fpsInput) this.fpsInput.value = String(tl.fps);

    clear(this.marks);
    const frames = new Set<number>();
    for (const obj of ed.scene.selectedObjects()) for (const f of keyFrames(obj.animation)) frames.add(f);
    for (const f of frames) {
      if (f < tl.start || f > tl.end) continue;
      this.marks.appendChild(h('div', {
        class: `tl-key${f === tl.current ? ' current' : ''}`,
        title: `Frame ${f}`,
        style: { left: `${this.frameToPercent(f)}%` },
      }));
    }

    this.playhead.style.left = `${this.frameToPercent(tl.current)}%`;
    this.root.classList.toggle('has-animation', ed.scene.hasAnimation);
  }
}
