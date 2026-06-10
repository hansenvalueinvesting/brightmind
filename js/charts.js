// ============================================================
// Shared charting + stats helpers (used by dashboard.js and coach.js).
// Loaded after the Chart.js CDN and before the page scripts.
// ============================================================

// The slider metrics we trend. Each gets a distinct line colour.
const METRICS = [
  { key: "confidence",    label: "Confidence",    color: "#ffb000" },
  { key: "focus",         label: "Focus",         color: "#3fb950" },
  { key: "stress",        label: "Stress",        color: "#f85149" },
  { key: "sleep_quality", label: "Sleep quality", color: "#58a6ff" },
  { key: "soreness",      label: "Soreness",      color: "#bc8cff" },
  { key: "intensity",     label: "Intensity",     color: "#ff9e64" },
  { key: "mood_after",    label: "Mood after",    color: "#2dd4bf" },
];

const GRID = "#2a323d", AXIS = "#8b96a5";

// Keep only logs within the last `days` calendar days; null/0 => all of them.
function rangeSlice(logs, days) {
  if (!days) return logs;
  const since = new Date(); since.setDate(since.getDate() - days);
  return logs.filter(l => new Date(l.log_date + "T00:00:00") >= since);
}

// Average a metric across logs, ignoring null entries (rest days etc.).
function avgOf(logs, key) {
  const v = logs.map(l => l[key]).filter(x => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

// Per-date team average for every metric. Returns { dates, series:{key:[..]} }.
function teamAverageSeries(logs) {
  const byDate = {};
  for (const l of logs) (byDate[l.log_date] ||= []).push(l);
  const dates = Object.keys(byDate).sort();
  const series = {};
  for (const m of METRICS) {
    series[m.key] = dates.map(d => {
      const vals = byDate[d].map(x => x[m.key]).filter(v => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    });
  }
  return { dates, series };
}

// One line per metric (the "all trends" view). `valueFor(key)` returns the
// y-values aligned to `labels`.
function multiLineChart(canvasId, labels, valueFor) {
  return new Chart(document.getElementById(canvasId), {
    type: "line",
    data: {
      labels,
      datasets: METRICS.map(m => ({
        label: m.label,
        data: valueFor(m.key),
        borderColor: m.color,
        backgroundColor: m.color + "22",
        borderWidth: 2, tension: 0.3, fill: false,
        pointRadius: 2, pointBackgroundColor: m.color, spanGaps: true,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, labels: { color: AXIS, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        y: { min: 0, max: 10, grid: { color: GRID }, ticks: { color: AXIS } },
        x: { grid: { color: GRID }, ticks: { color: AXIS, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
      }
    }
  });
}

// Grouped/normal bar chart.
function barChart(canvasId, labels, datasets, opts = {}) {
  return new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1, labels: { color: AXIS, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        y: Object.assign({ beginAtZero: true, grid: { color: GRID }, ticks: { color: AXIS } }, opts.yMax ? { max: opts.yMax } : {}),
        x: { grid: { color: GRID }, ticks: { color: AXIS } }
      }
    }
  });
}

// Sleep-hours (x) vs performance (y) scatter. Uses match-day perf rating when
// present, else mood-after. Returns null when there aren't enough points.
function sleepPerfScatter(canvasId, logs) {
  const points = (logs || [])
    .map(l => ({ x: l.sleep_hours, y: l.is_match_day && l.perf_rating != null ? l.perf_rating : l.mood_after }))
    .filter(p => p.x != null && p.y != null);
  if (points.length < 3) return null;
  return new Chart(document.getElementById(canvasId), {
    type: "scatter",
    data: { datasets: [{ data: points, backgroundColor: "#ffb000", pointRadius: 6, pointHoverRadius: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.x}h sleep → perf ${c.parsed.y}` } } },
      scales: {
        x: { title: { display: true, text: "Sleep hours", color: AXIS }, grid: { color: GRID }, ticks: { color: AXIS } },
        y: { min: 0, max: 10, title: { display: true, text: "Performance", color: AXIS }, grid: { color: GRID }, ticks: { color: AXIS } }
      }
    }
  });
}

// Shared summary block used by the dashboard and the coach view.
function summarize(logs) {
  if (!logs.length) return null;
  const mins = logs.reduce((s, l) => s + (l.duration_minutes || 0), 0);
  const fmt = k => { const v = logs.map(l => l[k]).filter(x => x != null); return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : "–"; };
  return { sessions: logs.length, time: `${Math.floor(mins / 60)}h ${mins % 60}m`, confidence: fmt("confidence"), sleep: fmt("sleep_hours") };
}

function statRows(s) {
  return `
    <div class="log-row"><span class="log-date">Sessions</span><span>${s.sessions}</span></div>
    <div class="log-row"><span class="log-date">Total time</span><span>${s.time}</span></div>
    <div class="log-row"><span class="log-date">Avg confidence</span><span>${s.confidence}</span></div>
    <div class="log-row"><span class="log-date">Avg sleep</span><span>${s.sleep}h</span></div>`;
}

// Flip the .active state on a segmented toggle and return the chosen value.
function toggleActive(containerSel, value, attr) {
  document.querySelectorAll(containerSel + " .toggle-btn")
    .forEach(b => b.classList.toggle("active", b.dataset[attr] === value));
}
