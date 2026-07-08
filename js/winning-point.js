// ============================================================
// Winning point visualization — a 3-minute guided mindset exercise.
// A calm cue script advances the player through picturing their winning
// point, hearing the crowd, and celebrating, while an ambient orb pulses
// and a progress bar fills.
//
// Driven by requestAnimationFrame off elapsed running time (same engine as
// js/box-breathing.js) so pause/resume is exact.
// ============================================================

// Redirect to login if signed out; the per-page role guard runs separately
// via loadTopbarUser() (js/supabase.js) on DOMContentLoaded.
(async () => { await requireSession(); })();

const TOTAL = 180; // 3 minutes

// Scripted cues, sorted by start second. render() shows the last cue whose
// `at` has been reached.
const STAGES = [
  { at: 0,   title: "Settle in",                 detail: "Close your eyes. Take a slow breath and let your shoulders drop." },
  { at: 20,  title: "Picture your winning point", detail: "Feel the racket connect with the ball — a clean, perfect strike — and watch the exact shot land right where you aimed." },
  { at: 75,  title: "Hear the crowd",            detail: "The cheers rise around you. Clapping, voices calling your name — let the sound fill the court." },
  { at: 125, title: "Celebrate it",              detail: "The fist pump. The rush of emotion. Your cry of victory as the point is yours." },
  { at: 170, title: "Hold the feeling",          detail: "Lock in this feeling of winning. Breathe it in, and carry it with you." },
];

// Skip the pulsing animation for users who prefer reduced motion.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let elapsed = 0;    // accumulated running seconds
let running = false;
let rafId   = null;
let lastTs  = 0;

const orb      = document.getElementById("viz-orb");
const titleEl  = document.getElementById("viz-title");
const detailEl = document.getElementById("viz-detail");
const barEl    = document.getElementById("viz-bar");
const remainEl = document.getElementById("viz-remaining");
const startBtn = document.getElementById("start-btn");

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function currentStage() {
  let stage = STAGES[0];
  for (const s of STAGES) { if (elapsed >= s.at) stage = s; else break; }
  return stage;
}

// Draw the current running state from `elapsed`.
function render() {
  const stage = currentStage();
  titleEl.textContent = stage.title;
  detailEl.textContent = stage.detail;
  barEl.style.width = Math.min(100, (elapsed / TOTAL) * 100) + "%";
  remainEl.textContent = fmtTime(TOTAL - elapsed) + " remaining";
}

// Idle state shown before start and after reset.
function renderIdle() {
  titleEl.textContent = "Ready";
  detailEl.textContent = "Press start, close your eyes, and follow along.";
  barEl.style.width = "0%";
  orb.classList.remove("playing");
  remainEl.textContent = fmtTime(TOTAL) + " total";
}

function frame(ts) {
  if (!running) return;
  if (!lastTs) lastTs = ts;
  elapsed += (ts - lastTs) / 1000;
  lastTs = ts;

  if (elapsed >= TOTAL) {
    elapsed = TOTAL;
    finish();
    return;
  }
  render();
  rafId = requestAnimationFrame(frame);
}

function start() {
  if (elapsed >= TOTAL) elapsed = 0; // restart after a completed session
  running = true;
  lastTs = 0;
  startBtn.textContent = "Pause";
  if (!reduceMotion) orb.classList.add("playing");
  render();
  rafId = requestAnimationFrame(frame);
}

function pause() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  startBtn.textContent = "Resume";
  orb.classList.remove("playing");
}

function finish() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  startBtn.textContent = "Start";
  orb.classList.remove("playing");
  titleEl.textContent = "Complete";
  detailEl.textContent = "Carry that winning feeling into your next match.";
  barEl.style.width = "100%";
  remainEl.textContent = "Nice work — session complete.";
}

function toggleRun() {
  if (running) pause();
  else start();
}

function resetSession() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  elapsed = 0;
  lastTs = 0;
  startBtn.textContent = "Start";
  renderIdle();
}

renderIdle();
