import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STARTING_BALANCE = 100000;

const VARIANT_META = {
  production: { label: "Production", fullLabel: "ICS V1 (Production)", color: "#4ade80", displayId: "17092574", accountId: "46992359" },
  alpha:      { label: "Alpha",      fullLabel: "Alpha Variant",       color: "#60a5fa", displayId: "5797573",  accountId: "46915262" },
  bravo:      { label: "Bravo",      fullLabel: "Bravo Variant",       color: "#c084fc", displayId: "5797576",  accountId: "46915271" },
  charlie:    { label: "Charlie",    fullLabel: "Charlie Variant",     color: "#facc15", displayId: "5797577",  accountId: "46915274" },
  delta:      { label: "Delta",      fullLabel: "Delta Variant",       color: "#f87171", displayId: "5797579",  accountId: "46915276" },
};

const ACCOUNT_KEYS = ["production", "alpha", "bravo", "charlie", "delta"];

export function useSupabaseData() {
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [stateRes, tradeRes, snapRes] = await Promise.all([
        supabase.from('account_state').select('*'),
        supabase.from('trade_history').select('*').order('exit_time', { ascending: false }).limit(500),
        supabase.from('balance_snapshots').select('*').order('timestamp', { ascending: true }),
      ]);

      if (stateRes.error) throw stateRes.error;
      if (tradeRes.error) throw tradeRes.error;
      if (snapRes.error) throw snapRes.error;

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
            outcome: t.r_multiple > 0 ? "win" : t.r_multiple < 0 ? "loss" : "breakeven",
          }));

        const wins = variantTrades.filter(t => t.outcome === "win").length;
        const losses = variantTrades.length - wins;
        const tradesWithR = variantTrades.filter(t => t.r != null);
        const totalR = tradesWithR.length ? Math.round(tradesWithR.reduce((s, t) => s + t.r, 0) * 100) / 100 : null;

        // Equity curve from snapshots
        const variantSnaps = snapRes.data.filter(s => s.variant === key);
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
          config: {
            quality_gate: 58,
            entry_delay_bars: 0,
            partial_trigger_r: 0.5,
            partial_pct: 0.3,
            ranking_method: "quality_score",
            slot_mode: state.slot_mode || "risk_based",
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
    return () => clearInterval(id);
  }, [fetchData]);

  return { accounts, loading, lastUpdated, error, ACCOUNT_KEYS, refetch: fetchData };
}
