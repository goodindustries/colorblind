# colorblind

A single-file web app that runs your phone camera through a real-time
colour-vision correction shader, tuned for **deutan** (green-weak /
green-blind) vision. Open it, point the phone, see more colour separation
than your eyes give you unaided.

**Live: https://goodindustries.github.io/colorblind/**

No build step, no dependencies, no network calls, no analytics. Camera
frames never leave the device — everything happens in a WebGL shader on
your own GPU.

## Why a camera can do more than glasses

Colour-blind glasses (EnChroma, Pilestone, etc.) are **subtractive notch
filters**. They cut a band of light where the L and M cone responses overlap,
which widens the gap between the two signals your retina is already
receiving. They cannot add information — they can only throw some away to
make what is left more distinguishable. That is also why they need bright
light, dull everything a little, and do nothing at all for a full dichromat.

A camera is **additive and computational**. The sensor records the full
spectrum-integrated RGB, including the red-green distinctions your cones
cannot resolve. Software can then *move* that information onto an axis you
still see — blue-yellow, lightness, or literal text. That is strictly more
powerful than a filter. A red and a green that land on the same point in
deutan colour space can be pushed apart, which no piece of glass can do.

The cost: it only works inside the frame on the screen, not in the world.

## Modes

Three chips, on purpose:

| Chip | What it does |
|---|---|
| **🌈 Rainbow mode** (default) | Simulates the lost cone response, measures the lost signal, re-injects it as a colour push fitted to what the camera is pointed at right now (`src/adapt.js`), plus a slow chroma pulse on pixels that still carry unresolved confusion after that push — motion is a channel the brain reads independent of colour, so a pair that still reads as one hue can still separate if one member visibly breathes and the other doesn't. Rate ≤1.5Hz, luminance held exactly constant, both well outside the photosensitive band. The most colour this app can get to you — the closest thing here to "full colour" |
| **How they see it** | Renders what the calibrated eye actually receives. Useful for showing other people |
| **Camera** | Untouched sensor feed, for comparison |

The engine also has a Fidaner-redistribution split mode (colours stop being
true, but confusion pairs separate unmistakably) and a zero-hue-error
brightness-only mode; both are tested and reachable in code, just not wired
to a chip — Rainbow mode is where experiments land as they're proven out,
so what it renders is allowed to change without growing the picker past
three.

**Severity** slider selects the deuteranomaly simulation matrix (0 = normal
trichromat, 1.0 = full deuteranope). A "Strong Deutan" test result sits
around 0.85–1.0; it ships defaulted to 0.90.

**Strength** scales how aggressively the correction is applied.

**Compare** (the split-rectangle icon, top left of the three) shows the
selected mode on top and the raw camera below it, live, instead of switching
between them — for holding a screen up next to what everyone else already
sees.

**Double-tap** the screen to step brightness: 1× → 1.5× → 2× → back to 1×.
More light genuinely helps a deutan's signal-to-noise limited cone
discrimination (see [SCIENCE.md](SCIENCE.md)) — the same reason colour-blind
glasses only work outdoors. Does nothing for a photophobic profile
(achromatopsia, blue cone monochromacy), where a brighter screen is a real
harm, not a help.

## Colour naming

The pill under the centre reticle names whatever the reticle is on, sampled
from the **raw sensor pixels** before any shader runs. It is therefore
correct no matter what the filter is doing, and it is the one feature that is
strictly more reliable than any optical aid: "is this wire red or brown" is
answered with a word, not a hue. ~60 named bins including brown, tan, olive,
navy and pink, which are exactly the categories that collapse for a deutan.

## Measured effect

Perceptual separation of confusion pairs *as received by a severity-0.9
deutan retina*, Euclidean distance in linear RGB after simulation:

| Pair | Unaided | Daltonize | Split |
|---|---:|---:|---:|
| red vs green | 0.055 | 0.265 (**×4.9**) | 0.701 (**×12.9**) |
| red vs brown | 0.032 | 0.164 (**×5.2**) | 0.167 (**×5.3**) |
| green vs orange | 0.322 | 0.438 (×1.4) | 0.728 (×2.3) |
| pink vs grey | 0.101 | 0.157 (×1.6) | 0.363 (×3.6) |
| ripe vs unripe fruit | 0.128 | 0.222 (×1.7) | 0.386 (×3.0) |
| saturated LED red vs green | 0.608 | 0.440 (×0.7) | 1.148 (×1.9) |

Note the last row: on already-saturated primaries at the edge of the display
gamut, Daltonize has nowhere to push the error and clipping makes it slightly
*worse* than doing nothing. Split handles that case. This is a real
limitation of error-redistribution daltonization, not a bug — it is why both
modes are here.

## Diagnostics

**https://goodindustries.github.io/colorblind/test.html**

Runs on the device, against the shipped code, and reports what only that
device can tell you:

- what this browser actually supports — wide-gamut canvas and WebGL, and how
  far the calibration game can reach along each confusion line here
- whether the GPU shader produces the same pixels as the tested CPU model
  (the node suites check the maths and the GLSL text; only this checks the
  pixels)
- how the correction behaves on the colour distribution of a real picture:
  load a photo, and it finds the pairs *that photo* contains which this
  observer loses, bands them by how much is lost, and measures what each mode
  does to them

Results land in `window.__DIAG` as JSON so a headless browser can read them,
and there is a Copy button for pasting them back.

## Training the objective

The per-pixel parameters are fitted to each frame at runtime, so what is left
to learn are the objective's constants: how hard to punish losing usable
separation, and where the floor and ceiling of "usable" sit.

```bash
python3 -m http.server 8765          # serve the repo
# from a directory where Playwright is installed:
TRAIN_URL=http://localhost:8765/train.html \
TRAIN_OUT=tools/train-result.json node tools/train.mjs
```

Put photographs in `corpus/` and list them in `corpus/index.json`; the trainer
adds generated scenes with realistic statistics on top. Current constants were
swept over 26 images — see the comment in `src/adapt.js`.

## Running it

Easiest: open **https://goodindustries.github.io/colorblind/** on your phone
and Add to Home Screen. That gives it an app icon and no browser chrome.

To hack on it locally, note that `getUserMedia` requires a secure context —
plain `file://` or `http://` over the network will be refused by the browser.
`localhost` counts as secure:

```bash
git clone https://github.com/goodindustries/colorblind
cd colorblind && python3 -m http.server 8000
# then open http://localhost:8000
```

The whole app is `index.html`. Edit it, reload, done.

## Under the hood

The colour science lives in `src/` and is independent of any UI:

| File | What it is |
|---|---|
| `src/engine.js` | All eight deficiency types, simulation, correction, calibration |
| `src/optimize.mjs` | Derives the correction constants numerically. Re-runnable |
| `src/engine.test.mjs` | 91 assertions across three suites. `npm test` |
| `src/profiles.js` | Per-person profiles, including per-type brightness policy |
| `src/render.js` | WebGL renderer + camera. Carries no visual design |
| `src/naming.js` | Colour naming, read from raw sensor pixels |
| [`SCIENCE.md`](SCIENCE.md) | Why each model was chosen, and what to build next |

`src/app.js` implements the Claude Design "Colorblind Camera" spec.
`src/render.js` is deliberately design-free — no colours, layout, or DOM beyond
the canvas it is handed. The UI drives it through `setProfile` / `setMode` /
`setBoost`, so a visual redesign never touches the colour science.

### Divergences from the design file

All deliberate, all listed at the top of `src/app.js`:

- The design wraps the app in a mock iPhone bezel with a caption. That is
  mockup presentation — the real app is the *contents* of that frame, full-bleed.
- The design corrects with an SVG `feColorMatrix`. That cannot express Brettel's
  two-half-plane projection (it branches per pixel) and cannot reach Display P3,
  so rendering goes through WebGL. Layout, gestures, and visuals are unchanged.
- Added the VISION picker. The design hardcodes deutan; without it the other
  seven types are unreachable.
- STRENGTH is 0..1, not the design's 0..1.6, because the boost parameter is
  defined and verified monotonic on 0..1.
- The design samples the geometric centre while drawing the reticle at 46%
  height, so the name described a different spot than the crosshair. Fixed —
  sampling now follows the reticle's real position through zoom and cover-crop.
- The camera is requested on load, not behind the sheet's button. The design
  gated it because it was a mockup running inside a design canvas, where
  auto-requesting would be wrong; this is a camera app, so it asks on open.
- Dropped the design's painted scene. It was a stand-in so the mockup had
  something to show — the real background is the camera.

## Algorithms

- **Simulation**: Machado, Oliveira & Fernandes (2009), *A Physiologically-based
  Model for Simulation of Color Vision Deficiency*. Severity-parameterised
  matrices on linear RGB, linearly interpolated between the published 0.1 steps.
- **Daltonization**: Fidaner, Lin & Ozguven error-redistribution — the classic
  `[[0,0,0],[0.7,1,0],[0.7,0,1]]` shift matrix applied to the simulation residual.
- **Split**: custom. Takes the signed residual along the lost L-M axis and
  drives it into blue with a compensating red term, then expands saturation
  about luma.

All colour maths happens in **linear** light with proper sRGB transfer
in/out. Doing daltonization on gamma-encoded values — which a lot of sample
code does — gets the error term wrong and desaturates midtones.

## Honest limits

- Only works on what is on the screen. It is a lens you look *through*, not
  a lens you wear.
- Cannot invent cone classes. Two objects that reflect identically will still
  look identical; it separates colours that *differ physically* but collapse
  in your cone space.
- Camera white balance shifts the readings. For critical calls (paint chips,
  resistor bands, wiring) trust the colour name, not the filtered image.
- Not a medical device. It is a visual aid, not a diagnosis or a correction.

## Licence

MIT — see [LICENSE](LICENSE). Built for one strong deutan, shared in case it
is useful to others.
