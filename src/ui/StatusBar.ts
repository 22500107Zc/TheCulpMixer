import { Editor } from '../editor/Editor';
import { PRICE } from '../licence/licence';
import { clear, h } from './dom';

/**
 * Time left, in the shortest form that is still honest.
 *
 * Minutes once it is under an hour, because "0h left" on a trial with fifty
 * minutes in it reads as broken.
 */
function countdown(endsAt: number, now = Date.now()): string {
  const ms = Math.max(0, endsAt - now);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return 'under a minute';
}

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
    // The countdown has to move on its own, or somebody watching the last
    // minutes of their trial sees a number that never changes.
    setInterval(() => {
      if (this.editor.account?.status === 'trial') this.refresh();
    }, 30000);
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
    const account = ed.account;
    // The owner's own licence is on this copy, so this is the founder looking
    // at it. Gated on the signature rather than on an account flag: the
    // signature is the thing that cannot be switched on by editing storage,
    // and it is also the thing that works with no server, which is the state
    // this is most needed in.
    if (ed.licence.status === 'owner') {
      this.left.append(h('button', {
        // Its own class. .founder-chip already belonged to the console
        // button, and two buttons answering to one selector is how a test
        // ends up asserting against whichever happens to come first.
        class: 'trial-chip issue-chip',
        title: 'Somebody paid — turn their account on, here, with no server',
        text: 'Issue a licence',
        on: { click: () => ed.panels.toggleIssue?.() },
      }));
    }
    // Signed in as the founder: the way into the console, in the application
    // rather than a URL to remember.
    if (account?.founder) {
      this.left.append(h('button', {
        class: 'trial-chip founder-chip',
        title: 'Accounts, who has paid, and where people pay',
        text: 'Founder console',
        on: { click: () => window.open('./founder.html', '_blank', 'noopener') },
      }));
    }
    if (account?.status === 'trial' && account.trialEndsAt) {
      this.left.append(h('button', {
        class: 'trial-chip',
        title: 'How long is left of your 33 hours, and what The Culp Mixer costs after',
        text: `Trial — ${countdown(account.trialEndsAt)} left · ${PRICE}`,
        on: { click: () => ed.panels.toggleLicence?.() },
      }));
    } else if (!account && ed.licence.status === 'trial') {
      this.left.append(h('button', {
        class: 'trial-chip',
        title: 'What The Culp Mixer costs, and how long is left of the trial',
        text: `${ed.licenceSummary} · ${PRICE}`,
        on: { click: () => ed.panels.toggleLicence?.() },
      }));
    }

    const modal = ed.modalLabel;
    if (modal) {
      // Enter and Esc are the whole confirm/cancel vocabulary of a modal
      // operator, and a phone has neither key. Lifting the finger commits, so
      // committing was always reachable — cancelling was not, and an operator
      // you cannot back out of is one nobody will risk starting. These are
      // real buttons rather than a hint, which also gives a mouse a visible
      // target instead of a line of text about keys.
      this.centre.append(
        h('button', {
          class: 'modal-act confirm', text: '✓ Confirm',
          title: 'Apply this operation (Enter, or lift your finger)',
          on: { click: () => ed.confirmModal() },
        }),
        h('button', {
          class: 'modal-act cancel', text: '✕ Cancel',
          title: 'Abandon this operation and put everything back (Esc)',
          on: { click: () => ed.cancelModal() },
        }),
      );
      this.right.appendChild(h('span', { class: 'modal-readout', text: modal }));
    } else {
      this.centre.appendChild(h('span', { class: 'dim', text: ed.mode === 'edit' ? 'Tab: back to Object Mode' : 'Tab: edit the active object' }));
      this.right.appendChild(h('span', { text: ed.statusMessage }));
    }
  }
}
