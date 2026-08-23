import * as E from "./engine.js";

const clamp = v => v.map(x => Math.max(0, Math.min(1, x)));
const norm  = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const dot   = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

// --- Build a confusion dataset per type, rather than trusting 3 hand-picked pairs.
// A "confusion pair" = clearly different to a normal observer, nearly identical
// after simulation. That is exactly what the correction has to fix.
function confusionSet(type, target = 400) {
  const prof = { type, severity: 1 };
  const cols = [];
  for (let r = 0; r < 8; r++) for (let g = 0; g < 8; g++) for (let b = 0; b < 8; b++) {
    const lin = [r/7, g/7, b/7];
    cols.push({ lin, lab: E.toLab(lin), sim: E.toLab(E.simulate(lin, prof)) });
  }
  const pairs = [];
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++) {
      if (E.deltaE(cols[i].lab, cols[j].lab) < 25) continue;
      if (E.deltaE(cols[i].sim, cols[j].sim) > 8) continue;
      pairs.push([cols[i].lin, cols[j].lin]);
    }
  // even stride so we cover the whole space, not just one corner of it
  const step = Math.max(1, Math.floor(pairs.length / target));
  return pairs.filter((_, i) => i % step === 0).slice(0, target);
}

// --- The lost direction is a property of the model, not something to guess.
// (I - Sim) collapses everything except the confusion axis, so its dominant
// right-singular vector IS that axis. Power-iterate on (I-Sim)^T(I-Sim).
function lostDirection(type) {
  const prof = { type, severity: 1 };
  const basis = [[1,0,0],[0,1,0],[0,0,1]].map(e => {
    const s = E.simulate(e, prof);
    return e.map((v, i) => v - s[i]);           // columns of (I - Sim)
  });
  const A = (v) => {                             // (I-Sim)^T (I-Sim) v
    const Mv = [0,1,2].map(r => basis[0][r]*v[0] + basis[1][r]*v[1] + basis[2][r]*v[2]);
    return [0,1,2].map(c => dot(basis[c], Mv));
  };
  let v = norm([1, -1, 0.1]);
  for (let i = 0; i < 200; i++) v = norm(A(v));
  return v;
}

// --- Score a candidate push direction over the whole confusion set.
function score(type, pick, push, satGain, boost = 1) {
  const prof = { type, severity: 1 };
  const pairs = DATA[type];
  let gains = [], natural = 0;
  const apply = (lin) => {
    const sim = E.simulate(lin, prof);
    const err = lin.map((v, i) => v - sim[i]);
    const d = dot(err, pick);
    const y = E.luma(lin);
    const k = 1 + satGain * boost;
    const out = lin.map((v, i) => {
      const shifted = v + d * push[i] * boost;
      return y + (shifted - y) * k;
    });
    return clamp(out);
  };
  for (const [a, b] of pairs) {
    const ca = apply(a), cb = apply(b);
    const before = E.deltaE(E.toLab(E.simulate(a, prof)), E.toLab(E.simulate(b, prof)));
    const after  = E.deltaE(E.toLab(E.simulate(ca, prof)), E.toLab(E.simulate(cb, prof)));
    gains.push(after / Math.max(before, 0.5));
    natural += (E.deltaE(E.toLab(a), E.toLab(ca)) + E.deltaE(E.toLab(b), E.toLab(cb))) / 2;
  }
  gains.sort((x, y) => x - y);
  return {
    p10: gains[Math.floor(gains.length * 0.1)],   // worst decile: no pair left behind
    median: gains[Math.floor(gains.length / 2)],
    natural: natural / pairs.length,
  };
}

const TYPES = ["protanomaly","deuteranomaly","tritanomaly","protanopia","deuteranopia","tritanopia"];
const DATA = {};
for (const t of TYPES) DATA[t] = confusionSet(t);
console.log("confusion pairs found:", TYPES.map(t => `${t}=${DATA[t].length}`).join("  "));

// --- Search push directions on a spherical grid + saturation gain.
const RESULT = {};
for (const type of TYPES) {
  const pick = lostDirection(type);
  let best = null;
  for (let th = 0; th < 180; th += 6) for (let ph = 0; ph < 360; ph += 6) {
    const t = th * Math.PI / 180, p = ph * Math.PI / 180;
    const dir = [Math.sin(t)*Math.cos(p), Math.sin(t)*Math.sin(p), Math.cos(t)];
    for (const mag of [1.0, 1.5, 2.0, 2.5]) {
      for (const sat of [0, 0.25, 0.5]) {
        const push = dir.map(x => x * mag);
        const s = score(type, pick, push, sat);
        if (s.natural > 45) continue;             // keep it recognisable as the scene
        const obj = s.p10 * 2 + s.median;         // weight the worst decile hardest
        if (!best || obj > best.obj) best = { obj, push, sat, ...s };
      }
    }
  }
  RESULT[type] = { pick, ...best };
  console.log(`\n${type}`);
  console.log(`  pick  [${pick.map(v=>v.toFixed(4)).join(", ")}]`);
  console.log(`  push  [${best.push.map(v=>v.toFixed(4)).join(", ")}]  sat ${best.sat}`);
  console.log(`  gain  worst-decile x${best.p10.toFixed(2)}  median x${best.median.toFixed(2)}  naturalness dE ${best.natural.toFixed(1)}`);
}

console.log("\n--- monotonicity of the boost slider with these constants ---");
for (const type of TYPES) {
  const r = RESULT[type];
  const seq = [];
  for (let b = 0; b <= 1.001; b += 0.25) seq.push(score(type, r.pick, r.push, r.sat, b).median);
  const mono = seq.every((v, i) => i === 0 || v >= seq[i-1] - 0.02);
  console.log(`  ${type.padEnd(15)} ${seq.map(v=>"x"+v.toFixed(2)).join(" -> ")}  ${mono ? "MONOTONIC" : "NOT MONOTONIC"}`);
}

console.log("\n--- copy into engine.js ---");
console.log(JSON.stringify(Object.fromEntries(TYPES.map(t => [t, {
  pick: RESULT[t].pick.map(v => +v.toFixed(4)),
  push: RESULT[t].push.map(v => +v.toFixed(4)),
  sat: RESULT[t].sat,
}])), null, 2));
