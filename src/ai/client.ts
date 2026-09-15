import { Mesh } from '../mesh/Mesh';
import { importOBJ } from '../io/obj';

/**
 * Bridge to a local image-to-3D model.
 *
 * The Culp Mixer does not ship neural weights — they are gigabytes and want a GPU. What
 * it ships is the client half of a deliberately small contract, so any local
 * server that speaks it (see tools/The Culp Mixer-ai-server.py) can hand geometry back
 * into the scene. Nothing leaves the machine unless the endpoint points off it.
 */

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8017';
const STORAGE_KEY = 'kline.ai.endpoint';

export interface BackendInfo {
  name: string;
  /** Model identifiers the server will accept in a request. */
  models: string[];
  /** Free-form, shown in the UI: device, precision, whatever the server reports. */
  detail?: string;
}

export interface GenerateRequest {
  image: Blob;
  model?: string;
  prompt?: string;
  /** Hint for how dense a mesh to return. */
  detail?: 'draft' | 'standard' | 'high';
  signal?: AbortSignal;
}

export interface GeneratedMesh {
  name: string;
  mesh: Mesh;
  /** Seconds the server reported spending, when it says. */
  seconds?: number;
}

export function storedEndpoint(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

export function storeEndpoint(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    /* Private browsing; the endpoint just will not persist. */
  }
}

function normalise(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/** Ask a server whether it is there and what it can do. Never throws. */
export async function probeBackend(
  endpoint: string, timeoutMs = 2500,
): Promise<{ ok: true; info: BackendInfo } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalise(endpoint)}/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, reason: `Server answered ${response.status}` };
    const body = (await response.json()) as Partial<BackendInfo>;
    return {
      ok: true,
      info: {
        name: body.name ?? 'local model',
        models: Array.isArray(body.models) ? body.models : [],
        detail: body.detail,
      },
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return { ok: false, reason: aborted ? 'No answer before the timeout' : 'Nothing listening' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post a frame and get a mesh back. The server may reply with an OBJ directly
 * or with JSON wrapping one; both are accepted so a five-line server is enough
 * to be useful.
 */
export async function generateMesh(
  endpoint: string, request: GenerateRequest,
): Promise<GeneratedMesh> {
  const form = new FormData();
  form.append('image', request.image, 'reference.png');
  if (request.model) form.append('model', request.model);
  if (request.prompt) form.append('prompt', request.prompt);
  form.append('detail', request.detail ?? 'standard');

  const response = await fetch(`${normalise(endpoint)}/generate`, {
    method: 'POST',
    body: form,
    signal: request.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The model server returned ${response.status}. ${text.slice(0, 200)}`.trim());
  }

  const contentType = response.headers.get('content-type') ?? '';
  let objText: string;
  let name = 'AI Mesh';
  let seconds: number | undefined;

  if (contentType.includes('application/json')) {
    const body = (await response.json()) as { format?: string; data?: string; name?: string; seconds?: number };
    if (!body.data) throw new Error('The server replied with JSON but no mesh data.');
    if (body.format && body.format.toLowerCase() !== 'obj') {
      throw new Error(`The Culp Mixer can read OBJ from a model server; this one sent "${body.format}".`);
    }
    objText = body.data;
    if (body.name) name = body.name;
    seconds = body.seconds;
  } else {
    objText = await response.text();
  }

  const objects = importOBJ(objText);
  if (objects.length === 0) throw new Error('The server sent a mesh The Culp Mixer could not read.');

  // Fold multi-object results into one, so a generation is one scene object.
  const mesh = objects[0].mesh;
  for (let i = 1; i < objects.length; i++) mesh.append(objects[i].mesh);
  if (objects.length === 1 && objects[0].name) name = objects[0].name;
  return { name, mesh, seconds };
}
