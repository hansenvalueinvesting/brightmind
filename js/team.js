// ============================================================
// Player "Team" screen — lists the teammates (name + streak only)
// for every team the player belongs to. Data comes from the
// get_my_teams() security-definer RPC.
// ============================================================

let session = null;

(async () => {
  session = await requireSession();
  if (!session) return;

  // Players only; send anyone else to their own interface.
  const role = await roleOf(session.user.id);
  if (role !== "player") { window.location.href = landingPage(role); return; }

  const { data, error } = await db.rpc("get_my_teams");
  render(data || [], error);
})();

function render(rows, error) {
  const el = document.getElementById("teams");
  if (error) {
    el.innerHTML = `<div class="empty">Couldn't load your team: ${esc(error.message)}</div>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = '<div class="empty">You\'re not on a team yet. Your coach can add you to one.</div>';
    return;
  }

  // Group members by team.
  const byTeam = {};
  for (const r of rows) {
    (byTeam[r.team_id] ||= { name: r.team_name, members: [] }).members.push(r);
  }

  el.innerHTML = Object.values(byTeam).map(t => `
    <div class="panel">
      <div class="panel-title">${esc(t.name)} · ${t.members.length} ${t.members.length === 1 ? "member" : "members"}</div>
      ${t.members.map(m => `
        <div class="log-row">
          <span class="log-type">${esc(m.member_name)}</span>
          <span class="badge">🔥 ${effectiveStreak(m.member_streak, m.member_last_log)}</span>
        </div>`).join("")}
    </div>`).join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
