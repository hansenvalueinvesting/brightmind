// ============================================================
// Screen 3 — dashboard: streak, all-metric trends, summary, entries.
// Charts/stats helpers live in charts.js.
// ============================================================

let session = null;
let logs = [];            // every log for this user, ascending by date
let sleepEntries = [];    // this user's once-a-day sleep rows
let todaySleep = null;    // today's sleep_entries row, or null if not recorded
let sleepEditing = false; // show the input form even when today is already recorded
let statsMode = "week";      // summary: "week" | "all"
let activityRange = "7";     // activity charts: "7" | "30" | "all"
let recentMode = "7";        // recent entries: "7" | "all"

// Local calendar day as YYYY-MM-DD (matches the log_date convention in log.js).
const todayStr = () => new Date().toLocaleDateString("en-CA");

(async () => {
  session = await requireSession();
  if (!session) return;
  await Promise.all([loadProfile(), loadLogs(), loadConnections()]);
  renderActivity();
  renderRecent();
  renderStats();
  renderSleepCard();

  // After a log is removed from the detail modal, drop it locally and repaint.
  setLogRemovedHandler(id => {
    logs = logs.filter(l => l.id !== id);
    renderActivity();
    renderRecent();
    renderStats();
  });
})();

async function loadProfile() {
  const { data } = await db.from("profiles")
    .select("streak_count, last_log_date, role").eq("id", session.user.id).single();
  // Show the live streak: it decays to 0 once a day is missed, not the stale
  // stored count (which only updates on the next log).
  document.getElementById("streak").textContent =
    effectiveStreak(data?.streak_count, data?.last_log_date);

  // Name + account type, shown under the "Home" heading.
  const name = session.user.user_metadata?.username || session.user.email;
  const role = data?.role ? data.role[0].toUpperCase() + data.role.slice(1) : "";
  document.getElementById("page-sub").textContent = role ? `${name} · ${role}` : name;
}

async function loadLogs() {
  const [{ data: logData }, { data: sleepData }] = await Promise.all([
    db.from("logs").select("*").eq("user_id", session.user.id)
      .order("log_date", { ascending: true }),
    db.from("sleep_entries").select("*").eq("user_id", session.user.id),
  ]);
  logs = logData || [];
  sleepEntries = sleepData || [];
  attachSleep(logs, sleepEntries);   // merge each day's sleep onto its logs
  todaySleep = sleepEntries.find(s => s.entry_date === todayStr()) || null;
}

// ---------- Once-a-day sleep entry ----------
// Sleep lives in its own table now; this card records last night once per day.
function renderSleepCard() {
  const el = document.getElementById("sleep-card");
  if (!el) return;
  el.classList.remove("hint");

  if (todaySleep && !sleepEditing) {
    const h = todaySleep.sleep_hours != null ? `${todaySleep.sleep_hours}h` : "–";
    const q = todaySleep.sleep_quality != null ? `quality ${todaySleep.sleep_quality}/10` : "–";
    el.innerHTML =
      `<div class="log-row"><span class="log-date">Recorded today</span><span>${h} · ${q}</span></div>` +
      `<button class="btn btn-ghost" style="margin-top:14px;" onclick="editSleep()">Update</button>`;
    return;
  }

  const hours = todaySleep?.sleep_hours ?? "";
  const qual  = todaySleep?.sleep_quality ?? 5;
  el.innerHTML = `
    <div class="field">
      <label for="sleep_hours">Sleep last night (hours)</label>
      <input type="number" id="sleep_hours" min="0" max="24" step="0.5" placeholder="e.g. 7.5" value="${hours}">
    </div>
    <div class="slider-row">
      <div class="slider-head">
        <label for="sleep_quality">Sleep quality</label>
        <span class="slider-val" id="sleep_quality-val">${qual}</span>
      </div>
      <input type="range" id="sleep_quality" min="1" max="10" value="${qual}"
             oninput="document.getElementById('sleep_quality-val').textContent=this.value">
      <div class="slider-scale"><span>1 · very poor</span><span>excellent · 10</span></div>
    </div>
    <button class="btn" id="sleepSaveBtn" style="margin-top:6px;" onclick="saveSleep()">Save sleep</button>
    <div class="msg" id="sleep-msg"></div>`;
}

function editSleep() { sleepEditing = true; renderSleepCard(); }

async function saveSleep() {
  const btn = document.getElementById("sleepSaveBtn");
  const msg = document.getElementById("sleep-msg");
  if (btn) btn.disabled = true;

  const hoursRaw = document.getElementById("sleep_hours").value;
  const hours = hoursRaw === "" ? null : parseFloat(hoursRaw);
  const row = {
    user_id: session.user.id,
    entry_date: todayStr(),
    sleep_hours: (hours == null || isNaN(hours)) ? null : hours,
    sleep_quality: parseInt(document.getElementById("sleep_quality").value, 10),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db.from("sleep_entries")
    .upsert(row, { onConflict: "user_id,entry_date" }).select().single();
  if (error) {
    if (msg) { msg.textContent = error.message; msg.className = "msg error"; }
    if (btn) btn.disabled = false;
    return;
  }

  // Update local state so trends/summary reflect today's sleep without a reload.
  todaySleep = data;
  sleepEntries = sleepEntries.filter(s => s.entry_date !== data.entry_date).concat(data);
  attachSleep(logs, sleepEntries);
  sleepEditing = false;
  renderSleepCard();
  renderTrend();
  renderStats();
}

// ---------- Coach / parent this player is linked to ----------
// N/A when nobody of that role has added them yet. Degrades to N/A if the
// get_my_adults RPC isn't present on the database.
async function loadConnections() {
  const el = document.getElementById("connections");
  if (!el) return;
  const { data, error } = await db.rpc("get_my_adults");
  const byRole = { coach: [], parent: [] };
  if (!error && data) {
    for (const a of data) if (byRole[a.role]) byRole[a.role].push(a.name);
  }
  const val = names => names.length ? names.map(esc).join(", ") : "N/A";
  el.classList.remove("hint");
  el.innerHTML =
    `<div class="conn-row"><span class="conn-label">Coach</span>` +
      `<span class="conn-val">${val(byRole.coach)}</span></div>` +
    `<div class="conn-row"><span class="conn-label">Parent</span>` +
      `<span class="conn-val">${val(byRole.parent)}</span></div>`;
}

// ---------- Activity (session-type pie + daily-hours bar) ----------
// Distinct colour per session type; unknown types fall back to grey.
const SESSION_COLORS = {
  "Solo practice":    "#ffb000",
  "Match play":       "#f85149",
  "Partner drills":   "#3fb950",
  "Private lesson":   "#58a6ff",
  "Group clinic":     "#bc8cff",
  "Ghosting/fitness": "#ff9e64",
  "Rest day":         "#8b96a5",
};

function setActivityRange(range) {
  activityRange = range;
  toggleActive("#activity-toggle", range, "range");
  renderActivity();
}

function renderActivity() {
  const set = activityRange === "all" ? logs : rangeSlice(logs, Number(activityRange));
  renderTypePie(set);
  renderHoursBar(set);
}

// Reset a chart box to a fresh <canvas> (avoids Chart.js's "canvas already in
// use" on re-render) or an empty-state message.
function activityCanvas(boxId, canvasId, hasData, msg) {
  const box = document.getElementById(boxId);
  if (!hasData) { box.innerHTML = `<div class="empty">${msg}</div>`; return null; }
  box.innerHTML = `<canvas id="${canvasId}"></canvas>`;
  return canvasId;
}

// Pie of how many sessions of each type were logged in the range.
function renderTypePie(set) {
  const counts = {};
  for (const l of set) counts[l.session_type] = (counts[l.session_type] || 0) + 1;
  const labels = Object.keys(counts);
  const cid = activityCanvas("type-box", "typeChart", labels.length > 0, "No sessions in this range.");
  if (!cid) return;
  pieChart(cid, labels, labels.map(k => counts[k]), labels.map(k => SESSION_COLORS[k] || "#8b96a5"));
}

// Bar of total logged hours per day in the range.
function renderHoursBar(set) {
  const byDate = {};
  for (const l of set) byDate[l.log_date] = (byDate[l.log_date] || 0) + (l.duration_minutes || 0);
  const dates = Object.keys(byDate).sort();
  const hasHours = dates.some(d => byDate[d] > 0);
  const cid = activityCanvas("hours-box", "hoursChart", hasHours, "No training time in this range.");
  if (!cid) return;
  barChart(cid, dates.map(d => d.slice(5)),
    [{ label: "Hours", data: dates.map(d => Math.round(byDate[d] / 60 * 10) / 10), backgroundColor: "#ffb000" }],
    { xTicks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } });
}

// ---------- Recent entries ----------
function setRecentMode(mode) {
  recentMode = mode;
  toggleActive("#recent-toggle", mode, "mode");
  renderRecent();
}

function renderRecent() {
  const el = document.getElementById("recent");
  const ordered = [...logs].reverse();
  const set = recentMode === "all" ? ordered : ordered.slice(0, 7);
  if (!set.length) { el.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
  el.innerHTML = set.map(l => `
    <div class="log-row clickable" onclick="openRecent('${l.id}')">
      <span class="log-date">${esc(l.log_date)}</span>
      <span class="log-type">${esc(l.session_type)}</span>
      <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
    </div>
  `).join("");
}

// Open the detail modal for a recent entry (the player owns these, so editable).
function openRecent(id) {
  const l = logs.find(x => x.id === id);
  if (l) showLogDetail(l, { editable: true });
}

// ---------- Summary (this week / all time) ----------
function setStatsMode(mode) {
  statsMode = mode;
  toggleActive("#stats-toggle", mode, "mode");
  renderStats();
}

function renderStats() {
  const el = document.getElementById("week-stats");
  const set = statsMode === "week" ? rangeSlice(logs, 7) : logs;
  const s = summarize(set);
  if (!s) {
    el.innerHTML = statsMode === "week" ? "No sessions logged this week yet." : "No sessions logged yet.";
    return;
  }
  el.innerHTML = statRows(s);
}
