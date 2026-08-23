/**
 * Colour-vision engine.
 *
 * Framework-agnostic. Runs in Node (tests) and the browser (app).
 * Everything here operates on LINEAR light unless a function name says sRGB.
 *
 * Two independent simulation models are implemented because neither is best
 * for every case:
 *
 *   Machado, Oliveira & Fernandes (2009) — physiologically-based, and the only
 *   published model with a continuous *severity* parameter. Correct choice for
 *   anomalous trichromacy (the overwhelming majority of real cases).
 *
 *   Brettel, Viénot & Mollon (1997) — LMS half-plane projection. More accurate
 *   for full dichromacy, and materially more accurate than Machado for tritan,
 *   which Machado's own paper flags as fitted to sparse data.
 *
 * See SCIENCE.md for why, and for what is worth building next.
 */

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

export const srgbToLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

export const linearToSrgb = (c) => {
  c = c < 0 ? 0 : c > 1 ? 1 : c;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

export const toLinear = (rgb) => rgb.map(srgbToLinear);
export const toSrgb = (rgb) => rgb.map(linearToSrgb);
export const from255 = (rgb) => rgb.map((c) => srgbToLinear(c / 255));

// 3x3 row-major times vec3
export const mul3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const lerpMat = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

// ---------------------------------------------------------------------------
// Machado et al. (2009), Table 1. Row-major, operate on linear sRGB.
// Index = severity in 0.1 steps, 0.0 (normal) .. 1.0 (dichromat).
// ---------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const MACHADO = {
  protanomaly: [
    IDENTITY,
    [0.856167,0.182038,-0.038205, 0.029342,0.955115,0.015544, -0.002880,-0.001563,1.004443],
    [0.734766,0.334872,-0.069637, 0.051840,0.919198,0.028963, -0.004928,-0.004209,1.009137],
    [0.630323,0.465641,-0.095964, 0.069181,0.890046,0.040773, -0.006308,-0.007724,1.014032],
    [0.539009,0.579343,-0.118352, 0.082546,0.866121,0.051332, -0.007136,-0.011959,1.019095],
    [0.458064,0.679578,-0.137642, 0.092785,0.846313,0.060902, -0.007494,-0.016807,1.024301],
    [0.385450,0.769005,-0.154455, 0.100526,0.829802,0.069673, -0.007442,-0.022190,1.029632],
    [0.319627,0.849633,-0.169261, 0.106241,0.815969,0.077790, -0.007025,-0.028051,1.035076],
    [0.259411,0.923008,-0.182420, 0.110296,0.804340,0.085364, -0.006276,-0.034346,1.040622],
    [0.203876,0.990338,-0.194214, 0.112975,0.794542,0.092483, -0.005222,-0.041043,1.046265],
    [0.152286,1.052583,-0.204868, 0.114503,0.786281,0.099216, -0.003882,-0.048116,1.051998],
  ],
  deuteranomaly: [
    IDENTITY,
    [0.866435,0.177704,-0.044139, 0.049567,0.939063,0.011370, -0.003453,0.007233,0.996220],
    [0.760729,0.319078,-0.079807, 0.090568,0.889315,0.020117, -0.006027,0.013325,0.992702],
    [0.675425,0.433850,-0.109275, 0.125303,0.847755,0.026942, -0.007950,0.018741,0.989209],
    [0.605511,0.528560,-0.134071, 0.155318,0.812366,0.032316, -0.009376,0.023176,0.986200],
    [0.547494,0.607765,-0.155259, 0.181692,0.781742,0.036566, -0.010410,0.027275,0.983136],
    [0.498864,0.674741,-0.173604, 0.205199,0.754872,0.039929, -0.011131,0.030969,0.980162],
    [0.457771,0.731899,-0.189670, 0.226409,0.731012,0.042579, -0.011595,0.034333,0.977261],
    [0.422823,0.781057,-0.203881, 0.245752,0.709602,0.044646, -0.011843,0.037423,0.974421],
    [0.392952,0.823610,-0.216562, 0.263559,0.690210,0.046232, -0.011910,0.040281,0.971630],
    [0.367322,0.860646,-0.227968, 0.280085,0.672501,0.047413, -0.011820,0.042940,0.968881],
  ],
  tritanomaly: [
    IDENTITY,
    [0.926670,0.092514,-0.019184, 0.021191,0.964503,0.014306, 0.008437,0.054813,0.936750],
    [0.895720,0.133330,-0.029050, 0.029997,0.945400,0.024603, 0.013027,0.104707,0.882266],
    [0.905871,0.127791,-0.033662, 0.026856,0.941251,0.031893, 0.013410,0.148296,0.838294],
    [0.948035,0.089490,-0.037526, 0.014364,0.946792,0.038844, 0.010853,0.193991,0.795156],
    [1.017277,0.027029,-0.044306, -0.006113,0.958479,0.047634, 0.006379,0.248708,0.744913],
    [1.104996,-0.046633,-0.058363, -0.032137,0.971635,0.060503, 0.001336,0.317922,0.680742],
    [1.193214,-0.109812,-0.083402, -0.058496,0.979410,0.079086, -0.002346,0.403492,0.598854],
    [1.257728,-0.139648,-0.118081, -0.078003,0.975409,0.102594, -0.003316,0.501214,0.502102],
    [1.278864,-0.125333,-0.153531, -0.084748,0.957674,0.127074, -0.000989,0.601151,0.399838],
    [1.255528,-0.076749,-0.178779, -0.078411,0.930809,0.147602, 0.004733,0.691367,0.303900],
  ],
};

/** Machado matrix for an anomaly family at continuous severity 0..1. */
export function machadoMatrix(family, severity) {
  const table = MACHADO[family];
  if (!table) throw new Error("no Machado table for " + family);
  const t = Math.max(0, Math.min(1, severity)) * 10;
  const i = Math.min(9, Math.floor(t));
  return lerpMat(table[i], table[i + 1], t - i);
}

// ---------------------------------------------------------------------------
// Brettel, Viénot & Mollon (1997) half-plane projection, for dichromacy.
//
// The gamut of a dichromat is two half-planes meeting at the neutral axis.
// A colour is projected onto whichever half-plane it falls in, selected by the
// sign of its dot product with the plane normal. Constants are precomputed in
// linear sRGB (equivalent to doing it in LMS, but one matrix multiply cheaper).
// ---------------------------------------------------------------------------

const BRETTEL = {
  protanopia: {
    m1: [0.14510,1.20165,-0.34675, 0.10447,0.85316,0.04237, 0.00429,-0.00603,1.00174],
    m2: [0.14115,1.16782,-0.30897, 0.10495,0.85730,0.03776, 0.00431,-0.00586,1.00155],
    n: [0.00048, 0.00393, -0.00441],
  },
  deuteranopia: {
    m1: [0.36198,0.86755,-0.22953, 0.26099,0.64512,0.09389, -0.01975,0.02785,0.99189],
    m2: [0.37009,0.88540,-0.25549, 0.25767,0.63782,0.10451, -0.01950,0.02741,0.99209],
    n: [-0.00281, -0.00611, 0.00892],
  },
  tritanopia: {
    m1: [1.01354,0.14268,-0.15622, -0.01181,0.87561,0.13619, 0.07707,0.81208,0.11085],
    m2: [0.93337,0.19999,-0.13336, 0.05809,0.82565,0.11626, -0.37923,1.13825,0.24098],
    n: [0.03960, -0.02831, -0.01129],
  },
};

export const brettelParams = (kind) => BRETTEL[kind];

/** Brettel dichromat simulation. `lin` is linear RGB. */
export function brettel(lin, kind, severity = 1) {
  const p = BRETTEL[kind];
  if (!p) throw new Error("no Brettel params for " + kind);
  const side = lin[0] * p.n[0] + lin[1] * p.n[1] + lin[2] * p.n[2];
  const out = mul3(side >= 0 ? p.m1 : p.m2, lin);
  if (severity >= 1) return out;
  return out.map((v, i) => lin[i] + (v - lin[i]) * severity);
}

// ---------------------------------------------------------------------------
// Rod / cone-monochromacy
//
// Achromatopsia is not "greyscale with photopic luma". Rods peak at ~507nm
// (Purkinje shift), so relative to normal luminance the response is pulled
// toward blue-green and red goes nearly black. These weights are an
// approximation of scotopic V'(lambda) against the sRGB primaries; they are
// directionally right and deliberately flagged as approximate.
// ---------------------------------------------------------------------------

export const ROD_WEIGHTS = [0.03, 0.60, 0.37];
export const PHOTOPIC_WEIGHTS = [0.2126, 0.7152, 0.0722];

export const luma = (lin, w = PHOTOPIC_WEIGHTS) =>
  lin[0] * w[0] + lin[1] * w[1] + lin[2] * w[2];

// ---------------------------------------------------------------------------
// The type registry — every clinically recognised category.
// ---------------------------------------------------------------------------

export const TYPES = {
  normal: {
    label: "Normal colour vision",
    axis: null, prevalence: "~92% of males, ~99.5% of females",
    model: "none",
  },
  protanomaly: {
    label: "Protanomaly", plain: "Red-weak — reds look dark and washed out",
    axis: "red-green", family: "protanomaly", model: "machado",
    prevalence: "~1.3% of males", anomalous: true,
  },
  deuteranomaly: {
    label: "Deuteranomaly", plain: "Green-weak — reds and greens blend together",
    axis: "red-green", family: "deuteranomaly", model: "machado",
    prevalence: "~5% of males — the most common form by far", anomalous: true,
  },
  tritanomaly: {
    label: "Tritanomaly", plain: "Blue-weak — blues and greens blend together",
    // Machado's tritan table is fitted to sparse data and disagrees with
    // Brettel by mean dE 14.2 across the RGB cube, against 2.6-4.2 for
    // protan/deutan. So severity here scales toward the Brettel projection
    // instead. Less physiologically principled, measurably more trustworthy.
    axis: "blue-yellow", family: "tritanomaly", model: "brettel",
    brettel: "tritanopia",
    prevalence: "~1 in 500, affects both sexes equally", anomalous: true,
  },
  protanopia: {
    label: "Protanopia", plain: "No red cone — cannot separate red from green",
    axis: "red-green", family: "protanomaly", model: "brettel", brettel: "protanopia",
    prevalence: "~1% of males", dichromat: true,
  },
  deuteranopia: {
    label: "Deuteranopia", plain: "No green cone — cannot separate red from green",
    axis: "red-green", family: "deuteranomaly", model: "brettel", brettel: "deuteranopia",
    prevalence: "~1.2% of males", dichromat: true,
  },
  tritanopia: {
    label: "Tritanopia", plain: "No blue cone — cannot separate blue from green",
    axis: "blue-yellow", family: "tritanomaly", model: "brettel", brettel: "tritanopia",
    prevalence: "~1 in 10,000, affects both sexes equally", dichromat: true,
  },
  blueConeMonochromacy: {
    label: "Blue cone monochromacy", plain: "Only blue cones work — almost no colour at all",
    axis: null, model: "monochrome", weights: [0.02, 0.11, 0.87],
    prevalence: "~1 in 100,000 males", monochrome: true, photophobic: true,
  },
  achromatopsia: {
    label: "Achromatopsia", plain: "No working cones — no colour, and bright light hurts",
    axis: null, model: "monochrome", weights: ROD_WEIGHTS,
    prevalence: "~1 in 30,000", monochrome: true, photophobic: true,
  },
};

// ---------------------------------------------------------------------------
// Simulation — what this person's retina actually receives
// ---------------------------------------------------------------------------

export function simulate(lin, profile) {
  const t = TYPES[profile.type];
  if (!t || t.model === "none") return lin.slice();
  const sev = profile.severity == null ? 1 : profile.severity;

  if (t.model === "monochrome") {
    const y = luma(lin, t.weights);
    const grey = [y, y, y];
    return sev >= 1 ? grey : lin.map((v, i) => v + (grey[i] - v) * sev);
  }
  if (t.model === "brettel") return brettel(lin, t.brettel, sev);
  return mul3(machadoMatrix(t.family, sev), lin);
}

// ---------------------------------------------------------------------------
// Correction
//
// One formula, one control. `boost` 0..1 goes from untouched to maximum
// separation, and separation is monotonic in it for every type (verified in
// engine.test.mjs) — so a single slider in the UI always means "more help".
//
// The constants are NOT hand-copied from the daltonization sample code that
// circulates online. That code hardcodes one red-green shift matrix for
// everyone, which measurably makes some protan pairs WORSE (red vs brown went
// to 0.5x). These were derived numerically by src/optimize.mjs:
//
//   pick — the direction the deficiency destroys. Recovered as the dominant
//          singular vector of (I - Sim), so it follows from the simulation
//          model rather than being guessed.
//   push — where to send it. Searched over a spherical grid against ~400
//          machine-generated confusion pairs per type, maximising the WORST
//          DECILE of separation gain (so no pair is left behind) under a
//          naturalness budget of dE 45.
//   sat  — saturation expansion about luma, ramped with boost.
//
// Measured worst-decile gain 3.6x-6.4x, median 8.3x-13.8x. See SCIENCE.md.
// ---------------------------------------------------------------------------

// Two corrections, because they answer different questions.
//
// NATURAL is the default. Optimised for separation SUBJECT TO a hue cap
// (mean <= 10 deg, worst <= 22 deg on everyday colours), so an orange still
// looks orange. The previous single correction had no hue term at all — it
// turned orange into pink-purple (67 deg shift), which is both wrong-looking
// and teaches a child the wrong name for a colour.
//
// MAX drops the hue cap for maximum separation. Colours stop being true; it is
// for "are these two things the same colour or not", not for looking at.
//
// Neither can make a deficient eye PERCEIVE the true colour. That would need
// the inverse of the simulation, whose entries reach 14x and -17x at severity
// 0.9 — far outside any display gamut. Measured: the best in-gamut correction
// reduces perceived-colour error by 21% at severity 0.4, but only 2% at 0.9.
// See SCIENCE.md §5.
const CORRECTION_NATURAL = {
  protanomaly:   { push: [0.9744, 1.0822, 1.0580], sat: 0.20 },
  protanopia:    { push: [0.8560, 1.1781, 1.0580], sat: 0.20 },
  deuteranomaly: { push: [0.4232, 0.9505, 0.9368], sat: 0.40 },
  deuteranopia:  { push: [0.8560, 1.1781, 1.0580], sat: 0.20 },
  tritanomaly:   { push: [1.1003, 1.2220, 0.7321], sat: 0.00 },
  tritanopia:    { push: [1.1003, 1.2220, 0.7321], sat: 0.00 },
};

const CORRECTION_MAX = {
  protanomaly:   { pick: [0.6141,-0.7730,0.1589], push: [ 1.0904, 0.9818,-0.3119], sat: 0.25 },
  protanopia:    { pick: [0.5674,-0.7975,0.2051], push: [ 0.1977, 0.9303,-0.3090], sat: 0.50 },
  deuteranomaly: { pick: [0.5883,-0.7845,0.1962], push: [-1.4135,-0.4593, 1.3383], sat: 0.00 },
  deuteranopia:  { pick: [0.5672,-0.7972,0.2067], push: [ 0.9654, 0.5574,-1.0037], sat: 0.25 },
  tritanomaly:   { pick: [-0.0562,-0.8307,0.5539], push: [-1.0904, 0.9818, 0.3119], sat: 0.25 },
  tritanopia:    { pick: [-0.0562,-0.8307,0.5539], push: [-1.0904, 0.9818, 0.3119], sat: 0.25 },
};

/** @param {"natural"|"max"} style */
export const correctionFor = (type, style = "natural") =>
  (style === "max" ? CORRECTION_MAX : CORRECTION_NATURAL)[type] || null;

/**
 * Push the information the retina discards onto an axis it still has.
 * @param {number[]} lin      linear RGB
 * @param {object}   profile  {type, severity}
 * @param {number}   boost    0 = untouched, 1 = maximum separation
 */
export function assist(lin, profile, boost = 0.5, style = "natural") {
  const c = correctionFor(profile.type, style);
  if (!c || boost <= 0) return lin.slice();
  const sim = simulate(lin, profile);
  const err = [lin[0] - sim[0], lin[1] - sim[1], lin[2] - sim[2]];
  const pick = CORRECTION_MAX[profile.type].pick;   // the lost axis, per type
  const d = err[0] * pick[0] + err[1] * pick[1] + err[2] * pick[2];
  const y = luma(lin);
  const k = 1 + c.sat * boost;
  const target = lin.map((v, i) => {
    const shifted = v + d * c.push[i] * boost;
    return y + (shifted - y) * k;
  });

  // Gamut handling: plain clipping, deliberately. Two smarter strategies were
  // measured and both lost — scaling back along the correction ray collapses
  // p10 gain from ~5x to 1.0x (any colour already touching a channel boundary
  // gets zero correction), and tanh soft-clipping matches plain clipping to
  // within 0.1x while lifting black. See src/optimize.mjs for the comparison.
  //
  // The residual cost is a small tail — roughly 2-4% of confusion pairs, all
  // already near the gamut edge — where correction still loses to clipping.
  // That tail is irreducible without a wider gamut; Display P3 is the real fix
  // and is the top item in SCIENCE.md.
  return target;
}

// ---------------------------------------------------------------------------
// Perceptual distance, used by the tests to prove the correction earns its keep
// ---------------------------------------------------------------------------

const linToXyz = (l) => [
  0.4124564 * l[0] + 0.3575761 * l[1] + 0.1804375 * l[2],
  0.2126729 * l[0] + 0.7151522 * l[1] + 0.0721750 * l[2],
  0.0193339 * l[0] + 0.1191920 * l[1] + 0.9503041 * l[2],
];
const WHITE = [0.95047, 1.0, 1.08883];
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIE L*a*b* from linear RGB. */
export function toLab(lin) {
  const xyz = linToXyz(lin).map((v, i) => f(v / WHITE[i]));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** CIE76 deltaE. Crude next to CIEDE2000, but monotonic and enough to rank. */
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Round-trip a corrected colour through the display and back into the eye. */
export function asSeen(lin, profile, boost, style = "natural") {
  const shown = boost == null ? lin : assist(lin, profile, boost, style);
  const clipped = toLinear(toSrgb(shown)); // the display cannot show out-of-gamut
  return simulate(clipped, profile);
}

// ---------------------------------------------------------------------------
// Personal calibration
//
// A label like "strong deutan" is a bucket, not a measurement. A Rayleigh
// match (the anomaloscope test) fits the actual severity: the user adjusts a
// red/green mixture until it matches a fixed yellow. Where they settle maps
// directly onto the severity parameter, because that is precisely the quantity
// the mixture ratio is diagnostic of.
// ---------------------------------------------------------------------------

/**
 * @param {number} match  0 = matched at pure green, 1 = matched at pure red,
 *                        0.5 = the normal-observer match point.
 * @returns {{severity:number, type:string, confidence:string}}
 */
export function severityFromRayleigh(match) {
  const dev = match - 0.5;              // signed: +red-heavy, -green-heavy
  const severity = Math.min(1, Math.abs(dev) / 0.5);
  // Needing MORE red to match means the red signal is weak -> protan.
  // Needing MORE green means the green signal is weak -> deutan.
  const type = dev > 0 ? "protanomaly" : "deuteranomaly";
  const confidence =
    severity < 0.15 ? "within normal range" : severity < 0.5 ? "mild" : severity < 0.85 ? "moderate" : "strong";
  return { severity, type, confidence };
}

// ---------------------------------------------------------------------------
// GLSL — generated from the same constants, so the GPU path cannot drift
// from the CPU path the tests cover.
// ---------------------------------------------------------------------------

const glslMat = (m) =>
  `mat3(${[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]].map((v) => v.toFixed(6)).join(",")})`;

export function buildShaderConstants(profile) {
  const t = TYPES[profile.type] || TYPES.normal;
  const sev = profile.severity == null ? 1 : profile.severity;
  const c = { model: t.model, axis: t.axis || "none" };
  if (t.model === "machado") c.sim = glslMat(machadoMatrix(t.family, sev));
  if (t.model === "brettel") {
    const p = BRETTEL[t.brettel];
    c.m1 = glslMat(p.m1); c.m2 = glslMat(p.m2);
    c.normal = `vec3(${p.n.map((v) => v.toFixed(6)).join(",")})`;
    c.severity = sev;
  }
  if (t.model === "monochrome") c.weights = `vec3(${t.weights.join(",")})`;
  for (const style of ["natural", "max"]) {
    const corr = correctionFor(profile.type, style);
    if (!corr) continue;
    c[style] = {
      pick: `vec3(${CORRECTION_MAX[profile.type].pick.join(",")})`,
      push: `vec3(${corr.push.join(",")})`,
      sat: corr.sat,
    };
  }
  return c;
}
