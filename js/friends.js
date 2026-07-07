// ============================================================
// Player "Friends" screen — peer-to-peer friend requests, a friend
// list you can add to / remove from, and a head-to-head stats
// comparison. Data comes from the friendship security-definer RPCs
// (send/respond/remove_friend, get_my_friends, get_friend_requests);
// friends' logs are read directly under the "friends read logs" RLS.
// Chart/stat helpers live in charts.js.
// ============================================================

let session   = null;
let me        = null;      // this user's id
let myStreak  = 0;
let myLogs    = [];        // this user's logs (ascending)
let friends   = [];        // [{ friend_id, email, username, streak_count, last_log_date }]
let requests  = [];        // [{ other_id, email, username, direction, requested_at }]
let logsByUser = {};       // user_id -> logs[] (me + every friend)
let selected  = null;      // friend_id being compared
let compareChart = null;

// Metrics shown in the head-to-head comparison bars.
const CMP_METRICS = [
  ["confidence",    "Confidence"],
  ["focus",         "Focus"],
  ["stress",        "Stress"],
  ["sleep_quality", "Sleep quality"],
  ["intensity",     "Intensity"],
  ["mood_after",    "Mood after"],
];

(async () => {
  session = await requireSession();
  if (!session) return;

  // Friends are a player feature; send anyone else to their own interface.
  const role = await roleOf(session.user.id);
  if (role !== "player") { window.location.href = landingPage(role); return; }

  me = session.user.id;
  const name = session.user.user_metadata?.username || session.user.email;
  document.getElementById("page-sub").textContent = `${name} · Player`;

  await loadAll();
})();

async function loadAll() {
  const [{ data: fr }, { data: rq }, { data: prof }] = await Promise.all([
    db.rpc("get_my_friends"),
    db.rpc("get_friend_requests"),
    db.from("profiles").select("streak_count").eq("id", me).single(),
  ]);
  friends  = fr || [];
  requests = rq || [];
  myStreak = prof?.streak_count ?? 0;

  // Pull logs + sleep for me and every friend in one query each. RLS scopes
  // this to my own rows plus friends I've accepted; merge sleep by date so
  // sleep_quality reads back on each log.
  const ids = [me, ...friends.map(f => f.friend_id)];
  const [{ data: logs }, { data: sleep }] = await Promise.all([
    db.from("logs").select("*").in("user_id", ids).order("log_date", { ascending: true }),
    db.from("sleep_entries").select("*").in("user_id", ids),
  ]);
  const all = logs || [];
  attachSleep(all, sleep || []);
  logsByUser = {};
  for (const l of all) (logsByUser[l.user_id] ||= []).push(l);
  myLogs = logsByUser[me] || [];

  if (selected && !friends.some(f => f.friend_id === selected)) selected = null;

  renderRequests();
  renderFriends();
  renderCompare();
}

// ---------- Add / respond / remove ----------
async function addFriend() {
  const input = document.getElementById("friend-email");
  const email = input.value.trim();
  if (!email) { setMsg("add-msg", "Enter a friend's email.", "error"); return; }

  const btn = document.getElementById("addBtn");
  btn.disabled = true;
  setMsg("add-msg", "");

  const { data, error } = await db.rpc("send_friend_request", { p_email: email });
  btn.disabled = false;
  if (error) { setMsg("add-msg", esc(error.message), "error"); return; }

  input.value = "";
  const status = data && data[0] && data[0].status;
  setMsg("add-msg", status === "accepted" ? "You're now friends!" : "Friend request sent.", "ok");
  await loadAll();
}

async function respondRequest(otherId, accept) {
  await db.rpc("respond_friend_request", { p_requester: otherId, p_accept: accept });
  await loadAll();
}

// Cancel an outgoing request or unfriend — both wipe the link either way.
async function removeFriend(id) {
  await db.rpc("remove_friend", { p_friend: id });
  if (selected === id) selected = null;
  await loadAll();
}

// ---------- Requests ----------
function renderRequests() {
  const panel = document.getElementById("requests-panel");
  const el = document.getElementById("requests");
  if (!requests.length) { panel.classList.add("section-hidden"); return; }
  panel.classList.remove("section-hidden");

  el.innerHTML = requests.map(r => {
    const name = esc(r.username || r.email);
    const id = r.other_id;
    if (r.direction === "incoming") {
      return `
        <div class="player-row" style="cursor:default;">
          <div class="player-id">
            <span class="player-name">${name}</span>
            <span class="player-email">${esc(r.email)}</span>
          </div>
          <span class="player-meta">wants to be friends</span>
          <button class="btn" style="width:auto; padding:7px 14px; font-size:13px;"
                  onclick="respondRequest('${id}', true)">Accept</button>
          <button class="row-x" title="Decline" onclick="respondRequest('${id}', false)">✕</button>
        </div>`;
    }
    return `
      <div class="player-row" style="cursor:default;">
        <div class="player-id">
          <span class="player-name">${name}</span>
          <span class="player-email">${esc(r.email)}</span>
        </div>
        <span class="player-meta">request sent</span>
        <button class="row-x" title="Cancel request" onclick="removeFriend('${id}')">✕</button>
      </div>`;
  }).join("");
}

// ---------- Friends list ----------
function renderFriends() {
  document.getElementById("friend-count").textContent = friends.length;
  const el = document.getElementById("friends");
  if (!friends.length) {
    el.innerHTML = '<div class="empty">No friends yet. Add one by email above.</div>';
    return;
  }
  el.innerHTML = friends.map(f => {
    const name = esc(f.username || f.email);
    const wk = rangeSlice(logsByUser[f.friend_id] || [], 7).length;
    const last = f.last_log_date || "never";
    return `
      <div class="player-row ${selected === f.friend_id ? "selected" : ""}"
           onclick="selectFriend('${f.friend_id}')">
        <div class="player-id">
          <span class="player-name">${name}</span>
          <span class="player-email">${esc(f.email)}</span>
        </div>
        <span class="badge">🔥 ${f.streak_count ?? 0}</span>
        <span class="player-meta">${wk} this wk</span>
        <span class="player-meta">last: ${esc(last)}</span>
        <button class="row-x" title="Remove friend"
                onclick="event.stopPropagation(); removeFriend('${f.friend_id}')">✕</button>
      </div>`;
  }).join("");
}

// ---------- Compare ----------
function selectFriend(id) {
  selected = selected === id ? null : id;   // click again to collapse
  renderFriends();
  renderCompare();
  if (selected) {
    document.getElementById("compare-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function renderCompare() {
  const panel = document.getElementById("compare-panel");
  if (compareChart) { compareChart.destroy(); compareChart = null; }
  if (!selected) { panel.classList.add("section-hidden"); return; }
  panel.classList.remove("section-hidden");

  const f = friends.find(x => x.friend_id === selected);
  const friendName = f ? (f.username || f.email) : "Friend";
  const friendLogs = logsByUser[selected] || [];

  document.getElementById("compare-title").textContent = `You vs. ${friendName}`;

  // Side-by-side streak + summary. summarize() returns null with no logs, so
  // fall back to a zeroed row rather than a blank column.
  const blank = { sessions: 0, time: "0h 0m", confidence: "–", sleep: "–" };
  const column = (title, streak, logs) => `
    <div>
      <div class="detail-sub">${esc(title)}</div>
      <div class="cmp-streak"><span>🔥</span> ${streak} day streak</div>
      ${statRows(summarize(logs) || blank)}
    </div>`;
  document.getElementById("compare-summary").innerHTML =
    `<div class="grid-2">
       ${column("You", myStreak, myLogs)}
       ${column(friendName, f?.streak_count ?? 0, friendLogs)}
     </div>`;

  // Grouped bars: one metric per group, your bar vs. theirs.
  const box = document.getElementById("compare-box");
  box.innerHTML = '<canvas id="compareChart"></canvas>';
  const labels = CMP_METRICS.map(m => m[1]);
  const datasets = [
    { label: "You", backgroundColor: "#ffb000",
      data: CMP_METRICS.map(m => +avgOf(myLogs, m[0]).toFixed(1)) },
    { label: friendName, backgroundColor: "#58a6ff",
      data: CMP_METRICS.map(m => +avgOf(friendLogs, m[0]).toFixed(1)) },
  ];
  compareChart = barChart("compareChart", labels, datasets, { yMax: 10 });
}

// ---------- Small local helpers ----------
function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
