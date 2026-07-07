// ============================================================
// Shared roster view for supervising adults (coach or parent).
// The page sets `window.ROSTER = { role, one, many }` before loading this:
//   coach  -> { role:"coach",  one:"player", many:"players"  }
//   parent -> { role:"parent", one:"child",  many:"children" }
//
// Both use the same coach_players link table + RLS and the same RPCs
// (add_player_by_email / get_my_players). Chart helpers live in charts.js.
// ============================================================

const R = Object.assign({ role: "coach", one: "player", many: "players" }, window.ROSTER || {});
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// The "other side" of each athlete's link: a coach sees each player's parent,
// a parent sees each child's coach.
const CP_ROLE  = R.role === "coach" ? "parent" : "coach";
const CP_LABEL = cap(CP_ROLE);

let session = null;
let players = [];          // [{ player_id, email, username, streak_count, last_log_date }]
let logsByPlayer = {};     // player_id -> logs[] (ascending)
let allPlayerLogs = [];    // every fetched log row, flat
let counterparts = {};     // player_id -> [{ adult_id, adult_name }] (their coach/parent)
let selected = null;       // selected player_id

let teams = [];            // coach's teams (coach view only)
let teamMembers = {};      // team_id -> [player_id]

let analyzeTeamId = null;  // team selected in "Analyze by team"
let analyzeMode = "week";  // analysis summary: "week" | "all"
let analyzeTrendRange = "30";
let analyzeTrend = null, analyzeCompare = null;

let teamMode = "week";     // overview summary: "week" | "all"
let teamTrendRange = "30"; // overview trend chart: "30" | "all"
let detailRange = "30";    // individual trend chart: "30" | "all"
let detailRecent = "7";    // individual entries: "7" | "all"

let teamTrend = null, teamCompare = null, detailChart = null, detailScatter = null;

(async () => {
  session = await requireSession();
  if (!session) return;

  // This screen is for one role only; send anyone else to their own interface.
  const role = await roleOf(session.user.id);
  if (role !== R.role) { window.location.href = landingPage(role); return; }

  const name = session.user.user_metadata?.username || session.user.email;
  document.getElementById("page-sub").textContent = `${name} · ${cap(R.role)}`;

  await loadPlayers();
})();

async function loadPlayers() {
  const { data, error } = await db.rpc("get_my_players");
  if (error) {
    document.getElementById("roster").innerHTML =
      `<div class="empty">Couldn't load ${R.many}: ${esc(error.message)}</div>`;
    return;
  }
  players = data || [];

  // Pull every athlete's logs (and their once-a-day sleep entries) in one query
  // each; RLS scopes both to this adult's links. Merge sleep onto the logs by
  // date so the sleep-quality bars and sleep-vs-performance scatter still work.
  const ids = players.map(p => p.player_id);
  logsByPlayer = {};
  allPlayerLogs = [];
  if (ids.length) {
    const [{ data: logs }, { data: sleep }] = await Promise.all([
      db.from("logs").select("*").in("user_id", ids).order("log_date", { ascending: true }),
      db.from("sleep_entries").select("*").in("user_id", ids),
    ]);
    allPlayerLogs = logs || [];
    attachSleep(allPlayerLogs, sleep || []);
    for (const l of allPlayerLogs) (logsByPlayer[l.user_id] ||= []).push(l);
  }

  // Who's on the other side of each athlete's link (their coach/parent).
  // Degrades to empty (→ "N/A") if the get_roster_counterparts RPC is absent.
  counterparts = {};
  if (ids.length) {
    const { data: cps } = await db.rpc("get_roster_counterparts", { p_role: CP_ROLE });
    for (const c of (cps || [])) (counterparts[c.player_id] ||= []).push(c);
  }

  if (selected && !players.some(p => p.player_id === selected)) selected = null;

  renderRoster();
  renderTeam();
  renderTeamTrend();
  renderTeamCompare();
  renderDetail();

  // Teams are a coach-only feature (config flag + markup present).
  if (R.teams && document.getElementById("teams-panel")) {
    await refreshTeams();
  }
}

// ---------- Add / remove ----------
async function addPlayer() {
  const input = document.getElementById("player-email");
  const email = input.value.trim();
  if (!email) { setMsg("add-msg", `Enter a ${R.one}'s email.`, "error"); return; }

  const btn = document.getElementById("addBtn");
  btn.disabled = true;
  setMsg("add-msg", "");

  const { error } = await db.rpc("add_player_by_email", { p_email: email });
  btn.disabled = false;
  if (error) { setMsg("add-msg", esc(error.message), "error"); return; }

  input.value = "";
  setMsg("add-msg", `${cap(R.one)} added.`, "ok");
  await loadPlayers();
}

async function removePlayer(id) {
  // Also drop them from any of this coach's teams (RLS scopes the delete).
  await db.from("team_members").delete().eq("player_id", id);
  await db.from("coach_players").delete()
    .eq("coach_id", session.user.id).eq("player_id", id);
  if (selected === id) selected = null;
  await loadPlayers();
}

// ---------- Overview summary (numbers) ----------
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
        ? `No sessions logged by your ${R.many} this week.`
        : `No sessions logged by your ${R.many} yet.`);
}

// ---------- Overview trends (avg of every metric across the group) ----------
function setTeamTrendRange(range) {
  teamTrendRange = range;
  toggleActive("#team-trend-toggle", range, "range");
  renderTeamTrend();
}

function renderTeamTrend() {
  const box = document.getElementById("team-trend-box");
  if (teamTrend) { teamTrend.destroy(); teamTrend = null; }

  const set = teamTrendRange === "all" ? allPlayerLogs : rangeSlice(allPlayerLogs, 30);
  if (!set.length) { box.innerHTML = `<div class="empty">No ${R.one} logs to chart yet.</div>`; return; }

  box.innerHTML = '<canvas id="teamTrendChart"></canvas>';
  const { dates, series } = teamAverageSeries(set);
  teamTrend = multiLineChart("teamTrendChart", dates.map(d => d.slice(5)), k => series[k]);
}

// ---------- Comparison (grouped bars) ----------
function renderTeamCompare() {
  const box = document.getElementById("team-compare-box");
  if (teamCompare) { teamCompare.destroy(); teamCompare = null; }

  if (!players.length) { box.innerHTML = `<div class="empty">Add ${R.many} to compare them.</div>`; return; }

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
    el.innerHTML = `<div class="empty">No ${R.many} yet. Add one by email above.</div>`;
    return;
  }
  el.innerHTML = players.map(p => {
    const wk = rangeSlice(logsByPlayer[p.player_id] || [], 7).length;
    const name = p.username || p.email;
    const last = p.last_log_date || "never";
    const rel = (counterparts[p.player_id] || []).map(c => esc(c.adult_name));
    const relText = rel.length ? rel.join(", ") : "N/A";
    return `
      <div class="player-row ${selected === p.player_id ? "selected" : ""}"
           onclick="selectPlayer('${p.player_id}')">
        <div class="player-id">
          <span class="player-name">${esc(name)}</span>
          <span class="player-email">${esc(p.email)}</span>
          <span class="player-rel">${CP_LABEL}: ${relText}</span>
        </div>
        <span class="badge">🔥 ${p.streak_count ?? 0}</span>
        <span class="player-meta">${wk} this wk</span>
        <span class="player-meta">last: ${esc(last)}</span>
        <button class="row-x" title="Remove ${R.one}"
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
    s ? statRows(s) : `<div class="empty">No logs yet for this ${R.one}.</div>`;

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
        <div class="log-row clickable" onclick="openDetailLog('${l.id}')">
          <span class="log-date">${esc(l.log_date)}</span>
          <span class="log-type">${esc(l.session_type)}</span>
          <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
        </div>`).join("")
    : '<div class="empty">No entries.</div>';
}

// Open the detail modal for one of the selected player's entries.
// Read-only: a coach/parent can view the full log but not edit or remove it.
function openDetailLog(id) {
  const l = (logsByPlayer[selected] || []).find(x => x.id === id);
  if (l) showLogDetail(l, { editable: false });
}

// ---------- Teams (coach only) ----------
async function loadTeams() {
  const { data: ts } = await db.from("teams")
    .select("*").eq("coach_id", session.user.id).order("created_at");
  teams = ts || [];
  teamMembers = {};
  if (teams.length) {
    const { data: ms } = await db.from("team_members")
      .select("*").in("team_id", teams.map(t => t.id));
    for (const m of (ms || [])) (teamMembers[m.team_id] ||= []).push(m.player_id);
  }
}

function renderTeams() {
  const el = document.getElementById("teams-list");
  if (!teams.length) {
    el.innerHTML = '<div class="empty">No teams yet. Create one above, then add players to it.</div>';
    return;
  }
  el.innerHTML = teams.map(t => {
    const ids = teamMembers[t.id] || [];
    const chips = ids.map(pid => {
      const p = players.find(x => x.player_id === pid);
      const name = p ? (p.username || p.email) : "(removed)";
      const streak = p ? (p.streak_count ?? 0) : 0;
      return `<span class="team-chip">${esc(name)} · 🔥${streak}
        <button class="chip-x" title="Remove from team"
                onclick="removeFromTeam('${t.id}','${pid}')">✕</button></span>`;
    }).join("") || '<span class="hint">No players on this team yet.</span>';

    const avail = players.filter(p => !ids.includes(p.player_id));
    const adder = avail.length
      ? `<div class="add-row" style="margin-top:10px;">
           <select id="team-sel-${t.id}">
             ${avail.map(p => `<option value="${p.player_id}">${esc(p.username || p.email)}</option>`).join("")}
           </select>
           <button class="btn btn-ghost" style="width:auto;" onclick="addToTeam('${t.id}')">Add to team</button>
         </div>`
      : '<div class="hint" style="margin-top:8px;">All your players are on this team.</div>';

    return `<div class="team-card">
      <div class="team-head">
        <span class="team-name">${esc(t.name)}</span>
        <button class="row-x" title="Delete team" onclick="deleteTeam('${t.id}')">✕</button>
      </div>
      <div class="team-members">${chips}</div>
      ${adder}
    </div>`;
  }).join("");
}

async function createTeam() {
  const input = document.getElementById("team-name");
  const name = input.value.trim();
  if (!name) { setMsg("team-msg", "Enter a team name.", "error"); return; }
  const { error } = await db.from("teams").insert({ coach_id: session.user.id, name });
  if (error) { setMsg("team-msg", esc(error.message), "error"); return; }
  input.value = "";
  setMsg("team-msg", "Team created.", "ok");
  await refreshTeams();
}

async function deleteTeam(id) {
  await db.from("teams").delete().eq("id", id);
  await refreshTeams();
}

async function addToTeam(teamId) {
  const sel = document.getElementById("team-sel-" + teamId);
  if (!sel || !sel.value) return;
  await db.from("team_members").insert({ team_id: teamId, player_id: sel.value });
  await refreshTeams();
}

async function removeFromTeam(teamId, playerId) {
  await db.from("team_members").delete().eq("team_id", teamId).eq("player_id", playerId);
  await refreshTeams();
}

// Reload teams + members, then repaint both the management list and the analysis.
async function refreshTeams() {
  await loadTeams();
  renderTeams();
  renderAnalyzeSelector();
  renderAnalyze();
}

// ---------- Analyze by team (coach only) ----------
function renderAnalyzeSelector() {
  const sel = document.getElementById("analyze-team");
  if (!sel) return;
  if (!teams.length) { sel.innerHTML = ""; return; }
  if (!analyzeTeamId || !teams.some(t => t.id === analyzeTeamId)) analyzeTeamId = teams[0].id;
  sel.innerHTML = teams.map(t =>
    `<option value="${t.id}" ${t.id === analyzeTeamId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
}

function onAnalyzeTeamChange() {
  analyzeTeamId = document.getElementById("analyze-team").value;
  renderAnalyze();
}

function analyzeMemberList() {
  const ids = teamMembers[analyzeTeamId] || [];
  return players.filter(p => ids.includes(p.player_id));
}
function analyzeLogList() {
  const ids = new Set(teamMembers[analyzeTeamId] || []);
  return allPlayerLogs.filter(l => ids.has(l.user_id));
}

function renderAnalyze() {
  const sel = document.getElementById("analyze-team");
  const body = document.getElementById("analyze-body");
  const empty = document.getElementById("analyze-empty");
  if (!sel) return;
  if (!teams.length) {
    sel.classList.add("section-hidden");
    body.classList.add("section-hidden");
    empty.classList.remove("section-hidden");
    return;
  }
  sel.classList.remove("section-hidden");
  body.classList.remove("section-hidden");
  empty.classList.add("section-hidden");
  renderAnalyzeSummary();
  renderAnalyzeTrend();
  renderAnalyzeCompare();
}

function setAnalyzeMode(mode) {
  analyzeMode = mode;
  toggleActive("#analyze-toggle", mode, "mode");
  renderAnalyzeSummary();
}

function renderAnalyzeSummary() {
  const el = document.getElementById("analyze-stats");
  const logs = analyzeLogList();
  const set = analyzeMode === "week" ? rangeSlice(logs, 7) : logs;
  const s = summarize(set);
  el.innerHTML = s ? statRows(s)
    : (analyzeMode === "week"
        ? "No sessions logged by this team this week."
        : "No sessions logged by this team yet.");
}

function setAnalyzeTrendRange(range) {
  analyzeTrendRange = range;
  toggleActive("#analyze-trend-toggle", range, "range");
  renderAnalyzeTrend();
}

function renderAnalyzeTrend() {
  const box = document.getElementById("analyze-trend-box");
  if (analyzeTrend) { analyzeTrend.destroy(); analyzeTrend = null; }

  const logs = analyzeLogList();
  const set = analyzeTrendRange === "all" ? logs : rangeSlice(logs, 30);
  if (!set.length) { box.innerHTML = '<div class="empty">No logs to chart for this team yet.</div>'; return; }

  box.innerHTML = '<canvas id="analyzeTrendChart"></canvas>';
  const { dates, series } = teamAverageSeries(set);
  analyzeTrend = multiLineChart("analyzeTrendChart", dates.map(d => d.slice(5)), k => series[k]);
}

function renderAnalyzeCompare() {
  const box = document.getElementById("analyze-compare-box");
  if (analyzeCompare) { analyzeCompare.destroy(); analyzeCompare = null; }

  const members = analyzeMemberList();
  if (!members.length) { box.innerHTML = '<div class="empty">No players on this team yet.</div>'; return; }

  box.innerHTML = '<canvas id="analyzeCompareChart"></canvas>';
  const labels = members.map(p => p.username || p.email);
  const pick = [
    ["confidence", "Confidence", "#ffb000"],
    ["focus", "Focus", "#3fb950"],
    ["sleep_quality", "Sleep quality", "#58a6ff"],
  ];
  const datasets = pick.map(([key, label, color]) => ({
    label, backgroundColor: color,
    data: members.map(p => +avgOf(logsByPlayer[p.player_id] || [], key).toFixed(1)),
  }));
  analyzeCompare = barChart("analyzeCompareChart", labels, datasets, { yMax: 10 });
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
