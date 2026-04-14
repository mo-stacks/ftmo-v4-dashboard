import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STARTING_BALANCE = 100000;

const VARIANT_META = {
  production: { label: "Production", fullLabel: "ICS V1 (Production)", color: "#4ade80", displayId: "17092574" },
  alpha:      { label: "Alpha",      fullLabel: "Alpha Variant",       color: "#60a5fa", displayId: "5797573" },
  bravo:      { label: "Bravo",      fullLabel: "Bravo Variant",       color: "#c084fc", displayId: "5797576" },
  charlie:    { label: "Charlie",    fullLabel: "Charlie Variant",     color: "#facc15", displayId: "5797577" },
  delta:      { label: "Delta",      fullLabel: "Delta Variant",       color: "#f87171", displayId: "5797579" },
};

const ACCOUNT_KEYS = ["production", "alpha", "bravo", "charlie", "delta"];

export function useSupabaseData() {
  const [accounts, setAccounts] = useState(null);
  const [trades, setTrades] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      // Fetch all 3 tables in parallel
      const [stateRes, tradeRes, snapRes] = await Promise.all([
        supabase.from('account_state').select('*'),
        supabase.from('trade_history').select('*').order('exit_time', { ascending: false }).limit(200),
        supabase.from('balance_snapshots').select('*').order('timestamp', { ascending: true }),
      ]);

      if (stateRes.error) throw stateRes.error;
      if (tradeRes.error) throw tradeRes.error;
      if (snapRes.error) throw snapRes.error;

      // Build ACCOUNTS structure matching the old tradeData.js format
      const accountData = {};
      for (const state of stateRes.data) {
        const key = state.variant;
        const meta = VARIANT_META[key] || { label: key, color: "#888" };

        // Get trades for this variant
        const variantTrades = tradeRes.data
          .filter(t => t.variant === key)
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
            outcome: t.r_multiple > 0 ? "win" : t.r_multiple < 0 ? "loss" : "breakeven",
          }));

        const wins = variantTrades.filter(t => t.outcome === "win").length;
        const losses = variantTrades.length - wins;
        const tradesWithR = variantTrades.filter(t => t.r != null);
        const totalR = tradesWithR.length ? Math.round(tradesWithR.reduce((s, t) => s + t.r, 0) * 100) / 100 : null;

        // Build equity curve from snapshots
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
            eq: Math.round(s.equity * 100) / 100,
            pnl: Math.round((s.balance - STARTING_BALANCE) * 100) / 100,
            dd: Math.round(dd * 100) / 100,
          };
        });

        const currentBalance = state.balance || STARTING_BALANCE;
        const currentEquity = state.equity || currentBalance;
        const realizedPnl = Math.round((currentBalance - STARTING_BALANCE) * 100) / 100;

        accountData[key] = {
          key,
          label: meta.label,
          fullLabel: meta.fullLabel,
          accountId: state.account_id,
          displayId: meta.displayId,
          color: meta.color,
          config: {
            quality_gate: 58,
            slot_mode: state.slot_mode,
            trailing_enabled: state.trailing_enabled,
            recycling_enabled: state.recycling_enabled,
          },
          status: state.engine_status === "active" ? "ACTIVE" : "OFFLINE",
          trades: variantTrades,
          balanceCurve,
          meta: {
            totalTrades: variantTrades.length,
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
          },
          engineState: {
            updated: state.updated_at,
            balance: state.balance,
            equity: state.equity,
            dayStartBalance: state.day_start_balance,
            dailyLoss: state.daily_pnl,
            tradingPaused: false,
            h4Scans: 0,
            m10Scans: 0,
            tradesPlaced: variantTrades.length,
            nextH4Scan: state.next_h4_scan,
            watchlist: (state.watchlist || []).map(e => ({
              symbol: e.symbol,
              direction: e.direction,
              setupType: e.setupType,
              qualityScore: e.qualityScore,
              barsElapsed: e.barsElapsed,
              maxEntryBars: e.maxEntryBars,
            })),
            recentM10Scans: state.scan_activity || [],
          },
          openPositions: (state.positions || []).map(p => ({
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            currentPrice: p.currentPrice,
            unrealizedPnl: p.unrealizedPnl,
          })),
          h4Scans: [],
        };
      }

      setAccounts(accountData);
      setTrades(tradeRes.data);
      setSnapshots(snapRes.data);
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

  return { accounts, trades, snapshots, loading, lastUpdated, error, ACCOUNT_KEYS };
}
