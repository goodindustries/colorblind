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

| Mode | What it does |
|---|---|
| **Off** | Untouched camera feed, for comparison |
| **Daltonize** | Simulates deutan cone response, measures the lost red-green signal, re-injects it on the blue-yellow axis. Colours stay broadly natural |
| **Split** | Drives that same lost axis hard. Colours stop being true, but confusion pairs separate unmistakably — reds go warm/bright, greens go cool/blue |
| **Simulate** | Renders what a deutan retina actually receives. Useful for showing other people what you see |

**Severity** slider selects the deuteranomaly simulation matrix (0 = normal
trichromat, 1.0 = full deuteranope). A "Strong Deutan" test result sits
around 0.85–1.0; it ships defaulted to 0.90.

**Strength** scales how aggressively the correction is applied.

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
| `src/engine.test.mjs` | 54 assertions. `node src/engine.test.mjs` |
| `src/profiles.js` | Per-person profiles, including per-type brightness policy |
| [`SCIENCE.md`](SCIENCE.md) | Why each model was chosen, and what to build next |

Note: `index.html` still runs its own older deuteranomaly-only shader. Wiring it
to `src/engine.js` is pending a UI redesign.

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
