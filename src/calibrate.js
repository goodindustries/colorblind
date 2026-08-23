// calibrate.js — Cambridge Colour Test, Trivector protocol, on a phone.
//
// Stimulus and procedure follow Regan, Reffin & Mollon (1994) / Mollon &
// Reffin (1989): a field of dots of randomised size and luminance, target
// region displaced from the background chromaticity along one of the three
// dichromatic confusion lines, staircase on displacement, interleaved across
// the three lines. Threshold per line in CIE 1976 u'v' units (x1e-4).
// The child-friendly substitution (Goulart et al. 2008) replaces the Landolt
// C with a shape; here the shape is a fish and the response is a tap.
//
// This module is pure: it generates trial descriptors and consumes responses.
// Rendering (canvas/WebGL) and hit-testing live in the app.
//
// Numbers marked CCT are the published parameters. Anything marked OURS is a
// mapping into this app's model and is not clinically validated.

export const VECTORS = ["protan", "deutan", "tritan"];

// CCT background chromaticity and copunctal points (CIE 1976 u'v').
export const BACKGROUND = { u: 0.1977, v: 0.4689 };
export const COPUNCTAL = {
  protan: { u: 0.6780, v: 0.5010 },
  deutan: { u: -1.2170, v: 0.7820 },
  tritan: { u: 0.2570, v: 0.0000 },
};

// CCT dot luminance: six levels, 8-18 cd/m^2. Scaled to display white later.
export const DOT_LUMINANCE_LEVELS = [8, 10, 12, 14, 16, 18];
// CCT dot diameters: 5.7 to 13.1 arcmin. At ~30 cm on a phone that is ~0.5-1.1 mm;
// given as relative sizes, app scales to its own px/arcmin.
export const DOT_SIZES_ARCMIN = [5.7, 7.5, 9.3, 11.2, 13.1];

// Staircase (CCT Trivector): start 1100 x1e-4 u'v', 1-down/1-up, step halves
// at each reversal down to a floor, terminate at 11 reversals, threshold =
// mean of the last 7 reversals. Floor/ceiling are instrument limits.
export const STAIRCASE = {
  start: 1100, ceiling: 1100, floor: 20,
  initialStep: 400, minStep: 20, reversals: 11, average: 7,
  maxTrials: 40,   // instrument cap: observer pinned at ceiling/floor never reverses
};

// --- chromaticity helpers -------------------------------------------------
export function uvToXYZ(u, v, Y = 1) {
  const X = Y * 9 * u / (4 * v), Z = Y * (12 - 3 * u - 20 * v) / (4 * v);
  return [X, Y, Z];
}
export function xyzToLinearSRGB([X, Y, Z]) {
  return [ 3.2406*X - 1.5372*Y - 0.4986*Z, -0.9689*X + 1.8758*Y + 0.0415*Z, 0.0557*X - 0.2040*Y + 1.0570*Z ];
}
export function xyzToLinearP3([X, Y, Z]) {
  return [ 2.4934969*X - 0.9313836*Y - 0.4027108*Z,
          -0.8294890*X + 1.7626641*Y + 0.0236247*Z,
           0.0358458*X - 0.0761724*Y + 0.9568845*Z ];
}

// MODEL.md: "the deutan line is short in sRGB... strong deutans will pin at
// the ceiling otherwise, which still classifies correctly but loses severity
// resolution exactly where Z is." So the stimulus gamut is switchable, and the
// app runs it in Display P3 where the browser reports P3 support.
let TO_LINEAR = xyzToLinearSRGB;
let _gamut = "srgb";
export function setGamut(name) {
  if (name !== "srgb" && name !== "display-p3") throw new Error(`unknown gamut ${name}`);
  TO_LINEAR = name === "display-p3" ? xyzToLinearP3 : xyzToLinearSRGB;
  _gamut = name;
  _maxLevelCache.clear();
  return maxLevels();
}
export const gamut = () => _gamut;
export const maxLevels = () => Object.fromEntries(VECTORS.map((v) => [v, maxLevel(v)]));

// Point at distance `dist` (x1e-4 u'v') from BACKGROUND along the confusion
// line toward the copunctal point. Tritan line runs downward in v'.
export function displaced(vector, dist) {
  const c = COPUNCTAL[vector];
  const du = c.u - BACKGROUND.u, dv = c.v - BACKGROUND.v;
  const n = Math.hypot(du, dv);
  return { u: BACKGROUND.u + du / n * dist * 1e-4, v: BACKGROUND.v + dv / n * dist * 1e-4 };
}

// --- staircase ------------------------------------------------------------
export class Staircase {
  constructor(vector, params = STAIRCASE) {
    this.vector = vector;
    const cap = Math.min(params.ceiling, maxLevel(vector));
    this.p = { ...params, ceiling: cap, start: Math.min(params.start, cap) };
    this.level = params.start; this.step = params.initialStep;
    this.lastDir = 0; this.reversalLevels = []; this.history = [];
  }
  get done() { return this.reversalLevels.length >= this.p.reversals || this.history.length >= this.p.maxTrials; }
  respond(hit) {
    this.history.push({ level: this.level, hit });
    const dir = hit ? -1 : +1;
    if (this.lastDir !== 0 && dir !== this.lastDir) {
      this.reversalLevels.push(this.level);
      this.step = Math.max(this.p.minStep, this.step / 2);
    }
    this.lastDir = dir;
    this.level = Math.min(this.p.ceiling, Math.max(this.p.floor, this.level + dir * this.step));
  }
  threshold() {
    const r = this.reversalLevels.slice(-this.p.average);
    if (!r.length) {
      if (!this.history.length) return null;
      // pinned: all-miss at ceiling or all-hit at floor
      return this.history.every(h => !h.hit) ? this.p.ceiling : this.p.floor;
    }
    return r.reduce((a, b) => a + b, 0) / r.length;
  }
}

// Gamut: scale luminance down until the chromaticity fits; never clip a
// channel (that changes chromaticity and therefore the test). Returns the
// colour and records the scale so the app can verify the stimulus was valid.
export function inGamut(ch, Y) {
  let lin = TO_LINEAR(uvToXYZ(ch.u, ch.v, Y));
  const neg = Math.min(...lin);
  if (neg < 0) throw new Error(`chromaticity (${ch.u.toFixed(3)},${ch.v.toFixed(3)}) outside display gamut`);
  const mx = Math.max(...lin);
  return mx > 1 ? lin.map(v => v / mx) : lin;
}
// Largest displacement along a vector that stays inside the gamut triangle.
const _maxLevelCache = new Map();
export function maxLevel(vector) {
  const hit = _maxLevelCache.get(vector);
  if (hit !== undefined) return hit;
  const v = computeMaxLevel(vector);
  _maxLevelCache.set(vector, v);
  return v;
}
function computeMaxLevel(vector) {
  let lo = 0, hi = STAIRCASE.ceiling;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    try { inGamut(displaced(vector, mid), 1); lo = mid; } catch { hi = mid; }
  }
  return Math.floor(lo);
}

// --- trial descriptor -----------------------------------------------------
let seedState = 1;
export function seed(s) { seedState = s >>> 0 || 1; }
function rnd() { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; }
const pick = arr => arr[Math.floor(rnd() * arr.length)];

// Fish mask on a unit square: body ellipse + tail triangle. `flip` mirrors.
export function fishMask(x, y, flip) {
  if (flip) x = 1 - x;
  const bx = (x - 0.42) / 0.30, by = (y - 0.5) / 0.20;
  if (bx * bx + by * by <= 1) return true;
  const tx = x - 0.68, ty = Math.abs(y - 0.5);
  return tx >= 0 && tx <= 0.22 && ty <= tx * 0.9;
}

export function makeTrial(vector, level, opts = {}) {
  const cols = opts.cols ?? 24, rows = opts.rows ?? 24;
  const fishScale = opts.fishScale ?? 0.45;
  const fx = 0.1 + rnd() * (0.8 - fishScale), fy = 0.1 + rnd() * (0.8 - fishScale);
  const flip = rnd() < 0.5;
  level = Math.min(level, maxLevel(vector));
  const target = displaced(vector, level);
  const dots = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.3 + rnd() * 0.4) / cols, y = (r + 0.3 + rnd() * 0.4) / rows;
    const inFish = x >= fx && x < fx + fishScale && y >= fy && y < fy + fishScale
      && fishMask((x - fx) / fishScale, (y - fy) / fishScale, flip);
    const Y = pick(DOT_LUMINANCE_LEVELS) / 18;      // 0.44..1 relative
    const ch = inFish ? target : BACKGROUND;
    dots.push({ x, y, size: pick(DOT_SIZES_ARCMIN), lin: inGamut(ch, Y), inFish });
  }
  return { vector, level, fish: { x: fx, y: fy, w: fishScale, h: fishScale, flip }, dots };
}

// Hit test for a tap in unit coordinates.
export function tapHits(trial, x, y) {
  const f = trial.fish;
  if (x < f.x || x >= f.x + f.w || y < f.y || y >= f.y + f.h) return false;
  return fishMask((x - f.x) / f.w, (y - f.y) / f.h, f.flip);
}

// --- session: three interleaved staircases --------------------------------
export class Session {
  constructor(opts = {}) {
    this.stairs = Object.fromEntries(VECTORS.map(v => [v, new Staircase(v, opts.staircase)]));
    this.catchEvery = opts.catchEvery ?? 8;   // OURS: guess detection, not in CCT
    this.trials = []; this.catchFails = 0; this.n = 0;
  }
  get done() { return VECTORS.every(v => this.stairs[v].done); }
  next() {
    if (this.done) return null;
    this.n++;
    if (this.n % this.catchEvery === 0) {
      const t = makeTrial(pick(VECTORS), 0); t.catch = true;
      this.current = t; return t;
    }
    const open = VECTORS.filter(v => !this.stairs[v].done);
    const v = pick(open);
    this.current = makeTrial(v, this.stairs[v].level);
    return this.current;
  }
  // tap: {x,y} in unit coords, or null for timeout
  respond(tap) {
    const t = this.current;
    const hit = !!tap && tapHits(t, tap.x, tap.y);
    this.trials.push({ vector: t.vector, level: t.level, catch: !!t.catch, hit });
    if (t.catch) { if (tap) this.catchFails++; return; }
    this.stairs[t.vector].respond(hit);
  }
  result() {
    const thresholds = Object.fromEntries(VECTORS.map(v => [v, this.stairs[v].threshold()]));
    const ceilings = Object.fromEntries(VECTORS.map(v => [v, this.stairs[v].p.ceiling]));
    return { thresholds, ceilings, catchFails: this.catchFails, trials: this.trials.length, ...classify(thresholds) };
  }
}

// --- classification (CCT normative, adults; OURS for cutoffs) -------------
// Normal thresholds ~ <100 x1e-4 on all three vectors. A red-green deficient
// observer elevates protan and deutan; the higher of the two names the type.
export const NORMAL_LIMIT = 100;
export function classify(th) {
  const { protan: p, deutan: d, tritan: t } = th;
  if ([p, d, t].some(x => x == null)) return { axis: null, severity: null };
  if (t > NORMAL_LIMIT && t > Math.max(p, d) * 1.2) return { axis: "tritan", severity: severityFromThreshold("tritan", t) };
  if (Math.max(p, d) <= NORMAL_LIMIT) return { axis: null, severity: 0 };
  const axis = p > d ? "protan" : "deutan";
  return { axis, severity: severityFromThreshold(axis, th[axis]) };
}

// OURS: map a threshold to Machado severity via the reduction model — an
// observer of severity s keeps a fraction k(s) of the contrast along the
// confusion line, so threshold ~ NORMAL / k(s). Dichromats hit the ceiling.
export function severityFromThreshold(axis, threshold) {
  if (threshold >= Math.min(STAIRCASE.ceiling, maxLevel(axis)) * 0.95) return 1;
  const k = Math.min(1, NORMAL_LIMIT / threshold);   // surviving contrast fraction
  // Linear-blend reduction: k = 1 - s for the blended matrix along its null
  // direction. Replace with engine's Machado tables when available.
  return Math.max(0, Math.min(1, 1 - k));
}

// --- reward palette -------------------------------------------------------
// Scale colours for the fish shown after a run. Chosen by farthest-point
// search in the colour space THIS observer actually perceives, so every scale
// is one they can tell from every other — the reward demonstrates the point of
// the app rather than being decorative.

import { simulate as perceive, toLab as cToLab, deltaE as cDeltaE } from "./correct.js";

/**
 * @param {{axis:string|null, severity:number, compensation?:number}} profile
 * @param {number} n      how many scales to pick
 * @param {number} minDE  required separation THROUGH THIS OBSERVER'S EYES
 * @returns {{colours:number[][], minDeltaE:number, requested:number}}
 *          `colours` are linear RGB to paint on screen.
 */
export function rewardPalette(profile, n = 12, minDE = 15) {
  // Candidate colours: mid-to-bright, saturated enough to be worth painting.
  const cand = [];
  for (let r = 0; r <= 6; r++) for (let g = 0; g <= 6; g++) for (let b = 0; b <= 6; b++) {
    const lin = [r / 6, g / 6, b / 6];
    const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    if (Y < 0.06 || Y > 0.95) continue;            // nothing near black or white
    cand.push({ lin, seen: cToLab(perceive(lin, profile)) });
  }

  // Farthest-point sampling: start from the extreme, then repeatedly take the
  // candidate whose nearest already-chosen neighbour is furthest away.
  const mid = cToLab(perceive([0.5, 0.5, 0.5], profile));
  let first = cand[0], fd = -1;
  for (const c of cand) { const d = cDeltaE(c.seen, mid); if (d > fd) { fd = d; first = c; } }

  const chosen = [first];
  while (chosen.length < n) {
    let best = null, bestD = -1;
    for (const c of cand) {
      let near = Infinity;
      for (const p of chosen) near = Math.min(near, cDeltaE(c.seen, p.seen));
      if (near > bestD) { bestD = near; best = c; }
    }
    if (!best || bestD < minDE) break;             // cannot add another and keep the promise
    chosen.push(best);
  }

  let worst = Infinity;
  for (let i = 0; i < chosen.length; i++)
    for (let j = i + 1; j < chosen.length; j++)
      worst = Math.min(worst, cDeltaE(chosen[i].seen, chosen[j].seen));

  return {
    colours: chosen.map((c) => c.lin),
    minDeltaE: chosen.length > 1 ? worst : Infinity,
    requested: n,
  };
}
