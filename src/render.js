/**
 * WebGL renderer. Deliberately carries no visual design — no colours, no
 * layout, no DOM beyond the canvas it is handed. The design layer drives it
 * through setProfile / setMode / setBoost, so a UI change never touches the
 * colour science.
 *
 * The GLSL is generated from src/engine.js constants, so the GPU path cannot
 * drift away from the CPU path the tests cover.
 */

import { TYPES, machadoMatrix, correctionFor, brettelParams, HUE_CAP_DEG, CHROMA_FLOOR } from "./engine.js";

export const MODE = { NORMAL: 0, ASSIST: 1, SIMULATE: 2, BOOST: 3, BRIGHT: 4 };

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
uniform vec2 uScale;
uniform float uMirror;
void main(){
  vec2 uv = aPos * 0.5 + 0.5;
  uv = (uv - 0.5) / uScale + 0.5;
  uv.x = mix(uv.x, 1.0 - uv.x, uMirror);
  vUV = vec2(uv.x, 1.0 - uv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform int uMode;
uniform float uBoost;
uniform float uDim;

const float PI = 3.14159265;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 toLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
}

// GLSL mat3 constructors are column-major.
const mat3 RGB2XYZ = mat3(0.4124564, 0.2126729, 0.0193339,
                          0.3575761, 0.7151522, 0.1191920,
                          0.1804375, 0.0721750, 0.9503041);
const mat3 XYZ2RGB = mat3( 3.2406, -0.9689,  0.0557,
                          -1.5372,  1.8758, -0.2040,
                          -0.4986,  0.0415,  1.0570);
const vec3 WHITE = vec3(0.95047, 1.0, 1.08883);

vec3 toLab(vec3 lin){
  vec3 n = (RGB2XYZ * lin) / WHITE;
  n = max(n, vec3(0.0));
  vec3 f = mix(7.787 * n + 16.0/116.0, pow(n, vec3(1.0/3.0)), step(vec3(0.008856), n));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 fromLab(vec3 lab){
  float fy = (lab.x + 16.0) / 116.0;
  vec3 f = vec3(lab.y / 500.0 + fy, fy, fy - lab.z / 200.0);
  vec3 n = mix((f - 16.0/116.0) / 7.787, f * f * f, step(vec3(0.206893), f));
  return XYZ2RGB * (n * WHITE);
}
float chromaOf(vec3 lab){ return length(lab.yz); }

// Scale chroma toward the pixel's own luminance. Clipping each channel
// separately rotates hue — that is exactly how an orange became purple.
vec3 mapToGamut(vec3 c){
  float Y = clamp(dot(c, LUMA), 0.0, 1.0);
  vec3 d = c - vec3(Y);
  float t = 1.0;
  if (c.r > 1.0 && d.r > 0.0) t = min(t, (1.0 - Y) / d.r);
  if (c.g > 1.0 && d.g > 0.0) t = min(t, (1.0 - Y) / d.g);
  if (c.b > 1.0 && d.b > 0.0) t = min(t, (1.0 - Y) / d.b);
  if (c.r < 0.0 && d.r < 0.0) t = min(t, -Y / d.r);
  if (c.g < 0.0 && d.g < 0.0) t = min(t, -Y / d.g);
  if (c.b < 0.0 && d.b < 0.0) t = min(t, -Y / d.b);
  return vec3(Y) + d * max(t, 0.0);
}

// Hard bound on hue rotation, so "orange stays orange" is a guarantee rather
// than an average that happened to hold on the colours we tested.
vec3 guardHue(vec3 o, vec3 ref, float capDeg){
  vec3 lo = toLab(o), lr = toLab(ref);
  float co = chromaOf(lo), cr = chromaOf(lr);
  if (cr < 4.0 || co < 4.0) return o;      // hue undefined near the neutral axis
  float dh = atan(lo.z, lo.y) - atan(lr.z, lr.y);
  if (dh >  PI) dh -= 2.0 * PI;
  if (dh < -PI) dh += 2.0 * PI;
  float cap = capDeg * PI / 180.0;
  if (abs(dh) <= cap) return o;
  float h = atan(lr.z, lr.y) + sign(dh) * cap;
  return mapToGamut(fromLab(vec3(lo.x, co * cos(h), co * sin(h))));
}
`;

const glslMat = (m) =>
  `mat3(${[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]].map((v) => v.toFixed(6)).join(",")})`;
const glslVec = (v) => `vec3(${v.map((x) => x.toFixed(6)).join(",")})`;

/** Emit a `simulate()` matching whichever model this type uses. */
function simulateGLSL(profile) {
  const t = TYPES[profile.type] || TYPES.normal;
  const sev = profile.severity == null ? 1 : profile.severity;

  if (t.model === "none") return `vec3 simulate(vec3 lin){ return lin; }`;

  if (t.model === "monochrome")
    return `vec3 simulate(vec3 lin){
      float y = dot(lin, ${glslVec(t.weights)});
      return mix(lin, vec3(y), ${sev.toFixed(4)});
    }`;

  if (t.model === "machado")
    return `const mat3 SIM = ${glslMat(machadoMatrix(t.family, sev))};
    vec3 simulate(vec3 lin){ return SIM * lin; }`;

  // Brettel: pick the half-plane by the sign of the plane-normal dot product.
  const B = brettelParams(t.brettel);
  return `const mat3 B1 = ${glslMat(B.m1)};
  const mat3 B2 = ${glslMat(B.m2)};
  const vec3 BN = ${glslVec(B.n)};
  vec3 simulate(vec3 lin){
    vec3 p = (dot(lin, BN) >= 0.0) ? (B1 * lin) : (B2 * lin);
    return mix(lin, p, ${sev.toFixed(4)});
  }`;
}

export function buildFragment(profile) {
  const nat = correctionFor(profile.type, "natural");
  const max = correctionFor(profile.type, "max");
  const passthrough = !nat;

  // Monochromacy has no axis to move information onto. A passthrough is the
  // honest answer; SCIENCE.md covers what helps instead.
  if (passthrough) {
    return `${HEAD}
${simulateGLSL(profile)}
void main(){
  vec3 lin = toLinear(texture2D(uTex, vUV).rgb);
  vec3 outv = (uMode == 2) ? simulate(lin) : lin;
  gl_FragColor = vec4(toSRGB(outv) * uDim, 1.0);
}`;
  }

  const PICK = glslVec(max.pick);
  const target = (name, c) => `
vec3 ${name}(vec3 lin, float boost){
  vec3 sim = simulate(lin);
  float d = dot(lin - sim, ${PICK});
  float y = dot(lin, LUMA);
  float k = 1.0 + ${c.sat.toFixed(4)} * boost;
  vec3 t = lin + d * ${glslVec(c.push)} * boost;
  return vec3(y) + (t - vec3(y)) * k;
}`;

  // Back the correction off until enough chroma survives the gamut map.
  // Without this, strongly saturated colours arrive GREY — 88 of 494 random
  // colours did, which is a worse artefact than the hue rotation it replaced.
  // Most pixels skip the loop entirely.
  const solve = (name, raw, bound) => `
vec3 ${name}(vec3 lin){
  vec3 full = mapToGamut(${raw}(lin, uBoost));
  float c0 = chromaOf(toLab(lin));
  vec3 best = full;
  if (c0 >= 4.0 && chromaOf(toLab(full)) < ${CHROMA_FLOOR.toFixed(3)} * c0) {
    float lo = 0.0, hi = 1.0;
    for (int i = 0; i < 6; i++) {
      float mid = (lo + hi) * 0.5;
      vec3 o = mapToGamut(${raw}(lin, uBoost * mid));
      if (chromaOf(toLab(o)) >= ${CHROMA_FLOOR.toFixed(3)} * c0) { lo = mid; best = o; }
      else hi = mid;
    }
  }
  return ${bound ? `guardHue(best, lin, ${HUE_CAP_DEG.toFixed(1)})` : "best"};
}`;

  return `${HEAD}
${simulateGLSL(profile)}
${target("rawNatural", nat)}
${target("rawMax", max)}
${solve("assistNatural", "rawNatural", true)}
${solve("assistMax", "rawMax", false)}

// Brightness: the lost signal encoded purely as lighter/darker. Hue and
// saturation are untouched, so hue error is exactly zero by construction.
vec3 brighten(vec3 lin){
  vec3 sim = simulate(lin);
  float d = dot(lin - sim, ${PICK});
  float Y = dot(lin, LUMA);
  float f = clamp(pow(2.0, d * 4.0 * uBoost), 0.5, 2.0);
  float yMax = Y / max(max(lin.r, max(lin.g, lin.b)), 1e-6);
  float Y2 = max(0.02, Y * f);
  if (Y2 > Y) Y2 = min(Y2, max(Y, yMax * 0.995));
  vec3 scaled = (Y < 1e-6) ? vec3(Y2) : lin * (Y2 / Y);
  return mapToGamut(scaled);
}

void main(){
  vec3 lin = toLinear(texture2D(uTex, vUV).rgb);
  vec3 outv = lin;
  if (uMode == 1) outv = assistNatural(lin);
  else if (uMode == 2) outv = simulate(lin);
  else if (uMode == 3) outv = assistMax(lin);
  else if (uMode == 4) outv = brighten(lin);
  // Photophobic profiles dim instead of brightening — see displayPolicy().
  gl_FragColor = vec4(toSRGB(outv) * uDim, 1.0);
}`;
}

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("WebGL unavailable");

  // SCIENCE.md ranks this first: sRGB is where 2-4% of confusion pairs still
  // lose to clipping, and P3 has ~25% more volume, most of it in the reds and
  // greens where red-green correction runs out of room.
  let wideGamut = false;
  try {
    if ("drawingBufferColorSpace" in gl) {
      gl.drawingBufferColorSpace = "display-p3";
      wideGamut = gl.drawingBufferColorSpace === "display-p3";
    }
  } catch { wideGamut = false; }

  const state = { profile: null, mode: MODE.ASSIST, boost: 0.55, mirror: 0, dim: 1 };
  let prog = null, loc = null, video = null;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s); gl.deleteShader(s);
      throw new Error("shader compile failed: " + log);
    }
    return s;
  };

  function rebuild() {
    if (prog) gl.deleteProgram(prog);
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, buildFragment(state.profile)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const a = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    loc = ["uTex","uMode","uBoost","uScale","uMirror","uDim"]
      .reduce((o, n) => (o[n] = gl.getUniformLocation(prog, n), o), {});
    gl.uniform1i(loc.uTex, 0);
  }

  // The source is a <video> once the camera is live, and a <canvas> before
  // that (the demo scene), so read dimensions from whichever it is.
  const srcW = () => video?.videoWidth || video?.width || 0;
  const srcH = () => video?.videoHeight || video?.height || 0;

  const coverScale = () => {
    const vw = srcW() || 1, vh = srcH() || 1;
    const va = vw / vh, ca = (canvas.width || 1) / (canvas.height || 1);
    return va > ca ? [ca / va, 1] : [1, va / ca];
  };

  return {
    wideGamut,
    get scale() { return coverScale(); },
    attach(v) { video = v; },
    setProfile(p) { state.profile = p; rebuild(); },
    setMode(m) { state.mode = m; },
    setBoost(b) { state.boost = Math.max(0, Math.min(1, b)); },
    setMirror(on) { state.mirror = on ? 1 : 0; },
    setExposure(d) { state.dim = Math.max(0.2, Math.min(2.5, d)); },

    resize(dpr = Math.min(devicePixelRatio || 1, 2)) {
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    draw() {
      if (!prog || !video) return false;
      if (video.readyState !== undefined && video.readyState < 2) return false;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      const [sx, sy] = coverScale();
      gl.uniform2f(loc.uScale, sx, sy);
      gl.uniform1f(loc.uMirror, state.mirror);
      gl.uniform1i(loc.uMode, state.mode);
      gl.uniform1f(loc.uBoost, state.boost);
      gl.uniform1f(loc.uDim, state.dim);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },

    /**
     * Screen point (0..1, top-left origin) -> source video pixel.
     * Accounts for cover-crop and mirroring so a tap lands where it looks.
     */
    videoPointAt(tx, ty) {
      const [sx, sy] = coverScale();
      let ux = (tx - 0.5) / sx + 0.5;
      const uy = (ty - 0.5) / sy + 0.5;
      if (state.mirror) ux = 1 - ux;
      const vw = srcW(), vh = srcH();
      return [
        Math.max(0, Math.min(vw - 1, ux * vw)),
        Math.max(0, Math.min(vh - 1, uy * vh)),
      ];
    },
  };
}

/** Camera acquisition, kept here so the design layer never touches getUserMedia. */
export async function openCamera(video, facing = "environment") {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error("This browser exposes no camera API."), { code: "unsupported" });
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    // Some devices reject the resolution hints outright rather than treating
    // them as hints. Fall back to whatever camera the browser will give us.
    if (e.name === "OverconstrainedError" || e.name === "NotFoundError" || e.name === "TypeError") {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } else throw e;
  }

  video.srcObject = stream;

  // iOS Safari can reject play() because the permission dialog consumed the
  // user gesture that authorised it. The element is muted + playsinline +
  // autoplay, so playback starts regardless — a rejection here must not fail
  // the whole flow, which is what made the camera look broken.
  try { await video.play(); } catch { /* autoplay policy; frames still arrive */ }

  // play() resolving does not mean frames exist yet. Wait for real data before
  // reporting success, so we never hand the renderer a zero-sized texture.
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("playing", done, { once: true });
      setTimeout(done, 4000);
    });
  }

  if (!video.videoWidth) {
    stream.getTracks().forEach((t) => t.stop());
    throw Object.assign(new Error("Camera gave no picture."), { code: "noframes" });
  }
  return stream;
}
