import * as K from "./calibrate.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// Simulated observer: true thresholds per vector; psychometric function is a
// Weibull in log-level with 4% lapse and 0 guess (tap must land on the fish).
function observer(trueTh, slope = 3.5, lapse = 0.04) {
  return trial => {
    if (trial.catch) return null;
    const p = (1 - lapse) * (1 - Math.exp(-Math.pow(trial.level / trueTh[trial.vector], slope)));
    if (Math.random() < p) { const f = trial.fish; return { x: f.x + f.w * 0.42, y: f.y + f.h * 0.5 }; }
    // miss: tap somewhere that is not the fish
    for (;;) { const x = Math.random(), y = Math.random(); if (!K.tapHits(trial, x, y)) return { x, y }; }
  };
}
function run(trueTh) {
  const s = new K.Session(); const obs = observer(trueTh);
  for (let t; (t = s.next());) s.respond(obs(t));
  return s.result();
}

// geometry sanity
ok(K.tapHits({ fish: { x: 0.2, y: 0.2, w: 0.4, h: 0.4, flip: false } }, 0.37, 0.4), "centre of fish hits");
ok(!K.tapHits({ fish: { x: 0.2, y: 0.2, w: 0.4, h: 0.4, flip: false } }, 0.05, 0.05), "outside misses");
const tr = K.makeTrial("deutan", 600);
ok(tr.dots.length === 576, "dot count");
ok(tr.dots.some(d => d.inFish) && tr.dots.some(d => !d.inFish), "fish and background dots present");
ok(tr.dots.every(d => d.lin.every(v => v >= -1e-9 && v <= 1 + 1e-9)), "dots in gamut");
ok(K.maxLevel("deutan") < 700 && K.maxLevel("protan") > 1000, "per-vector gamut reach");

// displaced points move along the line
const a = K.displaced("protan", 500), b = K.displaced("protan", 1000);
ok(Math.abs(Math.hypot(b.u - K.BACKGROUND.u, b.v - K.BACKGROUND.v) - 0.1) < 1e-9, "1000 = 0.1 u'v'");
ok(Math.abs((b.u - a.u) / (a.u - K.BACKGROUND.u) - 1) < 1e-9, "collinear");

// recovery across simulated observers
const cases = [
  { name: "normal",        th: { protan: 60,  deutan: 60,  tritan: 70 },  axis: null },
  { name: "mild deutan",   th: { protan: 200, deutan: 350, tritan: 70 },  axis: "deutan" },
  { name: "strong deutan", th: { protan: 500, deutan: 900, tritan: 80 },  axis: "deutan" },
  { name: "protanope",     th: { protan: 1100,deutan: 700, tritan: 80 },  axis: "protan" },
  { name: "tritan",        th: { protan: 70,  deutan: 70,  tritan: 500 }, axis: "tritan" },
];
for (const c of cases) {
  let typeOk = 0, errSum = 0, N = 60, trials = 0;
  for (let i = 0; i < N; i++) {
    const r = run(c.th);
    if (r.axis === c.axis) typeOk++;
    trials += r.trials;
    for (const v of K.VECTORS) errSum += Math.abs(Math.log(r.thresholds[v] / Math.min(c.th[v], r.ceilings[v])));
  }
  const typeRate = typeOk / N, logErr = errSum / (N * 3);
  console.log(`${c.name.padEnd(14)} type ${Math.round(typeRate*100)}%  mean |log err| ${logErr.toFixed(2)}  ~${Math.round(trials/N)} trials`);
  ok(typeRate >= 0.9, `${c.name} type recovery ${typeRate}`);
  ok(logErr < 0.35, `${c.name} threshold error ${logErr}`);
}
// catch trials are counted and never feed a staircase
{
  const s = new K.Session(); let catches = 0;
  for (let t; (t = s.next());) { if (t.catch) { catches++; s.respond({ x: 0.5, y: 0.5 }); } else s.respond(null); }
  ok(catches > 0 && s.catchFails === catches, "catch trials tracked");
}

// --- reward palette -------------------------------------------------------
// Every scale must be distinguishable from every other THROUGH THAT OBSERVER'S
// EYES, otherwise the reward quietly contradicts the app.
console.log("\nreward palette");
for (const prof of [
  { name: "normal",        axis: null,     severity: 0 },
  { name: "mild deutan",   axis: "deutan", severity: 0.5 },
  { name: "strong deutan", axis: "deutan", severity: 0.9 },
  { name: "deuteranope",   axis: "deutan", severity: 1 },
  { name: "protanope",     axis: "protan", severity: 1 },
  { name: "tritanope",     axis: "tritan", severity: 1 },
]) {
  const r = K.rewardPalette(prof, 12, 15);
  console.log(`  ${prof.name.padEnd(15)} ${String(r.colours.length).padStart(2)} scales, closest pair dE ${r.minDeltaE === Infinity ? "n/a" : r.minDeltaE.toFixed(1)}`);
  ok(r.colours.length >= 6, `${prof.name}: only ${r.colours.length} scales`);
  ok(r.minDeltaE >= 15 - 1e-6, `${prof.name}: closest pair dE ${r.minDeltaE.toFixed(1)} < 15`);
  ok(r.colours.every(c => c.every(v => v >= 0 && v <= 1)), `${prof.name}: scale out of gamut`);
}
// A dichromat must get FEWER usable scales than a normal observer — if not,
// the search is not actually measuring through their eyes.
ok(K.rewardPalette({ axis: "deutan", severity: 1 }, 12, 15).colours.length <=
   K.rewardPalette({ axis: null, severity: 0 }, 12, 15).colours.length,
   "dichromat palette is not larger than normal");


// --- end to end: honest observer -> profile the engine can use -------------
// The browser run proves the DOM loop and the guess detector. This proves the
// other half: a careful observer's taps become the right engine profile.
import { toEngineProfile, reliability } from "./calibrate.ui.js";

console.log("\nend to end");
function honest(trueTh) {
  const obs = observer(trueTh);
  const s = new K.Session();
  let t;
  while ((t = s.next())) {
    // A careful observer does not tap when there is no fish.
    s.respond(t.catch ? null : obs(t));
  }
  return s.result();
}
// The AXIS is what the instrument reliably recovers. Severity saturates once
// a threshold exceeds the display's reach along that confusion line, so a very
// strong observer reads as "at or near the ceiling" rather than a precise
// number — see the gamut table below. Assert what the instrument can actually
// deliver, not what we would like it to.
for (const [name, th, wantAxis, minSev] of [
  ["normal",        { protan: 60,   deutan: 60,  tritan: 70 }, null,     0],
  ["mild deutan",   { protan: 200,  deutan: 350, tritan: 70 }, "deutan", 0.3],
  ["strong deutan", { protan: 500,  deutan: 900, tritan: 80 }, "deutan", 0.85],
  ["protanope",     { protan: 1100, deutan: 700, tritan: 80 }, "protan", 0.85],
]) {
  const r = honest(th);
  const trust = reliability(r);
  const prof = toEngineProfile(r);
  console.log(`  ${name.padEnd(15)} -> ${prof.type.padEnd(15)} sev ${prof.severity.toFixed(2)}  false alarms ${trust.falseAlarms}/${trust.catches}`);
  ok(trust.trustworthy, `${name}: honest run flagged as guessing`);
  ok(trust.falseAlarms === 0, `${name}: ${trust.falseAlarms} false alarms from a careful observer`);
  ok(r.axis === wantAxis, `${name}: axis ${r.axis}, wanted ${wantAxis}`);
  ok(prof.severity >= minSev, `${name}: severity ${prof.severity.toFixed(2)} below ${minSev}`);
  ok(prof.calibrated === true, `${name}: not marked calibrated`);
}

// What the display's reach costs. sRGB runs out along the deutan line first,
// which is precisely where the strongest resolution is wanted.
console.log("\ngamut reach along each confusion line (x1e-4 u'v', ceiling 1100)");
for (const g of ["srgb", "display-p3"]) {
  const m = K.setGamut(g);
  console.log(`  ${g.padEnd(11)} protan ${m.protan}  deutan ${m.deutan}  tritan ${m.tritan}`);
}
K.setGamut("display-p3");
ok(K.maxLevels().deutan > 800, "P3 extends the deutan line past 800");
ok(K.maxLevels().deutan > 642, "P3 beats the sRGB deutan reach of 642");
K.setGamut("srgb");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);