// ============================================================
// Screen 3 — dashboard: streak, 30-day trend, last 7 entries.
// ============================================================

let session = null;
let logs = [];          // last 30 days, ascending by date
let allLogs = null;     // every log, lazily fetched for the "All time" summary
let statsMode = "week"; // "week" | "all"
let chart = null;

(async () => {
  session = await requireSession();
  if (!session) return;
  await Promise.all([loadProfile(), loadLogs()]);
  renderChart();
  renderRecent();
  renderStats();
})();

async function loadProfile() {
  const { data } = await db.from("profiles")
    .select("streak_count, role").eq("id", session.user.id).single();
  document.getElementById("streak").textContent = data?.streak_count ?? 0;

  // Name + account type, shown under the "Home" heading.
  const name = session.user.user_metadata?.username || session.user.email;
  const role = data?.role ? data.role[0].toUpperCase() + data.role.slice(1) : "";
  document.getElementById("page-sub").textContent = role ? `${name} · ${role}` : name;
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

function setStatsMode(mode) {
  statsMode = mode;
  document.querySelectorAll("#stats-toggle .toggle-btn")
    .forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  renderStats();
}

async function renderStats() {
  const el = document.getElementById("week-stats");
  let set;

  if (statsMode === "week") {
    const since = new Date(); since.setDate(since.getDate() - 7);
    set = logs.filter(l => new Date(l.log_date + "T00:00:00") >= since);
  } else {
    // "All time" needs the full history, not just the 30-day window the chart uses.
    if (!allLogs) {
      el.innerHTML = "Loading…";
      const { data } = await db.from("logs").select("*").eq("user_id", session.user.id);
      allLogs = data || [];
    }
    set = allLogs;
  }

  if (!set.length) {
    el.innerHTML = statsMode === "week" ? "No sessions logged this week yet." : "No sessions logged yet.";
    return;
  }

  // Average over rows that actually have the value (skip nulls / rest days).
  const avg = k => {
    const vals = set.map(l => l[k]).filter(v => v != null);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : "–";
  };
  const mins = set.reduce((s, l) => s + (l.duration_minutes || 0), 0);
  el.innerHTML = `
    <div class="log-row"><span class="log-date">Sessions</span><span>${set.length}</span></div>
    <div class="log-row"><span class="log-date">Total time</span><span>${Math.floor(mins/60)}h ${mins%60}m</span></div>
    <div class="log-row"><span class="log-date">Avg confidence</span><span>${avg("confidence")}</span></div>
    <div class="log-row"><span class="log-date">Avg sleep</span><span>${avg("sleep_hours")}h</span></div>
  `;
}
