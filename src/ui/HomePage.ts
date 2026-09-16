import { Editor } from '../editor/Editor';
import { PRICE } from '../licence/licence';
import { resolvePaymentLink } from '../licence/payment';

/** The one address behind The Culp Mixer. */
const CONTACT = 'culpindustriesllc@gmail.com';
import { button, clear, h } from './dom';

/**
 * The front door.
 *
 * The first thing anybody sees at the link: what The Culp Mixer is, what it costs, who
 * is behind it, and two boxes to make an account. It covers the whole window
 * until they are signed in, and it comes back the moment their thirty-three
 * hours run out — at which point the only thing on it is the way to pay.
 *
 * Three decisions worth writing down, because each is a thing people expect
 * and will not find:
 *
 * 1. **No confirmation email.** They pick a username, an email and a password,
 *    and they are in. Nothing to go to their inbox for, nothing to click,
 *    nothing to get stuck in a spam folder at the exact moment they were
 *    interested. They are told plainly to remember what they typed.
 * 2. **The countdown is on this page.** Somebody who is going to be asked for
 *    money in thirty-three hours should be able to see that from the first
 *    minute, not discover it when the application stops.
 * 3. **It says one person runs The Culp Mixer.** That is why approval is by hand, why
 *    it may take a moment, and why paying from a different address is fine.
 *    Saying it up front turns a support complaint into an expectation.
 */
/**
 * Whether this visit is the founder's rather than a customer's.
 *
 * Asked of the address bar, not of any stored state, so it costs a customer
 * nothing and cannot be stumbled into. `?founder` or `#founder` both work —
 * one is easier to bookmark, the other survives being pasted around without
 * a query string. This reveals the tab; it does not sign anybody in. The
 * password still has to unseal the owner key, exactly as before.
 */
export function founderRequested(search = typeof location === 'undefined' ? '' : location.search,
  hash = typeof location === 'undefined' ? '' : location.hash): boolean {
  return /(^|[?&])founder(=|&|$)/.test(search) || /^#founder$/.test(hash);
}

export class HomePage {
  readonly root = h('div', { class: 'home hidden' });
  private card = h('div', { class: 'home-card' });
  private note = h('p', { class: 'home-note' });
  private username = field('text', 'Username');
  private email = field('email', 'you@example.com');
  private password = field('password', 'Password — 8 characters or more');
  private mode: 'signup' | 'signin' | 'founder' | 'locked' = 'signup';
  /** Where people pay, from whichever source has one. Resolved, not guessed. */
  private payTo: string | null = null;
  private busy = false;

  constructor(private editor: Editor) {
    this.root.append(this.card);
    for (const input of [this.username, this.email, this.password]) {
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') void this.submit();
      });
    }
    this.editor.on('licence', () => this.refresh());
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /**
   * Show the lock screen now, for the founder to look at.
   *
   * Checking what a customer sees at the worst moment of the relationship
   * should not require waiting thirty-three hours or editing a clock.
   */
  preview(): void {
    this.mode = 'locked';
    void resolvePaymentLink(this.editor.account?.paymentLink).then((link) => {
      this.payTo = link;
      this.render();
    });
    this.render();
    this.root.classList.remove('hidden');
  }

  /** Show or hide according to where the account stands. Never guesses. */
  refresh(): void {
    const account = this.editor.account;
    // A key already unlocks this copy — the owner's own, or one issued by
    // hand. That is settled without a server, so there is nothing to ask.
    // Not 'source': that is the value before the real answer has arrived, so
    // treating it as unlocked made the door open and shut on every load.
    const byKey = this.editor.licence.status === 'owner'
      || this.editor.licence.status === 'licensed';
    if (byKey) {
      this.root.classList.add('hidden');
      return;
    }
    const needed = !account || account.status === 'locked';
    if (needed) {
      if (account?.status === 'locked') this.mode = 'locked';
      this.render();
      this.root.classList.remove('hidden');
      // The link can come from the account service, from a file served next to
      // the application, or from the founder's own machine. Looked up rather
      // than read off the account, and re-rendered when the answer lands so a
      // slow lookup never leaves somebody on a screen with no way to pay.
      if (this.mode === 'locked') {
        void resolvePaymentLink(account?.paymentLink).then((link) => {
          if (link === this.payTo) return;
          this.payTo = link;
          if (this.visible && this.mode === 'locked') this.render();
        });
      }
    } else {
      this.root.classList.add('hidden');
    }
  }

  private render(): void {
    clear(this.card);
    const account = this.editor.account;

    this.card.append(
      h('div', { class: 'home-brand' }, [
        h('h1', { class: 'home-title', text: 'The Culp Mixer' }),
        h('p', {
          class: 'home-tagline',
          text: 'A 3D modelling application that runs on your machine. Mesh editing, '
            + 'sculpting, UV unwrapping, rigging, animation and a path-traced renderer.',
        }),
      ]),
    );

    if (account?.status === 'locked') {
      this.renderLocked(account);
      return;
    }

    this.card.append(
      h('p', { class: 'home-terms' }, [
        h('strong', { text: '33 hours free.' }),
        h('span', { text: ` Then ${PRICE}. One account covers your whole team.` }),
      ]),
      h('div', { class: 'home-tabs' }, [
        tab('Create an account', this.mode === 'signup', () => {
          this.mode = 'signup';
          this.render();
        }),
        tab('Log in', this.mode === 'signin', () => {
          this.mode = 'signin';
          this.render();
        }),
        // The founder's door is deliberately not here.
        //
        // It used to be a third tab, sitting between "Create an account" and
        // "Log in", on the first screen every customer sees. Whatever it does,
        // what it *says* to somebody deciding whether to pay is that this is
        // one person's side project and they are looking at the back office.
        // Nobody else puts an admin login on their sign-up page.
        //
        // It is still one tab away for the person who needs it — ?founder on
        // the address, or the console at founder.html — and invisible to
        // everybody else. See founderRequested().
        ...(founderRequested() ? [tab('Founder', this.mode === 'founder', () => {
          this.mode = 'founder';
          this.render();
        })] : []),
      ]),
    );

    const fields = this.mode === 'signup'
      ? [this.username, this.email, this.password]
      : [this.email, this.password];
    for (const input of fields) this.card.append(input);

    if (this.mode === 'founder') {
      // Prefilled, because there is exactly one address that opens it and
      // making somebody type it every time is friction for no gain.
      this.email.value = CONTACT;
    }

    this.card.append(
      h('div', { class: 'home-actions' }, [
        button(
          this.mode === 'signup' ? 'Create account and start'
            : this.mode === 'founder' ? 'Sign in as founder'
              : 'Log in',
          () => void this.submit(),
          { class: 'primary home-go' },
        ),
      ]),
      this.note,
    );

    if (this.mode === 'founder') {
      this.card.append(h('p', {
        class: 'home-small',
        text: 'The owner\u2019s way in. It works with no server and on any machine, and it '
          + 'never expires. Once you are in, the founder console is a button in the bar '
          + 'along the bottom.',
      }));
    }

    if (this.mode === 'signup') {
      this.card.append(h('p', {
        class: 'home-small',
        text: this.editor.accountsAvailable
          ? 'No confirmation email and nothing to click — you are in as soon as you press '
            + 'the button. Remember what you typed: it is how you get back in, on this '
            + 'machine and on any other.'
          : 'No confirmation email and nothing to click — you are in as soon as you press '
            + 'the button. Remember what you typed. This account is kept on this machine, '
            + 'so use the same browser to come back to it.',
      }));
    }

    this.card.append(this.keyBox(), this.founderNote());
    window.setTimeout(() => fields[0]?.focus(), 0);
  }

  /** Past the trial. One thing on the screen, and it is how to pay. */
  private renderLocked(account: NonNullable<Editor['account']>): void {
    this.card.append(
      h('p', { class: 'home-locked-title', text: 'Your 33 hours are up' }),
      h('p', { class: 'home-price', text: PRICE }),
      h('p', {
        class: 'home-locked-body',
        text: 'Everything you made is still on your disk, untouched. Nothing has been deleted '
          + 'and nothing has been sent anywhere.',
      }),
    );

    const payTo = this.payTo ?? account.paymentLink ?? null;
    if (payTo) {
      this.card.append(h('div', { class: 'home-actions' }, [
        payLink(`Pay — ${PRICE}`, payTo),
      ]));
      this.card.append(h('ol', { class: 'home-steps' }, [
        h('li', { text: 'Pay through the link.' }),
        h('li', { text: `Email ${CONTACT} saying which address you paid from.` }),
        h('li', { text: 'Your account is switched on by hand, and you carry on here.' }),
      ]));
    } else {
      // No link configured. Not a dead end: the address that answers is on
      // the screen, which is a working way to buy something from one person.
      this.card.append(h('div', { class: 'home-actions' }, [
        payLink(`Email to pay — ${PRICE}`, `mailto:${CONTACT}`
          + '?subject=The%20Culp%20Mixer%20-%20I%20would%20like%20to%20subscribe'
          + '&body=My%20trial%20has%20ended%20and%20I%20would%20like%20to%20pay%20for%20'
          + 'The%20Culp%20Mixer%20at%20%24199%2Fmonth.'),
      ]));
      this.card.append(h('ol', { class: 'home-steps' }, [
        h('li', { text: `Email ${CONTACT} and you will be sent a way to pay.` }),
        h('li', { text: 'Once you have, you are sent a key.' }),
        h('li', { text: 'Paste it below under "Have a licence key?" and carry on.' }),
      ]));
    }

    this.card.append(
      h('p', {
        class: 'home-small',
        text: `Paid from a different address? That is fine — say so and the address that paid `
          + 'gets the access. One account covers your whole team.',
      }),
      h('div', { class: 'home-actions' }, [
        button('Log in with another account', () => {
          this.editor.signOutOfKline();
          this.mode = 'signin';
          this.render();
        }),
      ]),
      this.note,
      this.keyBox(),
      this.founderNote(),
    );
  }

  /**
   * A licence key, folded away.
   *
   * The way in that needs no server at all: it is verified here, against the
   * public key built into this copy. The owner's own key lives here, and so
   * does anyone issued one by hand — so a host that is misconfigured, or a
   * laptop with no network, is never the reason somebody cannot open the
   * application they paid for.
   */
  private keyBox(): HTMLElement {
    // Deliberately not .code-area: that class belongs to the program editor,
    // and this box is in the DOM whenever the front door is, so sharing it
    // made every selector for the editor match twice.
    const box = h('textarea', {
      class: 'home-key',
      placeholder: 'Paste a licence key',
    }) as HTMLTextAreaElement;
    return h('details', { class: 'home-advanced' }, [
      h('summary', { text: 'Have a licence key?' }),
      box,
      h('div', { class: 'home-actions' }, [
        // Deliberately not .home-go: that class is the one primary action on
        // the page, and two of them is both a design mistake and a selector
        // that matches twice.
        button('Apply key', () => void this.applyKey(box.value), { class: 'home-key-apply' }),
      ]),
    ]);
  }

  private async applyKey(key: string): Promise<void> {
    const result = await this.editor.applyLicenceKey(key);
    this.say(result.message, !result.ok);
    if (result.ok) this.refresh();
  }

  /**
   * Who is behind this.
   *
   * On the page because it is the answer to three questions at once: why
   * approval is by hand, why it might take an hour rather than a second, and
   * who somebody is actually buying from.
   */
  private founderNote(): HTMLElement {
    return h('p', { class: 'home-founder' }, [
      h('strong', { text: 'One person runs The Culp Mixer.' }),
      h('span', {
        text: ' Not a company, not a team — one founder, who wrote it and answers the email. '
          + 'That is why accounts are switched on by hand after you pay, and why it is worth '
          + 'saying which address you paid from.',
      }),
    ]);
  }

  private say(message: string, bad = false): void {
    this.note.textContent = message;
    this.note.classList.toggle('home-bad', bad);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say(this.mode === 'signup' ? 'Making your account…' : 'Logging in…');
    try {
      const result = this.mode === 'signup'
        ? await this.editor.createAccount(
          this.username.value.trim(), this.email.value.trim(), this.password.value,
        )
        : await this.editor.logIn(this.email.value.trim(), this.password.value);
      if (result.ok) {
        this.password.value = '';
        this.say('');
        this.refresh();
      } else {
        this.say(result.message, true);
      }
    } finally {
      this.busy = false;
    }
  }
}

/** A real anchor, so it works with a middle click and a right click too. */
function payLink(label: string, href: string): HTMLElement {
  const link = h('a', { class: 'btn primary home-go', text: label }) as HTMLAnchorElement;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function field(type: string, placeholder: string): HTMLInputElement {
  const input = h('input', { class: 'home-field', type, placeholder }) as HTMLInputElement;
  input.autocomplete = type === 'password' ? 'current-password' : type === 'email' ? 'email' : 'username';
  return input;
}

function tab(label: string, active: boolean, onClick: () => void): HTMLElement {
  return h('button', {
    class: `home-tab${active ? ' active' : ''}`,
    text: label,
    on: { click: onClick },
  });
}
