/**
 * Diagnostics that run where the app actually runs.
 *
 * The node suites cover the colour maths, but they cannot see the two things
 * that decide whether this works on a real phone: what the GPU does with the
 * generated shader, and how the correction behaves on the pixel distribution
 * of a real photograph rather than a handful of hand-picked swatches.
 *
 * Everything here returns plain data. test.html renders it; a headless browser
 * reads `window.__DIAG`.
 */

import { TYPES, simulate, toLab, deltaE, from255, linearToSrgb, srgbToLinear } from "./engine.js";
import { correctPixel, effectiveSeverity } from "./correct.js";
import { createRenderer, MODE } from "./render.js";
import * as K from "./calibrate.js";
import { optimiseForPalette, applyParams, makeContext as adaptContext } from "./adapt.js";

export const MODE_NAMES = ["normal", "natural", "simulate", "split", "achromatic", "pulse"];

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------
export function deviceReport() {
  const out = {
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio || 1,
    screen: `${screen.width}x${screen.height}`,
    secure: window.isSecureContext,
  };
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d", { colorSpace: "display-p3" });
    out.canvasP3 = ctx?.getContextAttributes?.().colorSpace === "display-p3";
  } catch { out.canvasP3 = false; }

  try {
    const gl = document.createElement("canvas").getContext("webgl");
    out.webgl = !!gl;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "hidden";
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      try {
        if ("drawingBufferColorSpace" in gl) {
          gl.drawingBufferColorSpace = "display-p3";
          out.glP3 = gl.drawingBufferColorSpace === "display-p3";
        } else out.glP3 = false;
      } catch { out.glP3 = false; }
    }
  } catch (e) { out.webgl = false; out.webglError = String(e); }

  // What the calibration game can actually reach on THIS display.
  const reach = {};
  for (const g of ["srgb", "display-p3"]) { K.setGamut(g); reach[g] = K.maxLevels(); }
  K.setGamut(out.canvasP3 ? "display-p3" : "srgb");
  out.calibrationReach = reach;
  out.deutanCeilingHit = reach[out.canvasP3 ? "display-p3" : "srgb"].deutan >= K.STAIRCASE.ceiling;
  return out;
}

// ---------------------------------------------------------------------------
// Does the shipped shader agree with the tested model?
//
// The node suites verify the CPU maths and that the GLSL contains the right
// constants. Neither proves the GPU produces the same pixels. This does.
// ---------------------------------------------------------------------------
export function gpuAgreement(profile, canvas, modeName = "natural") {
  const N = 16;
  const src = document.createElement("canvas");
  src.width = N * N; src.height = N;
  const sctx = src.getContext("2d");
  const colours = [];
  for (let i = 0; i < N * N; i++) {
    const r = (i % N) / (N - 1);
    const g = (Math.floor(i / N) % N) / (N - 1);
    const b = ((i * 7) % N) / (N - 1);
    const rgb = [r, g, b].map((v) => Math.round(v * 255));
    colours.push(rgb);
    sctx.fillStyle = `rgb(${rgb.join(",")})`;
    sctx.fillRect(i, 0, 1, N);
  }

  canvas.width = N * N; canvas.height = N;
  const r = createRenderer(canvas);
  r.setProfile(profile);
  r.setBoost(0.6);
  r.setExposure(1);
  r.setMode(MODE[modeName.toUpperCase()] ?? MODE.NATURAL);
  r.attach(src);
  r.drawRaw ? r.drawRaw() : r.draw();

  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
  const px = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const cprof = toCorrectProfile(profile);
  let worst = 0, sum = 0, n = 0, worstAt = null;
  const row = Math.floor(N / 2);
  for (let i = 0; i < N * N; i++) {
    const o = ((canvas.height - 1 - row) * canvas.width + i) * 4;
    const gpu = [px[o] / 255, px[o + 1] / 255, px[o + 2] / 255].map(srgbToLinear);
    const cpu = correctPixel(from255(colours[i]), cprof, modeName, 0, { strength: 0.6 });
    const d = deltaE(toLab(gpu), toLab(cpu.map((v) => Math.max(0, Math.min(1, v)))));
    sum += d; n++;
    if (d > worst) { worst = d; worstAt = colours[i]; }
  }
  return { mode: modeName, samples: n, meanDeltaE: sum / n, worstDeltaE: worst, worstColour: worstAt };
}

const AXIS_OF = {
  protanomaly: "protan", protanopia: "protan",
  deuteranomaly: "deutan", deuteranopia: "deutan",
  tritanomaly: "tritan", tritanopia: "tritan",
};
export const toCorrectProfile = (p) => ({
  axis: AXIS_OF[p.type] || null,
  severity: p.severity == null ? 1 : p.severity,
  compensation: p.compensation,
});

// ---------------------------------------------------------------------------
// What a real image is actually made of
//
// This is the harness the synthetic swatch tests were missing: find the pairs
// of colours THIS image contains that collapse for THIS observer, then measure
// what each mode does to them.
// ---------------------------------------------------------------------------
export function quantise(imageData, bins = 12) {
  const { data, width, height } = imageData;
  const map = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const o = (y * width + x) * 4;
    if (data[o + 3] < 200) continue;
    const q = [0, 1, 2].map((c) => Math.min(bins - 1, Math.floor((data[o + c] / 256) * bins)));
    const key = (q[0] * bins + q[1]) * bins + q[2];
    const e = map.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[o]; e.g += data[o + 1]; e.b += data[o + 2];
    map.set(key, e);
  }
  const total = [...map.values()].reduce((s, e) => s + e.n, 0) || 1;
  return [...map.values()]
    .filter((e) => e.n / total > 0.002)          // ignore specks
    .map((e) => ({ rgb: [e.r / e.n, e.g / e.n, e.b / e.n].map(Math.round), share: e.n / total }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 48);
}

export function sceneReport(imageData, profile, opts = {}) {
  const strength = opts.strength ?? 0.6;
  const cprof = toCorrectProfile(profile);
  const palette = quantise(imageData);
  const P = (lin) => toLab(simulate(lin, profile));

  const items = palette.map((p) => {
    const lin = from255(p.rgb);
    return { ...p, lin, lab: toLab(lin), seen: P(lin) };
  });

  // Difficulty is a scale, not a switch. A first version filtered to pairs the
  // eye sees as nearly identical (seen < 10) and reported ZERO confusable pairs
  // in a picture of traffic lights — which is plainly wrong. A deutan can
  // partly separate saturated red from green; it is still hard. So: keep every
  // pair a normal eye separates clearly, and band them by how much survives.
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const trueD = deltaE(items[i].lab, items[j].lab);
    if (trueD <= 20) continue;                  // not clearly different anyway
    const seenD = deltaE(items[i].seen, items[j].seen);
    const lost = 1 - seenD / trueD;             // fraction of the difference lost
    if (lost <= 0.25) continue;                 // this eye keeps most of it
    pairs.push({ a: items[i], b: items[j], trueD, seenD, lost,
                 weight: items[i].share * items[j].share * lost });
  }
  pairs.sort((x, y) => y.weight - x.weight);
  const top = pairs.slice(0, 300);
  const band = (p) => (p.seenD < 5 ? "invisible" : p.seenD < 15 ? "hard" : "workable");
  const bands = { invisible: 0, hard: 0, workable: 0 };
  for (const p of top) bands[band(p)]++;

  const modes = opts.modes ?? ["natural", "achromatic", "split", "adaptive"];
  const results = {};

  // The adaptive mode fits itself to THIS palette before being measured on it,
  // which is exactly how it will behave on a live frame.
  const adaptPalette = palette.map((p) => ({ lin: from255(p.rgb), share: p.share }));
  const fitted = optimiseForPalette(adaptPalette, cprof, { strength });
  const actx = adaptContext(cprof);
  const applyMode = (lin, m) =>
    m === "adaptive" ? applyParams(lin, actx, fitted, strength)
                     : correctPixel(lin, cprof, m, 0, { strength });

  for (const m of modes) {
    const gains = [], after = [];
    let worseCount = 0, worseWeight = 0, totalWeight = 0;
    for (const p of top) {
      const ca = applyMode(p.a.lin, m);
      const cb = applyMode(p.b.lin, m);
      const d = deltaE(P(ca), P(cb));
      after.push(d);
      const g = d / Math.max(p.seenD, 0.5);
      gains.push(g);
      totalWeight += p.weight;
      if (d < p.seenD - 0.5) { worseCount++; worseWeight += p.weight; }
    }
    gains.sort((a, b) => a - b);
    after.sort((a, b) => a - b);
    const q = (arr, f) => (arr.length ? arr[Math.floor(f * (arr.length - 1))] : null);
    // The pairs that start out invisible are the ones that matter most; report
    // them separately so a good average cannot hide a failure on the worst.
    const hardGains = [];
    top.forEach((p, i) => { if (p.seenD < 5) hardGains.push(gains[i]); });
    hardGains.sort((a, b) => a - b);
    results[m] = {
      pairs: top.length,
      medianGain: q(gains, 0.5),
      p10Gain: q(gains, 0.1),
      medianGainOnInvisible: q(hardGains, 0.5),
      medianSeparationAfter: q(after, 0.5),
      pairsMadeWorse: top.length ? worseCount / top.length : 0,
      frameMadeWorse: totalWeight ? worseWeight / totalWeight : 0,
      ...(m === "adaptive" ? { fittedTo: { kL: +fitted.kL.toFixed(2), kC: +fitted.kC.toFixed(2), kF: +fitted.kF.toFixed(2), sat: +fitted.sat.toFixed(2) } } : {}),
    };
  }

  return {
    coloursFound: palette.length,
    confusablePairs: pairs.length,
    difficulty: bands,
    medianSeparationBefore: top.length
      ? top.map((p) => p.seenD).sort((a, b) => a - b)[Math.floor(top.length / 2)] : null,
    worstExamples: top.slice(0, 5).map((p) => ({
      a: p.a.rgb, b: p.b.rgb, normallyApart: +p.trueD.toFixed(1), seenApart: +p.seenD.toFixed(1),
    })),
    modes: results,
  };
}

export const summarise = (r) => JSON.stringify(r, null, 2);
