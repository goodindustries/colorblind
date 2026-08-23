/**
 * Profiles.
 *
 * Everyone's eyes are different, so the correction is per-person, not global.
 * A profile is deliberately more than a name: brightness policy inverts between
 * deficiency types (bright light HELPS anomalous trichromats and HURTS
 * achromats), so getting this wrong is not cosmetic.
 *
 * Storage is localStorage — per-device, never leaves it, no account server.
 * Every access is guarded: private browsing and locked-down browsers throw on
 * the accessor itself rather than returning null.
 */

import { TYPES, severityFromRayleigh } from "./engine.js";

const KEY = "colorblind.profiles.v1";
// The design identifies a profile by an initial on a coloured disc, not an
// emoji. These are its six swatches.
const AVATAR_COLORS = ["#f5a623", "#2f9bf0", "#f2e327", "#1b2a6b", "#d2b48c", "#22c8d8"];

const safeRead = () => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
const safeWrite = (state) => {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch { return false; }   // private mode: app still works, just won't persist
};

let counter = 0;
const newId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export function defaultProfile(name = "Z") {
  return {
    id: newId(),
    name,
    avatarColor: AVATAR_COLORS[0],
    type: "deuteranomaly",   // by far the most common
    severity: 0.9,   // the design's default, and typical of a "strong" result
    boost: 0.6,
    calibrated: false,
    speak: false,
  };
}

/** Brightness policy is a clinical property of the deficiency, not a taste. */
export function displayPolicy(profile) {
  const t = TYPES[profile.type] || TYPES.normal;
  if (t.photophobic) {
    return {
      brightness: "reduce",
      reason: `${t.label} comes with light sensitivity. Bright screens cause real discomfort here, so this profile dims rather than brightens.`,
      tint: "warm",
    };
  }
  return {
    brightness: "max",
    reason:
      "Cone discrimination is limited by signal-to-noise, so more light genuinely helps. This is the same reason colour-blind glasses only work in bright conditions.",
    tint: "none",
  };
}

export function load() {
  const state = safeRead();
  if (state && Array.isArray(state.profiles) && state.profiles.length) return state;
  const p = defaultProfile();
  return { profiles: [p], activeId: p.id };
}

export const save = (state) => safeWrite(state);
export const active = (state) => state.profiles.find((p) => p.id === state.activeId) || state.profiles[0];

export function add(state, name) {
  const p = defaultProfile(name);
  p.avatarColor = AVATAR_COLORS[state.profiles.length % AVATAR_COLORS.length];
  const next = { profiles: [...state.profiles, p], activeId: p.id };
  save(next);
  return next;
}

export function update(state, id, patch) {
  const next = { ...state, profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
  save(next);
  return next;
}

export function remove(state, id) {
  const profiles = state.profiles.filter((p) => p.id !== id);
  if (!profiles.length) return load();
  const next = { profiles, activeId: state.activeId === id ? profiles[0].id : state.activeId };
  save(next);
  return next;
}

export const setActive = (state, id) => { const n = { ...state, activeId: id }; save(n); return n; };

/** Fit type and severity from a Rayleigh match instead of trusting a label. */
export function applyCalibration(state, id, match) {
  const { severity, type, confidence } = severityFromRayleigh(match);
  return update(state, id, { type, severity, calibrated: true, calibrationNote: confidence });
}

export { AVATAR_COLORS };
