// ============================================================
// Screen 4 — insights: sleep hours (X) vs performance (Y).
// Uses match-day perf_rating where available, else a composite daily
// performance score blended from that day's wellness/execution metrics
// (see performance.js) so the chart is meaningful before any matches.
// Computes Pearson r for the one-line insight.
// ============================================================

let session = null;
let logs = [];            // every log for this user, ascending by date
let sleepEntries = [];    // once-a-day sleep rows (raw, for the sleep recommendation)
let trendRange = "30";    // trends: "30" | "all"

(async () => {
  session = await requireSession();
  if (session) load();
})();

async function load() {
  // Sleep now lives in its own once-a-day table; pull it alongside the logs and
  // merge by date (attachSleep). Fall back to any legacy sleep on old log rows.
  const [{ data: logData }, { data: sleep }] = await Promise.all([
    db.from("logs").select("*")
      .eq("user_id", session.user.id)
      .order("log_date", { ascending: true }),
    db.from("sleep_entries").select("*").eq("user_id", session.user.id),
  ]);
  logs = logData || [];
  sleepEntries = sleep || [];
  attachSleep(logs, sleepEntries);

  renderRecommendations();
  renderTrend();
  renderScatter();
}

// ============================================================
// Recommendations — actionable alerts computed from recent logs.
//
// Each rule watches a *trailing run*: the number of consecutive calendar
// days (ending at the most recent entry) whose value crosses a threshold.
// A missing day or a day that breaks the threshold ends the run, and a
// rule only fires when its run is still current (anchored within the last
// couple of days) so stale history doesn't nag. Rules, roughly:
//   • Overtraining — 4h+ of activity for 5+ days straight → take a rest
//   • Under-active — under 1h for 3+ days straight → do more
//   • Under-slept  — under 7h of sleep for 3+ days straight → sleep more
//   • Sore         — soreness 8+ for 3+ days straight → prioritise recovery
// ============================================================

const REC = {
  OVERTRAIN_MINS: 240, OVERTRAIN_DAYS: 5,   // 4h+ for 5+ days
  UNDERACTIVE_MINS: 60, UNDERACTIVE_DAYS: 3, // <1h for 3+ days
  LOW_SLEEP_HOURS: 7,   LOW_SLEEP_DAYS: 3,   // <7h for 3+ days
  SORE_LEVEL: 8,        SORE_DAYS: 3,        // soreness 8+ for 3+ days
  STALE_DAYS: 2,        // a run must reach within this many days of today to fire
};

const todayStr = () => new Date().toLocaleDateString("en-CA");

// Whole calendar days from a -> b (both "YYYY-MM-DD"), positive when b is later.
function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

// Length of the run of consecutive calendar days ending at the most recent
// date in `byDate` whose value satisfies `ok`. A calendar gap or a failing
// day stops the count. Returns { run, anchor } where anchor is that most
// recent date (null when there's no data).
function trailingRun(byDate, ok) {
  const dates = Object.keys(byDate).sort().reverse();  // most recent first
  let run = 0, prev = null, anchor = dates[0] || null;
  for (const d of dates) {
    if (prev !== null && daysBetween(d, prev) !== 1) break;  // gap in the calendar
    if (!ok(byDate[d])) break;
    run++;
    prev = d;
  }
  return { run, anchor };
}

// A run only counts if it's still current — its most recent day is within
// STALE_DAYS of today. Otherwise it's old history, not an alert.
function isCurrent(anchor) {
  return anchor != null && daysBetween(anchor, todayStr()) <= REC.STALE_DAYS;
}

function buildRecommendations() {
  // Total logged activity minutes per calendar day (multiple sessions sum).
  const actByDate = {};
  for (const l of logs) {
    actByDate[l.log_date] = (actByDate[l.log_date] || 0) + (Number(l.duration_minutes) || 0);
  }
  // Worst (highest) soreness logged each day.
  const soreByDate = {};
  for (const l of logs) {
    if (l.soreness != null) {
      soreByDate[l.log_date] = Math.max(soreByDate[l.log_date] ?? 0, Number(l.soreness));
    }
  }
  // Sleep hours per night, straight from the sleep entries.
  const sleepByDate = {};
  for (const s of sleepEntries) {
    if (s.sleep_hours != null) sleepByDate[s.entry_date] = Number(s.sleep_hours);
  }

  const recs = [];

  const over = trailingRun(actByDate, m => m >= REC.OVERTRAIN_MINS);
  if (over.run >= REC.OVERTRAIN_DAYS && isCurrent(over.anchor)) {
    recs.push({
      kind: "warn", icon: "🛑", title: "Time to take a rest",
      body: `You've logged 4+ hours of activity ${over.run} days in a row. Sustained heavy load without a break raises your injury and burnout risk — schedule a lighter or full rest day soon.`,
    });
  }

  const sore = trailingRun(soreByDate, v => v >= REC.SORE_LEVEL);
  if (sore.run >= REC.SORE_DAYS && isCurrent(sore.anchor)) {
    recs.push({
      kind: "danger", icon: "🩹", title: "Give your body a break",
      body: `Your soreness has been high (${REC.SORE_LEVEL}+/10) for ${sore.run} days straight. Prioritise recovery — sleep, mobility and an easy day — before pushing hard again.`,
    });
  }

  const under = trailingRun(actByDate, m => m < REC.UNDERACTIVE_MINS);
  if (under.run >= REC.UNDERACTIVE_DAYS && isCurrent(under.anchor)) {
    recs.push({
      kind: "info", icon: "🏃", title: "Time to get moving",
      body: `You've logged under an hour of activity ${under.run} days in a row. A bit more training this week will keep your momentum — even a short session counts.`,
    });
  }

  const sleep = trailingRun(sleepByDate, h => h < REC.LOW_SLEEP_HOURS);
  if (sleep.run >= REC.LOW_SLEEP_DAYS && isCurrent(sleep.anchor)) {
    recs.push({
      kind: "danger", icon: "🌙", title: "Get more sleep",
      body: `You've slept under 7 hours ${sleep.run} nights in a row. Sleep is one of the biggest drivers of performance and recovery — aim for 8+ hours tonight.`,
    });
  }

  return recs;
}

// Render the recommendation cards (or a positive "all clear" state).
function renderRecommendations() {
  const box = document.getElementById("rec-list");
  if (!box) return;

  if (!logs.length && !sleepEntries.length) {
    box.innerHTML = '<div class="empty">Start logging to see your recommendations.</div>';
    return;
  }

  const recs = buildRecommendations();
  if (!recs.length) {
    box.innerHTML = recCard({
      kind: "good", icon: "✅", title: "You're in a good rhythm",
      body: "Nothing to flag from your recent logs — training load, activity and sleep all look balanced. Keep it up.",
    });
    return;
  }
  box.innerHTML = recs.map(recCard).join("");
}

function recCard(r) {
  return `
    <div class="rec-card ${r.kind}">
      <div class="rec-icon" aria-hidden="true">${r.icon}</div>
      <div>
        <div class="rec-title">${r.title}</div>
        <div class="rec-body">${r.body}</div>
      </div>
    </div>`;
}

// ---------- Trends (all metrics at once) — moved here from the dashboard ----------
function setTrendRange(range) {
  trendRange = range;
  toggleActive("#trend-toggle", range, "range");
  renderTrend();
}

function renderTrend() {
  const box = document.getElementById("trend-box");
  const set = trendRange === "all" ? logs : rangeSlice(logs, 30);
  if (!set.length) {
    box.innerHTML = '<div class="empty">No logs yet. Your trends appear once you start logging.</div>';
    return;
  }
  box.innerHTML = '<canvas id="trendChart"></canvas>';
  multiLineChart("trendChart", set.map(l => l.log_date.slice(5)), k => set.map(l => l[k]));
}

// ---------- Sleep vs. performance scatter ----------
function renderScatter() {
  // Build points: need sleep hours (X) + a performance value (Y). On a match
  // day use the self-rating; otherwise the composite daily performance score.
  const points = logs
    .map(l => ({
      x: l.sleep_hours,
      y: l.is_match_day && l.perf_rating != null ? l.perf_rating : computePerformance(l)
    }))
    .filter(p => p.x != null && p.y != null);

  const headline = document.getElementById("headline");

  if (points.length < 3) {
    headline.textContent = "Log at least 3 days with sleep recorded to see your sleep–performance relationship.";
    return;
  }

  const r = pearson(points.map(p => p.x), points.map(p => p.y));
  headline.innerHTML = interpret(r);

  new Chart(document.getElementById("scatter"), {
    type: "scatter",
    data: {
      datasets: [{
        data: points,
        backgroundColor: "#ffb000",
        pointRadius: 6, pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.parsed.x}h sleep → perf ${c.parsed.y}` } }
      },
      scales: {
        x: { title: { display: true, text: "Sleep hours", color: "#8b96a5" },
             grid: { color: "#2a323d" }, ticks: { color: "#8b96a5" } },
        y: { min: 0, max: 10, title: { display: true, text: "Performance", color: "#8b96a5" },
             grid: { color: "#2a323d" }, ticks: { color: "#8b96a5" } }
      }
    }
  });
}

// Pearson correlation coefficient.
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
}

// Show/hide the "About this insight" popup.
function toggleInfo(show) {
  const m = document.getElementById("info-modal");
  if (!m) return;
  m.classList.toggle("section-hidden", !show);
  document.body.style.overflow = show ? "hidden" : "";
}

document.addEventListener("keydown", e => {
  const m = document.getElementById("info-modal");
  if (e.key === "Escape" && m && !m.classList.contains("section-hidden")) toggleInfo(false);
});

function interpret(r) {
  const mag = Math.abs(r);
  const strength = mag < 0.2 ? "little to no" : mag < 0.4 ? "a weak" : mag < 0.6 ? "a moderate" : "a strong";
  const dir = r > 0 ? "more sleep tracks with better performance" : "more sleep tracks with worse performance";
  const note = mag < 0.2 ? "No clear link in your data yet — keep logging." : `On your logs so far, ${dir}.`;
  return `Correlation r = <b style="color:#ffb000">${r.toFixed(2)}</b> — ${strength} relationship. ${note}`;
}
