// Headless driver for train.html.
//
// Needs Playwright, which the app itself does not — keep it out of the repo's
// dependencies and point at an existing install:
//   cd /path/with/playwright && TRAIN_URL=http://localhost:8765/train.html \
//     TRAIN_OUT=/path/to/repo/tools/train-result.json node train.mjs
// Serves the repo, opens the trainer, waits for
// the sweep, prints the table and writes the raw result next to it.
import { chromium } from "playwright";
import { writeFileSync } from "fs";

const URL = process.env.TRAIN_URL || "http://localhost:8765/train.html";
const EXE = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const b = await chromium.launch({ executablePath: EXE });
const p = await b.newPage();
p.on("pageerror", (e) => console.error("page error:", e.message));
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => window.__TRAIN_DONE || window.__TRAIN_ERROR, null, { timeout: 900000 });
const err = await p.evaluate(() => window.__TRAIN_ERROR);
if (err) { console.error(err); await b.close(); process.exit(1); }
console.log(await p.textContent("#out"));
const data = await p.evaluate(() => window.__TRAIN);
writeFileSync(process.env.TRAIN_OUT || new URL("./train-result.json", import.meta.url), JSON.stringify(data, null, 2));
await b.close();
