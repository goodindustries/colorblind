/**
 * Colour naming.
 *
 * Read from raw sensor pixels, before any correction shader runs, so the answer
 * is right regardless of what the filter is doing. For someone who genuinely
 * cannot separate two hues, a word is the only fully reliable channel — see
 * SCIENCE.md §4.3.
 *
 * The bins that matter most are the ones that collapse for a red-green
 * deficiency: brown, tan, olive, maroon, pink. Those get explicit rules rather
 * than falling out of a plain hue wheel, because "dark orange" is a useless
 * answer when the real question is "is this wire brown or red".
 */

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

const HUES = [
  [10, "red"], [20, "red-orange"], [35, "orange"], [48, "amber"],
  [66, "yellow"], [80, "yellow-green"], [95, "lime green"], [150, "green"],
  [168, "spring green"], [190, "teal"], [200, "cyan"], [265, "blue"],
  // "indigo" and "violet" overlap almost entirely (CSS indigo is hue 275,
  // blueviolet 271) and neither is a word a child uses. One "purple" bin is
  // both more honest and more useful.
  [300, "purple"], [330, "magenta"], [350, "pink-red"], [361, "red"],
];

/** Plain-language name for an sRGB triple in 0..255. */
export function nameColor(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);

  if (s < 0.10 || l < 0.06 || l > 0.96) {
    if (l < 0.10) return "black";
    if (l < 0.28) return "dark grey";
    if (l < 0.55) return "grey";
    if (l < 0.82) return "light grey";
    return "white";
  }

  let base = "red";
  for (const [edge, label] of HUES) if (h < edge) { base = label; break; }

  // Categories that collapse under red-green deficiency get explicit rules.
  if (h >= 10 && h < 50) {
    if (l < 0.32) base = "brown";
    else if (l < 0.52 && s < 0.65) base = "brown";
    else if (l >= 0.52 && s < 0.55) base = "tan";
  }
  if (h < 12 && l < 0.30) base = "maroon";
  // Borrowed from the design's palette: light warm tones read as "peach",
  // which beats "pale orange" for skin — the one case its namer won on.
  if (h >= 10 && h < 45 && l > 0.72 && s > 0.30) base = "peach";
  if ((h >= 330 || h < 12) && l > 0.66) base = "pink";
  if (h >= 300 && h < 330 && l > 0.72) base = "pink";
  if (h >= 50 && h < 90 && l < 0.38) base = "olive";
  if (h >= 200 && h < 267 && l < 0.28) base = "navy";

  let mod = "";
  const literal = ["brown", "olive", "navy", "black", "maroon", "tan", "peach"];
  if (l < 0.26 && !literal.includes(base)) mod = "dark ";
  else if (l > 0.78 && base !== "pink" && !literal.includes(base)) mod = "pale ";
  else if (s > 0.80 && l > 0.30 && l < 0.72) mod = "vivid ";
  else if (s < 0.28) mod = "muted ";
  return mod + base;
}

const hex2 = (n) => n.toString(16).padStart(2, "0");
export const toHex = (r, g, b) => "#" + hex2(r) + hex2(g) + hex2(b);

/**
 * Average a patch rather than one pixel — a single pixel is dominated by
 * sensor noise, which is what makes a readout flicker between two names while
 * the phone is held still. See SCIENCE.md §2 on temporal averaging.
 */
export function averagePatch(data) {
  let r = 0, g = 0, b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Exponential smoothing across frames, for a readout that holds still. */
export function makeSmoother(alpha = 0.35) {
  let acc = null;
  return (rgb) => {
    acc = acc ? acc.map((v, i) => v + (rgb[i] - v) * alpha) : rgb.slice();
    return acc.map(Math.round);
  };
}
