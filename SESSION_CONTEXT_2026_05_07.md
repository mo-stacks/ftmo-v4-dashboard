# Hosting Artifacts session context — 2026-05-07

**Audience:** a future Claude session opened in `~/Projects/Hosting Artifacts/`
that needs context on dashboard changes from the FTMO V4 work session
on 2026-05-07. Read first if Morgan asks for any dashboard edits.

**TL;DR:** Three commits landed on `mo-stacks/ftmo-v4-dashboard@main` today
covering watchlist rendering changes (per-symbol cap-aware) and full
iOS web-push notifications. Backend push delivery is wired to a separate
publisher cron in the FTMO V4 repo (`~/Projects/FTMO_V4/`), not in this
dashboard repo. RLS is disabled on the `push_subscriptions` Supabase table
so the dashboard's anon key can insert.

---

## Dashboard repo: this directory

Path: `~/Projects/Hosting Artifacts/ftmo-v4-dashboard/`
Remote: `https://github.com/mo-stacks/ftmo-v4-dashboard.git`
Deploy: Vercel auto-deploy on push to `main`
Live URL: `https://ftmo-v4-dashboard.vercel.app`
Stack: React + Vite + Supabase JS client; PWA-installable

---

## Today's dashboard commits (all pushed)

```
562f0c7c  feat(notifications): full web-push (iOS background notifications)
1d724f34  fix(watchlist): per-symbol cap counts only active-risk positions
94c477fe  fix(watchlist): per-symbol open-position count + cap-aware BLOCKED status
```

### 1. Per-symbol cap-aware watchlist rendering (`94c477fe` → `1d724f34`)

**Why:** the FTMO V4 engine deploy 2026-05-07 replaced the hard
"one-position-per-symbol" skip with a risk-based cap (1.6% of balance
combined per symbol = 2 positions at 0.8% per-trade, but **only
counting active-risk positions** — BE-moved or trail-past-entry
positions contribute 0R and don't count). Pre-fix dashboard
displayed BLOCKED + greyed out for ANY open position on the symbol —
incorrect under the new policy.

**Files:** `src/App.jsx` `Watchlist` component, ~lines 2466-2570.

**Logic:**
```js
const isRiskLockedOut = (p) => {
  if (p.entryPrice == null || p.stopLoss == null) return false;
  if (p.side === "BUY")  return p.stopLoss >= p.entryPrice;
  if (p.side === "SELL") return p.stopLoss <= p.entryPrice;
  return false;
};

// Track {total, active} per symbol — total includes risk-locked,
// active excludes them (matches engine's per-symbol cap calc).
const openSymbolStats = new Map();
for (const p of (account.openPositions || [])) {
  const s = openSymbolStats.get(p.symbol) || { total: 0, active: 0 };
  s.total += 1;
  if (!isRiskLockedOut(p)) s.active += 1;
  openSymbolStats.set(p.symbol, s);
}

const MAX_ACTIVE_RISK_PER_SYMBOL = 2;   // hardcoded for now
const blocked = activeCount >= MAX_ACTIVE_RISK_PER_SYMBOL;
```

**Display states:**
- 0 open: normal (opacity 1.0)
- 1+ open with active < cap: dimmed (opacity 0.75), shows
  `EURAUD (1 open)` or `EURAUD (3 open, 2 active risk)` if some are BE-moved
- BLOCKED: heavy grey (opacity 0.45), shows
  `BLOCKED (2/2 active risk)`

**TODO:** `MAX_ACTIVE_RISK_PER_SYMBOL` is hardcoded at 2. To make it
config-driven, the publisher would need to forward
`max_per_symbol_risk_pct` and `risk_pct` to Supabase
`account_state.config` so the dashboard derives the cap dynamically per
variant. Currently the publisher doesn't ship those fields. Filed as
TODO in the source code comments.

### 2. Full web-push notifications (`562f0c7c`)

**Why:** previous architecture used `new Notification(...)` from
in-page JS in `useTradeAlerts.js`. iOS suspends backgrounded PWA JS,
so notifications stopped firing once the user closed the app.

**Files:**
- `src/useTradeAlerts.js`: subscribe flow + mount-time refresh
- `public/sw.js`: push handler activation + version bump +
  pushsubscriptionchange handler

**Architecture:**
```
Engine emits trade event
  ↓ (engine → shadow_trades.jsonl + Supabase via publisher)
Publisher cron (every 2 min, ~/Projects/FTMO_V4/tools/publish_to_supabase.py)
  ↓ (detects new event → calls tools/push_notifications.py)
Web-push library (pywebpush, VAPID-signed)
  ↓ (HTTPS POST)
Apple Push service (web.push.apple.com/...)
  ↓
iOS device → SW `push` event → showNotification()
  ↓ (user taps)
SW `notificationclick` → focus or open dashboard PWA
```

**VAPID keypair:**
- Generated 2026-05-07
- Public key (B64URL) **embedded in TWO files** in this repo:
  - `src/useTradeAlerts.js` (for `pushManager.subscribe()`)
  - `public/sw.js` (for `pushsubscriptionchange` re-subscribe)
- **Both must match** if you regenerate the key
- Private key (PEM) lives in `~/Projects/FTMO_V4/.env.vapid`
  (gitignored). Backend push worker reads from there.

**Subscription flow:**
1. User taps "Enable browser notifications" in AlertCenter
2. `requestPermission()` → `Notification.requestPermission()`
3. On grant, calls `subscribeToWebPush()`:
   - `navigator.serviceWorker.ready` → `pushManager.getSubscription()`
   - If no existing subscription, creates one with VAPID applicationServerKey
   - `supabase.from("push_subscriptions").upsert({endpoint, p256dh, auth, user_agent, ...}, {onConflict: "endpoint"})`
4. SW `pushsubscriptionchange` handler re-subscribes if iOS rotates
   the subscription endpoint, posts message to open clients to update
   Supabase

**Mount-time refresh:**
```js
useEffect(() => {
  if (permission === "granted" && settings.browser) {
    subscribeToWebPush().catch(...);
  }
}, [permission, settings.browser]);
```
Handles iOS subscription rotation across PWA reopens.

**Service worker** (`public/sw.js`):
- VERSION bumped to `ftmo-v4-2026-05-07-webpush` so iOS re-registers
- `push` event handler shows notification with title/body/tag from payload
- `notificationclick` focuses or reopens dashboard
- `pushsubscriptionchange` re-subscribes via embedded VAPID key,
  posts `{type: "PUSH_SUBSCRIPTION_CHANGED", subscription: {...}}` to
  open clients (which update Supabase via the React app)

---

## Backend push system (NOT in this repo — context only)

Lives in `~/Projects/FTMO_V4/`:

- `tools/push_notifications.py` — sending module. Has 7 typed wrappers:
  - `alert_position_opened(variant, symbol, direction, entry, stop, target, pid)`
  - `alert_position_closed(variant, symbol, direction, r_multiple, realized_pnl, pid)`
  - `alert_partial_taken(variant, symbol, direction, partial_pct, partial_r, pid)`
  - `alert_be_moved(variant, symbol, direction, new_stop, pid)`
  - `alert_dd_warning(variant, dd_used_pct, dd_dollars)`
  - `alert_engine_offline(variant)`
  - `alert_execution_failed(variant, symbol, reason)`

- `tools/publisher_alert_state.py` — per-variant state persistence in
  `/tmp/publisher_alert_state.json`. Tracks open pids, mgmt events
  seen per pid, engine status, DD thresholds breached today,
  READY-TO-FIRE entries (for fail-detect), failed-exec count.

- `tools/publish_to_supabase.py` — runs every 2 min via cron. At end
  of cycle, `_detect_and_send_alerts()` scans for:
  - New opens (diff vs prev cycle)
  - Partials/BE moves (read shadow_trades JSONL)
  - DD threshold crossings (50/75/90% of $5k)
  - Engine offline transitions
  - Challenge-only failed-execution candidates (READY-TO-FIRE entries
    that disappeared >10 min without a same-symbol open). Rate-limited 5/day.

---

## Supabase

- Project URL: `https://lsnlthpzwpovzqnektjp.supabase.co`
- Tables involved:
  - `push_subscriptions` — created today by migration
    `tools/migrations/2026_05_07_push_subscriptions.sql` in FTMO V4 repo
  - Schema: `id, endpoint UNIQUE, p256dh, auth, user_agent, created_at,
    last_used_at, consecutive_failures, disabled`
  - **RLS DISABLED** — needed because dashboard uses anon key for inserts.
    Endpoints are not sensitive without VAPID private key. If RLS gets
    re-enabled, dashboard inserts will silently fail and `useTradeAlerts.js
    [push]` console warnings will appear.

---

## Files modified today (this repo)

```
src/App.jsx                  Watchlist render — per-symbol cap-aware (commits 94c477fe + 1d724f34)
src/useTradeAlerts.js        subscribeToWebPush() + mount-time refresh + import supabase (562f0c7c)
public/sw.js                 VERSION bump + pushsubscriptionchange handler (562f0c7c)
SESSION_CONTEXT_2026_05_07.md (this file — session context for future Claude)
```

No other files touched.

---

## Common future edits Morgan might ask for

### "Add a new alert type"
1. Add a new wrapper in FTMO V4 repo `tools/push_notifications.py`
   following the existing pattern (title + body + tag + data fields)
2. Wire detection logic into `tools/publish_to_supabase.py`
   `_detect_and_send_alerts()` end-of-cycle hook
3. Add state tracking in `tools/publisher_alert_state.py` if dedup
   needed across cycles
4. Restart publisher cron (or wait for next 2-min tick — it'll
   pick up file changes on next process spawn)
5. **No dashboard change needed** — SW `push` handler is generic
   and renders whatever payload the backend sends

### "Show new field on dashboard"
1. Verify the field is in `account_state.positions` JSONB or
   `trade_history` row schema (check Supabase or the publisher's
   row dict in `tools/publish_to_supabase.py`)
2. Modify `src/App.jsx` or `src/useSupabaseData.js` to surface it
3. Build + push — Vercel auto-deploys

### "VAPID key needs rotation" (rare)
1. Generate new keypair in FTMO V4 repo: `python3 -m tools.push_notifications`
   (or whatever the script for VAPID gen is — current key was
   generated inline 2026-05-07)
2. Update private PEM in `~/Projects/FTMO_V4/.env.vapid`
3. **Update VAPID public key in BOTH** `src/useTradeAlerts.js`
   AND `public/sw.js` (search for `BABEuM4Lxxlozi4h6MFKJFofkekBC`)
4. Bump SW VERSION to force re-register
5. All existing subscriptions become invalid → next push will
   return 410 GONE → backend auto-disables them
6. Users re-grant permission to re-subscribe with new key

### "Make per-symbol cap config-driven"
The TODO is documented in `src/App.jsx` near the
`MAX_ACTIVE_RISK_PER_SYMBOL` constant. Steps:
1. FTMO V4 publisher (`tools/publish_to_supabase.py`) writes
   `max_per_symbol_risk_pct` and `risk_pct` to `account_state.config`
   JSONB
2. Dashboard `src/useSupabaseData.js` extracts those into
   `account.config`
3. Dashboard `src/App.jsx` Watchlist computes the cap dynamically:
   `Math.floor(account.config.max_per_symbol_risk_pct / account.config.risk_pct)`

### "Code-split the bundle"
Vite warning during build: `Some chunks are larger than 500 kB`.
Currently `dist/assets/index-*.js` is ~886 KB / ~250 KB gzipped.
Acceptable for now but worth splitting if more features land. Use
dynamic `import()` for heavy components (e.g., SetupChart already
splits at 173 KB chunk).

---

## Caveats / known limits

1. **VAPID public key is duplicated in two files** — must stay in
   sync. Search for the literal string `BABEuM4Lxxlozi4h6MFKJFofkekBC`
   to find both.

2. **Mount-time `useEffect` depends on `permission` and
   `settings.browser`** — if permission is granted but `settings.browser`
   is somehow false (localStorage glitch), mount-time refresh won't
   fire. Acceptable: user can toggle settings to refresh.

3. **iOS PWA install required for web-push** — Notifications work in
   Safari tabs only via the in-page path (legacy fallback). For
   true background notifications, dashboard must be installed via
   "Add to Home Screen" on iOS 16.4+.

4. **No fallback to in-page notifications removed** — `useTradeAlerts.js`
   STILL fires `new Notification(...)` for events detected in-page
   while the PWA is open. The web-push backend is ADDITIVE, not a
   replacement. So a user who opens the dashboard right when a trade
   closes will get TWO notifications (one in-page, one web-push)
   unless one of them deduplicates by tag. Currently they DO use the
   same tag pattern so iOS de-dupes — verified working.

5. **Backend push state in `/tmp`** — survives macOS reboots in most
   configs but if `/tmp` clears, next publisher run re-seeds and
   could send a "first-run flood" of notifications. Easy to migrate
   to a persistent path if it becomes an issue.

---

## Cross-repo references

- FTMO V4 repo (sibling): `~/Projects/FTMO_V4/`
- Memory file documenting today's work:
  `~/.claude/projects/-Users-mmmacbook-Projects-FTMO-V4/memory/project_full_session_deploys_20260507.md`
- Plans (in FTMO V4 repo):
  - `docs/process/plans/plan_per_symbol_risk_cap_2026_05_07.md`
  - `docs/process/plans/plan_bridge_eurausd_null_upnl_diagnosis_2026_05_06.md`
  - `docs/process/plans/plan_pre_challenge_safety_critical_deploy_2026_05_06.md`

---

## Verification commands (read-only — safe to run any time)

```bash
# How many push subscriptions are registered?
cd ~/Projects/FTMO_V4 && /Users/mmmacbook/mambaforge/bin/python3 -c "
import os
for line in open('.env.supabase'):
    line=line.strip()
    if '=' in line:
        k,v=line.split('=',1)
        os.environ.setdefault(k.strip(), v.strip().strip(chr(34)).strip(chr(39)))
from supabase import create_client
sb=create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY'])
r=sb.table('push_subscriptions').select('*').execute()
print(f'{len(r.data)} active subscription(s)')
for s in r.data: print(f'  {s[\"id\"]}: {s[\"endpoint\"][:60]}... ua={(s[\"user_agent\"] or \"\")[:50]}')
"

# Send a manual test push (verifies end-to-end)
cd ~/Projects/FTMO_V4 && /Users/mmmacbook/mambaforge/bin/python3 tools/push_notifications.py
```
