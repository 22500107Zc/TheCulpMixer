'use strict';

/**
 * Ad-hoc sign the macOS app so Apple Silicon will run it.
 *
 * This is not about Gatekeeper warnings. On arm64 macOS the kernel refuses to
 * execute a binary carrying no signature at all — the app does not start, and
 * the dialog says "The Culp Mixer is damaged and can't be opened. You should move it to
 * the Trash." Right-click -> Open does not clear that, because it is not a
 * Gatekeeper prompt: it is the loader rejecting an unsigned arm64 executable.
 *
 * electron-builder signs only when it finds a real Developer ID certificate in
 * the keychain. With none present it logs the miss and returns without signing
 * (`macPackager.js`, the `identity == null` branch), so every build without an
 * Apple Developer account ships unsigned and dead on arrival on Apple Silicon.
 *
 * An ad-hoc signature — `codesign --sign -` — is free, needs no account, and
 * is exactly what the loader requires. It does not make the app *trusted*:
 * macOS still warns that it is from an unidentified developer, and the user
 * still clears that once with right-click -> Open. It only makes the app
 * *runnable*, which is the part that was missing.
 */

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

/**
 * The universal build is merged from two single-architecture builds, and the
 * merge requires every non-binary file in them to be byte-identical. A
 * signature is not identical across architectures, so signing the halves makes
 * the merge fail outright:
 *
 *   Expected all non-binary files to have identical SHAs when creating a
 *   universal build but "…/_CodeSignature/CodeResources" did not
 *
 * The halves are therefore left alone and the merged app is signed instead —
 * electron-builder calls this hook a second time for it, with the comment
 * "give users a final opportunity to perform things on the combined universal
 * package before signing". Those temporary halves are the only outputs that
 * get skipped; the standalone arm64 and x64 apps behind the dmg and zip are
 * signed normally.
 *
 * The naming is electron-builder's own: `${appOutDir}-${Arch[arch]}-temp`.
 */
function isUniversalHalf(appOutDir) {
  return /-(?:x64|arm64)-temp$/.test(appOutDir);
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (isUniversalHalf(context.appOutDir)) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`ad-hoc signing: ${appPath} is not there to sign`);
  }

  // --deep so the helper apps and framework inside the bundle are signed too;
  // an unsigned helper is just as fatal as an unsigned main executable.
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none', appPath,
  ], { stdio: 'inherit' });

  // Signing that silently produced nothing is the failure this whole file
  // exists to prevent, so it is checked rather than assumed.
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appName}  ${context.appOutDir}`);
};

exports.isUniversalHalf = isUniversalHalf;
