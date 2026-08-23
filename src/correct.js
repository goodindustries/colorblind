// correct.js — pixel correction model for colour-vision deficiency on a phone.
//
// Hard constraints this module enforces (not just documents):
//   CAMERA   8-bit sRGB/P3 tristimulus only. No spectral recovery is possible,
//            so the model never pretends to restore a lost axis; it relocates
//            discarded information onto axes the eye still has.
//   SCREEN   3 primaries (P3 if available), 60/120 Hz. Output is gamut-mapped
//            by scaling chroma toward luminance, never per-channel clipping,
//            because clipping rotates hue (that is how orange became purple).
//   EYE      Machado severity sim, with a post-receptoral compensation term:
//            anomalous trichromats partially amplify their weak L-M signal
//            (Basim/Webster 2025, Tregillus 2021), so raw severity over-
//            simulates the loss and over-corrects. Hue shift is capped in Lab.
//   TIME     Chromatic flicker fuses at ~15-25 Hz and 3-30 Hz is the
//            photosensitive band. Any temporal mode is clamped to <=1.5 Hz,
//            is chroma-only (luminance held exactly constant), and is gated
//            to pixels that actually carry lost information.
//
// Interface: correctPixel(lin, profile, mode, t) -> lin, all in linear light.
// Swap `simulate` for the engine's own (Machado/Brettel) if it exists.

export const MODES = ["natural", "achromatic", "split", "pulse"];

// --- colour maths (linear sRGB / D65) -------------------------------------
export const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp01 = x => Math.max(0, Math.min(1, x));
const mul3 = (M, v) => [
  M[0]*v[0]+M[1]*v[1]+M[2]*v[2],
  M[3]*v[0]+M[4]*v[1]+M[5]*v[2],
  M[6]*v[0]+M[7]*v[1]+M[8]*v[2]];
const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

export function toLab(lin) {
  const [r,g,b] = lin;
  let X = 0.4124*r+0.3576*g+0.1805*b, Y = 0.2126*r+0.7152*g+0.0722*b, Z = 0.0193*r+0.1192*g+0.9505*b;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116;
  const fx = f(X/0.95047), fy = f(Y), fz = f(Z/1.08883);
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
export function fromLab([L,a,b]) {
  const fy = (L+16)/116, fx = a/500+fy, fz = fy-b/200;
  const fi = t => t > 0.206893 ? t*t*t : (t-16/116)/7.787;
  const X = fi(fx)*0.95047, Y = fi(fy), Z = fi(fz)*1.08883;
  return [ 3.2406*X-1.5372*Y-0.4986*Z, -0.9689*X+1.8758*Y+0.0415*Z, 0.0557*X-0.2040*Y+1.0570*Z ];
}
export const deltaE = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const hueOf = lab => Math.atan2(lab[2], lab[1]);
const chromaOf = lab => Math.hypot(lab[1], lab[2]);

// --- simulation: the engine's (Machado severity tables + Brettel) ----------
import { simulate as engineSimulate } from "./engine.js";
const ENGINE_TYPE = {
  protan: ["protanomaly", "protanopia"],
  deutan: ["deuteranomaly", "deuteranopia"],
  tritan: ["tritanomaly", "tritanopia"],
};

// Effective severity: the retinal loss minus what the cortex recovers.
// compensation in [0,1]; 0 for dichromats (nothing to amplify), ~0.3 default
// for anomalous trichromats. Calibrate per person when possible.
export function effectiveSeverity(profile) {
  const s = clamp01(profile.severity ?? 1);
  const comp = s >= 0.999 ? 0 : clamp01(profile.compensation ?? 0.3);
  return s * (1 - comp);
}

export function simulate(lin, profile) {
  const s = effectiveSeverity(profile);
  const pair = ENGINE_TYPE[profile.axis];
  if (!pair || s <= 0) return lin.slice();
  return engineSimulate(lin, { type: s >= 0.999 ? pair[1] : pair[0], severity: s });
}

// Dominant lost direction for this profile: principal singular vector of (I - Sim).
const _axisCache = new Map();
export function lostAxis(profile) {
  const key = `${profile.axis}|${effectiveSeverity(profile).toFixed(4)}`;
  const hit = _axisCache.get(key);
  if (hit) return hit;
  const v = computeLostAxis(profile);
  _axisCache.set(key, v);
  return v;
}
function computeLostAxis(profile) {
  const cols = [[1,0,0],[0,1,0],[0,0,1]].map(e => {
    const s = simulate(e, profile); return e.map((v,i) => v - s[i]);
  });
  const A = v => { const Mv = [0,1,2].map(r => cols[0][r]*v[0]+cols[1][r]*v[1]+cols[2][r]*v[2]);
                   return [0,1,2].map(c => dot(cols[c], Mv)); };
  let v = [0.6, -0.6, 0.2];
  for (let i = 0; i < 64; i++) { const w = A(v); const n = Math.hypot(...w) || 1; v = w.map(x => x/n); }
  if (v[0] < 0) v = v.map(x => -x);
  return v;
}

// Where to deposit the lost information: the opponent axis the eye still has.
// Red-green loss -> blue-yellow; tritan loss -> red-green.
export const SURVIVING_AXIS = {
  protan: [-0.3, -0.3, 1.0],
  deutan: [-0.3, -0.3, 1.0],
  tritan: [1.0, -1.0, 0.0],
};

// --- gamut mapping: scale chroma toward luminance, never clip channels ----
export function mapToGamut(c) {
  const Y = clamp01(luma(c));
  let t = 1;
  for (let i = 0; i < 3; i++) {
    const d = c[i] - Y;
    if (c[i] > 1 && d > 0) t = Math.min(t, (1 - Y) / d);
    if (c[i] < 0 && d < 0) t = Math.min(t, (0 - Y) / d);
  }
  return c.map(v => Y + (v - Y) * Math.max(0, t));
}

// --- hue guard: hard cap on hue rotation in Lab, preserving L and chroma ---
//
// Reconstructing a capped-hue point from Lab can itself land outside the RGB
// cube, so it is fed through mapToGamut — but mapToGamut scales chroma toward
// RGB luma, which is not a hue-preserving move in Lab. That could silently
// push hue back past the cap it was just set to (measured: 15% of the
// adaptive optimiser's grid, worst case 20.7deg against a 16deg cap). So the
// cap is enforced as a true bound: back off chroma in RGB-gamut space until
// the hue actually measured after gamut-mapping is inside the cap.
export function guardHue(out, ref, capDeg) {
  const lo = toLab(out), lr = toLab(ref);
  if (chromaOf(lr) < 4 || chromaOf(lo) < 4) return out;      // near-neutral: hue undefined
  let dh = hueOf(lo) - hueOf(lr);
  while (dh > Math.PI) dh -= 2*Math.PI; while (dh < -Math.PI) dh += 2*Math.PI;
  const cap = capDeg * Math.PI / 180;
  if (Math.abs(dh) <= cap) return out;
  const h = hueOf(lr) + Math.sign(dh) * cap;
  const target = [lo[0], Math.cos(h), Math.sin(h)]; // unit chroma direction at the capped hue
  // Fallback is the achromatic point at this lightness — chroma 0 means hue is
  // undefined, which trivially satisfies any cap, so it is always a safe worst
  // case rather than the unguarded (possibly over-cap) input.
  let lo_t = 0, hi_t = chromaOf(lo), best = mapToGamut(fromLab([lo[0], 0, 0]));
  for (let i = 0; i < 20; i++) {
    const mid = (lo_t + hi_t) / 2;
    const cand = mapToGamut(fromLab([lo[0], target[1] * mid, target[2] * mid]));
    const lc = toLab(cand);
    let dhc = hueOf(lc) - hueOf(lr);
    while (dhc > Math.PI) dhc -= 2*Math.PI; while (dhc < -Math.PI) dhc += 2*Math.PI;
    if (Math.abs(dhc) <= cap) { best = cand; lo_t = mid; } else hi_t = mid;
  }
  return best;
}

// --- set luminance of c to Y without changing chromaticity ----------------
function withLuma(c, Y) {
  const y0 = luma(c);
  if (y0 < 1e-6) return [Y, Y, Y];
  return c.map(v => v * Y / y0);
}

// --- the modes ------------------------------------------------------------
export const DEFAULTS = {
  strength: 0.6,
  hueCapDeg: 16,        // per-pixel hard cap; everyday-set mean lands ~8-10
  pulseHz: 1.0,         // must stay <= 1.5: below tracking, far below 3-30 Hz
  pulseGate: 0.05,      // |err| below this: pixel does not move at all
  pulseHueCapDeg: 30,   // peak excursion; bounded so orange never reads purple
};

function decompose(lin, profile) {
  const full = { axis: profile.axis, severity: 1 };
  const sim = simulate(lin, full);
  const errFull = lin.map((v, i) => v - sim[i]);
  const axis = lostAxis(full);
  const s = effectiveSeverity(profile);
  // what this eye loses: full loss x effective severity (with a floor so mild
  // cases still get a usable push; their confusion is real even if smaller)
  const k = 0.35 + 0.65 * s;
  const err = errFull.map(v => v * k);
  return { sim, err, d: dot(err, axis), mag: Math.hypot(...err), s };
}

// natural: push along the surviving axis + amplify the residual lost axis,
// chroma boosted around constant luminance, hue hard-capped.
function natural(lin, profile, p) {
  const { err, d } = decompose(lin, profile);
  const surv = SURVIVING_AXIS[profile.axis] ?? [0,0,0];
  const k = p.strength;
  const Y = luma(lin);
  let out = lin.map((v, i) => v + err[i] * k * 0.8 + surv[i] * d * k * 0.6);
  out = withLuma(out, Y);
  out = out.map(v => Y + (v - Y) * (1 + 0.35 * k));   // chroma boost
  out = mapToGamut(out);
  return guardHue(out, lin, p.hueCapDeg);
}

// achromatic: hue and chroma untouched; lost information encoded as a
// luminance offset (Sidorchuk 2025). Zero hue risk by construction.
function achromatic(lin, profile, p) {
  const { d } = decompose(lin, profile);
  const Y = luma(lin);
  // bounded to [0.5x, 2x] so dark colours never fall into the Lab toe where
  // hue is undefined, and highlights never blow out
  const f = Math.max(0.5, Math.min(2, Math.pow(2, d * 4 * p.strength)));
  // never brighter than this chromaticity can go in-gamut (saturated yellow
  // cannot get lighter without going white)
  const yMax = Y / Math.max(lin[0], lin[1], lin[2], 1e-6);
  let Y2 = Math.max(0.02, Y * f);
  if (Y2 > Y) Y2 = Math.min(Y2, Math.max(Y, yMax * 0.995));
  return mapToGamut(withLuma(lin, Y2));
}

// split: Fidaner error redistribution, maximum separation, hue not protected.
function split(lin, profile, p) {
  const { err } = decompose(lin, profile);
  const M = profile.axis === "tritan"
    ? [1,0,0.7, 0,1,0.7, 0,0,0]
    : [0,0,0, 0.7,1,0, 0.7,0,1];
  const s = mul3(M, err);
  return mapToGamut(lin.map((v, i) => v + s[i] * (0.5 + p.strength)));
}

// pulse: slow chroma-only breathing between natural and split on pixels that
// carry lost information. Luminance is held to natural's value exactly, so
// the screen never strobes; only confusion regions move, at <=1.5 Hz.
function pulse(lin, profile, p, t) {
  const a = natural(lin, profile, p);
  const { mag } = decompose(lin, profile);
  const gate = clamp01((mag - p.pulseGate) / p.pulseGate);
  if (gate <= 0) return a;
  const b = withLuma(split(lin, profile, p), luma(a));
  const hz = Math.min(p.pulseHz, 1.5);
  const w = 0.5 * (1 - Math.cos(2 * Math.PI * hz * t)) * gate;
  const out = mapToGamut(a.map((v, i) => v + (b[i] - v) * w));
  return guardHue(out, lin, p.pulseHueCapDeg);
}

export function correctPixel(lin, profile, mode = "natural", t = 0, params = {}) {
  const p = { ...DEFAULTS, ...params };
  if (effectiveSeverity(profile) <= 0) return lin.slice();
  switch (mode) {
    case "natural":    return natural(lin, profile, p);
    case "achromatic": return achromatic(lin, profile, p);
    case "split":      return split(lin, profile, p);
    case "pulse":      return pulse(lin, profile, p, t);
    default: throw new Error(`unknown mode ${mode}`);
  }
}

// sRGB helpers for callers working in 8-bit.
export const from255 = rgb => rgb.map(v => { const c = v/255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); });
export const to255 = lin => lin.map(v => { const c = clamp01(v); const s = c <= 0.0031308 ? c*12.92 : 1.055*Math.pow(c, 1/2.4) - 0.055; return Math.round(s*255); });
