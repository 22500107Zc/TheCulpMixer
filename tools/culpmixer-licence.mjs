#!/usr/bin/env node
/**
 * Mint The Culp Mixer licence keys.
 *
 * You hold the private key; the application holds the public one. That is the
 * whole system. There is no server, no account and no payment code anywhere
 * near it — selling happens wherever you like, and ends with you running this.
 *
 *   node tools/culpmixer-licence.mjs keygen
 *       Make a signing keypair. Writes culpmixer-private-key.pem (KEEP THIS, and
 *       keep it out of the repository) and prints the public key to paste into
 *       src/licence/licence.ts.
 *
 *   node tools/culpmixer-licence.mjs owner --name "Your Name"
 *       Your own licence. Never expires, costs nothing, and is the reason you
 *       can never be charged to use your own application.
 *
 *   node tools/culpmixer-licence.mjs issue --name "Acme Studio" --plan Studio \
 *        --seats 5 --months 1
 *       One month of a subscription. Run it again each month they pay.
 *
 *   node tools/culpmixer-licence.mjs issue --name "Acme" --plan Perpetual --forever
 *       A licence with no expiry.
 *
 *   node tools/culpmixer-licence.mjs check --key "<key>"
 *       Read a key back, to see exactly what a customer has.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PRIVATE_PATH = process.env.CULPMIXER_LICENCE_KEY ?? 'culpmixer-private-key.pem';

const args = process.argv.slice(2);
const command = args[0];

/** --name "x" --seats 3 --forever  ->  { name: 'x', seats: '3', forever: true } */
function options(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith('--')) continue;
    const key = list[i].slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function loadPrivateKey() {
  if (!existsSync(PRIVATE_PATH)) {
    console.error(`No signing key at ${PRIVATE_PATH}.`);
    console.error('Run:  node tools/culpmixer-licence.mjs keygen');
    process.exit(1);
  }
  return createPrivateKey(readFileSync(PRIVATE_PATH, 'utf8'));
}

/** Sign a payload into the two-part key the application verifies. */
function mint(payload) {
  const privateKey = loadPrivateKey();
  const body = base64url(JSON.stringify(payload));
  // P-1363 rather than DER: WebCrypto's ECDSA verify wants the raw r||s form,
  // and Node defaults to DER. Getting this wrong produces a key that looks
  // perfectly well formed and never verifies.
  const signature = sign('sha256', Buffer.from(body), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${body}.${base64url(signature)}`;
}

function printKey(payload, key) {
  console.log('');
  console.log(`  For:     ${payload.name}${payload.email ? ` <${payload.email}>` : ''}`);
  console.log(`  Plan:    ${payload.plan}${payload.owner ? '  (owner — never expires)' : ''}`);
  console.log(`  Seats:   ${payload.seats}`);
  console.log(`  Expires: ${payload.expires === null ? 'never' : new Date(payload.expires).toISOString()}`);
  console.log('');
  console.log('  Key (send this to them, or paste it into Help > Licence):');
  console.log('');
  console.log(`  ${key}`);
  console.log('');
}

switch (command) {
  case 'keygen': {
    if (existsSync(PRIVATE_PATH)) {
      console.error(`${PRIVATE_PATH} already exists. Refusing to overwrite it —`);
      console.error('every key you have ever issued was signed with it.');
      process.exit(1);
    }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(PRIVATE_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const spki = base64url(publicKey.export({ type: 'spki', format: 'der' }));
    console.log('');
    console.log(`  Private key written to ${PRIVATE_PATH}`);
    console.log('  KEEP IT. Back it up. Do not commit it. Anyone who has it can issue licences.');
    console.log('');
    console.log('  Paste this into src/licence/licence.ts as PUBLIC_KEY_SPKI:');
    console.log('');
    console.log(`  export const PUBLIC_KEY_SPKI = '${spki}';`);
    console.log('');
    console.log('  Then mint yourself the licence you will never pay for:');
    console.log('');
    console.log('    node tools/culpmixer-licence.mjs owner --name "Your Name"');
    console.log('');
    break;
  }

  case 'owner': {
    const o = options(args.slice(1));
    const payload = {
      name: typeof o.name === 'string' ? o.name : 'Owner',
      ...(typeof o.email === 'string' ? { email: o.email } : {}),
      plan: 'Owner',
      seats: 0,
      issued: Date.now(),
      expires: null,
      owner: true,
    };
    printKey(payload, mint(payload));
    console.log('  This one never expires and is not counted against anything.');
    console.log('');
    break;
  }

  case 'issue': {
    const o = options(args.slice(1));
    if (typeof o.name !== 'string') {
      console.error('--name is required, e.g. --name "Acme Studio"');
      process.exit(1);
    }
    const months = o.forever ? null : Number(o.months ?? 1);
    if (months !== null && (!Number.isFinite(months) || months <= 0)) {
      console.error('--months must be a positive number, or pass --forever');
      process.exit(1);
    }
    const expires = months === null
      ? null
      : new Date(new Date().setMonth(new Date().getMonth() + months)).getTime();
    const payload = {
      name: o.name,
      ...(typeof o.email === 'string' ? { email: o.email } : {}),
      plan: typeof o.plan === 'string' ? o.plan : 'Subscription',
      seats: Number.isFinite(Number(o.seats)) ? Number(o.seats) : 1,
      issued: Date.now(),
      expires,
    };
    printKey(payload, mint(payload));
    break;
  }

  case 'check': {
    const o = options(args.slice(1));
    const key = typeof o.key === 'string' ? o.key : '';
    const [body, signature] = key.trim().split('.');
    if (!body || !signature) {
      console.error('Pass a whole key: --key "<body>.<signature>"');
      process.exit(1);
    }
    const publicKey = createPublicKey(loadPrivateKey());
    const ok = verify('sha256', Buffer.from(body), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(body64(signature)));
    const payload = JSON.parse(Buffer.from(body64(body)).toString('utf8'));
    console.log('');
    console.log(`  Signature: ${ok ? 'valid' : 'INVALID — this key was not issued by you'}`);
    printKey(payload, key);
    if (payload.expires !== null && payload.expires < Date.now()) {
      console.log('  This key has expired. Issue another with `issue`.');
      console.log('');
    }
    break;
  }

  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').slice(2, 27).map((l) => l.replace(/^ \*ance?\/?/, '').replace(/^ \* ?/, '')).join('\n'));
    process.exit(command ? 1 : 0);
}

function body64(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
