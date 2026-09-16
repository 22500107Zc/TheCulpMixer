#!/usr/bin/env node
/**
 * Seal the signing key with the founder password.
 *
 *   node tools/kline-seal-signing-key.mjs "<founder password>"
 *
 * Prints a block to paste into src/licence/founder.ts.
 *
 * What this is for, and why it is worth the trade it makes.
 *
 * Issuing a licence means signing one, and signing needs the private key. Up
 * to now that meant the founder had to hold a .pem file and paste it into the
 * application before the Issue button would do anything. That is a file to
 * keep, a file to lose, and a file to find again on a phone at the moment
 * somebody wants to pay — and losing it is unrecoverable, because the public
 * half is baked into every shipped build. One lost file and no licence can
 * ever be issued again.
 *
 * So the signing key is sealed the same way the owner key already is: the
 * founder password is what decrypts it, and signing in as the founder is what
 * makes issuing possible. No file, nothing to keep, nothing to lose — the
 * password is the whole of it, on any machine, with no server.
 *
 * AES-GCM, PBKDF2-SHA256 at 310,000 iterations, exactly as the owner key.
 *
 * THE HONEST LIMIT, and it is a real one. This ciphertext ships to everybody
 * who loads the site. The owner key sealed beside it only ever unlocked one
 * person's copy; this one MINTS LICENCES. If somebody guesses the password
 * they can issue keys as you, for ever, and the only remedy is a new keypair
 * and a new build that invalidates every licence already sold.
 *
 * Which means the password is now the entire security of the product, and it
 * has to be chosen like it. Not a word and a date — those fall to an offline
 * guessing attack that costs a few dollars of compute. Four or five unrelated
 * words, or twenty-plus random characters. Change it with this tool whenever
 * you like; re-sealing is cheap and breaks nothing already issued, because the
 * keypair itself does not change.
 */
import { pbkdf2Sync, randomBytes, createCipheriv, createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const password = process.argv.slice(2).join(' ').trim();
if (!password) {
  console.error('Usage: node tools/kline-seal-signing-key.mjs "<founder password>"');
  process.exit(1);
}
if (password.includes('\0')) {
  console.error('A password cannot contain a NUL byte.');
  process.exit(1);
}
if (password.length < 12) {
  console.error(`That password is ${password.length} characters. This ciphertext ships to`);
  console.error('everybody, and it mints licences. Use twenty or more, or four unrelated words.');
  process.exit(1);
}

const PEM = 'kline-private-key.pem';
if (!existsSync(PEM)) {
  console.error(`${PEM} is not here. It is the key the shipped public key was derived from;`);
  console.error('without it this cannot be sealed, and a new one would invalidate every');
  console.error('licence already issued.');
  process.exit(1);
}

const pem = readFileSync(PEM, 'utf8').trim();
// Fail here rather than shipping a sealed blob that turns out not to be a key.
try {
  createPrivateKey(pem);
} catch (err) {
  console.error(`${PEM} is not a usable private key: ${err.message}`);
  process.exit(1);
}

const ITERATIONS = 310000;
const salt = randomBytes(16);
const iv = randomBytes(12);
const secret = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', secret, iv);
const sealed = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

const b64 = (b) => b.toString('base64');

console.log('');
console.log('  Paste into src/licence/founder.ts:');
console.log('');
console.log('export const SEALED_SIGNING_KEY = {');
console.log(`  salt: '${b64(salt)}',`);
console.log(`  iv: '${b64(iv)}',`);
console.log(`  data: '${b64(Buffer.concat([sealed, tag]))}',`);
console.log(`  iterations: ${ITERATIONS},`);
console.log('};');
console.log('');
