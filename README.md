# The Culp Mixer

**A 3D modelling application for your desktop — and your browser.** The Culp Mixer is an
alternative to Blender's modelling workflow: mesh editing with
bevel and booleans, sculpting, UV unwrapping, keyframe animation, a
non-destructive modifier stack, PBR materials, a path-traced renderer and glTF
export — in dependency-free TypeScript. Drop in a photo or a video and it
builds geometry from it. No account, no server; nothing you open ever leaves
your machine.

**Proprietary software. 33-hour free trial, then $199/month.** The Culp Mixer is not
open source and it is not free — see [LICENSE](LICENSE).

![The Culp Mixer editing a subdivided form](docs/screenshot.png)

The Culp Mixer runs two ways: as a **desktop app** you double-click, or as a page in a
browser tab. Same code either way.

## Download

Click your platform. The file downloads straight away — these links always
point at the newest release, so they never go stale.

| | |
|---|---|
| **macOS — Apple Silicon** (M1/M2/M3/M4) | **[Download CulpMixer-arm64.dmg](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer-arm64.dmg)** |
| **macOS — Intel** | **[Download CulpMixer-x64.dmg](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer-x64.dmg)** |
| **macOS — installer** (either chip) | [CulpMixer-universal.pkg](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer-universal.pkg) |
| **Windows** | **[Download CulpMixer-Setup.exe](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer-Setup.exe)** · [portable](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer-portable.exe) |
| **Linux** | **[Download CulpMixer.AppImage](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer.AppImage)** · [.deb](https://github.com/22500107Zc/CulpMixer/releases/latest/download/CulpMixer.deb) |

Not sure which Mac you have?  ▸ **About This Mac**. "Apple M1/M2/M3/M4" means
Apple Silicon; "Intel" means Intel.

### First launch

These builds are not signed by a paid Apple or Microsoft developer account, so
each system asks once whether you meant it. Once, not every time.

- **macOS** — open the `.dmg`, drag The Culp Mixer to Applications, then **right-click
  The Culp Mixer ▸ Open ▸ Open**. Double-clicking will not work the first time; the
  right-click is what offers the Open button.
  If it says the app **"is damaged and can't be opened"**, that is the
  quarantine flag macOS puts on downloaded unsigned apps, not a broken file:

  ```
  xattr -dr com.apple.quarantine /Applications/The Culp Mixer.app
  ```

- **Windows** — SmartScreen shows "Windows protected your PC" ▸ **More info** ▸
  **Run anyway**.
- **Linux** — `chmod +x CulpMixer.AppImage`, then run it.

The Culp Mixer gets a Dock or Start-menu entry, opens `.culpmixer` files on double-click
(and `.kiln` files saved before the rename), and has a real menu bar with
native Open and Save dialogs.

### Or build it yourself

```bash
git clone https://github.com/22500107Zc/CulpMixer.git
cd The Culp Mixer
npm install

npm run app     # build and launch the desktop app
npm run dist    # build an installer for the machine you are on -> release/
npm run dev     # web version with hot reload, for working on The Culp Mixer itself
```

`npm run dist` only builds for the OS it runs on — macOS installers need a Mac.
The release workflow builds all three on tag push.

### Or just use the browser

```bash
npm start       # builds, then opens http://localhost:4173
```

Chrome and Edge can install that page as a standalone app too (⋮ ▸ *Install page
as app*), which is lighter than the Electron build and works offline from the
first visit — the service worker caches the shell while it installs rather than
waiting for a second visit to see the traffic. Each build gets its own cache,
and a new version waits behind a **Reload** bar instead of swapping itself in
under an open document. The depth model is kept separately and survives an
update, so a rebuild does not cost forty megabytes of download. The Culp Mixer needs WebGL2 — Chrome, Firefox, Edge and Safari 15+ all have it.
Opening `dist/index.html` straight off disk will *not* work: browsers block ES
modules over `file://`.

---

## Just say what you want

There is a **Build** box across the top of the viewport. Type into it, press
Enter, and a model writes a short program that builds what you asked for.

```
a spiral staircase with 30 steps      a gear with 24 teeth
a suspension bridge                    a chess rook
a city block of towers                 a DNA double helix
```

![Two 24-tooth gears and a sphere helix, built from generated programs](docs/build-from-code.png)

The program is real code against a small geometry API — `box`, `cyl`,
`sphere`, `cone`, `torus`, `part`, plus loops and trigonometry — so the ceiling
is what the model can express, not a list somebody wrote in advance. Press
**Code** to read it, edit it and re-run. A gear is a loop; a staircase is a
loop; a city is a nested loop. That is why this is code and not a menu.

Generated code is untrusted, so it runs in a Worker with `fetch`, storage and
the DOM removed, a part budget and a three-second limit — an infinite loop gets
terminated instead of freezing the app. All it can do is return a list of
primitives, which goes through the same validator as everything else.

### You need a model for this

Arbitrary requests need something that can write arbitrary programs. **Ollama
is the only genuinely free-forever option**, because it runs on your machine:

```bash
# install Ollama, then:
ollama pull qwen2.5-coder:7b     # or llama3.2 on a smaller machine
ollama serve
```

Click the chip at the right of the Build box, press **Connect**, and you are
done. The Culp Mixer defaults to `http://127.0.0.1:11434`.

Any OpenAI-compatible endpoint works too — Groq and OpenRouter have free tiers,
LM Studio and llama.cpp are local. Be clear-eyed about hosted "free": those
tiers are free *today*, rate-limited, and need an account. Nobody serves GPUs
for nothing indefinitely, so local is the only zero anyone can promise.

Coding models do this better than chat models. When one writes something that
does not run, The Culp Mixer hands the error back and asks again — which is usually
enough.

### Without a model

Two things still work with nothing installed:

- **Write the code yourself.** Press **Code** and use the same API. No model, no
  network, no cost.
- **Built-in subjects.** Twenty-one procedural recipes (table, chair, house,
  tree, castle, robot, rocket, car, snowman, stairs, and so on) plus shape
  arrangements: `12 cubes in a circle`, `stack of 8 spheres`, `9 cylinders in a
  grid`. Instant and offline, but a fixed list — which is exactly why the code
  path exists.

Every build lands as a group of ordinary editable meshes. Tab into Edit Mode and
keep going.

## Quick keys

| | |
|---|---|
| `Cmd/Ctrl + K` | Search every command — the fastest way to find anything |
| `Cmd/Ctrl + Shift + B` | Jump to the Build box |
| `Cmd/Ctrl + U` | UV editor |
| `Cmd/Ctrl + G` | Graph editor |
| `Cmd/Ctrl + D` | Compare versions |
| `F12` | Render the image |
| Help ▸ Getting Started | The guided tour, any time |
| `?` | The full keyboard sheet |

The palette lists commands from the other mode too, marked, so you can discover
that Recalculate Normals lives in Edit Mode instead of finding nothing.

---

## First time here

The Culp Mixer opens with a short guided tour the first time you run it — six cards
covering the two modes, the transform keys, the Build box and version
comparison. Each card has a button that does the thing it is describing to the
scene behind it, because watching a cube light up with vertices teaches more
than reading that Tab does that.

Tick **Do not show this when The Culp Mixer opens** and it will not come back. It stays
in **Help ▸ Getting Started** if you want it again.

---

## See what changed

Every other 3D application answers *what does this look like now*. None of them
answers *what is different from an hour ago* — you open the old file next to
the new one and squint at it.

Press `Cmd/Ctrl + D` and pick a version: a step in your undo history, or a
scene file from last week. The model in front of you is then coloured by what
actually changed.

- **Green** — geometry this version gained.
- **Amber** — geometry that is the same, but somewhere else.
- **Red outlines** — faces that are gone, drawn where they used to be.

Alongside it, a per-object list: what moved, what was renamed, whose modifier
stack changed, whose material changed, how many faces and vertices each object
gained or lost. Click any of them to frame it.

It keeps up while you work. Undo a step with a comparison open and the geometry
it added stops being green while you watch.

It also says what it did **not** read. A comparison that reports "identical"
over something it never examined is worse than no comparison, because it is
believed — so UVs, vertex colours, skin weights, seams and smoothing are all
compared, material *values* are compared as well as which slots an object points
at, and anything genuinely outside its reach (the pixels inside an embedded
texture, the output of a modifier stack rather than its input) is listed rather
than rounded down to "the same". A pairing that is not certain — a part matched
by its generated identity after a rebuild renumbered it, an object whose
modifiers mean the mesh compared is not the mesh drawn — is marked as uncertain
instead of being presented with the same confidence as an exact one.

The hard part is that a mesh has no line numbers. Comparing vertex arrays falls
apart the moment an operator renumbers anything — and most of them do. So faces
are identified by where their corners are in space, sorted so that winding and
starting corner do not matter, which survives an operator rebuilding the mesh
from scratch. An index-aligned pass runs first to catch geometry that merely
*moved*, since a sculpted face is neither an addition nor a deletion and
reporting it as both would be true and useless.

---

## Revise what you generated, without losing what you did to it

Generating a starting point is the easy half. The half every tool skips is
coming back to it. *"Make that staircase thirty steps instead of twenty"* is a
sentence anyone would say, and everywhere else the answer is: generate a second
staircase, and redo your materials on it. Nothing was kept — not the prompt,
not the recipe, not the settings, not what the geometry looked like before you
started working on it — so there is nothing to revise, only something to
replace.

The Culp Mixer keeps all four, in the file.

**Create New** builds something. **Revise Selected** changes it.

```
Select the staircase → type "change this staircase from 20 steps to 30" → Revise Selected
```

The revision is staged, not applied. You see it in the viewport, and a panel
tells you what it kept, what it changed, and anything it could not reconcile.
**Accept** keeps it as a single undo step. **Reject** puts the scene back
exactly as it was, with nothing left in the history.

### Keep working while you review

A staged revision is applied to the scene so you can see it, and the transaction
is scoped to *that asset* — not to the document. So you can carry on modelling
while you decide: add objects, duplicate, sculpt something else, change
materials elsewhere. Reject puts the asset back and leaves everything you did in
the meantime exactly as it is. Accept takes in the asset and nothing else, as one
undo step, so undoing the revision does not undo your afternoon.

Two things are held, both because a proposal would otherwise escape as though it
were the model: editing the asset *under review* (an edit there would be
destroyed whichever button came next), and writing the document out — save,
autosave, export, open, new. Everything else is yours.

### What is kept automatically

The trick is that there are three versions of every part in play, not two: what
the generator made last time, what *you* made of it, and what the generator
would make now. With all three, each field decides on its own — the generator
changed it and you did not, take theirs; you changed it and they did not, keep
yours. So a revision keeps:

- **Materials and texture assignments** — a re-run has no opinion about them.
- **Names, transforms, parenting** — a part you moved stays where you put it.
- **Visibility and locking.**
- **Objects you added yourself.** A handrail you modelled onto a generated
  staircase has no part identity, and that absence is what marks it as yours:
  it is never matched, replaced or removed.
- **Modifier stacks, animation and rig relationships.**
- **Unrelated objects**, which are not touched at all.

Repeated parts have a defined correspondence when the count changes, rather than
matching on array position or display name. Twenty steps becoming thirty keeps
`step#1`–`step#20` and adds ten; thirty becoming twenty removes the top ten
instead of renumbering everything.

A generated program can do better than that, and should: give a part an `id`
and it keeps that identity through renaming and reordering, which recipes get
for free and programs do not.

```js
part({ shape: 'cube', id: 'top', name: 'Tabletop', at: [0, 0, 0.75], size: [1.6, 0.9, 0.06] });
```

Parts with no id are matched by the order they are created in, which is a guess
the moment a program reorders itself — so that is said out loud rather than
presented as a match. Two parts sharing an id are not silently picked between:
both are flagged and treated as uncertain, because either choice would attach
somebody's material to the wrong thing.

### Deleting a generated part is a decision

Delete a step and it stays deleted. Not just this revision — the next one, the
one after that, and after a save and a reload. The deletion is recorded in the
file, so it is something you did once rather than a chore you repeat.

Five cases, spelled out:

| | |
|---|---|
| Never existed, the revision adds it | genuinely new |
| You deleted it, the revision leaves it alone | stays deleted |
| You deleted it, the revision *changes* it | conflict — stays deleted until you ask for it back |
| You both dropped it | stays deleted, no argument |
| You changed it, the revision removes it | conflict — kept until you say otherwise |

Bringing one back is a choice you make, in the panel, per part.

### Fields disagree one at a time

Shape, name, position, rotation and scale are five separate decisions, and each
one gets the same three-way treatment: only the generator moved it, take
theirs; only you moved it, keep yours; you both moved it to the *same* place,
no argument; you both moved it differently, that is a conflict and it says so.

Conflicts resolve at the scope they are about. Choosing the revised geometry
does not also reset a name you chose or a placement you set — those are
different arguments, and you may not be having them.

Each choice shows what it will actually do: *Keep mine — 6, 0.56, 0.27* next to
*Use revised — 0, 1.008, 0.486*, rather than two buttons whose consequences you
have to guess at.

### What causes an explicit conflict

Not everything can survive a regeneration, and The Culp Mixer does not pretend otherwise.
A sculpted crease, an unwrapped UV island, a painted weight and a vertex colour
are all stored against *particular vertices*. When a revision produces different
vertices, the mapping is gone — no merge brings it back.

So those are conflicts, and they are reported as conflicts:

- **You changed the shape and so did the revision**, differently.
- **The revision changes the topology** of something you edited. The message
  names what is stored against the old vertices — "your UV coordinates are
  stored against the vertices this would replace" — rather than leaving you to
  find out.
- **The revision removes a part you had edited.**
- **A protected part would change.** Tick *Protect from regeneration* on any
  part and a revision that would touch it reports it instead.
- **No baseline was recorded**, so your edits cannot be told apart from the
  generator's. Everything is offered as the generator made it, and the panel
  says so.
- **The record predates The Culp Mixer storing materials, modifiers and animation**, so
  a part cannot be *shown* to be unedited. Missing evidence is not permission:
  it is kept and flagged rather than deleted on an assumption.
- **A removal would take work of yours with it** — anything you modelled and
  parented under the part being removed. Agreeing to the removal lifts your
  work clear and keeps it where it was in the world.

### Per-vertex work is carried, not written off

Choosing the revised shape after a topology change does not simply discard what
was stored against the old vertices. Your UV coordinates, vertex colours, skin
weights and sculpt mask are resampled onto the new surface by nearest surface
point, blended across the triangle they land on. It is an approximation — a
weight sampled at the nearest point is not a weight the old vertex had, because
there is no old vertex — and it says so: the panel reports what was carried and
how many vertices had no close match, so you know which areas to check.

Nothing is written to a disputed field until it is answered, and a revision
with anything unanswered cannot be accepted. There is one action to settle the
rest — *Keep my versions for all remaining* — and taking it is recorded as an
override rather than as agreement.

Nothing is applied to a conflicted part. Your version is what stays in the
scene, and you choose per object: **Keep mine**, **Use the revised one**, **Keep
both**, or reject the revision entirely. The success condition is preserved work
or an explicit conflict — never silent loss.

### What is recorded, and what is not

Every generated object carries, in the `.culpmixer` file: what made it (a recipe, a
generated program, a reference image), the prompt, the program, the settings as
named values, a schema and generator version, a stable identity for the asset
and for each of its parts, and the geometry the generator produced.

**Opening a file never re-runs anything.** You see the geometry the file
contains. A regeneration happens only because somebody asked for one.

Files written before any of this existed simply have none of it, which is an
ordinary scene — it opens exactly as it always did, and Revise says plainly that
there is nothing recorded to revise from. The same is true of anything you
modelled by hand or imported.

Where a dependency is genuinely missing it is named rather than discovered as a
failure later: a photo model whose picture was not embedded says *"the picture
this was built from (logo.png) is not in this file"*.

### Where the revision comes from

- **Recipes** revise by *changing a setting and running again* — instant,
  offline, exactly repeatable. "Thirty steps" changes `count` from 20 to 30.
  Nothing is asked to reinvent a staircase, so nothing else silently changes.
  A request that names no setting the object actually has says so rather than
  quietly doing nothing.
- **Generated programs** revise by editing the program — with a model, or by
  hand. Press **Code** and the selected asset's own program is loaded. Edit it
  and press **Preview Revision of Selected**: it goes through the same merge,
  preview and accept as everything else, keeping the asset's identity and your
  edits to it. **Run as New** is the other button, for when you want a second
  object rather than a revision. No model, account or network is needed for
  either.
- **Reference images** revise from the Create panel, where the picture and its
  settings are. Sliders rebuild in place while the model is still exactly what
  those settings made — there is nothing at risk. Once you have edited it, or
  when you press **Preview as Revision**, it goes through the same review as
  everything else. A resolution change replaces every vertex, so a sculpt or an
  unwrap on it is a conflict, and it is shown as one.

This is not branching or merging in the Git sense, and it is not described as
such. There are no branches, no merge commits and no history graph — there is a
recorded baseline, a three-way comparison against it, and a preview you accept
or reject.

---

## Build from a reference

![A traced mug reference extruded into a solid, hole and all](docs/reference-to-mesh.png)

Drag an image or a video anywhere onto the window. The Culp Mixer reads it locally and
builds a mesh straight away — then rebuilds that same object as you adjust the
settings, with what it found drawn over your reference so the result is
something you can see rather than guess at. Videos are scrubbable, so any frame
can be the source.

| Mode | What it does | Good for |
|---|---|---|
| **Photo** | Finds the subject by colour, inflates it to its own thickness, and projects the photograph on as a texture | Photographs of real objects |
| **Cut Out** | Traces the outline, extrudes it into a flat solid holes included, and projects the photograph on as a texture | Logos, signage, silhouettes, flat parts |
| **Turn** | Revolves the profile around a vertical axis | Vases, bottles, turned legs, anything round |
| **Relief** | Displaces a grid by image brightness | Carvings, terrain, depth maps, stamps |

These are deterministic geometry, not a model: no weights to download, no GPU,
no network, a few hundred milliseconds for a photograph and a few for the rest.
What comes out is an ordinary editable mesh — press Tab and keep modelling.

### What Photo mode actually does

Three things, and the first is why the other generators fall over on real
photographs:

**It finds the subject by colour.** A band around the edge of the frame is
taken as definitely background and the middle as probably subject; each gets a
small set of colour clusters in CIELAB, every pixel goes to whichever set
explains it better, and the whole thing runs again from the result, sharpened
each pass against the image's own colour edges. That is a cut-down GrabCut, and
it is the difference between a photograph working and not — a single brightness
threshold is right for a logo on white and useless for a shoe on a floor.
Speckles elsewhere in the frame are dropped and enclosed dark details are
filled, so a buckle does not punch a hole through the model.

**It models the subject, not the photograph.** The mesh grid is fitted to the
subject's own bounds, so a thing filling a quarter of the frame gets the whole
detail budget rather than a quarter of it — how tightly you happened to crop no
longer decides how good the model is.

**It inflates the outline to its own thickness.** Solving ∇²h = -4 across the
inside of the silhouette and taking √h gives exactly a hemisphere over a
circle, and everywhere else gives a thickness that follows the *local* width.
A wide body comes out deep and a thin strap comes out thin, from one solve.
That is the part a distance-to-the-outline inflation gets wrong, and it is why
inflated silhouettes usually look like inflated silhouettes. Shading inside the
subject, with its broad lighting gradient removed, is added on top for creases
and seams, and the whole field is smoothed along the image's colour edges.
Most things people photograph are bilaterally symmetric while the light on them
is not, so the depth is evened out across the subject's own mirror line — but
only as far as the silhouette actually mirrors itself, measured, so something
genuinely lopsided is left alone. The outline never moves; it is the reliable
half of the picture.

**It puts the photograph on the model.** Per-corner coordinates, projected from
the camera the photo was taken from, with the image embedded in the scene. A
grey lump in the right outline is not what anyone wanted.

The result stands upright on the floor, is closed and watertight — every edge
shared by exactly two faces, so it booleans, prints and exports — and is an
ordinary mesh you can sculpt, cut and re-topologise.

One thing it cannot do is see the back, and it does not pretend to: the far
side is the near side, shallower, with a **Back fullness** slider from mirrored
to flat. For a real reconstruction of the unseen half you need a model with a
learned prior, which is the next section.

### Hooking up a local AI model

For genuine single-image reconstruction (TripoSR, InstantMesh, TRELLIS,
Hunyuan3D and friends), The Culp Mixer talks to a model server you run yourself. It does
not bundle weights — those are gigabytes and want a GPU — but the other half is
in the box:

```bash
python3 tools/The Culp Mixer-ai-server.py                  # echo backend, verifies the wiring
python3 tools/The Culp Mixer-ai-server.py --backend triposr
```

Then in The Culp Mixer: **Create ▸ Local AI model ▸ Check ▸ Generate 3D**. The server
defaults to `127.0.0.1`, so your images stay on your machine unless you
deliberately point it somewhere else.

The contract is two endpoints, so pointing The Culp Mixer at your own pipeline means
writing one function:

```
GET  /health    -> {"name": str, "models": [str], "detail": str}
POST /generate  -> multipart: image, model, prompt, detail
                <- an OBJ, or {"format":"obj","data":"...","seconds":float}
```

The included `--backend triposr` implementation is a reference: it is written
against TripoSR's published API but needs you to install the model and its
weights, and it has not been run in this repository's CI, which has no GPU. The
`echo` backend is exercised end to end and is there so you can confirm the
connection before installing anything.

---

## Why this exists

Blender is extraordinary and The Culp Mixer is not trying to replace it. What The Culp Mixer
replaces is the *first ten minutes*: downloading a 300 MB package to box-model
a shape, check a silhouette, clean up a scanned mesh, or convert an OBJ to
glTF. The Culp Mixer opens in a tab, uses Blender's keymap so your hands already know it,
and everything you make stays on your machine — there is no server.

The whole application is dependency-free TypeScript: the mesh kernel, the
renderer, the path tracer, the sculpt brushes, the unwrapper, the modifiers and
the UI are all in this repository, and each piece is readable on its own.

## What works today

**Say what you want**
- A Build box where a local model writes a program that builds what you asked for
- A sandboxed geometry API you can also write against by hand, with no model
- 21 procedural subjects and shape arrangements as the offline fallback
- Command palette over every operation in the app

**From a reference**
- Drop an image or video anywhere in the window; scrub a video to pick a frame
- **Photo** mode: colour segmentation, Poisson inflation and the photograph
  projected back on as a texture — a closed, watertight, upright model
- Cut Out, Turn and Relief generators, rebuilt live as you tune them
- Automatic subject detection by colour, brightness, transparency or a channel
- Optional bridge to a local image-to-3D model server

**Modelling**
- Vertex, edge and face select modes with box select, edge-ring select and
  x-ray selection
- **Bevel** (`Ctrl+B`) with drag-to-width, scroll-to-segments and a profile
  control. The arc is centred where a real fillet's is, so a rounded cube comes
  out with the volume Steiner's formula says it should have; the width clamps
  globally rather than per corner, so it stays even instead of pinching; and
  per-edge weights let one operation round the hard corners heavily and leave
  the soft ones alone
- **Booleans** — union, difference and intersect, destructively or as a live
  modifier pointed at another object. Surface-based rather than BSP, so two
  curved surfaces meeting almost tangentially cost nothing special — the case
  that hangs a BSP boolean finishes here in about 60ms — and the result is
  repaired back to a closed solid rather than left with hairline cracks
- Extrude region (constrained to the face normal), inset with live preview,
  loop cut with a scroll-adjustable cut count and on-canvas preview
- **Knife** (`K`) — click a line over the model and it cuts along it, sharing
  the new vertices between both faces on every edge it crosses so the seam is
  a seam and not a hairline crack
- Bisect with a cap, spin/revolve, bridge edge loops, symmetrize, poke,
  limited dissolve, T-junction repair
- **Decimate** by quadric error metrics — cut a scan or a subdivided mesh to a
  tenth of its triangles with the silhouette intact
- Subdivide, dissolve, merge (at centre and by distance), make face, delete,
  duplicate, triangulate, smooth, flip and recalculate normals
- **Proportional editing** (`O`) with six falloff curves, straight-line or
  measured along the surface, radius on the scroll wheel
- **Snapping** (`Shift+Tab`) to increment, absolute grid, vertex, edge or face
- Modal transforms exactly as you expect: `G`/`R`/`S`, `X`/`Y`/`Z` to constrain,
  `Shift`+axis for a plane, typed numeric input, `Ctrl` to invert snapping,
  `Shift` for precision, `Esc` to cancel

**Sculpting**
- Eleven brushes: draw, smooth, inflate, grab, flatten, scrape, pinch, crease,
  mask, weight and colour
- Dabs land at a fixed spacing along the stroke, so the same gesture gives the
  same result whether you draw it fast or slowly
- **Voxel remesh** — rebuild the topology at an even density from the shape
  alone, for when a limb you pulled out has run out of polygons
- **Masking** holds part of the model still, so you can sculpt a face without
  dragging the ear along with it
- Radius, strength and auto-smooth; `Ctrl` inverts, `[` and `]` resize
- X/Y/Z symmetry, and a brush ring drawn on the surface so you can see the
  falloff before you commit to it

**UVs and texturing**
- **Unwrap** (`U`) with least-squares conformal maps, cut along seams you mark
  or where the surface folds past an angle limit
- Smart, cube, cylinder, sphere and planar projection
- Islands packed at a shared texel density by a MaxRects packer that tries
  several orderings and bin widths, so one texture resolves the whole model
  evenly and does not spend half of itself on air
- A UV editor (`Cmd/Ctrl+U`) that shades every face by stretch — a wireframe
  layout cannot show the thing that actually ruins a texture — and lets you
  drag the coordinates directly
- **Texture painting** straight onto the model, stamped once per face so a
  seam gets painted from both sides and does not show as a gap
- **Vertex colours**, for getting colour onto something without unwrapping it
  first
- Image textures with tiling and offset, plus a generated UV checker

**Animation**
- Keyframes on location, rotation and scale, with constant, linear and
  auto-eased bezier interpolation
- Keyframes on properties too: light power and colour, camera field of view,
  material colour, roughness, metallic, alpha and emission
- A **graph editor** (`Cmd/Ctrl+G`) that draws the actual curves — drag keys to
  retime or revalue them, and see the easing rather than guessing at it
- A timeline with a scrubbable playhead, keyframe markers, frame range, fps
  and looping playback
- **Actions and strips.** Keep a take as a named action, lay it on the timeline
  as a strip, and give it a start, an end, a speed, an offset into the action,
  a loop, fades at each end, and a weight. Several strips blend: `replace`
  crosses from one take to the next, `add` rides on top — which is how a wave
  happens while the walk keeps walking, something a single channel list cannot
  express at all
- Exported into glTF as real animation samplers. Location, rotation and scale
  travel; light, camera and material curves stay in the `.culpmixer` file, because
  glTF animates node transforms only — and the exporter says so rather than
  letting you find out in the other application

**Rigging**
- **Inverse kinematics** — a chain of bones that reaches a target bone, with a
  chain length, a pole to decide which way the joint bends, and an influence
  that blends the solve rather than switching it on. Cyclic coordinate descent,
  so a target out of reach extends the limb towards it instead of snapping, and
  a chain folded back on itself still solves
- **Bone constraints**: copy rotation, copy location, track to, and rotation
  limits — applied in the order you put them in, so a limit after an IK solve
  holds against the solver rather than only against what you typed
- **Control bones** in one step: an unparented bone that deforms nothing, which
  is what a rig is actually grabbed by
- Armatures with bones you extrude into a chain, drawn as octahedra so their
  roll is visible
- **Bind with automatic weights** in one step — weights, modifier and link
- Four bone influences per vertex, saved with the mesh so subdividing carries
  them
- A weight brush for fixing what the automatic pass got wrong

**Physics**
- Rigid bodies, active and passive, as boxes or spheres
- **Bake to keyframes** over the timeline, after which nothing depends on the
  solver — the animation is the artefact
- Sequential-impulse contacts with positional correction, so a stack settles
  instead of sinking or shuffling

**Rendering**
- A **path-traced renderer**: BVH-accelerated, metallic-roughness GGX, soft
  shadows from sized lights, a sky dome and global illumination
- **Glass** — transmission and index of refraction, with total internal
  reflection, and shadow rays that pass through it instead of treating a window
  as a brick
- **Emissive surfaces sampled directly**, with multiple importance sampling, so
  an emission plane lights a room cleanly instead of as noise
- **Depth of field** from a camera aperture and focus distance
- An **edge-aware denoiser** guided by surface colour, normal and depth, so a
  low-sample preview is usable — noise falls off as the square root of samples,
  which makes the last of the speckle the most expensive part of the image
- Progressive — the image refines pass by pass, across every core the machine
  has, and you can re-grade the exposure or toggle the denoiser without
  restarting
- Save a still as a PNG, or **render an animation**: a deterministic frame
  sequence with progress, a cancel button and a stated frame range, written as
  numbered files into one folder you pick — on the desktop and in the browser
  alike — or recorded straight to WebM where you want a single file

**Scene**
- Object hierarchy with parenting, per-object visibility and locking
- Point, sun, spot and area lights; camera objects you can look through
- PBR materials (base colour, metallic, roughness, emission, alpha) with
  per-face material slots
- Non-destructive modifiers: Subdivision Surface (Catmull–Clark), Mirror,
  Array, Solidify, Weld, Triangulate, Smooth, **Boolean**, **Decimate** and
  **Bevel** — reorderable, toggleable, applyable

**Viewport**
- Solid (studio-lit), Material (scene-lit PBR) and Wireframe shading
- **Shadow mapping** from the strongest sun or spot, filtered so the edges are
  soft rather than stepped
- Mipmapped, anisotropically filtered textures — without them a textured floor
  shimmers on every camera move
- Infinite grid that re-scales by powers of ten, selection outlines, edit-mode
  overlays, light and camera gizmos, a 3D cursor
- Orbit/pan/zoom, orthographic toggle, numpad axis views, frame selected/all

**Files**
- Save and open scenes as `.culpmixer` (plain JSON — diffable, scriptable), and
  open `.kiln` files saved before the rename
- Import OBJ; export OBJ + MTL (written together, so the material file and the
  textures it names arrive with the geometry), binary STL, and glTF 2.0 with
  `KHR_lights_punctual`, `KHR_materials_transmission` and `KHR_materials_ior`
- glTF carries vertex colours, skin weights with their bind matrices, and each
  camera's own settings rather than one default, and the export passes the
  Khronos glTF validator with no errors. What the format cannot carry — bone
  curves, depth of field, emission above 1, a texture on geometry with no UVs —
  comes back as a written warning rather than a silent omission
- Snapshot undo/redo across every operation, including modifier edits. Snapshots
  share the meshes an edit did not touch, so editing one object in a scene of
  twenty no longer copies all twenty, and the history is bounded by memory as
  well as by a step count
- Crash-recovery autosave to IndexedDB, which has room for a real scene — five
  rolling copies, offered rather than restored silently, because the one you
  want back is often not the newest

## Keyboard

| | |
|---|---|
| `Tab` | Object Mode ⇄ Edit Mode |
| `1` `2` `3` | Vertex / edge / face select |
| `G` `R` `S` | Move, rotate, scale — then `X`/`Y`/`Z`, or type a number |
| `E` `I` `Ctrl+R` `Ctrl+B` | Extrude, inset, loop cut, bevel |
| `K` | Knife — click points, `Enter` to cut |
| `U` | Unwrap the selection |
| `Cmd/Ctrl+U` `Cmd/Ctrl+G` | UV editor, graph editor |
| `O` `Shift+Tab` | Proportional editing, snapping |
| `I` `Alt+I` | Insert / delete keyframe (Object Mode) |
| `Space` `←` `→` | Play, step a frame |
| `F12` | Render the image |
| `M` `F` `X` `Ctrl+X` | Merge, make face, delete, dissolve |
| `A` `Alt+A` `Ctrl+I` | Select all / none / invert |
| `Shift+D` `Ctrl+J` `Ctrl+A` | Duplicate, join, apply transform |
| `Z` `Alt+Z` | Cycle shading, toggle x-ray |
| `Numpad 1/3/7` `5` `0` | Front / right / top, orthographic, camera view |
| `.` `Home` | Frame selected, frame all |
| `Ctrl+Z` `Ctrl+Shift+Z` | Undo, redo |

### Photographs into models

Two routes, because photographs come in two kinds.

**Photo** finds the subject by colour, inflates it to a thickness that follows
its own local width, adds surface relief from the shading, and projects the
picture back on. It is exact for one object against a background you can tell
apart from it, and it produces a closed solid you can print. When the colours
are too close to separate, draw on the preview — a stroke over the subject and
a stroke over the background are treated as fact, and the model is rebuilt from
what you said.

**Whole Scene** is for photographs with no single subject to cut out: a room, a
street, somebody standing in front of something. It reads the distance to
every part of the picture with a depth network — Depth Anything V2 Small,
26MB, bundled — and builds the surface that describes. Where the depth steps
between one thing and another the surface breaks rather than stretching, so a
foreground stands in front of a background instead of being joined to it by a
sheet of rubber.

The depth model runs on your machine, through a WebAssembly runtime served from
the application itself. Nothing is uploaded, and nothing is fetched from
anywhere at run time — it works with the network unplugged. It is loaded the
first time you ask for it and never otherwise, so a session that does not use
it costs nothing.

**Cut Out and Turn** find their subject with a brightness threshold rather
than colour, which is the right tool for a logo on white and the wrong one for
anything else — so they take the same brush. A stroke marked Subject or
Background overrules the threshold outright, and both routes now project the
photograph onto what they build, with every coordinate stepped a couple of
pixels off the outline so the edge of the model wears the subject's own colour
instead of a fringe of whatever was behind it.

What one photograph cannot give you, either way, is the back of anything. Both
routes are honest about that rather than inventing it.

See `THIRD-PARTY-NOTICES.md` for the model's licence and attribution.

### Moving around the viewport

`Option` on a Mac is `Alt` on Windows and Linux, and `Cmd` is `Ctrl`. The Culp Mixer
reads both, and the hints it shows in the application use whichever names the
machine it is running on has.

| Trackpad | Mouse | |
|---|---|---|
| `Option` + two-finger scroll, or `Option` + drag | Middle-drag | Orbit |
| `Shift` + scroll, or `Option`+`Shift` + drag | `Shift` + middle-drag | Pan |
| Pinch, or two-finger scroll | Wheel | Zoom towards the cursor |
| `Option`+`Cmd` + drag | `Ctrl` + middle-drag | Zoom |

Holding `Option` and scrolling with two fingers turns the view: nothing to hold
down, no second hand, and no middle mouse button — which a laptop does not
have. Gestures are measured in pixels of finger travel rather than in wheel
clicks, so a trackpad glides where a wheel steps.

Zooming goes towards whatever is under the cursor, not the middle of the
screen. Point at the corner you want a closer look at and scroll; it stays
where it is instead of sliding away as you approach.

`Shift` + right click places the 3D cursor. `.` frames what is selected and
`Home` frames everything — handy when you have lost the object off screen. The
full list lives behind **Shortcuts** in the menu bar.

## How it is built

```
electron/            Desktop shell: window, native menu, file dialogs
src/
  core/math.ts        Vec3, Mat4, AABB, ray intersection, matrix decomposition
  mesh/               The geometry kernel
    Mesh.ts             n-gon polygon mesh + cached derived topology
    primitives.ts       Blender-compatible primitive builders
    ops.ts              extrude, inset, loop cut, Catmull-Clark, merge, dissolve…
  imaging/            Reference to geometry
    contour.ts          Thresholding, marching-squares tracing, simplification
    triangulate.ts      Ear clipping with hole bridging
    generate.ts         Silhouette, lathe and heightfield builders
  ai/client.ts        Client for a local image-to-3D server
  build/              Say-what-you-want
    plan.ts             The build DSL, validation and execution
    sandbox.ts          Geometry API; runs generated code in a locked-down Worker
    llm.ts              Ollama / OpenAI-compatible code generation
    recipes.ts          Procedural subjects, for when no model is connected
    interpreter.ts      Offline prompt -> plan
    bevel.ts            Fan-based bevel: sectors, profiles, corner patches
    csg.ts              Surface-based booleans: BVH crossings, cut, classify
    bvh.ts              Triangle BVH: box queries, raycasts, inside tests
    boolean.ts          Post-cut repair: coplanar dissolve, stitching, manifold
    knife.ts            Screen-space cutting with shared seam vertices
    remesh.ts           Signed distance field + marching cubes
    skin.ts             Bone weights, envelope binding, linear blend skinning
    modeling.ts         Bisect, spin, bridge, symmetrize, poke
    decimate.ts         Quadric error metric simplification
  uv/
    unwrap.ts           Islands, LSCM flattening, projections
    pack.ts             MaxRects island packing
    transfer.ts         Resampling coordinates across an edit
  paint/texture.ts    Painting onto a texture through the UV layout
  sculpt/sculpt.ts    Brushes, falloff and the hash grid they query
  physics/            Rigid bodies, and baking them down to keyframes
  anim/
    animation.ts        Channels, interpolation, sampling
    armature.ts         Bones, pose evaluation, skinning matrices
  modifiers/          Non-destructive stack; each modifier is mesh -> mesh
  scene/              Scene graph, materials, lights, the orbit camera
  render/             WebGL2 forward renderer, GLSL, buffer builders
    pathtrace/          BVH, GGX path tracer, worker pool, progressive job
      denoise.ts          Edge-aware a-trous filter, guided by the first hit
  editor/             Modes, selection, CPU picking, modal transforms, undo,
                      the command registry and keymap
    selection.ts        Mode-authoritative selection derivation
  ui/                 Plain-DOM shell: header, toolbar, outliner, properties
  desktop.ts          Bridge to the Electron host; a no-op in a browser tab
```

Three decisions shape everything else:

**The mesh is an n-gon soup with derived adjacency.** `Mesh` stores positions
and polygon corner lists; `Mesh.topology()` builds edges, vertex/face
adjacency and normals on demand and caches them against a revision counter.
Operators get half-edge-quality queries without the cost of keeping a half-edge
structure valid through every edit, and serialization, undo and export all stay
trivial. Extrude and inset share one primitive — `splitRegion` detaches a face
region along its boundary and bridges the gap — so they can never disagree
about topology.

**Picking happens on the CPU.** Rays are cast against triangles and elements
are matched in screen space, rather than reading back a GPU id buffer. No
pipeline stall, no second render pass, and "nearest within N pixels, preferring
what is in front" is expressed directly.

**Selection is mode-authoritative.** Whichever of vertex/edge/face mode you are
in owns its set, and the other two are derived from it with Blender's
conversion rules. Deriving everything from vertices is simpler but wrong: an
edge ring around a closed shape has every corner as an endpoint, so a
vertex-derived edge set would light up the whole mesh.

**Undo takes whole-scene snapshots, but shares what did not change.** Snapshots
in exchange for correctness: every operator, however exotic, is undoable
without anybody writing a matching inverse. The obvious cost — copying every
mesh in the scene on every edit — is avoided by serializing each mesh once per
revision and letting every snapshot point at the same frozen blob, so the work
is proportional to what the edit touched. A modal transform pushes one snapshot
before it starts, so cancelling an extrude rolls back the extrusion *and* the
move.

**Booleans work on surfaces, not on a tree of planes.** The classic BSP
approach splits every polygon against every plane it meets, which is fine on
flat operands and never finishes on two rounded surfaces meeting almost
tangentially. The Culp Mixer finds the triangle pairs that actually cross through a BVH,
cuts only those, and classifies each piece by ray parity — so the work is
proportional to the number of crossings rather than to their arrangement.
Floating point still leaves the occasional sliver, and no tolerance setting
removes those without eating real detail, so the result is repaired back to a
closed solid instead.

## Development

```bash
npm run dev         # Vite dev server with HMR
npm run typecheck   # tsc --noEmit, strict
npm test            # everything below
npm run test:unit   # 367 unit tests over the kernel, operators, UVs, sculpting,
                    # animation, the path tracer, comparison, the scene and IO
npm run test:app    # 20 tests in a real browser: shadows land, overlays draw,
                    # strokes and rigs reach the screen, comparisons tint,
                    # clicks and modals behave. Skipped without Chromium.
npm run build       # typecheck + production bundle into dist/
npm run app         # run the desktop shell against the built bundle
npm run dist        # package installers for the current OS into release/
```

`dist/` is a static folder — drop it on any host, no backend required.

The tests are the specification for the geometry kernel. They assert real
invariants (a cube stays a closed manifold through extrude and loop cut,
Catmull–Clark converges toward a sphere while pinning open boundaries, solidify
produces watertight output) rather than snapshotting numbers, so they catch
genuine topology regressions.

The browser suite covers the part no unit test can reach. Three bugs shipped
through that gap — a shadow pass that silently drew nothing, a click that threw
away the selection it had just confirmed, an axis whose labels ran together —
and each was found by looking at the screen rather than by running the suite.
So `tests/app.test.mjs` renders real frames under SwiftShader and reads the
pixels back, and drives real pointer and key input. Every test in it was
written against a failure that actually reached a user, and each was checked by
putting the bug back and watching it go red. It needs Playwright and a Chromium
build; without either it skips with a reason and the rest still runs.

## Not there yet

Honest list of what Blender has that The Culp Mixer does not:

- **Geometry nodes** and **Python scripting.** The Build box writes JavaScript
  against a sandboxed geometry API instead, and `culpmixer.editor` in the browser
  console reaches the live scene.
- **Drivers and shape keys.** A value cannot yet be wired to another value, and
  there is no per-vertex blend-shape channel.
- **Cloth, fluid, smoke and particles.** Physics here is rigid bodies only.
- **Dynamic topology while sculpting.** Voxel remesh rebuilds the whole mesh at
  an even density; the brushes themselves move the vertices that are there.
- **A node-based shader editor.** Materials are a fixed metallic-roughness set
  with one base colour map.
- **UDIMs and multiple UV maps.** One layout, one 1024² paint map per material.
- **Convex hulls and mesh colliders** for physics. Bodies are boxes or spheres
  fitted to the bounds.

Also true, and worth knowing before you rely on it: the path tracer runs on the
CPU, so a large image at a high sample count is minutes rather than seconds;
one light casts viewport shadows rather than all of them; box-box physics
contacts ignore rotation, so a tumbling crate settles as an upright one;
reference images cannot be pinned in the viewport to model against;
photogrammetry from a video's many frames is not implemented; and meshes above
roughly a million triangles make the viewport uncomfortable.

Every release runs the packaged application on its own platform before it is
published — macOS, Windows and Linux each start the real installed build,
model a sphere, unwrap it, undo, rig it with an IK constraint, keyframe it and
save and reopen the document, and the job fails if any of that does not work.
The desktop builds are **unsigned**, and signing them needs certificates that
cost money rather than code.

## Contributing

The Culp Mixer is proprietary, so a contribution is not simply a pull request: accepting
outside code without a written assignment would leave someone else holding
copyright in a product being sold. Contributions are welcome, and are accepted
only under a signed contributor agreement — ask first at zachculprit@gmail.com.

For the house style and the test expectations, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Selling it

**Send somebody the link. That is the whole of the sale.**

They land on a home page, make an account — username, email, password, no
confirmation email — and get **33 hours**, counting down where they can see it.
When it runs out The Culp Mixer locks and shows them your payment link. They pay, tell
you which address they paid from, and you press **Mark paid** in the founder
console. They are back in on the login they already have.

No payment API, no webhooks, no integration. **One person runs The Culp Mixer**, and the
whole payment system is one button pressed by that person. The setup is four
things, done once: **[SELLING.md](SELLING.md)**.

The founder console at `/founder.html` — one email and one password — shows
every account, whether they are in
trial, waiting to pay, or paid — with **the same countdown the customer sees**,
so a message saying "I have two hours left" can be checked. It can also make
accounts directly, reset a password, and revoke access without deleting
anything.

Paid from a different address than they signed up with? Make them an account on
the address that paid. One account covers a whole team.

**The terms: 33-hour free trial, then $199/month to use The Culp Mixer at all.** Not
$199 to export — $199 to open it. The 33 hours cannot be changed from the
console, on purpose.

Four things the licensing deliberately cannot do, each covered by a test:

- **Lock you out of your own application.** A build made from source is never
  gated at all, and the owner key is perpetual by construction.
- **Brick every copy.** A build shipped without a public key enforces nothing,
  rather than refusing everything; a build that cannot reach the account
  service never puts a sign-up form in the way that nobody could complete.
- **Lock a paying customer out over an outage.** No network, a server that is
  down, a store that is unreachable: all of them leave the last good answer
  standing, and a paid account keeps working offline for a week.
- **Destroy anyone's work.** The lock stops the application; it never touches a
  file. Everything already saved stays on disk, untouched, and what a customer
  made with The Culp Mixer stays theirs for ever.

## Licence

**Proprietary — see [LICENSE](LICENSE). The Culp Mixer is not open source and it is not
free.**

**33-hour free trial. After that it is $199/month to use The Culp Mixer at all.** Not
$199 to export — $199 to open it. When the trial ends you have no right to use
the Software in any way: not to run it, not to keep a copy, not to build it
from source, not to put it inside anything you make or sell. You may not copy,
modify, resell or redistribute it.

Reading this repository is not permission. Cloning it, downloading a build or
being handed a copy gives you the same 33 hours and nothing else.

**What you make with it is yours.** The licence claims no ownership of and no
rights over your models, scenes, renders or animations, and you may use them
commercially without royalty — including after a licence ends.
The Culp Mixer contains no Blender code; the resemblance is in the keymap, which is
deliberate. Third-party components The Culp Mixer depends on keep their own licences,
which are reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and
`licences/`.
