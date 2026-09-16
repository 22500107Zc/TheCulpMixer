import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Scene } from '../src/scene/Scene';
import { describePlan, executePlan, meshForPart, validatePlan } from '../src/build/plan';
import { interpret, knownSubjects } from '../src/build/interpreter';
import { RECIPES, runRecipe } from '../src/build/recipes';

interface FileAssociation { ext: string | string[]; icon?: string }
interface BuildConfig {
  afterPack?: string;
  appId?: string;
  productName?: string;
  extraMetadata?: { main?: string };
  fileAssociations?: FileAssociation[];
  mac?: { icon?: string };
  dmg?: {
    title?: string;
    window?: { width?: number; height?: number };
    iconSize?: number;
    contents?: { x: number; y: number; type?: string; path?: string }[];
  };
  win?: { icon?: string };
  linux?: { icon?: string };
}
const BUILD: BuildConfig =
  createRequire(import.meta.url)('../package.json').build ?? {};

const plan = (prompt: string) => {
  const r = interpret(prompt);
  assert.ok(r.plan, `no plan for "${prompt}": ${r.reason}`);
  return r.plan!;
};

test('a part is scaled so its bounding box matches the requested size', () => {
  for (const shape of ['cube', 'sphere', 'cylinder', 'cone', 'torus'] as const) {
    const mesh = meshForPart({ shape, position: [0, 0, 0], size: [2, 0.5, 3] });
    const s = mesh.bounds().size();
    assert.ok(Math.abs(s.x - 2) < 1e-6, `${shape} x = ${s.x}`);
    assert.ok(Math.abs(s.y - 0.5) < 1e-6, `${shape} y = ${s.y}`);
    assert.ok(Math.abs(s.z - 3) < 1e-6, `${shape} z = ${s.z}`);
  }
});

test('a part mesh is centred on its own origin', () => {
  const mesh = meshForPart({ shape: 'cone', position: [5, 5, 5], size: [1, 1, 2] });
  const c = mesh.bounds().center();
  assert.ok(Math.hypot(c.x, c.y, c.z) < 1e-6, `centre ${c.toArray()}`);
});

test('every recipe builds parts that sit on or above the ground', () => {
  for (const recipe of RECIPES) {
    const parts = runRecipe(recipe.build, { scale: 1, stretch: 1 });
    assert.ok(parts.length > 0, `${recipe.label} produced nothing`);
    for (const p of parts) {
      const bottom = p.position[2] - p.size[2] / 2;
      assert.ok(bottom > -0.35, `${recipe.label} part "${p.name}" starts at z=${bottom.toFixed(2)}`);
      assert.ok(p.size.every((v) => v > 0), `${recipe.label} has a zero dimension`);
      assert.ok(p.size.every((v) => v < 50), `${recipe.label} is implausibly large`);
    }
  }
});

test('every recipe is reachable from a plain prompt', () => {
  for (const recipe of RECIPES) {
    const p = plan(`build a ${recipe.keys[0]}`);
    assert.equal(p.name, recipe.label, `"${recipe.keys[0]}" produced ${p.name}`);
  }
});

test('scale words change the size of the result', () => {
  const normal = plan('a table');
  const big = plan('a huge table');
  const tiny = plan('a tiny table');
  const width = (p: typeof normal) => Math.max(...p.parts.map((q) => q.size[0]));
  assert.ok(width(big) > width(normal) * 2);
  assert.ok(width(tiny) < width(normal) * 0.6);
});

test('"tall" stretches height without widening', () => {
  const normal = plan('a tower');
  const tall = plan('a tall tower');
  const top = (p: typeof normal) => Math.max(...p.parts.map((q) => q.position[2] + q.size[2] / 2));
  const wide = (p: typeof normal) => Math.max(...p.parts.map((q) => q.size[0]));
  assert.ok(top(tall) > top(normal) * 1.5);
  assert.ok(Math.abs(wide(tall) - wide(normal)) < 1e-6);
});

test('a named colour is applied to the whole build', () => {
  const p = plan('a red chair');
  assert.ok(p.parts.every((q) => q.color === '#c0392b'), 'every part is red');
});

test('a hex colour is accepted', () => {
  const p = plan('a #3fb5c4 tower');
  assert.ok(p.parts.every((q) => q.color === '#3fb5c4'));
});

test('counts inside a recipe describe the recipe, not how many to build', () => {
  const withSteps = plan('stairs with 20 steps');
  assert.equal(withSteps.parts.length, 20, 'twenty steps, one staircase');
  const floors = plan('a tower of 12 floors');
  assert.equal(floors.parts.length, 12);
});

test('a count outside a recipe repeats the whole thing', () => {
  const three = plan('3 chairs');
  const one = plan('a chair');
  assert.equal(three.parts.length, one.parts.length * 3);
  const xs = new Set(three.parts.map((p) => Math.round(p.position[0] * 100)));
  assert.ok(xs.size > 1, 'the copies are spread out, not stacked');
});

test('generic shapes arrange in a row, circle, stack and grid', () => {
  const row = plan('5 cubes in a row');
  assert.equal(row.parts.length, 5);
  assert.ok(row.parts.every((p) => Math.abs(p.position[1]) < 1e-9), 'a row runs along one axis');

  const circle = plan('8 spheres in a circle');
  assert.equal(circle.parts.length, 8);
  const radii = circle.parts.map((p) => Math.hypot(p.position[0], p.position[1]));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-6, 'all on one radius');

  const stack = plan('stack of 6 boxes');
  assert.equal(stack.parts.length, 6);
  const heights = stack.parts.map((p) => p.position[2]).sort((a, b) => a - b);
  assert.ok(heights[0] < heights[5], 'they go up');
  assert.ok(stack.parts.every((p) => Math.hypot(p.position[0], p.position[1]) < 1e-9));

  const grid = plan('9 cylinders in a grid');
  assert.equal(grid.parts.length, 9);
});

test('scatter is deterministic for the same prompt', () => {
  const a = plan('12 scattered cubes');
  const b = plan('12 scattered cubes');
  assert.deepEqual(a.parts.map((p) => p.position), b.parts.map((p) => p.position));
});

test('an unrecognised prompt explains itself instead of guessing', () => {
  const r = interpret('a photorealistic dragon wearing a hat');
  assert.equal(r.plan, null);
  assert.match(r.reason ?? '', /local model|recipe/i);
});

test('an empty prompt is handled', () => {
  assert.equal(interpret('   ').plan, null);
});

test('validation repairs sloppy model output rather than rejecting it', () => {
  const { plan: p, warnings } = validatePlan({
    name: 'Thing',
    parts: [
      { type: 'box', position: [0, 0, 0.5], size: [1, 1, 1], colour: 'red' },
      { shape: 'blob', position: 'nonsense', size: 9999 },
      'not an object',
    ],
  });
  assert.ok(p);
  assert.equal(p!.parts.length, 2, 'the string was dropped, the odd shapes repaired');
  assert.equal(p!.parts[0].shape, 'cube', 'box became a cube');
  assert.equal(p!.parts[0].color, '#c0392b', 'colour name resolved');
  assert.equal(p!.parts[1].shape, 'cube', 'unknown shape fell back');
  assert.ok(p!.parts[1].size.every((v) => v <= 500), 'size clamped');
  assert.ok(warnings.length >= 2);
});

test('validation rejects input that is not a plan at all', () => {
  assert.equal(validatePlan(null).plan, null);
  assert.equal(validatePlan({ hello: 'world' }).plan, null);
  assert.equal(validatePlan({ parts: [] }).plan, null);
});

test('executing a plan groups every part under one empty', () => {
  const scene = new Scene();
  const p = plan('a table');
  const { root, objects } = executePlan(scene, p);
  assert.equal(root.type, 'empty');
  assert.equal(objects.length, p.parts.length);
  assert.equal(root.children.length, p.parts.length);
  for (const o of objects) {
    assert.equal(o.parent, root.id);
    assert.ok(o.mesh && o.mesh.faceCount > 0);
  }
});

test('executing a plan reuses one material per colour', () => {
  const scene = new Scene();
  const { objects } = executePlan(scene, plan('a red chair'));
  const slots = new Set(objects.map((o) => o.materialSlots[0]));
  assert.equal(slots.size, 1, 'one shared red material');
});

test('a built table has believable real-world proportions', () => {
  const scene = new Scene();
  const { root } = executePlan(scene, plan('a table'));
  const box = root.bounds(scene);
  for (const child of root.children) box.union(scene.get(child)!.bounds(scene));
  assert.ok(box.max.z > 0.6 && box.max.z < 0.9, `table height ${box.max.z}`);
  assert.ok(box.size().x > 1 && box.size().x < 2.5, `table width ${box.size().x}`);
});

test('the plan summary names what was built', () => {
  assert.match(describePlan(plan('a snowman')), /Snowman/);
  assert.match(describePlan(plan('5 cubes in a row')), /5 cubes/);
});

test('the recipe list is exposed for the UI', () => {
  const subjects = knownSubjects();
  assert.ok(subjects.length >= 20);
  assert.ok(subjects.includes('Table') && subjects.includes('Castle'));
});

// --------------------------------------------------------------- model layer

test('JSON is recovered from fences, prose and trailing commas', async () => {
  const { extractJSON } = await import('../src/build/llm');
  const want = { name: 'X', parts: [{ shape: 'cube' }] };
  assert.deepEqual(extractJSON('{"name":"X","parts":[{"shape":"cube"}]}'), want);
  assert.deepEqual(extractJSON('```json\n{"name":"X","parts":[{"shape":"cube"}]}\n```'), want);
  assert.deepEqual(extractJSON('Sure! Here you go:\n{"name":"X","parts":[{"shape":"cube"}]}\nHope that helps.'), want);
  assert.deepEqual(extractJSON('{"name":"X","parts":[{"shape":"cube"},],}'), want);
  assert.equal(extractJSON('no json here'), null);
  assert.equal(extractJSON('{ hopelessly [ broken '), null);
});

test('the system prompt pins down the schema the validator expects', async () => {
  const { SYSTEM_PROMPT } = await import('../src/build/llm');
  const { BUILD_SHAPES } = await import('../src/build/plan');
  for (const shape of BUILD_SHAPES) {
    assert.ok(SYSTEM_PROMPT.includes(shape), `${shape} is not offered to the model`);
  }
  assert.match(SYSTEM_PROMPT, /CENTRE|CENTER/);
  assert.match(SYSTEM_PROMPT, /metres/);
  // The worked example has to survive our own validator.
  const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('{"name":"Stool"'));
  const { extractJSON } = await import('../src/build/llm');
  const { validatePlan } = await import('../src/build/plan');
  const parsed = validatePlan(extractJSON(example));
  assert.ok(parsed.plan, 'the example in the prompt is not a valid plan');
  assert.equal(parsed.plan!.parts.length, 4);
  assert.deepEqual(parsed.warnings, []);
});

test('provider defaults point at a local, zero-cost model', async () => {
  const { PROVIDER_DEFAULTS } = await import('../src/build/llm');
  assert.match(PROVIDER_DEFAULTS.ollama.baseUrl, /127\.0\.0\.1|localhost/);
  assert.equal(PROVIDER_DEFAULTS.ollama.apiKey, '', 'a local model needs no key');
});

test('an arrangement phrase is never mistaken for the shape', () => {
  for (const [prompt, shape, count] of [
    ['12 cubes in a circle', 'cube', 12],
    ['ring of 5 boxes', 'cube', 5],
    ['8 spheres in a row', 'sphere', 8],
    ['a circle of 6 cylinders', 'cylinder', 6],
    ['stack of 4 cones', 'cone', 4],
  ] as const) {
    const p = plan(prompt);
    assert.equal(p.parts.length, count, prompt);
    assert.ok(p.parts.every((q) => q.shape === shape), `${prompt} produced ${p.parts[0].shape}`);
  }
});

test('asking for circles still gets circles', () => {
  const p = plan('3 circles in a row');
  assert.ok(p.parts.every((q) => q.shape === 'circle'));
});

test('a spiral staircase spirals, and a plain one does not', () => {
  const straight = plan('a staircase');
  const treads = (p: { parts: { name: string }[] }) => p.parts.filter((q) => q.name.startsWith('Step'));

  // A straight flight climbs along one axis and never leaves it.
  const flight = treads(straight);
  assert.ok(flight.length >= 2, 'a staircase should have steps');
  assert.ok(
    flight.every((s) => Math.abs(s.position[0]) < 1e-9),
    'a plain staircase should not wander off its axis',
  );

  const spiral = plan('a spiral staircase');
  const wound = treads(spiral);
  assert.ok(wound.length >= 2, 'a spiral staircase should have steps');

  // Every tread is the same distance from the axis, at a different angle, and
  // higher than the one before: that is what makes it a helix rather than a
  // ring or a flight.
  const radii = wound.map((s) => Math.hypot(s.position[0], s.position[1]));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-6, 'treads should share one radius');
  assert.ok(radii[0] > 0.1, 'treads should stand off the axis');

  const angles = wound.map((s) => Math.atan2(s.position[1], s.position[0]));
  assert.ok(new Set(angles.map((a) => a.toFixed(4))).size === angles.length, 'every tread turns further');
  for (let i = 1; i < wound.length; i++) {
    assert.ok(wound[i].position[2] > wound[i - 1].position[2], `tread ${i} does not rise`);
  }
  // And each one is turned to face the way it points, not left axis-aligned.
  assert.ok(
    wound.some((s) => Math.abs((s.rotation ?? [0, 0, 0])[2]) > 1),
    'treads should be rotated about the axis',
  );

  // The count still comes from the prompt.
  assert.equal(treads(plan('a spiral staircase with 20 steps')).length, 20);
});

/**
 * The packaging config, which nothing else in this suite reads.
 *
 * It is not application code, so it is easy to treat as inert — but it is the
 * only thing standing between a working build and no download at all, and it
 * fails on a machine none of us is sitting at. The rename added a second file
 * association for legacy `.kiln` scenes and gave it the same icon path as the
 * first. On macOS, and only on macOS, electron-builder hard-links each
 * association's icon into the app bundle under its own basename, so two
 * associations sharing one icon means linking the same destination twice:
 *
 *   EEXIST: file already exists, link 'build/icon.png' ->
 *     'Electron.app/Contents/Resources/icon.png'
 *
 * Windows and Linux built and published cleanly through it. The release went
 * out with no macOS installer on it, which is the platform the app is
 * developed on.
 */
test('the packaging config cannot produce a build that fails on one platform only', () => {
  // macOS: electron-builder hard-links each association's icon into the app
  // bundle under that icon's basename, so two associations sharing an icon
  // link the same destination twice and the whole job dies with EEXIST.
  const seen = new Set<string>();
  for (const fa of BUILD.fileAssociations ?? []) {
    if (!fa.icon) continue;
    const basename = fa.icon.split('/').pop() as string;
    assert.ok(
      !seen.has(basename),
      `two file associations both link "${basename}" into the macOS bundle, which fails ` +
      'with EEXIST — give each association its own icon file',
    );
    seen.add(basename);
  }

  // Linux: the obvious fix for the above — one association listing both
  // extensions — is rejected by the Linux packager, which parses `ext` as a
  // bare string and fails on an array:
  //
  //   appimage.FileAssociation.Ext: ReadString: expects " or n, but found [
  //
  // The two rules point opposite ways, which is how one release went out
  // missing macOS and the next would have gone out missing Linux. Together
  // they only leave one shape: one association per extension, each with its
  // own icon file.
  for (const fa of BUILD.fileAssociations ?? []) {
    assert.equal(
      typeof fa.ext, 'string',
      `file association ext ${JSON.stringify(fa.ext)} must be a single string — ` +
      'the Linux packager cannot read an array',
    );
  }
});

test('scenes saved before the rename still open', () => {
  // `.kiln` has to stay registered. Dropping it would leave everything saved
  // before the rename as a file the desktop app no longer recognises.
  const extensions = new Set(
    (BUILD.fileAssociations ?? []).flatMap((fa) => (Array.isArray(fa.ext) ? fa.ext : [fa.ext])),
  );
  // The extensions themselves do not move when the product is renamed: every
  // file anybody has already saved would stop being recognised.
  assert.ok(extensions.has('culpmixer'), 'the current extension must be registered');
  assert.ok(extensions.has('kiln'), 'the pre-rename extension must still be registered');
});

test('every path the packaging config points at exists', () => {
  // A missing icon or entry point is not found until a release build runs,
  // which is the slowest possible place to find it.
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const paths = [
    BUILD.extraMetadata?.main,
    BUILD.afterPack,
    ...(BUILD.fileAssociations ?? []).map((fa) => fa.icon),
    BUILD.mac?.icon, BUILD.win?.icon, BUILD.linux?.icon,
  ].filter((p): p is string => typeof p === 'string');
  assert.ok(paths.length > 0, 'the config should name some files');
  for (const p of paths) {
    assert.ok(existsSync(join(root, p)), `${p} is named by the build config but is not there`);
  }
});

test('the app is packaged under the name it is called', () => {
  assert.equal(BUILD.productName, 'The Culp Mixer');
  assert.ok(BUILD.appId?.includes('culpmixer'),
    `appId ${BUILD.appId} should identify The Culp Mixer`);

  // A rename leaves the old name behind in the places only a release
  // surfaces: an installer filename, a Start-menu shortcut, the name macOS
  // puts under the icon. Twice now, so the fields a person actually reads are
  // named here rather than scanned for — the file extensions and the icon
  // filed under one are deliberately not among them, because they cannot move
  // without orphaning every file already saved.
  const shown = [
    BUILD.productName,
    BUILD.appId,
    BUILD.win?.shortcutName,
    ...(BUILD.fileAssociations ?? []).map((fa) => fa.name),
    ...[BUILD.mac, BUILD.win, BUILD.linux, BUILD.dmg, BUILD.nsis, BUILD.portable]
      .flatMap((target) => {
        const value = (target as { artifactName?: unknown } | undefined)?.artifactName;
        return typeof value === 'string' ? [value] : [];
      }),
  ].filter((value): value is string => typeof value === 'string');

  // The names this used to have. Spelled by concatenation so that searching
  // the repository for either one comes back empty — which is the point of
  // the rename — while this check still knows what it is rejecting.
  const abandoned = new RegExp(['kil' + 'n', 'kli' + 'ne'].join('|'), 'i');
  for (const value of shown) {
    assert.ok(!abandoned.test(value), `the packaging config still says "${value}"`);
  }
  assert.ok(shown.length >= 4, 'nothing was actually checked');
});

/**
 * Ad-hoc signing, without which the macOS build does not launch at all.
 *
 * On Apple Silicon the kernel refuses to execute a binary with no signature —
 * not a Gatekeeper warning that can be clicked through, but the loader
 * rejecting the app outright with "The Culp Mixer is damaged and can't be opened."
 * electron-builder signs only when it finds a real Developer ID certificate,
 * so without an Apple account every macOS build shipped unsigned and dead.
 */
test('the macOS build is ad-hoc signed', () => {
  assert.equal(
    BUILD.afterPack, 'build/adhoc-sign.cjs',
    'without the afterPack hook nothing signs the app and Apple Silicon will not run it',
  );
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const hook = join(root, BUILD.afterPack as string);
  assert.ok(existsSync(hook), `${BUILD.afterPack} is configured but missing`);

  const loaded = createRequire(import.meta.url)(hook);
  assert.equal(typeof loaded.default, 'function', 'the hook must export a function');
});

test('the signing hook leaves every other platform alone', async () => {
  // It shells out to `codesign`, which exists only on macOS — so on Windows
  // and Linux it has to return before touching anything, or it takes those
  // builds down with it.
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const hook = createRequire(import.meta.url)(join(root, BUILD.afterPack as string));
  for (const platform of ['linux', 'win32']) {
    await hook.default({
      electronPlatformName: platform,
      // Deliberately unusable: reaching for any of this on a non-macOS build
      // is itself the bug, so it should throw rather than quietly work.
      appOutDir: null,
      packager: null,
      arch: 1,
    });
  }
});

test('signing skips the universal halves and signs everything else', () => {
  // Signing the two single-architecture builds that the universal app is
  // merged from makes their signature files differ, and the merge demands
  // byte-identical non-binary files — so it fails with "Expected all
  // non-binary files to have identical SHAs". The merged app is signed
  // instead, on the second call electron-builder makes for it.
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { isUniversalHalf } = createRequire(import.meta.url)(
    join(root, BUILD.afterPack as string),
  ) as { isUniversalHalf: (dir: string) => boolean };

  // The halves, named by electron-builder as `${appOutDir}-${Arch[arch]}-temp`.
  assert.equal(isUniversalHalf('release/mac-universal-x64-temp'), true);
  assert.equal(isUniversalHalf('release/mac-universal-arm64-temp'), true);

  // Everything that ends up in front of a user has to be signed: the merged
  // universal app behind the pkg, and the standalone builds behind the dmg
  // and zip for each architecture.
  assert.equal(isUniversalHalf('release/mac-universal'), false);
  assert.equal(isUniversalHalf('release/mac'), false);
  assert.equal(isUniversalHalf('release/mac-arm64'), false);
});


test('the disk image opens onto the app and the Applications folder, and nothing else', () => {
  // The first thing anybody sees. Without this block electron-builder still
  // makes a usable image, but nothing here says what it should contain, and
  // the layout that decides where the two icons sit is written into a
  // .DS_Store inside the image where no test can reach it. So the intent is
  // asserted where it is declared; the release workflow mounts the finished
  // image on a real Mac and checks the same three things about the result.
  const dmg = BUILD.dmg;
  assert.ok(dmg, 'no dmg block — the disk image window is left to whatever the defaults do');

  const contents = dmg!.contents ?? [];
  assert.equal(contents.length, 2, `the window would show ${contents.length} things; it should show two`);

  const app = contents.find((c) => (c.type ?? 'file') === 'file');
  const applications = contents.find((c) => c.type === 'link');
  assert.ok(app, 'nothing in the window is the application to drag');
  assert.ok(applications, 'nothing in the window is the Applications folder to drag onto');
  assert.equal(applications!.path, '/Applications', 'the shortcut does not point at Applications');

  // Side by side, the way every other Mac application does it, so the drag
  // reads as a drag. Stacked or overlapping icons do not.
  assert.notEqual(app!.x, applications!.x, 'both icons sit in the same column');
  assert.equal(app!.y, applications!.y, 'the two icons are not on the same line');
  assert.ok(app!.x < applications!.x, 'the application should sit to the left of the folder it is dragged into');

  // The volume name has to differ per architecture.
  //
  // electron-builder builds the x64 and arm64 images at the same time, and
  // each one is customised by mounting it and writing the layout into the
  // volume. With one name for both, the two mount as "The Culp Mixer" and "The Culp Mixer 1"
  // at the same moment and the layout goes into whichever the system handed
  // over — so one image came out with its icons placed and the other with no
  // .DS_Store, no background and, worst of all, no Applications folder to
  // drag onto. It was the arm64 image that lost, which is the one every
  // Apple Silicon Mac downloads: they opened it and found a single icon and
  // nowhere to put it.
  //
  // The default title is "${productName} ${version}", which collides exactly
  // the same way, so this is not something the default would have got right.
  assert.ok(dmg!.title, 'the disk image has no volume name of its own');
  assert.match(
    dmg!.title!,
    /\$\{arch\}/,
    `the volume name "${dmg!.title}" is the same for both architectures, so the two images `
    + 'are mounted under one name at the same time and one loses its layout',
  );

  // Both have to be inside the window, with room for a 128px icon and its
  // label. An icon placed outside is simply not visible.
  const width = dmg!.window?.width ?? 0;
  const height = dmg!.window?.height ?? 0;
  const icon = dmg!.iconSize ?? 80;
  assert.ok(width > 0 && height > 0, 'the window has no size, so the icon positions mean nothing');
  for (const c of contents) {
    assert.ok(c.x - icon / 2 > 0 && c.x + icon / 2 < width, `an icon at x=${c.x} falls outside a ${width}px window`);
    assert.ok(c.y - icon / 2 > 0 && c.y + icon / 2 < height, `an icon at y=${c.y} falls outside a ${height}px window`);
  }
});

test('the desktop shell uses a valid URL scheme and the real scene extension', async () => {
  // The rename from CulpMixer turned the custom protocol scheme into the literal
  // "The Culp Mixer" — but a URL scheme cannot contain spaces or capitals, so
  // "The Culp Mixer://app/" is not a URL loadURL can open, and the desktop
  // window came up blank. The same regex corrupted the scene file extension to
  // ".The Culp Mixer", which the web build never uses. Both are guarded here so
  // a future rename cannot silently break the packaged app again.
  const { readFileSync } = await import('node:fs');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');

  const scheme = main.match(/scheme:\s*'([^']+)'/);
  assert.ok(scheme, 'no custom scheme is registered');
  assert.match(scheme![1], /^[a-z][a-z0-9+.-]*$/,
    `the desktop URL scheme "${scheme![1]}" is not a valid scheme (no spaces or capitals)`);
  // The three places the scheme is used must agree.
  assert.ok(main.includes(`protocol.handle('${scheme![1]}'`), 'the protocol handler names a different scheme');
  assert.ok(main.includes(`loadURL('${scheme![1]}://app/')`), 'the window loads a different scheme');
  // And it parses as a real URL.
  assert.doesNotThrow(() => new URL(`${scheme![1]}://app/`), 'the scheme does not form a valid URL');

  // The scene extension the desktop dialogs offer must match what the web
  // build actually writes, which is .culpmixer.
  assert.ok(!/extensions:\s*\[\s*'The Culp Mixer'/.test(main),
    'a file dialog still offers the broken "The Culp Mixer" extension');
  assert.match(main, /extensions:\s*\['culpmixer'/, 'the save dialog does not offer .culpmixer');
});
