/* Service worker for FTMO V4 dashboard PWA.
 *
 * Active features (post 2026-05-07):
 * - "Add to Home Screen" install-eligibility for iOS 16.4+ / Android.
 * - Network-first fetch (no caching — dashboard data must stay live).
 * - Web-push handler for backend-delivered notifications when the PWA
 *   is closed. Push subscription registered via useTradeAlerts.js after
 *   user grants Notification permission. Backend send via
 *   tools/push_notifications.py running in the publisher cron.
 * - Notification click → focus an existing PWA window or reopen.
 * - pushsubscriptionchange handler — iOS rotates subscriptions
 *   periodically; we re-subscribe and update Supabase.
 */

// Bump VERSION on every meaningful SW change so iOS re-registers and
// activates fresh code. Without bumping, an existing install keeps
// running the old SW indefinitely on iOS.
const VERSION = "ftmo-v4-2026-05-07-webpush";

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

// 2026-05-07: handle subscription rotation. iOS (and other push services)
// periodically refresh subscription tokens. Without re-subscribing, the
// stored endpoint in Supabase becomes invalid and pushes start returning
// 410 GONE. The push_notifications.py module auto-disables those, but
// catching the rotation here lets us update Supabase BEFORE pushes fail.
self.addEventListener("pushsubscriptionchange", (event) => {
  console.log("[sw] pushsubscriptionchange — re-subscribing");
  event.waitUntil((async () => {
    // Re-subscribe with the same VAPID public key. Note: VAPID public
    // key is duplicated here from useTradeAlerts.js because SW has no
    // module sharing with the React app. If the key is rotated, both
    // copies must be updated.
    const VAPID_PUBLIC_KEY_B64URL =
      "BABEuM4Lxxlozi4h6MFKJFofkekBC_k9pepnX70J9kqRh3olj8hApcg7q7u0JieiJlOC4F7sXmmqaA5wvg0EBpg";
    const padding = "=".repeat((4 - (VAPID_PUBLIC_KEY_B64URL.length % 4)) % 4);
    const base64 = (VAPID_PUBLIC_KEY_B64URL + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = self.atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);

    try {
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: arr,
      });
      const json = newSub.toJSON();
      // Send to dashboard so it can update Supabase. SW can't import
      // from the React app, so we post a message to any open clients
      // that will handle the Supabase upsert. If no clients are open,
      // the next dashboard open will re-subscribe via the mount-time
      // refresh in useTradeAlerts.js.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        c.postMessage({
          type: "PUSH_SUBSCRIPTION_CHANGED",
          subscription: { endpoint: json.endpoint, keys: json.keys },
        });
      }
      console.log("[sw] re-subscribed:", json.endpoint.slice(0, 60) + "...");
    } catch (err) {
      console.warn("[sw] pushsubscriptionchange re-subscribe failed:", err);
    }
  })());
});
