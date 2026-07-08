// ============================================================
// Winning point visualization — a short (~1 minute) guided mindset exercise.
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

const TOTAL = 60; // 60 seconds — short and tightly paced

// Scripted cues, sorted by start second. render() shows the last cue whose
// `at` has been reached. Kept close together (~8-14s apart) so the guidance
// stays continuous and there are no long, awkward silences.
const STAGES = [
  { at: 0,  title: "Settle in",          detail: "Close your eyes and take one slow breath." },
  { at: 8,  title: "On the court",       detail: "You're on court, ready — calm and sharp." },
  { at: 18, title: "The winning shot",   detail: "Feel the racket connect — a clean, perfect strike. The ball lands exactly where you aimed." },
  { at: 32, title: "Hear the crowd",     detail: "Cheers erupt around you. Clapping, voices calling your name." },
  { at: 44, title: "Celebrate",          detail: "The fist pump. The rush of emotion. Your cry of victory." },
  { at: 54, title: "Lock it in",         detail: "Breathe that winning feeling in — it's yours to keep." },
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
const soundBtn = document.getElementById("sound-btn");

// ---- Spoken guidance ------------------------------------------------------
// The player is told to close their eyes, so each cue is read aloud with the
// browser's built-in speech synthesis (no dependency). Speaking is triggered
// by the Start-button gesture, which satisfies browser autoplay rules.
const synth = window.speechSynthesis || null;
let voiceOn = true;          // toggled by the sound button
let lastSpokenIdx = -1;      // stage last spoken, so each cue is read once

function speak(text) {
  if (!voiceOn || !synth) return;
  synth.cancel();            // drop any in-flight utterance first
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;              // a touch slower for a calm, guided feel
  u.pitch = 1;
  synth.speak(u);
}

function stopSpeaking() { if (synth) synth.cancel(); }

// Sound toggle: mute cancels any speech; unmuting mid-session re-reads the
// current cue so the player isn't left without guidance.
function toggleVoice() {
  voiceOn = !voiceOn;
  soundBtn.textContent = voiceOn ? "🔊 Voice on" : "🔇 Voice off";
  soundBtn.setAttribute("aria-pressed", voiceOn ? "true" : "false");
  if (!voiceOn) { stopSpeaking(); return; }
  if (running) speak(cueText(STAGES[currentStageIdx()]));
}

function cueText(stage) { return stage.title + ". " + stage.detail; }

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Index of the last stage whose start second has been reached.
function currentStageIdx() {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (elapsed >= STAGES[i].at) idx = i; else break;
  }
  return idx;
}

// Draw the current running state from `elapsed`. Speaks a cue the first time
// its stage becomes active (once per transition).
function render() {
  const idx = currentStageIdx();
  const stage = STAGES[idx];
  titleEl.textContent = stage.title;
  detailEl.textContent = stage.detail;
  if (running && idx !== lastSpokenIdx) { lastSpokenIdx = idx; speak(cueText(stage)); }
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
  lastSpokenIdx = -1;   // (re)speak the current cue on start/resume
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
  stopSpeaking();
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
  speak("Complete. Carry that winning feeling into your next match.");
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
  lastSpokenIdx = -1;
  startBtn.textContent = "Start";
  stopSpeaking();
  renderIdle();
}

// Stop any narration if the player leaves the page mid-session.
window.addEventListener("pagehide", stopSpeaking);

renderIdle();
