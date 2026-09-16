#!/usr/bin/env node
/**
 * Seal an owner key with the founder password.
 *
 *   node tools/culpmixer-founder-seal.mjs "<founder password>"
 *
 * Prints a block to paste into src/licence/founder.ts.
 *
 * What this is for: the founder has to be able to open their own application
 * with nothing but their email and password, on any machine, with no server
 * answering. A password hash in the bundle could only ever say yes or no — and
 * a yes from code somebody can edit is not a lock. So instead the owner key
 * itself is encrypted with the password. Typing the password is what produces
 * a real, signed key; without it the bundle holds nothing usable.
 *
 * AES-GCM, with the key derived by PBKDF2-SHA256 at 310,000 iterations —
 * roughly what a browser will do without a noticeable pause, and enough that
 * guessing costs real money per attempt.
 *
 * The honest limit: this ciphertext ships to everybody, so the only thing
 * standing between a determined stranger and the owner key is how hard the
 * password is to guess. Use a long one. A short one built from a word and a
 * date will not hold.
 */
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const password = process.argv.slice(2).join(' ').trim();
if (!password) {
  console.error('Usage: node tools/culpmixer-founder-seal.mjs "<founder password>"');
  process.exit(1);
}

// Mint a fresh owner key to seal, so this never depends on an old one.
const minted = execFileSync('node', ['tools/culpmixer-licence.mjs', 'owner', '--name', 'Founder'], {
  encoding: 'utf8',
});
const key = minted.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(l));
if (!key) {
  console.error('Could not mint an owner key. Is culpmixer-private-key.pem here?');
  process.exit(1);
}

const ITERATIONS = 310000;
const salt = randomBytes(16);
const iv = randomBytes(12);
const secret = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', secret, iv);
const sealed = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

const b64 = (b) => b.toString('base64');

console.log('');
console.log('  Paste into src/licence/founder.ts:');
console.log('');
console.log(`export const SEALED_OWNER_KEY = {`);
console.log(`  salt: '${b64(salt)}',`);
console.log(`  iv: '${b64(iv)}',`);
console.log(`  data: '${b64(Buffer.concat([sealed, tag]))}',`);
console.log(`  iterations: ${ITERATIONS},`);
console.log(`};`);
console.log('');
