// ============================================================
// Ghosting — a squash footwork interval drill.
// The phone sits on the T. Each work interval the program shows an arrow to
// one of the six court areas (front/side/back × left/right); the player runs
// there, returns to the T, and taps the screen to get the next direction.
// Work intervals alternate with rests for a chosen number of sets.
//
// Timing is driven by requestAnimationFrame off real elapsed time so
// pause/resume is exact. Short beeps mark phase changes since the phone is on
// the floor and the player isn't always looking.
// ============================================================

// Redirect to login if signed out; the per-page role guard runs separately
// via loadTopbarUser() (js/supabase.js) on DOMContentLoaded.
(async () => { await requireSession(); })();

// Arrow rotation: 0deg points up = toward the front wall.
const DIRS = [
  { name: "Front left",  rot: -45 },
  { name: "Front right", rot: 45 },
  { name: "Side right",  rot: 90 },
  { name: "Back right",  rot: 135 },
  { name: "Back left",   rot: -135 },
  { name: "Side left",   rot: -90 },
];

let workSec = 30, restSec = 30, totalSets = 12;
let phase = "idle";        // 'idle' | 'work' | 'rest' | 'done'
let setIndex = 0;          // current set (1-based) while running
let phaseRemaining = 0;    // seconds left in the current phase
let reps = 0;              // completed runs (taps) this session
let lastDir = -1;          // avoid showing the same direction twice in a row
let running = false, rafId = null, lastTs = 0;

const config   = document.getElementById("ghost-config");
const workSel  = document.getElementById("work-sel");
const restSel  = document.getElementById("rest-sel");
const setsSel  = document.getElementById("sets-sel");
const stage    = document.getElementById("ghost-stage");
const arrow    = document.getElementById("ghost-arrow");
const label    = document.getElementById("ghost-label");
const hintEl   = document.getElementById("ghost-hint");
const chipPhase= document.getElementById("chip-phase");
const timerEl  = document.getElementById("ghost-timer");
const setEl    = document.getElementById("ghost-set");
const setsEl   = document.getElementById("ghost-sets");
const repsEl   = document.getElementById("ghost-reps");
const startBtn = document.getElementById("start-btn");

// ---- Audio cues -----------------------------------------------------------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq, dur, when = 0, gain = 0.28) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = "sine"; o.frequency.value = freq;
  const t = audioCtx.currentTime + when;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
const cueWork = () => beep(880, 0.16);                 // higher = go
const cueRest = () => beep(440, 0.28);                 // lower = rest
const cueTick = () => beep(1300, 0.05, 0, 0.18);       // soft tap tick
function cueDone() { beep(660, 0.14); beep(880, 0.14, 0.17); beep(1180, 0.24, 0.34); }

// ---- Helpers --------------------------------------------------------------
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function readConfig() {
  workSec   = Number(workSel.value);
  restSec   = Number(restSel.value);
  totalSets = Number(setsSel.value);
}

function setConfigDisabled(d) {
  config.classList.toggle("is-disabled", d);
  [workSel, restSel, setsSel].forEach(s => s.disabled = d);
}

function pickDir() {
  let i;
  do { i = Math.floor(Math.random() * DIRS.length); } while (i === lastDir);
  lastDir = i;
  return i;
}

function showArrow(i) {
  const d = DIRS[i];
  arrow.style.transform = "rotate(" + d.rot + "deg)";
  label.textContent = d.name;
}

function updateMeta() {
  timerEl.textContent = fmtTime(phaseRemaining);
  setEl.textContent   = setIndex;
  setsEl.textContent  = totalSets;
  repsEl.textContent  = reps;
}

// ---- Phase transitions ----------------------------------------------------
function enterWork() {
  phase = "work";
  phaseRemaining = workSec;
  stage.dataset.phase = "work";
  chipPhase.textContent = "Work";
  hintEl.textContent = "";
  lastDir = -1;
  showArrow(pickDir());   // first direction of the set (a run counts on tap)
  cueWork();
}

function enterRest() {
  phase = "rest";
  phaseRemaining = restSec;
  stage.dataset.phase = "rest";
  chipPhase.textContent = "Rest";
  label.textContent = "Rest";
  hintEl.textContent = "Next: set " + (setIndex + 1) + " of " + totalSets;
  cueRest();
}

function finish() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  phase = "done";
  phaseRemaining = 0;
  stage.dataset.phase = "done";
  chipPhase.textContent = "Done";
  label.textContent = "Done";
  hintEl.textContent = reps + " runs across " + totalSets + " sets — nice work.";
  startBtn.textContent = "Start";
  setConfigDisabled(false);
  updateMeta();
  cueDone();
}

// Advance when the current phase's timer runs out.
function advance() {
  if (phase === "work") {
    if (setIndex < totalSets) enterRest();
    else finish();
  } else if (phase === "rest") {
    setIndex++;
    enterWork();
  }
}

function frame(ts) {
  if (!running) return;
  if (!lastTs) lastTs = ts;
  phaseRemaining -= (ts - lastTs) / 1000;
  lastTs = ts;

  if (phaseRemaining <= 0) {
    phaseRemaining = 0;
    advance();
    if (!running) return;   // finish() stopped the loop
    updateMeta();
    rafId = requestAnimationFrame(frame);
    return;
  }
  updateMeta();
  rafId = requestAnimationFrame(frame);
}

// ---- Controls -------------------------------------------------------------
function start() {
  ensureAudio();
  running = true;
  lastTs = 0;
  startBtn.textContent = "Pause";
  setConfigDisabled(true);

  if (phase === "idle" || phase === "done") {
    readConfig();
    reps = 0;
    setIndex = 1;
    enterWork();
  }
  updateMeta();
  rafId = requestAnimationFrame(frame);
}

function pause() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  startBtn.textContent = "Resume";
}

function toggleRun() {
  if (running) pause();
  else start();
}

// Tap the screen after each run to get the next direction.
function tap() {
  if (!running || phase !== "work") return;
  reps++;
  repsEl.textContent = reps;
  showArrow(pickDir());
  cueTick();
}

function resetSession() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  phase = "idle";
  setIndex = 0;
  reps = 0;
  lastDir = -1;
  startBtn.textContent = "Start";
  setConfigDisabled(false);
  renderIdle();
}

// Idle / initial state, also refreshed when a dropdown changes.
function renderIdle() {
  readConfig();
  phase = "idle";
  phaseRemaining = workSec;
  stage.dataset.phase = "idle";
  chipPhase.textContent = "Idle";
  arrow.style.transform = "rotate(0deg)";
  label.textContent = "Ready";
  hintEl.textContent = "Place your phone on the T, then press start.";
  updateMeta();
}

// Changing a dropdown while idle updates the preview; ignored mid-session
// (the selects are disabled then anyway).
[workSel, restSel, setsSel].forEach(s => s.addEventListener("change", () => {
  if (phase === "idle") renderIdle();
}));

// Stop scheduled beeps if the player leaves the page mid-session.
window.addEventListener("pagehide", () => { if (audioCtx) audioCtx.close(); audioCtx = null; });

renderIdle();
