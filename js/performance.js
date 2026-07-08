// ============================================================
// Composite daily "performance" score (non-match days).
//
// On a match day, performance is the athlete's own perf_rating and
// the call sites use it directly. On every other day there's no single
// self-rating, so we blend the day's wellness/execution metrics into
// one 0–10 value. That gives the Insights and roster charts a real
// performance signal instead of leaning on mood_after alone.
//
// How it works: each metric is converted to a 0–10 "goodness"
// sub-score (higher = better, regardless of the metric's raw
// direction), then combined as a weighted average. Metrics that
// weren't logged that day (e.g. no sleep entry) drop out and the
// remaining weights renormalise, so a sparse day still yields a fair,
// comparable score.
//
// Training load (intensity / duration) is intentionally excluded — a
// hard, long session isn't "worse performance", so folding it in would
// penalise effort.
// ============================================================

function clampScore(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// --- goodness transforms: raw metric -> 0–10, higher = better ---
function goodDirect(v)      { return v; }        // 1–10 slider, higher is better
function goodReverse(v)     { return 11 - v; }   // 1–10 slider, lower is better (stress, soreness)
function goodSleepHours(h)  { return clampScore(10 - 1.5 * Math.abs(h - 8), 0, 10); } // ~8h optimal, either side costs
function goodScreenTime(st) { return clampScore(10 - 1.5 * Math.max(0, st - 2), 0, 10); } // ≤2h is free, then penalised

// [ log column, weight, transform ]. Weights sum to 1 when every metric
// is present; missing ones are excluded and the rest renormalise.
const PERF_COMPONENTS = [
  ["mood_after",        0.20, goodDirect],
  ["confidence",        0.15, goodDirect],
  ["focus",             0.15, goodDirect],
  ["sleep_quality",     0.12, goodDirect],
  ["stress",            0.12, goodReverse],
  ["sleep_hours",       0.10, goodSleepHours],
  ["soreness",          0.08, goodReverse],
  ["screen_time_hours", 0.08, goodScreenTime],
];

// Weighted 0–10 performance score for a log row (sleep_hours /
// sleep_quality expected to already be merged on from sleep_entries).
// Returns null when none of the component metrics are present, so the
// point gets filtered out just like a missing self-rating would.
function computePerformance(log) {
  if (!log) return null;
  let acc = 0, wsum = 0;
  for (const [key, w, transform] of PERF_COMPONENTS) {
    const v = log[key];
    if (v == null || isNaN(v)) continue;
    acc += w * clampScore(transform(Number(v)), 0, 10);
    wsum += w;
  }
  if (wsum === 0) return null;
  return Math.round((acc / wsum) * 10) / 10;   // one decimal, 0–10
}
