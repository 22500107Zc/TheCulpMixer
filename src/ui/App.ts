import { Editor } from '../editor/Editor';
import { COMMANDS, KEYMAP, keyChord, lookupKey, runCommand } from '../editor/commands';
import { Header } from './Header';
import { Outliner } from './Outliner';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { clear, h } from './dom';
import { BuildBar } from './BuildBar';
import { CommandPalette } from './CommandPalette';
import { COMMANDS as ALL_COMMANDS } from '../editor/commands';
import { applyDesktopChrome, desktop } from '../desktop';
import { Timeline } from './Timeline';
import { RenderWindow } from './RenderWindow';
import { UVEditor } from './UVEditor';
import { GraphEditor } from './GraphEditor';
import { DiffPanel } from './DiffPanel';
import { RevisionPanel } from './RevisionPanel';
import { SetupGuide } from './SetupGuide';
import { SculptPanel } from './SculptPanel';
import { askUnsaved } from './UnsavedDialog';
import { describeSave, saveText, saveWorked } from '../io/files';
import { formatAge } from '../editor/recovery';
import { altKeyName, ctrlKeyName, isMac, navigationHint, scrollPhrase } from './platform';
import { HomePage } from './HomePage';
import { LicencePanel } from './LicencePanel';

/** Assembles the shell around the viewport and routes keyboard input. */
export class App {
  readonly editor: Editor;
  private canvas: HTMLCanvasElement;
  private heatBar = h('div', { class: 'heat-bar' });
  private boxSelect = h('div', { class: 'box-select' });
  /** The knife's cut line, drawn over the viewport while the tool is live. */
  private knifeLine = (() => {
    // SVG needs its own namespace; `h` only makes HTML elements.
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', 'knife-line');
    return el;
  })();
  private shortcuts = h('div', { class: 'overlay-panel shortcuts hidden' });
  private licencePanel: LicencePanel;
  private homePage: HomePage;
  private viewportHint = h('div', { class: 'viewport-hint' });
  private dropVeil = h('div', { class: 'drop-veil' }, [
    h('p', { text: 'Drop to build geometry from it' }),
  ]);
  /**
   * The right-hand panel, reachable from the scripting handle.
   *
   * Public so the end-to-end tests can hand it a file the way a drop does,
   * rather than reaching in through the DOM and clicking hidden inputs.
   */
  properties!: Properties;
  private palette!: CommandPalette;
  /**
   * Public because the build prompt is a user-facing action surface: the
   * command palette, the guide and the end-to-end tests all drive it the same
   * way a person does.
   */
  buildBar!: BuildBar;
  private renderWindow!: RenderWindow;
  private uvEditor!: UVEditor;
  private graphEditor!: GraphEditor;
  private diffPanel!: DiffPanel;
  private revisionPanel!: RevisionPanel;
  private setupGuide!: SetupGuide;
  private recoveryBar = h('div', { class: 'recovery-bar hidden' });
  /**
   * "A new version is ready."
   *
   * An installed app that updates itself out from under an open document is
   * the wrong trade: the worker holds the new version back until this is
   * pressed, so a reload happens when the creator is ready for one rather than
   * in the middle of a sculpt.
   */
  private updateBar = h('div', { class: 'recovery-bar update-bar hidden' });

  constructor(private mount: HTMLElement) {
    this.canvas = h('canvas', { class: 'viewport-canvas' });
    this.editor = new Editor(this.canvas);
    this.licencePanel = new LicencePanel(this.editor);
    this.homePage = new HomePage(this.editor);

    const header = new Header(this.editor, () => this.toggleShortcuts());
    const toolbar = new Toolbar(this.editor);
    const outliner = new Outliner(this.editor);
    const properties = new Properties(this.editor);
    this.properties = properties;
    const status = new StatusBar(this.editor);

    this.buildBar = new BuildBar(this.editor);
    this.palette = new CommandPalette(this.editor);
    this.renderWindow = new RenderWindow(this.editor);
    this.uvEditor = new UVEditor(this.editor);
    this.graphEditor = new GraphEditor(this.editor);
    this.diffPanel = new DiffPanel(this.editor);
    this.revisionPanel = new RevisionPanel(this.editor);
    this.setupGuide = new SetupGuide(this.editor);
    // Registered rather than key-handled here, so every window reaches the
    // View menu, the command palette and the shortcut list through one
    // definition.
    this.editor.panels = {
      toggleUV: () => this.uvEditor.toggle(),
      toggleGraph: () => this.graphEditor.toggle(),
      toggleDiff: () => this.diffPanel.toggle(),
      toggleGuide: () => this.setupGuide.toggle(),
      focusBuild: (prefill) => this.buildBar.focus(prefill),
      openCreate: () => this.properties.openCreate(),
    };
    const sculptPanel = new SculptPanel(this.editor);
    const timeline = new Timeline(this.editor);
    const viewport = h('main', { class: 'viewport' }, [
      this.canvas, this.buildBar.root, this.boxSelect, this.knifeLine, this.viewportHint,
      sculptPanel.root, this.uvEditor.root, this.graphEditor.root, this.diffPanel.root,
      this.revisionPanel.root,
      this.setupGuide.root, this.dropVeil, this.shortcuts, this.licencePanel.root,
      this.homePage.root,
      this.renderWindow.root, this.palette.root,
    ]);
    const right = h('div', { class: 'sidebar' }, [outliner.root, properties.root]);

    // On a narrow window the sidebar becomes a drawer rather than disappearing.
    //
    // It used to be `display: none` below 820px, which took the outliner and
    // the whole properties panel — name, transform, materials, modifiers — out
    // of reach with nothing to open them again. A laptop with a palette open
    // beside the browser is enough to hit that width, and the application
    // silently lost half its controls.
    const drawerToggle = h('button', {
      class: 'sidebar-toggle',
      title: 'Show the outliner and properties (Esc closes)',
      text: 'Panels',
    });
    const scrim = h('div', { class: 'sidebar-scrim' });
    const setDrawer = (open: boolean): void => {
      right.classList.toggle('open', open);
      scrim.classList.toggle('open', open);
      drawerToggle.setAttribute('aria-expanded', String(open));
    };
    drawerToggle.addEventListener('click', () => setDrawer(!right.classList.contains('open')));
    scrim.addEventListener('click', () => setDrawer(false));
    // Escape closes it, and is handled here rather than in the global keymap so
    // it cannot shadow Escape's meaning in a modal transform.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && right.classList.contains('open')) {
        e.stopPropagation();
        setDrawer(false);
      }
    }, true);

    mount.append(
      header.root,
      this.heatBar,
      this.recoveryBar,
      this.updateBar,
      h('div', { class: 'workspace' }, [toolbar.root, viewport, scrim, right, drawerToggle]),
      timeline.root,
      status.root,
    );

    this.buildShortcuts();
    this.wireKeyboard();
    this.wireDesktopShell();
    this.wireFileDrop();
    this.editor.loadStoredPreferences();
    this.offerRecovery();
    // Shown regardless of whether there is a crash copy to restore. Holding it
    // back for that seemed considerate and was not: the recovery bar is a
    // strip across the top and the guide sits in the bottom corner, so they
    // never collide — and closing the tab writes an autosave, which means
    // almost every launch after the first has something to offer. Gating on
    // it meant anyone who quit without ticking the box never saw the guide
    // again.
    this.setupGuide.showOnStart();
    this.watchForUpdates();
    this.editor.panels.toggleLicence = () => this.licencePanel.toggle();
    // Whenever The Culp Mixer is locked, the wall goes up — at startup and again on any
    // refused command. Registered before the first check runs, so a build that
    // is already past its trial never gets a frame of the editor.
    this.editor.on('licence', () => {
      if (this.locked) this.licencePanel.show();
    });
    // Asked once at startup. A build from source, or one shipped without a
    // signing key, answers "nothing to enforce" and nothing else happens.
    //
    // The local answer comes first, so the interface is never wrong even for a
    // moment, and then the server is asked. That second call is what
    // recognises somebody who has just paid, or who is opening The Culp Mixer on their
    // second machine, without anybody being handed a key to copy. It cannot
    // fail loudly: offline, server down, or no Stripe account connected yet
    // all leave the local answer standing.
    // The front door goes up before anything else if nobody is signed in, and
    // the account is checked on every launch — that is what notices a trial
    // running out, and what notices the founder switching somebody on after
    // they paid.
    void this.editor.refreshLicence()
      .then(() => this.editor.refreshAccountState())
      .then(() => {
        this.homePage.refresh();
        // Only an old-style install, with nobody signed in, still consults
        // the licence server. A signed-in account has already been answered.
        if (!this.editor.signedIn) return this.editor.syncLicence();
        return undefined;
      });
    this.homePage.refresh();
    this.editor.renderer.onTexturesReady = () => this.editor.requestRender();
    // Closing the tab: write a recovery copy, and let the browser ask its own
    // "leave site?" question when there is unsaved work. A page cannot put its
    // own dialog here — browsers stopped allowing that years ago because it
    // was abused — so the honest thing is to set the flag that triggers the
    // native one and keep the recovery copy as the real safety net.
    window.addEventListener('beforeunload', (e) => {
      void this.editor.autosaveNow(false);
      if (!this.editor.hasUnsavedChanges) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // The desktop shell holds the close until this answers.
    const bridge = desktop();
    bridge?.onConfirmClose?.(() => { void this.confirmClose(); });

    this.editor.on('modal', () => this.syncModalChrome());
    this.editor.on('change', () => this.syncModalChrome());
    this.syncModalChrome();
    this.editor.start();
    this.editor.setStatus(`Ready — ${navigationHint()} · Ctrl+K finds everything else`);
  }

  /**
   * Answer the shell's "may I close?".
   *
   * A recovery copy is written either way, because the window is going and a
   * crash-safe copy costs nothing. Saving is offered first, and a save that is
   * cancelled or fails keeps the window open — pressing Save and then losing
   * the work anyway would be the worst outcome of the three.
   */
  private async confirmClose(): Promise<void> {
    const bridge = desktop();
    await this.editor.autosaveNow(false);
    if (!this.editor.hasUnsavedChanges) {
      bridge?.answerClose?.(true);
      return;
    }
    const answer = await askUnsaved('Closing The Culp Mixer will lose them.');
    if (answer === 'cancel') {
      bridge?.answerClose?.(false);
      return;
    }
    if (answer === 'save') {
      const outcome = await saveText(
        'scene.kline', JSON.stringify(this.editor.scene.toJSON(), null, 1), 'application/json',
      );
      if (!saveWorked(outcome)) {
        this.editor.setStatus(`${describeSave(outcome, 'scene.kline')} — The Culp Mixer stayed open.`);
        bridge?.answerClose?.(false);
        return;
      }
      this.editor.markSaved();
    }
    bridge?.answerClose?.(true);
  }

  private syncModalChrome(): void {
    this.heatBar.classList.toggle('live', this.editor.isModal);
    const rect = this.editor.boxSelectRect;
    if (rect) {
      Object.assign(this.boxSelect.style, {
        display: 'block',
        left: `${rect.x0}px`,
        top: `${rect.y0}px`,
        width: `${rect.x1 - rect.x0}px`,
        height: `${rect.y1 - rect.y0}px`,
      });
    } else {
      this.boxSelect.style.display = 'none';
    }
    const knife = this.editor.knifePath;
    if (knife && knife.length > 0) {
      const pts = knife.map(([x, y]) => `${x},${y}`).join(' ');
      const dots = knife
        .slice(0, this.editor.knifePointCount)
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" />`)
        .join('');
      this.knifeLine.innerHTML = `<polyline points="${pts}" />${dots}`;
      this.knifeLine.style.display = 'block';
    } else {
      this.knifeLine.style.display = 'none';
    }

    const label = this.editor.modalLabel;
    this.viewportHint.textContent = label ?? '';
    this.viewportHint.classList.toggle('visible', !!label);
  }

  /** Past the trial, with no key. The wall is up and nothing else responds. */
  private get locked(): boolean {
    // Somebody signed in meets the front door instead of the licence wall:
    // one screen, with the countdown and the way to pay on it.
    if (this.editor.account) return false;
    return !this.editor.canUse && this.editor.licence.status !== 'source';
  }

  private wireKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      // Locked, and not typing a licence key into the one field that still
      // takes input: swallow it. The wall covers the window so the mouse
      // cannot reach anything, and this is the other half of that — otherwise
      // G, R, S and the modal transforms would still drive the scene behind
      // it, and the shortcut would be the product.
      const typingTarget = e.target as HTMLElement | null;
      const typing = !!typingTarget && /^(INPUT|TEXTAREA|SELECT)$/.test(typingTarget.tagName);
      if ((this.locked || this.homePage.visible) && !typing) {
        if (this.locked && !this.licencePanel.visible) this.licencePanel.show();
        e.preventDefault();
        return;
      }

      // The app-wide chords work from anywhere, including inside a text field.
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.palette.toggle();
        return;
      }
      // Ctrl/Cmd+B belongs to Bevel, the way it does in every modeller;
      // the Build prompt takes the Shift variant.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.buildBar.focus();
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (!this.shortcuts.classList.contains('hidden') && e.key === 'Escape') {
        this.toggleShortcuts();
        e.preventDefault();
        return;
      }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        this.toggleShortcuts();
        return;
      }
      if (e.key === 'Escape') {
        if (this.renderWindow.visible) {
          this.renderWindow.hide();
          e.preventDefault();
          return;
        }
        if (this.uvEditor.visible) {
          this.uvEditor.hide();
          e.preventDefault();
          return;
        }
        if (this.graphEditor.visible) {
          this.graphEditor.hide();
          e.preventDefault();
          return;
        }
        if (this.setupGuide.visible) {
          this.setupGuide.hide();
          e.preventDefault();
          return;
        }
        if (this.diffPanel.visible) {
          this.diffPanel.hide();
          e.preventDefault();
          return;
        }
      }
      if (this.editor.handleKey(e)) {
        e.preventDefault();
        return;
      }
      const command = lookupKey(keyChord(e), this.editor.mode);
      if (command) {
        e.preventDefault();
        runCommand(this.editor, command);
      }
    });
    // Keep the canvas focused so the keymap always applies.
    this.mount.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      if (!/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) this.canvas.focus();
    });
  }

  /**
   * Dropping an image or a video anywhere over the window sends it straight to
   * the Create panel, which turns it into geometry immediately.
   */
  private wireFileDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    this.mount.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      this.dropVeil.classList.add('visible');
    });
    this.mount.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.mount.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.dropVeil.classList.remove('visible');
    });
    this.mount.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.dropVeil.classList.remove('visible');
      const file = e.dataTransfer?.files?.[0];
      if (file) this.properties.openCreate(file);
    });
  }

  /** Hand the native menu our command registry and accept its callbacks. */
  private wireDesktopShell(): void {
    const bridge = desktop();
    if (!bridge) return;
    applyDesktopChrome();
    bridge.registerCommands(ALL_COMMANDS.map((c) => ({
      id: c.id, label: c.label, category: c.category, shortcut: c.shortcut,
    })));
    bridge.onCommand((id) => runCommand(this.editor, id));
    bridge.onShowShortcuts(() => this.toggleShortcuts());
    bridge.onOpenFile((file) => {
      if (!file) return;
      try {
        this.editor.loadSceneJSON(JSON.parse(file.text));
        this.editor.setStatus(`Opened ${file.name}`);
      } catch (err) {
        this.editor.setStatus(`Could not open ${file.name}: ${(err as Error).message}`);
      }
    });
  }

  /**
   * If the last session left an autosave behind, offer it rather than
   * restoring silently — the user may well have wanted the blank scene.
   */
  private offerRecovery(): void {
    void this.editor.recovery.list().then((slots) => {
      const usable = slots.filter((s) => s.objectCount > 0);
      if (usable.length === 0) return;
      const newest = usable[0];
      clear(this.recoveryBar);

      // More than one copy is kept now, and the one you want is often not the
      // newest — the newest may already contain whatever went wrong.
      const picker = h('select', { class: 'input' }) as HTMLSelectElement;
      for (const slot of usable) {
        picker.append(
          h('option', {
            value: String(slot.id),
            text: `${formatAge(Date.now() - slot.savedAt)} · ${slot.objectCount} object${slot.objectCount === 1 ? '' : 's'}`,
          }),
        );
      }
      picker.value = String(newest.id);

      this.recoveryBar.append(
        h('span', { text: 'A scene from your last session is still here.' }),
        usable.length > 1 ? picker : h('span', {
          text: `Saved ${formatAge(Date.now() - newest.savedAt)} (${newest.objectCount} objects).`,
        }),
        h('button', {
          class: 'btn primary', text: 'Restore',
          on: {
            click: () => {
              const id = usable.length > 1 ? Number(picker.value) : newest.id;
              void this.editor.recovery.load(id).then((rec) => {
                if (!rec) {
                  this.editor.setStatus('That recovery copy is no longer there');
                  return;
                }
                try {
                  this.editor.loadSceneJSON(rec.scene);
                  this.editor.setStatus('Restored the recovered scene');
                } catch (err) {
                  this.editor.setStatus(`Could not restore: ${(err as Error).message}`);
                }
              });
              this.recoveryBar.classList.add('hidden');
            },
          },
        }),
        h('button', {
          class: 'btn', text: 'Discard',
          on: {
            click: () => {
              void this.editor.recovery.discard();
              this.recoveryBar.classList.add('hidden');
            },
          },
        }),
      );
      this.recoveryBar.classList.remove('hidden');
    // A recovery store that cannot be read is not worth interrupting over.
    }).catch(() => undefined);
  }

  /**
   * Offer a reload when a newer build has installed itself.
   *
   * The service worker deliberately does not take over a running tab — it
   * installs, precaches, and waits — so without this the new version would sit
   * there until every The Culp Mixer tab had been closed. This is the control that
   * releases it, and it only appears when there is genuinely something waiting
   * *and* a worker already in charge, so a first-ever install stays silent.
   */
  private watchForUpdates(): void {
    if (!('serviceWorker' in navigator)) return;
    const offer = (worker: ServiceWorker): void => {
      if (!navigator.serviceWorker.controller) return;
      clear(this.updateBar);
      this.updateBar.append(
        h('span', { text: 'A new version of The Culp Mixer is ready.' }),
        h('button', {
          class: 'btn primary', text: 'Reload',
          on: {
            click: () => {
              // One reload, when the new worker has actually taken over.
              let reloaded = false;
              navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (reloaded) return;
                reloaded = true;
                location.reload();
              });
              worker.postMessage({ type: 'kline:activate-update' });
              this.updateBar.classList.add('hidden');
            },
          },
        }),
        h('button', {
          class: 'btn', text: 'Later',
          on: { click: () => this.updateBar.classList.add('hidden') },
        }),
      );
      this.updateBar.classList.remove('hidden');
    };

    // `ready` rather than `getRegistration`: the worker is registered on the
    // window's load event, which is after this runs, so asking now would find
    // nothing and this would sit there listening to a registration that did
    // not exist yet.
    void navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') offer(installing);
        });
      });
    }).catch(() => undefined);
  }

  private toggleShortcuts(): void {
    this.shortcuts.classList.toggle('hidden');
  }

  private buildShortcuts(): void {
    clear(this.shortcuts);
    const byCommand = new Map(COMMANDS.map((c) => [c.id, c]));
    const groups = new Map<string, { chord: string; label: string; mode?: string }[]>();
    for (const binding of KEYMAP) {
      const cmd = byCommand.get(binding.command);
      if (!cmd) continue;
      const list = groups.get(cmd.category) ?? [];
      list.push({ chord: binding.chord, label: cmd.label, mode: binding.mode });
      groups.set(cmd.category, list);
    }

    this.shortcuts.appendChild(h('div', { class: 'overlay-head' }, [
      h('h2', { text: 'Keyboard' }),
      h('button', { class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.toggleShortcuts() } }),
    ]));

    const grid = h('div', { class: 'shortcut-grid' });
    for (const [category, list] of groups) {
      grid.appendChild(h('div', { class: 'shortcut-group' }, [
        h('h3', { text: category }),
        ...list.map((item) => h('div', { class: 'shortcut-row' }, [
          h('kbd', { text: prettyChord(item.chord) }),
          h('span', { text: item.label }),
          item.mode ? h('em', { text: item.mode }) : null,
        ])),
      ]));
    }
    grid.appendChild(h('div', { class: 'shortcut-group' }, [
      h('h3', { text: 'Quick keys' }),
      ...[
        ['Cmd/Ctrl + K', 'Search every command'],
        ['Cmd/Ctrl + Shift + B', 'Jump to the Build prompt'],
        ['Cmd/Ctrl + U', 'UV editor'],
        ['?', 'This sheet'],
      ].map(([k, v]) => h('div', { class: 'shortcut-row' }, [h('kbd', { text: k }), h('span', { text: v })])),
    ]));

    grid.appendChild(h('div', { class: 'shortcut-group' }, [
      h('h3', { text: 'Sculpt Mode' }),
      ...[
        ['Drag', 'Apply the brush'],
        ['Ctrl + drag', 'Invert the brush'],
        ['[  ]', 'Smaller / larger brush'],
        ['Ctrl + scroll', 'Resize the brush'],
        ['B', 'Next brush'],
      ].map(([k, v]) => h('div', { class: 'shortcut-row' }, [h('kbd', { text: k }), h('span', { text: v })])),
    ]));

    grid.appendChild(h('div', { class: 'shortcut-group' }, [
      h('h3', { text: 'Modal operators' }),
      ...[
        ['X / Y / Z', 'Constrain to an axis'],
        ['Shift + axis', 'Constrain to a plane'],
        ['Type a number', 'Enter an exact value'],
        ['Scroll', 'Loop cut count · bevel segments'],
        ['P', 'Cycle the bevel profile'],
        ['Shift', 'Precision drag'],
        ['Ctrl', 'Invert the snap setting'],
        ['Right click / Esc', 'Cancel'],
      ].map(([k, v]) => h('div', { class: 'shortcut-row' }, [h('kbd', { text: k }), h('span', { text: v })])),
    ]));

    grid.appendChild(h('div', { class: 'shortcut-group' }, [
      h('h3', { text: 'Trackpad and mouse' }),
      ...[
        [`${altKeyName()} + ${scrollPhrase()}`, 'Orbit — no button to hold'],
        [`Shift + ${scrollPhrase()}`, 'Pan'],
        ...(isMac() ? [['Pinch', 'Zoom towards the cursor']] : []),
        [scrollPhrase().replace(/^s/, 'S'), 'Zoom towards the cursor'],
        [`${altKeyName()} + drag`, 'Orbit'],
        [`${altKeyName()} + Shift + drag`, 'Pan'],
        [`${altKeyName()} + ${ctrlKeyName()} + drag`, 'Zoom'],
        ['Middle drag', 'Orbit (with a mouse)'],
        ['Shift + middle', 'Pan'],
        ['Left click', 'Select'],
        ['Left drag', 'Box select'],
        ['Shift + click', 'Extend selection'],
        ['Alt + click', 'Select edge ring (Edit Mode)'],
        ['Shift + right click', 'Place 3D cursor'],
      ].map(([k, v]) => h('div', { class: 'shortcut-row' }, [h('kbd', { text: k }), h('span', { text: v })])),
    ]));
    this.shortcuts.appendChild(grid);
  }
}

function prettyChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => {
      if (part.startsWith('numpad')) return `Numpad ${part.slice(6).replace('decimal', '.')}`;
      if (part.length === 1) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(' + ');
}
