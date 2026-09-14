import { Editor } from '../editor/Editor';
import { PRICE } from '../licence/licence';
import { clear, h } from './dom';

/**
 * Bottom bar. Left: what is in the scene or the current selection. Right: the
 * live operator readout — the same numbers the modal transform is applying.
 */
export class StatusBar {
  readonly root = h('footer', { class: 'status-bar' });
  private left = h('div', { class: 'status-left' });
  private centre = h('div', { class: 'status-centre' });
  private right = h('div', { class: 'status-right mono' });

  constructor(private editor: Editor) {
    this.root.append(this.left, this.centre, this.right);
    editor.on('change', () => this.refresh());
    editor.on('status', () => this.refresh());
    editor.on('modal', () => this.refresh());
    editor.on('licence', () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const ed = this.editor;
    clear(this.left);
    clear(this.centre);
    clear(this.right);

    const stat = (label: string, value: string | number): HTMLElement =>
      h('span', { class: 'stat' }, [
        h('span', { class: 'stat-label', text: label }),
        h('span', { class: 'stat-value mono', text: `${value}` }),
      ]);

    if (ed.mode === 'edit' && ed.editMesh) {
      const mesh = ed.editMesh;
      this.left.append(
        stat('Verts', `${ed.selection.verts.size}/${mesh.vertCount}`),
        stat('Edges', `${ed.selection.edges.size}/${mesh.edgeCount}`),
        stat('Faces', `${ed.selection.faces.size}/${mesh.faceCount}`),
        stat('Tris', mesh.triCount),
      );
    } else {
      const s = ed.scene.stats();
      this.left.append(
        stat('Objects', `${ed.scene.selection.size}/${s.objects}`),
        stat('Verts', s.verts.toLocaleString()),
        stat('Faces', s.faces.toLocaleString()),
        stat('Tris', s.tris.toLocaleString()),
      );
    }

    // The trial says so, permanently and in the same place, for as long as it
    // runs. A countdown somebody has to go looking for is a countdown they
    // find out about when the application stops.
    if (ed.licence.status === 'trial') {
      this.left.append(h('button', {
        class: 'trial-chip',
        title: 'What Kline costs, and how long is left of the trial',
        text: `${ed.licenceSummary} · ${PRICE}`,
        on: { click: () => ed.panels.toggleLicence?.() },
      }));
    }

    const modal = ed.modalLabel;
    if (modal) {
      this.centre.appendChild(h('span', { class: 'modal-hint', text: 'Click or Enter to confirm · Esc to cancel' }));
      this.right.appendChild(h('span', { class: 'modal-readout', text: modal }));
    } else {
      this.centre.appendChild(h('span', { class: 'dim', text: ed.mode === 'edit' ? 'Tab: back to Object Mode' : 'Tab: edit the active object' }));
      this.right.appendChild(h('span', { text: ed.statusMessage }));
    }
  }
}
