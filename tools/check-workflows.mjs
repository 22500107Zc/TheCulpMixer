/**
 * Check that every shell script inside the workflows actually parses.
 *
 * A workflow is YAML containing shell, and the two are checked by different
 * things — so a `run:` block can be valid YAML and broken shell, and nothing
 * says so until a runner picks it up. That happened: an unterminated quote in
 * an echo took down three release builds in a row, on all three platforms,
 * after the YAML had been validated.
 *
 * `bash -n` parses without executing, which is exactly the question being
 * asked. Runs in CI and before a release.
 *
 * A step can declare another shell, and a PowerShell block fed to bash fails
 * on its first brace — which says nothing about the script and everything
 * about the checker. Those are counted and named rather than checked, so it is
 * visible that they are not covered instead of looking like they are.
 */
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = '.github/workflows';
let checked = 0;
const broken = [];
const skipped = [];

/** Enough YAML for this: the run blocks and the names around them. */
function stepsOf(text) {
  const out = [];
  const lines = text.split('\n');
  let i = 0;
  let name = '(unnamed)';
  let shell = 'bash';
  while (i < lines.length) {
    const line = lines[i];
    const named = line.match(/^\s*-?\s*name:\s*(.+)$/);
    if (named) {
      name = named[1].trim();
      // A new step: whatever shell the last one asked for does not carry over.
      shell = 'bash';
    }
    const declared = line.match(/^\s*-?\s*shell:\s*(\S+)\s*$/);
    if (declared) shell = declared[1];
    const run = line.match(/^(\s*)-?\s*run:\s*(\|.*|>.*)?$/);
    if (run && (run[2] ?? '').startsWith('|')) {
      const indent = run[1].length;
      const body = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() !== '' && (l.length - l.trimStart().length) <= indent) break;
        body.push(l);
        i++;
      }
      out.push({ name, shell, script: body.join('\n') });
      continue;
    }
    const inline = line.match(/^\s*-?\s*run:\s+(?!\||>)(.+)$/);
    if (inline) out.push({ name, shell, script: inline[1] });
    i++;
  }
  return out;
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const text = readFileSync(join(dir, file), 'utf8');
  for (const { name, shell, script } of stepsOf(text)) {
    if (!/^(bash|sh)$/.test(shell)) {
      skipped.push(`${file} :: ${name} (${shell})`);
      continue;
    }
    // Skip anything using GitHub's ${{ }} in a way bash cannot parse on its
    // own; the expression is substituted before the shell ever sees it.
    const cleaned = script.replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
    checked++;
    const path = join(tmpdir(), `wf-${checked}.sh`);
    writeFileSync(path, cleaned);
    try {
      execFileSync('bash', ['-n', path], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${file} :: ${name}\n    ${String(err.stderr ?? err).trim().split('\n').slice(0, 3).join('\n    ')}`);
    } finally {
      unlinkSync(path);
    }
  }
}

if (broken.length) {
  console.error(`${broken.length} of ${checked} workflow scripts do not parse:\n`);
  for (const b of broken) console.error(`  ${b}\n`);
  process.exit(1);
}
console.log(`all ${checked} workflow shell scripts parse`);
if (skipped.length) {
  console.log(`${skipped.length} not checked, because bash cannot parse them:`);
  for (const s of skipped) console.log(`  ${s}`);
}
