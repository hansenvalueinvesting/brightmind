// ============================================================
// Screen — Matches: the player's match log plus visuals.
// A "match" is a logs row with is_match_day = true (there's no separate
// matches table). We derive win/loss from final_score (player's games
// first, e.g. "3-1" = win), then render KPIs, three charts, and a
// clickable match list that reuses the shared log-detail modal.
// Loaded after supabase.js, nav.js, charts.js (GRID/AXIS/toggleActive)
// and logdetail.js (showLogDetail/esc).
// ============================================================

let session = null;
let matches = [];          // this user's match-day logs, ascending by date
let matchRange = "all";    // "10" (last 10) | "all"

(async () => {
  session = await requireSession();
  if (!session) return;
  await load();

  // A match removed from the detail modal drops out locally and repaints.
  setLogRemovedHandler(id => {
    matches = matches.filter(m => m.id !== id);
    renderAll();
  });
})();

async function load() {
  // Pull match-day logs, plus sleep so the detail modal shows it correctly.
  const [{ data: matchData }, { data: sleepData }] = await Promise.all([
    db.from("logs").select("*")
      .eq("user_id", session.user.id)
      .eq("is_match_day", true)
      .order("log_date", { ascending: true }),
    db.from("sleep_entries").select("*").eq("user_id", session.user.id),
  ]);
  matches = matchData || [];
  attachSleep(matches, sleepData || []);   // merge each day's sleep onto its log
  renderAll();
}

// ---------- Win/loss from final_score ----------
// Scores are stored player's-games-first ("3-1" = win, "1-3" = loss).
// Anything blank/unparseable/tied is "unscored" and left out of the record.
function parseResult(final_score) {
  if (!final_score) return null;
  const m = String(final_score).split(/[-–—]/);
  if (m.length !== 2) return null;
  const mine = parseInt(m[0], 10), theirs = parseInt(m[1], 10);
  if (isNaN(mine) || isNaN(theirs) || mine === theirs) return null;
  return mine > theirs ? "win" : "loss";
}

// The current range: the most recent N matches, or all of them.
function currentSet() {
  if (matchRange === "all") return matches;
  return matches.slice(-10);   // matches is ascending, so tail = most recent
}

function setMatchRange(range) {
  matchRange = range;
  toggleActive("#range-toggle", range, "range");
  renderAll();
}

// ---------- Render orchestration ----------
function renderAll() {
  const set = currentSet();
  const sub = document.getElementById("page-sub");
  const total = matches.length;
  sub.textContent = total
    ? `${total} match${total === 1 ? "" : "es"} logged`
    : "No matches logged yet.";

  renderKpis(set);
  renderPerfChart(set);
  renderResultsChart(set);
  renderOppChart(set);
  renderList(set);
}

// ---------- KPI row ----------
function renderKpis(set) {
  const el = document.getElementById("kpis");
  if (!set.length) {
    el.innerHTML = '<div class="empty" style="grid-column:1/-1;">Log a match from the Log tab to see your stats here.</div>';
    return;
  }
  let wins = 0, losses = 0;
  for (const m of set) {
    const r = parseResult(m.final_score);
    if (r === "win") wins++;
    else if (r === "loss") losses++;
  }
  const decided = wins + losses;
  const winPct = decided ? Math.round((wins / decided) * 100) + "%" : "–";
  const perfs = set.map(m => m.perf_rating).filter(v => v != null);
  const avgPerf = perfs.length ? (perfs.reduce((a, b) => a + b, 0) / perfs.length).toFixed(1) : "–";

  el.innerHTML = kpi(set.length, "Matches")
    + kpi(`${wins}–${losses}`, "Win–Loss")
    + kpi(winPct, "Win rate")
    + kpi(avgPerf, "Avg perf");
}

function kpi(num, label) {
  return `<div class="kpi"><div class="kpi-num">${esc(num)}</div><div class="kpi-label">${esc(label)}</div></div>`;
}

// ---------- Chart helpers ----------
// Reset a chart box to a fresh <canvas> (a new element sidesteps Chart.js's
// "canvas already in use" on re-render) or an empty-state message.
function chartCanvas(boxId, canvasId, hasData, msg) {
  const box = document.getElementById(boxId);
  if (!hasData) { box.innerHTML = `<div class="empty">${msg}</div>`; return null; }
  box.innerHTML = `<canvas id="${canvasId}"></canvas>`;
  return document.getElementById(canvasId);
}

const RESULT_COLOR = { win: "#3fb950", loss: "#f85149", null: "#ffb000" };

// ---------- Performance over time ----------
function renderPerfChart(set) {
  const pts = set.filter(m => m.perf_rating != null);
  const cv = chartCanvas("perf-box", "perfChart", pts.length >= 1,
    "Rate your performance on a match to chart it here.");
  if (!cv) return;
  new Chart(cv, {
    type: "line",
    data: {
      labels: pts.map(m => m.log_date.slice(5)),
      datasets: [{
        data: pts.map(m => m.perf_rating),
        borderColor: "#ffb000", backgroundColor: "#ffb00022",
        borderWidth: 2, tension: 0.3, fill: true,
        pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: "#ffb000", spanGaps: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `Performance ${c.parsed.y}/10` } } },
      scales: {
        y: { min: 0, max: 10, grid: { color: GRID }, ticks: { color: AXIS } },
        x: { grid: { color: GRID }, ticks: { color: AXIS, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }
      }
    }
  });
}

// ---------- Results breakdown (win / loss / unscored) ----------
function renderResultsChart(set) {
  let wins = 0, losses = 0, unscored = 0;
  for (const m of set) {
    const r = parseResult(m.final_score);
    if (r === "win") wins++; else if (r === "loss") losses++; else unscored++;
  }
  const parts = [
    { label: "Wins", value: wins, color: "#3fb950" },
    { label: "Losses", value: losses, color: "#f85149" },
    { label: "Unscored", value: unscored, color: "#8b96a5" },
  ].filter(p => p.value > 0);

  const cv = chartCanvas("results-box", "resultsChart", parts.length > 0,
    "No matches in this range yet.");
  if (!cv) return;
  new Chart(cv, {
    type: "doughnut",
    data: {
      labels: parts.map(p => p.label),
      datasets: [{ data: parts.map(p => p.value), backgroundColor: parts.map(p => p.color), borderColor: "#161b22", borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "60%",
      plugins: {
        legend: { position: "bottom", labels: { color: AXIS, boxWidth: 12, padding: 14, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed}` } }
      }
    }
  });
}

// ---------- Performance vs. opponent level ----------
function renderOppChart(set) {
  const pts = set
    .filter(m => m.opponent_level != null && m.perf_rating != null)
    .map(m => ({ x: Number(m.opponent_level), y: m.perf_rating, result: parseResult(m.final_score) }));
  const cv = chartCanvas("opp-box", "oppChart", pts.length >= 1,
    "Log an opponent level and performance to compare them here.");
  if (!cv) return;
  new Chart(cv, {
    type: "scatter",
    data: {
      datasets: [{
        data: pts,
        backgroundColor: pts.map(p => RESULT_COLOR[p.result]),
        pointRadius: 6, pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const r = c.raw.result ? c.raw.result[0].toUpperCase() + c.raw.result.slice(1) : "Unscored";
          return `Opp ${c.parsed.x} → perf ${c.parsed.y} (${r})`;
        } } }
      },
      scales: {
        x: { title: { display: true, text: "Opponent level", color: AXIS }, grid: { color: GRID }, ticks: { color: AXIS } },
        y: { min: 0, max: 10, title: { display: true, text: "Performance", color: AXIS }, grid: { color: GRID }, ticks: { color: AXIS } }
      }
    }
  });
}

// ---------- Match log ----------
function renderList(set) {
  const el = document.getElementById("match-list");
  if (!set.length) { el.innerHTML = '<div class="empty">No matches yet.</div>'; return; }
  el.innerHTML = [...set].reverse().map(m => {
    const r = parseResult(m.final_score);
    const badge = r === "win" ? '<span class="badge win">Win</span>'
                : r === "loss" ? '<span class="badge loss">Loss</span>'
                : '<span class="badge" style="color:var(--ink-dim);border-color:var(--line);">—</span>';
    // Lead with the opponent's name when we have it, falling back to the level.
    const who = m.opponent_name ? `vs ${esc(m.opponent_name)}`
              : m.opponent_level != null ? `Opp ${esc(m.opponent_level)}`
              : "Match";
    const bits = [];
    if (m.opponent_name && m.opponent_level != null) bits.push(`lvl ${esc(m.opponent_level)}`);
    if (m.final_score) bits.push(esc(m.final_score));
    const detail = bits.length ? ` · ${bits.join(" · ")}` : "";
    const perf = m.perf_rating != null ? `${m.perf_rating}/10` : "–";
    return `
      <div class="log-row clickable" onclick="openMatch('${m.id}')">
        <span class="log-date">${esc(m.log_date)}</span>
        <span style="flex:1; margin:0 12px; color:var(--ink-dim);">${who}${detail}</span>
        ${badge}
        <span style="margin-left:12px; min-width:38px; text-align:right;">${perf}</span>
      </div>`;
  }).join("");
}

// Open a match in the shared detail modal (owned by the player, so editable).
function openMatch(id) {
  const m = matches.find(x => x.id === id);
  if (m) showLogDetail(m, { editable: true });
}
