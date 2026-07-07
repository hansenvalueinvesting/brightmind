// ============================================================
// Screen 3 — dashboard: streak, all-metric trends, summary, entries.
// Charts/stats helpers live in charts.js.
// ============================================================

let session = null;
let logs = [];            // every log for this user, ascending by date
let sleepEntries = [];    // this user's once-a-day sleep rows
let todaySleep = null;    // today's sleep_entries row, or null if not recorded
let sleepEditing = false; // show the input form even when today is already recorded
let trend = null;         // Chart instance
let statsMode = "week";   // summary: "week" | "all"
let trendRange = "30";    // trends: "30" | "all"
let recentMode = "7";     // recent entries: "7" | "all"

// Local calendar day as YYYY-MM-DD (matches the log_date convention in log.js).
const todayStr = () => new Date().toLocaleDateString("en-CA");

(async () => {
  session = await requireSession();
  if (!session) return;
  await Promise.all([loadProfile(), loadLogs(), loadConnections()]);
  renderTrend();
  renderRecent();
  renderStats();
  renderSleepCard();

  // After a log is removed from the detail modal, drop it locally and repaint.
  setLogRemovedHandler(id => {
    logs = logs.filter(l => l.id !== id);
    renderTrend();
    renderRecent();
    renderStats();
  });
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

// ---------- Trends (all metrics at once) ----------
function setTrendRange(range) {
  trendRange = range;
  toggleActive("#trend-toggle", range, "range");
  renderTrend();
}

function renderTrend() {
  const box = document.getElementById("trend-box");
  if (trend) { trend.destroy(); trend = null; }

  const set = trendRange === "all" ? logs : rangeSlice(logs, 30);
  if (!set.length) {
    box.innerHTML = '<div class="empty">No logs yet. Your trends appear once you start logging.</div>';
    return;
  }
  box.innerHTML = '<canvas id="trendChart"></canvas>';
  trend = multiLineChart("trendChart", set.map(l => l.log_date.slice(5)), k => set.map(l => l[k]));
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
