import { desktop } from '../../desktop';
import { saveBinary } from '../../io/files';
import { FrameImage, frameFilename } from './sequence';

/**
 * Getting a finished sequence out of the application.
 *
 * The two runtimes can do genuinely different things here and the difference
 * is worth stating rather than papering over. The desktop shell can be handed
 * a folder once and write four hundred files into it. A browser tab cannot: it
 * has no folder, only a download per file, and a download it is never told the
 * outcome of. So the browser path offers a video instead where the runtime
 * supports recording one, and says plainly what it is doing either way.
 */

export interface Destination {
  /** How the frames will be delivered, in words for the person waiting. */
  describe(): string;
  /** Called once per rendered frame. */
  write(image: FrameImage, total: number): Promise<boolean>;
  /** Called after the last frame; returns a closing message. */
  finish(written: number, cancelled: boolean): Promise<string>;
}

/**
 * Wrap a frame's pixels as ImageData.
 *
 * Copied rather than wrapped in place: the pixel buffer comes back from a
 * worker and may sit on memory ImageData will not take directly.
 */
function imageDataFor(image: FrameImage): ImageData {
  const copy = new Uint8ClampedArray(image.width * image.height * 4);
  copy.set(image.pixels.subarray(0, copy.length));
  return new ImageData(copy, image.width, image.height);
}

/** Turn tonemapped pixels into PNG bytes. */
export async function toPng(image: FrameImage): Promise<ArrayBuffer | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(imageDataFor(image), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? blob.arrayBuffer() : null;
}

/** Write every frame into one folder the person chose. Desktop only. */
export function folderDestination(folder: string): Destination {
  const bridge = desktop();
  let failed: string | null = null;
  return {
    describe: () => `Writing frames to ${folder}`,
    async write(image, total) {
      const png = await toPng(image);
      if (!png || !bridge?.writeInFolder) {
        failed = 'the frame could not be encoded';
        return false;
      }
      const result = await bridge.writeInFolder(
        folder, frameFilename(image.frame, total), new Uint8Array(png),
      );
      if (result.status !== 'saved') {
        failed = result.reason ?? 'the write was refused';
        return false;
      }
      return true;
    },
    async finish(written, cancelled) {
      if (failed) return `Stopped after ${written} frame(s): ${failed}`;
      if (cancelled) return `Cancelled after ${written} frame(s), which are in ${folder}`;
      return `Rendered ${written} frame(s) into ${folder}`;
    },
  };
}

/**
 * One download per frame.
 *
 * The browser fallback, and deliberately capped: a tab asked to start three
 * hundred downloads will either prompt three hundred times or be throttled
 * into dropping most of them, and quietly losing frames at the end of a long
 * render is worse than declining to start.
 */
export const MAX_BROWSER_FRAMES = 60;

export function downloadDestination(): Destination {
  let failed: string | null = null;
  return {
    describe: () => 'Downloading each frame — your browser will ask where to put them',
    async write(image, total) {
      const png = await toPng(image);
      if (!png) {
        failed = 'the frame could not be encoded';
        return false;
      }
      const outcome = await saveBinary(frameFilename(image.frame, total), png, 'image/png');
      if (outcome.status === 'failed') {
        failed = outcome.reason;
        return false;
      }
      // `started` is as much as a tab ever knows, and the closing message says so.
      return outcome.status !== 'cancelled';
    },
    async finish(written, cancelled) {
      if (failed) return `Stopped after ${written} frame(s): ${failed}`;
      const what = `${written} frame(s) handed to your browser's downloads`;
      return cancelled ? `Cancelled — ${what}` : `Rendered ${what}`;
    },
  };
}

/** Whether this runtime can record a video rather than a pile of stills. */
export function canRecordVideo(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      || MediaRecorder.isTypeSupported('video/webm'));
}

/**
 * Record the frames into a single WebM as they arrive.
 *
 * Only where the runtime actually supports it. There is no bundled encoder and
 * no intention of shipping one: a fallback that quietly produces a worse file
 * is how people end up delivering something they did not check.
 */
export function videoDestination(fps: number): Destination | null {
  if (!canRecordVideo() || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  let ctx: CanvasRenderingContext2D | null = null;
  let recorder: MediaRecorder | null = null;
  const parts: Blob[] = [];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';

  return {
    describe: () => `Recording ${mime.split(';')[0]} at ${fps}fps`,
    async write(image) {
      if (!recorder) {
        canvas.width = image.width;
        canvas.height = image.height;
        ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const stream = canvas.captureStream(0);
        recorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
        recorder.start();
      }
      if (!ctx) return false;
      ctx.putImageData(imageDataFor(image), 0, 0);
      // One explicit frame per rendered frame, so the result runs at the
      // timeline's rate rather than at whatever speed the render happened to go.
      const track = canvas.captureStream(0).getVideoTracks()[0] as unknown as
        { requestFrame?: () => void };
      track?.requestFrame?.();
      await new Promise((r) => setTimeout(r, 1000 / Math.max(1, fps)));
      return true;
    },
    async finish(written, cancelled) {
      if (!recorder) return 'Nothing was recorded.';
      await new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
        recorder!.stop();
      });
      const blob = new Blob(parts, { type: mime });
      const outcome = await saveBinary('render.webm', await blob.arrayBuffer(), mime);
      const head = cancelled ? `Cancelled after ${written} frame(s)` : `Recorded ${written} frame(s)`;
      if (outcome.status === 'failed') return `${head}, but the video could not be saved: ${outcome.reason}`;
      if (outcome.status === 'cancelled') return `${head}; saving the video was cancelled`;
      return `${head} to render.webm`;
    },
  };
}

/**
 * The best destination this runtime can offer, and a plain sentence about why.
 */
export async function chooseDestination(
  prefer: 'frames' | 'video', fps: number, frames: number,
): Promise<{ destination: Destination | null; reason: string }> {
  const bridge = desktop();
  if (prefer === 'video') {
    const video = videoDestination(fps);
    if (video) return { destination: video, reason: video.describe() };
    return {
      destination: null,
      reason: 'This runtime cannot record video — there is no MediaRecorder here. '
        + 'Render a frame sequence instead and assemble it in an editor.',
    };
  }
  if (bridge?.chooseFolder && bridge.writeInFolder) {
    const picked = await bridge.chooseFolder('Where should the frames go?');
    if (picked.status !== 'saved' || !picked.path) {
      return { destination: null, reason: 'No folder was chosen, so nothing was rendered.' };
    }
    const dest = folderDestination(picked.path);
    return { destination: dest, reason: dest.describe() };
  }
  if (frames > MAX_BROWSER_FRAMES) {
    return {
      destination: null,
      reason: `A browser tab can only hand over one download at a time, so ${frames} frames `
        + `is more than it will reliably deliver (the limit here is ${MAX_BROWSER_FRAMES}). `
        + 'Shorten the range, record a video instead, or use the desktop app, which writes '
        + 'a whole sequence into one folder.',
    };
  }
  const dest = downloadDestination();
  return { destination: dest, reason: dest.describe() };
}
