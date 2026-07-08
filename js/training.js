// ============================================================
// Training — index of guided mental/physical activities.
// Static content lives in training.html; this file only gates on auth
// (the page-role guard runs automatically via loadTopbarUser on load).
// ============================================================

(async () => {
  await requireSession();
})();
