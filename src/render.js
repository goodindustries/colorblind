/**
 * WebGL renderer. Deliberately carries no visual design — no colours, no
 * layout, no DOM beyond the canvas it is handed. The design layer drives it
 * through setProfile / setMode / setBoost, so a UI change never touches the
 * colour science.
 *
 * The GLSL is generated from src/engine.js constants, so the GPU path cannot
 * drift away from the CPU path the tests cover.
 */

import { TYPES, machadoMatrix, correctionFor, brettelParams } from "./engine.js";

export const MODE = { NORMAL: 0, ASSIST: 1, SIMULATE: 2 };

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

vec3 toLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
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
  const corr = correctionFor(profile.type);
  const assist = corr
    ? `vec3 assist(vec3 lin){
        vec3 sim = simulate(lin);
        vec3 err = lin - sim;
        float d = dot(err, ${glslVec(corr.pick)});
        float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
        float k = 1.0 + ${corr.sat.toFixed(4)} * uBoost;
        vec3 t = lin + d * ${glslVec(corr.push)} * uBoost;
        return y + (t - y) * k;
      }`
    // Monochromacy has no axis to move information onto. Returning the input
    // unchanged is the honest answer; SCIENCE.md §3 covers what helps instead.
    : `vec3 assist(vec3 lin){ return lin; }`;

  return `${HEAD}
${simulateGLSL(profile)}
${assist}
void main(){
  vec3 src = texture2D(uTex, vUV).rgb;
  vec3 lin = toLinear(src);
  vec3 outv = lin;
  if (uMode == 1) outv = assist(lin);
  else if (uMode == 2) outv = simulate(lin);
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

  const coverScale = () => {
    const vw = video?.videoWidth || 1, vh = video?.videoHeight || 1;
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
    setDim(d) { state.dim = Math.max(0.2, Math.min(1, d)); },

    resize(dpr = Math.min(devicePixelRatio || 1, 2)) {
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    draw() {
      if (!prog || !video || video.readyState < 2) return false;
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
      const vw = video?.videoWidth || 0, vh = video?.videoHeight || 0;
      return [
        Math.max(0, Math.min(vw - 1, ux * vw)),
        Math.max(0, Math.min(vh - 1, uy * vh)),
      ];
    },
  };
}

/** Camera acquisition, kept here so the design layer never touches getUserMedia. */
export async function openCamera(video, facing = "environment") {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("This browser exposes no camera API."), { code: "unsupported" });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}
