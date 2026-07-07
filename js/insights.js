// ============================================================
// Screen 4 — insights: sleep hours (X) vs self-rated performance (Y).
// Uses match-day perf_rating where available, else mood_after as the
// general performance proxy so the chart is useful before any matches.
// Computes Pearson r for the one-line insight.
// ============================================================

let session = null;

(async () => {
  session = await requireSession();
  if (session) load();
})();

async function load() {
  // Sleep now lives in its own once-a-day table; pull it alongside the logs and
  // match by date. Fall back to any legacy sleep_hours still on old log rows.
  const [{ data }, { data: sleep }] = await Promise.all([
    db.from("logs")
      .select("log_date, sleep_hours, perf_rating, mood_after, is_match_day")
      .eq("user_id", session.user.id),
    db.from("sleep_entries")
      .select("entry_date, sleep_hours")
      .eq("user_id", session.user.id),
  ]);

  const sleepByDate = {};
  for (const s of (sleep || [])) sleepByDate[s.entry_date] = s.sleep_hours;

  // Build points: need sleep + a performance value.
  const points = (data || [])
    .map(l => ({
      x: sleepByDate[l.log_date] != null ? sleepByDate[l.log_date] : l.sleep_hours,
      y: l.is_match_day && l.perf_rating != null ? l.perf_rating : l.mood_after
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
        y: { min: 0, max: 10, title: { display: true, text: "Performance (self-rated)", color: "#8b96a5" },
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

function interpret(r) {
  const mag = Math.abs(r);
  const strength = mag < 0.2 ? "little to no" : mag < 0.4 ? "a weak" : mag < 0.6 ? "a moderate" : "a strong";
  const dir = r > 0 ? "more sleep tracks with better performance" : "more sleep tracks with worse performance";
  const note = mag < 0.2 ? "No clear link in your data yet — keep logging." : `On your logs so far, ${dir}.`;
  return `Correlation r = <b style="color:#ffb000">${r.toFixed(2)}</b> — ${strength} relationship. ${note}`;
}
