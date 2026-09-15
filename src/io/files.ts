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
 * `started` is the honest answer for a plain download: a tab that hands a file
 * to the download manager is never told what became of it, and reporting that
 * as a completed save would be a guess dressed as a fact. It is now the
 * fallback rather than the rule — where the browser has the File System Access
 * API, a save goes to a real file the person picked and comes back `saved`,
 * `cancelled` or `failed` like the desktop shell's does.
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
  return saveInBrowser(filename, new Blob([text], { type: mime }), mime);
}

export async function saveBinary(
  filename: string, data: ArrayBuffer, mime = 'application/octet-stream',
): Promise<SaveOutcome> {
  const bridge = desktop();
  if (bridge) return fromBridge(bridge.saveFile(filename, new Uint8Array(data), true));
  return saveInBrowser(filename, new Blob([data], { type: mime }), mime);
}

// ------------------------------------------------------- saving in a browser

interface FileHandle {
  readonly name: string;
  createWritable(): Promise<{
    write(data: Blob | ArrayBuffer): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

export interface DirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
}

interface PickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandle>;
  showDirectoryPicker?: (options?: { mode?: string }) => Promise<DirectoryHandle>;
}

/** Whether this browser can save to a file the person actually chose. */
export function canSaveToFile(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as unknown as PickerWindow).showSaveFilePicker === 'function';
}

/** Whether this browser can be given a folder to write a set of files into. */
export function canSaveToFolder(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';
}

/**
 * Ask for a folder, once.
 *
 * A picker needs a live user gesture, and a gesture is spent by the first
 * picker it opens. That is why a multi-file export cannot be a loop of save
 * dialogs: the second one throws, and a `.obj` whose `.mtl` never arrived is
 * not a partial success. One folder, chosen once, is both the thing the
 * browser will allow and the thing a person would have wanted anyway.
 */
export async function pickFolder(): Promise<DirectoryHandle | null | { failed: string }> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  try {
    return await picker({ mode: 'readwrite' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    return { failed: (err as Error).message };
  }
}

/** Write one file into a chosen folder. */
export async function writeInFolder(
  folder: DirectoryHandle, filename: string, body: Blob,
): Promise<SaveOutcome> {
  try {
    // Path separators are flattened: a name is a name inside the folder the
    // person picked, and nothing an exporter produces may walk out of it.
    const safe = filename.replace(/[\\/]+/g, '_').replace(/^\.+/, '_');
    const handle = await folder.getFileHandle(safe, { create: true });
    const stream = await handle.createWritable();
    try {
      await stream.write(body);
      await stream.close();
    } catch (err) {
      await stream.abort?.().catch(() => undefined);
      throw err;
    }
    return { status: 'saved', path: `${folder.name}/${safe}` };
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { status: 'cancelled' };
    return { status: 'failed', reason: (err as Error).message };
  }
}

/**
 * Remember where a document was last saved, so Save writes there again.
 *
 * Keyed by the name the caller asks for, which is how The Culp Mixer addresses a
 * document. Held in memory only: a file handle is not serializable, and a
 * reload legitimately has to ask again.
 */
const handles = new Map<string, FileHandle>();

/** Forget every remembered file, e.g. when a new document is started. */
export function forgetSaveTargets(): void {
  handles.clear();
}

/** The name a document was last written under, if it has been saved. */
export function savedAs(filename: string): string | null {
  return handles.get(filename)?.name ?? null;
}

/**
 * Save in a browser, as well as this browser can manage.
 *
 * Where the File System Access API exists — Chrome, Edge, Opera, and anything
 * else on that engine — this is a real save: a picker the person chooses a
 * folder in, a write that either lands or throws, and a second Save that goes
 * to the same file without asking again. That is the difference between
 * "Downloading scene.kline" and "Saved scene.kline", and it is also what makes
 * a cancelled save and a failed write distinguishable from a successful one,
 * which nothing downstream could tell apart before.
 *
 * Firefox and Safari have no such API, so they keep the download path and the
 * honest `started`.
 */
async function saveInBrowser(filename: string, blob: Blob, mime: string): Promise<SaveOutcome> {
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') return startDownload(filename, blob);

  let handle = handles.get(filename);
  if (!handle) {
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 ? filename.slice(dot) : '';
    try {
      handle = await picker({
        suggestedName: filename,
        ...(extension
          ? { types: [{ description: describeKind(extension), accept: { [mime]: [extension] } }] }
          : {}),
      });
    } catch (err) {
      // A picker the person dismissed throws AbortError. Anything else is a
      // real failure — a blocked permission, a policy — and is not a cancel.
      if ((err as Error).name === 'AbortError') return { status: 'cancelled' };
      return { status: 'failed', reason: (err as Error).message };
    }
  }

  try {
    const stream = await handle.createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (err) {
      await stream.abort?.().catch(() => undefined);
      throw err;
    }
    handles.set(filename, handle);
    return { status: 'saved', path: handle.name };
  } catch (err) {
    // A handle that will not open again — the file was moved, the permission
    // was revoked — must not be kept, or every later Save fails the same way.
    handles.delete(filename);
    if ((err as Error).name === 'AbortError') return { status: 'cancelled' };
    return { status: 'failed', reason: (err as Error).message };
  }
}

/** A word for the file type, for the picker's filter row. */
function describeKind(extension: string): string {
  switch (extension) {
    case '.kline': return 'The Culp Mixer scene';
    case '.gltf': return 'glTF 2.0';
    case '.obj': return 'Wavefront OBJ';
    case '.mtl': return 'Material library';
    case '.stl': return 'STL';
    case '.png': return 'PNG image';
    case '.webm': return 'WebM video';
    default: return 'File';
  }
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
  // The weakest outcome of the set is the one the caller is told about: a save
  // that is "saved" for two files and "started" for a third has not finished,
  // and saying it has is exactly the guess this type exists to prevent.
  let overall: SaveOutcome = { status: 'saved', path: '' };

  // In a browser, ask for the folder once and write everything into it. A
  // picker spends the user gesture that opened it, so a second save dialog in
  // the same act throws — which made a two-file export impossible to finish.
  if (!desktop() && canSaveToFolder() && files.length > 1) {
    const folder = await pickFolder();
    if (folder && 'failed' in folder) return { outcome: { status: 'failed', reason: folder.failed }, written };
    if (folder) {
      for (const file of files) {
        const body = file.bytes
          ? new Blob([file.bytes], { type: file.mime ?? 'application/octet-stream' })
          : new Blob([file.text ?? ''], { type: file.mime ?? 'text/plain' });
        const outcome = await writeInFolder(folder, file.filename, body);
        if (!saveWorked(outcome)) return { outcome, written };
        written.push(file.filename);
      }
      return { outcome: { status: 'saved', path: folder.name }, written };
    }
    return { outcome: { status: 'cancelled' }, written };
  }

  for (const file of files) {
    const outcome = file.bytes
      ? await saveBinary(file.filename, file.bytes, file.mime)
      : await saveText(file.filename, file.text ?? '', file.mime);
    if (!saveWorked(outcome)) return { outcome, written };
    if (outcome.status === 'started') overall = { status: 'started' };
    written.push(file.filename);
  }
  return { outcome: overall, written };
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
