// The renderer needs a GPU, so these tests cover what can be checked without
// one: that the generated GLSL is well-formed for every type, and that its
// constants match the engine's exactly (a drift here would silently make the
// GPU disagree with the tested CPU maths).
import { buildFragment } from "./render.js";
import { TYPES, machadoMatrix } from "./engine.js";
import { lostAxis, SURVIVING_AXIS, DEFAULTS } from "./correct.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log("  PASS  " + n))
                               : (fail++, console.log("  FAIL  " + n + (d ? "  <- " + d : "")));

console.log("GLSL generates and is structurally sound for every type:");
for (const type of Object.keys(TYPES)) {
  const src = buildFragment({ type, severity: 0.8 });
  // Strip comments first: the prose legitimately contains words like
  // "undefined", and only interpolated values matter for this check.
  const code = src.replace(/\/\/[^\n]*/g, "");
  const balanced = (code.match(/{/g) || []).length === (code.match(/}/g) || []).length;
  ok(`${type.padEnd(22)} well-formed`,
     code.includes("void main()") && code.includes("simulateEye") &&
     balanced && !code.includes("undefined") && !code.includes("NaN"));
}

console.log("\nGPU constants come from correct.js, not a second copy:");
for (const type of Object.keys(TYPES)) {
  const axis = { protanomaly:"protan", protanopia:"protan", deuteranomaly:"deutan",
                 deuteranopia:"deutan", tritanomaly:"tritan", tritanopia:"tritan" }[type];
  if (!axis) continue;
  const src = buildFragment({ type, severity: 1 });
  const want = lostAxis({ axis, severity: 1 });
  ok(`${type.padEnd(22)} lost axis baked`, want.every((v) => src.includes(v.toFixed(6))));
  ok(`${type.padEnd(22)} surviving axis baked`,
     SURVIVING_AXIS[axis].every((v) => src.includes(v.toFixed(6))));
  ok(`${type.padEnd(22)} all four modes`,
     ["vec3 natural(", "vec3 achromatic(", "vec3 split(", "vec3 pulse("].every((m) => src.includes(m)));
}

console.log("\nPulse safety is baked in, not left to the caller:");
{
  const src = buildFragment({ type: "deuteranomaly", severity: 0.9 });
  const hz = parseFloat(src.match(/PI \* ([0-9.]+) \* uTime/)[1]);
  ok(`pulse rate ${hz}Hz is at or below 1.5`, hz <= 1.5);
  ok("pulse is far below the 3-30Hz photosensitive band", hz < 3);
  // Luminance is pinned to natural's before crossfading, so the screen cannot
  // strobe — only chroma moves. What matters is that the pulse TARGET is
  // forced to natural's luminance (dot(a, LUMA)) before the mix, however that
  // target is spelled — split() was inlined into pulse() to share one errOf
  // call, so this checks the property rather than one spelling of it.
  ok("pulse crossfades at constant luminance", /withLuma\([^;]*,\s*dot\(a, LUMA\)\)/.test(src));
  ok("pulse is gated to pixels carrying lost information", src.includes("gate"));
  ok("pulse hue cap present", src.includes(DEFAULTS.pulseHueCapDeg.toFixed(1)));
  ok("natural hue cap present", src.includes(DEFAULTS.hueCapDeg.toFixed(1)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
