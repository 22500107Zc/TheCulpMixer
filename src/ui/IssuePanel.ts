import { Editor } from '../editor/Editor';
import { PRICE } from '../licence/licence';
import { forgetSigningKey, handoutFor, hasSigningKey, issueKey, rememberSigningKey } from '../licence/issue';
import { localPaymentLink, setLocalPaymentLink } from '../licence/payment';
import { button, clear, h } from './dom';

/**
 * Turning a payment into a working account, from inside the application.
 *
 * The shape of the business is: somebody signs up, uses it for thirty-three
 * hours, pays, and gets back in. Every part of that ran with nothing
 * configured except the last one — switching a paying customer on needed the
 * account service, which needed a signing key on the host, a database and a
 * set of environment variables. Until all of that was finished a customer
 * could pay and still be locked out, which is the one failure a business
 * cannot survive on its first day.
 *
 * So the founder does it here. Type who paid, press the button, send them the
 * message it writes. Their key is signed on this machine against the same
 * public key that is built into every copy, so it is checked offline, on any
 * machine, forever — no server involved at any point on either side.
 *
 * Only the owner sees this. The gate is the licence status, not a flag in a
 * database: an owner licence is a signature, and a signature cannot be turned
 * on by editing storage.
 */
export class IssuePanel {
  readonly root = h('div', { class: 'overlay-panel issue-panel hidden' });
  private body = h('div', { class: 'issue-body' });
  private note = h('p', { class: 'dim small issue-note' });
  private name = field('text', 'Their name (optional)');
  private email = field('email', 'them@example.com');
  private months = h('select', { class: 'issue-select' }) as HTMLSelectElement;
  private keyPem = h('textarea', {
    class: 'issue-pem',
    placeholder: '-----BEGIN PRIVATE KEY-----',
  }) as HTMLTextAreaElement;
  private out = h('pre', { class: 'issue-out hidden' });
  private payLink = field('url', 'https://buy.stripe.com/…');
  private payNote = h('p', { class: 'dim small issue-note' });
  private payOut = h('pre', { class: 'issue-out hidden' });
  private busy = false;

  constructor(private editor: Editor) {
    for (const [value, label] of [
      ['1', '1 month'], ['3', '3 months'], ['6', '6 months'],
      ['12', '12 months'], ['forever', 'Never expires'],
    ]) {
      this.months.appendChild(h('option', { value, text: label }));
    }
    this.email.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void this.issue();
    });
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'Founder settings' }),
        button('Close', () => this.hide(), { class: 'icon-btn' }),
      ]),
      this.body,
    );
    this.editor.on('licence', () => { if (this.visible) this.render(); });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  toggle(): void {
    if (this.visible) { this.hide(); return; }
    this.render();
    this.root.classList.remove('hidden');
  }

  /** Whether this machine is the founder's. A signature, not a setting. */
  private get isOwner(): boolean {
    return this.editor.licence.status === 'owner';
  }

  private render(): void {
    clear(this.body);
    if (!this.isOwner) {
      this.body.append(h('p', {
        class: 'dim',
        text: 'Only the founder issues licences. Sign in on the Founder tab first.',
      }));
      return;
    }

    if (!hasSigningKey()) {
      this.renderSetup();
      // Where people pay has nothing to do with whether this machine can sign
      // keys, and gating it behind the signing key meant the founder could not
      // set the payment link until after they had pasted a private key. Two
      // unrelated things; both belong to the owner and both are here.
      this.body.append(this.paymentSection());
      return;
    }

    this.body.append(
      h('p', { class: 'dim small' }, [
        h('span', {
          text: 'Somebody paid. Put their email in, press the button, and send them what it '
            + 'writes. Their key is checked on their machine against the key built into every '
            + 'copy, so nothing here has to be online — theirs or yours.',
        }),
      ]),
      labelled('Their name', this.name),
      labelled('Their email', this.email),
      labelled('How long', this.months),
      h('div', { class: 'issue-actions' }, [
        button(`Issue a key — ${PRICE}`, () => void this.issue(), { class: 'primary issue-go' }),
        button('Copy', () => void this.copy(), { class: 'issue-copy' }),
      ]),
      this.note,
      this.out,
      this.paymentSection(),
      h('details', { class: 'issue-advanced' }, [
        h('summary', { text: 'The signing key on this machine' }),
        h('p', {
          class: 'dim small',
          text: 'It is kept in this browser and nowhere else. It is never sent anywhere and '
            + 'never goes out to a customer — what they get is one signed key for themselves.',
        }),
        h('div', { class: 'issue-actions' }, [
          button('Forget it on this machine', () => {
            forgetSigningKey();
            this.say('Removed. Keys cannot be issued here until it is added again.');
            this.render();
          }, { class: 'issue-forget' }),
        ]),
      ]),
    );
  }

  /**
   * Where people pay, set here rather than in code.
   *
   * Typing it takes effect immediately on this machine, so the lock screen can
   * be looked at before a customer ever sees it. Publishing it to everybody is
   * a separate step and says so plainly: a browser cannot hand a value to
   * other browsers, so it has to be served from somewhere. The panel writes
   * out exactly what to paste and where.
   */
  private paymentSection(): HTMLElement {
    const current = localPaymentLink();
    if (current) this.payLink.value = current;
    // Not folded away in a <details>. This is the setting that decides whether
    // a customer who has hit the wall can hand over money, so it is on screen.
    const section = h('div', { class: 'issue-pay' }, [
      h('h3', { class: 'issue-heading', text: 'Where people pay when their 33 hours are up' }),
      h('p', {
        class: 'dim small',
        text: 'The button on the lock screen goes here. Stripe payment link, PayPal, an '
          + 'invoice page — anything that takes money. Leave it empty and they are given '
          + 'your email instead, which still works.',
      }),
      labelled('Payment link', this.payLink),
      h('div', { class: 'issue-actions' }, [
        button('Save', () => this.savePayment(), { class: 'primary issue-go' }),
        button('Show the lock screen', () => {
          this.hide();
          this.editor.previewLocked?.();
        }, { class: 'issue-preview' }),
      ]),
      this.payNote,
      this.payOut,
    ]);
    return section;
  }

  private savePayment(): void {
    const result = setLocalPaymentLink(this.payLink.value);
    if (!result.ok) {
      this.payNote.textContent = result.message;
      this.payNote.classList.add('issue-bad');
      return;
    }
    this.payNote.classList.remove('issue-bad');
    if (!result.link) {
      this.payNote.textContent = 'Cleared. The lock screen offers your email instead.';
      this.payOut.classList.add('hidden');
      return;
    }
    this.payNote.textContent = 'Saved, and live on this machine. To publish it to everybody, '
      + 'do one of the two below.';
    this.payOut.textContent = [
      'Either — put this one line in Vercel and redeploy.',
      '  Settings > Environment Variables > Production',
      '',
      '    KLINE_PAYMENT_LINK',
      `    ${result.link}`,
      '',
      'Or — edit public/pay.json in the repository so it reads:',
      '',
      '    {',
      `      "paymentLink": "${result.link}"`,
      '    }',
      '',
      'Either one, and every customer past their 33 hours is sent there.',
    ].join('\n');
    this.payOut.classList.remove('hidden');
  }

  /** First run on a machine: the key has to get here once. */
  private renderSetup(): void {
    this.body.append(
      h('p', { class: 'dim small' }, [
        h('strong', { text: 'One thing, once, on this machine. ' }),
        h('span', {
          text: 'Paste the signing key below and it is kept in this browser. It is what turns '
            + 'a payment into a working account, and it stays here — it is never sent anywhere '
            + 'and never reaches a customer.',
        }),
      ]),
      this.keyPem,
      h('div', { class: 'issue-actions' }, [
        button('Keep it on this machine', () => void this.remember(), { class: 'primary issue-go' }),
      ]),
      this.note,
      h('p', {
        class: 'dim small',
        text: 'It is the kline-private-key.pem file. If it is lost, keys already issued keep '
          + 'working and no new ones can be made, so it is worth a backup somewhere that is '
          + 'not a browser.',
      }),
    );
  }

  private async remember(): Promise<void> {
    const result = await rememberSigningKey(this.keyPem.value);
    if (!result.ok) { this.say(result.message, true); return; }
    this.keyPem.value = '';
    this.say('Kept. You can issue licences from this machine now.');
    this.render();
  }

  private async issue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Signing…');
    try {
      const value = this.months.value;
      const result = await issueKey({
        name: this.name.value,
        email: this.email.value,
        months: value === 'forever' ? null : Number(value),
      });
      if (!result.ok) { this.say(result.message, true); return; }
      this.out.textContent = handoutFor(result.payload, result.key, location.origin || '');
      this.out.classList.remove('hidden');
      this.say(`Issued for ${result.payload.email}. Send them the message below.`);
    } finally {
      this.busy = false;
    }
  }

  private async copy(): Promise<void> {
    const text = this.out.textContent ?? '';
    if (!text) { this.say('Issue one first.', true); return; }
    try {
      await navigator.clipboard.writeText(text);
      this.say('Copied. Paste it into an email.');
    } catch {
      // Clipboard refused. Select it so it can still be copied by hand, which
      // is the only thing left that helps.
      const range = document.createRange();
      range.selectNodeContents(this.out);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      this.say('Selected it — press Cmd/Ctrl+C.');
    }
  }

  private say(message: string, bad = false): void {
    this.note.textContent = message;
    this.note.classList.toggle('issue-bad', bad);
  }
}

function field(type: string, placeholder: string): HTMLInputElement {
  const input = h('input', { class: 'issue-field', type, placeholder }) as HTMLInputElement;
  input.autocomplete = 'off';
  return input;
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'issue-row' }, [h('span', { text: label }), control]);
}
