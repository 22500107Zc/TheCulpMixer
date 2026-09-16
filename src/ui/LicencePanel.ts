import { Editor } from '../editor/Editor';
import { button, clear, h } from './dom';
import { PRICE, TERMS } from '../licence/licence';

/**
 * Paying for The Culp Mixer, and the wall that appears when somebody has not.
 *
 * The important thing about this screen is what is *not* on it. No licence
 * key, no serial number, nothing to copy or paste, nothing to be emailed. A
 * customer sees what it costs and a button that takes their money, and when
 * they come back the application is unlocked. That is the entire flow, and
 * everything else here exists to keep it that way when something goes wrong:
 * a second machine, a reinstall, a lapsed card.
 *
 * Locked, this stops being a panel and becomes a wall — full screen, no close
 * button, Escape does nothing. Unlocked, it is an ordinary panel that says
 * what the subscription is.
 */
export class LicencePanel {
  readonly root = h('div', { class: 'overlay-panel licence-panel hidden' });
  private head = h('div', { class: 'overlay-head' });
  private body = h('div', { class: 'licence-body' });
  private note = h('p', { class: 'dim small licence-note' });
  private email = h('input', {
    class: 'licence-email',
    type: 'email',
    placeholder: 'you@example.com',
  }) as HTMLInputElement;
  private password = h('input', {
    class: 'licence-email',
    type: 'password',
    placeholder: 'Password',
  }) as HTMLInputElement;
  private keyInput = h('textarea', {
    class: 'code-area licence-input',
    placeholder: 'Paste a licence key',
  }) as HTMLTextAreaElement;
  private busy = false;

  constructor(private editor: Editor) {
    this.email.autocomplete = 'email';
    this.password.autocomplete = 'current-password';
    // Enter in either field signs in, because that is what Enter means in a
    // pair of boxes with a Sign in button under them.
    for (const field of [this.email, this.password]) {
      field.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') void this.signIn();
      });
    }
    this.root.append(this.head, this.body);
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
  }

  hide(): void {
    // While The Culp Mixer is locked this is the only way back in, so it stays.
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

    this.head.append(h('h2', { text: locked ? 'Your free trial has ended' : 'Licence' }));
    // No way out of a wall except paying. A close button here would look like
    // an escape and would not be one.
    if (!locked) {
      this.head.append(h('button', {
        class: 'icon-btn', text: '✕', title: 'Close',
        on: { click: () => this.hide() },
      }));
    }
    this.root.classList.toggle('licence-wall', locked);

    if (state.status === 'source') {
      this.body.append(
        h('p', { class: 'licence-state', text: this.editor.licenceSummary }),
        h('p', {
          class: 'dim small',
          text: 'This copy was built from source, so there is nothing to unlock — everything '
            + 'works. Shipped builds ask for a subscription after the trial.',
        }),
      );
      return;
    }

    this.body.append(h('p', { class: 'licence-state', text: this.editor.licenceSummary }));

    if (state.status === 'owner') {
      this.body.append(
        h('p', {
          class: 'dim small',
          text: 'An owner licence. It does not expire and it is not counted against anything.',
        }),
        this.note,
      );
      return;
    }

    if (state.status === 'licensed') {
      this.body.append(
        h('p', { class: 'dim small', text: `Subscribed at ${PRICE}. It renews on its own.` }),
        h('p', {
          class: 'dim small',
          text: 'Using The Culp Mixer on another machine: open this panel there and sign in with the '
            + 'same details.',
        }),
        this.signInBlock(),
        this.note,
      );
      return;
    }

    if (state.status === 'trial') {
      this.body.append(
        h('p', { class: 'dim small', text: TERMS }),
        h('p', {
          class: 'dim small',
          text: 'Paying does not cut the trial short and does not charge you twice.',
        }),
        h('p', { class: 'dim small licence-restore-label', text: 'Already have an account?' }),
        this.signInBlock(),
        this.note,
      );
      return;
    }

    // Locked. Everything on this screen is about getting them working again.
    this.body.append(h('p', { class: 'licence-price', text: PRICE }));
    this.body.append(h('p', { class: 'licence-blocked', text: this.editor.licenceBlockedMessage }));

    this.body.append(h('div', { class: 'btn-row licence-buy' }, [
      button('Sign in or create an account', () => this.editor.emit('licence'), { class: 'primary' }),
    ]));

    this.body.append(h('ul', { class: 'licence-list' }, [
      h('li', { text: 'Every file you have already saved is still on your disk, untouched.' }),
      h('li', { text: 'Nothing has been deleted and nothing has been sent anywhere.' }),
      h('li', { text: 'Paying unlocks everything straight away, here and in the desktop app.' }),
      h('li', { text: 'Cancel whenever you like. What you made with The Culp Mixer stays yours for ever.' }),
    ]));

    this.body.append(
      h('p', {
        class: 'dim small licence-restore-label',
        text: 'Already have an account, or already paid? Sign in.',
      }),
      this.signInBlock(),
      this.note,
      this.advanced(),
    );
  }

  /**
   * Signing in.
   *
   * Two boxes and a button, which is what everybody already knows how to do.
   * It covers both kinds of customer: an account made for them in the founder
   * console, and somebody who paid Stripe and is now on a second machine —
   * the second only needs the email, so the password is optional and the
   * button does the right thing either way.
   */
  private signInBlock(): HTMLElement {
    return h('div', { class: 'licence-signin' }, [
      h('div', { class: 'btn-row licence-restore' }, [this.email, this.password]),
      h('div', { class: 'btn-row' }, [
        button('Sign in', () => void this.signIn(), { class: 'primary' }),
      ]),
    ]);
  }

  /**
   * The key box, folded away.
   *
   * No customer ever needs this — it is how the owner applies their own
   * perpetual key, and a way back in if the server is ever unreachable for
   * long enough to matter. Out of the way rather than gone.
   */
  private advanced(): HTMLElement {
    return h('details', { class: 'licence-advanced' }, [
      h('summary', { text: 'Have a licence key?' }),
      this.keyInput,
      h('div', { class: 'btn-row' }, [
        button('Apply key', () => void this.applyKey()),
        button('Remove key', () => void this.applyKey('')),
      ]),
    ]);
  }

  private say(message: string, bad = false): void {
    this.note.textContent = message;
    this.note.classList.toggle('licence-bad', bad);
  }

  private async signIn(): Promise<void> {
    const email = this.email.value.trim();
    const password = this.password.value;
    if (!email) {
      this.say('Put your email in.', true);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.say('Signing in…');
    try {
      // With a password, it is an account. Without one, it is somebody who
      // paid Stripe and is unlocking another machine — the same button,
      // because a customer should not have to know which kind they are.
      const result = password
        ? await this.editor.signIn(email, password)
        : await this.restoreByEmail(email);
      this.say(result.message, !result.ok);
      if (result.ok) {
        this.password.value = '';
        this.render();
      }
    } finally {
      this.busy = false;
    }
  }

  /** The no-password path: a Stripe customer on a machine they have not used. */
  private async restoreByEmail(email: string): Promise<{ ok: boolean; message: string }> {
    await this.editor.syncLicence({ email });
    if (this.editor.canUse) return { ok: true, message: 'Found it. You are unlocked.' };
    return {
      ok: false,
      message: `Nothing found for ${email}. If you have an account, put the password in too. `
        + 'If you paid with a different address, try that one — nothing has been charged twice.',
    };
  }

  private async applyKey(value?: string): Promise<void> {
    const key = value === undefined ? this.keyInput.value : value;
    const result = await this.editor.applyLicenceKey(key);
    this.say(result.message, !result.ok);
    if (result.ok) this.render();
  }
}
