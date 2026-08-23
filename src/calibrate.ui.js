/**
 * The calibration game: a dot field with a hidden fish, tapped ~75 times.
 *
 * Rendering and hit-testing only — every stimulus decision comes from
 * calibrate.js, which owns the published CCT parameters. This file must not
 * change what is shown, only where it is drawn.
 *
 * Stimuli run in Display P3 where the browser has it. That is not cosmetic:
 * in sRGB the deutan confusion line runs out of gamut at 642 of 1100, so a
 * strong deutan pins at the ceiling and the severity reading is lost. P3
 * reaches 845 — 32% further, exactly where it is needed.
 */

import * as K from "./calibrate.js";
import { rewardPalette } from "./calibrate.js";

const linToSrgb = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};

/** Does this browser give us a wide-gamut 2D canvas? */
export function p3Available() {
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d", { colorSpace: "display-p3" });
    return !!ctx && ctx.getContextAttributes?.().colorSpace === "display-p3";
  } catch { return false; }
}

export function makeContext(canvas) {
  if (p3Available()) {
    try { return { ctx: canvas.getContext("2d", { colorSpace: "display-p3" }), wide: true }; }
    catch { /* fall through */ }
  }
  return { ctx: canvas.getContext("2d"), wide: false };
}

const paint = (ctx, lin, wide) => {
  if (wide) {
    ctx.fillStyle = `color(display-p3 ${lin.map((v) => Math.max(0, Math.min(1, v)).toFixed(4)).join(" ")})`;
  } else {
    ctx.fillStyle = `rgb(${lin.map(linToSrgb).join(",")})`;
  }
};

/** Draw one trial's dot field to fill the canvas. */
export function drawTrial(canvas, ctx, trial, wide) {
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  // Dot sizes are given in arcmin; scale the set so the largest is legible.
  const span = Math.min(w, h);
  const maxArc = Math.max(...K.DOT_SIZES_ARCMIN);
  for (const d of trial.dots) {
    paint(ctx, d.lin, wide);
    const r = (d.size / maxArc) * (span / 46);
    ctx.beginPath();
    ctx.arc(d.x * w, d.y * h, r, 0, 7);
    ctx.fill();
  }
}

/** Draw the reward fish using scales this observer can actually separate. */
export function drawReward(canvas, ctx, profile, wide) {
  const w = canvas.width, h = canvas.height;
  const { colours } = rewardPalette(profile, 12, 15);
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5, cy = h * 0.5, R = Math.min(w, h) * 0.3;
  // Body, then overlapping scales in a spiral so every neighbour differs.
  for (let i = 0; i < colours.length; i++) {
    paint(ctx, colours[i], wide);
    const a = (i / colours.length) * Math.PI * 2;
    const rr = R * (0.32 + 0.5 * ((i % 3) / 3));
    ctx.beginPath();
    ctx.ellipse(cx + Math.cos(a) * rr * 0.9, cy + Math.sin(a) * rr * 0.55,
                R * 0.26, R * 0.20, a, 0, 7);
    ctx.fill();
  }
  paint(ctx, colours[0], wide);
  ctx.beginPath();
  ctx.moveTo(cx + R * 0.95, cy);
  ctx.lineTo(cx + R * 1.5, cy - R * 0.45);
  ctx.lineTo(cx + R * 1.5, cy + R * 0.45);
  ctx.closePath();
  ctx.fill();
  return colours.length;
}

/**
 * Drive a whole session. `onProgress(done, total)` for the bar, `onWait(frac)`
 * for a per-trial countdown (1 -> 0 over timeoutMs, reset each trial), resolves
 * with `Session.result()`.
 */
export function runSession(canvas, { onProgress, onWait, timeoutMs = 5000 } = {}) {
  const { ctx, wide } = makeContext(canvas);
  K.setGamut(wide ? "display-p3" : "srgb");
  const session = new K.Session();
  // Rough total for the progress bar; the staircases decide the real length.
  const expected = 78;
  let answered = 0;

  return new Promise((resolve) => {
    let timer = 0, waitRaf = 0;
    const finish = () => {
      clearTimeout(timer);
      cancelAnimationFrame(waitRaf);
      canvas.onpointerdown = null;
      resolve({ ...session.result(), gamut: K.gamut() });
    };
    const step = () => {
      const trial = session.next();
      if (!trial) return finish();
      drawTrial(canvas, ctx, trial, wide);

      const answer = (tap) => {
        clearTimeout(timer);
        cancelAnimationFrame(waitRaf);
        canvas.onpointerdown = null;
        session.respond(tap);
        answered++;
        onProgress?.(answered, Math.max(expected, answered + 1), session.catchFails);
        step();
      };

      // One in eight trials has no fish at all. Without a way to answer
      // "nothing there", a catch trial can never be passed and the guess
      // detector is dead — a run of random taps yields a confident, wrong
      // result. Not tapping IS the answer; the timeout collects it.
      canvas.onpointerdown = (e) => {
        const r = canvas.getBoundingClientRect();
        answer({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
      };
      timer = setTimeout(() => answer(null), timeoutMs);

      // Countdown runs identically on every trial, catch or not — if it only
      // showed on catch trials, its presence would itself answer "is there a
      // fish", which is exactly the guess-detector this is meant to protect.
      if (onWait) {
        const startedAt = performance.now();
        const tick = () => {
          const frac = Math.max(0, 1 - (performance.now() - startedAt) / timeoutMs);
          onWait(frac);
          if (frac > 0) waitRaf = requestAnimationFrame(tick);
        };
        waitRaf = requestAnimationFrame(tick);
      }
    };
    step();
  });
}

/**
 * How much of the run looks like guessing. Catch trials carry no fish, so any
 * tap on one is a false alarm.
 */
export function reliability(result) {
  const catches = result.trials ? Math.floor(result.trials / 8) : 0;
  if (catches < 3) return { trustworthy: true, falseAlarms: result.catchFails ?? 0, catches };
  const rate = (result.catchFails ?? 0) / catches;
  return { trustworthy: rate <= 0.34, falseAlarms: result.catchFails ?? 0, catches, rate };
}

/** Calibration result -> the profile shape the engine and renderer speak. */
export function toEngineProfile(result) {
  if (!result.axis) return { type: "deuteranomaly", severity: 0, calibrated: true };
  const anomalous = { protan: "protanomaly", deutan: "deuteranomaly", tritan: "tritanomaly" };
  const dichromat = { protan: "protanopia", deutan: "deuteranopia", tritan: "tritanopia" };
  const s = result.severity ?? 1;
  return {
    type: s >= 0.999 ? dichromat[result.axis] : anomalous[result.axis],
    severity: s,
    calibrated: true,
    calibrationNote: `${result.axis}, ${result.trials} taps, ${result.gamut}`,
  };
}
