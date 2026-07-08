// ============================================================
// Top-bar hamburger dropdown.
// Collapses the nav links into a dropdown so the top bar stays compact
// regardless of how many sections a role can see. Kept dependency-free
// (no Supabase/CDN) so the menu always works even if other scripts fail.
// ============================================================

function setNavOpen(open) {
  const menu = document.getElementById("nav-menu");
  const toggle = document.getElementById("nav-toggle");
  if (!menu || !toggle) return;
  menu.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleNav(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("nav-menu");
  setNavOpen(menu ? !menu.classList.contains("open") : false);
}

// Close the menu on an outside click, a link tap, or the Escape key.
document.addEventListener("click", (e) => {
  const menu = document.getElementById("nav-menu");
  if (!menu || !menu.classList.contains("open")) return;
  if (e.target.closest("#nav-toggle")) return;
  if (!e.target.closest("#nav-menu") || e.target.closest("#nav-menu a")) setNavOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setNavOpen(false);
});
