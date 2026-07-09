// ============================================================
// Training — index of guided mental/physical activities, plus a tracking
// summary at the top: all-time / today / last-30-day session counts and a
// last-7-days stacked bar broken down by activity type. Rows come from the
// training_sessions table, written by each activity on completion
// (see logTrainingSession in js/supabase.js).
// ============================================================

// Activity display metadata. `key` matches the `activity` column values.
const ACTIVITIES = [
  { key: "box_breathing", label: "Box breathing",  color: "#ffb000" },
  { key: "winning_point", label: "Winning point",  color: "#58a6ff" },
  { key: "ghosting",      label: "Ghosting",        color: "#3fb950" },
];

(async () => {
  const session = await requireSession();
  if (session) loadStats(session.user.id);
})();

// A completed_at timestamp -> its local calendar day (YYYY-MM-DD), matching the
// local-day convention used elsewhere (effectiveStreak in js/supabase.js).
const localDay = ts => new Date(ts).toLocaleDateString("en-CA");

async function loadStats(uid) {
  let rows = [];
  try {
    const { data, error } = await db.from("training_sessions")
      .select("activity, completed_at")
      .eq("user_id", uid);
    if (!error && data) rows = data;
  } catch (_) { /* leave rows empty */ }

  const now = Date.now();
  const todayStr = new Date().toLocaleDateString("en-CA");
  const ms30 = 30 * 86400000;

  const all    = rows.length;
  const today  = rows.filter(r => localDay(r.completed_at) === todayStr).length;
  const last30 = rows.filter(r => (now - new Date(r.completed_at).getTime()) < ms30).length;

  document.getElementById("stat-all").textContent   = all;
  document.getElementById("stat-today").textContent = today;
  document.getElementById("stat-30").textContent    = last30;

  // Build the last 7 day buckets, oldest -> today.
  const base = new Date(todayStr + "T00:00:00");
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    days.push({
      key: d.toLocaleDateString("en-CA"),
      label: d.toLocaleDateString("en-US", { weekday: "short" }),
      counts: {},
    });
  }
  const byKey = {};
  days.forEach(d => (byKey[d.key] = d));
  for (const r of rows) {
    const d = byKey[localDay(r.completed_at)];
    if (d) d.counts[r.activity] = (d.counts[r.activity] || 0) + 1;
  }

  if (all === 0) {
    document.getElementById("train-chart-box").classList.add("section-hidden");
    document.getElementById("train-empty").classList.remove("section-hidden");
    return;
  }
  renderChart(days);
}

function renderChart(days) {
  const datasets = ACTIVITIES.map(a => ({
    label: a.label,
    data: days.map(d => d.counts[a.key] || 0),
    backgroundColor: a.color,
    borderWidth: 0,
    stack: "sessions",
    maxBarThickness: 48,
  }));

  new Chart(document.getElementById("trainChart"), {
    type: "bar",
    data: { labels: days.map(d => d.label), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#8b96a5", boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: "#8b96a5" } },
        y: { stacked: true, beginAtZero: true,
             ticks: { color: "#8b96a5", precision: 0, stepSize: 1 },
             grid: { color: "#2a323d" } },
      },
    },
  });
}
