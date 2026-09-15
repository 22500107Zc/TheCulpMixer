import { h } from './dom';

/**
 * "You have unsaved work."
 *
 * The one dialog a document application owes people, and the one The Culp Mixer did not
 * have. `File > New` wiped the scene on the spot, `File > Open` replaced it,
 * and closing the desktop window took it with no question asked — the only
 * safety net was an autosave that a person had no reason to know about and no
 * obvious way to reach.
 *
 * Three answers, not two. "Cancel" is the one that matters: a dialog offering
 * only Save and Discard makes the question a trap, because somebody who
 * realises mid-prompt that they opened the wrong menu has no way back.
 */

export type UnsavedAnswer = 'save' | 'discard' | 'cancel';

export function askUnsaved(action: string): Promise<UnsavedAnswer> {
  if (typeof document === 'undefined') return Promise.resolve('discard');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: UnsavedAnswer): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(answer);
    };

    const onKey = (e: KeyboardEvent): void => {
      // Stopped as well as handled: the viewport listens for single keys, and
      // a stray G while this is up would start a move behind the dialog.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish('cancel');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish('save');
      }
    };

    const button = (
      label: string, answer: UnsavedAnswer, cls: string, title: string,
    ): HTMLElement => {
      const el = h('button', { class: cls, text: label, title });
      el.addEventListener('click', () => finish(answer));
      return el;
    };

    const root = h('div', { class: 'unsaved-dialog' }, [
      h('div', { class: 'unsaved-card' }, [
        h('div', { class: 'overlay-head' }, [h('h2', { text: 'Unsaved changes' })]),
        h('p', {
          class: 'unsaved-body',
          text: `This project has changes that have not been saved to a file. ${action}`,
        }),
        h('div', { class: 'btn-row unsaved-actions' }, [
          button('Save', 'save', 'btn primary', 'Save the project, then carry on.'),
          button('Discard', 'discard', 'btn', 'Lose the changes and carry on.'),
          button('Cancel', 'cancel', 'btn', 'Stay here and change nothing.'),
        ]),
      ]),
    ]);

    // Clicking the backdrop is a cancel: it is the least destructive reading
    // of a click somebody may not have meant to make.
    root.addEventListener('click', (e) => {
      if (e.target === root) finish('cancel');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    (root.querySelector('.btn.primary') as HTMLElement | null)?.focus();
  });
}
