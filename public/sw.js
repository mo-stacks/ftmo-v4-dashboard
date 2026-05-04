/* Service worker for ICS V1 dashboard PWA.
 *
 * Minimal: satisfies the install-eligibility requirement for "Add to Home
 * Screen" on iOS and Android, plus a network-first fetch handler so the
 * app stays fresh on every load (this dashboard is read-only data, no
 * offline mode needed).
 *
 * Future: when web-push is wired, push event listener goes here. For now
 * notifications fire from the in-page useTradeAlerts hook while the PWA
 * is open / recently active.
 */

const VERSION = "ics-v1-2026-05-04";

self.addEventListener("install", (event) => {
  // Activate immediately on install — no waiting room
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of any open clients without requiring a reload
  event.waitUntil(self.clients.claim());
  // Cleanup old caches if any (we're not caching aggressively but be safe)
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    ))
  );
});

// Network-first: always try the network so dashboard data stays current.
// If offline, fall through (browser default error). We deliberately do
// NOT cache responses — the dashboard polls live data and serving stale
// trades/positions from cache would be misleading.
self.addEventListener("fetch", (event) => {
  // Pass through — browser handles. Having the listener registered is
  // what makes the service worker "active" and the app installable.
  return;
});

// Placeholder push handler for future web-push integration.
// Currently unused; in-page useTradeAlerts handles all notifications
// while the PWA is open or in background (iOS keeps the SW alive
// briefly even after the PWA is closed; Android keeps it longer).
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch (_) { payload = { title: "ICS V1", body: event.data.text() }; }

  const title = payload.title || "ICS V1";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: payload.tag || "ics-v1-default",
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click on a notification → focus or open the dashboard
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow("/");
    })
  );
});
