# The science

What actually helps a colour-blind person see more, what only sounds like it
helps, and what is worth building next. Written against measurements from
`src/engine.test.mjs`, which you can re-run with `node src/engine.test.mjs`.

---

## 1. All eight types, and why one model is not enough

| Type | What breaks | Prevalence | Model used here |
|---|---|---|---|
| Protanomaly | L cone shifted | ~1.3% of males | Machado 2009 |
| **Deuteranomaly** | M cone shifted | **~5% of males** | Machado 2009 |
| Tritanomaly | S cone shifted | ~1 in 500, both sexes | Brettel, severity-scaled |
| Protanopia | No L cone | ~1% of males | Brettel 1997 |
| Deuteranopia | No M cone | ~1.2% of males | Brettel 1997 |
| Tritanopia | No S cone | ~1 in 10,000, both sexes | Brettel 1997 |
| Blue cone monochromacy | Only S cones + rods | ~1 in 100,000 males | Rod/S luminance |
| Achromatopsia | No working cones | ~1 in 30,000 | Scotopic luminance |

Two published models are implemented because neither wins everywhere:

- **Machado, Oliveira & Fernandes (2009)** is the only model with a continuous
  *severity* parameter, which matters because anomalous trichromacy — the
  overwhelming majority of real cases — is a spectrum, not a switch.
- **Brettel, Viénot & Mollon (1997)** projects onto the two half-planes that
  make up a dichromat's gamut. More accurate for full dichromacy.

**Measured, not assumed.** Compared across 216 colours, the two models agree to
mean ΔE **4.19** (protan) and **2.57** (deutan) — strong evidence both are
correctly implemented, since they share no constants. But for tritan they
disagree by **14.24**, because Machado's own paper notes the tritan fit rests on
sparse data. So tritanomaly uses severity-scaled Brettel instead. That decision
came from the measurement, not from preference.

A third model, Viénot's 1999 single-matrix simplification, was tested and
rejected: it produces wildly out-of-gamut values for blue (ΔE > 10,000 before
clamping). That is the documented artifact which motivated Brettel's two-plane
method in the first place.

### The correction constants are derived, not copied

Nearly every daltonization implementation online copies one hardcoded red-green
shift matrix and applies it to everyone. Measured against protan confusion
pairs, that matrix makes some pairs **worse** (red vs brown fell to 0.5×).

`src/optimize.mjs` derives them per type instead:

- **What is lost** is recovered as the dominant singular vector of `(I − Sim)`,
  so it follows from the simulation model rather than being guessed.
- **Where to put it** is searched over a spherical grid against ~400
  machine-generated confusion pairs per type — pairs that are obvious to a
  normal observer (ΔE > 25) but nearly identical after simulation (ΔE < 8) —
  maximising the **worst decile**, so no pair is left behind, under a
  naturalness budget.

Result, across all six correctable types:

| | worst decile | median |
|---|---:|---:|
| Protanomaly | ×6.02 | ×10.76 |
| Deuteranomaly | ×5.61 | ×13.26 |
| Tritanomaly | ×3.41 | ×8.16 |
| Protanopia | ×6.39 | ×11.37 |
| Deuteranopia | ×4.62 | ×11.96 |
| Tritanopia | ×3.41 | ×8.16 |

The boost control is now **monotonic for every type** — more slider always
means more separation. The previous version crossfaded two algorithms that
pushed in different directions, so separation actually *dipped* mid-slider.

**What still fails:** 2–4% of pairs, all near the gamut edge, still lose to
clipping. Two smarter gamut strategies were measured and both lost — scaling
back along the correction ray collapsed worst-decile gain from ~5× to 1.0×, and
tanh soft-clipping matched plain clipping while lifting black. The real fix is
a wider gamut. See §4.

---

## 2. Your three questions

### Does the LiDAR help?

Small correction first: iPhone Pro has **LiDAR**, not radar. (Radar on a phone
was Google's Project Soli in the Pixel 4; discontinued.)

**Directly: no.** LiDAR measures time-of-flight distance. It carries zero
spectral information. It cannot tell red from green because it does not sense
colour at all.

**Indirectly: yes, and more than you'd guess** — for one reason above all.
The largest source of error in colour naming is not the algorithm, it is
**shading**. A red ball in shadow currently reads "dark brown," and that is a
wrong answer given confidently. Depth plus surface normals let you estimate the
shading and divide it out, recovering the object's true colour rather than the
colour of the light that happened to hit it.

Second: **per-object segmentation**. Knowing where the mug ends and the table
begins lets you recolour whole objects consistently, instead of per-pixel
shimmer. Much calmer to look at, which matters a lot for a child.

**Verdict: worth doing, but not first.** On-device ML segmentation gets most of
the benefit without LiDAR and works on every phone, not just Pro models.

### Does changing frame rate help?

Two different questions hide in this one.

**(a) Higher camera FPS — helps accuracy, not perception.** It does nothing for
your eyes. But averaging colour across several frames cuts sensor noise, which
is the main cause of the colour name flickering between "red" and "brown" while
you hold still. Cheap, and a real improvement.

**(b) Temporal modulation — this is the genuinely interesting idea, and it is
underexploited.**

Here is the key fact: in *all* red-green colour blindness, the **luminance
pathway is completely intact**. Flicker sensitivity is normal. So you can encode
the missing colour information as *flicker* and deliver it through a channel
that works perfectly — red regions pulse at one rate, green at another. A deutan
who genuinely cannot see the colour difference can absolutely see the flicker
difference. You are not fixing the cones; you are routing around them.

This is the most promising unexplored direction in the whole space, and almost
nothing consumer-facing uses it.

**Two serious caveats.**

1. **Photosensitive epilepsy.** WCAG 2.3.1 sets the general flash threshold at
   no more than 3 flashes per second for large, high-contrast areas. Any flicker
   feature must be small-area, low-contrast, opt-in, off by default, and carry a
   warning. In an app aimed at children this is not a footnote.
2. **The safer sibling is spatial, not temporal.** Encode hue as *texture* —
   diagonal hatching for red, dots for green — instead of flicker. Same core
   idea, delivered through an intact channel, with none of the seizure risk.
   Cartographers have done exactly this for a century. **This should be the
   first version**, with flicker as a later opt-in.

ProMotion 120 Hz does help here: it lets modulation read as a gentle shimmer
rather than a strobe, which is both more comfortable and safer.

### Does max brightness help?

**Yes — and it is better grounded than most things in this space.**

Anomalous trichromats are **signal-to-noise limited**. The L and M cone signals
they compare are nearly identical, so the difference between them is tiny
relative to photoreceptor noise. More photons means a cleaner comparison. This
is exactly why EnChroma-style glasses need bright sunlight and do essentially
nothing indoors — they throw light away, so they need plenty to start with.

**But brightness is not the biggest lever — gamut is.** The correction needs
somewhere to *put* the redistributed signal, and I measured the cost of not
having room: 2–4% of confusion pairs still regress purely because the push runs
out of sRGB. Brightness does not fix that. **Display P3 does** — see §4.

**One important exception, and it is why profiles exist.** For **achromatopsia**
and **blue cone monochromacy**, photophobia is a *defining symptom*. Bright
screens cause genuine pain. Those profiles must *dim*, not brighten. Brightness
policy is therefore a clinical property of the deficiency, not a global setting
— `displayPolicy()` in `src/profiles.js` returns `reduce` for those two types
and `max` for everything else.

---

## 3. What cannot be fixed

Worth being straight about, because it bounds everything above.

- **Metamers.** Two objects with different spectra that produce identical camera
  RGB are identical, permanently. No algorithm recovers information the sensor
  never captured. This is a limit of the camera, not the code.
- **No new cone classes.** The app relocates information you already receive
  onto an axis you can read. It cannot manufacture a channel that isn't there.
- **Monochromacy is not a recolouring problem.** For achromatopsia there is no
  colour axis to move information onto. The tests skip the correction entirely
  for those types rather than pretending. What helps instead: text naming,
  texture encoding, brightness reduction, and glare control.
- **It only works on the screen.** It is a lens you look *through*, not one you
  wear.

---

## 4. What to build next, ranked

1. **Display P3 pipeline.** Highest value per unit effort in the whole list.
   iPhone displays are P3 — roughly 25% more volume than sRGB, and most of the
   extra sits in reds and greens, precisely where red-green correction runs out
   of room. Directly attacks the measured 2–4% regression tail. A few lines:
   `canvas.getContext('2d', {colorSpace:'display-p3'})` and
   `gl.drawingBufferColorSpace = 'display-p3'`.
2. **Personal calibration.** A label like "strong deutan" is a bucket; a
   Rayleigh match is a measurement. The user slides a red/green mixture until it
   matches a fixed yellow, and where they settle fits severity directly — that
   ratio is exactly what the anomaloscope is diagnostic of. Already implemented
   (`severityFromRayleigh`), needs ~60 seconds of UI. Also detects protan vs
   deutan without a diagnosis.
3. **Colour naming, spoken.** Already the single most reliable feature, because
   it is read from raw sensor pixels and is therefore immune to whatever the
   filter is doing. "Is this wire red or brown" answered with a word beats any
   hue shift. Adding speech makes it work for a child who cannot read yet.
4. **Texture encoding of the confusion axis** (then flicker, opt-in). §2b.
5. **Per-object segmentation** via on-device ML, LiDAR-assisted where available.
   Kills per-pixel shimmer and enables shadow removal. §2a.
6. **Optimisation-based recolouring** — Kuhn, Oliveira & Fernandes (2008) use a
   mass-spring system in CIELAB to preserve naturalness while maximising
   separation. Strictly better tradeoff than any fixed matrix, at real compute
   cost. The upgrade path once the fixed-matrix approach is exhausted.
7. **Multi-frame temporal denoising** for naming stability. §2a.
8. **Achromatopsia mode**: dimming, warm tint, glare control, texture-coded hue.

---

## 5. Can a screen give a colour-blind person the *real* colours?

Short answer: **no, and it is worth knowing exactly why**, because it sets the
ceiling on everything else here.

The goal is precise and testable: what the deficient eye receives from the
corrected image should equal what a normal eye receives from the original —
`simulate(C(x)) = x`. If the simulation matrix `S` is invertible, then
`C = S⁻¹` solves it **exactly**. And `S` *is* invertible for anomalous
trichromacy — determinant 0.10 at severity 0.8, 0.047 at 0.9, reaching zero
only at full dichromacy.

So the maths works. The screen does not.

At severity 0.9 the inverse has entries reaching **14×** and **−17×**. Every
everyday colour it produces lands far outside the display gamut, and once
clipped, the result is *worse* than doing nothing: perceived error rises from
ΔE 30.4 to 41.9.

Optimising directly for perceived fidelity — with clamping inside the objective,
so the search cannot cheat by leaving the gamut — gives the real ceiling:

| Severity | Perceived error, uncorrected | Best a screen can do | Improvement |
|---:|---:|---:|---:|
| 0.40 | 19.4 | 15.3 | **−21%** |
| 0.60 | 25.1 | 22.7 | −10% |
| 0.75 | 28.5 | 27.4 | −4% |
| 0.90 | 31.3 | 30.6 | −2% |
| 1.00 | 33.0 | 31.7 | −4% |

Mild deficiency can be meaningfully corrected. **Strong deficiency cannot.**
This is a gamut limit, not an algorithm limit — no cleverness recovers it, and
it is the same reason colour-blind glasses do not deliver "real colours" either.

### So what should the correction actually do?

Two honest goals remain, and they need different settings — which is why there
are two correction modes rather than one:

- **Keep colours recognisable while separating the confusable ones.** An orange
  must still look orange. This is the default.
- **Maximise separation, accepting false colours.** For "are these two things
  the same colour or not", where being able to tell beats being accurate.

The first version of this app shipped only the second, as the default, with no
hue term in the optimiser at all — it maximised CIELAB separation, and ΔE
happily permits enormous hue rotation. The result turned orange into pink-purple
(67° hue shift). A child using it would have been taught the wrong name for a
colour. Hue is now a constrained, tested property: **3° mean shift** for the
default mode against 35° for the boost mode.

And for the cases where none of this is enough, the colour name under the
reticle is read from the raw sensor and is simply correct.

## 6. Where the field is going

**Gene therapy is the actual cure trajectory.** Mancuso et al. (*Nature*, 2009,
Neitz lab) restored full trichromacy to adult squirrel monkeys — born
dichromatic — by delivering a human L-opsin gene to the retina. Human trials are
underway for achromatopsia (CNGA3/CNGB3 mutations).

The result matters here for a reason beyond the cure: those were **adult**
brains, long past any critical period, and they learned to use a brand-new
colour channel. That is the strongest existing evidence that a trained
artificial channel — flicker coding, texture coding — could become genuinely
perceptual with practice rather than staying a chore to decode. If that holds,
§2b's ceiling is far higher than it first appears.

**Worth knowing about the glasses**, since that is where this started: clinical
evidence for EnChroma-style lenses is mixed. Several controlled studies found no
improvement on standard tests (Ishihara, D-15) even though users report real
subjective benefit. They cannot add information — only subtract light to widen a
gap. A camera can genuinely move information onto a channel that works, which is
a categorically stronger operation.

---

## References

- Machado, Oliveira & Fernandes (2009), *A Physiologically-based Model for
  Simulation of Color Vision Deficiency*, IEEE TVCG 15(6).
- Brettel, Viénot & Mollon (1997), *Computerized simulation of color appearance
  for dichromats*, JOSA A 14(10).
- Viénot, Brettel & Mollon (1999), *Digital video colourmaps for checking the
  legibility of displays by dichromats*, Color Research & Application 24(4).
- Kuhn, Oliveira & Fernandes (2008), *An Efficient Naturalness-Preserving
  Image-Recoloring Method for Dichromats*, IEEE TVCG 14(6).
- Mancuso et al. (2009), *Gene therapy for red–green colour blindness in adult
  primates*, Nature 461.
- W3C WCAG 2.1, Success Criterion 2.3.1, Three Flashes or Below Threshold.
