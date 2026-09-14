#!/usr/bin/env node
/**
 * Make the founder password hash.
 *
 *   node tools/kline-founder.mjs "your password here"
 *
 * Prints one line to paste into Vercel as the environment variable
 * KLINE_FOUNDER_HASH. The password itself is never written anywhere — not to
 * this repository, not to a file, not to your shell history if you are careful
 * to run it with a leading space.
 *
 * Why a hash rather than the password: this repository is readable. A password
 * in source is a password every reader of the source has, and the founder
 * console can issue licences and see every customer. The hash is useless to
 * anybody who finds it — it cannot be turned back into the password, and it
 * cannot be used to log in.
 *
 * To change the password later, run this again with the new one and replace
 * the variable. Every open console session is signed out by that, because the
 * session signature is derived from the hash.
 */
import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv.slice(2).join(' ').trim();

if (!password) {
  console.error('Usage: node tools/kline-founder.mjs "your password here"');
  process.exit(1);
}

if (password.length < 10) {
  console.error(`That password is ${password.length} characters. Use at least 10 —`);
  console.error('this one login can issue licences and read every customer you have.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);

console.log('');
console.log('  Paste this into Vercel > Settings > Environment Variables, for Production:');
console.log('');
console.log('    Name:   KLINE_FOUNDER_HASH');
console.log(`    Value:  scrypt$${salt.toString('hex')}$${hash.toString('hex')}`);
console.log('');
console.log('  Then redeploy, and sign in at  /founder.html  with the password itself.');
console.log('');
console.log('  Do not commit the password. Do not put it in this repository. The value');
console.log('  above is safe to paste into Vercel and useless to anybody who finds it.');
console.log('');
