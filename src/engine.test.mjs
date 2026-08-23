import * as E from "./engine.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  <- " + detail : "")); }
};
const H = (s) => console.log("\n" + s);

const P = (type, severity = 1) => ({ type, severity });
const ALL = Object.keys(E.TYPES).filter((t) => t !== "normal");
const DICHROMATS = ["protanopia", "deuteranopia", "tritanopia"];

// ---------------------------------------------------------------------------
H("1. Achromatic axis is invariant  (greys must survive every simulation)");
// Any correct CVD model leaves the neutral axis untouched: a grey stimulates
// all cone classes proportionally, so losing one cannot change it. This is the
// single sharpest check on the Brettel constants.
for (const type of ALL) {
  let worst = 0;
  for (const g of [0.05, 0.2, 0.5, 0.8, 1.0]) {
    const grey = [g, g, g];
    const s = E.simulate(grey, P(type));
    worst = Math.max(worst, Math.max(...s.map((v, i) => Math.abs(v - grey[i]))));
  }
  ok(`${type.padEnd(22)} grey preserved`, worst < 0.01, `max drift ${worst.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
H("2. Dichromat simulation is idempotent  (sim(sim(c)) == sim(c))");
// A dichromat's gamut is a surface. Projecting onto it twice must be the same
// as projecting once. Wrong half-plane normals break this immediately.
for (const type of DICHROMATS) {
  let worst = 0;
  for (const c of [[1,0,0],[0,1,0],[0,0,1],[0.8,0.3,0.1],[0.2,0.7,0.4],[0.5,0.2,0.9],[0.9,0.9,0.1]]) {
    const once = E.simulate(c, P(type));
    const twice = E.simulate(once, P(type));
    worst = Math.max(worst, Math.max(...once.map((v, i) => Math.abs(v - twice[i]))));
  }
  ok(`${type.padEnd(22)} idempotent`, worst < 0.02, `max drift ${worst.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
H("3. Cross-validation: Machado@1.0 vs Brettel  (two independent models)");
// Machado's model is derived from cone spectral shifts; Brettel's from LMS
// half-plane geometry. They share no constants. If both are implemented
// correctly they must agree closely for protan/deutan. This is the strongest
// evidence available offline that neither table was mistranscribed.
// Compared over the whole RGB cube, clamped to gamut first: out-of-gamut
// values are never displayed, and Vienot-style models blow up outside it.
const clamp = (v) => v.map((x) => Math.max(0, Math.min(1, x)));
const AGREEMENT = { protanopia: 6, deuteranopia: 6, tritanopia: 20 };
for (const [dich, fam] of [["protanopia","protanomaly"],["deuteranopia","deuteranomaly"],["tritanopia","tritanomaly"]]) {
  const m = E.machadoMatrix(fam, 1.0);
  let sum = 0, n = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    const c = [r/5, g/5, b/5];
    sum += E.deltaE(E.toLab(clamp(E.mul3(m, c))), E.toLab(clamp(E.brettel(c, dich)))); n++;
  }
  const mean = sum / n;
  ok(`${dich.padEnd(22)} models agree`, mean < AGREEMENT[dich],
     `mean deltaE ${mean.toFixed(2)} over 216 colours (bound ${AGREEMENT[dich]})`);
}
// The tritan gap is the finding, not a nuisance: it is why tritanomaly uses
// severity-scaled Brettel rather than Machado's table.

// ---------------------------------------------------------------------------
H("4. Confusion pairs actually collapse under simulation");
// If the model is right, colours a real person confuses must land close
// together after simulation, while staying far apart for a normal observer.
const CONFUSIONS = {
  "red-green": [[[200,40,40],[40,150,40]], [[190,30,30],[140,90,40]], [[190,60,50],[120,150,60]]],
  "blue-yellow": [[[40,90,200],[40,150,150]], [[150,120,200],[130,140,150]]],
};
for (const type of ALL) {
  const axis = E.TYPES[type].axis;
  if (!axis) continue; // monochrome: no axis to confuse along
  let collapsed = true, worstRatio = 0;
  for (const [a, b] of CONFUSIONS[axis]) {
    const la = E.from255(a), lb = E.from255(b);
    const normal = E.deltaE(E.toLab(la), E.toLab(lb));
    const seen = E.deltaE(E.toLab(E.simulate(la, P(type))), E.toLab(E.simulate(lb, P(type))));
    const ratio = seen / normal;
    worstRatio = Math.max(worstRatio, ratio);
    if (ratio > 0.7) collapsed = false;
  }
  ok(`${type.padEnd(22)} ${axis} pairs collapse`, collapsed,
     `worst retained ${(worstRatio * 100).toFixed(0)}% of normal separation`);
}

// ---------------------------------------------------------------------------
H("5. Correction increases separation, and never makes a pair worse");
// Confusion pairs are generated, not hand-picked: clearly different to a normal
// observer (dE > 25), nearly identical after simulation (dE < 8). That is the
// exact population the correction exists to fix, so it cannot be cherry-picked.
function confusionSet(type, target = 250) {
  const prof = P(type);
  const cols = [];
  for (let r = 0; r < 8; r++) for (let g = 0; g < 8; g++) for (let b = 0; b < 8; b++) {
    const lin = [r/7, g/7, b/7];
    cols.push({ lin, lab: E.toLab(lin), sim: E.toLab(E.simulate(lin, prof)) });
  }
  const out = [];
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    if (E.deltaE(cols[i].lab, cols[j].lab) < 25) continue;
    if (E.deltaE(cols[i].sim, cols[j].sim) > 8) continue;
    out.push([cols[i].lin, cols[j].lin]);
  }
  const step = Math.max(1, Math.floor(out.length / target));
  return out.filter((_, i) => i % step === 0).slice(0, target);
}

const gainsFor = (type, boost) => {
  const prof = P(type), g = [];
  for (const [a, b] of confusionSet(type)) {
    const before = E.deltaE(E.toLab(E.asSeen(a, prof)), E.toLab(E.asSeen(b, prof)));
    const after  = E.deltaE(E.toLab(E.asSeen(a, prof, boost)), E.toLab(E.asSeen(b, prof, boost)));
    g.push(after / Math.max(before, 0.5));
  }
  return g.sort((x, y) => x - y);
};

console.log("     type              pairs   worst    p10   median     best");
for (const type of ALL) {
  if (!E.TYPES[type].axis) { console.log(`     ${type.padEnd(22)} monochrome — recolouring cannot help, see SCIENCE.md`); continue; }
  const g = gainsFor(type, 1.0);
  const p = (q) => g[Math.floor(g.length * q)];
  console.log(`     ${type.padEnd(17)} ${String(g.length).padStart(5)}  x${g[0].toFixed(2)}  x${p(0.1).toFixed(2)}  x${p(0.5).toFixed(2)}  x${g[g.length-1].toFixed(2)}`);
  const regressed = g.filter((x) => x < 0.95).length / g.length;
  ok(`${type.padEnd(22)} worst decile improves`, p(0.1) > 2.0, `x${p(0.1).toFixed(2)}`);
  // A small tail of near-gamut-edge pairs still loses to clipping. Bounded and
  // reported rather than hidden; Display P3 is the fix (see SCIENCE.md).
  ok(`${type.padEnd(22)} regressions bounded`, regressed < 0.05,
     `${(regressed * 100).toFixed(1)}% of pairs regressed, worst x${g[0].toFixed(2)}`);
}

// ---------------------------------------------------------------------------
H("6. Severity is monotonic  (a worse deficiency loses more information)");
const AXIS_PAIR = { "red-green": [[200,40,40],[40,150,40]], "blue-yellow": [[40,90,200],[40,150,150]] };
for (const fam of ["protanomaly", "deuteranomaly", "tritanomaly"]) {
  const [a, b] = AXIS_PAIR[E.TYPES[fam].axis];
  const la = E.from255(a), lb = E.from255(b);
  // Chroma only (a*,b*), deliberately excluding L*. Protanopes lose luminous
  // efficiency in the red, so a red/green pair grows FURTHER apart in lightness
  // as protan severity rises even while colour discrimination collapses. That
  // is a real effect, not a modelling error — measuring total dE would hide the
  // discrimination loss behind it.
  const chroma = (x, y2) => Math.hypot(x[1] - y2[1], x[2] - y2[2]);
  let prev = Infinity, mono = true;
  for (let sv = 0; sv <= 1.0001; sv += 0.1) {
    const d = chroma(E.toLab(E.simulate(la, P(fam, sv))), E.toLab(E.simulate(lb, P(fam, sv))));
    // Tolerance 3.0, not picked by eye: section 3 measured Machado and Brettel
    // — two independently derived models — disagreeing by mean dE 4.19 for
    // protan. Machado's protanomaly table wiggles 1.67 dE at its final step
    // (0.9 -> 1.0, where the anomalous model hands off to dichromacy). Asserting
    // tighter than the models agree with each other would be measuring noise.
    if (d > prev + 3.0) mono = false;
    prev = d;
  }
  ok(`${fam.padEnd(22)} monotonic in severity`, mono);
}

// ---------------------------------------------------------------------------
H("7. The boost slider is monotonic  (one control, always 'more help')");
// The previous design crossfaded two algorithms that pushed in different
// directions, so separation DIPPED mid-slider. One formula fixes that.
for (const type of ALL) {
  if (!E.TYPES[type].axis) continue;
  const seq = [], med = (g) => g[Math.floor(g.length / 2)];
  for (const boost of [0, 0.25, 0.5, 0.75, 1.0]) seq.push(med(gainsFor(type, boost)));
  const mono = seq.every((v, i) => i === 0 || v >= seq[i-1] - 0.05);
  ok(`${type.padEnd(22)} boost monotonic`, mono, seq.map(v => "x" + v.toFixed(1)).join(" -> "));
}

// ---------------------------------------------------------------------------
H("7b. NATURAL mode keeps colours recognisable  (the bug Z found)");
// The first version of this correction had no hue term. It turned orange into
// pink-purple — a 67 degree shift — which looks wrong and teaches a child the
// wrong name for a colour. Hue is now a tested property, not an afterthought.
const EVERYDAY = [
  ["orange", [242,132,25]], ["red", [214,40,40]], ["green", [60,150,60]],
  ["yellow", [242,220,40]], ["blue", [40,100,210]], ["brown", [140,90,40]],
  ["pink", [240,150,170]], ["skin", [235,180,150]], ["grass", [70,140,55]],
];
const hueOf = (lab) => (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
const hueShift = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)); return d > 180 ? 360 - d : d; };
const clampLin = (v) => v.map((x) => Math.max(0, Math.min(1, x)));

console.log("     type              style     mean hue shift   worst");
for (const type of ALL) {
  if (!E.TYPES[type].axis) continue;
  const prof = P(type, 0.9);
  const stats = (style) => {
    let sum = 0, worst = 0, which = "";
    for (const [name, rgb] of EVERYDAY) {
      const lin = E.from255(rgb);
      const d = hueShift(E.toLab(lin), E.toLab(clampLin(E.assist(lin, prof, 0.6, style))));
      sum += d; if (d > worst) { worst = d; which = name; }
    }
    return { mean: sum / EVERYDAY.length, worst, which };
  };
  const nat = stats("natural"), max = stats("max");
  console.log(`     ${type.padEnd(17)} natural   ${nat.mean.toFixed(0).padStart(9)}deg   ${nat.worst.toFixed(0)}deg (${nat.which})`);
  console.log(`     ${type.padEnd(17)} max       ${max.mean.toFixed(0).padStart(9)}deg   ${max.worst.toFixed(0)}deg (${max.which})`);
  ok(`${type.padEnd(22)} natural keeps hue`, nat.mean < 14 && nat.worst < 30,
     `mean ${nat.mean.toFixed(0)}deg worst ${nat.worst.toFixed(0)}deg`);
  ok(`${type.padEnd(22)} natural beats max on hue`, nat.mean <= max.mean,
     `${nat.mean.toFixed(0)}deg vs ${max.mean.toFixed(0)}deg`);
}

// Orange is the specific case Z reported. Pin it.
{
  const prof = P("deuteranomaly", 0.9);
  const orange = E.from255([242, 132, 25]);
  const shift = hueShift(E.toLab(orange), E.toLab(clampLin(E.assist(orange, prof, 0.6, "natural"))));
  ok("orange stays orange in Z's mode", shift < 20, `${shift.toFixed(0)}deg shift`);
}

// ---------------------------------------------------------------------------
H("7c. Every mode clears the baseline, and brightness never touches hue");
// Brightness encodes the lost signal purely as lighter/darker, so its hue
// error is zero BY CONSTRUCTION, not by tuning. It trades separation for never
// telling the user a colour is something it is not.
for (const type of ALL) {
  if (!E.TYPES[type].axis) continue;
  const prof = P(type, 0.9);
  let worst = 0;
  for (const [, rgb] of EVERYDAY) {
    const lin = E.from255(rgb);
    worst = Math.max(worst, hueShift(E.toLab(lin), E.toLab(E.brighten(lin, prof, 0.6))));
  }
  ok(`${type.padEnd(22)} brightness hue is exactly 0`, worst < 0.5, `${worst.toFixed(2)}deg`);
}
for (const type of ALL) {
  if (!E.TYPES[type].axis) continue;
  const prof = P(type, 0.9);
  let bad = 0;
  for (const [, rgb] of EVERYDAY) {
    const out = E.brighten(E.from255(rgb), prof, 1);
    if (out.some((v) => v < -1e-9 || v > 1 + 1e-9)) bad++;
  }
  ok(`${type.padEnd(22)} brightness stays in gamut`, bad === 0);
}
for (const type of ["deuteranomaly", "protanopia", "tritanopia"]) {
  const med = (style) => {
    const g = [];
    for (const [a, b] of confusionSet(type)) {
      const prof = P(type);
      const before = E.deltaE(E.toLab(E.asSeen(a, prof)), E.toLab(E.asSeen(b, prof)));
      const after = E.deltaE(E.toLab(E.asSeen(a, prof, 1, style)), E.toLab(E.asSeen(b, prof, 1, style)));
      g.push(after / Math.max(before, 0.5));
    }
    g.sort((x, y) => x - y);
    return g[Math.floor(g.length / 2)];
  };
  const n = med("natural"), m = med("max"), b = med("bright");
  // Once gamut mapping stopped clipping (and so stopped rotating hue), max lost
  // its across-the-board edge: it now beats natural on only half the types,
  // for 3-9x the hue error. Both must clear the baseline; neither always wins.
  ok(`${type.padEnd(22)} all three modes help`, n > 2.5 && m > 2.5 && b > 1.5,
     `natural x${n.toFixed(1)}  max x${m.toFixed(1)}  bright x${b.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
H("7d. Gamut and hue bounds hold on colours nothing was tuned against");
// Per-channel clipping is what rotated orange into purple: red pinned at 1.0
// while blue kept climbing. Scaling chroma toward luminance cannot do that.
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const WILD = Array.from({ length: 400 }, () => [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0]);
  for (const type of ["deuteranomaly", "protanopia", "tritanopia"]) {
    const prof = P(type, 0.9);
    const chroma = (l) => Math.hypot(l[1], l[2]);
    let worstHue = 0, outOfGamut = 0, greyed = 0, worstKeep = 1, n = 0;
    for (const rgb of WILD) {
      const lin = E.from255(rgb);
      const out = E.assist(lin, prof, 1, "natural");
      if (out.some((v) => v < -1e-6 || v > 1 + 1e-6)) outOfGamut++;
      const ci = chroma(E.toLab(lin)), co = chroma(E.toLab(out));
      if (ci < 8) continue;              // hue is undefined near the neutral axis
      n++;
      if (co < 4) greyed++; else {
        worstHue = Math.max(worstHue, hueShift(E.toLab(lin), E.toLab(out)));
        worstKeep = Math.min(worstKeep, co / ci);
      }
    }
    ok(`${type.padEnd(22)} 400 unseen colours in gamut`, outOfGamut === 0, `${outOfGamut} escaped`);
    ok(`${type.padEnd(22)} hue bound holds unseen`, worstHue <= E.HUE_CAP_DEG + 0.5,
       `worst ${worstHue.toFixed(1)}deg over ${n} chromatic colours, cap ${E.HUE_CAP_DEG}`);
    ok(`${type.padEnd(22)} no colour turns grey`, greyed === 0, `${greyed}/${n} greyed`);
    ok(`${type.padEnd(22)} chroma floor respected`, worstKeep >= E.CHROMA_FLOOR - 0.05,
       `worst kept ${(worstKeep * 100).toFixed(0)}%`);
  }
}

// ---------------------------------------------------------------------------
H("8. Rayleigh calibration maps to the right type and severity");
ok("normal match -> normal range", E.severityFromRayleigh(0.5).severity < 0.15);
ok("red-heavy match -> protan", E.severityFromRayleigh(0.9).type === "protanomaly");
ok("green-heavy match -> deutan", E.severityFromRayleigh(0.1).type === "deuteranomaly");
ok("extreme match -> strong", E.severityFromRayleigh(1.0).confidence === "strong");

// ---------------------------------------------------------------------------
H("9. Shader constants generate for every type");
for (const type of Object.keys(E.TYPES)) {
  let okc = true;
  try { E.buildShaderConstants(P(type)); } catch { okc = false; }
  ok(`${type.padEnd(22)} shader constants`, okc);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
