// ============================================================
// Screen 1 — auth: login / signup, hard consent gate.
// ============================================================

let mode = "login";

// If already logged in, skip straight to the dashboard.
(async () => {
  const { data: { session } } = await db.auth.getSession();
  if (session) window.location.href = "dashboard.html";
})();

function switchTab(next) {
  mode = next;
  document.getElementById("tab-login").classList.toggle("active", next === "login");
  document.getElementById("tab-signup").classList.toggle("active", next === "signup");
  document.getElementById("signup-fields").classList.toggle("section-hidden", next !== "signup");
  document.getElementById("submitBtn").textContent = next === "login" ? "Log in" : "Create account";
  document.getElementById("password").autocomplete = next === "login" ? "current-password" : "new-password";
  setMsg("");
}

function setMsg(text, kind) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

async function submitAuth() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const btn = document.getElementById("submitBtn");

  if (!email || !password) { setMsg("Enter your email and password.", "error"); return; }

  btn.disabled = true;
  setMsg("");

  if (mode === "signup") {
    const role = document.getElementById("role").value;
    const consent = document.getElementById("consent").checked;

    // Hard gate: no account without consent.
    if (!consent) {
      setMsg("You must accept the consent statement to create an account.", "error");
      btn.disabled = false;
      return;
    }

    const { data, error } = await db.auth.signUp({
      email, password,
      options: { data: { role } }   // role flows into the profile via DB trigger
    });

    if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }

    // Stamp consent timestamp on the profile.
    // (Profile row is created by the DB trigger on signup.)
    const userId = data.user?.id;
    if (userId) {
      await db.from("profiles").update({ consent_at: new Date().toISOString() }).eq("id", userId);
    }

    // If email confirmation is OFF (default for new projects), a session exists now.
    if (data.session) {
      window.location.href = "dashboard.html";
    } else {
      setMsg("Account created. Check your email to confirm, then log in.", "ok");
      switchTab("login");
      btn.disabled = false;
    }
  } else {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }
    window.location.href = "dashboard.html";
  }
}

// Submit on Enter.
document.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
