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
  const balanced = (src.match(/{/g) || []).length === (src.match(/}/g) || []).length;
  ok(`${type.padEnd(22)} compiles-shaped`,
     src.includes("void main()") && src.includes("vec3 simulate(") &&
     src.includes("vec3 assistNatural(") && src.includes("vec3 assistMax(") && balanced && !src.includes("undefined") && !src.includes("NaN"));
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
}
for (const [type, fam] of [["protanomaly","protanomaly"],["deuteranomaly","deuteranomaly"]]) {
  const src = buildFragment({ type, severity: 0.7 });
  const m = machadoMatrix(fam, 0.7);
  ok(`${type.padEnd(22)} severity-0.7 matrix baked`, m.every((v) => src.includes(v.toFixed(6))));
}

console.log("\nMonochromacy honestly declines to recolour:");
for (const type of ["achromatopsia", "blueConeMonochromacy"]) {
  const src = buildFragment({ type, severity: 1 });
  ok(`${type.padEnd(22)} assist is a passthrough`, /assistNatural\(vec3 lin\)\{ return lin; \}/.test(src.replace(/\s+/g, " ")));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
