// ============================================================
// Coach view — add players by email, see team-wide stats, and
// drill into any individual player.
//
// Data access:
//  - get_my_players()  RPC  -> roster + identity (email/username from auth)
//  - add_player_by_email()  RPC -> link a player by email
//  - logs are read directly; a row-level-security policy lets a coach
//    select the logs of players they're linked to.
// ============================================================

let session = null;
let players = [];          // [{ player_id, email, username, streak_count, last_log_date }]
let logsByPlayer = {};     // player_id -> logs[] (ascending by date)
let allPlayerLogs = [];    // every fetched log row, flat
let teamMode = "week";     // "week" | "all"
let selected = null;       // selected player_id for the detail panel
let detailChart = null;

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

  // Drop a stale selection if that player was removed.
  if (selected && !players.some(p => p.player_id === selected)) selected = null;

  renderRoster();
  renderTeam();
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

// ---------- Team overview ----------
function setTeamMode(mode) {
  teamMode = mode;
  document.querySelectorAll("#team-toggle .toggle-btn")
    .forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  renderTeam();
}

function renderTeam() {
  document.getElementById("team-count").textContent = players.length;
  const el = document.getElementById("team-stats");
  const set = teamMode === "week" ? weekSlice(allPlayerLogs) : allPlayerLogs;
  const s = summarize(set);
  if (!s) {
    el.innerHTML = teamMode === "week"
      ? "No sessions logged by your players this week."
      : "No sessions logged by your players yet.";
    return;
  }
  el.innerHTML = statRows(s);
}

// ---------- Roster ----------
function renderRoster() {
  const el = document.getElementById("roster");
  if (!players.length) {
    el.innerHTML = '<div class="empty">No players yet. Add one by email above.</div>';
    return;
  }
  el.innerHTML = players.map(p => {
    const logs = logsByPlayer[p.player_id] || [];
    const wk = weekSlice(logs).length;
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
  renderRoster();   // re-highlight the selected row
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

  renderDetailChart();

  const recent = [...logs].reverse().slice(0, 7);
  document.getElementById("detail-recent").innerHTML = recent.length
    ? recent.map(l => `
        <div class="log-row">
          <span class="log-date">${esc(l.log_date)}</span>
          <span class="log-type">${esc(l.session_type)}</span>
          <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
        </div>`).join("")
    : '<div class="empty">No entries.</div>';
}

function renderDetailChart() {
  if (!selected) return;
  const logs = logsByPlayer[selected] || [];
  const since = new Date(); since.setDate(since.getDate() - 30);
  const recent = logs.filter(l => new Date(l.log_date + "T00:00:00") >= since);

  const box = document.getElementById("detail-chartbox");
  const empty = document.getElementById("detail-empty");

  if (detailChart) { detailChart.destroy(); detailChart = null; }

  if (!recent.length) {
    box.classList.add("section-hidden");
    empty.classList.remove("section-hidden");
    return;
  }
  box.classList.remove("section-hidden");
  empty.classList.add("section-hidden");

  const metric = document.getElementById("detail-metric").value;
  detailChart = new Chart(document.getElementById("detailChart"), {
    type: "line",
    data: {
      labels: recent.map(l => l.log_date.slice(5)),
      datasets: [{
        data: recent.map(l => l[metric]),
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

// ---------- Shared helpers ----------
function weekSlice(logs) {
  const since = new Date(); since.setDate(since.getDate() - 7);
  return logs.filter(l => new Date(l.log_date + "T00:00:00") >= since);
}

function summarize(logs) {
  if (!logs.length) return null;
  const avg = k => {
    const vals = logs.map(l => l[k]).filter(v => v != null);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : "–";
  };
  const mins = logs.reduce((s, l) => s + (l.duration_minutes || 0), 0);
  return {
    sessions: logs.length,
    time: `${Math.floor(mins / 60)}h ${mins % 60}m`,
    confidence: avg("confidence"),
    sleep: avg("sleep_hours"),
  };
}

function statRows(s) {
  return `
    <div class="log-row"><span class="log-date">Sessions</span><span>${s.sessions}</span></div>
    <div class="log-row"><span class="log-date">Total time</span><span>${s.time}</span></div>
    <div class="log-row"><span class="log-date">Avg confidence</span><span>${s.confidence}</span></div>
    <div class="log-row"><span class="log-date">Avg sleep</span><span>${s.sleep}h</span></div>`;
}

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
