/**
 * The renderer half of the desktop shell.
 *
 * Everything here is a no-op in a browser tab: `window.klineDesktop` only exists
 * when Kline is running inside its Electron host, so the same bundle ships to
 * both without a second build.
 */

export interface OpenedFile {
  name: string;
  text: string;
}

export interface DesktopBridge {
  platform: string;
  registerCommands: (commands: { id: string; label: string; category: string; shortcut?: string }[]) => void;
  onCommand: (fn: (id: string) => void) => void;
  onShowShortcuts: (fn: () => void) => void;
  onOpenFile: (fn: (file: OpenedFile | null) => void) => void;
  /** The shell is about to close the window and wants an answer first. */
  onConfirmClose?: (fn: () => void) => void;
  answerClose?: (ok: boolean) => void;
  saveFile: (defaultName: string, data: string | Uint8Array, binary?: boolean) => Promise<unknown>;
  /** Ask once for a folder a whole render sequence can be written into. */
  chooseFolder?: (title: string) => Promise<{ status: string; path?: string }>;
  writeInFolder?: (
    folder: string, name: string, data: Uint8Array,
  ) => Promise<{ status: string; path?: string; reason?: string }>;
  openScene: () => Promise<OpenedFile | null>;
}

export function desktop(): DesktopBridge | null {
  return (window as unknown as { klineDesktop?: DesktopBridge }).klineDesktop ?? null;
}

export const isDesktop = (): boolean => desktop() !== null;

/** Mark the document so the shell can style itself as a native window. */
export function applyDesktopChrome(): void {
  const bridge = desktop();
  if (!bridge) return;
  document.documentElement.classList.add('is-desktop');
  if (bridge.platform === 'darwin') document.documentElement.classList.add('is-mac');
}
