import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, Plugin } from 'vite';

/**
 * Write the built shell into the service worker.
 *
 * The worker cannot know the hashed asset names — they change every build —
 * and it must not have to guess, because guessing is what left the app unable
 * to open offline after a first visit. So the list is stamped in here, after
 * the bundle exists, along with a build identifier that becomes the cache name.
 *
 * The forty megabytes of depth model and ONNX runtime are deliberately left
 * out: they belong to a feature that is asked for, not to the shell, and the
 * worker holds them in a separate cache that outlives a rebuild.
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'kline-service-worker',
    apply: 'build',
    closeBundle() {
      const out = 'dist';
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'models' || entry.name === 'ort') continue;
            walk(full);
            continue;
          }
          const rel = relative(out, full).split(/[\\/]/).join('/');
          if (rel === 'sw.js' || rel.endsWith('.map') || rel.endsWith('.onnx') || rel.endsWith('.wasm')) continue;
          if (statSync(full).size > 8 * 1024 * 1024) continue;
          files.push(rel === 'index.html' ? './' : `./${rel}`);
        }
      };
      walk(out);
      files.sort();

      const hash = createHash('sha256');
      for (const rel of files) {
        const name = rel === './' ? 'index.html' : rel.slice(2);
        hash.update(rel).update(readFileSync(join(out, name)));
      }
      const build = hash.digest('hex').slice(0, 16);

      const swPath = join(out, 'sw.js');
      const source = readFileSync(swPath, 'utf8')
        .replace(/^const BUILD = .*__KLINE_BUILD__.*$/m, `const BUILD = ${JSON.stringify(build)};`)
        .replace(/^const PRECACHE = .*__KLINE_PRECACHE__.*$/m, `const PRECACHE = ${JSON.stringify(files)};`);
      if (source.includes('__KLINE_BUILD__') || source.includes('__KLINE_PRECACHE__')) {
        throw new Error('the service worker was not stamped — its marker lines have moved');
      }
      writeFileSync(swPath, source);
      this.info?.(`service worker: build ${build}, ${files.length} precached files`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [stampServiceWorker()],
  resolve: {
    // Take ONNX Runtime's build that loads its WebAssembly as a separate file
    // rather than the default, which inlines 13MB of it as base64 into the
    // JavaScript bundle. The .wasm is copied into public/ort/ and pointed at
    // explicitly, so it is served by us and never fetched from a CDN.
    conditions: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The depth runtime is loaded only when somebody asks for depth, so it
        // has to stay in its own chunk rather than being merged into the entry.
        manualChunks(id) {
          if (id.includes('onnxruntime')) return 'depth-runtime';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
