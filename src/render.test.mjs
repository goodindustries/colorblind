// The renderer needs a GPU, so these tests cover what can be checked without
// one: that the generated GLSL is well-formed for every type, and that its
// constants match the engine's exactly (a drift here would silently make the
// GPU disagree with the tested CPU maths).
import { buildFragment } from "./render.js";
import { TYPES, correctionFor, machadoMatrix } from "./engine.js";

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
     code.includes("void main()") && code.includes("vec3 simulate(") &&
     (code.includes("vec3 assistNatural(") || code.includes("uMode == 2")) &&
     balanced && !code.includes("undefined") && !code.includes("NaN"));
}

console.log("\nGPU constants match the CPU engine exactly:");
for (const type of Object.keys(TYPES)) {
  const nat = correctionFor(type, "natural"), max = correctionFor(type, "max");
  if (!nat) continue;
  const src = buildFragment({ type, severity: 1 });
  const has = max.pick.every((v) => src.includes(v.toFixed(6))) &&
              nat.push.every((v) => src.includes(v.toFixed(6))) &&
              max.push.every((v) => src.includes(v.toFixed(6)));
  ok(`${type.padEnd(22)} both corrections baked`, has);
  ok(`${type.padEnd(22)} gamut + hue guard present`,
     src.includes("mapToGamut") && src.includes("guardHue") && src.includes("brighten"));
}
for (const [type, fam] of [["protanomaly","protanomaly"],["deuteranomaly","deuteranomaly"]]) {
  const src = buildFragment({ type, severity: 0.7 });
  const m = machadoMatrix(fam, 0.7);
  ok(`${type.padEnd(22)} severity-0.7 matrix baked`, m.every((v) => src.includes(v.toFixed(6))));
}

console.log("\nMonochromacy honestly declines to recolour:");
for (const type of ["achromatopsia", "blueConeMonochromacy"]) {
  const src = buildFragment({ type, severity: 1 });
  ok(`${type.padEnd(22)} assist is a passthrough`, !src.includes("assistNatural") && src.includes("uMode == 2"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
