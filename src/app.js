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

import { TYPES, simulate, assist, brighten, linearToSrgb, srgbToLinear } from "./engine.js";
import { createRenderer, openCamera, MODE } from "./render.js";
import { nameColor, toHex, averagePatch, makeSmoother } from "./naming.js";
import * as Profiles from "./profiles.js";
import { displayPolicy } from "./profiles.js";

const $ = (id) => document.getElementById(id);

const EV = [0.7, 1, 1.35, 1.8];
const EV_LABEL = ["EV −1", "EV 0", "EV +1", "EV +2"];
const ACC = ["#f5a623", "#8ad14b", "#2f9bf0", "#ffffff"];
const BG = ["#f5a623", "#2f9bf0", "#f2e327", "#1b2a6b", "#d2b48c", "#22c8d8"];

// Mode order is the brief's: correct their vision first, then show what they
// see, then the untouched reference — with "extra" sitting next to the default
// because they are the two corrections.
//
// The default is NATURAL, not maximum separation. Z reported that orange looked
// purple, which was exactly right: the old default had no hue constraint. It
// now keeps an orange orange (3 degrees mean hue shift, against 35) while still
// separating confusable colours. See SCIENCE.md §5 for why no correction can
// make him actually PERCEIVE the true colour.
const MODES = [
  { key: MODE.ASSIST,   name: (n) => `${n}'s mode`,      sub: "Colours stay true, and the confusing ones move apart." },
  { key: MODE.BRIGHT,   name: () => "True colour",       sub: "No colour is changed at all. Confusing ones go lighter or darker instead." },
  { key: MODE.SIMULATE, name: (n) => `How ${n} sees it`, sub: "What their eyes actually receive — show this to other people." },
  { key: MODE.NORMAL,   name: () => "Standard",          sub: "Untouched camera. The reference frame." },
];

// The false-colour mode lives in the sheet, not on a chip. Once gamut mapping
// stopped clipping, it beat the default on only half the deficiency types,
// while costing 3-9x the hue error — so it is a tool for "are these two the
// same?", not something to leave a child looking through.
const FALSE_COLOUR = { key: MODE.BOOST, name: () => "Extra boost",
  sub: "Colours are deliberately wrong so two similar ones cannot hide." };

const S = { mode: 0, ev: 1, zoom: 1, sheet: false, rgb: [128, 128, 128], cam: false, falseColour: false };
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
  // Photophobic profiles dim rather than brighten — bright screens genuinely
  // hurt in achromatopsia and blue cone monochromacy. SCIENCE.md §2.
  return EV[S.ev] * (policy.brightness === "reduce" ? 0.55 : 1);
}

function applyProfile() {
  renderer.setProfile(me);
  renderer.setBoost(me.boost);
  renderer.setExposure(exposure());
  renderer.setMode(MODES[S.mode].key);
}

function frame() {
  renderer.resize();
  renderer.draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Sampling — always from the RAW source, never the corrected canvas, so the
// name stays true no matter what the filter is doing.
// ---------------------------------------------------------------------------
function sample() {
  if (!S.cam) return;
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
  $("chex").textContent = toHex(r, g, b).toUpperCase();

  // Each mode chip previews the sampled colour under that mode — the design's
  // nicest detail, and it makes the modes self-explanatory without words.
  const lin = [r, g, b].map((v) => srgbToLinear(v / 255));
  const preview = [
    assist(lin, me, me.boost, "natural"),
    brighten(lin, me, me.boost),
    simulate(lin, me),
    lin,
  ];
  document.querySelectorAll(".mode").forEach((el, i) => {
    el.querySelector(".chip").style.background = toRGBString(preview[i]);
  });
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
function paintChrome() {
  const initial = (me.name || "Z").slice(0, 2).toUpperCase();
  $("avatar").textContent = initial;
  $("avatarBig").textContent = initial;
  $("ico0").textContent = initial;
  $("avatar").style.background = me.avatarColor || BG[0];
  $("avatarBig").style.background = me.avatarColor || BG[0];
  $("modeName").textContent = S.falseColour ? FALSE_COLOUR.name() : MODES[S.mode].name(initial);
  document.querySelectorAll(".mode").forEach((el, i) =>
    el.setAttribute("aria-pressed", String(i === S.mode && !S.falseColour)));
  $("gl").style.transform = `scale(${S.zoom.toFixed(3)})`;

  const t = TYPES[me.type];
  $("typeHint").textContent = t.prevalence || "";
  $("note").textContent = t.axis
    ? `${t.plain}. ${displayPolicy(me).reason}`
    : `${t.plain}. There is no colour axis left to move information onto, so recolouring is switched off — the colour name is what helps here.`;
}

function setMode(i) {
  S.mode = Math.max(0, Math.min(MODES.length - 1, i));
  S.falseColour = false;
  $("falseBtn")?.setAttribute("aria-pressed", "false");
  renderer.setMode(MODES[S.mode].key);
  paintChrome();
  flash(MODES[S.mode].sub, 1800);
}

function toggleFalseColour() {
  S.falseColour = !S.falseColour;
  $("falseBtn").setAttribute("aria-pressed", String(S.falseColour));
  $("falseBtn").textContent = S.falseColour ? "False colour on" : "Turn on false colour";
  renderer.setMode(S.falseColour ? FALSE_COLOUR.key : MODES[S.mode].key);
  paintChrome();
  flash(S.falseColour ? FALSE_COLOUR.sub : MODES[S.mode].sub, 1800);
}

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

function persist(patch) {
  state = Profiles.update(state, me.id, patch);
  me = Profiles.active(state);
  applyProfile();
  paintChrome();
  paintReadout();
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
  } else if (!q.ax) {
    S.ev = (S.ev + 1) % 4;
    renderer.setExposure(exposure());
    flash(EV_LABEL[S.ev]);
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
};
$("gear").addEventListener("click", () => openSheet(true));
$("avatar").addEventListener("click", () => openSheet(true));
$("scrim").addEventListener("click", () => openSheet(false));
$("doneBtn").addEventListener("click", () => openSheet(false));
$("falseBtn").addEventListener("click", toggleFalseColour);

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

  $("type").value = me.type;
  $("sev").value = me.severity;
  $("sevLabel").textContent = me.severity.toFixed(2);
  $("str").value = me.boost;
  $("strLabel").textContent = me.boost.toFixed(2);
  $("letter").value = me.name;
  document.querySelectorAll("#bgs button").forEach((o, i) =>
    o.setAttribute("aria-pressed", String((me.avatarColor || BG[0]) === BG[i])));

  paintChrome();
  setInterval(sample, 140);
  requestAnimationFrame(frame);

  // Ask immediately. Already-granted permission means the camera is simply
  // live on launch, with no prompt at all.
  startCamera(false);

  if (!renderer.wideGamut) console.info("[colorblind] Display P3 unavailable; running sRGB.");
}

boot();
