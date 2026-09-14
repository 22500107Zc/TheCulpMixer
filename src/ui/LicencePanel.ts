import { Editor } from '../editor/Editor';
import { button, clear, h } from './dom';
import { PRICE, TERMS } from '../licence/licence';

/**
 * Where a licence key goes in.
 *
 * Deliberately plain and deliberately honest. It says what state this copy is
 * in, what is and is not affected by that, and — where the answer is "the
 * trial has finished" — what specifically has paused. It never says a person's
 * work is at risk, because it never is.
 */
export class LicencePanel {
  readonly root = h('div', { class: 'overlay-panel licence-panel hidden' });
  private head = h('div', { class: 'overlay-head' });
  private body = h('div', { class: 'licence-body' });
  private input = h('textarea', {
    class: 'code-area licence-input',
    placeholder: 'Paste your licence key here',
  }) as HTMLTextAreaElement;
  private note = h('p', { class: 'dim small licence-note' });

  constructor(private editor: Editor) {
    this.root.append(
      this.head,
      this.body,
    );
    this.editor.on('licence', () => {
      if (this.visible) this.render();
    });
    // Escape closes it, in the capture phase so it does not reach a modal
    // transform underneath.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Locked means the panel is a wall, not a window: it does not close. */
  private get locked(): boolean {
    return !this.editor.canUse && this.editor.licence.status !== 'source';
  }

  show(): void {
    this.render();
    this.root.classList.remove('hidden');
    this.input.focus();
  }

  hide(): void {
    // While Kline is locked this is the only way back in, so it stays.
    if (this.locked) return;
    this.root.classList.add('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  private render(): void {
    clear(this.head);
    clear(this.body);
    const state = this.editor.licence;
    const locked = this.locked;

    this.head.append(h('h2', { text: locked ? 'Kline is locked' : 'Licence' }));
    // No way out of a wall except a key. A close button here would look like
    // an escape and would not be one.
    if (!locked) {
      this.head.append(h('button', {
        class: 'icon-btn', text: '✕', title: 'Close',
        on: { click: () => this.hide() },
      }));
    }
    this.root.classList.toggle('licence-wall', locked);

    this.body.append(h('p', { class: 'licence-state', text: this.editor.licenceSummary }));

    if (state.status !== 'source') {
      this.body.append(h('p', { class: 'dim small licence-terms', text: TERMS }));
    }

    if (state.status === 'source') {
      this.body.append(h('p', {
        class: 'dim small',
        text: 'This copy was built from source, so there is nothing to unlock — everything '
          + 'works. A licence key is only needed for a build somebody else shipped you.',
      }));
      return;
    }

    if (state.status === 'owner') {
      this.body.append(h('p', {
        class: 'dim small',
        text: 'An owner licence. It does not expire and it is not counted against anything.',
      }));
    }

    if (locked) {
      this.body.append(h('p', { class: 'licence-price', text: PRICE }));
      this.body.append(h('p', { class: 'licence-blocked', text: this.editor.licenceBlockedMessage }));
      this.body.append(h('ul', { class: 'licence-list' }, [
        h('li', { text: 'Every file you have already saved is still on your disk, untouched.' }),
        h('li', { text: 'Nothing has been deleted and nothing has been sent anywhere.' }),
        h('li', { text: 'A licence key unlocks everything again immediately.' }),
      ]));
    }

    this.input.value = '';
    this.note.textContent = '';
    this.body.append(
      this.input,
      h('div', { class: 'btn-row' }, [
        button('Apply key', () => void this.apply(), { class: 'primary' }),
        button('Remove key', () => void this.apply('')),
      ]),
      this.note,
    );
  }

  private async apply(value?: string): Promise<void> {
    const key = value === undefined ? this.input.value : value;
    const result = await this.editor.applyLicenceKey(key);
    this.note.textContent = result.message;
    this.note.classList.toggle('licence-bad', !result.ok);
    if (result.ok) this.render();
  }
}
