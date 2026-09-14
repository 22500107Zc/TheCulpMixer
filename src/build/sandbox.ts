import { BuildPart, validatePlan } from './plan';

/**
 * Running generated code safely.
 *
 * "Build anything" cannot come from a fixed set of recipes — it comes from a
 * model writing a short program against a geometry API, which is how you get a
 * spiral staircase or a 37-tooth gear without anyone having anticipated them.
 * That program is untrusted, so it runs inside a Worker with the dangerous
 * globals removed and a hard time limit, and it can only produce data: a list
 * of primitives that goes through the same validator as everything else.
 */

export interface RunLimits {
  maxParts: number;
  maxMs: number;
  /**
   * The largest result the worker may hand back, in rough bytes.
   *
   * A part cap alone does not bound memory: a program can put a very long
   * string in a name or an id and stay well under four thousand parts while
   * returning hundreds of megabytes to a thread that has to parse it.
   */
  maxBytes?: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxParts: 4000, maxMs: 3000, maxBytes: 16 * 1024 * 1024 };

export interface RunResult {
  parts: BuildPart[];
  /** Anything the program passed to log(). */
  log: string[];
  ms: number;
}

/**
 * The sandbox harness, as source, because it has to be injected into a Worker
 * and also executed directly in tests. Defining it once as a string keeps those
 * two paths honestly identical.
 */
export const HARNESS_SOURCE = `
function buildParts(code, maxParts) {
  var parts = [];
  var log = [];
  var seed = 1234567;

  function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  function num(v, fallback) {
    v = Number(v);
    return isFinite(v) ? v : fallback;
  }

  function push(shape, x, y, z, w, d, h, color, rot, name, id) {
    if (parts.length >= maxParts) {
      throw new Error('This program tried to make more than ' + maxParts + ' parts.');
    }
    parts.push({
      shape: shape,
      name: name || undefined,
      id: typeof id === 'string' && id ? id : undefined,
      position: [num(x, 0), num(y, 0), num(z, 0)],
      size: [Math.abs(num(w, 1)) || 0.001, Math.abs(num(d, 1)) || 0.001, Math.abs(num(h, 1)) || 0.001],
      rotation: rot ? [num(rot[0], 0), num(rot[1], 0), num(rot[2], 0)] : undefined,
      color: typeof color === 'string' ? color : undefined
    });
  }

  var api = {
    box: function (x, y, z, w, d, h, c) { push('cube', x, y, z, w, d, h, c); },
    cube: function (x, y, z, w, d, h, c) { push('cube', x, y, z, w, d, h, c); },
    cyl: function (x, y, z, w, d, h, c) { push('cylinder', x, y, z, w, d, h, c); },
    cylinder: function (x, y, z, w, d, h, c) { push('cylinder', x, y, z, w, d, h, c); },
    sphere: function (x, y, z, w, d, h, c) { push('sphere', x, y, z, w, d, h, c); },
    ball: function (x, y, z, diameter, c) { push('sphere', x, y, z, diameter, diameter, diameter, c); },
    cone: function (x, y, z, w, d, h, c) { push('cone', x, y, z, w, d, h, c); },
    torus: function (x, y, z, w, d, h, c) { push('torus', x, y, z, w, d, h, c); },
    plane: function (x, y, z, w, d, c) { push('plane', x, y, z, w, d, 0.001, c); },
    part: function (spec) {
      spec = spec || {};
      var at = spec.at || spec.position || [0, 0, 0];
      var size = spec.size || [1, 1, 1];
      push(spec.shape || 'cube', at[0], at[1], at[2], size[0], size[1], size[2],
        spec.color, spec.rot || spec.rotation, spec.name, spec.id);
    },
    log: function () {
      if (log.length < 40) log.push(Array.prototype.join.call(arguments, ' '));
    },
    random: rnd,
    PI: Math.PI, TAU: Math.PI * 2,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
    abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
    floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, pow: Math.pow,
    hypot: Math.hypot, sign: Math.sign, Math: Math
  };

  var names = Object.keys(api);
  var values = names.map(function (n) { return api[n]; });
  // Shadow the escape hatches as parameters, so a stray fetch in generated code
  // is a TypeError rather than a request. "eval" and "Function" are absent on
  // purpose: they are illegal as strict-mode parameter names, and the harness
  // needs Function itself. They are handled below instead.
  // Capabilities: everything in a worker that can reach the network, persist
  // data, or start another context. These are removed for real and the removal
  // is *verified* — a sandbox that reports itself as one while a hole is open
  // is worse than no sandbox, because it is the version people trust.
  //
  // Several of them (indexedDB, caches, navigator) are not own properties of
  // the worker global at all: they are configurable accessors on
  // WorkerGlobalScope.prototype, so deleting them off self silently does
  // nothing and leaves storage wide open to anything that walks the prototype
  // chain. The strip helper below walks it.
  // ------------------------------------------------------------ the allowlist
  //
  // This used to be a list of dangerous names to delete. That is the wrong way
  // round and it failed exactly as a denylist always does: WebSocket was on
  // it, WebSocketStream was not, and a program could open a socket to any host
  // it liked. The platform adds APIs faster than any list is maintained, and
  // every one of them arrives switched on.
  //
  // So the rule is inverted. Everything reachable from the worker global is
  // removed *except* a small set of pure-computation names a geometry program
  // legitimately needs. A capability shipped in Chrome next year is blocked
  // the day it ships, because nobody has to remember to add it.
  var allowed = {
    // Values and language intrinsics.
    Infinity: 1, NaN: 1, undefined: 1, globalThis: 1, self: 1,
    Object: 1, Function: 1, Boolean: 1, Symbol: 1, BigInt: 1,
    Number: 1, String: 1, Array: 1, Math: 1, JSON: 1, Date: 1, RegExp: 1,
    Map: 1, Set: 1, WeakMap: 1, WeakSet: 1, WeakRef: 1, Promise: 1,
    Proxy: 1, Reflect: 1, Intl: 1, escape: 1, unescape: 1,
    Error: 1, TypeError: 1, RangeError: 1, SyntaxError: 1, ReferenceError: 1,
    EvalError: 1, URIError: 1, AggregateError: 1,
    isNaN: 1, isFinite: 1, parseInt: 1, parseFloat: 1,
    decodeURI: 1, decodeURIComponent: 1, encodeURI: 1, encodeURIComponent: 1,
    eval: 1, console: 1,
    // Typed arrays: plain number storage, no reach of their own. Note that
    // SharedArrayBuffer and Atomics are deliberately absent — those are shared
    // memory between contexts, not arithmetic.
    ArrayBuffer: 1, DataView: 1,
    Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1,
    Int16Array: 1, Uint16Array: 1, Int32Array: 1, Uint32Array: 1,
    Float32Array: 1, Float64Array: 1, BigInt64Array: 1, BigUint64Array: 1,
    // Iteration and structure, used by ordinary code.
    Iterator: 1, AsyncIterator: 1, ArrayIteratorPrototype: 1,
    structuredClone: 1,
    // Timers stay: the harness runs the program synchronously under a wall
    // clock the main thread enforces by terminating the worker, so a timer
    // cannot outlive the run, and removing them breaks ordinary library code.
    setTimeout: 1, clearTimeout: 1, setInterval: 1, clearInterval: 1,
    queueMicrotask: 1,
    // Needed by the harness itself before it hands over. Captured and rebound
    // by the worker wrapper, then removed here along with everything else.
    onmessage: 1, onerror: 1, onunhandledrejection: 1, onrejectionhandled: 1,
    addEventListener: 1, removeEventListener: 1, dispatchEvent: 1,
    Event: 1, EventTarget: 1, MessageEvent: 1, ErrorEvent: 1,
    PromiseRejectionEvent: 1, WorkerGlobalScope: 1, DedicatedWorkerGlobalScope: 1,
    constructor: 1
  };
  // Names still shadowed as parameters, so the common mistakes read as
  // undefined rather than as something half-removed.
  var shadowed = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
    'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'caches',
    'localStorage', 'sessionStorage', 'Request', 'Response', 'EventSource',
    'BroadcastChannel', 'MessageChannel', 'navigator', 'postMessage',
    'require', 'process', 'window', 'document', 'location', 'origin'];
  // Spot checks: if any of these is still reachable after the sweep, the sweep
  // did not work and the program must not run. Not the mechanism — the sweep
  // is — but the alarm on it.
  var mustBeGone = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
    'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'caches',
    'localStorage', 'sessionStorage', 'Request', 'Response', 'EventSource',
    'BroadcastChannel', 'navigator', 'BackgroundFetchManager', 'SharedArrayBuffer',
    'Atomics', 'WebAssembly', 'createImageBitmap', 'FileReader', 'FileReaderSync'];
  var blocked = shadowed.concat(['self', 'globalThis']);
  var args = names.concat(blocked);
  var vals = values.concat(blocked.map(function () { return undefined; }));

  var body = '"use strict";\\n' + code + '\\n';
  // Compile first, because this needs the real Function constructor.
  var fn = new Function(args.join(','), body);

  // Then empty those globals for real. Parameter shadowing on its own is
  // defeated by Function('return this')(); this is not, because the properties
  // are genuinely gone before the program runs. Only ever applied inside a
  // Worker — never to a page or Node global.
  var inWorker = typeof importScripts !== 'undefined' && typeof self !== 'undefined';
  if (inWorker) {
    // Held before anything is removed, because the removal needs somewhere to
    // look names up and self is one of the things that can go.
    var g = self;
    // Remove a name wherever it actually lives — on the global itself or on
    // anything in its prototype chain. Several capabilities (indexedDB,
    // caches, navigator) are not own properties of the worker global at all:
    // they are configurable accessors on WorkerGlobalScope.prototype, so
    // deleting them off self alone silently does nothing.
    var strip = function (name) {
      try { delete g[name]; } catch (e) { /* not configurable here */ }
      var proto = Object.getPrototypeOf(g);
      var guard = 0;
      while (proto && guard++ < 16) {
        if (Object.getOwnPropertyDescriptor(proto, name)) {
          try { delete proto[name]; } catch (e2) { /* not configurable there */ }
        }
        proto = Object.getPrototypeOf(proto);
      }
      if (g[name] !== undefined) {
        try { g[name] = undefined; } catch (e3) { /* read-only */ }
      }
    };

    // Sweep the whole surface, not a list of things somebody thought of.
    var seen = {};
    var scope = g;
    var depth = 0;
    while (scope && depth++ < 16) {
      var own = Object.getOwnPropertyNames(scope);
      for (var oi = 0; oi < own.length; oi++) {
        var name = own[oi];
        if (seen[name] || allowed[name] === 1) continue;
        seen[name] = 1;
        strip(name);
      }
      scope = Object.getPrototypeOf(scope);
    }

    // The alarm. Parameter shadowing is defeated by Function('return this')(),
    // so the sweep above is the isolation and this only checks it worked.
    var survivors = [];
    for (var ci = 0; ci < mustBeGone.length; ci++) {
      if (g[mustBeGone[ci]] !== undefined) survivors.push(mustBeGone[ci]);
    }
    if (survivors.length) {
      throw new Error('The isolated worker could not be locked down (' + survivors.join(', ')
        + ' still reachable), so the program was not run.');
    }
  }

  fn.apply(null, vals);
  return { parts: parts, log: log };
}
`;

/** The API description handed to the model, kept next to the implementation. */
export const API_REFERENCE = `Available functions (all coordinates in metres, Z up, ground at z = 0,
and x/y/z is always the CENTRE of the part):

  box(x, y, z, width, depth, height, color)
  cyl(x, y, z, width, depth, height, color)      // a cylinder, height along Z
  sphere(x, y, z, width, depth, height, color)
  ball(x, y, z, diameter, color)
  cone(x, y, z, width, depth, height, color)     // point upward
  torus(x, y, z, width, depth, height, color)
  plane(x, y, z, width, depth, color)
  part({shape, at:[x,y,z], size:[w,d,h], rot:[rx,ry,rz], color, name, id})   // rot in degrees
  log(...)                                        // shows in the panel

Also in scope: PI, TAU, sin, cos, tan, atan2, abs, min, max, round, floor,
ceil, sqrt, pow, hypot, sign, Math, random() (seeded, so results repeat).

Colors are hex strings like '#8b5e34'.

Give every part a stable "id" when you can — a short name like 'top' or
'leg-3'. It is how an edited version of this program is matched up with the
model already in the scene, so somebody's material and placement survive a
revision. Ids must be unique within one program. If you are editing an
existing program, keep the ids exactly as they are.`;

interface HarnessResult {
  parts: unknown[];
  log: string[];
}

type Harness = (code: string, maxParts: number) => HarnessResult;

let cachedHarness: Harness | null = null;

/** Compile the harness once for direct (non-Worker) execution. */
function harness(): Harness {
  if (!cachedHarness) {
    cachedHarness = new Function(`${HARNESS_SOURCE}; return buildParts;`)() as Harness;
  }
  return cachedHarness;
}

/**
 * Run a program on this thread, with no isolation whatsoever.
 *
 * This is **not** a sandbox and the application never calls it. It exists so
 * the test suite can exercise the same harness source that the worker runs,
 * in a runtime that has no Worker at all.
 *
 * It used to double as a fallback for `runProgramSandboxed`, which meant that
 * on any browser where a blob Worker could not start — an unusual Content
 * Security Policy is enough — untrusted generated code quietly ran on the main
 * thread instead: no time limit, so an infinite loop hung the tab with the
 * document in it, and none of the globals removed, because the removal only
 * ever applies inside a worker. A fallback that silently drops every guarantee
 * the feature is sold on is worse than not running at all, so it is gone.
 */
export function runProgramHere(code: string, limits: RunLimits = DEFAULT_LIMITS): RunResult {
  const started = Date.now();
  const raw = harness()(code, limits.maxParts);
  const { plan, warnings } = validatePlan({ name: 'Build', parts: raw.parts });
  if (!plan) throw new Error(`The program produced no usable parts. ${warnings.join(' ')}`.trim());
  return { parts: plan.parts, log: raw.log, ms: Date.now() - started };
}

function workerSource(): string {
  // Everything is wrapped in a closure so the harness's own names — buildParts,
  // reply — are not properties of the worker global. The lockdown sweeps the
  // global by allowlist, and a top-level `var` in a classic worker *is* a
  // global property: the first version of the sweep dutifully deleted the
  // harness's own reply channel along with everything else, and every run came
  // back "reply is not a function".
  return `(function () {
${HARNESS_SOURCE}
// Captured before the harness empties the globals, which includes this one.
var reply = self.postMessage.bind(self);
self.onmessage = function (e) {
  try {
    var out = buildParts(e.data.code, e.data.maxParts);
    // Measured here, where the strings still live in the worker, so an
    // oversized result is refused before the main thread has to hold a copy.
    var bytes = 0;
    try { bytes = JSON.stringify(out.parts).length * 2; } catch (sizeErr) { bytes = Infinity; }
    if (e.data.maxBytes && bytes > e.data.maxBytes) {
      reply({ ok: true, parts: [], log: out.log, bytes: bytes });
      return;
    }
    reply({ ok: true, parts: out.parts, log: out.log, bytes: bytes });
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  }
};
})();`;
}

/**
 * Run a program in a Worker, terminating it if it overruns. An infinite loop in
 * generated code is a when-not-if, and this is the only way to survive one.
 */
export function runProgramSandboxed(
  code: string, limits: RunLimits = DEFAULT_LIMITS,
): Promise<RunResult> {
  if (typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.reject(new Error(
      'Generated code needs an isolated worker and this browser will not start one. '
      + 'It is usually a Content Security Policy that blocks blob: workers, or a '
      + 'private-mode restriction. Nothing was run. The built-in shapes and the '
      + 'modelling tools all work without it.',
    ));
  }
  const started = Date.now();
  const blob = new Blob([workerSource()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    return Promise.reject(new Error(
      `The isolated worker could not be started (${(err as Error).message}), so the program `
      + 'was not run.',
    ));
  }

  return new Promise<RunResult>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The program was still running after ${limits.maxMs}ms and was stopped. Check for a loop that never ends.`));
    }, limits.maxMs);

    worker.onmessage = (event: MessageEvent) => {
      cleanup();
      const data = event.data as {
        ok: boolean; parts?: unknown[]; log?: string[]; error?: string; bytes?: number;
      };
      if (!data.ok) {
        reject(new Error(data.error ?? 'The program failed.'));
        return;
      }
      const cap = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes ?? 0;
      if (cap > 0 && (data.bytes ?? 0) > cap) {
        reject(new Error(
          `The program returned ${Math.round((data.bytes ?? 0) / 1024 / 1024)}MB of parts, over `
          + `the ${Math.round(cap / 1024 / 1024)}MB limit, and was stopped.`,
        ));
        return;
      }
      const { plan, warnings } = validatePlan({ name: 'Build', parts: data.parts ?? [] });
      if (!plan) {
        reject(new Error(`The program produced no usable parts. ${warnings.join(' ')}`.trim()));
        return;
      }
      resolve({ parts: plan.parts, log: data.log ?? [], ms: Date.now() - started });
    };
    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'The program could not be started.'));
    };
    worker.postMessage({ code, maxParts: limits.maxParts, maxBytes: limits.maxBytes });
  });
}
