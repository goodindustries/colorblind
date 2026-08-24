/**
 * App shell. Implements the Claude Design "Colorblind Camera" spec against the
 * tested engine in ./engine.js.
 *
 * Divergences from the design file, all deliberate:
 *  - The design wraps the app in a mock iPhone bezel with a caption above it.
 *    That is mockup presentation; the real app is the *contents* of that
 *    frame, full-bleed.
 *  - The design corrects with an SVG feColorMatrix. That cannot express
 *    Brettel's two-half-plane projection (it branches per pixel) and cannot
 *    reach Display P3, so rendering goes through WebGL instead. The visual
 *    result, gestures, and layout are unchanged.
 *  - Added a VISION picker. The design predates all-eight-type support and
 *    hardcodes deutan; without it the other seven are unreachable.
 *  - STRENGTH is 0..1, not the design's 0..1.6. Our boost parameter is defined
 *    and verified monotonic on 0..1 (engine.test.mjs §7).
 */

import { TYPES, simulate, assist, linearToSrgb, srgbToLinear } from "./engine.js";
import { createRenderer, openCamera, MODE } from "./render.js";
import { nameColor, averagePatch, makeSmoother } from "./naming.js";
import * as Profiles from "./profiles.js";
import { quantiseFrame, optimiseForPalette, makeSmoother as makeFitSmoother,
         DEFAULT_PARAMS } from "./adapt.js";
import { runSession, drawReward, makeContext, toEngineProfile, reliability } from "./calibrate.ui.js";
import { displayPolicy } from "./profiles.js";

const $ = (id) => document.getElementById(id);

const ACC = ["#f5a623", "#2f9bf0", "#ffffff"];
const BG = ["#f5a623", "#2f9bf0", "#f2e327", "#1b2a6b", "#d2b48c", "#22c8d8"];

// Three modes, named by whose eyes they belong to.
//
//   world  — the picture altered so THIS person's eyes land as close to
//            everyone else's as a screen can manage. The default.
//   Z      — what their eyes actually receive, for showing other people.
//   camera — the untouched sensor feed.
//
// The engine also carries a zero-hue-error brightness mode and a false-colour
// mode; both are tested and reachable, just not on screen. Three chips is the
// whole interface on purpose.
const MODES = [
  { key: MODE.NATURAL,  icon: "world",
    name: () => "The world's colours",
    sub:  "Changed so your eyes see them closer to how everyone else does." },
  { key: MODE.SIMULATE, icon: "who",
    name: (n) => `How ${n} sees it`,
    sub:  "What their eyes actually receive. Show this to other people." },
  { key: MODE.NORMAL,   icon: "camera",
    name: () => "Camera",
    sub:  "The picture untouched." },
];

const S = { mode: 0, zoom: 1, sheet: false, rgb: [128, 128, 128], cam: false, compare: false };
let state = Profiles.load();
let me = Profiles.active(state);

const gl = $("gl"), vid = $("vid"), sampler = $("sampler");
const sctx = sampler.getContext("2d", { willReadFrequently: true });
const smooth = makeSmoother(0.4);
let renderer = null;

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function exposure() {
  const policy = displayPolicy(me);
  // Auto-exposure already handles the picture; the only reason to touch
  // brightness here is the photophobic profiles, where bright screens hurt.
  // Photophobic profiles dim rather than brighten — bright screens genuinely
  // hurt in achromatopsia and blue cone monochromacy. SCIENCE.md §2.
  return policy.brightness === "reduce" ? 0.55 : 1;
}

function applyProfile() {
  renderer.setProfile(me);
  renderer.setBoost(me.boost);
  renderer.setExposure(exposure());
  renderer.setMode(MODES[S.mode].key);
}

// ---------------------------------------------------------------------------
// Per-frame fit
//
// Two fixed corrections failed the same way: tuned for one kind of colour pair,
// they damaged another. A fixed map from three dimensions into two has to
// sacrifice something, and constants chosen in advance cannot know what the
// camera is pointed at. So the correction is refitted to what is actually on
// screen, a couple of times a second, and eased between fits.
// ---------------------------------------------------------------------------
const FIT_HZ = 1.5;
const smoothFit = makeFitSmoother(300, DEFAULT_PARAMS);
let lastFit = 0, fitTarget = { ...DEFAULT_PARAMS }, fitCost = 0;

function refit(now) {
  const src = S.cam ? vid : null;
  if (!src || !src.videoWidth) return;
  const t0 = performance.now();
  const N = 48;
  sampler.width = N; sampler.height = N;
  try { sctx.drawImage(src, 0, 0, N, N); } catch { return; }
  let d;
  try { d = sctx.getImageData(0, 0, N, N).data; } catch { return; }
  const samples = [];
  for (let i = 0; i < d.length; i += 4)
    samples.push([d[i], d[i + 1], d[i + 2]].map((v) => srgbToLinear(v / 255)));
  const palette = quantiseFrame(samples, 32);
  const axis = { protanomaly: "protan", protanopia: "protan", deuteranomaly: "deutan",
                 deuteranopia: "deutan", tritanomaly: "tritan", tritanopia: "tritan" }[me.type];
  if (!axis) return;
  fitTarget = optimiseForPalette(palette, { axis, severity: me.severity }, { strength: me.boost });
  fitCost = performance.now() - t0;
  // The sampler is shared with the colour readout; put it back.
  sampler.width = 32; sampler.height = 32;
}

function frame() {
  renderer.resize();
  const now = performance.now();
  if (S.cam && now - lastFit > 1000 / FIT_HZ) { lastFit = now; refit(now); }
  renderer.setFit(smoothFit(fitTarget, now));
  renderer.draw();
  requestAnimationFrame(frame);
}

// Exposed so test.html and a headless run can see what the live fit is doing.
window.__FIT = () => ({ target: fitTarget, costMs: fitCost });

// ---------------------------------------------------------------------------
// Sampling — always from the RAW source, never the corrected canvas, so the
// name stays true no matter what the filter is doing.
// ---------------------------------------------------------------------------
function sample() {
  if (!S.cam || S.compare) return; // reticle is hidden in compare view; nothing to update
  const src = vid;
  const w = src.videoWidth, h = src.videoHeight;
  if (!w || !h) return;

  // Sample where the reticle actually IS, not the geometric centre. The
  // reticle sits at 46% height, so centre-sampling names a different spot than
  // the crosshair points at — invisible in a static mockup, wrong in a live
  // app. Read its real position, undo the CSS zoom (which scales about the
  // canvas centre), then let the renderer undo the cover-crop and mirroring.
  const r = $("reticle").getBoundingClientRect();
  const app = $("app").getBoundingClientRect();
  const sx = (r.left + r.width / 2 - app.left) / app.width;
  const sy = (r.top + r.height / 2 - app.top) / app.height;
  const zx = 0.5 + (sx - 0.5) / S.zoom;
  const zy = 0.5 + (sy - 0.5) / S.zoom;
  const [px, py] = renderer.videoPointAt(zx, zy);

  const patch = Math.max(10, Math.round(Math.min(w, h) * 0.05 / S.zoom));
  const x0 = Math.max(0, Math.min(w - patch, px - patch / 2));
  const y0 = Math.max(0, Math.min(h - patch, py - patch / 2));
  try {
    sctx.drawImage(src, x0, y0, patch, patch, 0, 0, 32, 32);
  } catch { return; }
  let d;
  try { d = sctx.getImageData(0, 0, 32, 32).data; } catch { return; }
  S.rgb = smooth(averagePatch(d));
  paintReadout();
}

const toRGBString = (lin) => "rgb(" + lin.map((v) => Math.round(linearToSrgb(v) * 255)).join(",") + ")";

function paintReadout() {
  const [r, g, b] = S.rgb;
  $("swatch").style.background = `rgb(${r},${g},${b})`;
  $("cname").textContent = nameColor(r, g, b);

  // Each mode chip previews the sampled colour under that mode — the design's
  // nicest detail, and it makes the modes self-explanatory without words.
  const lin = [r, g, b].map((v) => srgbToLinear(v / 255));
  const preview = [assist(lin, me, me.boost, "natural"), simulate(lin, me), lin];
  document.querySelectorAll(".mode").forEach((el, i) => {
    el.querySelector(".chip").style.background = toRGBString(preview[i]);
  });
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
function paintChrome() {
  const initial = (me.name || "Z").slice(0, 2).toUpperCase();
  $("avatarBig").textContent = initial;
  $("icoZ").textContent = initial;
  $("avatarBig").style.background = me.avatarColor || BG[0];
  $("modeName").textContent = MODES[S.mode].name(initial);
  document.querySelectorAll(".mode").forEach((el, i) =>
    el.setAttribute("aria-pressed", String(i === S.mode)));
  $("gl").style.transform = `scale(${S.zoom.toFixed(3)})`;

  const t = TYPES[me.type];
  $("typeHint").textContent = t.prevalence || "";
  $("note").textContent = t.axis
    ? `${t.plain}. ${displayPolicy(me).reason}`
    : `${t.plain}. There is no colour axis left to move information onto, so recolouring is switched off — the colour name is what helps here.`;
}

function setMode(i) {
  S.mode = Math.max(0, Math.min(MODES.length - 1, i));
  renderer.setMode(MODES[S.mode].key);
  paintChrome();
  flash(MODES[S.mode].sub, 1800);
}

// Split top/bottom rather than left/right — a phone screen is taller than
// wide, so a horizontal seam keeps each half nearly the full picture instead
// of cropping it into a narrow strip. Raw camera on top, the corrected mode
// below, live. The colour-name reticle samples a screen position that only
// means one thing in a single full-frame view — in compare it would land
// over whichever half happens to be under 46% height, and the two halves
// show different pixels for the same screen point. Simplest correct answer
// is to hide it rather than compute a split-aware reprojection for a feature
// whose whole point is the visual comparison, not the name pill.
function setCompare(on) {
  S.compare = on;
  renderer.setCompare(on);
  $("compare").setAttribute("aria-pressed", String(on));
  $("center").style.display = on ? "none" : "";
  if (on) flash("Camera on top, corrected below", 1800);
}
$("compare").addEventListener("click", () => setCompare(!S.compare));

let toastTimer = 0;
function flash(text, ms = 1100) {
  clearTimeout(toastTimer);
  const el = $("toast");
  el.textContent = text;
  el.style.opacity = "1";
  el.style.font = ms > 1500 ? "500 13px/1.4 var(--sans)" : "600 15px/1 var(--mono)";
  el.style.maxWidth = "78%";
  el.style.textAlign = "center";
  toastTimer = setTimeout(() => { el.style.opacity = "0"; }, ms);
}

// ---------------------------------------------------------------------------
// People
//
// Everything about the correction is per-person — type, severity, strength and
// the calibration behind them — so more than one child (or a grown-up wanting
// to compare) needs more than one profile. profiles.js has carried this from
// the start; this is the UI for it, kept in the grown-ups sheet so the
// kid-facing screen stays three chips.
// ---------------------------------------------------------------------------
const nextFreeLetter = () => {
  const used = new Set(state.profiles.map((p) => (p.name || "").toUpperCase()));
  for (const ch of "ZABCDEFGHIJKLMNOPQRSTUVWXY") if (!used.has(ch)) return ch;
  return "?";
};

function switchTo(id) {
  state = Profiles.setActive(state, id);
  me = Profiles.active(state);
  applyProfile();
  syncSheet();
  paintChrome();
  paintReadout();
  flash(`${(me.name || "?").toUpperCase()} — ${TYPES[me.type].label}`, 1600);
}

function paintPeople() {
  const box = $("people");
  box.textContent = "";
  for (const p of state.profiles) {
    const b = document.createElement("button");
    b.textContent = (p.name || "?").slice(0, 2).toUpperCase();
    b.style.background = p.avatarColor || BG[0];
    b.setAttribute("aria-pressed", String(p.id === me.id));
    b.setAttribute("aria-label", `Use ${p.name}'s settings`);
    b.addEventListener("click", () => { if (p.id !== me.id) switchTo(p.id); });
    box.appendChild(b);
  }
  if (state.profiles.length < 6) {
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+";
    add.setAttribute("aria-label", "Add a person");
    add.addEventListener("click", () => {
      state = Profiles.add(state, nextFreeLetter());
      me = Profiles.active(state);
      applyProfile();
      syncSheet();
      paintChrome();
      paintReadout();
      $("letter").focus();
      flash("New person added — set their letter and measure their eyes", 2400);
    });
    box.appendChild(add);
  }
  $("removeBtn").hidden = state.profiles.length < 2;
}

/** Push the active profile's values into the sheet's controls. */
function syncSheet() {
  $("type").value = me.type;
  $("sev").value = me.severity;
  $("sevLabel").textContent = me.severity.toFixed(2);
  $("str").value = me.boost;
  $("strLabel").textContent = me.boost.toFixed(2);
  $("letter").value = me.name;
  document.querySelectorAll("#bgs button").forEach((o, i) =>
    o.setAttribute("aria-pressed", String((me.avatarColor || BG[0]) === BG[i])));

  // Say plainly whether these numbers were measured or are a starting guess.
  // A profile that has never run the test is using my default, not this
  // person's eyes, and that is worth knowing before trusting the correction.
  const who = (me.name || "?").toUpperCase();
  const st = $("calState");
  st.classList.toggle("measured", !!me.calibrated);
  st.textContent = me.calibrated
    ? `Measured — ${me.calibrationNote || "from the fish game"}`
    : `${who} has not been measured. These are starting values, not ${who}'s eyes.`;
  $("calBtn").textContent = me.calibrated ? "Measure again" : "Start the fish game";

  paintPeople();
}

function persist(patch) {
  state = Profiles.update(state, me.id, patch);
  me = Profiles.active(state);
  applyProfile();
  paintChrome();
  paintReadout();
  paintPeople();
}

// ---------------------------------------------------------------------------
// Gestures: swipe X changes mode, drag Y zooms, tap steps exposure.
// ---------------------------------------------------------------------------
let p = null;
const app = $("app");
app.addEventListener("pointerdown", (e) => {
  if (e.target.closest?.("[data-chrome]")) { p = null; return; }
  p = { x: e.clientX, y: e.clientY, z: S.zoom, ax: null };
  app.setPointerCapture?.(e.pointerId);
});
app.addEventListener("pointermove", (e) => {
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (!p.ax && Math.hypot(dx, dy) > 10) p.ax = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  if (p.ax === "x") {
    p.drag = Math.max(-160, Math.min(160, dx));
    $("modeName").style.transform = `translateX(${(p.drag * 0.35).toFixed(1)}px)`;
    $("modeName").style.opacity = (1 - Math.min(0.7, Math.abs(p.drag) / 220)).toFixed(2);
  } else if (p.ax === "y") {
    S.zoom = Math.max(1, Math.min(4, p.z * Math.exp(-dy / 320)));
    $("gl").style.transform = `scale(${S.zoom.toFixed(3)})`;
    flash(S.zoom.toFixed(1) + "×");
  }
});
const endDrag = () => {
  const q = p; p = null;
  $("modeName").style.transform = "";
  $("modeName").style.opacity = "1";
  if (!q) return;
  if (q.ax === "x") {
    if (Math.abs(q.drag || 0) > 55) setMode(S.mode + (q.drag < 0 ? 1 : -1));
  }
};
app.addEventListener("pointerup", endDrag);
app.addEventListener("pointercancel", endDrag);
app.addEventListener("wheel", (e) => {
  S.zoom = Math.max(1, Math.min(4, S.zoom * Math.exp(-e.deltaY / 600)));
  $("gl").style.transform = `scale(${S.zoom.toFixed(3)})`;
  flash(S.zoom.toFixed(1) + "×");
}, { passive: true });

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
document.querySelectorAll(".mode").forEach((el) =>
  el.addEventListener("click", () => setMode(+el.dataset.mode)));

const openSheet = (on) => {
  S.sheet = on;
  $("sheet").classList.toggle("on", on);
  $("scrim").classList.toggle("on", on);
  // The camera gate sits above the sheet (z-index 90 vs 80) so a denied/
  // pending camera permission doesn't get buried under settings. But that
  // means opening settings before the camera is granted stacks two full-
  // screen overlays and the sheet reads as a grey wash underneath the gate's
  // blur. Hide the gate for as long as the sheet is open; startCamera() and
  // the permission-denied path both re-show it on their own, so nothing is
  // lost by hiding it here — only shown while genuinely relevant.
  if (on) $("gate").classList.add("hidden");
  else if (!S.cam) $("gate").classList.remove("hidden");
};
$("gear").addEventListener("click", () => openSheet(true));
$("scrim").addEventListener("click", () => openSheet(false));
$("doneBtn").addEventListener("click", () => openSheet(false));
$("removeBtn").addEventListener("click", () => {
  if (state.profiles.length < 2) return;
  const gone = me.name;
  state = Profiles.remove(state, me.id);
  me = Profiles.active(state);
  applyProfile();
  syncSheet();
  paintChrome();
  paintReadout();
  flash(`Removed ${gone}`, 1600);
});

$("letter").addEventListener("input", (e) =>
  persist({ name: (e.target.value || "Z").toUpperCase().slice(0, 2) }));

BG.forEach((c) => {
  const b = document.createElement("button");
  b.style.background = c;
  b.setAttribute("aria-label", "Profile colour");
  b.addEventListener("click", () => {
    persist({ avatarColor: c });
    document.querySelectorAll("#bgs button").forEach((o) =>
      o.setAttribute("aria-pressed", String(o === b)));
  });
  $("bgs").appendChild(b);
});

for (const [key, t] of Object.entries(TYPES)) {
  if (key === "normal") continue;
  const o = document.createElement("option");
  o.value = key;
  // Just the label plus a two-word gloss; the full sentence goes in the note
  // below, because the long form overflows the select on a phone.
  const gloss = t.plain ? t.plain.split("—")[0].trim().toLowerCase() : "";
  o.textContent = gloss ? `${t.label} (${gloss})` : t.label;
  $("type").appendChild(o);
}
$("type").addEventListener("change", (e) => {
  persist({ type: e.target.value });
  flash(TYPES[e.target.value].label, 1600);
});

$("sev").addEventListener("input", (e) => {
  $("sevLabel").textContent = (+e.target.value).toFixed(2);
  persist({ severity: +e.target.value });
});
$("str").addEventListener("input", (e) => {
  $("strLabel").textContent = (+e.target.value).toFixed(2);
  persist({ boost: +e.target.value });
});

const showGate = (title, body, label, diag) => {
  $("gateTitle").textContent = title;
  $("gateBody").textContent = body;
  $("gateBtn").textContent = label;
  $("diag").textContent = diag || "";
  $("gate").classList.remove("hidden");
};

/**
 * This is a camera app, so it asks on open rather than hiding the camera
 * behind a settings screen. (The design put it behind a button because it was
 * a mockup inside a design canvas, where auto-requesting would be wrong.)
 *
 * If the permission was already granted the prompt never reappears and the
 * camera is simply live on launch. If the request fails — denied, or a browser
 * that demands a user gesture first — the demo scene stays up behind a gate
 * the user can tap, so the app is never a black rectangle.
 *
 * @param {boolean} viaTap whether a user gesture triggered this
 */
async function startCamera(viaTap) {
  try {
    await openCamera(vid, "environment");
    S.cam = true;
    renderer.attach(vid);
    $("app").classList.add("ready");
    $("gate").classList.add("hidden");
    $("camBtn").textContent = "Camera live";
    if (viaTap) flash("Camera live");
    return true;
  } catch (err) {
    const detail = `${err.name || "Error"}: ${err.message || err}`;
    $("app").classList.remove("ready");
    if (err.code === "unsupported" || !window.isSecureContext) {
      showGate("Camera not available",
        "A browser only allows the camera over https. Open this page at its https address and it will work.",
        "Try again", detail);
    } else if (err.name === "NotAllowedError" && viaTap) {
      showGate("Camera is blocked",
        "Allow it for this page: tap \u201cAA\u201d in the address bar, then Website Settings, then Camera.",
        "Try again", detail);
    } else if (err.code === "noframes") {
      showGate("Camera opened but sent no picture",
        "This usually clears if you close the tab and open it again.",
        "Try again", detail);
    } else {
      showGate("Turn on the camera",
        "Point it at anything and colours get easier to tell apart.",
        "Turn on camera", viaTap ? detail : "");
    }
    return false;
  }
}

$("gateBtn").addEventListener("click", () => startCamera(true));
$("camBtn").addEventListener("click", async () => {
  if (await startCamera(true)) openSheet(false);
});

// ---------------------------------------------------------------------------
// Calibration
//
// A label like "strong deutan" is a bucket; this is a measurement. The result
// replaces the profile's type and severity, and the correction updates live.
// ---------------------------------------------------------------------------
let calRunning = false;

async function calibrate() {
  if (calRunning) return;
  calRunning = true;
  const cv = $("calCanvas");
  $("cal").classList.add("on");
  openSheet(false);
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    return cv.width > 0 && cv.height > 0;
  };
  // One frame for the overlay to lay out before measuring it.
  await new Promise((r) => requestAnimationFrame(() => r()));
  if (!fit()) {
    await new Promise((r) => setTimeout(r, 120));
    if (!fit()) {
      $("calMsg").textContent = "The game could not size itself on this screen. Tell Claude what phone this is.";
      $("calQuit").textContent = "Close";
      $("calQuit").onclick = () => { $("cal").classList.remove("on"); calRunning = false; };
      return;
    }
  }
  $("calMsg").textContent = "Tap the fish. If there is no fish, wait.";
  $("calFill").style.width = "0%";
  $("calTime").textContent = "0:00";

  let stopped = false;
  $("calQuit").onclick = () => { stopped = true; $("cal").classList.remove("on"); calRunning = false; };

  // Live elapsed time — the game has no fixed length (staircases decide it),
  // so a kid with no sense of "about 3 minutes" needs to see time passing
  // rather than guess whether it is almost over.
  const startedAt = Date.now();
  const timeTick = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("calTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  // A run that fails the reliability check at the end (too many taps on
  // no-fish trials) gets thrown away silently — from a kid's side that reads
  // as the game randomly not working. Nudge as soon as a second false alarm
  // lands, while there is still time to slow down and save the run.
  const ringFg = $("waitRingFg");
  const CIRC = 113;
  let lastCatchFails = 0, nudgeUntil = 0;
  const result = await runSession(cv, {
    onProgress: (done, total, catchFails) => {
      $("calFill").style.width = Math.min(100, (done / total) * 100).toFixed(1) + "%";
      if (catchFails > lastCatchFails && catchFails >= 2) nudgeUntil = Date.now() + 4000;
      lastCatchFails = catchFails;
      $("calMsg").textContent = Date.now() < nudgeUntil
        ? "Only tap when you see the fish — take your time."
        : `Tap the fish. ${done} of about ${total}`;
    },
    // Drains every trial, catch or not — see the CSS comment on #waitRing for
    // why it can never be conditional on which kind of trial this is.
    onWait: (frac) => { ringFg.style.strokeDashoffset = (CIRC * (1 - frac)).toFixed(1); },
  });
  clearInterval(timeTick);
  if (stopped) return;

  // A run full of false alarms on the no-fish trials is guessing, and writing
  // it into the profile would be worse than leaving the old value alone.
  const trust = reliability(result);
  if (!trust.trustworthy) {
    $("calFill").style.width = "100%";
    $("calMsg").textContent =
      `Too many taps when there was no fish (${trust.falseAlarms} of ${trust.catches}). Nothing saved — try again slower.`;
    $("calQuit").textContent = "Close";
    $("calQuit").onclick = () => {
      $("cal").classList.remove("on");
      $("calQuit").textContent = "Take a break";
      calRunning = false;
    };
    return;
  }

  const patch = toEngineProfile(result);
  persist(patch);
  syncSheet();

  // The reward is drawn from colours THIS profile can separate — it
  // demonstrates the point rather than decorating.
  const { ctx, wide } = makeContext(cv);
  const scales = drawReward(cv, ctx, { axis: result.axis, severity: result.severity }, wide);
  $("calFill").style.width = "100%";
  $("calMsg").textContent = "";

  // What the game found, in plain words, before handing back to the camera.
  // A kid does not know what "deuteranomaly, severity 0.90" means; TYPES[].plain
  // already has the everyday version ("Green-weak — reds and greens blend
  // together"), so lead with that instead of the clinical label.
  if (result.axis) {
    const t = TYPES[patch.type];
    $("resultType").textContent = t.label;
    $("resultPlain").textContent = t.plain;
    $("resultWhy").textContent = `The camera found ${scales} colours it can now help you tell apart.`;
  } else {
    $("resultType").textContent = "Nothing unusual found";
    $("resultPlain").textContent = "Your colour vision looks typical on this test.";
    $("resultWhy").textContent = `${scales} colours checked — all came through clearly.`;
  }
  $("calResult").classList.add("on");
  $("resultGo").onclick = () => {
    $("calResult").classList.remove("on");
    $("cal").classList.remove("on");
    calRunning = false;
    flash(result.axis ? `Measured: ${TYPES[patch.type].label}` : "Measured: nothing unusual", 2200);
  };
}

$("calBtn").addEventListener("click", calibrate);

// ---------------------------------------------------------------------------
// First-run setup
//
// Everything the correction does depends on whose eyes it is for, and an
// uncalibrated profile is running on a guess. The sheet has always held these
// controls, but nothing pointed anyone at them — so the app shipped looking
// finished while quietly using default numbers. This asks once, up front.
// ---------------------------------------------------------------------------
function paintSetup() {
  const initial = (me.name || "Z").slice(0, 2).toUpperCase();
  $("setupAvatar").textContent = initial;
  $("setupAvatar").style.background = me.avatarColor || BG[0];
  $("setupLetter").value = me.name;
  document.querySelectorAll("#setupColours button").forEach((o, i) =>
    o.setAttribute("aria-pressed", String((me.avatarColor || BG[0]) === BG[i])));
}

BG.forEach((c) => {
  const b = document.createElement("button");
  b.style.background = c;
  b.setAttribute("aria-label", "Their colour");
  b.addEventListener("click", () => { persist({ avatarColor: c }); paintSetup(); });
  $("setupColours").appendChild(b);
});
$("setupLetter").addEventListener("input", (e) => {
  persist({ name: (e.target.value || "Z").toUpperCase().slice(0, 2) });
  paintSetup();
});

const closeSetup = () => { $("setup").classList.remove("on"); };
$("setupSkip").addEventListener("click", () => {
  closeSetup();
  flash("Using a starting guess. Measure any time from the gear.", 2600);
});
$("setupMeasure").addEventListener("click", async () => {
  closeSetup();
  await calibrate();
});

$("save").addEventListener("click", () => {
  gl.toBlob((b) => {
    if (!b) return flash("Could not save");
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url; a.download = "colorblind-frame.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    flash("Frame saved");
  }, "image/png");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  window.__booted = true;
  try {
    renderer = createRenderer(gl);
  } catch (e) {
    showGate("This browser has no WebGL",
      "The correction needs WebGL to run. Safari has it under Settings if it was switched off.",
      "Try again", String(e.message || e));
    return;
  }
  applyProfile();

  syncSheet();
  paintChrome();
  paintSetup();
  setInterval(sample, 140);
  requestAnimationFrame(frame);

  // Nobody measured yet, and only one person: this is a first run.
  if (!me.calibrated && state.profiles.length === 1) $("setup").classList.add("on");

  // Ask immediately. Already-granted permission means the camera is simply
  // live on launch, with no prompt at all.
  startCamera(false);

  if (!renderer.wideGamut) console.info("[colorblind] Display P3 unavailable; running sRGB.");
}

boot();
