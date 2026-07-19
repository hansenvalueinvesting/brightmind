// ============================================================
// Admin dashboard (reached at /admin).
//
// A password gate reveals two tabs:
//   Users   — every account grouped by role, each an accordion that
//             opens to full account info (+ aggregate stats for players).
//   Network — a force-directed graph of who coaches / parents / is
//             friends with whom, colour-coded by role and edge type.
//
// All data comes from two security-definer RPCs (admin_overview,
// admin_relationships) that take the password and validate it
// server-side, so the data itself is gated — see db/schema.sql. The
// password below only exists so the client can send it to those RPCs;
// it is NOT a real secret on a static site.
// ============================================================

const ADMIN_STORE_KEY = "bm_admin_pass";

// Role → colour, shared by the user pills and the network nodes.
const ROLE_COLOR = { player: "#ffb000", coach: "#58a6ff", parent: "#bc8cff" };
// Edge type → colour for the relationship map.
const EDGE_COLOR = { coach: "#58a6ff", parent: "#bc8cff", friend: "#3fb950" };
const ROLE_ORDER = ["player", "coach", "parent"];
const ROLE_PLURAL = { player: "Players", coach: "Coaches", parent: "Parents" };

let users = [];      // from admin_overview
let relData = null;  // { nodes, edges } from admin_relationships
let net = null;      // live network-graph controller

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  const pass = document.getElementById("gate-pass");
  document.getElementById("gate-btn").addEventListener("click", () => unlock(pass.value));
  pass.addEventListener("keydown", e => { if (e.key === "Enter") unlock(pass.value); });

  document.getElementById("lock-btn").addEventListener("click", lock);
  document.getElementById("user-search").addEventListener("input", renderUsers);

  document.querySelectorAll(".admin-tab").forEach(b =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));
  document.querySelectorAll("#net-filter .toggle-btn").forEach(b =>
    b.addEventListener("click", () => setNetFilter(b.dataset.filter)));
  document.getElementById("table-search").addEventListener("input", renderCurrentTable);

  // Skip the gate if we already unlocked this browser tab.
  const saved = sessionStorage.getItem(ADMIN_STORE_KEY);
  if (saved) unlock(saved, true);
});

// ---------- Unlock / lock ----------
async function unlock(pass, silent = false) {
  if (!pass) { if (!silent) gateMsg("Enter the password.", "error"); return; }
  if (!dbReady) { gateMsg("Backend not configured (Supabase keys missing).", "error"); return; }

  const btn = document.getElementById("gate-btn");
  btn.disabled = true;
  if (!silent) gateMsg("Checking…");

  const { data, error } = await db.rpc("admin_overview", { p_pass: pass });
  btn.disabled = false;

  if (error) {
    sessionStorage.removeItem(ADMIN_STORE_KEY);
    // A wrong password raises "Unauthorized"; anything else is a real fault.
    const wrong = /unauthorized/i.test(error.message || "");
    gateMsg(wrong ? "Incorrect password." : ("Error: " + esc(error.message)), "error");
    return;
  }

  sessionStorage.setItem(ADMIN_STORE_KEY, pass);
  users = data || [];

  document.getElementById("gate").classList.add("section-hidden");
  document.getElementById("dash").classList.remove("section-hidden");
  document.getElementById("dash-sub").textContent =
    `${users.length} account${users.length === 1 ? "" : "s"} · ${countRole("player")} players · ${countRole("coach")} coaches · ${countRole("parent")} parents`;

  renderUsers();

  // Relationship graph loads in the background so the Users tab is instant.
  const rel = await db.rpc("admin_relationships", { p_pass: pass });
  if (!rel.error) relData = rel.data;
}

function lock() {
  sessionStorage.removeItem(ADMIN_STORE_KEY);
  if (net) { net.destroy(); net = null; }
  document.getElementById("dash").classList.add("section-hidden");
  document.getElementById("gate").classList.remove("section-hidden");
  document.getElementById("gate-pass").value = "";
  gateMsg("");
}

function countRole(role) { return users.filter(u => (u.role || "player") === role).length; }
function gateMsg(text, kind) {
  const el = document.getElementById("gate-msg");
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

// ---------- Tabs ----------
function switchTab(tab) {
  document.querySelectorAll(".admin-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("panel-users").classList.toggle("section-hidden", tab !== "users");
  document.getElementById("panel-network").classList.toggle("section-hidden", tab !== "network");
  document.getElementById("panel-tables").classList.toggle("section-hidden", tab !== "tables");
  if (tab === "network") startNetwork();
  if (tab === "tables") loadTables();
}

// ---------- Users tab ----------
function renderUsers() {
  const q = document.getElementById("user-search").value.trim().toLowerCase();
  const el = document.getElementById("users-body");

  const match = u => !q
    || (u.username || "").toLowerCase().includes(q)
    || (u.email || "").toLowerCase().includes(q);

  const groups = ROLE_ORDER.map(role => {
    const list = users.filter(u => (u.role || "player") === role && match(u));
    return { role, list };
  }).filter(g => g.list.length || !q);

  if (!users.length) { el.innerHTML = '<div class="empty">No accounts found.</div>'; return; }
  if (q && !groups.some(g => g.list.length)) {
    el.innerHTML = '<div class="empty">No users match that search.</div>';
    return;
  }

  el.innerHTML = groups.map(g => `
    <div class="role-group">
      <div class="role-group-head">
        <span class="role-dot" style="background:${ROLE_COLOR[g.role]}"></span>
        <span class="role-group-title">${ROLE_PLURAL[g.role] || cap(g.role) + "s"}</span>
        <span class="role-count">${g.list.length}</span>
      </div>
      ${g.list.length
        ? g.list.map(userRow).join("")
        : '<div class="hint">None.</div>'}
    </div>`).join("");
}

function userRow(u) {
  const role = u.role || "player";
  const name = u.username || u.email || "(no name)";
  const color = ROLE_COLOR[role] || "#8b96a5";
  const pillStyle = `color:${color}; border-color:${color}66; background:${color}1a;`;

  return `
    <div class="acc" data-uid="${esc(u.id)}">
      <div class="acc-head" onclick="toggleAcc(this)">
        <div class="acc-id">
          <span class="acc-name">${esc(name)}</span>
          <span class="acc-email">${esc(u.email || "")}</span>
        </div>
        <span class="acc-pill" style="${pillStyle}">${esc(role)}</span>
        <span class="acc-chevron">▶</span>
      </div>
      <div class="acc-body">
        ${accountInfo(u)}
        ${role === "player" ? playerStats(u) : ""}
        <div class="acc-detail"></div>
      </div>
    </div>`;
}

function accountInfo(u) {
  const rows = [
    ["Username", u.username || "—"],
    ["Email", u.email || "—"],
    ["Role", cap(u.role || "player")],
    ["User ID", u.id],
    ["Joined", fmtDate(u.created_at)],
    ["Last sign-in", fmtDateTime(u.last_sign_in_at)],
    ["Consent", u.consent_at ? fmtDate(u.consent_at) : "Not recorded"],
    ["Streak", `🔥 ${effectiveStreak(u.streak_count, u.last_log_date)}`],
    ["Last log", u.last_log_date ? fmtDate(u.last_log_date) : "Never"],
  ];
  return `<dl class="acct">${rows.map(([k, v]) =>
    `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

function playerStats(u) {
  const mins = u.total_minutes || 0;
  const tiles = [
    [u.log_count ?? 0, "Logs"],
    [u.match_count ?? 0, "Matches"],
    [`${Math.floor(mins / 60)}h ${mins % 60}m`, "Total time"],
    [fmtNum(u.avg_confidence), "Avg confidence"],
    [fmtNum(u.avg_focus), "Avg focus"],
    [fmtNum(u.avg_stress), "Avg stress"],
    [fmtNum(u.avg_intensity), "Avg intensity"],
    [fmtNum(u.avg_sleep_hours), "Avg sleep (h)"],
    [fmtNum(u.avg_sleep_quality), "Avg sleep qual."],
  ];
  return `
    <div class="stat-head">Player stats</div>
    <div class="stat-grid">
      ${tiles.map(([n, l]) =>
        `<div class="stat-tile"><div class="stat-num">${esc(n)}</div><div class="stat-label">${esc(l)}</div></div>`).join("")}
    </div>`;
}

function toggleAcc(headEl) {
  const acc = headEl.parentElement;
  const willOpen = !acc.classList.contains("open");
  acc.classList.toggle("open");
  if (willOpen) loadDetail(acc);   // pull full activity the first time it opens
}

// ---------- Per-user activity drill-down ----------
// Loaded lazily (one admin_user_detail RPC per account) the first time an
// accordion is opened, then cached in the DOM so re-opening is instant.
async function loadDetail(acc) {
  const box = acc.querySelector(".acc-detail");
  if (!box || box.dataset.loaded === "1" || box.dataset.loading === "1") return;

  box.dataset.loading = "1";
  box.innerHTML = '<div class="hint det-hint">Loading full activity…</div>';

  const pass = sessionStorage.getItem(ADMIN_STORE_KEY);
  const { data, error } = await db.rpc("admin_user_detail", {
    p_pass: pass, p_user_id: acc.dataset.uid,
  });
  box.dataset.loading = "0";

  if (error) {
    box.innerHTML = `<div class="hint det-hint">Couldn't load activity: ${esc(error.message)}</div>`;
    return;
  }
  box.dataset.loaded = "1";
  box.innerHTML = renderDetail(data);
}

function renderDetail(d) {
  if (!d) return '<div class="hint det-hint">No detail returned.</div>';
  return signInDetails(d.account || {}) + relationships(d) + activityTables(d);
}

// Sign-in / account details straight off auth.users.
function signInDetails(a) {
  const providers = Array.isArray(a.providers) && a.providers.length
    ? a.providers.join(", ")
    : (a.provider || "—");
  const rows = [
    ["Last sign-in", a.last_sign_in_at ? fmtDateTime(a.last_sign_in_at) : "Never signed in"],
    ["Account created", fmtDateTime(a.created_at)],
    ["Email confirmed", a.email_confirmed_at ? fmtDateTime(a.email_confirmed_at) : "Not confirmed"],
    ["Sign-in method", providers],
    ["Profile updated", fmtDateTime(a.account_updated_at)],
  ];
  return `<div class="det-head">Sign-in &amp; account</div>
    <dl class="acct">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

// Who this user is linked to: coaches/parents, players, friends.
function relationships(d) {
  const groups = [];
  if ((d.coaches || []).length)
    groups.push(["Coaches / parents", d.coaches.map(c =>
      relChip(c.name, cap(c.role || "coach"), ROLE_COLOR[c.role] || "#8b96a5"))]);
  if ((d.players || []).length)
    groups.push(["Players", d.players.map(p =>
      relChip(p.name, p.email, ROLE_COLOR.player))]);
  if ((d.friends || []).length)
    groups.push(["Friends", d.friends.map(f =>
      relChip(f.name, f.status === "accepted" ? "friend" : (f.direction || "pending"), EDGE_COLOR.friend))]);
  if (!groups.length) return "";

  return `<div class="det-head">Relationships</div>` + groups.map(([label, chips]) =>
    `<div class="rel-row"><span class="rel-label">${label}</span>
       <span class="rel-chips">${chips.join("")}</span></div>`).join("");
}
function relChip(name, sub, color) {
  return `<span class="rel-chip"><span class="rel-dot" style="background:${color}"></span>${esc(name)}${
    sub ? `<span class="rel-sub">${esc(sub)}</span>` : ""}</span>`;
}

// Raw activity rows as compact scrollable tables.
function activityTables(d) {
  const logs = d.logs || [], training = d.training || [], sleep = d.sleep || [];
  let html = `<div class="det-head">Activity — ${logs.length} log${logs.length === 1 ? "" : "s"} · ${
    training.length} training · ${sleep.length} sleep</div>`;

  html += `<div class="det-sub">Logs</div>`;
  html += dataTable([
    ["Date", r => fmtDate(r.log_date)],
    ["Session", r => r.session_type || "—"],
    ["Min", r => r.duration_minutes ?? "—"],
    ["Intensity", r => r.intensity ?? "—"],
    ["Confidence", r => r.confidence ?? "—"],
    ["Stress", r => r.stress ?? "—"],
    ["Focus", r => r.focus ?? "—"],
    ["Sleep h", r => r.sleep_hours ?? "—"],
    ["Match", r => (r.is_match_day ? matchSummary(r) : "")],
    ["Notes", r => r.notes || ""],
  ], logs);

  html += `<div class="det-sub">Training sessions</div>`;
  html += dataTable([
    ["Completed", r => fmtDateTime(r.completed_at)],
    ["Activity", r => prettyActivity(r.activity)],
    ["Duration", r => (r.duration_seconds != null ? fmtDuration(r.duration_seconds) : "—")],
  ], training);

  html += `<div class="det-sub">Sleep entries</div>`;
  html += dataTable([
    ["Date", r => fmtDate(r.entry_date)],
    ["Hours", r => r.sleep_hours ?? "—"],
    ["Quality", r => r.sleep_quality ?? "—"],
  ], sleep);

  return html;
}

function matchSummary(r) {
  const bits = [];
  bits.push("vs " + (r.opponent_name || "opponent") + (r.opponent_level != null ? ` (${r.opponent_level})` : ""));
  if (r.final_score) bits.push(r.final_score);
  if (r.perf_rating != null) bits.push("perf " + r.perf_rating);
  return bits.join(" · ");
}

// ---------- Database tab (raw table browser) ----------
// Order + display labels for the browsable tables.
const TABLE_LIST = [
  ["users", "auth.users"],
  ["profiles", "profiles"],
  ["logs", "logs"],
  ["sleep_entries", "sleep_entries"],
  ["training_sessions", "training_sessions"],
  ["coach_players", "coach_players"],
  ["teams", "teams"],
  ["team_members", "team_members"],
  ["friendships", "friendships"],
];
let tableData = null;    // { tableName: rows[] } from admin_tables
let currentTable = null;

async function loadTables() {
  if (tableData) { renderTableTabs(); return; }   // already fetched

  document.getElementById("table-view").innerHTML = '<div class="empty">Loading database…</div>';
  const pass = sessionStorage.getItem(ADMIN_STORE_KEY);
  const { data, error } = await db.rpc("admin_tables", { p_pass: pass });
  if (error) {
    document.getElementById("table-view").innerHTML =
      `<div class="empty">Couldn't load the database: ${esc(error.message)}</div>`;
    return;
  }
  tableData = data || {};
  renderTableTabs();
}

function renderTableTabs() {
  if (!currentTable) currentTable = TABLE_LIST[0][0];
  const wrap = document.getElementById("table-tabs");
  wrap.innerHTML = TABLE_LIST.map(([key, label]) => {
    const n = (tableData[key] || []).length;
    return `<button class="table-tab${key === currentTable ? " active" : ""}" data-tbl="${key}">${
      esc(label)}<span class="tt-count">${n}</span></button>`;
  }).join("");
  wrap.querySelectorAll(".table-tab").forEach(b =>
    b.addEventListener("click", () => selectTable(b.dataset.tbl)));
  renderCurrentTable();
}

function selectTable(key) {
  currentTable = key;
  document.getElementById("table-search").value = "";
  document.querySelectorAll("#table-tabs .table-tab")
    .forEach(b => b.classList.toggle("active", b.dataset.tbl === key));
  renderCurrentTable();
}

function renderCurrentTable() {
  if (!tableData) return;
  const cont = document.getElementById("table-view");
  const rows = tableData[currentTable] || [];
  if (!rows.length) { cont.innerHTML = '<div class="empty">This table is empty.</div>'; return; }

  const q = (document.getElementById("table-search").value || "").trim().toLowerCase();
  const filtered = q ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(q)) : rows;
  if (!filtered.length) { cont.innerHTML = '<div class="empty">No rows match that filter.</div>'; return; }

  const cols = Object.keys(rows[0]);
  cont.innerHTML =
    `<div class="det-count">${filtered.length} of ${rows.length} row${rows.length === 1 ? "" : "s"}</div>
     <div class="det-table-wrap"><table class="det-table">
       <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
       <tbody>${filtered.map(r =>
         `<tr>${cols.map(c => `<td>${esc(cellVal(r[c]))}</td>`).join("")}</tr>`).join("")}</tbody>
     </table></div>`;
}

function cellVal(v) {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ============================================================
// Relationship map — a small force-directed graph on a canvas.
// No external graph library: repulsion between every node, springs
// along edges, gentle centring, with drag + hover interaction.
// ============================================================
let netFilter = "all";

function setNetFilter(filter) {
  netFilter = filter;
  document.querySelectorAll("#net-filter .toggle-btn")
    .forEach(b => b.classList.toggle("active", b.dataset.filter === filter));
  if (net) { net.destroy(); net = null; }
  startNetwork();
}

function startNetwork() {
  if (net) return;                 // already running
  if (!relData) {                  // still loading (or failed)
    setTimeout(() => { if (!net) startNetwork(); }, 400);
    return;
  }
  net = buildNetwork(relData);
}

function buildNetwork(data) {
  const box = document.getElementById("net-box");
  const canvas = document.getElementById("net-canvas");
  const tip = document.getElementById("net-tooltip");
  const ctx = canvas.getContext("2d");

  // Interaction state — declared up front because the physics/draw loop
  // (started below) reads them synchronously on its first frame.
  let dragging = null, hovered = null;

  // Degree per node so we can optionally hide unconnected users.
  const degree = {};
  for (const e of data.edges) { degree[e.source] = (degree[e.source] || 0) + 1; degree[e.target] = (degree[e.target] || 0) + 1; }

  const keep = new Set(
    (netFilter === "connected" ? data.nodes.filter(n => degree[n.id]) : data.nodes).map(n => n.id)
  );

  // Seed positions on a circle so the layout unfolds smoothly.
  const nodesArr = data.nodes.filter(n => keep.has(n.id));
  let W = box.clientWidth, H = box.clientHeight;
  const cx = W / 2, cy = H / 2;
  const nodes = nodesArr.map((n, i) => {
    const a = (i / Math.max(1, nodesArr.length)) * Math.PI * 2;
    const r = Math.min(W, H) * 0.32;
    return { ...n, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0, fx: null, fy: null };
  });
  const byId = {};
  nodes.forEach(n => (byId[n.id] = n));
  const edges = data.edges.filter(e => byId[e.source] && byId[e.target]);

  // ---- High-DPI sizing ----
  let dpr = window.devicePixelRatio || 1;
  function resize() {
    W = box.clientWidth; H = box.clientHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const onResize = () => resize();
  window.addEventListener("resize", onResize);

  // ---- Physics ----
  const R = 9;                     // node radius
  const REPULSION = 5200;
  const SPRING = 0.045;
  const SPRING_LEN = 96;
  const CENTER = 0.008;
  const DAMP = 0.86;
  let alpha = 1;                   // cools over time; wakes on drag

  function step() {
    // Repulsion (O(n^2) — fine for a roster-sized graph).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.5 + 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = (REPULSION / d2) * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    // Springs along edges.
    for (const e of edges) {
      const a = byId[e.source], b = byId[e.target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - SPRING_LEN) * SPRING * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    // Centring + integrate.
    for (const n of nodes) {
      if (n === dragging) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
      n.vx += (cx - n.x) * CENTER * alpha;
      n.vy += (cy - n.y) * CENTER * alpha;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
    // Keep the whole cluster centred as it settles: nudge every (non-dragged)
    // node toward the box centre by the centroid's offset. Without this the
    // graph can come to rest off-centre once alpha cools.
    let mx = 0, my = 0, cnt = 0;
    for (const n of nodes) { if (n !== dragging) { mx += n.x; my += n.y; cnt++; } }
    if (cnt) {
      const dx = (cx - mx / cnt) * 0.08, dy = (cy - my / cnt) * 0.08;
      for (const n of nodes) {
        if (n === dragging) continue;
        n.x += dx; n.y += dy;
        n.x = Math.max(R + 2, Math.min(W - R - 2, n.x));
        n.y = Math.max(R + 2, Math.min(H - R - 2, n.y));
      }
    }
    if (alpha > 0.03) alpha *= 0.992;   // cool down toward rest
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // Edges first.
    ctx.lineWidth = 1.6;
    for (const e of edges) {
      const a = byId[e.source], b = byId[e.target];
      ctx.strokeStyle = (EDGE_COLOR[e.type] || "#8b96a5") + "cc";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // Nodes.
    ctx.font = "12px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const n of nodes) {
      const color = ROLE_COLOR[n.role] || "#8b96a5";
      ctx.beginPath();
      ctx.arc(n.x, n.y, n === hovered ? R + 2 : R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#0e1116"; ctx.stroke();
      // Label
      const label = n.name && n.name.length > 16 ? n.name.slice(0, 15) + "…" : (n.name || "");
      ctx.fillStyle = "#c9d3de";
      ctx.fillText(label, n.x, n.y + R + 3);
    }
  }

  let raf = null;
  function loop() { step(); draw(); raf = requestAnimationFrame(loop); }
  loop();

  // ---- Interaction ----
  function nodeAt(px, py) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if ((px - n.x) ** 2 + (py - n.y) ** 2 <= (R + 4) ** 2) return n;
    }
    return null;
  }
  function pos(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function onDown(ev) {
    const p = pos(ev);
    const n = nodeAt(p.x, p.y);
    if (n) { dragging = n; n.fx = p.x; n.fy = p.y; alpha = Math.max(alpha, 0.6); canvas.setPointerCapture?.(ev.pointerId); }
  }
  function onMove(ev) {
    const p = pos(ev);
    if (dragging) { dragging.fx = p.x; dragging.fy = p.y; alpha = Math.max(alpha, 0.3); return; }
    const n = nodeAt(p.x, p.y);
    hovered = n;
    if (n) {
      tip.innerHTML = `<div class="tt-name">${esc(n.name || "")}</div>
        <div class="tt-sub">${esc(cap(n.role || "player"))}${n.email ? " · " + esc(n.email) : ""}</div>`;
      const bx = Math.min(p.x + 14, W - 220), by = Math.min(p.y + 14, H - 60);
      tip.style.left = bx + "px"; tip.style.top = by + "px"; tip.style.opacity = "1";
    } else {
      tip.style.opacity = "0";
    }
  }
  function onUp() { if (dragging) { dragging.fx = dragging.fy = null; dragging = null; } }
  function onLeave() { hovered = null; tip.style.opacity = "0"; }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);

  // Empty-state hint drawn once (over the canvas) when there's nothing to show.
  if (!nodes.length) {
    cancelAnimationFrame(raf); raf = null;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#8b96a5"; ctx.font = "14px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(netFilter === "connected" ? "No connected users yet." : "No users yet.", W / 2, H / 2);
  }

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      tip.style.opacity = "0";
    }
  };
}

// ---------- Helpers ----------
// Generic scrollable table. `cols` is an array of [header, row => cell] pairs.
function dataTable(cols, rows) {
  if (!rows.length) return '<div class="hint det-hint">None.</div>';
  return `<div class="det-table-wrap"><table class="det-table">
    <thead><tr>${cols.map(c => `<th>${esc(c[0])}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r =>
      `<tr>${cols.map(c => `<td>${esc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}
const ACTIVITY_LABEL = { box_breathing: "Box breathing", winning_point: "Winning point", ghosting: "Ghosting" };
function prettyActivity(a) { return ACTIVITY_LABEL[a] || cap(String(a || "").replace(/_/g, " ")); }
function fmtDuration(s) {
  s = Math.round(s);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function cap(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }
function fmtNum(v) { return v == null ? "—" : String(v); }
function fmtDate(v) { return v ? String(v).slice(0, 10) : "—"; }
function fmtDateTime(v) {
  if (!v) return "Never";
  const s = String(v);
  return s.slice(0, 10) + " " + s.slice(11, 16);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
