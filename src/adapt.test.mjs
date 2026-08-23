import * as A from "./adapt.js";
import { toLab, deltaE, from255 } from "./engine.js";
import { guardHue, DEFAULTS } from "./correct.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

const PROFILE = { axis: "deutan", severity: 0.9 };

// --- quantiseFrame ----------------------------------------------------------
// Empty input: no samples, no crash, empty palette.
{
  const p = A.quantiseFrame([]);
  ok(Array.isArray(p) && p.length === 0, "quantiseFrame empty input -> empty palette");
}
// A single repeated colour quantises to one bin holding the whole frame.
{
  const samples = Array.from({ length: 100 }, () => [0.5, 0.2, 0.1]);
  const p = A.quantiseFrame(samples);
  ok(p.length === 1, `quantiseFrame uniform frame -> 1 bin (got ${p.length})`);
  ok(Math.abs(p[0].share - 1) < 1e-9, `quantiseFrame uniform frame share ${p[0]?.share}`);
}
// Rare colours (<0.4% share) are dropped; the cap of n is respected.
{
  const samples = [
    ...Array.from({ length: 996 }, () => [0.9, 0.1, 0.1]),
    ...Array.from({ length: 4 }, () => [0.1, 0.9, 0.1]),
  ];
  const p = A.quantiseFrame(samples, 32, 8);
  ok(p.length === 1, `quantiseFrame drops sub-0.4% bins (got ${p.length} bins)`);
}
{
  // More distinct colours than n=32 -> capped, sorted by share descending.
  const samples = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++)
    for (let n = 0; n < 5; n++) samples.push([i / 7, j / 7, k / 7]);
  const p = A.quantiseFrame(samples, 32, 8);
  ok(p.length <= 32, `quantiseFrame respects cap n=32 (got ${p.length})`);
  for (let i = 1; i < p.length; i++) ok(p[i - 1].share >= p[i].share, "quantiseFrame sorted by share desc");
}

// --- palettePairs ------------------------------------------------------------
// A palette with <2 usable colours yields no pairs, and optimiseForPalette
// must fall back to the identity default rather than search an empty space.
{
  const ctx = A.makeContext(PROFILE);
  const { pairs } = A.palettePairs([{ lin: [0.5, 0.5, 0.5], share: 1 }], ctx);
  ok(pairs.length === 0, "palettePairs single colour -> no pairs");
}
{
  const r = A.optimiseForPalette([{ lin: [0.5, 0.5, 0.5], share: 1 }], PROFILE);
  ok(r.pairs === 0, "optimiseForPalette <2 items -> pairs 0");
  ok(r.kL === A.DEFAULT_PARAMS.kL && r.kC === A.DEFAULT_PARAMS.kC &&
     r.kF === A.DEFAULT_PARAMS.kF && r.sat === A.DEFAULT_PARAMS.sat,
     "optimiseForPalette <2 items -> returns DEFAULT_PARAMS");
}
// A true red/green confusion pair (this observer's lost axis) must surface as
// a pair worth optimising for.
{
  const ctx = A.makeContext(PROFILE);
  const palette = [
    { lin: from255([214, 40, 40]), share: 0.5 },   // red
    { lin: from255([40, 150, 40]), share: 0.5 },   // green — confused by deutan
  ];
  const { pairs } = A.palettePairs(palette, ctx);
  ok(pairs.length === 1, `palettePairs finds the red/green confusion pair (got ${pairs.length})`);
}
// Two colours already far apart to this observer (e.g. red vs blue) should
// not register as "lost" — deutan tells red from blue fine.
{
  const ctx = A.makeContext(PROFILE);
  const palette = [
    { lin: from255([214, 40, 40]), share: 0.5 },   // red
    { lin: from255([30, 60, 220]), share: 0.5 },   // blue
  ];
  const { pairs } = A.palettePairs(palette, ctx);
  ok(pairs.length === 0, `palettePairs does not flag an already-distinct pair (got ${pairs.length})`);
}

// --- optimiseForPalette: does it ever actively hurt? ------------------------
// On a real confusion pair, the fitted params must not make the pair harder
// to tell apart than doing nothing (score must be >= 0, matching "do nothing"
// being in-grid at score 0).
{
  const ctx = A.makeContext(PROFILE);
  const palette = [
    { lin: from255([214, 40, 40]), share: 0.5 },
    { lin: from255([40, 150, 40]), share: 0.5 },
  ];
  const r = A.optimiseForPalette(palette, PROFILE);
  ok(r.pairs === 1, "optimiseForPalette finds the one confusion pair");
  ok(r.harm <= 0.5, `optimiseForPalette harm bounded (got ${r.harm})`);
  const seenBefore = deltaE(ctx.seen(palette[0].lin), ctx.seen(palette[1].lin));
  const outA = A.applyParams(palette[0].lin, ctx, r, 0.6);
  const outB = A.applyParams(palette[1].lin, ctx, r, 0.6);
  const seenAfter = deltaE(ctx.seen(outA), ctx.seen(outB));
  ok(seenAfter >= seenBefore - 1e-6, `optimiseForPalette does not shrink separation (${seenBefore.toFixed(2)} -> ${seenAfter.toFixed(2)})`);
}
// The identity point (kL:0,kC:0,kF:0,sat:0) must be reachable and score 0 —
// this is what stops the optimiser from being forced into a harmful move.
// (Regression guard for the original "40->35 counted as harm" bug.)
{
  const ctx = A.makeContext(PROFILE);
  const identity = { kL: 0, kC: 0, kF: 0, sat: 0 };
  const out = A.applyParams([0.4, 0.2, 0.1], ctx, identity, 0.6);
  ok(deltaE(toLab(out), toLab([0.4, 0.2, 0.1])) < 1e-6, "identity params leave the pixel unchanged");
}

// --- applyParams: hue cap and gamut, same guarantees as correct.js ----------
{
  const ctx = A.makeContext(PROFILE);
  const strongest = { kL: 30, kC: 1.6, kF: 1.6, sat: 0.6 };
  for (const rgb of [[242, 132, 25], [214, 40, 40], [60, 150, 60], [140, 60, 180]]) {
    const lin = from255(rgb);
    const out = A.applyParams(lin, ctx, strongest, 1);
    ok(out.every((v) => v >= -1e-9 && v <= 1 + 1e-9), `applyParams stays in gamut for rgb(${rgb})`);
    const lo = toLab(out), lr = toLab(lin);
    const hue = (l) => Math.atan2(l[2], l[1]);
    let dh = Math.abs(hue(lo) - hue(lr)) * 180 / Math.PI;
    if (dh > 180) dh = 360 - dh;
    const chroma = (l) => Math.hypot(l[1], l[2]);
    if (chroma(lr) >= 4 && chroma(lo) >= 4)
      ok(dh <= DEFAULTS.hueCapDeg + 1e-6, `applyParams respects hue cap for rgb(${rgb}) (${dh.toFixed(1)}deg)`);
  }
}
// Black and white must not produce NaN or leave gamut.
{
  const ctx = A.makeContext(PROFILE);
  for (const lin of [[0, 0, 0], [1, 1, 1]]) {
    const out = A.applyParams(lin, ctx, { kL: 3, kC: 0.8, kF: 0.8, sat: 0.3 }, 0.6);
    ok(out.every((v) => Number.isFinite(v)), `applyParams no NaN on ${JSON.stringify(lin)}`);
    ok(out.every((v) => v >= -1e-9 && v <= 1 + 1e-9), `applyParams in gamut on ${JSON.stringify(lin)}`);
  }
}

// --- makeSmoother: converges, doesn't overshoot or discontinuity-jump -------
{
  const sm = A.makeSmoother(300, A.DEFAULT_PARAMS);
  const target = { kL: 30, kC: 1.6, kF: 1.6, sat: 0.6 };
  let t = 0, prev = null, jumped = false;
  for (let i = 0; i < 50; i++) {
    t += 50;
    const cur = sm(target, t);
    if (prev) {
      const step = Math.max(...["kL", "kC", "kF", "sat"].map((k) => Math.abs(cur[k] - prev[k])));
      if (step > 1.0) jumped = true; // a single 50ms tick should never leap most of the way
    }
    prev = cur;
  }
  ok(!jumped, "makeSmoother steps gradually, no discontinuity");
  const diff = Math.max(...["kL", "kC", "kF", "sat"].map((k) => Math.abs(prev[k] - target[k])));
  ok(diff < 0.05, `makeSmoother converges toward target after 2.5s (residual ${diff.toFixed(3)})`);
}
// First call snaps straight to target (no fade-in from a fictitious t=-inf).
{
  const sm = A.makeSmoother(300, A.DEFAULT_PARAMS);
  const target = { kL: 4.5, kC: 1.2, kF: 0.4, sat: 0.3 };
  const first = sm(target, 1000);
  ok(first.kL === target.kL && first.sat === target.sat, "makeSmoother first call snaps to target");
}

// --- tuning knobs -------------------------------------------------------------
{
  const before = A.tuning();
  A.setTuning({ floor: 10, ceil: 40, harmPenalty: 25 });
  const after = A.tuning();
  ok(after.floor === 10 && after.ceil === 40 && after.harmPenalty === 25, "setTuning updates all three knobs");
  A.setTuning(before); // restore
  const restored = A.tuning();
  ok(restored.floor === before.floor && restored.ceil === before.ceil && restored.harmPenalty === before.harmPenalty,
     "setTuning restores prior values");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
