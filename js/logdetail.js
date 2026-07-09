// ============================================================
// Shared "log detail" modal.
//   - Players open it from their Home recent-entries list (editable):
//     full stats + notes, plus Edit and Remove actions.
//   - Coaches / parents open it from a player's entries (read-only):
//     same detail, no Edit/Remove.
// Loaded after supabase.js (needs `db`) and before the page script that
// calls showLogDetail(). Self-contained: injects its own markup + styles.
// ============================================================

// Escape user-controlled values before inserting as HTML. (roster.js declares
// an identical helper; duplicate function declarations across scripts are safe.)
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let _detailLog = null;       // the log currently shown in the modal
let _onLogRemoved = null;    // optional callback the host page registers

// Let a host page (the player dashboard) react after a delete without a reload.
function setLogRemovedHandler(fn) { _onLogRemoved = fn; }

// ---------- Formatting helpers ----------
function fmtDuration(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function dRow(label, value) {
  if (value == null || value === "") return "";
  return `<div class="log-row"><span class="log-date">${esc(label)}</span><span>${esc(value)}</span></div>`;
}

function dSection(title, rows) {
  const body = rows.join("");
  return body ? `<div class="detail-sub" style="margin-top:16px;">${esc(title)}</div>${body}` : "";
}

function dNote(label, text) {
  if (!text) return "";
  return `<div class="detail-sub" style="margin-top:16px;">${esc(label)}</div>` +
         `<div class="note-text">${esc(text)}</div>`;
}

// Build the modal body for one log row.
function logDetailHTML(l, editable) {
  const s = key => (l[key] != null ? `${l[key]} / 10` : null);
  const isRest = l.session_type === "Rest day";

  let html = `
    <div class="modal-head">
      <div>
        <div class="modal-title">${esc(l.session_type)}</div>
        <div class="modal-date">${esc(l.log_date)}</div>
      </div>
      <span class="badge">${l.is_match_day ? "match" : "intensity " + (l.intensity ?? "–")}</span>
    </div>`;

  html += dSection("Training", [
    dRow("Duration", isRest ? "Rest day" : fmtDuration(l.duration_minutes)),
    dRow("Intensity", s("intensity")),
    dRow("Mood before", s("mood_before")),
    dRow("Mood after", s("mood_after")),
  ]);
  html += dNote("Notes", l.notes);

  html += dSection("Mental", [
    dRow("Confidence", s("confidence")),
    dRow("Stress", s("stress")),
    dRow("Focus", s("focus")),
    dRow("Screen time", l.screen_time_hours != null ? `${l.screen_time_hours}h` : null),
  ]);

  html += dSection("Recovery", [
    dRow("Sleep", l.sleep_hours != null ? `${l.sleep_hours}h` : null),
    dRow("Sleep quality", s("sleep_quality")),
    dRow("Body soreness", s("soreness")),
  ]);

  if (l.is_match_day) {
    html += dSection("Match", [
      dRow("Opponent", l.opponent_name),
      dRow("Opponent level", l.opponent_level),
      dRow("Final score", l.final_score),
      dRow("Self-rated performance", s("perf_rating")),
    ]);
  }

  if (editable) {
    html += `
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="editCurrentLog()">Edit</button>
        <button class="btn btn-danger" onclick="removeCurrentLog()">Remove</button>
      </div>`;
  }
  return html;
}

// ---------- Modal plumbing ----------
function ensureLogModal() {
  if (document.getElementById("log-modal")) return;
  const m = document.createElement("div");
  m.id = "log-modal";
  m.className = "modal-overlay section-hidden";
  m.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <button class="modal-close" onclick="closeLogModal()" aria-label="Close">✕</button>
      <div id="log-modal-body"></div>
    </div>`;
  // Click on the dimmed backdrop (but not the card) closes the modal.
  m.addEventListener("click", e => { if (e.target === m) closeLogModal(); });
  document.body.appendChild(m);
}

function showLogDetail(log, opts = {}) {
  if (!log) return;
  ensureLogModal();
  _detailLog = log;
  document.getElementById("log-modal-body").innerHTML = logDetailHTML(log, !!opts.editable);
  const m = document.getElementById("log-modal");
  m.classList.remove("section-hidden");
  document.body.style.overflow = "hidden";   // stop background scroll
}

function closeLogModal() {
  const m = document.getElementById("log-modal");
  if (m) m.classList.add("section-hidden");
  document.body.style.overflow = "";
  _detailLog = null;
}

function editCurrentLog() {
  if (_detailLog) window.location.href = "log.html?edit=" + encodeURIComponent(_detailLog.id);
}

async function removeCurrentLog() {
  if (!_detailLog) return;
  if (!confirm("Remove this log? This can't be undone.")) return;
  const id = _detailLog.id;
  const { error } = await db.from("logs").delete().eq("id", id);
  if (error) { alert("Couldn't remove this log: " + error.message); return; }
  closeLogModal();
  if (typeof _onLogRemoved === "function") _onLogRemoved(id);
}

document.addEventListener("DOMContentLoaded", ensureLogModal);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("log-modal")
      && !document.getElementById("log-modal").classList.contains("section-hidden")) {
    closeLogModal();
  }
});
