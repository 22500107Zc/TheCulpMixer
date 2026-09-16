import { BUILD_SHAPES, BuildPlan, validatePlan } from './plan';
import { API_REFERENCE } from './sandbox';

/**
 * Optional model backends for the build prompt.
 *
 * On cost, plainly: **Ollama is the only option that is free forever** — it
 * runs on your own machine, needs no account and makes no network calls. The
 * OpenAI-compatible provider works with anything that speaks that API, which
 * includes free tiers (Groq, OpenRouter's free models) and other local servers
 * (LM Studio, llama.cpp, vLLM). Free tiers are free today, rate-limited, and
 * not promises — so nothing here is on by default and the built-in interpreter
 * always answers first.
 *
 * Small models are unreliable at freeform 3D. They are reasonably good at
 * filling in a flat JSON array of boxes and cylinders, which is exactly what
 * the schema below asks for, and everything they return is validated and
 * repaired before it reaches the scene.
 */

export type ProviderKind = 'ollama' | 'openai';

export interface LLMConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  /** Only sent to an OpenAI-compatible endpoint; never needed for Ollama. */
  apiKey: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderKind, Omit<LLMConfig, 'provider'>> = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2', apiKey: '' },
  openai: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '' },
};

const STORAGE_KEY = 'culpmixer.build.llm';

export function loadConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LLMConfig>;
      const provider: ProviderKind = parsed.provider === 'openai' ? 'openai' : 'ollama';
      // Stored values win, but a missing field falls back to the provider default.
      return { ...PROVIDER_DEFAULTS[provider], ...parsed, provider };
    }
  } catch {
    /* Unreadable or unavailable storage; fall through to defaults. */
  }
  return { provider: 'ollama', ...PROVIDER_DEFAULTS.ollama };
}

export function saveConfig(config: LLMConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Nothing to do; the settings just will not persist. */
  }
}

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

export const SYSTEM_PROMPT = `You turn a description of an object into a 3D build plan.

Reply with JSON only. No prose, no markdown fences. The shape is:
{"name":"short name","parts":[{"shape":"cube","name":"Leg","position":[x,y,z],"size":[w,d,h],"color":"#rrggbb"}]}

Rules:
- "shape" is one of: ${BUILD_SHAPES.join(', ')}.
- Units are metres. Z is up. The ground is z = 0.
- "position" is the CENTRE of the part, so a 1m tall box on the floor is z = 0.5.
- "size" is the bounding box [width, depth, height] in metres. Never 0.
- Keep everything at or above the ground and roughly life-sized: a chair seat is
  about 0.45m up, a door is about 2m tall, a car is about 4m long.
- Use 3 to 40 parts. Build the object out of simple primitives.
- "color" is a hex string. Optional "rotation" is degrees [x,y,z].
- Centre the object on x = 0, y = 0.

Example for "a wooden stool":
{"name":"Stool","parts":[
{"shape":"cylinder","name":"Seat","position":[0,0,0.6],"size":[0.34,0.34,0.05],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[0.12,0,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[-0.06,0.1,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[-0.06,-0.1,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"}]}`;

export interface ProbeResult {
  ok: boolean;
  /** Model names the endpoint reports, when it can. */
  models: string[];
  detail: string;
}

/** Is anything listening, and what can it run? Never throws. */
export async function probeProvider(config: LLMConfig, timeoutMs = 3000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = trimUrl(config.baseUrl);
  try {
    const url = config.provider === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.provider === 'openai' && config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        detail: response.status === 401 || response.status === 403
          ? 'The endpoint rejected the key.'
          : `The endpoint answered ${response.status}.`,
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const list = config.provider === 'ollama'
      ? (body.models as { name?: string }[] | undefined)?.map((m) => m.name ?? '') ?? []
      : (body.data as { id?: string }[] | undefined)?.map((m) => m.id ?? '') ?? [];
    const models = list.filter(Boolean).sort();
    return {
      ok: true,
      models,
      detail: models.length ? `${models.length} model(s) available.` : 'Connected, but no models are installed.',
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      ok: false,
      models: [],
      detail: aborted
        ? 'No answer before the timeout.'
        : config.provider === 'ollama'
          ? 'Nothing listening. Install Ollama and run `ollama serve`.'
          : 'Could not reach that endpoint.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first JSON object out of a reply, tolerating fences and stray prose. */
export function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Trailing commas are the single most common thing small models get wrong.
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

async function chat(
  config: LLMConfig, messages: { role: string; content: string }[], signal?: AbortSignal,
): Promise<string> {
  const base = trimUrl(config.baseUrl);
  if (config.provider === 'ollama') {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: 0.3 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}. Is "${config.model}" pulled?`);
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The endpoint answered ${response.status}. ${text.slice(0, 160)}`.trim());
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}

export interface GenerateResult {
  plan: BuildPlan;
  warnings: string[];
  seconds: number;
}

/**
 * Ask the model for a plan. One repair round-trip is allowed, because small
 * models routinely get the JSON right on the second try when told what broke.
 */
export async function generatePlan(
  config: LLMConfig, prompt: string, signal?: AbortSignal,
): Promise<GenerateResult> {
  const started = Date.now();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  let reply = await chat(config, messages, signal);
  let parsed = extractJSON(reply);
  let result = validatePlan(parsed, prompt.slice(0, 30));

  if (!result.plan) {
    messages.push({ role: 'assistant', content: reply.slice(0, 2000) });
    messages.push({
      role: 'user',
      content: 'That was not a usable plan. Reply with JSON only, matching the schema exactly, with a non-empty "parts" array.',
    });
    reply = await chat(config, messages, signal);
    parsed = extractJSON(reply);
    result = validatePlan(parsed, prompt.slice(0, 30));
  }

  if (!result.plan) {
    throw new Error(`${config.model} did not return a usable plan. Try a larger model, or a simpler description.`);
  }
  return {
    plan: { ...result.plan, source: `${config.provider}:${config.model}` },
    warnings: result.warnings,
    seconds: (Date.now() - started) / 1000,
  };
}


// ---------------------------------------------------------------- code output

/**
 * The other way to ask a model for geometry: have it write a short program.
 *
 * A flat parts list can only describe what the model can enumerate by hand. A
 * loop can describe a 40-step spiral staircase, a gear with any tooth count, or
 * a city block — so this is the path that actually means "build anything", and
 * the JSON planner stays as the simpler fallback for weaker models.
 */
export const CODE_SYSTEM_PROMPT = `You write short JavaScript programs that build 3D models.

Reply with JavaScript only. No prose, no markdown fences, no function wrapper —
just statements that call the API below. Do not use fetch, imports, or the DOM.

${API_REFERENCE}

Guidance:
- Build the object out of primitives. Use loops for anything repetitive.
- Keep it life-sized: a chair seat is ~0.45m up, a door ~2m tall, a car ~4m long.
- Everything sits at or above z = 0 and is centred on x = 0, y = 0.
- Aim for 5 to 300 parts. Prefer a loop over a hundred literal calls.
- Give parts sensible colours.

Example — "a spiral staircase with 30 steps":
const steps = 30, radius = 1.8;
for (let i = 0; i < steps; i++) {
  const a = i / steps * TAU * 1.25;
  part({ shape: 'cube', at: [cos(a) * radius, sin(a) * radius, i * 0.18 + 0.09],
         size: [1.3, 0.42, 0.18], rot: [0, 0, a * 180 / PI], color: '#8b5e34' });
}
cyl(0, 0, steps * 0.09, 0.24, 0.24, steps * 0.18, '#5a5a5e');`;

/** Pull JavaScript out of a reply that may be fenced or prefaced with prose. */
export function extractCode(text: string): string {
  const fenced = [...text.matchAll(/```(?:js|javascript|ts)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (fenced.length) return fenced.sort((a, b) => b.length - a.length)[0];
  // No fences: drop any leading chat before the first line that looks like code.
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*(const|let|var|for|function|part\(|box\(|cyl\(|sphere\(|ball\(|cone\(|torus\(|plane\(|\/\/)/.test(l));
  return (start >= 0 ? lines.slice(start) : lines).join('\n').trim();
}

export interface ProgramResult {
  code: string;
  seconds: number;
}

/** Ask the model for a program. Retries once with the error when it does not run. */
export async function generateProgram(
  config: LLMConfig,
  prompt: string,
  verify: (code: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<ProgramResult> {
  const started = Date.now();
  const messages = [
    { role: 'system', content: CODE_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  let code = extractCode(await chatPlain(config, messages, signal));
  try {
    await verify(code);
    return { code, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    // Handing the model its own error back is what turns a 3B model from
    // unusable into usable; it fixes its own typos far more often than not.
    messages.push({ role: 'assistant', content: code.slice(0, 2000) });
    messages.push({
      role: 'user',
      content: `That failed with: ${(err as Error).message}\nReply with corrected JavaScript only.`,
    });
    code = extractCode(await chatPlain(config, messages, signal));
    await verify(code);
    return { code, seconds: (Date.now() - started) / 1000 };
  }
}

/** Same transport as the JSON planner, without forcing a JSON response format. */
async function chatPlain(
  config: LLMConfig, messages: { role: string; content: string }[], signal?: AbortSignal,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (config.provider === 'ollama') {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}. Is "${config.model}" pulled?`);
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The endpoint answered ${response.status}. ${text.slice(0, 160)}`.trim());
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}
