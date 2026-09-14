import { Editor } from '../editor/Editor';
import { TERMS } from '../licence/licence';
import { h } from './dom';
import { altKeyName, isMac, navigationHint, scrollPhrase } from './platform';

/**
 * The first thing a new user sees.
 *
 * A 3D application is close to unusable without knowing a few things: how to
 * turn the view without a middle mouse button, that
 * Tab switches between moving objects and editing their geometry, that G, R
 * and S are how you move anything, and that Ctrl+K will find the rest. None
 * of that is discoverable by clicking around, and everyone who has used
 * Blender already knows it while everyone who has not is stuck. So it is
 * said once, up front, in a handful of short cards.
 *
 * Each card can *do* the thing it describes. Reading "press Tab to edit
 * geometry" teaches nothing next to watching the cube light up with vertices,
 * so the buttons run the real commands against the real scene behind the
 * dialog. That is also why the guide is deliberately narrow and offset rather
 * than a full-screen takeover: the viewport has to stay visible for any of it
 * to land.
 *
 * It shows on first run and never again once dismissed, which is the whole
 * bargain — an onboarding flow that reappears is an annoyance, and one you
 * cannot get back is a dead end, so there is a checkbox and a menu entry.
 */

interface Card {
  title: string;
  body: string;
  /** Optional demonstration, run against the live scene behind the dialog. */
  action?: { label: string; run: (editor: Editor) => void };
}

const CARDS: Card[] = [
  {
    title: 'Welcome to Kline',
    body: 'A 3D modelling application that runs on your machine and nowhere else. '
      + 'Nothing you open is uploaded, there is no account, and there is no server. '
      + `Kline is proprietary software, not free software: ${TERMS} `
      + 'This takes about a minute and you can stop at any point.',
    action: {
      label: 'Put a cube in front of me',
      run: (editor) => {
        for (const id of [...editor.scene.objects.keys()]) editor.scene.remove(id);
        editor.addPrimitive('cube');
        editor.frameSelected();
      },
    },
  },
  {
    title: 'Turning the view',
    body: `Hold ${altKeyName()} and ${scrollPhrase()} to turn the model round. Shift and `
      + `${scrollPhrase()} slides it sideways, and ${isMac() ? 'pinch or scroll' : 'the wheel'} `
      + 'zooms. All of it works from a laptop trackpad — no middle mouse button, no second '
      + 'hand. With a mouse, the middle button does the same.',
    action: {
      label: 'Show me from another angle',
      run: (editor) => {
        if (editor.scene.objects.size === 0) editor.addPrimitive('cube');
        editor.frameSelected();
        editor.camera.nudge(-45 * (Math.PI / 180), 12 * (Math.PI / 180));
        editor.requestRender();
        editor.setStatus(navigationHint());
      },
    },
  },
  {
    title: 'Two modes, one key',
    body: 'Object Mode moves whole things around. Edit Mode changes the shape of one thing — '
      + 'its vertices, edges and faces. Tab switches between them, and it is the single most '
      + 'important key in the application.',
    action: {
      label: 'Show me Edit Mode',
      run: (editor) => {
        if (editor.scene.objects.size === 0) editor.addPrimitive('cube');
        if (!editor.scene.active) {
          const first = [...editor.scene.objects.values()][0];
          if (first) {
            editor.scene.selection = new Set([first.id]);
            editor.scene.active = first.id;
          }
        }
        if (editor.mode !== 'edit') editor.toggleEditMode();
        editor.selectAll();
      },
    },
  },
  {
    title: 'Move, rotate, scale',
    body: 'G grabs, R rotates, S scales. Move the mouse, then click to keep it or press '
      + 'Escape to put it back. Hold X, Y or Z while dragging to lock to an axis. '
      + 'Every transform in Kline works this way.',
    action: {
      label: 'Back to Object Mode',
      run: (editor) => {
        if (editor.mode !== 'object') editor.setMode('object');
      },
    },
  },
  {
    title: 'Turn a photo into a model',
    body: 'Drag a photograph onto the window. Kline finds the subject by colour, inflates it '
      + 'to its own thickness — wide parts deep, thin parts thin — and projects the photo back '
      + 'on as a texture. What comes out is a closed, editable mesh, not a cut-out. It cannot '
      + 'see the back of the object, so the far side is the near side, shallower.',
    action: {
      label: 'Where do I drop it?',
      run: (editor) => {
        editor.panels.openCreate?.();
        editor.setStatus('Drop an image anywhere on the window, or use the Create tab on the right');
      },
    },
  },
  {
    title: 'Ask for what you want',
    body: 'The Build box at the top takes plain language — "a spiral staircase with 20 steps", '
      + '"12 cubes in a circle". It answers from built-in recipes with no model and no network. '
      + 'Connect a local model and it will build things it has no recipe for.',
    action: {
      label: 'Put that in the box for me',
      run: (editor) => {
        editor.panels.focusBuild?.('a spiral staircase with 14 steps');
        editor.setStatus('Press Go, or edit the wording first');
      },
    },
  },
  {
    title: 'See what changed',
    body: 'Ctrl+D compares the model against an earlier version — a step in your undo history '
      + 'or a file from last week — and colours it by what actually changed. Green is new, '
      + 'amber has moved, red outlines are gone. No other 3D application does this.',
    action: {
      label: 'Try it on what I just built',
      run: (editor) => {
        const steps = editor.history.steps();
        const step = steps[steps.length - 1];
        if (!step) {
          editor.setStatus('Do something first, then Ctrl+D will have something to compare against');
          return;
        }
        editor.panels.toggleDiff?.();
        editor.compareAgainst(step.scene, `before ${step.label}`);
      },
    },
  },
  {
    title: 'That is the hard part over',
    body: 'Ctrl+K searches every command in the application, which is the fastest way to find '
      + 'anything not covered here. Press ? at any time for the full keyboard sheet. '
      + 'You can reopen this guide from the Help menu.',
  },
];

export class SetupGuide {
  readonly root = h('div', { class: 'setup-guide hidden' });
  private titleEl = h('h2', { text: '' });
  private bodyEl = h('p', { class: 'setup-body' });
  private actionRow = h('div', { class: 'setup-action' });
  private dots = h('div', { class: 'setup-dots' });
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private againBox: HTMLInputElement;
  private step = 0;

  constructor(private editor: Editor) {
    this.backBtn = h('button', {
      class: 'btn', text: 'Back', on: { click: () => this.go(this.step - 1) },
    });
    this.nextBtn = h('button', {
      class: 'btn primary', text: 'Next', on: { click: () => this.go(this.step + 1) },
    });
    this.againBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.againBox.addEventListener('change', () => {
      // Written the moment it is ticked rather than on close, so quitting the
      // application from this dialog still honours the choice.
      this.editor.applyPreferences({
        ...this.editor.preferences,
        showGuideOnStart: !this.againBox.checked,
      });
    });

    this.root.append(
      h('div', { class: 'overlay-head' }, [
        this.titleEl,
        h('button', {
          class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.hide() },
        }),
      ]),
      this.bodyEl,
      this.actionRow,
      h('div', { class: 'setup-foot' }, [
        this.dots,
        this.backBtn,
        this.nextBtn,
      ]),
      h('label', { class: 'setup-again' }, [
        this.againBox,
        h('span', { text: 'Do not show this when Kline opens' }),
      ]),
    );
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Open the guide if the user has not turned it off. */
  showOnStart(): void {
    if (!this.editor.preferences.showGuideOnStart) return;
    this.show();
  }

  show(): void {
    this.step = 0;
    this.againBox.checked = !this.editor.preferences.showGuideOnStart;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  private go(to: number): void {
    if (to < 0) return;
    if (to >= CARDS.length) {
      this.hide();
      this.editor.setStatus('Ctrl+K finds every command · ? shows the keyboard sheet');
      return;
    }
    this.step = to;
    this.render();
  }

  private render(): void {
    const card = CARDS[this.step];
    this.titleEl.textContent = card.title;
    this.bodyEl.textContent = card.body;

    this.actionRow.replaceChildren();
    if (card.action) {
      const { label, run } = card.action;
      this.actionRow.appendChild(h('button', {
        class: 'btn setup-try',
        text: label,
        on: {
          click: () => {
            try {
              run(this.editor);
            } catch {
              // A demonstration failing must not strand anyone inside the
              // guide; the rest of it still works.
              this.editor.setStatus('That demonstration could not run here — carry on');
            }
          },
        },
      }));
    }

    this.dots.replaceChildren(...CARDS.map((_, i) => h('span', {
      class: `setup-dot${i === this.step ? ' setup-dot-on' : ''}`,
      title: `Step ${i + 1}`,
      on: { click: () => this.go(i) },
    })));

    this.backBtn.disabled = this.step === 0;
    this.nextBtn.textContent = this.step === CARDS.length - 1 ? 'Start modelling' : 'Next';
  }
}
