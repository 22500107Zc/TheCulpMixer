import { Bitmap } from './contour';

/**
 * Getting pixels out of a dropped file.
 *
 * Images and videos are handled the same way downstream: both end up as a
 * `Bitmap` sampled from a canvas, so a video is really just an image source
 * with a playhead.
 */

export type ReferenceKind = 'image' | 'video';

export interface Reference {
  name: string;
  kind: ReferenceKind;
  width: number;
  height: number;
  element: HTMLImageElement | HTMLVideoElement;
  /** Seconds, videos only. */
  duration: number;
  /** Object URL backing the element; revoke when finished with it. */
  url: string;
}

export const ACCEPTED_TYPES = 'image/*,video/*';

export function isSupportedFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

export function loadReference(file: File): Promise<Reference> {
  const url = URL.createObjectURL(file);
  const kind: ReferenceKind = file.type.startsWith('video/') ? 'video' : 'image';

  return new Promise((resolve, reject) => {
    const fail = (): void => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name}. Is it a format this browser supports?`));
    };

    if (kind === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.onloadeddata = () => {
        resolve({
          name: file.name,
          kind,
          width: video.videoWidth,
          height: video.videoHeight,
          element: video,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          url,
        });
      };
      video.onerror = fail;
      video.src = url;
      video.load();
      return;
    }

    const image = new Image();
    image.onload = () => {
      resolve({
        name: file.name,
        kind,
        width: image.naturalWidth,
        height: image.naturalHeight,
        element: image,
        duration: 0,
        url,
      });
    };
    image.onerror = fail;
    image.src = url;
  });
}

export function releaseReference(reference: Reference | null): void {
  if (!reference) return;
  if (reference.element instanceof HTMLVideoElement) {
    reference.element.pause();
    reference.element.removeAttribute('src');
    reference.element.load();
  }
  // A reference rebuilt from a picture stored in the document has no object
  // URL behind it; revoking an empty string is harmless but saying so is not.
  if (reference.url) URL.revokeObjectURL(reference.url);
}

/** Move a video's playhead and wait for the frame to actually be ready. */
export function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = (): void => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, Math.min(time, Math.max(0, video.duration - 1e-3)));
    // Some browsers never fire 'seeked' for a video that has not started.
    setTimeout(done, 500);
  });
}

const scratch = (): HTMLCanvasElement => document.createElement('canvas');

/**
 * Sample the reference's current frame into a bitmap, capped at `maxSize` on
 * the longer edge — contour tracing does not get better above a few hundred
 * pixels, and staying small keeps the live preview interactive.
 */
export function bitmapFromReference(reference: Reference, maxSize = 384): Bitmap {
  const scale = Math.min(1, maxSize / Math.max(reference.width, reference.height));
  const width = Math.max(1, Math.round(reference.width * scale));
  const height = Math.max(1, Math.round(reference.height * scale));
  const canvas = scratch();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser would not give The Culp Mixer a 2D canvas to read pixels from.');
  ctx.drawImage(reference.element, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { width, height, data };
}

/** The current frame as a PNG blob, for handing to a local model server. */
export function blobFromReference(reference: Reference, maxSize = 768): Promise<Blob> {
  const scale = Math.min(1, maxSize / Math.max(reference.width, reference.height));
  const canvas = scratch();
  canvas.width = Math.max(1, Math.round(reference.width * scale));
  canvas.height = Math.max(1, Math.round(reference.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser would not give The Culp Mixer a 2D canvas.'));
  ctx.drawImage(reference.element, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the frame as a PNG.'));
    }, 'image/png');
  });
}

/**
 * The current frame as a PNG data URL, for use as a texture.
 *
 * A data URL rather than an object URL because the scene embeds its textures:
 * a saved .kline that points at a blob from a page that has since closed is a
 * file that opens grey.
 */
export function textureFromReference(
  reference: Reference, maxSize = 1024,
): { url: string; width: number; height: number } {
  const scale = Math.min(1, maxSize / Math.max(reference.width, reference.height));
  const canvas = scratch();
  canvas.width = Math.max(1, Math.round(reference.width * scale));
  canvas.height = Math.max(1, Math.round(reference.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give The Culp Mixer a 2D canvas.');
  ctx.drawImage(reference.element, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/** Draw a reference frame into a visible canvas, letterboxed to fit. */
export function drawReferenceInto(
  canvas: HTMLCanvasElement, reference: Reference,
): { x: number; y: number; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / reference.width, canvas.height / reference.height);
  const w = reference.width * scale;
  const h = reference.height * scale;
  const x = (canvas.width - w) / 2;
  const y = (canvas.height - h) / 2;
  ctx.drawImage(reference.element, x, y, w, h);
  return { x, y, width: w, height: h };
}

/**
 * Rebuild a reference from a picture stored in the document.
 *
 * The counterpart to `textureFromReference`: that puts the image into the file
 * so a generated model can be rebuilt later, and this is later. It reads a
 * data URL, so it works with the network unplugged and depends on nothing
 * outside the file.
 */
export function referenceFromDataUrl(name: string, url: string): Promise<Reference> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({
      name,
      kind: 'image',
      width: image.naturalWidth,
      height: image.naturalHeight,
      element: image,
      duration: 0,
      // Not an object URL, so there is nothing to revoke; releaseReference
      // checks for the blob: prefix before it revokes anything.
      url: '',
    });
    image.onerror = () => reject(new Error(`The stored picture "${name}" could not be decoded`));
    image.src = url;
  });
}
