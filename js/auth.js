// ============================================================
// Screen 1 — auth: login / signup, hard consent gate.
// ============================================================

let mode = "login";

// If already logged in, skip straight to the right interface for this role.
(async () => {
  const { data: { session } } = await db.auth.getSession();
  if (session) window.location.href = landingPage(await roleOf(session.user.id));
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
      const box = document.getElementById("consentBox");
      box.classList.remove("invalid");
      // Force reflow so the shake animation re-triggers on repeat attempts.
      void box.offsetWidth;
      box.classList.add("invalid");
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

    // role is the value chosen on the signup form.
    window.location.href = landingPage(role);
  } else {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) { setMsg(error.message, "error"); btn.disabled = false; return; }
    window.location.href = landingPage(await roleOf(data.user.id));
  }
}

// ---- Password reset ---------------------------------------------------------
// Sends a recovery email via Supabase Auth. The link lands the user on
// reset.html (same folder as this page, so the app works under any subpath,
// including GitHub Pages' /brightmind/). reset.js completes the change there.
async function sendReset() {
  const email = document.getElementById("email").value.trim();
  if (!email) {
    setMsg("Enter your email above first, then tap “Forgot password?” again.", "error");
    document.getElementById("email").focus();
    return;
  }

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  setMsg("Sending reset link…");

  // Resolve reset.html relative to the current page → correct under any host/subpath.
  const redirectTo = new URL("reset.html", window.location.href).href;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });

  btn.disabled = false;
  // Don't reveal whether the address has an account (avoids email enumeration).
  if (error) { setMsg(error.message, "error"); return; }
  setMsg("If that email has an account, a reset link is on its way. Check your inbox (and spam).", "ok");
}

// Clear the consent error highlight once the box is ticked.
document.getElementById("consent").addEventListener("change", (e) => {
  if (e.target.checked) document.getElementById("consentBox").classList.remove("invalid");
});

// Submit on Enter.
document.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
