# Correction model — what it is and why

`src/correct.js` — `correctPixel(lin, profile, mode, t)`. Drop-in; swap its
`simulate` for `engine.simulate` (Machado tables + Brettel) before shipping.
The stub here blends Machado severity-1 matrices linearly, which under-
simulates mild severities; the engine does not.

## The shape

    lin → sim → err = lin − sim → relocate err → gamut-map → hue-guard → out

"See true colour" is off the table: three primaries in, a 2-D percept out.
The only move available is to relocate the information the eye discards onto
axes it still has, with as little lying about hue as the mode allows.

## Constraints enforced in code

| limit | source | enforcement |
|---|---|---|
| camera is tristimulus | physics | no spectral terms; err is all we have |
| screen clips per channel → hue rotates | Z: orange→purple | `mapToGamut` scales chroma toward luminance, never clips a channel |
| Machado over-simulates anomalous loss | Basim/Webster JOV 2025; Tregillus 2021 | `compensation` (default 0.3) reduces effective severity; 0 for dichromats |
| hue fidelity | Kotera/Fidaner rankings; Shen 2021 | `guardHue` hard cap in Lab: 16° natural, 30° pulse, 0° achromatic |
| chromatic flicker fuses ~15–25 Hz; 3–30 Hz is the photosensitive band | vision science | pulse clamped ≤1.5 Hz, chroma-only, luminance held exactly constant |
| Lab hue is undefined in the dark toe | colorimetry | achromatic Y bounded to [0.5×, 2×] and ≥0.02 |
| saturated colours can't brighten | gamut | achromatic brightening capped at chromaticity's max Y |

## Modes

| mode | deposits err on | hue | evidence | use |
|---|---|---|---|---|
| natural (default) | residual lost axis + surviving opponent axis, constant Y, chroma boost | ≤16° | hue-constrained search, Shen 2021 | everyday |
| achromatic | luminance only | 0° | Sidorchuk 2025: 90%+ preferred | "no lying" mode; weak for tritan (no headroom on bright yellows) |
| split | Fidaner redistribution, no hue guard | unbounded | highest separation | label it "colours will look wrong" |
| pulse | slow crossfade natural→split on pixels with \|err\|>gate | ≤30° peak | Zhu 2024 rotational shifts | discrimination as motion; prototype on Z |

## Measured (this stub; rerun against the engine)

dichromats, 250 confusion pairs, median separation gain through the eye:
natural ×2.1–2.6, achromatic ×2.6–3.2 (tritan ×1.0), split ×4.4–5.0.
Everyday-colour hue shift, natural: mean 8.5–9.7°, worst 16°. Orange stays orange.

## Calibration hooks

`profile = { axis, severity, compensation }`. Fit `severity` and
`compensation` from an in-app task, not a diagnosis label: Rayleigh match or
D-15 arrangement (retains diagnostic value on an uncalibrated display per the
2024 preprint Hue4U cites). Severity/Rayleigh alone is a poor predictor of
performance (Bosten 2019) — compensation is the second parameter for a reason.

## Shader port

Everything is per-pixel with no neighbourhood or history: `lostAxis` is a
per-profile uniform, `t` is a uniform, Lab round-trip for the hue guard is
~40 flops. Pulse gate uses `|err|` so camera noise in flat regions does not
move.

# Calibration — `src/calibrate.js`

Cambridge Colour Test, Trivector protocol (Mollon & Reffin 1989; Regan,
Reffin & Mollon 1994), child form per Goulart et al. 2008 with a fish in
place of the Landolt C and a tap in place of the gap.

Published parameters kept: background u'v' (0.1977, 0.4689); copunctal
points; dot luminance 8–18 cd/m² in six levels; dot diameters 5.7–13.1
arcmin; staircase from 1100×10⁻⁴ u'v', 1-down/1-up, step halving on
reversal, 11 reversals, threshold = mean of last 7; three vectors interleaved.

Ours, not validated: catch trials (1 in 8, no fish — detects guessing);
40-trial cap per vector (a dichromat pinned at the ceiling never reverses);
luminance reduced rather than channels clipped when a stimulus exceeds the
gamut; threshold → Machado severity via the reduction model.

Gamut reach from the CCT background in sRGB: protan 1099, deutan 642,
tritan 1099. The deutan line is short in sRGB. Recompute `maxLevel` with P3
primaries on device; strong deutans will pin at the ceiling otherwise, which
still classifies correctly but loses severity resolution exactly where Z is.

Simulated observer (Weibull, 4% lapse), 60 runs each: type recovered
98–100%; threshold error ≈ 10–16% (log); ≈ 70–80 trials, ~3 min.

Device: full brightness, True Tone and Night Shift off, store device model.
Thresholds are relative on an uncalibrated screen — fine for type and for
the shader's severity parameter; not clinical numbers.


---

## Integration notes (added on wiring, nothing above changed)

- `correct.js` `simulate` now calls `engine.simulate` (Machado tables +
  Brettel) as instructed. `lostAxis` is memoised — `decompose` was calling a
  64-iteration power method per pixel.
- `render.js` is a GLSL transcription of `correct.js`, reading `lostAxis`,
  `SURVIVING_AXIS` and `DEFAULTS` from it, so the shader cannot drift from the
  model the tests cover. All 18 generated shaders verified to compile on a real
  GL context. Pulse baked at 1.0 Hz, caps at 16°/30°.
- Calibration stimuli run in Display P3 where the browser supports it.
  Measured reach along the deutan line: **sRGB 642 → P3 845**, 32% further.
  Still short of the 1100 ceiling, so a threshold above ~845 saturates and
  reads as "at the ceiling" rather than a precise severity. The axis is
  recovered correctly either way.
- Catch trials could never be passed as first wired: the UI required a tap on
  every trial, so a run of random taps produced a confident, wrong profile.
  Not tapping is now the answer — a 5 s timeout collects it — and a run with
  too many false alarms is discarded rather than saved.
- `rewardPalette(profile, n, minDE)` picks scale colours by farthest-point
  search in the space the observer actually perceives. 12 scales for every
  profile tested; closest pair ΔE 54.8 (normal) down to 24.7 (dichromat),
  against a required 15.
