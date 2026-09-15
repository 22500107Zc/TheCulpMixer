/**
 * Image textures. The pixels live in a data URL so a saved .kline file is
 * self-contained — a scene that references files on disk stops working the
 * moment it is sent to anyone else.
 */
export interface SceneTexture {
  id: number;
  name: string;
  /** Data URL holding the encoded image. */
  url: string;
  width: number;
  height: number;
}

let textureCounter = 0;

export function createTexture(name: string, url: string, width = 0, height = 0): SceneTexture {
  return { id: ++textureCounter, name, url, width, height };
}

/**
 * Whether a texture reference is one The Culp Mixer is willing to load.
 *
 * The Culp Mixer embeds every image it owns as a `data:` URL so a saved file is
 * self-contained and opening one touches nothing outside it. A document is
 * untrusted input — people share project files — and a `url` of
 * `https://someone.example/pixel.png?who=you` loaded straight into an <img>
 * is a tracking beacon that fires the moment the file is opened, against the
 * one promise the application makes about privacy.
 *
 * So only self-contained references are accepted. This was verified the wrong
 * way round first: a crafted file reached a server on open.
 */
export function isSelfContainedImage(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  // `data:` only, and only an image. `blob:` is deliberately excluded — a blob
  // URL from another document is not something a saved file can legitimately
  // carry, and it would be dead on load anyway.
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed);
}

/**
 * Keep the textures a document may load, and say what was dropped.
 *
 * Dropping rather than refusing the whole file: a project with one hostile
 * texture is still somebody's afternoon of modelling, and the geometry is not
 * the dangerous part.
 */
export function acceptTextures(raw: unknown): { textures: SceneTexture[]; rejected: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const textures: SceneTexture[] = [];
  const rejected: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Partial<SceneTexture>;
    const raw: unknown = t.url;
    if (!isSelfContainedImage(raw)) {
      const where = typeof raw === 'string' ? raw.slice(0, 60) : String(raw);
      rejected.push(`${typeof t.name === 'string' ? t.name : 'texture'} (${where})`);
      continue;
    }
    textures.push({
      id: Number.isFinite(t.id) ? Number(t.id) : 0,
      name: typeof t.name === 'string' ? t.name : 'Texture',
      url: raw,
      width: Number.isFinite(t.width) ? Number(t.width) : 0,
      height: Number.isFinite(t.height) ? Number(t.height) : 0,
    });
  }
  return { textures, rejected };
}

/** Adopt deserialized textures, keeping ids unique against future ones. */
export function reserveTextureId(id: number): void {
  if (id > textureCounter) textureCounter = id;
}

/** Read an image file the user picked into a texture. */
export async function loadTextureFile(file: File): Promise<SceneTexture> {
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
    fr.readAsDataURL(file);
  });
  const size = await imageSize(url);
  return createTexture(file.name.replace(/\.[^.]+$/, ''), url, size.width, size.height);
}

export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

/** A UV checker map, generated rather than shipped as an asset. */
export function generateCheckerTexture(size = 512, squares = 8): SceneTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return createTexture('Checker', '', size, size);
  const cell = size / squares;
  const palette = ['#3f4a56', '#e8e4dc'];
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      ctx.fillStyle = palette[(x + y) % 2];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // Coloured corners make orientation and mirroring obvious at a glance.
  ctx.fillStyle = '#d1495b';
  ctx.fillRect(0, 0, cell, cell);
  ctx.fillStyle = '#2a9d8f';
  ctx.fillRect(size - cell, size - cell, cell, cell);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= squares; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(size, i * cell);
    ctx.stroke();
  }
  return createTexture('UV Checker', canvas.toDataURL('image/png'), size, size);
}

/**
 * A blank white map to paint on.
 *
 * White rather than transparent: the map multiplies into the base colour, so
 * white is the value that changes nothing, and a new map should leave the
 * model looking exactly as it did.
 */
export function blankTexture(name: string, size = 1024): SceneTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
  }
  return createTexture(name, canvas.toDataURL('image/png'), size, size);
}
