/**
 * Per-frame optimiser.
 *
 * Two fixed global corrections have now failed the same way: tuned to help one
 * kind of colour pair, they damage another. That is not a tuning problem. A
 * deutan's perceptual space is two-dimensional; a fixed map from three
 * dimensions into two must sacrifice something, and which pairs get sacrificed
 * is decided in advance by constants that cannot know what the camera is
 * pointed at.
 *
 * So the correction is fitted to the frame instead. Quantise what is actually
 * on screen to ~32 colours, find the pairs THIS frame contains that this
 * observer loses, and search for the correction that best separates those —
 * under the same hue cap, with the same severity taper. Re-fit a couple of
 * times a second and smooth between fits so nothing lurches.
 *
 * Pure and synchronous. render.js takes the result as uniforms; app.js decides
 * when to call it.
 */

import { simulate, toLab, deltaE } from "./engine.js";
import { lostAxis, SURVIVING_AXIS, effectiveSeverity, mapToGamut, guardHue,
         DEFAULTS } from "./correct.js";

const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const withLuma = (c, Y) => { const y0 = luma(c); return y0 < 1e-6 ? [Y, Y, Y] : c.map((v) => v * Y / y0); };

/**
 * What a separation is WORTH, rather than what it measures.
 *
 * Below the floor two colours cannot be told apart at all, so 3 -> 2 is not a
 * regression and 3 -> 4 is not a win. Above the ceiling they are already
 * comfortably distinct, so 40 -> 35 costs nothing real. Only movement between
 * the two changes anything for the person using it.
 *
 * Scoring raw distance instead is what made the first optimiser refuse to act:
 * it counted 40 -> 35 as harm, so doing nothing outscored every correction.
 */
// Learned from a corpus rather than chosen — see tools/train.mjs. Mutable so
// the trainer can sweep them; the app never changes them at runtime.
// Swept over 15 real photographs + 24 generated scenes (tools/train.mjs) —
// the first sweep behind this file used generated scenes only, and the
// corpus README already warned real photos disagree with them. Harm falls
// steeply with the penalty and then plateaus around 13% at penalty 20, while
// gain starts to slide — so the knee is still here, just at a higher harm
// floor than the synthetic-only sweep found:
//   natural    x1.14 gain, 40% of pairs made worse
//   achromatic x1.01 gain, 43% made worse
//   split      x1.49 gain, 26% made worse
//   adaptive   x1.39 gain, 13% made worse (11% of frame)
let FLOOR = 5;      // below this, two colours cannot be told apart at all
let CEIL = 35;      // above this, more separation buys nothing
let HARM = 20;      // losing usable separation vs gaining it

export const tuning = () => ({ floor: FLOOR, ceil: CEIL, harmPenalty: HARM });
export function setTuning(t = {}) {
  if (t.floor != null) FLOOR = t.floor;
  if (t.ceil != null) CEIL = t.ceil;
  if (t.harmPenalty != null) HARM = t.harmPenalty;
}
export const CONFUSION_FLOOR = 5;
const worth = (d) => Math.max(0, Math.min(1, (d - FLOOR) / Math.max(1e-6, CEIL - FLOOR)));

export const DEFAULT_PARAMS = { kL: 0, kC: 0.8, kF: 0.6, sat: 0.2 };

// Fidaner error redistribution, per axis. The split mode is this alone, and it
// beat every parameterisation that excluded it — so it belongs in the search
// space rather than in a separate mode the optimiser cannot reach.
const SHIFT = {
  "protan": [0,0,0, 0.7,1,0, 0.7,0,1],
  "deutan": [0,0,0, 0.7,1,0, 0.7,0,1],
  "tritan": [1,0,0.7, 0,1,0.7, 0,0,0],
};
const mul3 = (M, v) => [
  M[0]*v[0]+M[1]*v[1]+M[2]*v[2],
  M[3]*v[0]+M[4]*v[1]+M[5]*v[2],
  M[6]*v[0]+M[7]*v[1]+M[8]*v[2]];

/** Quantise linear-RGB pixel samples to at most `n` weighted colours. */
export function quantiseFrame(samples, n = 32, bins = 8) {
  const map = new Map();
  for (const lin of samples) {
    const q = lin.map((v) => Math.min(bins - 1, Math.max(0, Math.floor(v * bins))));
    const key = (q[0] * bins + q[1]) * bins + q[2];
    const e = map.get(key) || { n: 0, s: [0, 0, 0] };
    e.n++; e.s[0] += lin[0]; e.s[1] += lin[1]; e.s[2] += lin[2];
    map.set(key, e);
  }
  const total = samples.length || 1;
  return [...map.values()]
    .map((e) => ({ lin: e.s.map((v) => v / e.n), share: e.n / total }))
    .filter((c) => c.share > 0.004)
    .sort((a, b) => b.share - a.share)
    .slice(0, n);
}

/** The correction, as a function of the searched parameters. */
export function applyParams(lin, ctx, p, strength) {
  const { d, err } = ctx.decompose(lin);
  const f = mul3(ctx.shift, err);
  const Y = luma(lin);
  let o = lin.map((v, i) =>
    v + ctx.surv[i] * d * (p.kC ?? 0) * strength + f[i] * (p.kF ?? 0) * strength);
  const Y2 = Math.max(0.02, Math.min(1, Y * Math.pow(2, p.kL * d * strength)));
  o = withLuma(o, Y2);
  o = o.map((v) => Y2 + (v - Y2) * (1 + p.sat * strength));
  // Same hue cap as every other mode. The optimiser searches underneath it,
  // so it can never buy separation by lying about hue.
  return guardHue(mapToGamut(o), lin, DEFAULTS.hueCapDeg);
}

export function makeContext(profile) {
  const axis = profile.axis;
  const full = { axis, severity: 1 };
  const lost = lostAxis(full);
  const surv = SURVIVING_AXIS[axis] || [0, 0, 0];
  // The severity taper, unchanged: a milder eye loses less, so it is corrected
  // less, with a floor so mild cases still get a usable push.
  const k = 0.35 + 0.65 * effectiveSeverity(profile);
  return {
    axis, surv, shift: SHIFT[axis] || SHIFT.deutan,
    decompose(lin) {
      const sim = simulate(lin, { type: DICHROMAT[axis], severity: 1 });
      const err = [(lin[0] - sim[0]) * k, (lin[1] - sim[1]) * k, (lin[2] - sim[2]) * k];
      return { err, d: err[0] * lost[0] + err[1] * lost[1] + err[2] * lost[2] };
    },
    dOf(lin) { return this.decompose(lin).d; },
    seen: (lin) => toLab(simulate(lin, ENGINE_PROFILE(profile))),
  };
}
const DICHROMAT = { protan: "protanopia", deutan: "deuteranopia", tritan: "tritanopia" };
const ANOMALOUS = { protan: "protanomaly", deutan: "deuteranomaly", tritan: "tritanomaly" };
const ENGINE_PROFILE = (p) => {
  const s = effectiveSeverity(p);
  return { type: s >= 0.999 ? DICHROMAT[p.axis] : ANOMALOUS[p.axis], severity: s };
};

/** Pairs in this palette that this observer loses, with a weight. */
export function palettePairs(palette, ctx) {
  const items = palette.map((c) => ({ ...c, lab: toLab(c.lin), seen: ctx.seen(c.lin) }));
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const trueD = deltaE(items[i].lab, items[j].lab);
    if (trueD <= 20) continue;
    const seenD = deltaE(items[i].seen, items[j].seen);
    const lost = 1 - seenD / trueD;
    if (lost <= 0.25) continue;
    pairs.push({ i, j, seenD, weight: items[i].share * items[j].share * lost });
  }
  pairs.sort((a, b) => b.weight - a.weight);
  return { items, pairs: pairs.slice(0, 400) };
}

const GRID = [];
for (const kL of [0, 1.5, 3, 4.5, 6])
  for (const kC of [0, 0.4, 0.8, 1.2, 1.6])
    for (const kF of [0, 0.4, 0.8, 1.2, 1.6])
      for (const sat of [0, 0.3, 0.6]) GRID.push({ kL, kC, kF, sat });

function scoreParams(p, ctx, items, pairs, strength) {
  // Correct the PALETTE once per candidate, not every pair — 32 corrections
  // instead of hundreds, which is what makes this affordable per frame.
  const seenAfter = items.map((it) => ctx.seen(applyParams(it.lin, ctx, p, strength)));
  let wsum = 0, gained = 0, lost = 0, logGain = 0, broke = 0;
  for (const q of pairs) {
    const after = deltaE(seenAfter[q.i], seenAfter[q.j]);
    const dw = worth(after) - worth(q.seenD);
    if (dw >= 0) gained += q.weight * dw; else lost += q.weight * -dw;
    if (dw < -0.02) broke += q.weight;
    logGain += q.weight * Math.log(Math.max(after / Math.max(q.seenD, FLOOR), 1e-3));
    wsum += q.weight;
  }
  if (!wsum) return { score: 0, gain: 1, harm: 0 };
  // Losing usable separation is worse than gaining it is good, but not
  // infinitely so — otherwise the optimiser simply refuses to act.
  return {
    score: (gained - HARM * lost) / wsum,
    gain: Math.exp(logGain / wsum),
    harm: broke / wsum,
  };
}

/**
 * Fit the correction to one frame's palette.
 * @returns {{kL:number,kC:number,sat:number,gain:number,harm:number,pairs:number}}
 */
export function optimiseForPalette(palette, profile, opts = {}) {
  const strength = opts.strength ?? 0.6;
  const ctx = makeContext(profile);
  const { items, pairs } = palettePairs(palette, ctx);
  if (pairs.length < 2) return { ...DEFAULT_PARAMS, gain: 1, harm: 0, pairs: pairs.length };

  let best = null;
  for (const p of GRID) {
    const s = scoreParams(p, ctx, items, pairs, strength);
    if (!best || s.score > best.score) best = { ...p, ...s };
  }
  // Local refine around the winner.
  for (const dL of [-0.75, 0, 0.75]) for (const dC of [-0.2, 0, 0.2])
    for (const dF of [-0.2, 0, 0.2]) for (const dS of [-0.15, 0, 0.15]) {
      const p = {
        kL: Math.max(0, Math.min(6, best.kL + dL)),
        kC: Math.max(0, Math.min(1.6, best.kC + dC)),
        kF: Math.max(0, Math.min(1.6, best.kF + dF)),
        sat: Math.max(0, Math.min(0.6, best.sat + dS)),
      };
      const s = scoreParams(p, ctx, items, pairs, strength);
      if (s.score > best.score) best = { ...p, ...s };
    }
  return { kL: best.kL, kC: best.kC, kF: best.kF, sat: best.sat,
           gain: best.gain, harm: best.harm, pairs: pairs.length };
}

/**
 * Exponential smoothing so the picture eases between fits instead of stepping.
 * `tau` is the time constant in ms; ~300 reaches most of the way in a third of
 * a second, which is slow enough not to shimmer and fast enough to follow a pan.
 */
export function makeSmoother(tau = 300, initial = DEFAULT_PARAMS) {
  let cur = { ...initial }, last = null;
  return (target, nowMs) => {
    if (last == null) { last = nowMs; cur = { ...target }; return { ...cur }; }
    const a = 1 - Math.exp(-(nowMs - last) / tau);
    last = nowMs;
    for (const k of ["kL", "kC", "kF", "sat"]) cur[k] += (target[k] - cur[k]) * a;
    return { ...cur };
  };
}
