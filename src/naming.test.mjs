import { nameColor, averagePatch, makeSmoother, toHex } from "./naming.js";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log("  PASS  " + n))
                               : (fail++, console.log("  FAIL  " + n + (d ? "  <- " + d : "")));
const is = (rgb, want) => {
  const got = nameColor(...rgb);
  ok(`${JSON.stringify(rgb).padEnd(18)} -> ${want}`, got === want, `got "${got}"`);
};

console.log("Categories that collapse under red-green deficiency:");
is([139, 69, 19], "brown");
is([128, 0, 0], "maroon");
is([210, 180, 140], "tan");
is([128, 128, 0], "olive");
is([255, 192, 203], "pink");
is([0, 0, 128], "navy");

console.log("\nBasics:");
is([255, 0, 0], "vivid red");
is([0, 255, 0], "vivid green");
is([0, 0, 255], "vivid blue");
is([75, 0, 130], "dark purple");
is([160, 60, 200], "purple");
is([0, 0, 0], "black");
is([255, 255, 255], "white");
is([128, 128, 128], "grey");

console.log("\nThe pair this whole app exists for:");
const wireRed = nameColor(190, 30, 30), wireBrown = nameColor(140, 90, 40);
ok(`red wire "${wireRed}" != brown wire "${wireBrown}"`, wireRed !== wireBrown);

console.log("\nHelpers:");
ok("patch average", JSON.stringify(averagePatch(new Uint8Array([10,20,30,255, 30,40,50,255]))) === "[20,30,40]");
ok("hex", toHex(255, 128, 0) === "#ff8000");
const sm = makeSmoother(0.5);
sm([0, 0, 0]);
ok("smoother converges", sm([100, 100, 100])[0] === 50);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
