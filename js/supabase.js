// ============================================================
// Supabase client — shared across all pages.
// PASTE YOUR TWO VALUES BELOW (from Supabase → Project Settings → API).
// The anon key is meant to be public; Row Level Security protects data.
// ============================================================

const SUPABASE_URL  = "https://ebyhwddmxoqngvqbgkoo.supabase.co/";       // e.g. https://abcxyz.supabase.co
const SUPABASE_ANON = "sb_publishable_9eAwOE5IexKgr_KezmmQwg_UPYXr3R1";  // the long "anon public" key

// Guard: if keys aren't pasted yet, show a clear banner instead of a blank page.
let db;
let dbReady = false;
if (!/^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) || SUPABASE_ANON.startsWith("YOUR_")) {
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999;background:#f85149;color:#1a0000;" +
      "font:600 14px/1.4 'IBM Plex Mono',monospace;padding:12px 16px;text-align:center;";
    bar.textContent = "Supabase keys not set — open js/supabase.js and paste your Project URL and anon key. See README step 4.";
    document.body.prepend(bar);
  });
  // A harmless stub so pages don't throw before keys are added.
  db = { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => ({}) };
} else {
  // Loaded from the CDN <script> in each HTML file as window.supabase
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  dbReady = true;
}

// Redirect to login if not authenticated. Returns the session.
async function requireSession() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}

// Sign out from anywhere.
async function signOut() {
  await db.auth.signOut();
  window.location.href = "index.html";
}

// ---- Role-based routing ---------------------------------------------------
// Coaches and players get separate interfaces. These helpers decide where a
// given role belongs and are shared by the login flow and the per-page guard.
const COACH_PAGES  = ["coach.html"];
const PLAYER_PAGES = ["dashboard.html", "log.html", "insights.html"];

function landingPage(role) { return role === "coach" ? "coach.html" : "dashboard.html"; }

async function roleOf(userId) {
  const { data } = await db.from("profiles").select("role").eq("id", userId).single();
  return (data && data.role) || "player";
}

// Send a user to their own interface if they've landed on the other one.
// Returns true if a redirect was issued (caller should stop).
function enforcePageRole(role) {
  const page = location.pathname.split("/").pop() || "";
  const isCoach = role === "coach";
  if (isCoach && PLAYER_PAGES.includes(page))  { location.replace("coach.html"); return true; }
  if (!isCoach && COACH_PAGES.includes(page))  { location.replace("dashboard.html"); return true; }
  return false;
}

// Populate the top-bar identity chip (username + role) on any page that has it.
// Runs automatically on load; falls back to the account email if no username is set.
async function loadTopbarUser() {
  if (!dbReady) return;
  const chip = document.getElementById("user-chip");
  if (!chip) return;
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  // Username comes from account metadata; role lives on the profile row.
  const role = await roleOf(session.user.id);

  // Keep each role on its own interface; bail out if we're redirecting away.
  if (enforcePageRole(role)) return;

  // textContent (not innerHTML) keeps a user-chosen username from injecting markup.
  chip.querySelector(".user-name").textContent = session.user.user_metadata?.username || session.user.email;
  chip.querySelector(".user-role").textContent = role;

  // Show only the nav links that belong to this role.
  const isCoach = role === "coach";
  document.getElementById("nav-coach")?.classList.toggle("section-hidden", !isCoach);
  document.querySelectorAll('.nav a[href="dashboard.html"], .nav a[href="log.html"], .nav a[href="insights.html"]')
    .forEach(a => a.classList.toggle("section-hidden", isCoach));
}
document.addEventListener("DOMContentLoaded", loadTopbarUser);
