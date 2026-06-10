// ============================================================
// Supabase client — shared across all pages.
// PASTE YOUR TWO VALUES BELOW (from Supabase → Project Settings → API).
// The anon key is meant to be public; Row Level Security protects data.
// ============================================================

const SUPABASE_URL  = "YOUR_SUPABASE_URL";       // e.g. https://abcxyz.supabase.co
const SUPABASE_ANON = "YOUR_SUPABASE_ANON_KEY";  // the long "anon public" key

// Guard: if keys aren't pasted yet, show a clear banner instead of a blank page.
let db;
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
