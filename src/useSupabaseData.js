import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

const REFRESH_INTERVAL = 60 * 1000; // 1 minute
const STARTING_BALANCE = 100000;

const VARIANT_META = {
  production: { label: "Production", fullLabel: "FTMO_PROD — half-fib stop, no trail",       color: "#4ade80", displayId: "17102428", accountId: "47151641" },
  alpha:      { label: "Alpha",      fullLabel: "Alpha — classifier stop, no trail (control)", color: "#60a5fa", displayId: "5797573",  accountId: "46915262" },
  bravo:      { label: "Bravo",      fullLabel: "Bravo — classifier stop + trail-C5 (forex)", color: "#c084fc", displayId: "5797576",  accountId: "46915271" },
  charlie:    { label: "Charlie",    fullLabel: "Charlie — classifier stop + trail-C5",       color: "#facc15", displayId: "5797577",  accountId: "46915274" },
  delta:      { label: "Delta",      fullLabel: "Delta — classifier stop + trail-C5 (+crypto)", color: "#f87171", displayId: "5797579",  accountId: "46915276" },
  // 2026-04-30: FTMO 2-Step Challenge added. Same OAuth as Production;
  // bridge auto-routes by accountId (live host for PROD, demo host for Challenge).
  // Same code path: gate=100 (engine-validator), Phase 5 ON, V3 mgmt, V2 half-fib stop.
  challenge:  { label: "Challenge",  fullLabel: "Challenge — half-fib stop, gate=100 (V2 + Plan A/B/C)", color: "#fb923c", displayId: "7545753",  accountId: "47142181" },
};

const ACCOUNT_KEYS = ["production", "alpha", "bravo", "charlie", "delta", "challenge"];

// Per-variant live configuration. This is the AUTHORITATIVE per-variant
// reference the dashboard renders in the "Variant Configuration" table.
// Source of truth: config_*.yaml (in /Users/mmmacbook/Projects/FTMO_V4/)
// + engine/run_live.py hardcoded constants (RISK_PCT, MAX_POSITIONS) +
// CLAUDE.md "BASELINE REFERENCE / LIVE DEPLOYMENT STATE" section
// (Rule-1 ground-truth as of running-engine startup banners).
//
// IMPORTANT: when a Rule-2 deploy lands, edit THIS block to match
// running-engine state. The previous behavior of identical hardcoded
// values masked real per-variant differences (engine-version drift,
// trail mode, partial overrides).
//
// Last refreshed: 2026-04-28 (post-account-transition + telemetry fixes
// + Track 1 seed + Stocks LIMIT + EMERGENCY $90k static floor).
const VARIANT_CONFIG = {
  production: {
    quality_gate:          58,
    entry_delay_bars:      0,
    partial_trigger_r:     0.6,
    partial_pct:           0.20,
    ranking_method:        "quality_score",
    risk_pct:              0.0080,
    stop_mode:             "half-fib of pullback",
    trail:                 "off",
    slot_mode:             "risk_based",
    max_floating_risk_pct: 0.045,
    universe_filter:       "44 syms · no crypto",
    notes:
      "Initial TP: 1.272 Fib extension. " +
      "Move stop to break-even ONLY after MFE crosses +1.0R (decoupled from partial — survives noise wicks). " +
      "Stock entries use LIMIT @ entry-bar open with 600s expiry (caps slippage on RTH tape). " +
      "Hard $90k static max-loss floor (FTMO 2-Step rule — was trailing, switched to static after death-spiral). " +
      "On every engine restart, classifier _sequence is pre-seeded from 1+ year of cTrader bars (avoids cold-start IBO bias).",
  },
  alpha: {
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    ranking_method:    "quality_score",
    risk_pct:          0.0165,
    stop_mode:         "classifier-computed",
    trail:             "off",
    slot_mode:         "risk_based",
    universe_filter:   "36 syms · incl. ETHUSD",
    notes:
      "Initial TP: 1.272 Fib extension. " +
      "Move stop to break-even at +0.5R (coincident with partial). " +
      "No trail — A/B control variant by design (any 'V2-style' behavior here would be coincidence). " +
      "Engine has NOT been restarted since 2026-04-18, so it is running the older classifier-stop code (pre-half-fib-port) and the older 1.65% risk dial — not the 0.80% Phase 1 deploy that landed Apr 24 on Production.",
  },
  bravo: {
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    ranking_method:    "quality_score",
    risk_pct:          0.0165,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "17 forex pairs",
    notes:
      "Initial TP: 1.272 Fib extension. " +
      "Move stop to break-even at +0.5R (coincident with partial). " +
      "Trail-C5: after partial fires, trail activates at 60% of distance to TP, follows price by 10%, capped at 12R. On activation, broker TP is amended FROM 1.272 Fib TO the 12R safety ceiling. " +
      "Forex-only universe (no stocks/indices/metals/commodities). " +
      "Engine has NOT been restarted since 2026-04-18 — running classifier-stop code, not the 0.80% Phase 1 risk dial.",
  },
  charlie: {
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    ranking_method:    "quality_score",
    risk_pct:          0.0165,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "35 syms",
    notes:
      "Initial TP: 1.272 Fib extension. " +
      "Move stop to break-even at +0.5R (coincident with partial). " +
      "Trail-C5: after partial fires, trail activates at 60% of distance to TP, follows price by 10%, capped at 12R. On activation, broker TP is amended FROM 1.272 Fib TO the 12R safety ceiling. " +
      "Full universe (forex + indices + metals + commodities + stocks). " +
      "Engine has NOT been restarted since 2026-04-18 — running classifier-stop code, not the 0.80% Phase 1 risk dial.",
  },
  challenge: {
    quality_gate:           58,
    entry_delay_bars:       0,
    partial_trigger_r:      0.6,
    partial_pct:            0.20,
    be_decouple_r:          1.0,
    ranking_method:         "quality_score",
    risk_pct:               0.0080,
    stop_mode:              "half-fib of pullback",
    trail:                  "off",
    slot_mode:              "risk_based",
    max_floating_risk_pct:  0.045,
    max_positions_hard_cap: 15,
    search_start_gate:      100,    // 2026-04-30 deploy: engine-validator gate (was 5)
    h4_confirmation_bars:   1,      // Phase 5 ON
    universe_filter:        "34 syms · no crypto",
    notes:
      "Paid FTMO 2-Step Challenge ($900 fee, started 2026-04-30). Same OAuth + bridge as Production; cTrader demo env (vs Production's live env). " +
      "Same code path as Production: V2 half-fib stop + Phase 5 ON + V3 mgmt (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + no trail + EMA-as-soft-factor only. " +
      "Engine-wide gate=100 (deployed 2026-04-30): _find_m10_entry waits until 100+ M10 forward bars accumulated past scan_ts (~16.7h) before attempting entry detection. Live-replay 4y backtest: 74.4% WR / +1188R / 0.33% Prague-daily DD / FTMO PASS by huge margin. " +
      "Universe revised 2026-04-30: 17 → 10 exclusions (un-excluded AMZN/GOOG/META/MSTR/XOM/JP225/GER40 — all 73-87% WR / net +R in gate=100 backtest). Still excluded: CAT/DIS/FDX/GS/HD/MA/V/UK100/AUDNZD/GBPCAD (no backtest data, except UK100 = confirmed bad). " +
      "On every restart, classifier _sequence is pre-seeded from 1+ year of cTrader bars (avoids cold-start IBO bias). Watchlist preserved across restarts via load_watchlist_state.",
  },
  delta: {
    quality_gate:      58,
    entry_delay_bars:  0,
    partial_trigger_r: 0.5,
    partial_pct:       0.30,
    ranking_method:    "quality_score",
    risk_pct:          0.0165,
    stop_mode:         "classifier-computed",
    trail:             "C5: act 60% / 10% trail / 12R cap",
    slot_mode:         "risk_based",
    universe_filter:   "36 syms · incl. ETHUSD",
    notes:
      "Initial TP: 1.272 Fib extension. " +
      "Move stop to break-even at +0.5R (coincident with partial). " +
      "Trail-C5: after partial fires, trail activates at 60% of distance to TP, follows price by 10%, capped at 12R. On activation, broker TP is amended FROM 1.272 Fib TO the 12R safety ceiling. " +
      "Full universe + ETHUSD (only variant currently allowed crypto). " +
      "Engine has NOT been restarted since 2026-04-18 — running classifier-stop code, not the 0.80% Phase 1 risk dial.",
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

  const fetchData = useCallback(async () => {
    try {
      // Fetch account state + trades in parallel; balance_snapshots is paginated separately.
      const [stateRes, tradeRes] = await Promise.all([
        supabase.from('account_state').select('*'),
        supabase.from('trade_history').select('*').order('exit_time', { ascending: false }).limit(500),
      ]);

      if (stateRes.error) throw stateRes.error;
      if (tradeRes.error) throw tradeRes.error;

      // balance_snapshots: Supabase REST default caps rows at 1000. Before this
      // fix the fetch was unbounded + ordered ascending, which silently kept the
      // OLDEST 1000 rows globally and cut off the equity curve at ~Apr 13.
      // Fix: 90-day time window + descending-paged .range() loop + client-side
      // reverse so downstream (App.jsx balanceCurve builder at lines 74-87)
      // continues to receive chronologically-ascending rows.
      const PAGE_SIZE = 1000;
      const MAX_ROWS = 50000;
      const cutoffIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const snapsAccum = [];
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
        console.warn(`balance_snapshots: hit MAX_ROWS safety cap (${MAX_ROWS}); oldest rows within the 90-day window may be truncated.`);
      }
      snapsAccum.reverse(); // newest-first → oldest-first (ascending) for charting
      const snapRes = { data: snapsAccum, error: null };

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
        let peak = STARTING_BALANCE;
        let maxDD = 0;
        const balanceCurve = variantSnaps.map((s, i) => {
          if (s.balance > peak) peak = s.balance;
          const dd = peak > 0 ? ((peak - s.balance) / peak) * 100 : 0;
          if (dd > maxDD) maxDD = dd;
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

        // Watchlist
        const watchlist = (state.watchlist || []).map(e => ({
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
        }));

        // Open positions
        const openPositions = (state.positions || []).map(p => ({
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPnl != null ? Math.round(p.unrealizedPnl * 100) / 100 : null,
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
            dailyLoss: state.daily_pnl || 0,
            dailyDdLimit: 5000,
            tradingPaused: false,
            h4Scans: 0,
            m10Scans: 0,
            tradesPlaced: variantTrades.length,
            nextH4Scan: state.next_h4_scan,
            watchlist,
            recentRemovals: [],
            recentM10Scans: (state.scan_activity || []).map(s => ({
              time: s.time,
              symbolsChecked: s.symbols_checked,
              entriesTriggered: s.entries_triggered,
              entrySymbols: s.entry_symbols,
              watchlistStatus: s.watchlist_status,
            })),
          },
          h4Scans: [],
          openPositions,
        };
      }

      setAccounts(accountData);
      setLastUpdated(new Date().toISOString());
      setError(null);
    } catch (err) {
      console.error('Supabase fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, REFRESH_INTERVAL);
    const onFocus = () => fetchData();
    const onVisible = () => { if (!document.hidden) fetchData(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchData]);

  return { accounts, loading, lastUpdated, error, ACCOUNT_KEYS, refetch: fetchData };
}
