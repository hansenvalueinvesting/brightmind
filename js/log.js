// ============================================================
// Screen 2 — daily log. Builds sliders, submits a log row,
// updates streak. Default slider value = 5.
// ============================================================

let session = null;
let editId = null;        // set when editing an existing log (?edit=<id>)
let editLogDate = null;   // preserve the original log_date on edit

(async () => {
  session = await requireSession();
  if (!session) return;
  buildSliders();

  // Edit mode: ?edit=<logId> loads that row and switches Save -> Update.
  editId = new URLSearchParams(location.search).get("edit");
  if (editId) await loadForEdit(editId);
})();

// Pull an existing log and prefill the form. Only the owner may edit it
// (RLS also enforces this server-side).
async function loadForEdit(id) {
  const { data, error } = await db.from("logs").select("*").eq("id", id).single();
  if (error || !data) { setMsg("Couldn't load that log to edit.", "error"); editId = null; return; }
  if (data.user_id !== session.user.id) { setMsg("You can only edit your own logs.", "error"); editId = null; return; }

  editLogDate = data.log_date;
  document.querySelector(".page-title").textContent = "Edit log";
  document.title = "Edit Log — BrightMind";
  document.getElementById("saveBtn").textContent = "Update log";
  fillForm(data);
}

// Set a plain input/select/textarea value (skips nulls so placeholders remain).
function setField(id, v) {
  const el = document.getElementById(id);
  if (el && v != null) el.value = v;
}

// Set a 1-10 slider and its live value label.
function setSlider(id, v) {
  const el = document.getElementById(id);
  if (!el || v == null) return;
  el.value = v;
  const label = document.getElementById(id + "-val");
  if (label) label.textContent = v;
}

function fillForm(l) {
  document.getElementById("session_type").value = l.session_type;
  onSessionType();   // reveal/hide match + duration panels to match the type

  if (l.session_type !== "Rest day") {
    const mins = l.duration_minutes || 0;
    document.getElementById("duration_h").value = Math.floor(mins / 60);
    document.getElementById("duration_m").value = mins % 60;
  }

  setSlider("intensity", l.intensity);
  setSlider("mood_before", l.mood_before);
  setSlider("mood_after", l.mood_after);
  setField("notes", l.notes);

  setSlider("confidence", l.confidence);
  setSlider("stress", l.stress);
  setSlider("focus", l.focus);
  setField("screen_time", l.screen_time_hours);

  setField("sleep_hours", l.sleep_hours);
  setSlider("sleep_quality", l.sleep_quality);
  setSlider("soreness", l.soreness);

  if (l.is_match_day) {
    setField("match_type", l.match_type);
    setField("tournament_name", l.tournament_name);
    setField("placement", l.placement);
    setSlider("perf_rating", l.perf_rating);
    setSlider("emotional_state", l.emotional_state);
    setField("reflection", l.reflection);
  }
}

// Build all slider rows from their data-attributes (keeps HTML clean).
function buildSliders() {
  document.querySelectorAll(".slider-row").forEach(row => {
    const key = row.dataset.slider;
    row.innerHTML = `
      <div class="slider-head">
        <label for="${key}">${row.dataset.label}</label>
        <span class="slider-val" id="${key}-val">5</span>
      </div>
      <input type="range" id="${key}" min="1" max="10" value="5"
             oninput="document.getElementById('${key}-val').textContent=this.value">
      <div class="slider-scale"><span>1 · ${row.dataset.min}</span><span>${row.dataset.max} · 10</span></div>
    `;
  });
}

// React to the session-type dropdown: show match details only for matches,
// and hide the duration field on a rest day (there's no session to time).
function onSessionType() {
  const type = document.getElementById("session_type").value;
  document.getElementById("tournament-panel").classList.toggle("section-hidden", type !== "Match play");
  document.getElementById("duration-field").classList.toggle("section-hidden", type === "Rest day");
}

function setMsg(text, kind) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function showToast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3200);
}

const val = id => document.getElementById(id).value;
const num = id => { const v = parseFloat(val(id)); return isNaN(v) ? null : v; };
const sld = id => parseInt(val(id), 10);

// Hours + minutes inputs -> total minutes
function durationMinutes() {
  const h = parseInt(val("duration_h"), 10) || 0;
  const m = parseInt(val("duration_m"), 10) || 0;
  return h * 60 + m;
}

async function saveLog() {
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  setMsg("");

  const isMatch = val("session_type") === "Match play";
  const isRest = val("session_type") === "Rest day";

  const row = {
    user_id: session.user.id,
    // Editing keeps the original date; a new log is dated today (local YYYY-MM-DD).
    log_date: editId ? editLogDate : new Date().toLocaleDateString("en-CA"),
    session_type: val("session_type"),
    duration_minutes: isRest ? 0 : durationMinutes(),
    intensity: sld("intensity"),
    mood_before: sld("mood_before"),
    mood_after: sld("mood_after"),
    notes: val("notes") || null,
    confidence: sld("confidence"),
    stress: sld("stress"),
    focus: sld("focus"),
    screen_time_hours: num("screen_time"),
    sleep_hours: num("sleep_hours"),
    sleep_quality: sld("sleep_quality"),
    soreness: sld("soreness"),
    is_match_day: isMatch,
    match_type:     isMatch ? val("match_type") : null,
    tournament_name: isMatch ? (val("tournament_name") || null) : null,
    placement:      isMatch ? (val("placement") || null) : null,
    perf_rating:    isMatch ? sld("perf_rating") : null,
    emotional_state:isMatch ? sld("emotional_state") : null,
    reflection:     isMatch ? (val("reflection") || null) : null,
  };

  // Edit mode: update the existing row in place. The streak reflects logging
  // cadence, so editing an entry leaves it untouched.
  if (editId) {
    const { error } = await db.from("logs").update(row).eq("id", editId);
    if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }
    setMsg("Updated. Redirecting to your dashboard…", "ok");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 1000);
    return;
  }

  const { error } = await db.from("logs").insert(row);
  if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }

  const streak = await updateStreak(row.log_date);
  showToast(`Streak: ${streak} days 🔥`);
  setMsg("Saved. Redirecting to your dashboard…", "ok");
  setTimeout(() => { window.location.href = "dashboard.html"; }, 1400);
}

// ----------------------------------------------------------------
// Streak logic (client-side):
//  - same day already logged  -> unchanged
//  - logged yesterday         -> +1
//  - gap (or first ever)      -> reset to 1
// ----------------------------------------------------------------
async function updateStreak(todayStr) {
  const { data: profile } = await db.from("profiles")
    .select("streak_count, last_log_date").eq("id", session.user.id).single();

  const today = new Date(todayStr + "T00:00:00");
  let streak = 1;

  if (profile?.last_log_date) {
    const last = new Date(profile.last_log_date + "T00:00:00");
    const dayMs = 86400000;
    const diff = Math.round((today - last) / dayMs);
    if (diff === 0) streak = profile.streak_count;        // already logged today
    else if (diff === 1) streak = profile.streak_count + 1; // consecutive
    else streak = 1;                                        // gap -> reset
  }

  await db.from("profiles")
    .update({ streak_count: streak, last_log_date: todayStr })
    .eq("id", session.user.id);

  return streak;
}
