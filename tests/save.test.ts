import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Saving in a browser.
 *
 * The interesting cases are the ones that are not success, because those are
 * the ones a save used to be unable to tell apart. A document reported as
 * saved when the person pressed Cancel is how somebody closes the tab over
 * work they were told was safe.
 */

type Picked = { name: string; chunks: unknown[] };

interface Harness {
  picks: string[];
  written: Picked[];
  /** Set to make the picker throw. */
  pickerError?: Error;
  /** Set to make the write throw. */
  writeError?: Error;
  aborted: number;
}

/** Stand a File System Access API up in front of the module under test. */
function install(h: Harness, { withPicker = true } = {}): () => void {
  const g = globalThis as Record<string, any>;
  const hadWindow = 'window' in g;
  const previousWindow = g.window;
  const hadDocument = 'document' in g;
  const previousDocument = g.document;

  const win: Record<string, unknown> = {};
  if (withPicker) {
    win.showSaveFilePicker = async (options: { suggestedName?: string }) => {
      if (h.pickerError) throw h.pickerError;
      const name = options.suggestedName ?? 'untitled';
      h.picks.push(name);
      const file: Picked = { name, chunks: [] };
      return {
        name,
        async createWritable() {
          return {
            async write(data: unknown) {
              if (h.writeError) throw h.writeError;
              file.chunks.push(data);
            },
            async close() { h.written.push(file); },
            async abort() { h.aborted++; },
          };
        },
      };
    };
  }
  g.window = win;
  // The download fallback reaches for the DOM; a bare stub is enough to tell
  // "it took that path" from "it saved a file".
  g.document = {
    createElement: () => ({ click() {}, remove() {}, style: {}, set href(_v: string) {}, set download(_v: string) {} }),
    body: { appendChild() {} },
  };
  if (!('URL' in g)) g.URL = {};
  const hadCreate = 'createObjectURL' in (g.URL as object);
  (g.URL as Record<string, unknown>).createObjectURL = () => 'blob:stub';
  (g.URL as Record<string, unknown>).revokeObjectURL = () => undefined;

  return () => {
    if (hadWindow) g.window = previousWindow; else delete g.window;
    if (hadDocument) g.document = previousDocument; else delete g.document;
    if (!hadCreate) delete (g.URL as Record<string, unknown>).createObjectURL;
  };
}

const fresh = (): Harness => ({ picks: [], written: [], aborted: 0 });

test('a save writes to a file the person picked, and says so', async () => {
  const h = fresh();
  const restore = install(h);
  try {
    const { saveText, forgetSaveTargets, canSaveToFile } = await import('../src/io/files');
    forgetSaveTargets();
    assert.equal(canSaveToFile(), true, 'the picker was not detected');
    const outcome = await saveText('scene.kline', '{"a":1}', 'application/json');
    assert.deepEqual(outcome, { status: 'saved', path: 'scene.kline' });
    assert.deepEqual(h.picks, ['scene.kline']);
    assert.equal(h.written.length, 1, 'nothing was written');
  } finally {
    restore();
  }
});

test('saving again goes to the same file rather than asking once per save', async () => {
  // Without this, Ctrl+S in a browser is a folder dialog every time, which is
  // why people stop pressing it.
  const h = fresh();
  const restore = install(h);
  try {
    const { saveText, forgetSaveTargets, savedAs } = await import('../src/io/files');
    forgetSaveTargets();
    await saveText('scene.kline', 'one');
    await saveText('scene.kline', 'two');
    await saveText('scene.kline', 'three');
    assert.deepEqual(h.picks, ['scene.kline'], 'the picker opened more than once');
    assert.equal(h.written.length, 3, 'later saves did not write');
    assert.equal(savedAs('scene.kline'), 'scene.kline');
  } finally {
    restore();
  }
});

test('a new document forgets where the last one was saved', async () => {
  // Otherwise the first Ctrl+S after New Scene silently overwrites the
  // previous project's file.
  const h = fresh();
  const restore = install(h);
  try {
    const { saveText, forgetSaveTargets, savedAs } = await import('../src/io/files');
    forgetSaveTargets();
    await saveText('scene.kline', 'one');
    forgetSaveTargets();
    assert.equal(savedAs('scene.kline'), null);
    await saveText('scene.kline', 'two');
    assert.equal(h.picks.length, 2, 'the second document reused the first one’s file');
  } finally {
    restore();
  }
});

test('a dismissed picker is a cancellation, not a save', async () => {
  const h = fresh();
  h.pickerError = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
  const restore = install(h);
  try {
    const { saveText, saveWorked, forgetSaveTargets } = await import('../src/io/files');
    forgetSaveTargets();
    const outcome = await saveText('scene.kline', '{}');
    assert.equal(outcome.status, 'cancelled');
    assert.equal(saveWorked(outcome), false, 'a cancelled save counted as a save');
    assert.equal(h.written.length, 0);
  } finally {
    restore();
  }
});

test('a picker that fails for another reason is a failure, not a cancellation', async () => {
  // A blocked permission and a dismissed dialog are different things, and
  // telling the person the wrong one sends them looking in the wrong place.
  const h = fresh();
  h.pickerError = Object.assign(new Error('Not allowed by policy'), { name: 'SecurityError' });
  const restore = install(h);
  try {
    const { saveText, describeSave, forgetSaveTargets } = await import('../src/io/files');
    forgetSaveTargets();
    const outcome = await saveText('scene.kline', '{}');
    assert.equal(outcome.status, 'failed');
    assert.match(describeSave(outcome, 'scene.kline'), /Not allowed by policy/);
  } finally {
    restore();
  }
});

test('a write that fails reports the reason and does not keep the file', async () => {
  const h = fresh();
  h.writeError = new Error('No space left on device');
  const restore = install(h);
  try {
    const { saveText, saveWorked, savedAs, forgetSaveTargets } = await import('../src/io/files');
    forgetSaveTargets();
    const outcome = await saveText('scene.kline', '{}');
    assert.equal(outcome.status, 'failed');
    assert.match((outcome as { reason: string }).reason, /No space left/);
    assert.equal(saveWorked(outcome), false);
    assert.equal(h.aborted, 1, 'the half-written file was not abandoned');
    // Keeping a handle that will not write means every later save fails the
    // same way with no chance to pick somewhere else.
    assert.equal(savedAs('scene.kline'), null, 'a broken file handle was kept');
  } finally {
    restore();
  }
});

test('a browser with no picker still downloads, and still says only that', async () => {
  const h = fresh();
  const restore = install(h, { withPicker: false });
  try {
    const { saveText, canSaveToFile, describeSave, forgetSaveTargets } = await import('../src/io/files');
    forgetSaveTargets();
    assert.equal(canSaveToFile(), false);
    const outcome = await saveText('scene.kline', '{}');
    assert.equal(outcome.status, 'started');
    assert.match(describeSave(outcome, 'scene.kline'), /Downloading/);
  } finally {
    restore();
  }
});

test('a multi-file export is only "exported" when every file landed', async () => {
  const h = fresh();
  const restore = install(h);
  try {
    const { saveAll, describeExport, forgetSaveTargets } = await import('../src/io/files');
    forgetSaveTargets();
    const all = await saveAll([
      { filename: 'model.obj', text: 'v 0 0 0' },
      { filename: 'model.mtl', text: 'newmtl a' },
    ]);
    assert.equal(all.outcome.status, 'saved');
    assert.deepEqual(all.written, ['model.obj', 'model.mtl']);
    assert.match(describeExport(all, 2), /^Exported/);

    // And a cancellation part way through stops the rest and says where it got to.
    forgetSaveTargets();
    h.pickerError = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    const half = await saveAll([
      { filename: 'a.obj', text: 'v' },
      { filename: 'b.mtl', text: 'm' },
    ]);
    assert.equal(half.outcome.status, 'cancelled');
    assert.deepEqual(half.written, []);
    assert.match(describeExport(half, 2), /cancelled after 0 of 2/i);
  } finally {
    restore();
  }
});
