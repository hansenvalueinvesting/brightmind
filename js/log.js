// ============================================================
// Screen 2 — daily log. Builds sliders, submits a log row,
// updates streak. Default slider value = 5.
// ============================================================

let session = null;

(async () => {
  session = await requireSession();
  if (session) buildSliders();
})();

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

function toggleTournament() {
  const isMatch = document.getElementById("session_type").value === "Match play";
  document.getElementById("tournament-panel").classList.toggle("section-hidden", !isMatch);
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

// "HH:MM" -> total minutes
function durationMinutes() {
  const [h, m] = val("duration").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

async function saveLog() {
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  setMsg("");

  const isMatch = val("session_type") === "Match play";

  const row = {
    user_id: session.user.id,
    log_date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
    session_type: val("session_type"),
    duration_minutes: durationMinutes(),
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
    tournament_name: isMatch ? (val("tournament_name") || null) : null,
    placement:      isMatch ? (val("placement") || null) : null,
    perf_rating:    isMatch ? sld("perf_rating") : null,
    emotional_state:isMatch ? sld("emotional_state") : null,
    reflection:     isMatch ? (val("reflection") || null) : null,
  };

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
