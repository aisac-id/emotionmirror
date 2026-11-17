import { initEngine, engineReady, detectFace } from "./engine.js";
import { EMOTIONS, extractFeatures, applyBaseline, scoreEmotions, classify, affect, smileScore, expressiveness, makeBaseline, DEFAULT_BASE, MoodTracker, FEATURE_KEYS } from "./emotion.js";
import { demoFrame, drawFace } from "./demo.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SVG = (p, c) => `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  load: SVG('<circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/>', "#f9a8d4"),
  ready: SVG('<ellipse cx="12" cy="12" rx="8" ry="9"/><path d="M9 10h.01M15 10h.01" stroke-width="2.6"/><path d="M9 14.5c.9 1.1 2 1.7 3 1.7s2.1-.6 3-1.7"/>', "#4ade80"),
  noface: SVG('<ellipse cx="12" cy="12" rx="8" ry="9" stroke-dasharray="3 3"/><path d="M9 15h6"/>', "#fbbf24"),
  pause: SVG('<path d="M9 5v14M15 5v14"/>', "#f9a8d4"),
};

export const EMO_COLORS = {
  JOY: "#fbbf24", SAD: "#60a5fa", ANGER: "#f87171", SURPRISE: "#a78bfa",
  FEAR: "#2dd4bf", DISGUST: "#a3e635", NEUTRAL: "#9ca3af",
};

// ---- sound ----
let actx = null;
function blip(freq, dur = 0.1, type = "sine", gain = 0.05) {
  if (!tune.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.03);
  } catch {}
}
const sfx = { ui: () => blip(660, 0.08), ready: () => { blip(523, 0.15); setTimeout(() => blip(784, 0.2), 110); }, emo: () => blip(880, 0.07, "triangle", 0.03), err: () => blip(220, 0.2, "square", 0.04) };

// ---- persistence ----
const TUNE_KEY = "em-tuning-v1";
const BASE_KEY = "em-baseline-v1";
const DEFAULT_TUNE = { sens: 1, smooth: 0.5, mirror: true, mesh: false, sound: true };
let tune = { ...DEFAULT_TUNE };
const store = {
  get(k) { return new Promise((res) => { try { chrome.storage.local.get([k], (o) => res(o[k])); } catch { res(null); } }); },
  set(k, v) { try { chrome.storage.local.set({ [k]: v }); } catch {} },
};

// ---- state ----
let srcKind = "demo", paused = false, ready = false;
let base = { ...DEFAULT_BASE }, calibrated = false;
let demoT = 0, lastTick = null;
let frames = 0, faceFrames = 0, fps = 0, fpsCount = 0, fpsT = 0, faceMs = 0;
let truth = null, lastFaceSeen = 0;
let smoothF = null;
let scores = null, probs = null, emotion = "NEUTRAL", confidence = 0;
let candidate = null, candidateN = 0;
let valence = 0, arousal = 0, smile = 0, expr = 0;
const mood = new MoodTracker();
let timeline = []; // {t, emotion}
let lastTimelinePush = 0;
let affectTrail = [];
let calibrating = false, calStart = 0, calSamples = [];
let events = [];
let stream = null;

// ---- log / toast ----
function addLog(kind, msg) {
  events.push({ t: Date.now(), kind, msg });
  if (events.length > 200) events.shift();
  const li = document.createElement("li");
  li.className = kind;
  const d = new Date();
  li.innerHTML = `<time>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}</time><b></b>`;
  li.querySelector("b").textContent = msg;
  $("log").prepend(li);
  while ($("log").children.length > 60) $("log").removeChild($("log").lastChild);
}
let toastTimer = null;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }
function fmtClock(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

// ---- static UI builders ----
function buildSpectrum() {
  const box = $("spectrum");
  for (const k of EMOTIONS) {
    const row = document.createElement("div");
    row.className = "spec-row"; row.id = "spec" + k;
    row.innerHTML = `<label>${k}</label><div class="spec-bar"><i style="background:${EMO_COLORS[k]}"></i></div><b>0%</b>`;
    box.appendChild(row);
  }
  const leg = $("legend");
  for (const k of EMOTIONS) {
    const s = document.createElement("span");
    s.innerHTML = `<i style="background:${EMO_COLORS[k]}"></i>${k}`;
    leg.appendChild(s);
  }
  const dw = $("dwell");
  for (const k of EMOTIONS) {
    const row = document.createElement("div");
    row.className = "dwell-row"; row.id = "dwell" + k;
    row.innerHTML = `<label>${k}</label><div class="dwell-bar"><i style="background:${EMO_COLORS[k]}"></i></div><b>0%</b>`;
    dw.appendChild(row);
  }
}

// ---- canvas helpers ----
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h };
}

function drawTimeline() {
  const cv = $("timeline"); const { w, h } = fitCanvas(cv);
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const now = performance.now();
  const windowMs = 120000;
  for (const p of timeline) {
    const x = w - ((now - p.t) / windowMs) * w;
    if (x < -6) continue;
    ctx.fillStyle = EMO_COLORS[p.emotion];
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, 8, Math.max(3, w * (500 / windowMs)) + 1, h - 16);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(249,168,212,0.25)";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function drawAffectPad() {
  const cv = $("affectPad"); const { w, h } = fitCanvas(cv);
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const pad = 14;
  const X = (v) => pad + ((v + 1) / 2) * (w - pad * 2);
  const Y = (a) => h - pad - a * (h - pad * 2);
  // grid
  ctx.strokeStyle = "rgba(249,168,212,0.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
  ctx.beginPath();
  ctx.moveTo(X(0), pad); ctx.lineTo(X(0), h - pad);
  ctx.moveTo(pad, Y(0.5)); ctx.lineTo(w - pad, Y(0.5));
  ctx.stroke();
  ctx.fillStyle = "rgba(185,138,168,0.7)";
  ctx.font = "8px Unbounded, sans-serif";
  ctx.fillText("pleasant", w - pad - 44, h - 3);
  ctx.fillText("unpleasant", pad, h - 3);
  ctx.fillText("high", pad + 2, pad + 8);
  // trail
  for (let i = 0; i < affectTrail.length; i++) {
    const p = affectTrail[i];
    ctx.globalAlpha = (i / affectTrail.length) * 0.5;
    ctx.fillStyle = "#ec4899";
    ctx.beginPath(); ctx.arc(X(p.v), Y(p.a), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // current dot
  ctx.fillStyle = "#f9a8d4";
  ctx.strokeStyle = "#ec4899";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(valence), Y(arousal), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

function drawMoodRing() {
  const cv = $("moodRing"); const { w, h } = fitCanvas(cv);
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2 + 6, r = Math.min(w, h) * 0.36;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.lineWidth = 10; ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(42,15,33,0.9)";
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  const v = mood.moodIndex;
  const col = v >= 60 ? "#fbbf24" : v >= 40 ? "#f9a8d4" : "#60a5fa";
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * clamp(v / 100, 0.01, 1)); ctx.stroke();
  ctx.fillStyle = col;
  ctx.font = "700 22px Unbounded, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(Math.round(v)), cx, cy + 8);
  ctx.font = "8px Unbounded, sans-serif";
  ctx.fillStyle = "rgba(185,138,168,0.9)";
  ctx.fillText("0–100", cx, cy + 24);
  ctx.textAlign = "left";
}

// ---- banner ----
function updateBanner() {
  const b = $("statusBanner");
  if (!ready) { b.className = "status-banner"; $("statusIcon").innerHTML = ICONS.load; $("statusTitle").textContent = "Loading engine"; $("statusHint").textContent = "Initialising FaceLandmarker blendshapes (CPU, WASM)…"; return; }
  if (paused) { b.className = "status-banner"; $("statusIcon").innerHTML = ICONS.pause; $("statusTitle").textContent = "Paused"; $("statusHint").textContent = "The mirror is frozen."; return; }
  if (srcKind === "webcam" && performance.now() - lastFaceSeen > 1500) {
    b.className = "status-banner warn"; $("statusIcon").innerHTML = ICONS.noface;
    $("statusTitle").textContent = "No face detected"; $("statusHint").textContent = "Move into the frame so the mirror can read your expression."; return;
  }
  b.className = "status-banner ready"; $("statusIcon").innerHTML = ICONS.ready;
  $("statusTitle").textContent = emotion === "NEUTRAL" ? "Calm & neutral" : `Reading: ${emotion.toLowerCase()}`;
  $("statusHint").textContent = `confidence ${Math.round(confidence * 100)}% · mood index ${Math.round(mood.moodIndex)} · everything stays on this device`;
}

// ---- core processing ----
function process(blend, truthLabel, now) {
  const raw = extractFeatures(blend);
  if (calibrating) calSamples.push(raw);
  const f = applyBaseline(raw, base, tune.sens);
  // EMA smoothing per feature
  if (!smoothF) smoothF = { ...f };
  const alpha = 1 - tune.smooth;
  for (const k of FEATURE_KEYS) smoothF[k] += (f[k] - smoothF[k]) * alpha;

  scores = scoreEmotions(smoothF);
  const c = classify(scores);
  probs = c.probs;
  // 4-frame stability gate
  if (c.emotion === candidate) candidateN++;
  else { candidate = c.emotion; candidateN = 1; }
  if (candidateN >= 4 && c.emotion !== emotion) {
    emotion = c.emotion;
    addLog("info", `Expression → ${emotion}`);
    sfx.emo();
  }
  confidence = probs[emotion] || c.confidence;

  const a = affect(smoothF);
  valence = a.valence; arousal = a.arousal;
  smile = smileScore(smoothF);
  expr = expressiveness(smoothF);
  mood.push(emotion, valence, raw.eyeBlink, now);
  affectTrail.push({ v: valence, a: arousal });
  if (affectTrail.length > 60) affectTrail.shift();
  if (now - lastTimelinePush >= 500) {
    lastTimelinePush = now;
    timeline.push({ t: now, emotion });
    if (timeline.length > 260) timeline.shift();
  }
  truth = truthLabel;
}

function clearReading() {
  scores = null; probs = null; smoothF = null;
  candidate = null; candidateN = 0;
  confidence = 0;
  truth = null;
}

// ---- tick ----
function tick() {
  const now = performance.now();
  if (lastTick === null) lastTick = now;
  const dt = now - lastTick;
  lastTick = now;
  if (!ready || paused) return;

  // fps counter
  fpsCount++;
  if (now - fpsT >= 1000) { fps = fpsCount; fpsCount = 0; fpsT = now; }

  if (srcKind === "demo") {
    demoT += dt;
    const { blend, truth: tr } = demoFrame(demoT);
    const cv = $("face"); const { w, h } = fitCanvas(cv);
    drawFace(cv.getContext("2d"), w, h, blend);
    process(blend, tr, now);
    frames++; faceFrames++;
  } else {
    const video = $("video");
    if (video.readyState >= 2) {
      const { blend, lm, ms } = detectFace(video, now);
      faceMs = faceMs * 0.9 + ms * 0.1;
      frames++;
      if (blend) {
        faceFrames++; lastFaceSeen = now;
        process(blend, null, now);
        if (tune.mesh && lm) drawMesh(lm);
        else $("overlay").getContext("2d").clearRect(0, 0, $("overlay").width, $("overlay").height);
      } else if (now - lastFaceSeen > 1500) {
        clearReading();
      }
    }
  }

  // calibration window
  if (calibrating) {
    const el = now - calStart;
    $("calFill").style.width = clamp((el / 3000) * 100, 0, 100) + "%";
    if (el >= 3000) finishCal();
  }

  updateUI(now);
}

function drawMesh(lm) {
  const cv = $("overlay"); const video = $("video");
  if (cv.width !== video.videoWidth) { cv.width = video.videoWidth; cv.height = video.videoHeight; }
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(236,72,153,0.55)";
  for (let i = 0; i < lm.length; i += 4) {
    ctx.fillRect(lm[i].x * cv.width - 1, lm[i].y * cv.height - 1, 2, 2);
  }
}

// ---- UI refresh ----
function updateUI(now) {
  $("pillFps").textContent = "FPS " + fps;
  $("pillMood").textContent = "MOOD " + Math.round(mood.moodIndex);
  $("emoName").textContent = emotion;
  $("emoName").style.color = EMO_COLORS[emotion];
  $("emoConfPct").textContent = Math.round(confidence * 100) + "%";
  $("emoConfFill").style.width = Math.round(confidence * 100) + "%";
  $("truthChip").hidden = srcKind !== "demo";
  if (srcKind === "demo") $("truthChip").textContent = "TRUTH: " + (truth || "–");
  $("noFaceVeil").hidden = !(srcKind === "webcam" && now - lastFaceSeen > 1500);
  if (srcKind === "webcam") $("srcNote").textContent = `Live · face ${Math.round(faceMs)}ms · ${fps} fps`;

  for (const k of EMOTIONS) {
    const p = probs ? probs[k] : 0;
    const row = $("spec" + k);
    row.classList.toggle("top", k === emotion);
    row.querySelector("i").style.width = Math.round(p * 100) + "%";
    row.querySelector("b").textContent = Math.round(p * 100) + "%";
    const pct = mood.dwellPct()[k];
    const dr = $("dwell" + k);
    dr.querySelector("i").style.width = Math.round(pct) + "%";
    dr.querySelector("b").textContent = Math.round(pct) + "%";
  }

  $("stDom").textContent = mood.dominant();
  $("stDom").style.color = EMO_COLORS[mood.dominant()];
  $("stMood").textContent = Math.round(mood.moodIndex);
  $("stSmile").textContent = Math.round(smile);
  $("stTrans").textContent = mood.transitions;
  $("stExpr").textContent = Math.round(expr);
  $("stTime").textContent = fmtClock(mood.totalMs / 1000);
  $("moodLabel").textContent = mood.moodIndex >= 65 ? "bright mood" : mood.moodIndex >= 40 ? "balanced mood" : "low mood";
  const bs = mood.bestStreak;
  $("streakInfo").textContent = bs.emotion ? `Longest streak: ${bs.emotion} ${(bs.ms / 1000).toFixed(1)}s` : "Longest streak: –";
  $("blinkInfo").textContent = "Blinks: " + mood.blinks;

  drawTimeline();
  drawAffectPad();
  drawMoodRing();
  updateBanner();
}

// ---- calibration ----
function startCal() {
  if (!ready || calibrating) return;
  if (srcKind === "webcam" && performance.now() - lastFaceSeen > 1500) { toast("No face — calibration needs your face in frame"); return; }
  calibrating = true; calStart = performance.now(); calSamples = [];
  $("calVeil").hidden = false;
  addLog("info", "Neutral calibration started (3s)");
  sfx.ui();
}
function finishCal() {
  calibrating = false;
  $("calVeil").hidden = true;
  if (calSamples.length >= 10) {
    base = makeBaseline(calSamples);
    calibrated = true;
    store.set(BASE_KEY, base);
    const top = Object.entries(base).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
    $("calInfo").textContent = `Calibrated · n=${calSamples.length}${top ? " · offsets: " + top : ""}`;
    addLog("good", `Baseline captured (${calSamples.length} samples)`);
    toast("Neutral baseline saved");
    sfx.ready();
  } else {
    addLog("alert", `Calibration failed: only ${calSamples.length} samples`);
    toast("Calibration failed — keep your face in frame");
    sfx.err();
  }
}

// ---- sources ----
function useDemo() {
  stopWebcam();
  srcKind = "demo";
  $("btnDemo").classList.add("active"); $("btnWebcam").classList.remove("active");
  $("video").hidden = true; $("face").hidden = false; $("overlay").hidden = true;
  $("srcNote").textContent = "Synthetic 30s expression cycle · no camera";
  clearReading();
  addLog("info", "Demo face selected");
  sfx.ui();
}
async function useWebcam() {
  if (!ready) { toast("Engine still loading…"); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    srcKind = "webcam";
    lastFaceSeen = performance.now();
    $("btnWebcam").classList.add("active"); $("btnDemo").classList.remove("active");
    $("video").hidden = false; $("face").hidden = true; $("overlay").hidden = false;
    video.classList.toggle("mirrored", tune.mirror);
    $("overlay").classList.toggle("mirrored", tune.mirror);
    clearReading();
    addLog("good", "Webcam started (on-device only)");
    sfx.ui();
  } catch (e) {
    addLog("alert", "Camera unavailable: " + (e.name || e.message || e));
    toast("Camera unavailable");
    sfx.err();
  }
}
function stopWebcam() {
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  $("video").srcObject = null;
}
function togglePause() {
  paused = !paused;
  $("pauseVeil").hidden = !paused;
  $("btnPause").textContent = paused ? "RESUME" : "PAUSE";
  addLog("info", paused ? "Paused" : "Resumed");
  sfx.ui();
  updateBanner();
}

// ---- report ----
function exportReport() {
  const obj = {
    app: "EmotionMirror", version: "1.0.0", generated: new Date().toISOString(),
    sessionSec: Math.round(mood.totalMs / 1000),
    moodIndex: Math.round(mood.moodIndex),
    dominant: mood.dominant(),
    dwellPct: Object.fromEntries(Object.entries(mood.dwellPct()).map(([k, v]) => [k, +v.toFixed(1)])),
    transitions: mood.transitions,
    longestStreak: mood.bestStreak.emotion ? { emotion: mood.bestStreak.emotion, sec: +(mood.bestStreak.ms / 1000).toFixed(1) } : null,
    blinks: mood.blinks,
    smileScore: Math.round(smile),
    calibrated, source: srcKind,
  };
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "emotionmirror-session.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Session report exported");
  addLog("info", "Session report exported");
}
function resetSession() {
  mood.reset(); timeline = []; affectTrail = [];
  addLog("info", "Session reset");
  toast("Session reset");
  sfx.ui();
}

// ---- bindings ----
function bind() {
  $("btnDemo").onclick = useDemo;
  $("btnWebcam").onclick = useWebcam;
  $("btnPause").onclick = togglePause;
  $("btnCal").onclick = startCal;
  $("btnReport").onclick = exportReport;
  $("btnReset").onclick = resetSession;
  $("tSens").oninput = (e) => { tune.sens = +e.target.value; $("vSens").textContent = tune.sens.toFixed(1) + "×"; store.set(TUNE_KEY, tune); };
  $("tSmooth").oninput = (e) => { tune.smooth = +e.target.value; $("vSmooth").textContent = tune.smooth.toFixed(2); store.set(TUNE_KEY, tune); };
  $("tMirror").onchange = (e) => { tune.mirror = e.target.checked; $("video").classList.toggle("mirrored", tune.mirror); $("overlay").classList.toggle("mirrored", tune.mirror); store.set(TUNE_KEY, tune); };
  $("tMesh").onchange = (e) => { tune.mesh = e.target.checked; store.set(TUNE_KEY, tune); if (!tune.mesh) $("overlay").getContext("2d").clearRect(0, 0, $("overlay").width, $("overlay").height); };
  $("btnSound").onclick = () => { tune.sound = !tune.sound; $("btnSound").textContent = tune.sound ? "SOUND ON" : "SOUND OFF"; store.set(TUNE_KEY, tune); if (tune.sound) sfx.ui(); };
  $("btnClearLog").onclick = () => { $("log").innerHTML = ""; events = []; sfx.ui(); };
  $("btnHelp").onclick = () => { $("helpModal").hidden = false; sfx.ui(); };
  $("btnCloseHelp").onclick = () => { $("helpModal").hidden = true; sfx.ui(); };
  $("helpModal").onclick = (e) => { if (e.target === $("helpModal")) $("helpModal").hidden = true; };
}

// ---- boot ----
async function boot() {
  buildSpectrum();
  bind();
  const [saved, savedBase] = await Promise.all([store.get(TUNE_KEY), store.get(BASE_KEY)]);
  if (saved) tune = { ...DEFAULT_TUNE, ...saved };
  if (savedBase) { base = { ...DEFAULT_BASE, ...savedBase }; calibrated = true; $("calInfo").textContent = "Calibrated baseline restored from storage."; }
  $("tSens").value = tune.sens; $("vSens").textContent = tune.sens.toFixed(1) + "×";
  $("tSmooth").value = tune.smooth; $("vSmooth").textContent = tune.smooth.toFixed(2);
  $("tMirror").checked = tune.mirror;
  $("tMesh").checked = tune.mesh;
  $("btnSound").textContent = tune.sound ? "SOUND ON" : "SOUND OFF";
  addLog("info", "EmotionMirror started");
  updateBanner();
  setInterval(tick, 33);
  try {
    await initEngine();
    ready = true;
    $("pillEngine").textContent = "ENGINE READY";
    $("pillEngine").classList.add("ok");
    addLog("good", "FaceLandmarker ready (52 blendshapes, CPU)");
    sfx.ready();
    updateBanner();
  } catch (e) {
    $("pillEngine").textContent = "ENGINE FAILED";
    $("pillEngine").classList.add("warn");
    addLog("alert", "Engine init failed: " + (e.message || e));
    toast("Engine failed to load");
  }
}

window.__em = {
  get ready() { return ready; },
  get engineReady() { return engineReady(); },
  get srcKind() { return srcKind; },
  get paused() { return paused; },
  get truth() { return truth; },
  get emotion() { return emotion; },
  get confidence() { return confidence; },
  get scores() { return scores; },
  get probs() { return probs; },
  get valence() { return valence; },
  get arousal() { return arousal; },
  get smile() { return smile; },
  get expressiveness() { return expr; },
  get moodIndex() { return mood.moodIndex; },
  get dominant() { return mood.dominant(); },
  get transitions() { return mood.transitions; },
  get dwell() { return mood.dwellPct(); },
  get blinks() { return mood.blinks; },
  get bestStreak() { return mood.bestStreak; },
  get frames() { return frames; },
  get faceFrames() { return faceFrames; },
  get fps() { return fps; },
  get faceMs() { return faceMs; },
  get calibrated() { return calibrated; },
  get base() { return base; },
  get tune() { return tune; },
  get events() { return events; },
  get demoT() { return demoT; },
  useDemo, useWebcam, startCal, togglePause, exportReport, resetSession,
  setTune(patch) { Object.assign(tune, patch); },
};

boot();