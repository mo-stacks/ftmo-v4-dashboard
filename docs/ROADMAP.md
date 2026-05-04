# Trading Dashboard — Roadmap

**Maintained:** rolling
**Last updated:** 2026-05-04
**Owner:** Morgan
**Living document** — update statuses inline as work ships, move
completed phases to the "Shipped" section, never delete (history is
the audit trail for what was promised vs delivered).

---

## North star

A single set of dashboards that covers the whole trading life-cycle:

- **Investor view** (static, presentation-grade) — `ics-v2-investor`,
  `equity-dashboard-4yr`, `financial-trajectory`, `portfolio-comparison`.
  These exist and are stable. Updates flow through
  `data/strategy_metrics.json` + `scripts/sync_metrics.py`.
- **Operator view** (live, real-time) — `ftmo-v4-dashboard` at
  `https://ftmo-v4-dashboard.vercel.app`. The active development surface;
  the rest of this document is about it unless noted otherwise.
- **Strategy generator** (interactive, exploratory) — not yet built.
  See "Strategy Generator" section below for the design.

---

## Shipped (foundation)

Everything below is live on https://ftmo-v4-dashboard.vercel.app today.
Listed for context — no further work needed unless a regression
surfaces.

| Capability | Notes |
|---|---|
| Multi-variant overview (Production · Challenge · Alpha · Bravo · Charlie · Delta) | per-account drill-down with dedicated tab |
| Live engine status (balance, equity, day P&L, daily/trailing DD bars) | data via Supabase poll, 2-min cadence |
| Open Positions with expandable detail panel | entry, original/live stop, original/live target, R-multiple, P&L, time held, time-anchored chart with markers |
| Watchlist with priority queue + expandable setup-detail panels | TRIGGER / RISK / IMPULSE / GATE / QUALITY sections, gate=100 ETA, pan-to-recent chart |
| Trade History (paginated, 10/page) with expandable detail panels | SETUP / ENTRY / EXIT / RESULT sections, focus-on-entry chart with entry/exit markers |
| Lightweight TradingView candlestick chart with H4/M10 toggle | annotation lines for break/stop/target/fib/impulse, autoscale extends to encompass annotations, lazy-loaded (53 KB gzipped chunk) |
| Trade Performance section | equity curve, monthly heatmap, R-distribution, by-symbol breakdown |
| Mobile responsive (375px+) with sticky-positioned detail panels | charts no longer bleed past viewport in expanded rows |
| ICS-V2 unified color/typography | `#22b89a` teal-green / `#cf5b5b` coral-red, Urbanist + Space Grotesk fonts |
| **Trade alerts** — browser notifications + in-page toast + Web Audio beep | per-event toggles (entry/modify/close), per-tab dedupe, settings persist to localStorage |
| **PWA** — `manifest.json` + service worker + iOS / Android home-screen install | local notifications fire while PWA is foreground / recent-background |
| Egress optimization (lazy candles + delta refresh) | ~99 % reduction; 36 GB/day → ~290 MB/day per tab |
| Supabase auth-lock fix | resolved "Lock was stolen by another request" multi-tab error |

---

## Engine handoffs in flight

These live in `~/Projects/FTMO_V4/SESSION_HANDOFF_*.md`. Dashboard
side already wired with graceful `?? null` degradation; once each
handoff lands, the corresponding fields populate automatically with
zero further dashboard work.

| Handoff | Resolves |
|---|---|
| `SESSION_HANDOFF_watchlist_setup_chart.md` | per-watchlist-entry candles in `wl_json` |
| `SESSION_HANDOFF_position_detail.md` | original stop/target tracking + per-position candles |
| `SESSION_HANDOFF_trade_history.md` | extended trade_history columns + per-trade candles |
| `SESSION_HANDOFF_trade_open_setup_capture.md` | last 7 NULL columns (impulse_*, atr_multiple, consistency, pullback_depth, fib_786) |

Status: most are landed; the trade_open setup-capture is the smallest
remaining touch (~15 lines across `engine/run_live.py` + `tools/publish_to_supabase.py`).

---

## Q3 2026 — Real-time + zero-maintenance alerts

Goal: reduce notification latency from ~2 min (current poll) to
<5 seconds, and have alerts fire even when the PWA is fully closed
or the phone is locked for hours.

### 1. Supabase Realtime subscriptions (replace polling for live data)

**Why:** Trade events go from "you'll know within 2 minutes" to "you
know within seconds." Same alert UI, just a faster trigger.

**Scope:**
- Subscribe to `account_state` postgres_changes via
  `supabase.channel().on('postgres_changes', ...)`
- Same `useTradeAlerts` diffing logic; just driven by realtime push
  instead of polling
- Keep one polling fallback per minute for snapshot freshness in
  case the realtime channel drops
- Free tier includes 2 M Realtime messages/month. Estimate: 6 variants
  × ~20 row writes/hour × 730 hr/month ≈ 88 K — well within budget

**Estimated effort:** ~half day. Risk-9: dry-run on Charlie variant
first to validate behavior before promoting to all 6.

**Owner:** dashboard session (no engine changes)

### 2. Web Push (zero-maintenance — alerts even when PWA closed)

**Why:** Local notifications stop firing when iOS suspends the PWA
process or you've force-closed it. Web Push wakes the service worker
even from a cold start and fires the notification regardless of app
state.

**Architecture:**
1. Generate VAPID keys (one-time, stored in publisher env)
2. PWA subscribes to push at install time via `pushManager.subscribe()`
   — one-time user click on a "Subscribe to push alerts" button
3. Subscription endpoint stored in a new Supabase table:
   `push_subscriptions { id, endpoint, keys_p256dh, keys_auth, device_label, created_at }`
4. Publisher (Python `tools/publish_to_supabase.py`) gains a
   `notify_push_subscribers()` step that fires alongside the
   `account_state` upsert when a position open/close/modify is detected
5. Service worker `push` handler is already stubbed in `public/sw.js`
   from this commit — just needs the payload contract documented

**Honest cost:**
- ~half day on the dashboard side (subscription button + SW push handler)
- ~half day on the engine side (VAPID setup + push dispatch in publisher)
- One small new dependency: `pywebpush` (Python) for the publisher

**No infrastructure cost** — push goes through browser-vendor relay
servers (Apple, Google), not your own server. Free, unmetered.

**Owner:** split — dashboard session for SW + subscription UI;
engine session for VAPID + publisher push step. Sequence: Realtime
first (smaller change, higher daily value), then Web Push once
Realtime has proven the alert pattern.

### 3. Account comparison view

**Why:** Today you see one account at a time. To pick which variant
deserves the next FTMO funded slot, side-by-side metrics matter.

**Scope:**
- New "Compare" tab next to "Main"
- Multi-select up to 6 variants (default: all)
- Side-by-side: balance/equity sparkline, daily P&L, max DD used,
  win rate, Sharpe, R-multiple histogram, per-symbol contribution
- Linked timeframe selector (1d / 1w / 1m / all)

**Estimated effort:** ~1 day. Risk: low — all data is already in
`useSupabaseData`'s account map.

**Owner:** dashboard session

---

## Q4 2026 — Strategy Generator

A new top-level tab in the operator dashboard. The trader picks
strategy parameters via UI controls, hits "Run backtest," and the
dashboard renders results from the FTMO_V4 backtest engine — with
proper in-sample / out-of-sample discipline so the trader doesn't
overfit a curve.

### Why this matters

Today strategy iteration looks like: edit a YAML, run a backtest
script, copy R-multiples into a spreadsheet, eyeball the equity curve.
Slow loop. The dashboard turns that into "drag a slider, see new
curve in 30 seconds" — making real iteration possible.

The output also feeds the investor presentation: when a new variant
proves out, `data/strategy_metrics.json` gets updated and
`scripts/sync_metrics.py` propagates it to all the static dashboards
in one push.

### Adjustable variables (UI controls)

Grouped to mirror how the engine actually thinks about strategy:

**Setup classifier**
- ATR multiple band (slider: 2.0–10.0)
- Consistency threshold (slider: 0.30–0.80)
- Pullback depth band (slider: 0.30–0.85)
- Leg candles range (range slider: min/max)
- IBO vs CBO toggle (or weight blend)

**Quality gate**
- Quality score threshold (slider: 0–100, default 58 / 100)
- Optional: per-class gates (different for forex vs stocks vs crypto)

**Risk**
- % per trade (slider: 0.25–2.0%)
- Max concurrent positions (1–10)
- Max floating risk cap (% of balance)
- Daily DD circuit-breaker threshold

**Trade management**
- Partial exit trigger R (slider: 0.3–1.5R)
- Partial exit % (slider: 10–50%)
- BE move rule: coincident with partial / decoupled at +N R
- Trailing stop config: off / fixed pip / activate-at-R / structure
- Hard target: fib 1.272 / fib 1.618 / fixed RR

**Universe**
- Multi-select instruments grouped by class
- Class-level toggles (forex / metals / crypto / equities / indices)

**Filters**
- Time-of-day window (London / NY / Asia / 24h)
- Day-of-week mask
- Optional: regime filter (trending / ranging detector)

**Execution timing**
- Entry-delay bars (0–5)
- M10 vs M5 vs M15 entry timeframe
- Engine-validator gate (search_start_gate, current PROD value 100)

### Output sections

**1. Headline metrics card**
Total R, win rate, profit factor, Sharpe, Sortino, max DD, monthly
hit rate, exposure stats. Same shape as the existing investor
dashboards so visual literacy transfers.

**2. Equity curve** with IS / OOS shaded regions
Solid line for in-sample, dashed for out-of-sample. Shaded background
distinguishes the two regimes. If OOS performance falls off, that's
visually obvious.

**3. Monthly heatmap**
48 cells, color-keyed by R magnitude. Rows = years, columns = months.
Bonus row at the bottom: column-level annual totals.

**4. Per-instrument breakdown**
Sortable table with R contribution, trade count, win rate, expectancy
per symbol. Highlights which instruments carry the strategy.

**5. R distribution histogram**
Bin counts per R bucket. Shows whether the edge is "many small wins"
or "few big winners."

**6. Drawdown chart**
Underwater plot — depth + duration + recovery time of every drawdown.

**7. IS vs OOS comparison block**
Side-by-side metrics for in-sample vs out-of-sample windows.
Material drop in any metric = potential overfit. Flag with color
codes (green if degradation < 20%, amber 20–40%, red > 40%).

**8. Walk-forward analysis** (optional, slower)
N forward windows, each trained on a prior IS slice and tested on
the next OOS slice. Shows whether the strategy "ages well."

**9. Save / load profile**
Each parameter set saved as a named profile (e.g., "v3.4 conservative
forex"). Reload, fork, compare.

**10. Promote to live**
Once a profile shows good IS/OOS parity, one-click "Promote" writes
the params to `~/Projects/FTMO_V4/config_<variant>.yaml` for the next
engine restart. Confirms with a diff preview.

### Architecture sketch

The big question: where does the backtest run?

**Option A — Local backtest server (recommended)**
- Run `tools/backtest_server.py` on the same machine as the engine
- Exposes `/backtest` POST endpoint; accepts a config blob, returns
  the result JSON
- Dashboard tab calls this endpoint via a localhost reverse-tunnel
  (e.g., Cloudflare Tunnel) so the live Vercel-deployed dashboard
  can talk to your machine
- Pros: reuses existing FTMO_V4 backtest infra (bar-by-bar replay,
  realistic constraints). No data movement to cloud.
- Cons: backtest only works while your machine is online and the
  tunnel is up

**Option B — Worker-pool architecture**
- Dashboard sends config → message queue (Supabase Realtime + a
  jobs table)
- Worker process on local machine (or any always-on box) pulls jobs,
  runs backtest, writes result back to Supabase
- Pros: queueable, parallelizable, works even if dashboard is closed
  during long runs
- Cons: more infrastructure

**Option C — Precomputed grid search** (simplest)
- Define a grid of N parameter combinations
- Backtest all overnight, write results to a `strategy_grid` Supabase
  table
- Dashboard shows a filterable / sortable view of the grid
- Pros: no backend needed; dashboard is purely a viewer
- Cons: not truly interactive — slider movement maps to nearest grid
  point, not a fresh backtest

**Recommendation: A first, evolve to B if needed.** Option A is the
shortest path to a useful tool. Option B is the right answer if it
becomes a core workflow.

### Data inputs

The FTMO_V4 backtest engine already has all the historical data:
- 4-year minute bars across 23+ instruments
- Bar-by-bar replay matching live engine semantics
- Realistic constraints: spreads, slippage, broker rules, prop firm
  limits

No new data work required. The `tools/backtest_server.py` would just
expose the existing engine via HTTP.

### Phased delivery

**Phase 1 — Read-only grid browser (1 week)**
Build the UI shell + result-rendering components. Backend is a
hand-curated set of ~20 strategy configurations precomputed and stored
in a `strategy_results` Supabase table. Validates the UX without
needing the live backtest service.

**Phase 2 — Live backtest service (~2 weeks)**
- Build `tools/backtest_server.py` (HTTP wrapper around existing engine)
- Cloudflare Tunnel for secure remote access to the local server
- Auth token in the request header so the public dashboard can't
  trigger arbitrary backtests
- Dashboard "Run backtest" button calls the service; shows progress
  + results

**Phase 3 — Save / load / fork / promote (~1 week)**
- `strategy_profiles` Supabase table for named configs
- "Promote to variant" flow that writes a config_*.yaml on the
  engine machine

**Phase 4 — Walk-forward + advanced analytics (~1 week)**
- WFO automation
- Monte Carlo of trade-order shuffling (sequence risk)
- Regime-conditioned analysis (bull / bear / chop)

**Total estimated effort:** ~5 weeks of dashboard work + ~1 week of
engine work for the backtest server wrapper.

---

## H1 2027 — Long-term

Lower priority but worth tracking so we don't lose them.

### Strategy lab (research mode)
Beyond the parameter sweeper: structural changes (new setup classes,
new exit logic). Needs a more flexible config schema.

### Multi-broker view
Today everything is cTrader. As real-money accounts come online (IBKR,
direct exchange API for crypto), unify them under one dashboard.

### Risk dashboard
Portfolio-level greeks (sensitivity to dollar moves), correlation
matrix between open positions, marginal-risk-budget remaining.

### Auto-deployment of generated strategies
Once a Strategy Generator profile passes IS / OOS / WFO gates, allow
a one-click promotion that:
1. Writes the config to the engine machine
2. Triggers a controlled engine restart
3. Flags the variant as "newly promoted — observe closely for 2 weeks"
4. Auto-rolls-back if any of: max DD breach, win-rate degradation
   > 30%, profit-factor degradation > 40%

### Mobile-first redesign
Currently mobile is responsive but desktop-first in design. If iPhone
becomes the primary monitoring surface, a ground-up mobile redesign
might be worth the effort.

### Notifications for strategy-level events
Beyond per-trade alerts: weekly summary digest, monthly profit
milestone, drawdown breach warning, FTMO compliance alerts (daily DD
nearing limit).

### Realtime collaborative annotations
Click on a trade in the history → leave a note. Notes visible across
all your devices. Useful for journaling without leaving the dashboard.

---

## Open questions / decisions needed

These are blocking specific roadmap items. Please confirm direction
when convenient.

1. **Web Push priority.** Do you want true push (works when phone is
   locked / app closed)? Or is "PWA in background works fine" enough
   for now?
   - If yes → engine session needs ~half day for VAPID + publisher
     push step.

2. **Strategy Generator architecture.** Option A (local backend +
   tunnel), B (queue + worker), or C (precomputed grid)?
   - My recommendation is A, evolving to B. But if you want to
     start truly minimally, C is the lowest-effort first step.

3. **Investor dashboard split.** When the Strategy Generator promotes
   a new variant, should the investor dashboards (`ics-v2-investor`,
   etc.) automatically update via the metrics sync, or stay frozen
   to the current published version until you manually approve?
   - Default suggestion: manual approval. Investor docs shouldn't
     change without you explicitly publishing.

4. **Account comparison view scope.** Just the 6 existing variants,
   or also support comparing strategies *as-if* across the same time
   period (i.e., what would Charlie have done with Bravo's trades)?
   The latter is much harder.

---

## How this document gets updated

- **When a phase ships** — move it from its quarterly section into
  "Shipped (foundation)" with a one-line note. Don't delete.
- **When a new idea lands** — add to the appropriate quarter
  (or "Long-term" if uncertain). Mark with `[NEW]` until prioritized.
- **When direction changes** — strike through (or move to "Decided
  against" subsection) the abandoned plan with a one-line "why."
  Preserves the decision audit trail.
- **At each session start** — Claude (or any session-Claude) reads
  this first, references it when planning new work, and updates it
  when work completes.

---

## Cross-references

- Active engine handoffs: `~/Projects/FTMO_V4/SESSION_HANDOFF_*.md`
- Static investor dashboards monorepo:
  `~/Projects/Hosting Artifacts/trading_dashboards/`
- Static-dashboard metrics sync workflow:
  `~/Projects/Hosting Artifacts/trading_dashboards/scripts/sync_metrics.py`
  (single source of truth: `data/strategy_metrics.json`)
- Live dashboard repo: this folder, deployed to
  `https://ftmo-v4-dashboard.vercel.app`
- FTMO_V4 engine knowledge graph: `~/Projects/FTMO_V4/CLAUDE.md`
- Backtest infrastructure (referenced by Strategy Generator):
  `~/Projects/FTMO_V4/backtest/`
