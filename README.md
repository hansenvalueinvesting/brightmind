# BrightMind Athletics — Prototype

A web app where squash players log training, mental state, and recovery in under 2 minutes, see a streak counter, and get one insight on whether sleep correlates with performance.

Pure static frontend (HTML/CSS/JS) + Supabase backend (auth + Postgres). No build step. Deploys free to GitHub Pages, Netlify, or Vercel.

---

## Setup (10 minutes, one time)

### 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) → sign in → **New project**.
2. Give it a name and a database password (save it somewhere). Pick the free tier. Wait ~2 min for it to provision.

### 2. Create the database
1. In your project: left sidebar → **SQL Editor** → **New query**.
2. Open `schema.sql` from this repo, copy its entire contents, paste, and click **Run**.
3. You should see "Success. No rows returned." That created the `profiles` and `logs` tables, security rules, and the signup trigger.

### 3. Paste your keys into the app
1. Left sidebar → **Project Settings** (gear) → **API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `js/supabase.js` and replace the two placeholder values:
   ```js
   const SUPABASE_URL  = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON = "your-anon-public-key";
   ```
   The anon key is safe to expose publicly — Row Level Security (set up by `schema.sql`) locks every row to its owner.

---

## Run it locally
Because browsers block ES modules over `file://`, serve the folder over HTTP:

```bash
# from inside the brightmind/ folder
python3 -m http.server 8000
```
Open <http://localhost:8000>.

---

## Deploy free (GitHub Pages)
1. Create a new GitHub repo and push these files to it.
2. Repo → **Settings** → **Pages** → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → Save.
3. Your app goes live at `https://YOUR-USERNAME.github.io/YOUR-REPO/` in ~1 minute.

*(Netlify/Vercel: drag the folder into their dashboard, or connect the repo. Same result, no config.)*

---

## File map
```
index.html        Screen 1 — sign up / log in (hard consent gate)
log.html          Screen 2 — daily log (training / mental / recovery / tournament)
dashboard.html    Screen 3 — streak, 30-day trend chart, last 7 entries
insights.html     Screen 4 — sleep vs. performance scatter + correlation
css/style.css     shared styles
js/supabase.js    DB client + config (YOUR KEYS GO HERE)
js/auth.js        signup/login/consent
js/log.js         form submit + streak logic
js/dashboard.js   streak, trend chart, recent entries
js/insights.js    sleep-performance correlation
schema.sql        run once in Supabase SQL editor
```

## Notes on behavior
- **Consent** is a hard gate: no account is created without the checkbox. The acceptance time is stored as `consent_at` on the user's profile.
- **Streak**: +1 for a consecutive calendar day, unchanged if you log twice in one day, resets to 1 after a missed day. Stored on the profile as `streak_count` / `last_log_date`.
- **Tournament section** appears when **Session type = Match play**.
- **Insights** uses your match-day performance rating when available, otherwise "mood after" as a general performance proxy, so the chart is useful before your first logged match. It needs 3+ days with sleep recorded.
