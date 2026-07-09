// ============================================================
// Screen 4 — insights: sleep hours (X) vs performance (Y).
// Uses match-day perf_rating where available, else a composite daily
// performance score blended from that day's wellness/execution metrics
// (see performance.js) so the chart is meaningful before any matches.
// Computes Pearson r for the one-line insight.
// ============================================================

let session = null;
let logs = [];            // every log for this user, ascending by date
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
  attachSleep(logs, sleep || []);

  renderTrend();
  renderScatter();
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
