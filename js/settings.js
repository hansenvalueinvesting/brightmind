// ============================================================
// Settings — change username (user metadata), email, and password.
// Each section has its own inline message so results are clear.
// ============================================================

let session = null;

(async () => {
  session = await requireSession();
  if (!session) return;

  // Prefill current values. Username lives in the account's user metadata,
  // so it needs no extra DB column / migration.
  document.getElementById("email").value = session.user.email || "";
  document.getElementById("username").value = session.user.user_metadata?.username || "";
})();

function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

async function saveUsername() {
  const username = document.getElementById("username").value.trim();
  if (!username) { setMsg("username-msg", "Enter a username.", "error"); return; }

  const { data, error } = await db.auth.updateUser({ data: { username } });
  if (error) { setMsg("username-msg", error.message, "error"); return; }

  // Keep the local session object in sync so the top-bar chip reflects the change.
  if (data?.user) session.user = data.user;
  setMsg("username-msg", "Username saved.", "ok");
  loadTopbarUser();   // refresh the top-bar chip
}

async function updateEmail() {
  const email = document.getElementById("email").value.trim();
  if (!email) { setMsg("email-msg", "Enter an email address.", "error"); return; }
  if (email === session.user.email) { setMsg("email-msg", "That's already your email.", "error"); return; }

  const { error } = await db.auth.updateUser({ email });
  if (error) { setMsg("email-msg", error.message, "error"); return; }

  // Depending on the Supabase project's email settings, the change may need
  // confirmation from a link sent to the new address before it takes effect.
  setMsg("email-msg", "Email update requested. Check your inbox if confirmation is required.", "ok");
}

async function updatePassword() {
  const pw = document.getElementById("password").value;
  const pw2 = document.getElementById("password2").value;

  if (!pw) { setMsg("password-msg", "Enter a new password.", "error"); return; }
  if (pw.length < 6) { setMsg("password-msg", "Password must be at least 6 characters.", "error"); return; }
  if (pw !== pw2) { setMsg("password-msg", "Passwords don't match.", "error"); return; }

  const { error } = await db.auth.updateUser({ password: pw });
  if (error) { setMsg("password-msg", error.message, "error"); return; }

  document.getElementById("password").value = "";
  document.getElementById("password2").value = "";
  setMsg("password-msg", "Password updated.", "ok");
}
