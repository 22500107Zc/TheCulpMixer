/**
 * Local persistence: preferences and the recent-file list. Both are small and
 * both are best-effort — storage can be full, disabled or unavailable (a
 * file:// page, a private window), and none of that is worth interrupting the
 * user over, so every path degrades to "no saved state".
 *
 * Crash recovery used to live here too. It outgrew `localStorage` and moved to
 * `recovery.ts`, which uses IndexedDB.
 */

const PREFS_KEY = 'culpmixer.preferences';
const RECENT_KEY = 'culpmixer.recent';
/**
 * What these keys were called before the application was renamed.
 *
 * Read once, when the current key is absent, and then written forward under
 * the new name. A rename is not a reason for someone to lose their settings
 * and their recent files.
 */
const LEGACY_KEYS: Record<string, string> = {
  [PREFS_KEY]: 'kiln.preferences',
  [RECENT_KEY]: 'kiln.recent',
};

/** Read a key, falling back to the name it had before the rename. */
function readKey(store: Storage, key: string): string | null {
  const current = store.getItem(key);
  if (current !== null) return current;
  const legacy = LEGACY_KEYS[key];
  return legacy ? store.getItem(legacy) : null;
}

export interface Preferences {
  theme: 'dark' | 'light';
  showGrid: boolean;
  showOverlays: boolean;
  autosaveEnabled: boolean;
  autosaveSeconds: number;
  snapIncrement: number;
  proportionalFalloff: string;
  renderSamples: number;
  renderWidth: number;
  renderHeight: number;
  /**
   * Show the getting-started guide when the application opens.
   *
   * True by default so a first run is guided, and turned off by the guide's
   * own checkbox — which is the only place anyone will look for it, and is
   * far more likely to be used than a settings page nobody opens.
   */
  showGuideOnStart: boolean;
}

export function defaultPreferences(): Preferences {
  return {
    theme: 'dark',
    showGrid: true,
    showOverlays: true,
    autosaveEnabled: true,
    autosaveSeconds: 60,
    snapIncrement: 0.25,
    proportionalFalloff: 'smooth',
    renderSamples: 128,
    renderWidth: 960,
    renderHeight: 540,
    showGuideOnStart: true,
  };
}

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    // Safari in private mode hands back an object that throws on write.
    const probe = '__culpmixer_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function loadPreferences(): Preferences {
  const s = storage();
  if (!s) return defaultPreferences();
  try {
    const raw = readKey(s, PREFS_KEY);
    if (!raw) return defaultPreferences();
    return { ...defaultPreferences(), ...JSON.parse(raw) };
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(p: Preferences): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* nothing useful to do if preferences will not fit */
  }
}

export interface RecentEntry {
  name: string;
  openedAt: number;
}

export function recentFiles(): RecentEntry[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = readKey(s, RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

export function noteRecentFile(name: string): void {
  const s = storage();
  if (!s) return;
  try {
    const list = recentFiles().filter((r) => r.name !== name);
    list.unshift({ name, openedAt: Date.now() });
    s.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
}
