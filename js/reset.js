// ============================================================
// Password reset — completion screen.
// Reached from the recovery link in the Supabase email. supabase-js
// (detectSessionInUrl, on by default) parses the token from the URL hash,
// establishes a short-lived recovery session, and fires PASSWORD_RECOVERY.
// We then let the user set a new password via db.auth.updateUser().
// ============================================================

function setMsg(text, kind) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function showForm() {
  document.getElementById("reset-fields").classList.remove("section-hidden");
  document.getElementById("reset-invalid").classList.add("section-hidden");
}

function showInvalid(reason) {
  document.getElementById("reset-fields").classList.add("section-hidden");
  document.getElementById("reset-invalid").classList.remove("section-hidden");
  if (reason) setMsg(reason, "error");
}

let ready = false;    // a recovery session is active — form is usable
let failed = false;   // link was missing/expired/invalid — don't override with a late fallback

function markReady() { if (!failed && !ready) { ready = true; showForm(); } }
function markFailed(reason) { if (!ready) { failed = true; showInvalid(reason); } }

// If the link itself carried an error (e.g. expired), Supabase puts it in the
// URL hash. Surface that immediately rather than showing a dead form.
(function checkLinkError() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const err = hash.get("error_description") || hash.get("error");
  if (err) markFailed(decodeURIComponent(err.replace(/\+/g, " ")));
})();

if (dbReady) {
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) markReady();
  });

  // Fallback: if the token was already exchanged before this listener attached,
  // an existing session means we're good to go.
  db.auth.getSession().then(({ data: { session } }) => {
    if (session) markReady();
    // Give detectSessionInUrl a moment; if still no session and no explicit
    // error surfaced, the link is missing or malformed.
    else setTimeout(() => {
      if (!ready && !failed) markFailed("Open this page from the reset link in your email.");
    }, 1500);
  });
}

async function submitReset() {
  const pw  = document.getElementById("password").value;
  const pw2 = document.getElementById("password2").value;
  const btn = document.getElementById("submitBtn");

  if (pw.length < 6)  { setMsg("Password must be at least 6 characters.", "error"); return; }
  if (pw !== pw2)     { setMsg("The two passwords don't match.", "error"); return; }

  btn.disabled = true;
  setMsg("Updating…");

  const { error } = await db.auth.updateUser({ password: pw });
  if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }

  setMsg("Password updated. Redirecting to login…", "ok");
  // Sign out the recovery session so they log in fresh with the new password.
  await db.auth.signOut();
  setTimeout(() => { window.location.href = "login.html"; }, 1500);
}
