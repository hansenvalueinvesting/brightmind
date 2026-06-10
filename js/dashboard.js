// ============================================================
// Screen 3 — dashboard: streak, 30-day trend, last 7 entries.
// ============================================================

let session = null;
let logs = [];          // last 30 days, ascending by date
let chart = null;

(async () => {
  session = await requireSession();
  if (!session) return;
  await Promise.all([loadProfile(), loadLogs()]);
  renderChart();
  renderRecent();
  renderWeek();
})();

async function loadProfile() {
  const { data } = await db.from("profiles")
    .select("streak_count").eq("id", session.user.id).single();
  document.getElementById("streak").textContent = data?.streak_count ?? 0;
}

async function loadLogs() {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const { data } = await db.from("logs")
    .select("*").eq("user_id", session.user.id)
    .gte("log_date", since.toLocaleDateString("en-CA"))
    .order("log_date", { ascending: true });
  logs = data || [];
}

function renderChart() {
  const metric = document.getElementById("metric").value;
  const labels = logs.map(l => l.log_date.slice(5));   // MM-DD
  const values = logs.map(l => l[metric]);

  if (chart) chart.destroy();
  const ctx = document.getElementById("trendChart");

  if (!logs.length) {
    ctx.parentElement.innerHTML = '<div class="empty">No logs yet. Your trend appears once you start logging.</div>';
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: "#ffb000",
        backgroundColor: "rgba(255,176,0,0.08)",
        borderWidth: 2, tension: 0.3, fill: true,
        pointRadius: 3, pointBackgroundColor: "#ffb000",
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 10, grid: { color: "#2a323d" }, ticks: { color: "#8b96a5" } },
        x: { grid: { color: "#2a323d" }, ticks: { color: "#8b96a5", maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
      }
    }
  });
}

function renderRecent() {
  const el = document.getElementById("recent");
  const last7 = [...logs].reverse().slice(0, 7);
  if (!last7.length) { el.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
  el.innerHTML = last7.map(l => `
    <div class="log-row">
      <span class="log-date">${l.log_date}</span>
      <span class="log-type">${l.session_type}</span>
      <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
    </div>
  `).join("");
}

function renderWeek() {
  const el = document.getElementById("week-stats");
  const since = new Date(); since.setDate(since.getDate() - 7);
  const wk = logs.filter(l => new Date(l.log_date + "T00:00:00") >= since);
  if (!wk.length) { el.innerHTML = "No sessions logged this week yet."; return; }
  const avg = k => (wk.reduce((s, l) => s + (l[k] || 0), 0) / wk.length).toFixed(1);
  const mins = wk.reduce((s, l) => s + (l.duration_minutes || 0), 0);
  el.innerHTML = `
    <div class="log-row"><span class="log-date">Sessions</span><span>${wk.length}</span></div>
    <div class="log-row"><span class="log-date">Total time</span><span>${Math.floor(mins/60)}h ${mins%60}m</span></div>
    <div class="log-row"><span class="log-date">Avg confidence</span><span>${avg("confidence")}</span></div>
    <div class="log-row"><span class="log-date">Avg sleep</span><span>${avg("sleep_hours")}h</span></div>
  `;
}
