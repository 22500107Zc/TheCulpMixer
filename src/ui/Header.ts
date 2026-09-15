import { COMMANDS, Command, runCommand } from '../editor/commands';
import { Editor } from '../editor/Editor';
import { ShadingMode } from '../render/Renderer';
import { clear, h } from './dom';
import { icon } from './icons';

const MENUS: { label: string; categories: Command['category'][] }[] = [
  { label: 'File', categories: ['File'] },
  { label: 'Add', categories: ['Add'] },
  { label: 'Object', categories: ['Object'] },
  { label: 'Mesh', categories: ['Mesh'] },
  { label: 'Rig', categories: ['Rig'] },
  { label: 'Select', categories: ['Select'] },
  { label: 'View', categories: ['View'] },
  { label: 'Help', categories: ['Help'] },
];

/** Top bar: wordmark, menus, mode switch, select-mode and shading controls. */
export class Header {
  readonly root = h('header', { class: 'header' });
  private openMenu: HTMLElement | null = null;
  private modeArea = h('div', { class: 'header-right' });

  constructor(private editor: Editor, onShowShortcuts: () => void) {
    // The accent sits on the middle letter, which is what gives the wordmark
    // its balance at this letter-spacing.
    this.root.appendChild(h('div', { class: 'wordmark', title: 'The Culp Mixer' }, [
      h('span', { text: 'KL' }),
      h('span', { class: 'wordmark-accent', text: 'I' }),
      h('span', { text: 'NE' }),
    ]));

    const menuBar = h('nav', { class: 'menu-bar' });
    for (const menu of MENUS) menuBar.appendChild(this.buildMenu(menu.label, menu.categories));
    menuBar.appendChild(h('button', {
      class: 'menu-label',
      text: 'Shortcuts',
      on: { click: () => { this.closeMenu(); onShowShortcuts(); } },
    }));
    this.root.appendChild(menuBar);
    this.root.appendChild(this.modeArea);

    document.addEventListener('pointerdown', (e) => {
      if (this.openMenu && !this.openMenu.contains(e.target as Node)) this.closeMenu();
    });
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private buildMenu(label: string, categories: Command['category'][]): HTMLElement {
    const items = h('div', { class: 'menu-items' });
    const wrapper = h('div', { class: 'menu' }, [
      h('button', {
        class: 'menu-label',
        text: label,
        on: {
          click: (e) => {
            e.stopPropagation();
            const isOpen = wrapper.classList.contains('open');
            this.closeMenu();
            if (!isOpen) {
              this.populate(items, categories);
              wrapper.classList.add('open');
              this.openMenu = wrapper;
            }
          },
        },
      }),
      items,
    ]);
    return wrapper;
  }

  private populate(container: HTMLElement, categories: Command['category'][]): void {
    clear(container);
    const ed = this.editor;
    let lastCategory = '';
    for (const cmd of COMMANDS) {
      if (!categories.includes(cmd.category)) continue;
      if (cmd.mode && cmd.mode !== ed.mode) continue;
      if (cmd.category !== lastCategory && lastCategory !== '') {
        container.appendChild(h('div', { class: 'menu-sep' }));
      }
      lastCategory = cmd.category;
      const disabled = cmd.enabled ? !cmd.enabled(ed) : false;
      container.appendChild(h('button', {
        class: `menu-item${disabled ? ' disabled' : ''}`,
        disabled,
        on: {
          click: () => {
            this.closeMenu();
            runCommand(ed, cmd.id);
          },
        },
      }, [
        h('span', { text: cmd.label }),
        cmd.shortcut ? h('kbd', { text: cmd.shortcut }) : null,
      ]));
    }
    if (!container.children.length) {
      container.appendChild(h('div', { class: 'menu-empty', text: 'Nothing available in this mode' }));
    }
  }

  private closeMenu(): void {
    this.openMenu?.classList.remove('open');
    this.openMenu = null;
  }

  refresh(): void {
    const ed = this.editor;
    clear(this.modeArea);

    const editorModes: { id: 'object' | 'edit' | 'sculpt'; label: string }[] = [
      { id: 'object', label: 'Object' },
      { id: 'edit', label: 'Edit' },
      { id: 'sculpt', label: 'Sculpt' },
    ];
    const modeGroup = h('div', { class: `mode-switch ${ed.mode}` });
    // Edit and Sculpt need something to work on, and a button that refuses
    // has to look like one. These used to sit there looking perfectly normal,
    // do nothing at all when clicked, and explain themselves only in a line
    // at the bottom of a crowded status bar — which reads as an application
    // whose buttons are broken.
    const blocker = ed.meshModeBlocker();
    for (const m of editorModes) {
      const needsMesh = m.id !== 'object';
      const unavailable = needsMesh && blocker !== null && ed.mode === 'object';
      const button = h('button', {
        class: `mode-opt${ed.mode === m.id ? ' active' : ''}${unavailable ? ' unavailable' : ''}`,
        text: m.label,
        title: unavailable
          ? `${m.label} Mode — ${blocker}`
          : m.id === 'edit' ? 'Edit Mode (Tab)' : `${m.label} Mode`,
        on: { click: () => ed.setMode(m.id) },
      }) as HTMLButtonElement;
      // Dimmed but still clickable, so the reason reaches anyone who presses
      // it anyway; a disabled button swallows the click and says nothing.
      button.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
      modeGroup.appendChild(button);
    }
    this.modeArea.appendChild(modeGroup);

    if (ed.mode === 'edit') {
      const group = h('div', { class: 'seg-group' });
      const selectModes: { id: 'vertex' | 'edge' | 'face'; key: string }[] = [
        { id: 'vertex', key: '1' }, { id: 'edge', key: '2' }, { id: 'face', key: '3' },
      ];
      for (const m of selectModes) {
        group.appendChild(h('button', {
          class: `seg${ed.selectMode === m.id ? ' active' : ''}`,
          title: `${m.id[0].toUpperCase()}${m.id.slice(1)} select (${m.key})`,
          on: { click: () => ed.setSelectMode(m.id) },
        }, [icon(m.id)]));
      }
      this.modeArea.appendChild(group);
    }

    const shading = h('div', { class: 'seg-group' });
    const shadingModes: { id: ShadingMode; label: string }[] = [
      { id: 'solid', label: 'Solid' },
      { id: 'material', label: 'Material' },
      { id: 'wireframe', label: 'Wireframe' },
    ];
    for (const m of shadingModes) {
      shading.appendChild(h('button', {
        class: `seg${ed.options.shading === m.id ? ' active' : ''}`,
        title: `${m.label} shading (Z cycles)`,
        on: { click: () => ed.setShading(m.id) },
      }, [icon(m.id)]));
    }
    shading.appendChild(h('button', {
      class: `seg${ed.options.xray ? ' active' : ''}`,
      title: 'X-ray — see and select through surfaces (Alt+Z)',
      on: {
        click: () => {
          ed.options.xray = !ed.options.xray;
          ed.requestRender();
          ed.emit('change');
        },
      },
    }, [icon('xray')]));
    shading.appendChild(h('button', {
      class: `seg${ed.options.uvCheck ? ' active' : ''}`,
      title: 'UV checker — shade every surface with a test grid',
      on: { click: () => runCommand(ed, 'view.uvCheck') },
    }, [icon('uv')]));
    this.modeArea.appendChild(shading);

    // Modifier toggles that change what a drag does, so they belong on screen
    // rather than buried in a menu.
    const toggles = h('div', { class: 'seg-group' });
    toggles.appendChild(h('button', {
      class: `seg${ed.proportional.enabled ? ' active' : ''}`,
      title: `Proportional editing (O) — ${ed.proportional.falloff} falloff, radius ${ed.proportional.radius.toFixed(2)}`,
      on: { click: () => ed.toggleProportional() },
    }, [icon('proportional')]));
    toggles.appendChild(h('button', {
      class: `seg${ed.snap.enabled ? ' active' : ''}`,
      title: `Snapping (Shift+Tab) — target: ${ed.snap.mode}`,
      on: { click: () => runCommand(ed, 'transform.snap') },
    }, [icon('snap')]));
    toggles.appendChild(h('button', {
      class: 'seg',
      title: 'Render image (F12)',
      on: { click: () => runCommand(ed, 'render.image') },
    }, [icon('render')]));
    this.modeArea.appendChild(toggles);
  }
}
