import { Scene } from '../../scene/Scene';
import { RenderJob } from './RenderJob';
import { buildTraceScene, cameraFromObject, cameraFromViewport } from './build';
import { EMPTY_TEXTURES, PackedTextures } from './textures';
import { tonemapToImage } from './tracer';
import { RenderSettings, TraceCamera } from './types';
import { ViewportCamera } from '../../scene/ViewportCamera';

/**
 * Rendering an animation, one frame at a time.
 *
 * A single PNG is not a motion-graphics workflow. Everything needed to make
 * one was already here — a timeline, a solver that bakes to keyframes, a path
 * tracer — and the last step, turning that into a sequence somebody can hand
 * to an editor, simply did not exist.
 *
 * Every frame goes through `Scene.setFrame`, which is the same call playback
 * and scrubbing use. That is deliberate and it is the whole of the consistency
 * guarantee: there is no second evaluation path that could drift from what the
 * viewport shows, because there is no second path.
 */

export interface FrameImage {
  frame: number;
  width: number;
  height: number;
  /** Tonemapped RGBA, ready to be turned into a PNG. */
  pixels: Uint8ClampedArray;
}

export interface SequenceProgress {
  /** Frames finished so far. */
  done: number;
  total: number;
  /** The frame number just finished. */
  frame: number;
}

export interface SequenceOptions {
  settings: RenderSettings;
  /** Use the scene camera when there is one, rather than the viewport. */
  fromCamera?: boolean;
  viewport?: ViewportCamera;
  textures?: PackedTextures;
  onFrame?: (image: FrameImage) => void | Promise<void>;
  onProgress?: (progress: SequenceProgress) => void;
}

export interface SequenceResult {
  frames: number;
  cancelled: boolean;
  /** Set when a frame could not be rendered at all. */
  error?: string;
}

/** The frames a settings range covers, resolved against the timeline. */
export function framesFor(scene: Scene, settings: RenderSettings): number[] {
  const start = Math.round(settings.frameStart ?? scene.timeline.start);
  const end = Math.round(settings.frameEnd ?? scene.timeline.end);
  const step = Math.max(1, Math.round(settings.frameStep ?? 1));
  const out: number[] = [];
  // A backwards range renders one frame rather than none: somebody who types
  // an end before a start has made a mistake, and silently producing nothing
  // at the end of a long wait is the least useful way to tell them.
  if (end < start) return [start];
  for (let f = start; f <= end; f += step) out.push(f);
  return out;
}

/**
 * Render a range of frames.
 *
 * Cancellable between frames and, through the job, within one. The scene's
 * playhead is put back where it started afterwards, so rendering an animation
 * does not quietly move the user's timeline.
 */
export class SequenceRender {
  cancelled = false;
  private job: RenderJob | null = null;

  constructor(private scene: Scene, private options: SequenceOptions) {}

  cancel(): void {
    this.cancelled = true;
    this.job?.cancel();
  }

  async run(): Promise<SequenceResult> {
    const { settings } = this.options;
    const frames = framesFor(this.scene, settings);
    const wasAt = this.scene.timeline.current;
    let done = 0;
    try {
      for (const frame of frames) {
        if (this.cancelled) break;
        // The same evaluation playback uses. Nothing else poses the scene.
        this.scene.setFrame(frame);
        const camera = this.cameraFor();
        const traceScene = buildTraceScene(
          this.scene, camera, this.scene.world.sky, this.options.textures ?? EMPTY_TEXTURES,
        );
        if (traceScene.positions.length === 0) {
          return { frames: done, cancelled: this.cancelled, error: 'Nothing to render' };
        }
        const job = new RenderJob(traceScene, settings);
        this.job = job;
        await job.run();
        this.job = null;
        if (job.cancelled) {
          this.cancelled = true;
          break;
        }
        const pixels = new Uint8ClampedArray(settings.width * settings.height * 4);
        tonemapToImage(
          job.accum, job.samplesDone, settings.width, settings.height, pixels,
          settings.transparentBackground, null, settings.exposure,
        );
        await this.options.onFrame?.({
          frame, width: settings.width, height: settings.height, pixels,
        });
        done++;
        this.options.onProgress?.({ done, total: frames.length, frame });
      }
    } finally {
      // Put the playhead back. Rendering is a read of the animation, not an
      // edit of it.
      this.scene.setFrame(wasAt);
    }
    return { frames: done, cancelled: this.cancelled };
  }

  private cameraFor(): TraceCamera {
    if (this.options.fromCamera !== false) {
      const camObj = [...this.scene.objects.values()]
        .find((o) => o.type === 'camera' && o.visible);
      // Re-resolved every frame on purpose: a camera can be animated, and a
      // camera captured once before the loop would hold frame one's framing
      // for the whole shot.
      const resolved = camObj ? cameraFromObject(this.scene, camObj.id) : null;
      if (resolved) return resolved;
    }
    if (this.options.viewport) return cameraFromViewport(this.options.viewport);
    throw new Error('An animation render needs a camera in the scene or a viewport to use.');
  }
}

/** A zero-padded name, so a sequence sorts correctly in every file browser. */
export function frameFilename(frame: number, total: number, ext = 'png'): string {
  const width = Math.max(4, String(total).length);
  return `frame_${String(Math.max(0, frame)).padStart(width, '0')}.${ext}`;
}
