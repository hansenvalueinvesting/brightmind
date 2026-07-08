// ============================================================
// Box breathing — a guided 4-4-4-4 breathing exercise.
// A marker travels clockwise around a square, one edge every 4 seconds:
//   Inhale  — up the left edge     (bottom-left -> top-left)
//   Hold    — across the top edge  (top-left    -> top-right)
//   Exhale  — down the right edge  (top-right   -> bottom-right)
//   Hold    — across the bottom    (bottom-right-> bottom-left)  ...repeat
// The session runs for a chosen total (1 / 3 / 5 min) and ends on the
// total countdown, even if that lands mid-cycle.
//
// The marker is driven by requestAnimationFrame off elapsed running time
// (not CSS transitions) so pause/resume is exact and positioning is precise.
// ============================================================

// Redirect to login if signed out; the per-page role guard runs separately
// via loadTopbarUser() (js/supabase.js) on DOMContentLoaded.
(async () => { await requireSession(); })();

const PHASES = ["Inhale", "Hold", "Exhale", "Hold"];
const PHASE_SECS = 4;
const CYCLE_SECS = PHASE_SECS * PHASES.length; // 16s per full square

// Skip the continuous glide for users who prefer reduced motion — the marker
// then snaps corner-to-corner at each phase change instead of sliding.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let totalSecs = 60;   // selected session length
let elapsed   = 0;    // accumulated running seconds
let running   = false;
let rafId     = null;
let lastTs    = 0;

const square    = document.getElementById("breathe-square");
const marker     = document.getElementById("breathe-marker");
const phaseEl    = document.getElementById("breathe-phase");
const countEl    = document.getElementById("breathe-count");
const remainEl   = document.getElementById("breathe-remaining");
const startBtn   = document.getElementById("start-btn");
const durToggle  = document.getElementById("duration-toggle");

// Marker centre (as % of the square) at fraction f (0..1) along the current
// clockwise edge. Only one of left/top changes per edge, so it stays on track.
function edgePosition(phaseIndex, f) {
  switch (phaseIndex) {
    case 0: return { left: 0,             top: 100 - f * 100 }; // up left edge
    case 1: return { left: f * 100,       top: 0 };             // across top
    case 2: return { left: 100,           top: f * 100 };       // down right edge
    default: return { left: 100 - f * 100, top: 100 };          // across bottom
  }
}

function placeMarker(phaseIndex, f) {
  const p = edgePosition(phaseIndex, f);
  marker.style.left = p.left + "%";
  marker.style.top  = p.top + "%";
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Draw the current running state from `elapsed`.
function render() {
  const cyclePos   = elapsed % CYCLE_SECS;
  const phaseIndex = Math.floor(cyclePos / PHASE_SECS);
  const tInPhase   = cyclePos % PHASE_SECS;
  const f = reduceMotion ? 0 : tInPhase / PHASE_SECS;

  placeMarker(phaseIndex, f);
  phaseEl.textContent = PHASES[phaseIndex];
  countEl.textContent = String(Math.max(1, Math.ceil(PHASE_SECS - tInPhase)));
  square.dataset.phase = PHASES[phaseIndex].toLowerCase();
  remainEl.textContent = fmtTime(totalSecs - elapsed) + " remaining";
}

// Idle state shown before start and after reset: marker parked at the
// bottom-left corner (where Inhale begins), no active phase.
function renderIdle() {
  placeMarker(0, 0);
  phaseEl.textContent = "Ready";
  countEl.textContent = "";
  square.dataset.phase = "ready";
  remainEl.textContent = fmtTime(totalSecs) + " total";
}

function frame(ts) {
  if (!running) return;
  if (!lastTs) lastTs = ts;
  elapsed += (ts - lastTs) / 1000;
  lastTs = ts;

  if (elapsed >= totalSecs) {
    elapsed = totalSecs;
    finish();
    return;
  }
  render();
  rafId = requestAnimationFrame(frame);
}

function start() {
  if (elapsed >= totalSecs) elapsed = 0; // restart after a completed session
  running = true;
  lastTs = 0;
  startBtn.textContent = "Pause";
  durToggle.classList.add("is-disabled");
  render();
  rafId = requestAnimationFrame(frame);
}

function pause() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  startBtn.textContent = "Resume";
  durToggle.classList.remove("is-disabled");
}

function finish() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  startBtn.textContent = "Start";
  durToggle.classList.remove("is-disabled");
  placeMarker(0, 0);
  phaseEl.textContent = "Complete";
  countEl.textContent = "✓";
  square.dataset.phase = "done";
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
  durToggle.classList.remove("is-disabled");
  renderIdle();
}

// Duration buttons are disabled mid-run; picking one otherwise resets the
// session to the new length.
function setDuration(mins) {
  if (running) return;
  totalSecs = mins * 60;
  durToggle.querySelectorAll(".toggle-btn")
    .forEach(b => b.classList.toggle("active", Number(b.dataset.min) === mins));
  resetSession();
}

renderIdle();
