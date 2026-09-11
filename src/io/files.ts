import { desktop } from '../desktop';

/**
 * File in and out. In a browser tab these are downloads and an <input type=file>;
 * in the desktop shell the same calls become native Save and Open dialogs.
 */

/**
 * What actually happened to a save.
 *
 * These used to be `void` functions that started a save and returned, so every
 * caller said "Saved" the instant it was asked to — before the dialog had even
 * appeared, and identically whether the person picked a folder, pressed Cancel,
 * or the disk was full. The one message a save is for is whether the work is
 * safe, and it was the one thing the message did not depend on.
 *
 * `started` is the honest browser answer and is deliberately not `saved`: a tab
 * can hand a file to the download manager and is never told what became of it.
 * Reporting that as a completed save would be a guess dressed as a fact.
 */
export type SaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'started' }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string };

/** True when the file is definitely on disk, or definitely on its way. */
export function saveWorked(outcome: SaveOutcome): boolean {
  return outcome.status === 'saved' || outcome.status === 'started';
}

/** One line describing an outcome, for the status bar. */
export function describeSave(outcome: SaveOutcome, what: string): string {
  switch (outcome.status) {
    case 'saved': return `Saved ${what}`;
    case 'started': return `Downloading ${what}`;
    case 'cancelled': return `${what} was not saved — cancelled`;
    default: return `Could not save ${what}: ${outcome.reason}`;
  }
}

export async function saveText(
  filename: string, text: string, mime = 'text/plain',
): Promise<SaveOutcome> {
  const bridge = desktop();
  if (bridge) return fromBridge(bridge.saveFile(filename, text, false));
  return startDownload(filename, new Blob([text], { type: mime }));
}

export async function saveBinary(
  filename: string, data: ArrayBuffer, mime = 'application/octet-stream',
): Promise<SaveOutcome> {
  const bridge = desktop();
  if (bridge) return fromBridge(bridge.saveFile(filename, new Uint8Array(data), true));
  return startDownload(filename, new Blob([data], { type: mime }));
}

/**
 * Save several files as one act.
 *
 * An OBJ is not one file — it is geometry, a material library beside it, and an
 * image for every texture the library names. Firing those off independently
 * gave three unrelated dialogs on the desktop and one cheerful "Exported"
 * whatever the person did with them, so cancelling half an export still
 * reported a complete one. Here the first cancellation or failure stops the
 * rest, because a `.obj` whose `.mtl` never arrived is not a partial success.
 */
export async function saveAll(
  files: { filename: string; text?: string; bytes?: ArrayBuffer; mime?: string }[],
): Promise<{ outcome: SaveOutcome; written: string[] }> {
  const written: string[] = [];
  for (const file of files) {
    const outcome = file.bytes
      ? await saveBinary(file.filename, file.bytes, file.mime)
      : await saveText(file.filename, file.text ?? '', file.mime);
    if (!saveWorked(outcome)) return { outcome, written };
    written.push(file.filename);
  }
  return { outcome: { status: 'started' }, written };
}

/** Describe a multi-file export truthfully, including a half-finished one. */
export function describeExport(
  result: { outcome: SaveOutcome; written: string[] }, total: number,
): string {
  const { outcome, written } = result;
  if (saveWorked(outcome) && written.length === total) {
    return `Exported ${written.join(', ')}`;
  }
  const got = written.length ? ` ${written.join(', ')} ${written.length === 1 ? 'was' : 'were'} written.` : '';
  if (outcome.status === 'cancelled') {
    return `Export cancelled after ${written.length} of ${total} files.${got}`;
  }
  return `Export failed after ${written.length} of ${total} files`
    + `${outcome.status === 'failed' ? `: ${outcome.reason}` : ''}.${got}`;
}

async function fromBridge(pending: Promise<unknown>): Promise<SaveOutcome> {
  try {
    const result = await pending;
    // The shell answers with a full outcome. A bare string is what the older
    // shell returned, and a bundle can be newer than the shell around it.
    if (typeof result === 'string') return { status: 'saved', path: result };
    if (!result) return { status: 'cancelled' };
    const r = result as { status?: string; path?: string; reason?: string };
    if (r.status === 'saved' && r.path) return { status: 'saved', path: r.path };
    if (r.status === 'cancelled') return { status: 'cancelled' };
    if (r.status === 'failed') return { status: 'failed', reason: r.reason ?? 'unknown error' };
    return { status: 'cancelled' };
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }
}

function startDownload(filename: string, blob: Blob): SaveOutcome {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { status: 'started' };
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }
}

export function openTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  const bridge = desktop();
  if (bridge && accept.includes('.kline')) return bridge.openScene();
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? '') });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

/** Open a native file picker and hand back the raw File. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // A cancelled picker fires nothing at all in some browsers, so the promise
    // is also settled when focus comes back to the window.
    window.addEventListener('focus', () => setTimeout(() => resolve(input.files?.[0] ?? null), 300), { once: true });
    input.click();
  });
}
