import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';

// 2026-05-02: raised 60s → 120s as part of the egress reduction pass.
// The engine's downstream cadence (M10 scans, FTMO daily DD reset, etc.)
// is well-aligned with 2-minute polls; users won't notice the slower
// refresh and we cut Supabase egress in half.
const REFRESH_INTERVAL = 120 * 1000;

// Balance-snapshot lookback. Was 90 days, dropped to 30 days to shrink
// the first-load payload (most recent activity is what users care about;
// 30 days still covers the rolling-month performance views).
const SNAPSHOT_WINDOW_DAYS = 30;

const STARTING_BALANCE = 100000;

// Explicit column list for trade_history fetches. Excludes the `candles`
// JSONB so the bulk fetch doesn't pull ~30 KB of OHLC per row × 500 rows
// every refresh. Candles are fetched on-demand by TradeDetailPanel when
// a row is expanded.
const TRADE_HISTORY_COLS = [
  // Identity
  "id", "variant", "position_id", "symbol", "direction", "setup_type",
  // Prices
  "entry_price", "exit_price", "stop_price", "target_price",
  // Times
  "entry_time", "exit_time", "scan_time",
  // Result
  "exit_reason", "volume_lots", "risk_usd", "realized_pnl", "r_multiple",
  "quality_score", "hold_time_hours",
  "trailing_was_active", "partial_hit", "source", "created_at",
  // Extended setup-detail (added 2026-05-02 migration)
  "bars_held", "mfe_r", "mae_r",
  "impulse_start_price", "impulse_end_price", "impulse_leg",
  "atr_multiple", "consistency", "pullback_depth", "fib_786",
  "partial_price", "partial_pct", "partial_r",
  // NOTE: `candles` deliberately omitted — fetched on-demand
].join(",");

const VARIANT_META = {
  production: { label: "Production", fullLabel: "FTMO_PROD — half-fib stop, no trail",       color: "#22b89a", displayId: "17102428", accountId: "47151641" },
  alpha:      { label: "Alpha",      fullLabel: "Alpha — classifier stop, no trail (control)", color: "#7eb4fa", displayId: "5797573",  accountId: "46915262" },
  bravo:      { label: "Bravo",      fullLabel: "Bravo — classifier stop + trail-C5 (forex)", color: "#a78bfa", displayId: "5797576",  accountId: "46915271" },
  charlie:    { label: "Charlie",    fullLabel: "Charlie — classifier stop + trail-C5",       color: "#cfb95b", displayId: "5797577",  accountId: "46915274" },
  delta:      { label: "Delta",      fullLabel: "Delta — classifier stop + trail-C5 (+crypto)", color: "#cf5b5b", displayId: "5797579",  accountId: "46915276" },
  // 2026-04-30: FTMO 2-Step Challenge added. Same OAuth as Production;
  // bridge auto-routes by accountId (live host for PROD, demo host for Challenge).
  // Same code path: gate=100 (engine-validator), Phase 5 ON, V3 mgmt, V2 half-fib stop.
  challenge:  { label: "Challenge",  fullLabel: "Challenge — half-fib stop, gate=100 (V2 + Plan A/B/C)", color: "#cf8f5b", displayId: "7545753",  accountId: "47142181" },
};

// Challenge first — primary funded-pathway account; Production (FTMO Free
// demo) follows as the V2/Plan-A/B/C reference; demos last.
const ACCOUNT_KEYS = ["challenge", "production", "alpha", "bravo", "charlie", "delta"];

// Per-variant live configuration. STRUCTURED FIELDS ONLY — full prose
// notes (TP method, BE decouple/coincident, code-path lineage, deploy
// rationale, etc.) live in the offline doc:
//   docs/variant_state.md   ← refresh on every Rule-2 deploy
// Dashboard surfaces only the at-a-glance fields below. account_type +
// target_pct identify whether a row is Challenge/Demo and what the
// pass criteria are. be_move encodes the BE rule because that's a real
// per-variant differentiator (V3 mgmt's D2 BE-decouple @1.0R only fires
// on production/challenge today).
//
// Source of truth (in priority order):
//   1. Running engine startup banner (Rule-1 ground truth)
//   2. config_*.yaml (in /Users/mmmacbook/Projects/FTMO_V4/)
//   3. engine/run_live.py hardcoded constants (RISK_PCT, MAX_POSITIONS)
//   4. tools/system_health_state.yaml (cross-tool canonical mirror)
//
// Last refreshed: 2026-04-30 (notes field removed; structured fields
// added; offline doc created at docs/variant_state.md).
const VARIANT_CONFIG = {
  production: {
    account_type:          "FTMO Free Demo",
    target_pct:            null,           // demo — no profit target
    quality_gate:          58,
    entry_delay_bars:      0,
    partial_trigger_r:     0.6,
    partial_pct:           0.20,
    be_move:               "+1.0R decoupled",   // D2 — BE moves only after MFE crosses 1.0R
    ranking_method:        "quality_score",
    risk_pct:              0.0080,
    stop_mode:             "half-fib of pullback",
    trail:                 "off",
    slot_mode:             "risk_based",
    max_floating_risk_pct: 0.045,
    universe_filter:       "44 syms · no crypto",
  },
  challenge: {
    account_type:           "FTMO 2-Step Challenge",
    target_pct:             10,             // Step-1 profit target = 10%
    quality_gate:           58,
    entry_delay_bars:       0,
    partial_trigger_r:      0.6,
    partial_pct:            0.20,
    be_move:                "+1.0R decoupled",
    ranking_method:         "quality_score",
    risk_pct:               0.0080,
    stop_mode:              "half-fib of pullback",
    trail:                  "off",
    slot_mode:              "risk_based",
    max_floating_risk_pct:  0.045,
    max_positions_hard_cap: 15,
    search_start_gate:      100,            // 2026-04-30: engine-validator gate (was 5)
    h4_confirmation_bars:   1,              // Phase 5 ON
    universe_filter:        "34 syms · no crypto",
  },
  alpha: {
    account_type:      "Spotware Demo",
    target_pct:        null,
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    be_move:           "+0.5R coincident",   // BE moves with partial fire
    ranking_method:    "quality_score",
    risk_pct:          0.0080,
    stop_mode:         "classifier-computed",
    trail:             "off",                // CONTROL — no trail
    slot_mode:         "risk_based",
    universe_filter:   "36 syms · incl. ETHUSD",
  },
  bravo: {
    account_type:      "Spotware Demo",
    target_pct:        null,
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    be_move:           "+0.5R coincident",
    ranking_method:    "quality_score",
    risk_pct:          0.0080,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "17 forex pairs",
  },
  charlie: {
    account_type:      "Spotware Demo",
    target_pct:        null,
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    be_move:           "+0.5R coincident",
    ranking_method:    "quality_score",
    risk_pct:          0.0080,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "35 syms",
  },
  delta: {
    account_type:      "Spotware Demo",
    target_pct:        null,
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    be_move:           "+0.5R coincident",
    ranking_method:    "quality_score",
    risk_pct:          0.0080,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "36 syms · incl. ETHUSD",
  },
};

// Known-incident carve-outs. Remove entries once root cause is fixed
// upstream and you want to re-verify the dashboard against raw data.
const EXCLUDED_INCIDENTS = [
  {
    variant: "production",
    start:   "2026-04-16T00:00:00Z",
    end:     "2026-04-16T02:00:00Z",
    reason:  "Bridge dual-subscription to decommissioned FTMO account " +
             "17083057 inflated equity via phantom floating_pnl. " +
             "Balance unaffected. Upstream fix: clean bridge " +
             "disconnect protocol on account swap.",
  },
];

/**
 * Classify a trade_history row into an outcome bucket.
 *
 * Precedence (stop at first match):
 *   1. phantom      — entry == exit AND not a partial close (reconcile-race artifact)
 *   2. timeout      — exit_reason === "TIMEOUT"
 *   3. r_multiple   — win / loss / breakeven driven by r sign
 *   4. realized_pnl — fallback when r_multiple is NULL (broker_reconstructed rows)
 *   5. unknown      — no signal available
 *
 * Win/loss definition matches backtest parity at
 * backtest/run_validation_suite.py:310 where
 *   wr = wins / (wins + losses) * 100
 * and pos.trade.outcome ∈ {"win", "loss"} with the else branch carried
 * as timeouts. This function expands the exclusion set to also cover
 * phantom closes (D-017 reconcile-race signature) and unknown/breakeven
 * rows — all EXCLUDED from WR denominator, never counted as losses.
 */
function classifyOutcome(t) {
  if (
    t.entry_price != null &&
    t.exit_price != null &&
    t.entry_price === t.exit_price &&
    t.partial_hit !== true
  ) {
    return "phantom";
  }
  if (t.exit_reason === "TIMEOUT") {
    return "timeout";
  }
  if (t.r_multiple != null) {
    if (t.r_multiple > 0) return "win";
    if (t.r_multiple < 0) return "loss";
    return "breakeven";
  }
  if (t.realized_pnl != null) {
    if (t.realized_pnl > 0) return "win";
    if (t.realized_pnl < 0) return "loss";
    return "breakeven";
  }
  return "unknown";
}

export function useSupabaseData() {
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);

  // ─── Delta-refresh caches (2026-05-02 egress reduction) ────────────
  // After the first full fetch we keep snapshots and trades in refs and
  // only ask Supabase for rows newer than the last seen `timestamp` /
  // `created_at`. This drops per-refresh egress by ~95% (a typical
  // 60-second tick now ships ~10 new snapshot rows × 6 variants instead
  // of refetching the full ~60k-row 90-day window).
  //
  // The caches survive component re-renders but reset on full page
  // reload — that's intentional, the first fetch then re-establishes
  // the baseline.
  const snapshotsCacheRef = useRef([]);
  const lastSnapshotTsRef = useRef(null);
  const tradesCacheRef = useRef([]);
  const lastTradeCreatedRef = useRef(null);

  // 2026-05-04 iOS-PWA staleness fix:
  // - In-flight guard so a fetch that got suspended mid-flight by iOS
  //   process freeze doesn't block subsequent invocations forever
  // - Last-fetch wall-clock time so we can detect "interval is dead but
  //   page is alive" and force a refresh on the next visibility/focus
  //   event regardless of whether visibilitychange fires reliably
  const inFlightRef = useRef(false);
  const lastFetchAtRef = useRef(0);

  const fetchData = useCallback(async () => {
    // Drop the call if a previous one is still pending. iOS can freeze
    // a fetch mid-flight without ever resolving its promise; without
    // this guard, every visibility/focus event would queue another
    // fetch behind the dead one. The fetch we drop here is replaced by
    // the next interval tick.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      // Account state is small (6 rows) and changes constantly, so
      // refetch it in full each tick. Trade and snapshot fetches are
      // delta-aware below.
      const isFirstLoad = lastSnapshotTsRef.current === null;
      const tradesQuery = isFirstLoad
        ? supabase
            .from('trade_history')
            .select(TRADE_HISTORY_COLS)
            .order('exit_time', { ascending: false })
            .limit(500)
        : supabase
            .from('trade_history')
            .select(TRADE_HISTORY_COLS)
            .gt('created_at', lastTradeCreatedRef.current)
            .order('exit_time', { ascending: false });

      const [stateRes, tradeRes] = await Promise.all([
        supabase.from('account_state').select('*'),
        tradesQuery,
      ]);

      if (stateRes.error) throw stateRes.error;
      if (tradeRes.error) throw tradeRes.error;

      // Merge delta trades into the cache (newest first across the union).
      // Dedupe by id in case a row is updated and re-emitted by the
      // publisher within a single tick.
      if (isFirstLoad) {
        tradesCacheRef.current = tradeRes.data || [];
      } else if ((tradeRes.data || []).length > 0) {
        const seen = new Set(tradeRes.data.map(t => t.id));
        tradesCacheRef.current = [
          ...tradeRes.data,
          ...tradesCacheRef.current.filter(t => !seen.has(t.id)),
        ].slice(0, 500); // keep the working set bounded
      }
      // Track the freshest created_at we've persisted
      if (tradesCacheRef.current.length > 0) {
        const newest = tradesCacheRef.current.reduce((a, b) =>
          (a.created_at || "") > (b.created_at || "") ? a : b
        );
        lastTradeCreatedRef.current = newest.created_at;
      }
      const tradeData = tradesCacheRef.current;

      // ─── balance_snapshots ────────────────────────────────────────
      // First load: paginated descending-by-timestamp pull of the
      // 30-day window (was 90; trimmed to halve the first-load payload).
      // Subsequent ticks: only rows with `timestamp > lastSnapshotTs`,
      // appended to the cache. As time passes, prune rows that fall
      // outside the rolling 30-day window so memory stays bounded.
      const PAGE_SIZE = 1000;
      const cutoffIso = new Date(Date.now() - SNAPSHOT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

      if (isFirstLoad) {
        const snapsAccum = [];
        // Cap first-load pull at 30 days × 6 variants × 2-min cadence
        // ≈ 130k rows. We're nowhere near this in practice (~20k for
        // 30 days observed) but the cap keeps a future cadence change
        // from blowing up the browser.
        const MAX_ROWS = 50000;
        for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
          const end = Math.min(offset + PAGE_SIZE - 1, MAX_ROWS - 1);
          const pageRes = await supabase
            .from('balance_snapshots')
            .select('*')
            .gte('timestamp', cutoffIso)
            .order('timestamp', { ascending: false })
            .range(offset, end);
          if (pageRes.error) throw pageRes.error;
          const page = pageRes.data || [];
          snapsAccum.push(...page);
          if (page.length < PAGE_SIZE) break;
        }
        if (snapsAccum.length >= MAX_ROWS) {
          console.warn(`balance_snapshots: hit MAX_ROWS first-load cap (${MAX_ROWS}).`);
        }
        snapsAccum.reverse(); // newest-first → oldest-first
        snapshotsCacheRef.current = snapsAccum;
      } else {
        const deltaRes = await supabase
          .from('balance_snapshots')
          .select('*')
          .gt('timestamp', lastSnapshotTsRef.current)
          .order('timestamp', { ascending: true });
        if (deltaRes.error) throw deltaRes.error;
        const newRows = deltaRes.data || [];
        if (newRows.length > 0) {
          snapshotsCacheRef.current = [...snapshotsCacheRef.current, ...newRows];
        }
        // Prune the window — drop snapshots that have aged out
        snapshotsCacheRef.current = snapshotsCacheRef.current.filter(
          s => (s.timestamp || "") >= cutoffIso
        );
      }
      if (snapshotsCacheRef.current.length > 0) {
        lastSnapshotTsRef.current = snapshotsCacheRef.current[snapshotsCacheRef.current.length - 1].timestamp;
      }
      const snapRes = { data: snapshotsCacheRef.current, error: null };

      // Use the merged trade cache below (originally `tradeRes.data`)
      tradeRes.data = tradeData;

      const accountData = {};
      for (const key of ACCOUNT_KEYS) {
        const state = stateRes.data.find(s => s.variant === key) || {};
        const meta = VARIANT_META[key] || { label: key, color: "#888" };

        // Trades
        const variantTrades = tradeRes.data
          .filter(t => t.variant === key)
          .sort((a, b) => (a.exit_time || "").localeCompare(b.exit_time || ""))
          .map((t, i) => ({
            tn: i + 1,
            id: t.id,                 // PK — used by TradeDetailPanel for lazy candle fetch
            ts: t.exit_time,
            d: t.exit_time ? t.exit_time.substring(0, 10) : "",
            sym: t.symbol,
            dir: t.direction,
            mode: t.setup_type || "",
            entry: t.entry_price,
            exit: t.exit_price,
            sl: t.stop_price,
            tp: t.target_price,
            r: t.r_multiple,
            riskUsd: t.risk_usd || 0,
            enginePnl: t.realized_pnl || 0,
            brokerPnl: t.realized_pnl,
            reason: t.exit_reason,
            score: t.quality_score,
            posId: t.position_id || "",
            outcome: classifyOutcome(t),
            // Extended setup-detail fields surfaced in the TradeHistory
            // expandable detail panel. All `?? null` for graceful
            // degradation — the engine writes these to JSONL but the
            // supabase trade_history columns may not be populated yet.
            // See SESSION_HANDOFF_trade_history.md.
            entryTime:    t.entry_time     ?? null,
            scanTime:     t.scan_time      ?? null,
            barsHeld:     t.bars_held      ?? null,
            mfeR:         t.mfe_r          ?? null,
            maeR:         t.mae_r          ?? null,
            // Setup characteristics (the same fields the watchlist uses)
            impulseStartPrice: t.impulse_start_price ?? null,
            impulseEndPrice:   t.impulse_end_price   ?? null,
            impulseLeg:        t.impulse_leg         ?? null,
            atrMultiple:       t.atr_multiple        ?? null,
            consistency:       t.consistency         ?? null,
            pullbackDepth:     t.pullback_depth      ?? null,
            fib786:            t.fib_786             ?? null,
            // Per-trade candles intentionally NOT included in the bulk
            // fetch — they are 30+ KB JSONB per row and would balloon
            // the trade_history list payload to ~15 MB. TradeDetailPanel
            // fetches candles on-demand for the single expanded row via
            // a separate `select('candles').eq('id', X)` call.
            candles:           null,
            // Partial-exit info (engine logs partial fills as separate
            // events; field is null when the trade had no partial)
            partialPrice:      t.partial_price       ?? null,
            partialPct:        t.partial_pct         ?? null,
            partialR:          t.partial_r           ?? null,
          }));

        const wins = variantTrades.filter(t => t.outcome === "win").length;
        const losses = variantTrades.filter(t => t.outcome === "loss").length;
        const tradesWithR = variantTrades.filter(t => t.r != null);
        const totalR = tradesWithR.length ? Math.round(tradesWithR.reduce((s, t) => s + t.r, 0) * 100) / 100 : null;

        // Equity curve from snapshots.
        // After the 90-day pagination fix (commit 34258cf) exposed the full
        // retained snapshot history, we observed pre-existing malformed rows
        // where balance is 0 or NULL. These rendered as vertical spikes to $0
        // and caused Max Drawdown to compute as 100% on every variant.
        // Defensive filter: drop rows with balance OR equity <= 0 / null so
        // both chart modes (Balance and Equity) render cleanly. Preflight
        // against live Supabase confirmed equity<=0 rows exist and share
        // the same full-zero signature as balance<=0 rows (117 total).
        // droppedSnapshots is the combined count for display.
        // Upstream root cause (why these rows exist at all) is out of scope
        // here — goes to the publisher/engine data-quality worklist.
        const rawVariantSnaps = snapRes.data.filter(s => s.variant === key);

        // Stage 1: drop null/zero-value rows (publisher bridge-down fallback).
        const validSnaps = rawVariantSnaps.filter(s =>
          s.balance != null && s.balance > 0 &&
          s.equity  != null && s.equity  > 0
        );
        const droppedSnapshots = rawVariantSnaps.length - validSnaps.length;

        // Stage 2: drop rows inside known-incident windows (see
        // EXCLUDED_INCIDENTS at module top for the rationale per window).
        const variantSnaps = validSnaps.filter(s =>
          !EXCLUDED_INCIDENTS.some(e =>
            e.variant === key &&
            s.timestamp >= e.start &&
            s.timestamp <= e.end
          )
        );
        const excludedIncidents = validSnaps.length - variantSnaps.length;

        // Compute peak/maxDD over ALL snapshots (don't lose precision on DD)
        let peak = STARTING_BALANCE;
        let maxDD = 0;
        for (const s of variantSnaps) {
          if (s.balance > peak) peak = s.balance;
          const dd = peak > 0 ? ((peak - s.balance) / peak) * 100 : 0;
          if (dd > maxDD) maxDD = dd;
        }

        // ── Decimate balanceCurve to ≤TARGET points for chart rendering ──
        // Supabase publisher writes a snapshot every ~2 min; over 90 days that's
        // ~65k rows per variant × 6 variants = 390k+ unique timestamps. Recharts
        // renders these as SVG circles + path nodes — at scale, the browser tab
        // ran out of memory, force-reloaded, and looked like "crashing every few
        // seconds" to the user. Cap at 500 points per variant; bucket by even
        // index so we keep first + last + a representative sample in between.
        // Peak/maxDD computed above on FULL data so DD is precise even though
        // the rendered curve is downsampled.
        const TARGET_POINTS = 500;
        const stride = Math.max(1, Math.ceil(variantSnaps.length / TARGET_POINTS));
        const decimated = [];
        for (let i = 0; i < variantSnaps.length; i += stride) decimated.push(variantSnaps[i]);
        // Always include the last snapshot (current state)
        if (variantSnaps.length > 0 &&
            decimated[decimated.length - 1] !== variantSnaps[variantSnaps.length - 1]) {
          decimated.push(variantSnaps[variantSnaps.length - 1]);
        }
        // Recompute running peak only over decimated points (for per-row dd field)
        let runningPeak = STARTING_BALANCE;
        const balanceCurve = decimated.map((s, i) => {
          if (s.balance > runningPeak) runningPeak = s.balance;
          const dd = runningPeak > 0 ? ((runningPeak - s.balance) / runningPeak) * 100 : 0;
          return {
            idx: i,
            ts: s.timestamp,
            d: s.timestamp ? s.timestamp.substring(0, 10) : "",
            bal: Math.round(s.balance * 100) / 100,
            eq: Math.round((s.equity || s.balance) * 100) / 100,
            pnl: Math.round((s.balance - STARTING_BALANCE) * 100) / 100,
            dd: Math.round(dd * 100) / 100,
          };
        });

        const currentBalance = state.balance || STARTING_BALANCE;
        const currentEquity = state.equity || currentBalance;
        if (currentBalance > peak) peak = currentBalance;
        const realizedPnl = Math.round((currentBalance - STARTING_BALANCE) * 100) / 100;

        // Watchlist — pass through extended setup-detail fields with graceful
        // degradation. Fields marked with `?? null` are populated only after
        // the engine + publish_to_supabase.py round-trip carries them. UI
        // shows "—" when null.
        const watchlist = (state.watchlist || []).map(e => ({
          // Core (already in publish_to_supabase wl_json)
          symbol: e.symbol,
          direction: e.direction,
          setupType: e.setupType,
          qualityScore: e.qualityScore,
          barsElapsed: e.barsElapsed,
          maxEntryBars: e.maxEntryBars,
          stopPrice: e.stopPrice,
          targetPrice: e.targetPrice,
          ageMinutes: e.ageMinutes,
          pullbackDepth: e.pullbackDepth,
          status: e.status,
          barsRemaining: e.barsRemaining,
          // Extended setup-detail fields (added 2026-05-01).
          // Engine flush of these into wl_json may lag the dashboard work.
          stopDistance: e.stopDistance ?? null,
          impulseStartPrice: e.impulseStartPrice ?? e.impulse_start_price ?? null,
          impulseEndPrice: e.impulseEndPrice ?? e.impulse_end_price ?? null,
          impulseLeg: e.impulseLeg ?? e.impulse_leg ?? null,
          atrMultiple: e.atrMultiple ?? e.atr_multiple ?? null,
          consistency: e.consistency ?? null,
          fib786: e.fib786 ?? e.fib_786 ?? null,
          scanTime: e.scanTime ?? e.scan_time ?? null,
          subScores: e.subScores ?? e.sub_scores ?? null,
          instType: e.instType ?? e.inst_type ?? null,
          // Engine work pending — see SESSION_HANDOFF Watchlist Setup-Detail UI
          candidateBreakLevel: e.candidateBreakLevel ?? e.candidate_break_level ?? null,
          candidatePivotPrice: e.candidatePivotPrice ?? e.candidate_pivot_price ?? null,
          candidateStopPrice: e.candidateStopPriceFib ?? e.candidate_stop_price_pivot_half_fib ?? null,
          // Candlestick data for the SetupChart in the detail panel.
          // Engine pushes this via publish_to_supabase.py — shape:
          //   { h4: [{t, o, h, l, c}, ...], m10: [{t, o, h, l, c}, ...] }
          // `t` is unix-seconds (UTC). Empty/missing → chart shows
          // "no candle data yet" empty state.
          // See SESSION_HANDOFF Watchlist Setup-Chart for engine work.
          candles: e.candles ?? null,
        }));

        // Open positions — pass through stop/target plus the original
        // values (set at order placement and never modified by trailing).
        // Original* fields are graceful-degradation `?? null` until the
        // engine pipeline starts persisting them; until then the dashboard
        // treats them as "same as live" and notes that trail-status detection
        // is pending.
        const openPositions = (state.positions || []).map(p => ({
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPnl != null ? Math.round(p.unrealizedPnl * 100) / 100 : null,
          // Live (current) stop and target — updated by trailing
          stopLoss: p.stopLoss ?? null,
          takeProfit: p.takeProfit ?? null,
          // Original (entry-time) stop and target — never modified
          originalStopLoss: p.originalStopLoss ?? null,
          originalTakeProfit: p.originalTakeProfit ?? null,
          // Engine-side amend flags — TRUE only when the engine has
          // emitted a MGMT_STATE_TRANSITION (BE_MOVE / TRAIL_*) for
          // this position. The TRAIL ENGAGED / MOVED badges in
          // App.jsx gate on these. Numeric comparison of original-
          // vs-live SL/TP produces false positives because cTrader
          // adjusts SL/TP at order placement (~1-2 pips) even when
          // the engine never amended. `?? null` for graceful fallback
          // on rows from publishers that pre-date 2026-05-02.
          stopAmendedAfterOpen: p.stopAmendedAfterOpen ?? null,
          targetAmendedAfterOpen: p.targetAmendedAfterOpen ?? null,
          // Position metadata
          openTime: p.openTime ?? p.open_time ?? null,
          volume: p.volume ?? null,
          positionId: p.positionId ?? p.position_id ?? null,
          // Per-position candles for the chart. Shape mirrors
          // watchlist: { h4: [...], m10: [...] } with unix-seconds
          // t and o/h/l/c.
          candles: p.candles ?? null,
        }));

        accountData[key] = {
          key,
          label: meta.label,
          fullLabel: meta.fullLabel,
          accountId: meta.accountId,
          displayId: meta.displayId,
          color: meta.color,
          // Per-variant live config (see VARIANT_CONFIG at module top).
          // Each variant has DIFFERENT values reflecting actual running-engine
          // state — DO NOT collapse back to a single shared object. Engine-state
          // override (slot_mode) wins over the static config block when present.
          config: {
            ...(VARIANT_CONFIG[key] || {}),
            slot_mode: state.slot_mode || (VARIANT_CONFIG[key]?.slot_mode) || "risk_based",
          },
          status: state.engine_status === "active" ? "ACTIVE" : "OFFLINE",
          trades: variantTrades,
          balanceCurve,
          engineEventCurve: [],
          meta: {
            totalTrades: variantTrades.length,
            engineEventCount: variantTrades.length,
            partialCount: 0,
            wins,
            losses,
            totalR,
            avgR: tradesWithR.length ? Math.round((totalR / tradesWithR.length) * 100) / 100 : null,
            realizedPnl,
            startBalance: STARTING_BALANCE,
            currentBalance: Math.round(currentBalance * 100) / 100,
            currentEquity: Math.round(currentEquity * 100) / 100,
            finalBalance: Math.round(currentBalance * 100) / 100,
            openPnl: Math.round((currentEquity - currentBalance) * 100) / 100,
            maxDD: Math.round(maxDD * 100) / 100,
            maxDailyDD: 0,
            historyPoints: balanceCurve.length,
            droppedSnapshots,
            excludedIncidents,
          },
          engineState: {
            updated: state.updated_at,
            balance: currentBalance,
            equity: currentEquity,
            dayStartBalance: state.day_start_balance || currentBalance,
            highestEodBalance: peak,
            trailingDdFloor: state.trailing_dd || (STARTING_BALANCE * 0.9),
            // daily_pnl from supabase is signed (positive = profit, negative = loss).
            // The dashboard's "Daily Loss" indicator only counts losses against
            // the FTMO daily DD limit — profits don't consume the limit. So:
            //   dailyPnl: raw signed P&L (for informational display)
            //   dailyLoss: only the loss component (0 when profitable)
            dailyPnl: state.daily_pnl || 0,
            dailyLoss: Math.max(0, -(state.daily_pnl || 0)),
            dailyDdLimit: 5000,
            tradingPaused: false,
            h4Scans: 0,
            m10Scans: 0,
            tradesPlaced: variantTrades.length,
            nextH4Scan: state.next_h4_scan,
            watchlist,
            recentRemovals: [],
            recentM10Scans: (() => {
              // scan_activity shape evolved 2026-04-30:
              //   - Old: [m10_scan, ...]                 (bare array)
              //   - New: {"m10": [...], "h4": [...]}     (dict)
              // Pick the M10 list from whichever shape is present.
              const sa = state.scan_activity;
              const m10 = Array.isArray(sa)
                ? sa
                : (sa && Array.isArray(sa.m10) ? sa.m10 : []);
              return m10.map(s => ({
                time: s.time,
                symbolsChecked: s.symbols_checked,
                entriesTriggered: s.entries_triggered,
                entrySymbols: s.entry_symbols,
                watchlistStatus: s.watchlist_status,
              }));
            })(),
          },
          h4Scans: (() => {
            // 2026-04-30: publisher now embeds H4 scan history in
            // state.scan_activity using dict shape `{m10: [...], h4: [...]}`.
            // Old shape is a bare array (M10 only). Read defensively so
            // a publisher rollback or stale row still renders cleanly.
            const sa = state.scan_activity;
            if (sa && !Array.isArray(sa) && Array.isArray(sa.h4)) {
              return sa.h4;
            }
            return [];
          })(),
          openPositions,
        };
      }

      setAccounts(accountData);
      setLastUpdated(new Date().toISOString());
      lastFetchAtRef.current = Date.now();
      setError(null);
    } catch (err) {
      console.error('Supabase fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, REFRESH_INTERVAL);

    // Foreground / visibility handlers — fire fetchData when the user
    // brings the dashboard back to the front. Multiple events because
    // browsers (especially iOS Safari + installed PWAs) are inconsistent
    // about which fires when:
    //   - focus      — desktop, when the window regains focus
    //   - visibilitychange — most browsers when tab becomes visible
    //   - pageshow   — fires on bfcache restore (iOS uses bfcache aggressively
    //     for installed PWAs; visibilitychange isn't always fired in this case)
    //   - online     — when network reconnects after being offline
    // All gated on lastFetchAt so we don't hammer Supabase with rapid-fire
    // re-fetches if multiple events fire close together.
    const FORCE_REFRESH_THRESHOLD_MS = 30 * 1000; // 30s — if a fetch ran
                                                  // within the last 30s,
                                                  // skip the redundant one
    const maybeRefetch = (reason) => {
      const sinceLast = Date.now() - lastFetchAtRef.current;
      if (sinceLast < FORCE_REFRESH_THRESHOLD_MS) return;
      // Optional: console.debug for diagnosing on-device staleness
      // console.debug(`[ftmo-v4] refetch trigger=${reason} sinceLast=${sinceLast}ms`);
      fetchData();
    };
    const onFocus = () => maybeRefetch('focus');
    const onVisible = () => { if (!document.hidden) maybeRefetch('visibilitychange'); };
    const onPageShow = (e) => { if (e.persisted) fetchData(); }; // bfcache restore — always force
    const onOnline = () => maybeRefetch('online');

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);

    // Watchdog — every 30s while the page is visible, check whether
    // the main interval has actually been firing. iOS Safari throttles
    // background timers and can leave the interval in a broken state
    // after resume. If lastFetchAt is older than 1.5× our normal cadence
    // AND the page is visible, force a refresh.
    const STALENESS_CHECK_MS = 30 * 1000;
    const watchdog = setInterval(() => {
      if (document.hidden) return;
      const sinceLast = Date.now() - lastFetchAtRef.current;
      if (sinceLast > REFRESH_INTERVAL * 1.5) {
        fetchData();
      }
    }, STALENESS_CHECK_MS);

    return () => {
      clearInterval(id);
      clearInterval(watchdog);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, [fetchData]);

  return { accounts, loading, lastUpdated, error, ACCOUNT_KEYS, refetch: fetchData };
}
