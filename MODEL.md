# Correction model

> Integrated into `src/engine.js` and `src/render.js`. Kept as the design
> rationale; the measured numbers below are from the original standalone stub,
> and SCIENCE.md carries the post-integration figures.

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
