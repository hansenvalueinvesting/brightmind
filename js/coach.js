// ============================================================
// Coach dashboard — add players by email, team-wide stats + charts,
// and per-player drill-down. Chart/stats helpers live in charts.js.
//
// Data access:
//  - get_my_players()  RPC -> roster + identity (email/username from auth)
//  - add_player_by_email() RPC -> link a player by email
//  - logs are read directly; an RLS policy lets a coach select the logs
//    of players they're linked to.
// ============================================================

let session = null;
let players = [];          // [{ player_id, email, username, streak_count, last_log_date }]
let logsByPlayer = {};     // player_id -> logs[] (ascending)
let allPlayerLogs = [];    // every fetched log row, flat
let selected = null;       // selected player_id

let teamMode = "week";     // team summary: "week" | "all"
let teamTrendRange = "30"; // team trend chart: "30" | "all"
let detailRange = "30";    // player trend chart: "30" | "all"
let detailRecent = "7";    // player entries: "7" | "all"

let teamTrend = null, teamCompare = null, detailChart = null, detailScatter = null;

(async () => {
  session = await requireSession();
  if (!session) return;

  // Coaches only — players don't have this screen.
  const { data: prof } = await db.from("profiles")
    .select("role").eq("id", session.user.id).single();
  if (prof?.role !== "coach") { window.location.href = "dashboard.html"; return; }

  const name = session.user.user_metadata?.username || session.user.email;
  document.getElementById("page-sub").textContent = `${name} · Coach`;

  await loadPlayers();
})();

async function loadPlayers() {
  const { data, error } = await db.rpc("get_my_players");
  if (error) {
    document.getElementById("roster").innerHTML =
      `<div class="empty">Couldn't load players: ${esc(error.message)}</div>`;
    return;
  }
  players = data || [];

  // Pull every player's logs in one query (RLS scopes it to this coach's players).
  const ids = players.map(p => p.player_id);
  logsByPlayer = {};
  allPlayerLogs = [];
  if (ids.length) {
    const { data: logs } = await db.from("logs")
      .select("*").in("user_id", ids).order("log_date", { ascending: true });
    allPlayerLogs = logs || [];
    for (const l of allPlayerLogs) (logsByPlayer[l.user_id] ||= []).push(l);
  }

  if (selected && !players.some(p => p.player_id === selected)) selected = null;

  renderRoster();
  renderTeam();
  renderTeamTrend();
  renderTeamCompare();
  renderDetail();
}

// ---------- Add / remove ----------
async function addPlayer() {
  const input = document.getElementById("player-email");
  const email = input.value.trim();
  if (!email) { setMsg("add-msg", "Enter a player's email.", "error"); return; }

  const btn = document.getElementById("addBtn");
  btn.disabled = true;
  setMsg("add-msg", "");

  const { error } = await db.rpc("add_player_by_email", { p_email: email });
  btn.disabled = false;
  if (error) { setMsg("add-msg", esc(error.message), "error"); return; }

  input.value = "";
  setMsg("add-msg", "Player added.", "ok");
  await loadPlayers();
}

async function removePlayer(id) {
  await db.from("coach_players").delete()
    .eq("coach_id", session.user.id).eq("player_id", id);
  if (selected === id) selected = null;
  await loadPlayers();
}

// ---------- Team summary (numbers) ----------
function setTeamMode(mode) {
  teamMode = mode;
  toggleActive("#team-toggle", mode, "mode");
  renderTeam();
}

function renderTeam() {
  document.getElementById("team-count").textContent = players.length;
  const el = document.getElementById("team-stats");
  const set = teamMode === "week" ? rangeSlice(allPlayerLogs, 7) : allPlayerLogs;
  const s = summarize(set);
  el.innerHTML = s ? statRows(s)
    : (teamMode === "week"
        ? "No sessions logged by your players this week."
        : "No sessions logged by your players yet.");
}

// ---------- Team trends (avg of every metric across the team) ----------
function setTeamTrendRange(range) {
  teamTrendRange = range;
  toggleActive("#team-trend-toggle", range, "range");
  renderTeamTrend();
}

function renderTeamTrend() {
  const box = document.getElementById("team-trend-box");
  if (teamTrend) { teamTrend.destroy(); teamTrend = null; }

  const set = teamTrendRange === "all" ? allPlayerLogs : rangeSlice(allPlayerLogs, 30);
  if (!set.length) { box.innerHTML = '<div class="empty">No player logs to chart yet.</div>'; return; }

  box.innerHTML = '<canvas id="teamTrendChart"></canvas>';
  const { dates, series } = teamAverageSeries(set);
  teamTrend = multiLineChart("teamTrendChart", dates.map(d => d.slice(5)), k => series[k]);
}

// ---------- Player comparison (grouped bars) ----------
function renderTeamCompare() {
  const box = document.getElementById("team-compare-box");
  if (teamCompare) { teamCompare.destroy(); teamCompare = null; }

  if (!players.length) { box.innerHTML = '<div class="empty">Add players to compare them.</div>'; return; }

  box.innerHTML = '<canvas id="teamCompareChart"></canvas>';
  const labels = players.map(p => p.username || p.email);
  const pick = [
    ["confidence", "Confidence", "#ffb000"],
    ["focus", "Focus", "#3fb950"],
    ["sleep_quality", "Sleep quality", "#58a6ff"],
  ];
  const datasets = pick.map(([key, label, color]) => ({
    label, backgroundColor: color,
    data: players.map(p => +avgOf(logsByPlayer[p.player_id] || [], key).toFixed(1)),
  }));
  teamCompare = barChart("teamCompareChart", labels, datasets, { yMax: 10 });
}

// ---------- Roster ----------
function renderRoster() {
  const el = document.getElementById("roster");
  if (!players.length) {
    el.innerHTML = '<div class="empty">No players yet. Add one by email above.</div>';
    return;
  }
  el.innerHTML = players.map(p => {
    const wk = rangeSlice(logsByPlayer[p.player_id] || [], 7).length;
    const name = p.username || p.email;
    const last = p.last_log_date || "never";
    return `
      <div class="player-row ${selected === p.player_id ? "selected" : ""}"
           onclick="selectPlayer('${p.player_id}')">
        <div class="player-id">
          <span class="player-name">${esc(name)}</span>
          <span class="player-email">${esc(p.email)}</span>
        </div>
        <span class="badge">🔥 ${p.streak_count ?? 0}</span>
        <span class="player-meta">${wk} this wk</span>
        <span class="player-meta">last: ${esc(last)}</span>
        <button class="row-x" title="Remove player"
                onclick="event.stopPropagation(); removePlayer('${p.player_id}')">✕</button>
      </div>`;
  }).join("");
}

// ---------- Individual detail ----------
function selectPlayer(id) {
  selected = id;
  renderRoster();
  renderDetail();
  document.getElementById("detail-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderDetail() {
  const panel = document.getElementById("detail-panel");
  if (!selected) { panel.classList.add("section-hidden"); return; }
  panel.classList.remove("section-hidden");

  const p = players.find(x => x.player_id === selected);
  document.getElementById("detail-name").textContent = p ? (p.username || p.email) : "";

  const logs = logsByPlayer[selected] || [];
  const s = summarize(logs);
  document.getElementById("detail-stats").innerHTML =
    s ? statRows(s) : '<div class="empty">No logs yet for this player.</div>';

  renderDetailTrend();
  renderDetailScatter();
  renderDetailRecent();
}

function setDetailRange(range) {
  detailRange = range;
  toggleActive("#detail-trend-toggle", range, "range");
  renderDetailTrend();
}

function renderDetailTrend() {
  const box = document.getElementById("detail-trend-box");
  if (detailChart) { detailChart.destroy(); detailChart = null; }

  const logs = logsByPlayer[selected] || [];
  const set = detailRange === "all" ? logs : rangeSlice(logs, 30);
  if (!set.length) { box.innerHTML = '<div class="empty">No logs to chart.</div>'; return; }

  box.innerHTML = '<canvas id="detailChart"></canvas>';
  detailChart = multiLineChart("detailChart", set.map(l => l.log_date.slice(5)), k => set.map(l => l[k]));
}

function renderDetailScatter() {
  const box = document.getElementById("detail-scatter-box");
  if (detailScatter) { detailScatter.destroy(); detailScatter = null; }

  box.innerHTML = '<canvas id="detailScatter"></canvas>';
  detailScatter = sleepPerfScatter("detailScatter", logsByPlayer[selected] || []);
  if (!detailScatter) {
    box.innerHTML = '<div class="empty">Need 3+ days with sleep recorded to chart this.</div>';
  }
}

function setDetailRecent(mode) {
  detailRecent = mode;
  toggleActive("#detail-recent-toggle", mode, "mode");
  renderDetailRecent();
}

function renderDetailRecent() {
  const el = document.getElementById("detail-recent");
  const ordered = [...(logsByPlayer[selected] || [])].reverse();
  const set = detailRecent === "all" ? ordered : ordered.slice(0, 7);
  el.innerHTML = set.length
    ? set.map(l => `
        <div class="log-row">
          <span class="log-date">${esc(l.log_date)}</span>
          <span class="log-type">${esc(l.session_type)}</span>
          <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
        </div>`).join("")
    : '<div class="empty">No entries.</div>';
}

// ---------- Small local helpers ----------
function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

// Escape user-controlled values (emails, usernames) before inserting as HTML.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
