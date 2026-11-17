// Deterministic demo: a 30s expression cycle that synthesizes blendshape
// values directly (same shape as the real engine output) and draws an
// animated 2D face that mirrors them. No camera needed.

export const CYCLE = 30000;
const TRANS = 500;

// [name, duration, blendshape targets]
const PHASES = [
  ["NEUTRAL", 4000, {}],
  ["JOY", 6000, { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, jawOpen: 0.15 }],
  ["SURPRISE", 4000, { eyeWideLeft: 0.8, eyeWideRight: 0.8, browOuterUpLeft: 0.7, browOuterUpRight: 0.7, browInnerUp: 0.5, jawOpen: 0.55 }],
  ["SAD", 5000, { mouthFrownLeft: 0.7, mouthFrownRight: 0.7, browInnerUp: 0.8, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 }],
  ["ANGER", 5000, { browDownLeft: 0.85, browDownRight: 0.85, noseSneerLeft: 0.4, noseSneerRight: 0.4, mouthPressLeft: 0.6, mouthPressRight: 0.6, eyeSquintLeft: 0.4, eyeSquintRight: 0.4 }],
  ["DISGUST", 3000, { noseSneerLeft: 0.9, noseSneerRight: 0.9, browDownLeft: 0.5, browDownRight: 0.5, mouthPressLeft: 0.3, mouthPressRight: 0.3, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 }],
  ["NEUTRAL", 3000, {}],
];

// blink windows inside the neutral phases (ms within cycle)
const BLINKS = [[1500, 1650], [28400, 28550]];

const lerp = (a, b, t) => a + (b - a) * t;

function phaseAt(t) {
  let acc = 0;
  for (let i = 0; i < PHASES.length; i++) {
    const [name, dur, target] = PHASES[i];
    if (t < acc + dur) return { i, name, target, local: t - acc, dur };
    acc += dur;
  }
  const last = PHASES[PHASES.length - 1];
  return { i: PHASES.length - 1, name: last[0], target: last[2], local: last[1], dur: last[1] };
}

export function demoFrame(tMs) {
  const t = ((tMs % CYCLE) + CYCLE) % CYCLE;
  const p = phaseAt(t);
  const prevTarget = PHASES[(p.i + PHASES.length - 1) % PHASES.length][2];
  const k = p.local < TRANS ? p.local / TRANS : 1;
  const blend = {};
  const keys = new Set([...Object.keys(prevTarget), ...Object.keys(p.target)]);
  for (const key of keys) blend[key] = lerp(prevTarget[key] || 0, p.target[key] || 0, k);
  for (const [a, b] of BLINKS) {
    if (t >= a && t <= b) { blend.eyeBlinkLeft = 0.9; blend.eyeBlinkRight = 0.9; }
  }
  return { blend, truth: p.name };
}

// ---- animated face drawing (mirrors the blendshapes) ----
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const g = (b, k) => b[k] || 0;
const avg = (b, a, c) => (g(b, a) + g(b, c)) / 2;

export function drawFace(ctx, w, h, b) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.52, r = Math.min(w, h) * 0.33;
  const smile = avg(b, "mouthSmileLeft", "mouthSmileRight");
  const frown = avg(b, "mouthFrownLeft", "mouthFrownRight");
  const browDown = avg(b, "browDownLeft", "browDownRight");
  const browInnerUp = g(b, "browInnerUp");
  const browOuterUp = avg(b, "browOuterUpLeft", "browOuterUpRight");
  const eyeWide = avg(b, "eyeWideLeft", "eyeWideRight");
  const eyeSquint = avg(b, "eyeSquintLeft", "eyeSquintRight");
  const blink = avg(b, "eyeBlinkLeft", "eyeBlinkRight");
  const jawOpen = g(b, "jawOpen");
  const press = avg(b, "mouthPressLeft", "mouthPressRight");
  const sneer = avg(b, "noseSneerLeft", "noseSneerRight");
  const cheek = avg(b, "cheekSquintLeft", "cheekSquintRight");

  // halo
  const grad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.7);
  grad.addColorStop(0, "rgba(236,72,153,0.10)");
  grad.addColorStop(1, "rgba(236,72,153,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // face outline
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#f9a8d4";
  ctx.fillStyle = "rgba(249,168,212,0.05)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.92, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // eyes
  const open = clamp(1 + eyeWide * 0.65 - blink - eyeSquint * 0.55, 0.04, 1.7);
  for (const side of [-1, 1]) {
    const ex = cx + side * r * 0.38, ey = cy - r * 0.18;
    ctx.strokeStyle = "#f9a8d4";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.14, r * 0.14 * open, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (open > 0.2) {
      ctx.fillStyle = "#ec4899";
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.055 * Math.min(open, 1.2), 0, Math.PI * 2);
      ctx.fill();
    }
    // cheek squint arcs (Duchenne marker)
    if (cheek > 0.15) {
      ctx.strokeStyle = `rgba(236,72,153,${clamp(cheek, 0, 0.8)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, ey + r * 0.2, r * 0.12, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  }

  // brows: inner end responds to browInnerUp / browDown, outer to browOuterUp
  ctx.strokeStyle = "#f472b6";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    const ix = cx + side * r * 0.2, ox = cx + side * r * 0.56;
    const baseY = cy - r * 0.42;
    const iy = baseY - browInnerUp * r * 0.2 + browDown * r * 0.16;
    const oy = baseY - browOuterUp * r * 0.16 + browDown * r * 0.02;
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.quadraticCurveTo((ix + ox) / 2, Math.min(iy, oy) - r * 0.05, ox, oy);
    ctx.stroke();
  }

  // nose + sneer wrinkles
  ctx.strokeStyle = "rgba(249,168,212,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.05);
  ctx.lineTo(cx - r * 0.05, cy + r * 0.14);
  ctx.stroke();
  if (sneer > 0.15) {
    ctx.strokeStyle = `rgba(236,72,153,${clamp(sneer, 0, 0.9)})`;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + side * r * 0.1, cy + r * (0.02 + i * 0.07));
        ctx.lineTo(cx + side * r * 0.22, cy + r * (-0.03 + i * 0.07));
        ctx.stroke();
      }
    }
  }

  // mouth
  const my = cy + r * 0.42;
  const mw = r * (0.34 + smile * 0.1 - press * 0.06);
  const cornerY = my + frown * r * 0.14 - smile * r * 0.1;
  const ctrlY = my + smile * r * 0.42 - frown * r * 0.32;
  ctx.strokeStyle = "#f472b6";
  ctx.lineWidth = 3.5;
  if (jawOpen > 0.18) {
    ctx.fillStyle = "rgba(236,72,153,0.22)";
    ctx.beginPath();
    ctx.ellipse(cx, my + jawOpen * r * 0.1, mw * 0.8, jawOpen * r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(cx - mw, cornerY);
    ctx.quadraticCurveTo(cx, ctrlY, cx + mw, cornerY);
    ctx.stroke();
  }
}