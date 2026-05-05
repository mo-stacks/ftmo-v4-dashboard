import { useState, useMemo, useEffect, Fragment, Component, Suspense, lazy } from "react";

// Lazy-load the candlestick chart (~150KB lightweight-charts) so the
// initial dashboard bundle stays small. The chart only mounts when a
// user expands a watchlist row.
const SetupChart = lazy(() => import("./SetupChart.jsx"));
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, BarChart, Bar, Cell, ReferenceLine, ComposedChart, Line, LineChart, Legend,
} from "recharts";
import { useSupabaseData } from "./useSupabaseData.js";
import { supabase } from "./supabaseClient.js";
import { useTradeAlerts } from "./useTradeAlerts.js";
import AlertCenter from "./AlertCenter.jsx";
import { VARIANT_CHANGE_EVENTS, attachChangeEvents } from "./changeEvents.js";

/* ── error boundary ──────────────────────────────────────────────
   Wraps a major section so a render error in one panel doesn't
   unmount the whole tree (which previously dropped the user back
   to the loading screen). Each boundary shows a contained error
   panel; the rest of the dashboard keeps working. Logs to console
   for debugging. */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label || "section"}]`, error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          background: "#2a1a1a",
          border: "1px solid #cf5b5b",
          borderRadius: 10,
          padding: 16,
          margin: "12px 0",
          color: "#fca5a5",
          fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "#cf5b5b" }}>
            ⚠ {this.props.label || "Section"} failed to render
          </div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
            Other panels are unaffected. Reload to retry, or check the browser console for details.
          </div>
          <pre style={{ fontSize: 11, color: "#ef4444", margin: 0, overflow: "auto", maxHeight: 120 }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── helpers ─────────────────────────────────────────────────── */

const useIsMobile = () => {
  const [m, setM] = useState(window.innerWidth < 640);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
};

// Profit factor — outcome-driven per backtest parity
// (run_validation_suite.py:310). Only t.outcome === "win" contributes to
// grossWin; only t.outcome === "loss" contributes to grossLoss. Phantom,
// timeout, breakeven, and unknown outcomes are excluded from BOTH sides,
// so they do not distort the ratio.
const pf = (trades) => {
  const grossWin = trades
    .filter(t => t.outcome === "win" && t.r != null)
    .reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(trades
    .filter(t => t.outcome === "loss" && t.r != null)
    .reduce((s, t) => s + t.r, 0));
  return grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? Infinity : 0;
};

const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

const fmtAge = (minutes) => {
  if (!minutes && minutes !== 0) return "—";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

const getNextH4Scan = (stateNextH4) => {
  if (stateNextH4) {
    return new Date(stateNextH4);
  }
  // Fallback: compute from cTrader H4 grid {01,05,09,13,17,21} UTC
  const now = new Date();
  const utcH = now.getUTCHours();
  const h4Hours = [1, 5, 9, 13, 17, 21];
  let nextH = h4Hours.find(h => h > utcH) ?? h4Hours[0];
  const next = new Date(now);
  next.setUTCHours(nextH, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const fmtScanTime = (date) => {
  if (!date) return "—";
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
  const pdtStr = date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: true }) + " PDT";
  return `${utcStr} (${pdtStr})`;
};

const timeAgo = (iso) => {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

/* ── tooltip ─────────────────────────────────────────────────── */

const fmtSnapshotTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

const Tip = ({ active, payload }) => {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const isPartial = d.type === "PARTIAL";
  return (
    <div style={{ background: "#13131c", border: "1px solid #444", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#e0e0ea", maxWidth: 260 }}>
      {/* Snapshot point (from cTrader balance history) */}
      {d.idx !== undefined && d.bal !== undefined && d.eq !== undefined && d.tn === undefined && (
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{fmtSnapshotTime(d.ts)}</div>
      )}
      {d.d && d.tn !== undefined && (
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {d.d} — Event #{d.tn}
          {d.type && (
            <span style={{
              marginLeft: 6,
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 3,
              background: isPartial ? "#cfb95b22" : "#7eb4fa22",
              color: isPartial ? "#cfb95b" : "#7eb4fa",
            }}>{d.type}</span>
          )}
        </div>
      )}
      {d.month && <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.month}</div>}
      {d.bal !== undefined && <div>Balance: <span style={{ color: "#22b89a" }}>${d.bal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.eq !== undefined && d.eq !== d.bal && <div>Equity: <span style={{ color: "#7eb4fa" }}>${d.eq.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.pnl !== undefined && d.tn === undefined && <div>P&L vs $100k: <span style={{ color: d.pnl >= 0 ? "#22b89a" : "#cf5b5b" }}>{d.pnl >= 0 ? "+" : ""}${d.pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.enginePnl !== undefined && <div style={{ color: "#888", fontSize: 11 }}>Engine claimed: {d.enginePnl >= 0 ? "+" : ""}${d.enginePnl.toFixed(2)}</div>}
      {d.sym && <div>{d.sym}{d.mode ? ` ${d.mode}` : ""} — {d.r > 0 ? "+" : ""}{d.r}R</div>}
      {d.reason && <div style={{ color: "#888", fontSize: 11 }}>Exit: {d.reason}</div>}
      {d.trades && <div>{d.trades} events | {d.wr}% WR</div>}
      {d.monthPnl !== undefined && <div>Month P&L: <span style={{ color: d.monthPnl >= 0 ? "#22b89a" : "#cf5b5b" }}>${d.monthPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
    </div>
  );
};

/* ── stat card ───────────────────────────────────────────────── */

const Card = ({ label, value, sub, color = "#22b89a" }) => (
  <div style={{ background: "#13131c", borderRadius: 10, padding: "14px 16px", border: "1px solid #22222e", minWidth: 0, overflow: "hidden" }}>
    <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 3, wordBreak: "break-word", lineHeight: 1.15 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#666", marginTop: 2, wordBreak: "break-word" }}>{sub}</div>}
  </div>
);

/* ── section header ──────────────────────────────────────────── */

const SectionHeader = ({ children }) => (
  <h2 style={{ fontSize: 16, fontWeight: 700, margin: "24px 0 12px", color: "#fff", borderBottom: "1px solid #22222e", paddingBottom: 8 }}>
    {children}
  </h2>
);

/* ── status pill ─────────────────────────────────────────────── */

const StatusPill = ({ status }) => {
  const map = {
    ACTIVE:  { bg: "#22b89a22", fg: "#22b89a", border: "#22b89a44" },
    PAUSED:  { bg: "#cf5b5b22", fg: "#cf5b5b", border: "#cf5b5b44" },
    OFFLINE: { bg: "#88888822", fg: "#888888", border: "#88888844" },
  };
  const s = map[status] || map.OFFLINE;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
      {status}
    </span>
  );
};

/* ── tab navigation ──────────────────────────────────────────── */

function TabBar({ activeTab, onChange, mob, ACCOUNTS, ACCOUNT_KEYS }) {
  const tabs = [
    { key: "main", label: "Main Dashboard", color: "#fff" },
    ...ACCOUNT_KEYS.map(k => ({
      key: k,
      label: ACCOUNTS[k].label,
      color: ACCOUNTS[k].color,
    })),
  ];

  return (
    <div style={{
      display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap",
      borderBottom: "1px solid #22222e", paddingBottom: 12,
    }}>
      {tabs.map(t => {
        const isActive = activeTab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding: mob ? "7px 12px" : "8px 16px",
              borderRadius: 8,
              border: isActive ? `1px solid ${t.color}66` : "1px solid #22222e",
              background: isActive ? `${t.color}22` : "#13131c",
              color: isActive ? t.color : "#888",
              fontSize: mob ? 12 : 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── main dashboard (5-account summary) ──────────────────────── */

function MainDashboard({ mob, onSelectAccount, ACCOUNTS, ACCOUNT_KEYS }) {
  const accounts = ACCOUNT_KEYS.map(k => ACCOUNTS[k]);
  // Curve mode for the comparison chart. "balance" (realized only) is the
  // default — smoother; "equity" (balance + floating P&L) is opt-in via the
  // toggle above the chart card.
  const [chartMode, setChartMode] = useState("balance");

  // Aggregate totals — all $ figures from cTrader (TRUTH)
  const totals = useMemo(() => {
    let totalTrades = 0;
    let totalRealized = 0;
    let totalOpen = 0;
    let totalEquity = 0;
    let totalBalance = 0;
    let activeCount = 0;
    let totalWatchlist = 0;
    for (const a of accounts) {
      totalTrades += a.meta.totalTrades;
      totalRealized += (a.meta.realizedPnl || 0);
      totalOpen += (a.meta.openPnl || 0);
      totalEquity += (a.meta.currentEquity || 0);
      totalBalance += (a.meta.currentBalance || 0);
      if (a.engineState) {
        if (!a.engineState.tradingPaused) activeCount++;
        totalWatchlist += (a.engineState.watchlist?.length || 0);
      }
    }
    return { totalTrades, totalRealized, totalOpen, totalEquity, totalBalance, activeCount, totalWatchlist };
  }, [accounts]);

  // Best & worst by realized $ PnL (truth: balance - 100k)
  // Only rank accounts with at least one trade closed.
  const sorted = [...accounts]
    .filter(a => a.meta.totalTrades > 0)
    .sort((a, b) => (b.meta.realizedPnl || 0) - (a.meta.realizedPnl || 0));
  const bestVariant = sorted[0]?.label || "—";
  const worstVariant = sorted.length > 1 ? sorted[sorted.length - 1]?.label : "—";

  // Equity comparison: hourly-bucket alignment across all variants.
  //
  // 2026-04-30 simplification (recurring "not updating properly" issue):
  // Old algorithm unioned every variant's decimated timestamps into a
  // sparse 3000-row grid where only 1/6 variants had data per row, then
  // ran an O(N²) inner-search for "latest snapshot at-or-before" per
  // (timestamp × variant). With ~3000 ts × 6 variants × 500-point curves
  // that was ~9M iterations per render, AND the curves stepped weirdly
  // because per-variant strided decimation picked different sample points.
  //
  // New algorithm: align all variants to a fixed hourly time grid
  // covering the full snapshot window. For each hour bucket, take the
  // last-balance-at-or-before via merge-walk (each variant's curve is
  // already sorted ascending). O(buckets × variants) — for 90d × 6
  // variants = 12,960 ops. Curves stay aligned because the grid is shared.
  //
  // The most recent snapshot is always included as a final row even if
  // it falls between hour boundaries — guarantees the curve tip always
  // reflects the latest data the hook has fetched.
  const equityCompare = useMemo(() => {
    if (!accounts?.length) return [];

    // Find the curve span across all accounts
    let minTs = null, maxTs = null;
    for (const a of accounts) {
      const curve = a.balanceCurve || [];
      if (!curve.length) continue;
      const first = curve[0].ts, last = curve[curve.length - 1].ts;
      if (!minTs || first < minTs) minTs = first;
      if (!maxTs || last  > maxTs) maxTs = last;
    }
    if (!minTs || !maxTs) return [];

    // Build hourly bucket grid (UTC hour boundaries)
    const HOUR_MS = 60 * 60 * 1000;
    const startMs = Math.floor(new Date(minTs).getTime() / HOUR_MS) * HOUR_MS;
    const endMs   = new Date(maxTs).getTime();
    const buckets = [];
    for (let t = startMs; t <= endMs; t += HOUR_MS) {
      buckets.push(new Date(t).toISOString());
    }

    // Per-variant cursor for merge-walk (avoids re-scanning from index 0)
    const cursors = accounts.map(() => 0);

    const data = buckets.map((bucketTs, i) => {
      const row = { idx: i, ts: bucketTs, label: fmtSnapshotTime(bucketTs) };
      accounts.forEach((a, vi) => {
        const curve = a.balanceCurve || [];
        // Advance cursor to last point with p.ts <= bucketTs
        let cur = cursors[vi];
        while (cur + 1 < curve.length && curve[cur + 1].ts <= bucketTs) cur++;
        cursors[vi] = cur;
        // Use the cursor point if it's <= bucketTs, else fall back to start
        const p = curve[cur];
        if (p && p.ts <= bucketTs) {
          row[a.key] = chartMode === "balance" ? p.bal : p.eq;
        } else {
          row[a.key] = 100000;  // FTMO starting balance fallback
        }
      });
      return row;
    });

    // Append a final row reflecting the most-recent snapshot per variant —
    // ensures the curve tip is always current even if the hour bucket lags.
    const lastRow = { idx: data.length, ts: maxTs, label: fmtSnapshotTime(maxTs) };
    accounts.forEach(a => {
      const curve = a.balanceCurve || [];
      if (curve.length) {
        const last = curve[curve.length - 1];
        lastRow[a.key] = chartMode === "balance" ? last.bal : last.eq;
      } else {
        lastRow[a.key] = 100000;
      }
    });
    // Only append if it's strictly past the last hourly bucket
    if (data.length === 0 || data[data.length - 1].ts !== maxTs) {
      data.push(lastRow);
    }

    // Project change events onto the rows. Each row may now carry a
    // `${variantKey}_changes` array consumed by the per-Line dot renderer.
    return attachChangeEvents(data, VARIANT_CHANGE_EVENTS);
  }, [accounts, chartMode]);

  return (
    <>
      <SectionHeader>Multi-Account Overview</SectionHeader>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,minmax(0,1fr))" : "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 20 }}>
        <Card label="Active Accounts" value={`${totals.activeCount} / ${accounts.length}`} sub="Engines running" color="#22b89a" />
        <Card
          label="Total Equity"
          value={`$${totals.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Across ${accounts.length} accounts`}
          color="#7eb4fa"
        />
        <Card
          label="Total Closes"
          value={totals.totalTrades}
          sub={`Realized: ${totals.totalRealized >= 0 ? "+" : ""}$${totals.totalRealized.toFixed(2)}`}
          color="#a78bfa"
        />
        <Card label="Watchlist" value={totals.totalWatchlist} sub="Active setups" color="#cfb95b" />
        <Card
          label="Next H4 Scan"
          value={(() => {
            const prodState = accounts.find(a => a.key === "production")?.engineState;
            const nextScan = getNextH4Scan(prodState?.nextH4Scan);
            return nextScan.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: true });
          })()}
          sub={(() => {
            const prodState = accounts.find(a => a.key === "production")?.engineState;
            const nextScan = getNextH4Scan(prodState?.nextH4Scan);
            return nextScan.toLocaleString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
          })()}
          color="#22d3ee"
        />
        <Card
          label="Best / Worst"
          value={bestVariant}
          sub={worstVariant !== "—" ? `Worst: ${worstVariant}` : "Need more data"}
          color="#22b89a"
        />
      </div>

      {/* Per-account performance table */}
      <SectionHeader>Account Performance</SectionHeader>
      <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden", marginBottom: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                {["Account", "Status", "Balance", "Equity", "Open P&L", "Realized P&L", "Daily P&L", "Closes", "Max DD"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const s = a.engineState;
                const balance = a.meta.currentBalance ?? 100000;
                const equity = a.meta.currentEquity ?? balance;
                // Day P&L is only meaningful when engine state has reported a
                // dayStartBalance. Falling back to current balance silently
                // produces $0 on variants whose state is loading or missing,
                // which masks "no state" as "no movement". Show — instead.
                const hasDayStart = s?.dayStartBalance != null;
                const dayStart = hasDayStart ? s.dayStartBalance : null;
                const dayPnl = hasDayStart ? equity - dayStart : null;
                const realized = a.meta.realizedPnl || 0;
                const openPnl = a.meta.openPnl || 0;
                return (
                  <tr
                    key={a.key}
                    onClick={() => onSelectAccount(a.key)}
                    style={{
                      borderBottom: "1px solid #1a1a26",
                      cursor: "pointer",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#22223333"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: "50%", background: a.color, display: "inline-block",
                        }} />
                        <span style={{ fontWeight: 600 }}>{a.label}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>#{a.displayId || a.accountId}</div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <StatusPill status={a.status} />
                    </td>
                    <td style={{ padding: "10px 12px", color: "#e0e0ea", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
                      ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ padding: "10px 12px", color: equity >= balance ? "#22b89a" : "#cf5b5b", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
                      ${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ padding: "10px 12px", color: openPnl >= 0 ? "#22b89a" : "#cf5b5b", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
                      {openPnl >= 0 ? "+" : ""}${openPnl.toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 12px", color: realized >= 0 ? "#22b89a" : "#cf5b5b", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontWeight: 600 }}>
                      {realized >= 0 ? "+" : ""}${realized.toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 12px", color: dayPnl == null ? "#555" : dayPnl >= 0 ? "#22b89a" : "#cf5b5b", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
                      {dayPnl == null ? "—" : `${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {a.meta.totalTrades}
                      {a.meta.partialCount > 0 && (
                        <span style={{ fontSize: 10, color: "#cfb95b", marginLeft: 4 }}>+{a.meta.partialCount}p</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", color: a.meta.maxDD < 5 ? "#22b89a" : a.meta.maxDD < 10 ? "#cfb95b" : "#cf5b5b" }}>
                      {a.meta.maxDD > 0 ? `${a.meta.maxDD}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 12px", borderTop: "1px solid #1a1a26", fontSize: 11, color: "#555", textAlign: "center" }}>
          Click any row to view that account's full dashboard ·
          All $ figures sourced directly from cTrader balance/equity (authoritative)
        </div>
      </div>

      {/* Variant config comparison — structured at-a-glance fields.
          Full prose notes live offline in docs/variant_state.md (refreshed
          on every Rule-2 deploy). Columns prioritized to surface ACTUAL
          per-variant differences: Account / Q-gate / Partial / BE / Risk /
          Stop / Trail / Universe. */}
      <SectionHeader>Variant Configuration</SectionHeader>
      <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden", marginBottom: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                {[
                  ["Variant",   "Account label and color"],
                  ["Account",   "Account type + profit target (Challenge has Step-1 target; demos have none)"],
                  ["Q Gate",    "Quality score gate (signal admission threshold)"],
                  ["Partial",   "Partial-close trigger and size (e.g. 20%@0.6R = close 20% at +0.6R MFE)"],
                  ["BE",        "Break-even rule: coincident with partial vs decoupled (D2 — BE moves only after MFE crosses N R)"],
                  ["Risk",      "Per-trade risk as % of balance (engine constant; restart-bound)"],
                  ["Stop",      "Stop placement strategy (classifier = V1, pivot_half_fib = V2)"],
                  ["Trail",     "Trailing-stop mode (off / C5 = act-60% / 10%-trail / 12R-ceiling)"],
                  ["Universe",  "Active instrument set"],
                ].map(([h, title]) => (
                  <th key={h} title={title}
                      style={{ textAlign: "left", padding: "10px 12px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const c = a.config || {};
                const partialStr = (c.partial_pct != null && c.partial_trigger_r != null)
                  ? `${(c.partial_pct * 100).toFixed(0)}%@${c.partial_trigger_r}R`
                  : "—";
                const riskStr = c.risk_pct != null ? `${(c.risk_pct * 100).toFixed(2)}%` : "—";
                // Trail-active variants get a yellow "C5" badge so the contrast
                // with off variants is obvious at a glance.
                const trailIsOff = (c.trail || "").toLowerCase().startsWith("off");
                const trailColor = trailIsOff ? "#888" : "#cfb95b";
                // Account type + target: Challenge gets a tinted badge so it
                // stands out against the demo rows. Production = FTMO Free
                // Demo (also tinted, lighter) since it's the V2/Plan-A/B/C
                // reference. Spotware demos are neutral.
                const isChallenge = c.account_type?.includes("Challenge");
                const isProduction = c.account_type?.includes("FTMO Free");
                const acctColor = isChallenge ? "#cf8f5b" : isProduction ? "#22b89a" : "#888";
                return (
                  <tr key={a.key} style={{ borderBottom: "1px solid #1a1a26" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.color, display: "inline-block" }} />
                        <span style={{ fontWeight: 600 }}>{a.label}</span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px", fontSize: 11 }}>
                      <div style={{ color: acctColor, fontWeight: 600 }}>{c.account_type ?? "—"}</div>
                      {c.target_pct != null && (
                        <div style={{ color: "#888", marginTop: 2 }}>Target = {c.target_pct}%</div>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>{c.quality_gate ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>{partialStr}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 11, color: "#aaa" }}>{c.be_move ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace", color: "#22b89a" }}
                        title="Phase 1 fleet-wide RISK_PCT (engine constant)">
                      {riskStr}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace", color: "#7eb4fa" }}>{c.stop_mode ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "'Space Grotesk', ui-monospace, monospace", color: trailColor }}>{c.trail ?? "—"}</td>
                    <td style={{ padding: "10px 12px", color: "#aaa", fontSize: 11 }}>{c.universe_filter ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 12px", borderTop: "1px solid #1a1a26", fontSize: 11, color: "#555", textAlign: "center" }}>
          Structured fields only · full per-variant deploy state and rationale lives in
          {" "}<code style={{ color: "#aaa" }}>docs/variant_state.md</code>{" "}
          (refresh on every Rule-2 deploy)
        </div>
      </div>

      {/* Equity comparison chart (only if we have at least one snapshot point) */}
      {equityCompare.length > 0 && (
        <>
          <SectionHeader>{chartMode === "balance" ? "Balance" : "Equity"} Curve Comparison</SectionHeader>
          {/* Balance / Equity toggle — balance (realized only) is the default;
              equity (balance + floating P&L) is opt-in. Style mirrors the
              existing tab-button pattern in TradePerformance. */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {[["balance", "Balance"], ["equity", "Equity"]].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setChartMode(v)}
                title={v === "balance" ? "Realized P&L only — smoother curve" : "Balance + floating P&L — moves with open positions"}
                style={{
                  padding: "7px 18px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                  background: chartMode === v ? "#22b89a" : "#13131c",
                  color: chartMode === v ? "#000" : "#888",
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div style={{ background: "#13131c", borderRadius: 12, border: "1px solid #22222e", padding: "16px 12px 6px", marginBottom: 14 }}>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={equityCompare}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis
                  dataKey="idx"
                  tick={{ fontSize: 11, fill: "#666" }}
                  tickFormatter={(v) => equityCompare[v]?.label || ""}
                  label={{ value: "Snapshot time", position: "insideBottom", offset: -2, fill: "#666", fontSize: 11 }}
                />
                <YAxis tick={{ fontSize: 11, fill: "#666" }} domain={["auto", "auto"]} tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = equityCompare[label];
                    return (
                      <div style={{ background: "#13131c", border: "1px solid #444", borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>{row?.label || `Point ${label}`}</div>
                        {payload.map(p => (
                          <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
                            {ACCOUNTS[p.dataKey]?.label}: ${p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={100000} stroke="#555" strokeDasharray="4 4" />
                {accounts.map(a => (
                  <Line
                    key={a.key}
                    type="monotone"
                    dataKey={a.key}
                    stroke={a.color}
                    strokeWidth={2}
                    // Per-point dot renderer: returns a marker SVG only for
                    // points that carry a `${variantKey}_changes` array
                    // (populated by attachChangeEvents). Non-event points
                    // return null (Recharts 3.x handles cleanly).
                    //
                    // 2026-04-30: removed the per-marker SVG <title> tooltip
                    // — it was triggering occasional DOM crashes on points
                    // with multiple stacked events (long concatenated tip
                    // strings). Markers are now visual-only; users can
                    // cross-reference change details in changeEvents.js
                    // until a proper Tooltip overlay is wired (deferred).
                    dot={(props) => {
                      const events = props?.payload?.[`${a.key}_changes`];
                      if (!events?.length) return null;
                      const cx = props.cx;
                      const cy = props.cy;
                      return (
                        <g key={`mark-${a.key}-${props.index}`}>
                          {/* outer ring for contrast against any line color */}
                          <circle cx={cx} cy={cy} r={7} fill="#0a0a14" stroke={a.color} strokeWidth={2} />
                          {/* inner solid disc — variant color */}
                          <circle cx={cx} cy={cy} r={3.5} fill={a.color} stroke="#fff" strokeWidth={0.5} />
                        </g>
                      );
                    }}
                    activeDot={{ r: 5, strokeWidth: 1 }}
                    name={a.label}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: "#555", textAlign: "center", marginTop: 6 }}>
              Markers (◉) on each curve indicate config changes that took effect at that timestamp ·
              Sourced from live cTrader balance snapshots
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ── engine status section (per-account) ─────────────────────── */

function EngineStatus({ account, mob, lastUpdated, refetch }) {
  // Manual-refresh button state — flashes briefly so the user gets
  // feedback that the click did something, even if Supabase round-
  // trip is fast enough that nothing visibly changes.
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshClick = async () => {
    if (refreshing || !refetch) return;
    setRefreshing(true);
    try { await refetch(); } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };
  // Color-code page sync age. Stale => the dashboard isn't keeping up
  // (often iOS PWA suspending the JS process). Clearly different from
  // engine snapshot age, which is when the publisher last wrote state.
  const ageMs = lastUpdated ? Date.now() - new Date(lastUpdated).getTime() : null;
  const ageMin = ageMs != null ? Math.floor(ageMs / 60000) : null;
  const syncColor =
    ageMin == null ? "#666" :
    ageMin < 3 ? "#22b89a" :
    ageMin < 10 ? "#cfb95b" :
    "#cf5b5b";
  const syncLabel =
    ageMin == null ? "—" :
    ageMin < 1 ? "just now" :
    ageMin === 1 ? "1m ago" :
    `${ageMin}m ago`;
  if (!account?.engineState) {
    return (
      <>
        <SectionHeader>Engine Status</SectionHeader>
        <div style={{ background: "#13131c", borderRadius: 10, padding: 20, border: "1px solid #22222e", textAlign: "center", color: "#666", fontSize: 13 }}>
          No engine state available for {account?.label || "this account"}
        </div>
      </>
    );
  }
  const s = account.engineState;

  const trailingDdUsed = s.highestEodBalance - s.trailingDdFloor;
  // Clamp the "DD consumed" numerator at 0 so the bar reads 0% when
  // equity is above the prior peak (i.e., we're not in any drawdown
  // at all). Previously it could go negative and render as `-$447 / $10117`
  // which was a confusing "DD usage is negative" display.
  const trailingDdConsumed = Math.max(0, s.highestEodBalance - s.equity);
  const trailingDdPct = trailingDdUsed > 0 ? (trailingDdConsumed / trailingDdUsed * 100).toFixed(1) : "0";
  const dailyDdPct = s.dailyDdLimit > 0 ? ((s.dailyLoss / s.dailyDdLimit) * 100).toFixed(1) : "0";

  return (
    <>
      <SectionHeader>Engine Status</SectionHeader>

      {/* Status indicator + freshness readout + manual refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: s.tradingPaused ? "#cf5b5b22" : "#22b89a22",
          color: s.tradingPaused ? "#cf5b5b" : "#22b89a",
          padding: "4px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600,
          border: `1px solid ${s.tradingPaused ? "#cf5b5b44" : "#22b89a44"}`,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {s.tradingPaused ? "TRADING PAUSED" : "ACTIVE"}
        </span>
        {/* Engine snapshot age — when the publisher last wrote state.
            If this lags, the publisher (or its cron / sleep window)
            is behind. */}
        <span style={{ fontSize: 12, color: "#888" }}>
          Engine: {timeAgo(s.updated)}
        </span>
        <span style={{ fontSize: 11, color: "#555" }}>
          ({fmtTime(s.updated)})
        </span>
        {/* Page-sync age — when this browser tab last successfully
            fetched. If this lags but the engine is fresh, the dashboard
            is stuck (typically iOS PWA suspending the JS process).
            Color-coded: green < 3m, amber 3–10m, red > 10m. */}
        <span style={{ fontSize: 12, color: syncColor, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: syncColor, display: "inline-block" }} />
          Page synced {syncLabel}
        </span>
        {refetch && (
          <button
            onClick={onRefreshClick}
            disabled={refreshing}
            aria-label="Refresh now"
            title="Refresh now"
            style={{
              background: refreshing ? "#22b89a22" : "transparent",
              border: `1px solid ${refreshing ? "#22b89a55" : "#22222e"}`,
              borderRadius: 6,
              padding: "4px 8px",
              cursor: refreshing ? "wait" : "pointer",
              color: refreshing ? "#22b89a" : "#888",
              fontFamily: "inherit",
              fontSize: 13,
              lineHeight: 1,
              transition: "all 0.15s",
            }}
          >
            {/* Circular refresh glyph */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ display: "block", animation: refreshing ? "ftmoSpin 0.6s linear infinite" : "none" }}>
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
            <style>{`@keyframes ftmoSpin { to { transform: rotate(360deg); } }`}</style>
          </button>
        )}
      </div>

      {/* Next scan times */}
      {(() => {
        const nextH4 = getNextH4Scan(s.nextH4Scan);
        return (
          <div style={{ background: "#13131c", borderRadius: 8, padding: "10px 14px", border: "1px solid #22222e", marginBottom: 14, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Next H4 Scan:</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#7eb4fa" }}>{fmtScanTime(nextH4)}</span>
            </div>
            <div style={{ width: 1, height: 16, background: "#333" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Next M10 Scan:</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#888" }}>{(() => {
                const now = new Date();
                const nextMin = (Math.floor(now.getMinutes() / 10) + 1) * 10;
                const next = new Date(now);
                if (nextMin >= 60) { next.setHours(next.getHours() + 1); next.setMinutes(0); } else { next.setMinutes(nextMin); }
                next.setSeconds(0);
                return fmtScanTime(next);
              })()}</span>
            </div>
          </div>
        );
      })()}

      {/* Engine stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,minmax(0,1fr))" : "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 14 }}>
        <Card label="Balance" value={`$${s.balance.toLocaleString()}`} sub={`Day start: $${s.dayStartBalance.toLocaleString()}`} color="#7eb4fa" />
        <Card label="Equity" value={`$${s.equity.toLocaleString()}`} sub={`P&L: $${(s.equity - s.dayStartBalance).toFixed(2)}`} color={s.equity >= s.dayStartBalance ? "#22b89a" : "#cf5b5b"} />
        <Card
          label="Activity"
          value={s.h4Scans != null && s.m10Scans != null
            ? `${s.h4Scans} / ${s.m10Scans}`
            : "—"}
          sub={s.h4Scans != null
            ? "H4 / M10 scans since engine start"
            : "Cumulative counters pending publisher update"}
          color="#7eb4fa"
        />
        <Card
          label="Trades Placed"
          value={s.tradesPlaced ?? 0}
          sub={s.tradesPlacedFromEngine
            ? "Since engine start"
            : "Open + closed (engine counter pending)"}
          color="#a78bfa"
        />
      </div>

      {/* Prop firm drawdown bars */}
      <div style={{ background: "#13131c", borderRadius: 10, padding: 16, border: "1px solid #22222e" }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "#ccc" }}>Drawdown Limits</h3>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 16 }}>
          {/* Daily DD */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "#888" }}>Daily Loss</span>
              <span style={{ color: parseFloat(dailyDdPct) > 80 ? "#cf5b5b" : "#22b89a" }}>
                ${s.dailyLoss.toFixed(2)} / ${s.dailyDdLimit.toFixed(2)}
              </span>
            </div>
            <div style={{ background: "#222", borderRadius: 4, height: 8, overflow: "hidden" }}>
              <div style={{
                background: parseFloat(dailyDdPct) > 80 ? "#cf5b5b" : parseFloat(dailyDdPct) > 50 ? "#cfb95b" : "#22b89a",
                height: "100%", width: `${Math.min(100, parseFloat(dailyDdPct))}%`, borderRadius: 4, transition: "width 0.3s",
              }} />
            </div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2, display: "flex", justifyContent: "space-between" }}>
              <span>{dailyDdPct}% of daily limit used</span>
              {s.dailyPnl != null && (
                <span style={{ color: s.dailyPnl >= 0 ? "#22b89a" : "#cf5b5b" }}>
                  Daily P&L: {s.dailyPnl >= 0 ? "+" : ""}${s.dailyPnl.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          {/* Trailing DD */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "#888" }}>Trailing DD</span>
              <span style={{ color: parseFloat(trailingDdPct) > 80 ? "#cf5b5b" : "#22b89a" }}>
                ${trailingDdConsumed.toFixed(2)} / ${trailingDdUsed.toFixed(2)}
              </span>
            </div>
            <div style={{ background: "#222", borderRadius: 4, height: 8, overflow: "hidden" }}>
              <div style={{
                background: parseFloat(trailingDdPct) > 80 ? "#cf5b5b" : parseFloat(trailingDdPct) > 50 ? "#cfb95b" : "#22b89a",
                height: "100%", width: `${Math.min(100, Math.max(0, parseFloat(trailingDdPct)))}%`, borderRadius: 4, transition: "width 0.3s",
              }} />
            </div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>Floor: ${s.trailingDdFloor.toLocaleString()} | Peak: ${s.highestEodBalance.toLocaleString()}</div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── watchlist section (per-account) ─────────────────────────── */

/* ── open positions (per-account, from bridge at build time) ──── */

function OpenPositions({ account, mob }) {
  const [expanded, setExpanded] = useState(new Set());
  const positions = account?.openPositions || [];
  if (positions.length === 0) {
    return (
      <>
        <SectionHeader>Open Positions (0 / 5)</SectionHeader>
        <div style={{ background: "#13131c", borderRadius: 10, padding: 16, border: "1px solid #22222e", textAlign: "center", color: "#666", fontSize: 13, marginBottom: 14 }}>
          No open positions — all slots available
        </div>
      </>
    );
  }
  return (
    <>
      <SectionHeader>Open Positions ({positions.length} / 5)</SectionHeader>
      <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden", marginBottom: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                {["", "Symbol", "Side", "Entry", "Stop", "Target", "Unrealized P&L"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const rowKey = `${p.symbol}-${p.positionId ?? p.openTime ?? i}`;
                const isOpen = expanded.has(rowKey);
                const toggle = () => {
                  const next = new Set(expanded);
                  if (isOpen) next.delete(rowKey);
                  else next.add(rowKey);
                  setExpanded(next);
                };
                // Trail detection: trust the engine's MGMT_STATE_TRANSITION
                // event as the source of truth, not numeric SL comparison.
                // Brokers adjust SL/TP at order placement (cTrader
                // stop-level enforcement) by 1-2 pips — that is NOT a
                // trail/BE move. The publisher derives stopAmendedAfterOpen
                // from event log; only that flag should light up the badge.
                // Fall through `?? false` for backward compat with old rows
                // (still numeric for those — Supabase rows refresh in 60s).
                const trailEngaged = p.stopAmendedAfterOpen ?? (
                  p.originalStopLoss != null && p.stopLoss != null
                  && Math.abs(p.originalStopLoss - p.stopLoss) > 1e-9
                );
                return (
                <Fragment key={rowKey}>
                <tr
                  onClick={toggle}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } }}
                  aria-expanded={isOpen}
                  style={{
                    borderBottom: isOpen ? "none" : "1px solid #1a1a26",
                    cursor: "pointer",
                    background: isOpen ? "#22223344" : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(ev) => { if (!isOpen) ev.currentTarget.style.background = "#22223322"; }}
                  onMouseLeave={(ev) => { if (!isOpen) ev.currentTarget.style.background = "transparent"; }}
                >
                  <td style={{ padding: "8px 6px 8px 10px", color: "#888", fontSize: 14, width: 24, textAlign: "center", userSelect: "none" }} aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </td>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>
                    {p.symbol}
                    {trailEngaged && <span style={{ marginLeft: 6, fontSize: 9, color: "#cfb95b", border: "1px solid #cfb95b44", padding: "1px 5px", borderRadius: 3 }}>TRAIL</span>}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ color: p.side === "BUY" ? "#22b89a" : "#cf5b5b", fontSize: 12, fontWeight: 600 }}>
                      {p.side}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>
                    {fmtPrice(p.entryPrice)}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12, color: "#cf5b5b" }}>
                    {fmtPrice(p.stopLoss)}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12, color: "#22b89a" }}>
                    {fmtPrice(p.takeProfit)}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontWeight: 600, color: (p.unrealizedPnl ?? 0) >= 0 ? "#22b89a" : "#cf5b5b" }}>
                    {p.unrealizedPnl != null ? `${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)}` : "—"}
                  </td>
                </tr>
                {isOpen && (
                  <tr style={{ borderBottom: "1px solid #1a1a26" }}>
                    <td colSpan={7} style={{ padding: 0 }}>
                      {/* Mobile: anchor the detail content to the left edge
                          of the visible viewport via position:sticky so it
                          doesn't inherit the table's wider min-width and
                          push the chart off-screen. Desktop: full width is
                          fine, the table fits the page wrapper. */}
                      <div style={mob ? {
                        position: "sticky", left: 0,
                        width: "calc(100vw - 24px)",
                        maxWidth: "100%", boxSizing: "border-box",
                      } : undefined}>
                        <PositionDetailPanel position={p} account={account} mob={mob} trailEngaged={trailEngaged} />
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "6px 10px", borderTop: "1px solid #1a1a26", fontSize: 10, color: "#555", textAlign: "center" }}>
          {5 - positions.length} slot{5 - positions.length !== 1 ? "s" : ""} available · click any row for position detail
        </div>
      </div>
    </>
  );
}

/* ── position detail panel ─────────────────────────────────────── */

function PositionDetailPanel({ position, account, mob, trailEngaged }) {
  // Live ticker so unrealized P&L / current price recalculations stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const p = position;

  // Derive distances from current price to stop / target. These are the
  // most-asked-about numbers when watching a live trade.
  let distToStop = null, distToTarget = null, rMultipleNow = null;
  if (p.currentPrice != null) {
    if (p.stopLoss != null) distToStop = Math.abs(p.currentPrice - p.stopLoss);
    if (p.takeProfit != null) distToTarget = Math.abs(p.takeProfit - p.currentPrice);
    // Current R-multiple = unrealized / 1R risk. 1R = entry-to-original-stop
    // distance, which we have only when originalStopLoss is populated.
    const oneR = p.originalStopLoss != null && p.entryPrice != null
      ? Math.abs(p.entryPrice - p.originalStopLoss) : null;
    if (oneR != null && oneR > 0) {
      const direction = p.side === "BUY" ? 1 : -1;
      rMultipleNow = (p.currentPrice - p.entryPrice) * direction / oneR;
    }
  }

  // Time held
  let heldLabel = "—";
  if (p.openTime) {
    const heldMin = Math.floor((Date.now() - new Date(p.openTime).getTime()) / 60000);
    if (!isNaN(heldMin) && heldMin >= 0) heldLabel = fmtAge(heldMin);
  }

  // Risk USD = balance × variant risk pct
  const riskPct = (account?.config?.risk_pct ?? 0.008);
  const balance = account?.meta?.currentBalance ?? account?.engineState?.balance ?? 100000;
  const riskUsd = balance * riskPct;

  // Stop/target movement deltas (vs originals) — only meaningful when
  // engine has populated originalStopLoss / originalTakeProfit.
  // Source of truth: stopAmendedAfterOpen / targetAmendedAfterOpen flags
  // from the publisher (derived from MGMT_STATE_TRANSITION events).
  // Numeric comparison of original vs live can produce false positives
  // due to cTrader adjusting SL/TP at order placement (~1-2 pips drift)
  // even when the engine never amended. Trust the flags. Fall through
  // to numeric for old Supabase rows that don't yet carry the flags.
  const stopMoved = p.stopAmendedAfterOpen ?? (
    p.originalStopLoss != null && p.stopLoss != null
    && Math.abs(p.originalStopLoss - p.stopLoss) > 1e-9
  );
  const targetMoved = p.targetAmendedAfterOpen ?? (
    p.originalTakeProfit != null && p.takeProfit != null
    && Math.abs(p.originalTakeProfit - p.takeProfit) > 1e-9
  );

  // Section style — same as WatchlistDetailPanel for visual consistency
  const sectionTitle = {
    fontSize: mob ? 9 : 10, fontWeight: 700, letterSpacing: 1.1,
    textTransform: "uppercase", color: "#888",
    margin: mob ? "0 0 6px" : "0 0 8px",
  };
  const fieldRow = {
    display: "grid",
    gridTemplateColumns: mob ? "minmax(90px,auto) 1fr" : "minmax(140px,auto) 1fr",
    gap: mob ? 6 : 8,
    padding: mob ? "2px 0" : "3px 0",
    fontSize: mob ? 10 : 12,
    lineHeight: mob ? 1.35 : 1.45,
  };
  const fieldLabel = { color: "#888" };
  const fieldVal = { color: "#e0e0ea", fontFamily: "'Space Grotesk', ui-monospace, monospace", wordBreak: "break-word" };
  const sectionBox = {
    background: "#0e0e15",
    borderRadius: mob ? 6 : 8,
    padding: mob ? "9px 10px" : "12px 14px",
    border: "1px solid #1a1a26",
    minWidth: 0,
  };
  const grid = {
    display: "grid",
    gridTemplateColumns: mob ? "1fr" : "1fr 1fr",
    gap: mob ? 8 : 10,
  };

  // Adapt the position into a SetupChart-compatible "entry" so the same
  // chart annotations work. The chart cares about: candles, direction,
  // a few price levels. We map position-side → bullish/bearish and pass
  // entry/stop/target as the relevant lines.
  const chartEntry = {
    symbol: p.symbol,
    candles: p.candles,
    direction: p.side === "BUY" ? "bullish" : "bearish",
    // 2026-05-03: position-panel chart shows position-relevant lines only.
    // Previously this re-used the watchlist-shaped chart props with hacky
    // mappings (impulseEndPrice → originalTakeProfit, etc.), which caused
    // misleading labels — most visibly the "Break ▼" annotation rendering
    // AT the target line when currentPrice was null and SetupChart's
    // breakLevel = candidateBreakLevel ?? impulseEndPrice fallback fired.
    //
    // For positions: only Entry, live Stop, live Target are meaningful.
    // "Break" / "Impulse start" / "Fib 0.786" are watchlist concepts —
    // levels relevant BEFORE entry fires. After entry, the trade is in
    // motion and those levels are historical noise. Original stop/target
    // deltas are surfaced numerically in the panel below the chart.
    stopPrice:           p.stopLoss,    // live (may move on trail/BE)
    targetPrice:         p.takeProfit,  // live
    entryPrice:          p.entryPrice,  // new: drawn as "Entry" line
    impulseStartPrice:   null,          // watchlist-only
    impulseEndPrice:     null,          // watchlist-only
    candidateBreakLevel: null,          // watchlist-only
    fib786:              null,          // watchlist-only
  };

  return (
    <div style={{
      background: "#0a0a10",
      padding: mob ? "10px 8px" : "14px 16px",
      borderTop: "1px solid #1a1a26",
      borderBottom: "1px solid #1a1a26",
    }}>
      {/* Chart (lazy-loaded) */}
      <div style={{ marginBottom: mob ? 10 : 12 }}>
        <Suspense fallback={
          <div style={{
            background: "#0e0e15", borderRadius: mob ? 6 : 8, border: "1px solid #1a1a26",
            padding: 16, textAlign: "center", color: "#555", fontSize: 11, fontStyle: "italic",
          }}>Loading chart…</div>
        }>
          <SetupChart entry={chartEntry} height={mob ? 220 : 280} />
        </Suspense>
      </div>

      <div style={grid}>
        {/* ENTRY */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Entry</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Side</span>
            <span style={{ ...fieldVal, color: p.side === "BUY" ? "#22b89a" : "#cf5b5b" }}>
              {p.side === "BUY" ? "LONG" : "SHORT"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Entry price</span>
            <span style={fieldVal}>{fmtPrice(p.entryPrice)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Current price</span>
            <span style={fieldVal}>
              {fmtPrice(p.currentPrice)}
              {p.entryPrice != null && p.currentPrice != null && (
                <span style={{ color: "#666", marginLeft: 6 }}>
                  ({((p.currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(2)}%)
                </span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Time held</span>
            <span style={fieldVal}>{heldLabel}</span>
          </div>
          {p.volume != null && (
            <div style={fieldRow}>
              <span style={fieldLabel}>Volume</span>
              <span style={fieldVal}>{p.volume}</span>
            </div>
          )}
        </div>

        {/* STOP */}
        <div style={sectionBox}>
          <div style={sectionTitle}>
            Stop
            {trailEngaged && (
              <span style={{ marginLeft: 8, fontSize: 9, color: "#cfb95b", letterSpacing: 0.5 }}>
                · TRAIL ENGAGED
              </span>
            )}
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Original stop</span>
            <span style={fieldVal}>
              {p.originalStopLoss != null ? fmtPrice(p.originalStopLoss) : (
                <span style={{ color: "#555", fontStyle: "italic" }}>tracking pending</span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Live stop</span>
            <span style={{ ...fieldVal, color: stopMoved ? "#cfb95b" : "#cf5b5b" }}>
              {fmtPrice(p.stopLoss)}
              {stopMoved && p.originalStopLoss != null && (
                <span style={{ color: "#666", marginLeft: 6 }}>
                  ({((p.stopLoss - p.originalStopLoss) >= 0 ? "+" : "")}{fmtPrice(p.stopLoss - p.originalStopLoss)})
                </span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Distance from price</span>
            <span style={fieldVal}>
              {distToStop != null ? fmtPrice(distToStop) : "—"}
            </span>
          </div>
        </div>

        {/* TARGET */}
        <div style={sectionBox}>
          <div style={sectionTitle}>
            Target
            {targetMoved && (
              <span style={{ marginLeft: 8, fontSize: 9, color: "#cfb95b", letterSpacing: 0.5 }}>
                · MOVED
              </span>
            )}
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Original target</span>
            <span style={fieldVal}>
              {p.originalTakeProfit != null ? fmtPrice(p.originalTakeProfit) : (
                <span style={{ color: "#555", fontStyle: "italic" }}>tracking pending</span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Live target</span>
            <span style={{ ...fieldVal, color: targetMoved ? "#cfb95b" : "#22b89a" }}>
              {fmtPrice(p.takeProfit)}
              {targetMoved && p.originalTakeProfit != null && (
                <span style={{ color: "#666", marginLeft: 6 }}>
                  ({((p.takeProfit - p.originalTakeProfit) >= 0 ? "+" : "")}{fmtPrice(p.takeProfit - p.originalTakeProfit)})
                </span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Distance from price</span>
            <span style={fieldVal}>
              {distToTarget != null ? fmtPrice(distToTarget) : "—"}
            </span>
          </div>
        </div>

        {/* P&L */}
        <div style={sectionBox}>
          <div style={sectionTitle}>P&L</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Unrealized</span>
            <span style={{ ...fieldVal, color: (p.unrealizedPnl ?? 0) >= 0 ? "#22b89a" : "#cf5b5b", fontWeight: 700 }}>
              {p.unrealizedPnl != null
                ? `${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)}`
                : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>R-multiple</span>
            <span style={{ ...fieldVal, color: (rMultipleNow ?? 0) >= 0 ? "#22b89a" : "#cf5b5b" }}>
              {rMultipleNow != null
                ? `${rMultipleNow >= 0 ? "+" : ""}${rMultipleNow.toFixed(2)}R`
                : <span style={{ color: "#555", fontStyle: "italic" }}>needs original stop</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>1R risk</span>
            <span style={fieldVal}>{fmtUsd(riskUsd)}
              <span style={{ color: "#666", marginLeft: 6 }}>({(riskPct * 100).toFixed(2)}% of {fmtUsd(balance)})</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── trade history (closed trades, paginated) ──────────────────── */

const PAGE_SIZE = 10;

function TradeHistory({ account, mob }) {
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(new Set());

  // Trades come from useSupabaseData sorted by exit_time ASC. Display
  // newest-first so "page 1" is the last 10 closed trades.
  const allTrades = useMemo(() => {
    const t = [...(account?.trades || [])];
    t.reverse();
    return t;
  }, [account?.trades]);

  const totalPages = Math.max(1, Math.ceil(allTrades.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const trades = allTrades.slice(start, start + PAGE_SIZE);

  if (allTrades.length === 0) {
    return (
      <>
        <SectionHeader>Trade History (0 closed)</SectionHeader>
        <div style={{ background: "#13131c", borderRadius: 10, padding: 16, border: "1px solid #22222e", textAlign: "center", color: "#666", fontSize: 13, marginBottom: 14 }}>
          No closed trades yet
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader>Trade History ({allTrades.length} closed · page {safePage + 1}/{totalPages})</SectionHeader>
      <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden", marginBottom: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                {["", "When", "Symbol", "Dir", "Type", "Entry", "Exit", "R", "P&L", "Reason"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => {
                const rowKey = `${t.posId || t.ts || i}-${t.sym}`;
                const isOpen = expanded.has(rowKey);
                const toggle = () => {
                  const next = new Set(expanded);
                  if (isOpen) next.delete(rowKey);
                  else next.add(rowKey);
                  setExpanded(next);
                };
                const pnlColor = (t.brokerPnl ?? t.enginePnl ?? 0) >= 0 ? "#22b89a" : "#cf5b5b";
                const rColor = (t.r ?? 0) >= 0 ? "#22b89a" : "#cf5b5b";
                return (
                  <Fragment key={rowKey}>
                    <tr
                      onClick={toggle}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } }}
                      aria-expanded={isOpen}
                      style={{
                        borderBottom: isOpen ? "none" : "1px solid #1a1a26",
                        cursor: "pointer",
                        background: isOpen ? "#22222e44" : "transparent",
                        transition: "background 0.15s",
                      }}
                      onMouseEnter={(ev) => { if (!isOpen) ev.currentTarget.style.background = "#22222e22"; }}
                      onMouseLeave={(ev) => { if (!isOpen) ev.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={{ padding: "8px 6px 8px 10px", color: "#888", fontSize: 14, width: 24, textAlign: "center", userSelect: "none" }} aria-hidden>
                        {isOpen ? "▾" : "▸"}
                      </td>
                      <td style={{ padding: "8px 10px", color: "#888", fontSize: 11, whiteSpace: "nowrap" }}>{fmtTradeWhen(t.ts)}</td>
                      <td style={{ padding: "8px 10px", fontWeight: 600 }}>{t.sym || "—"}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <span style={{ color: t.dir === "bullish" || t.dir === "BUY" ? "#22b89a" : "#cf5b5b", fontSize: 12, fontWeight: 600 }}>
                          {(t.dir === "bullish" || t.dir === "BUY") ? "LONG" : "SHORT"}
                        </span>
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        {t.mode ? (
                          <span style={{ background: t.mode === "IBO" ? "#7eb4fa22" : "#a78bfa22", color: t.mode === "IBO" ? "#7eb4fa" : "#a78bfa", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{t.mode}</span>
                        ) : "—"}
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>{fmtPrice(t.entry)}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>{fmtPrice(t.exit)}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontWeight: 600, color: rColor }}>
                        {t.r != null ? `${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R` : "—"}
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontWeight: 600, color: pnlColor }}>
                        {(t.brokerPnl ?? t.enginePnl) != null ? `${(t.brokerPnl ?? t.enginePnl) >= 0 ? "+" : ""}$${(t.brokerPnl ?? t.enginePnl).toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "8px 10px", fontSize: 11, color: "#888" }}>{t.reason || "—"}</td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: "1px solid #1a1a26" }}>
                        <td colSpan={10} style={{ padding: 0 }}>
                          <div style={mob ? {
                            position: "sticky", left: 0,
                            width: "calc(100vw - 24px)",
                            maxWidth: "100%", boxSizing: "border-box",
                          } : undefined}>
                            <TradeDetailPanel trade={t} account={account} mob={mob} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Pagination — Prev/Next + jump-to-page chips for short histories,
            or just Prev/Next for very long ones. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderTop: "1px solid #1a1a26", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              style={pageBtn(safePage === 0)}
            >‹ Prev</button>
            {/* Page chips — render up to 7 around current; truncate with … if needed */}
            {paginationChips(totalPages, safePage).map((p, i) => p === "..."
              ? <span key={`gap-${i}`} style={{ color: "#555", fontSize: 11, padding: "0 4px" }}>…</span>
              : <button
                  key={p}
                  onClick={() => setPage(p)}
                  style={pageBtn(false, p === safePage)}
                >{p + 1}</button>
            )}
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage >= totalPages - 1}
              style={pageBtn(safePage >= totalPages - 1)}
            >Next ›</button>
          </div>
          <div style={{ fontSize: 10, color: "#555" }}>
            showing {start + 1}–{Math.min(start + PAGE_SIZE, allTrades.length)} of {allTrades.length}
          </div>
        </div>
      </div>
    </>
  );
}

const pageBtn = (disabled, active) => ({
  background: active ? "#22222e" : "transparent",
  color: disabled ? "#333" : active ? "#e0e0ea" : "#888",
  border: `1px solid ${active ? "#3a3a4e" : "#1a1a26"}`,
  borderRadius: 4,
  padding: "3px 9px",
  fontSize: 11,
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  minWidth: 28,
  textAlign: "center",
});

// Compute which page numbers to render in the chip strip. Returns an
// array of page indices and "..." separators. For ≤7 pages, show all.
// For more, show first/last + window of 5 around current.
function paginationChips(total, current) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const chips = [];
  chips.push(0);
  let start = Math.max(1, current - 2);
  let end = Math.min(total - 2, current + 2);
  if (start > 1) chips.push("...");
  for (let i = start; i <= end; i++) chips.push(i);
  if (end < total - 2) chips.push("...");
  chips.push(total - 1);
  return chips;
}

// Compact "when" formatter for the trade history row — keeps it readable
// on mobile by collapsing relative-time display.
function fmtTradeWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const now = Date.now();
  const ageMs = now - d.getTime();
  const ageHr = ageMs / 3_600_000;
  if (ageHr < 24) return d.toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (ageHr < 24 * 7) return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

/* ── trade detail panel (closed-trade dropdown content) ────────── */

function TradeDetailPanel({ trade, account, mob }) {
  const t = trade;

  // Lazy candle fetch — the bulk trade_history query intentionally omits
  // the `candles` JSONB to keep egress under control (~30 KB × 500 rows
  // = 15 MB saved per refresh × every browser tab × every 2 min). When
  // the user expands a row, fetch the candles for just this trade.
  // The result is cached in component state, so re-collapsing and re-
  // expanding the same row doesn't re-fetch.
  const [candles, setCandles] = useState(t.candles ?? null);
  const [candlesLoading, setCandlesLoading] = useState(false);
  useEffect(() => {
    if (!t.id) return;
    if (candles !== null) return; // already have them
    let cancelled = false;
    setCandlesLoading(true);
    supabase
      .from("trade_history")
      .select("candles")
      .eq("id", t.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn(`Failed to fetch candles for trade ${t.id}:`, error.message);
          setCandles({}); // sentinel — chart shows "no candle data" empty state
        } else {
          setCandles(data?.candles ?? {});
        }
      })
      .finally(() => { if (!cancelled) setCandlesLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id]);

  // Direction normalization — engine writes "bullish"/"bearish" in newer
  // rows but older history may carry "BUY"/"SELL".
  const dirNormal = t.dir === "bullish" || t.dir === "BUY" ? "bullish" : "bearish";

  // Original 1R distance — entry to original stop (or stopPrice as fallback).
  // Used to sanity-check the engine's r value and to size the Risk USD line.
  const oneR = t.entry != null && t.sl != null ? Math.abs(t.entry - t.sl) : null;

  // Convert exit_time / scan_time / entry_time to unix seconds for the
  // chart's focusTime + markers. If the engine isn't yet writing
  // entry_time, fall back to exit_time as the focus point.
  const tsExit = t.ts ? Math.floor(new Date(t.ts).getTime() / 1000) : null;
  const tsEntry = t.entryTime ? Math.floor(new Date(t.entryTime).getTime() / 1000) : null;
  const focusTs = tsEntry || tsExit;

  // Series markers for the chart — green/red dots at entry and exit.
  const markers = [];
  if (tsEntry) {
    markers.push({
      time: tsEntry,
      position: dirNormal === "bullish" ? "belowBar" : "aboveBar",
      color: "#7eb4fa",
      shape: dirNormal === "bullish" ? "arrowUp" : "arrowDown",
      text: "Entry",
    });
  }
  if (tsExit && tsExit !== tsEntry) {
    const winning = (t.r ?? 0) >= 0;
    markers.push({
      time: tsExit,
      position: dirNormal === "bullish" ? "aboveBar" : "belowBar",
      color: winning ? "#22b89a" : "#cf5b5b",
      shape: "circle",
      text: `Exit ${t.reason || ""}`.trim(),
    });
  }

  // Map trade to the chart's expected `entry` shape. Reuses watchlist
  // semantics: the field names match what SetupChart already reads.
  // candles come from the lazy-loaded state (above) rather than the
  // bulk-fetched trade row.
  const chartEntry = {
    symbol: t.sym,
    candles: candles,                  // from lazy-load useEffect
    direction: dirNormal,
    impulseStartPrice: t.impulseStartPrice,
    impulseEndPrice:   t.impulseEndPrice,
    stopPrice:         t.sl,
    targetPrice:       t.tp,
    fib786:            t.fib786,
    candidateBreakLevel: null,  // closed trades don't need a "break" line
  };

  // Time-held label
  let heldLabel = "—";
  if (t.barsHeld != null) {
    heldLabel = `${t.barsHeld} bars`;
  } else if (tsEntry && tsExit) {
    const min = Math.floor((tsExit - tsEntry) / 60);
    if (min >= 0) heldLabel = fmtAge(min);
  }

  // Section style mirrors the watchlist/position panels for consistency
  const sectionTitle = {
    fontSize: mob ? 9 : 10, fontWeight: 700, letterSpacing: 1.1,
    textTransform: "uppercase", color: "#888",
    margin: mob ? "0 0 6px" : "0 0 8px",
  };
  const fieldRow = {
    display: "grid",
    gridTemplateColumns: mob ? "minmax(90px,auto) 1fr" : "minmax(140px,auto) 1fr",
    gap: mob ? 6 : 8,
    padding: mob ? "2px 0" : "3px 0",
    fontSize: mob ? 10 : 12,
    lineHeight: mob ? 1.35 : 1.45,
  };
  const fieldLabel = { color: "#888" };
  const fieldVal = { color: "#e0e0ea", fontFamily: "'Space Grotesk', ui-monospace, monospace", wordBreak: "break-word" };
  const sectionBox = {
    background: "#0e0e15",
    borderRadius: mob ? 6 : 8,
    padding: mob ? "9px 10px" : "12px 14px",
    border: "1px solid #1a1a26",
    minWidth: 0,
  };
  const grid = {
    display: "grid",
    gridTemplateColumns: mob ? "1fr" : "1fr 1fr",
    gap: mob ? 8 : 10,
  };

  const winning = (t.r ?? 0) >= 0;
  const pnl = t.brokerPnl ?? t.enginePnl;

  return (
    <div style={{
      background: "#0a0a10",
      padding: mob ? "10px 8px" : "14px 16px",
      borderTop: "1px solid #1a1a26",
      borderBottom: "1px solid #1a1a26",
    }}>
      {/* Chart — focus on entry, mark entry + exit. Candles are lazy-
          loaded above; show a tiny "fetching candles" hint while the
          on-demand request is in flight. */}
      <div style={{ marginBottom: mob ? 10 : 12 }}>
        <Suspense fallback={
          <div style={{
            background: "#0e0e15", borderRadius: mob ? 6 : 8, border: "1px solid #1a1a26",
            padding: 16, textAlign: "center", color: "#555", fontSize: 11, fontStyle: "italic",
          }}>Loading chart…</div>
        }>
          <SetupChart
            entry={chartEntry}
            height={mob ? 220 : 280}
            focusTime={focusTs}
            markers={markers}
          />
        </Suspense>
        {candlesLoading && (
          <div style={{
            marginTop: 4, fontSize: 10, color: "#555", textAlign: "right",
            fontStyle: "italic",
          }}>fetching candles…</div>
        )}
      </div>

      <div style={grid}>
        {/* SETUP */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Setup</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Type</span>
            <span style={fieldVal}>
              {t.mode || "—"} {t.mode && (t.mode === "IBO" ? "(breakout)" : "(continuation)")}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Direction</span>
            <span style={{ ...fieldVal, color: dirNormal === "bullish" ? "#22b89a" : "#cf5b5b" }}>
              {dirNormal}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Quality score</span>
            <span style={fieldVal}>
              {t.score != null ? `${(t.score * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Pullback depth</span>
            <span style={fieldVal}>{t.pullbackDepth != null ? `${(t.pullbackDepth * 100).toFixed(1)}%` : "—"}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>ATR multiple</span>
            <span style={fieldVal}>{t.atrMultiple != null ? `${t.atrMultiple.toFixed(2)}×` : "—"}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Consistency</span>
            <span style={fieldVal}>{t.consistency != null ? `${(t.consistency * 100).toFixed(1)}%` : "—"}</span>
          </div>
        </div>

        {/* ENTRY */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Entry</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Entry price</span>
            <span style={fieldVal}>{fmtPrice(t.entry)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Entry time</span>
            <span style={fieldVal}>
              {t.entryTime
                ? new Date(t.entryTime).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " PDT"
                : <span style={{ color: "#555", fontStyle: "italic" }}>—</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Stop</span>
            <span style={{ ...fieldVal, color: "#cf5b5b" }}>{fmtPrice(t.sl)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Target</span>
            <span style={{ ...fieldVal, color: "#22b89a" }}>{fmtPrice(t.tp)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>1R distance</span>
            <span style={fieldVal}>{oneR != null ? fmtPrice(oneR) : "—"}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Risk $</span>
            <span style={fieldVal}>{t.riskUsd ? fmtUsd(t.riskUsd) : "—"}</span>
          </div>
        </div>

        {/* EXIT */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Exit</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Exit price</span>
            <span style={fieldVal}>{fmtPrice(t.exit)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Exit time</span>
            <span style={fieldVal}>
              {t.ts
                ? new Date(t.ts).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " PDT"
                : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Reason</span>
            <span style={fieldVal}>{t.reason || "—"}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Time held</span>
            <span style={fieldVal}>{heldLabel}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>MFE</span>
            <span style={{ ...fieldVal, color: "#22b89a" }}>
              {t.mfeR != null ? `+${t.mfeR.toFixed(2)}R` : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>MAE</span>
            <span style={{ ...fieldVal, color: "#cf5b5b" }}>
              {t.maeR != null ? `${t.maeR.toFixed(2)}R` : "—"}
            </span>
          </div>
          {t.partialPrice != null && (
            <div style={fieldRow}>
              <span style={fieldLabel}>Partial exit</span>
              <span style={fieldVal}>
                {t.partialPct != null ? `${(t.partialPct * 100).toFixed(0)}% @ ` : ""}{fmtPrice(t.partialPrice)}
                {t.partialR != null && <span style={{ color: "#666", marginLeft: 6 }}>(+{t.partialR.toFixed(2)}R)</span>}
              </span>
            </div>
          )}
        </div>

        {/* RESULT */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Result</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Outcome</span>
            <span style={{ ...fieldVal, color: winning ? "#22b89a" : "#cf5b5b", fontWeight: 700, textTransform: "uppercase" }}>
              {t.outcome || "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Final R</span>
            <span style={{ ...fieldVal, color: winning ? "#22b89a" : "#cf5b5b", fontWeight: 700 }}>
              {t.r != null ? `${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R` : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>P&L</span>
            <span style={{ ...fieldVal, color: (pnl ?? 0) >= 0 ? "#22b89a" : "#cf5b5b", fontWeight: 700 }}>
              {pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"}
            </span>
          </div>
          {t.posId && (
            <div style={fieldRow}>
              <span style={fieldLabel}>Position ID</span>
              <span style={{ ...fieldVal, fontSize: mob ? 9 : 11, color: "#666" }}>{t.posId}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── watchlist setup-detail helpers ────────────────────────────── */

// Format a price with appropriate precision based on magnitude
const fmtPrice = (p) => {
  if (p == null || isNaN(p)) return "—";
  if (Math.abs(p) < 10) return p.toFixed(5);
  if (Math.abs(p) < 100) return p.toFixed(3);
  if (Math.abs(p) < 1000) return p.toFixed(2);
  return p.toFixed(2);
};

// Format USD with thousands separator
const fmtUsd = (n) => {
  if (n == null || isNaN(n)) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

// Format a percent (input 0-1 → "62.8%")
const fmtPct = (n, digits = 1) => {
  if (n == null || isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
};

// Compute Gate=100 ETA. The engine requires 100 M10 forward bars after
// scan_time before firing entries. 24/7 instruments accumulate bars
// continuously (16h 40min wall-clock). RTH stocks accumulate only during
// the 6.5h NYSE session (≈2.56 trading days).
//
// instType: forex | metal | commodity | crypto | index | stock
const computeGateEta = (scanTimeIso, instType) => {
  if (!scanTimeIso) return { ready: false, etaMs: null, label: "—" };
  const scanTime = new Date(scanTimeIso);
  if (isNaN(scanTime)) return { ready: false, etaMs: null, label: "—" };

  let etaTime;
  if (instType === "stock") {
    // RTH: 39 M10 bars per day (6.5h × 6 bars/h). 100 / 39 = 2.564 days.
    // Naive weekend-skip; ignore holidays for v1.
    const tradingDaysNeeded = 100 / 39;
    let cursor = new Date(scanTime.getTime());
    let daysAdded = 0;
    while (daysAdded < tradingDaysNeeded) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const remaining = tradingDaysNeeded - daysAdded;
        if (remaining >= 1) {
          daysAdded += 1;
        } else {
          // Add fractional day in minutes (390 RTH min/day × remaining)
          cursor.setUTCMinutes(cursor.getUTCMinutes() + Math.round(remaining * 390));
          daysAdded = tradingDaysNeeded;
        }
      }
    }
    etaTime = cursor;
  } else {
    // 24/7: 100 bars × 10 min = 1000 minutes after scan
    etaTime = new Date(scanTime.getTime() + 1000 * 60 * 1000);
  }

  const now = Date.now();
  const etaMs = etaTime.getTime() - now;
  const ready = etaMs <= 0;

  if (ready) {
    return { ready: true, etaMs, label: "GATE CLEAR — awaiting M10 break" };
  }

  const totalMin = Math.floor(etaMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  if (hours < 24) {
    return {
      ready: false,
      etaMs,
      label: `gate clears in ${hours}h ${mins}m`,
    };
  }

  // > 24h — show day + time
  const dayLabel = etaTime.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return { ready: false, etaMs, label: `gate clears ${dayLabel} PDT` };
};

// Heuristic instrument-class lookup when wl_json doesn't carry inst_type.
// Mirrors the engine's universe classification.
const inferInstType = (symbol) => {
  if (!symbol) return "forex";
  const s = symbol.toUpperCase();
  // Crypto suffix
  if (s.endsWith("USD") && /^(BTC|ETH|XBT|SOL|DOT|AVAX|LINK|DOGE|XRP|ADA|MATIC)/.test(s)) return "crypto";
  // Metals
  if (s.startsWith("XAU") || s.startsWith("XAG")) return "metal";
  // Oil & commodities
  if (/^(USO|UCO|BNO|CRUDE|BRENT|NATGAS)$/.test(s)) return "commodity";
  // Indices
  if (/^(SPX|NDX|DJI|RUT|US500|US100|US30|US2000|GER40|UK100|JP225|FRA40|EUR50|HK50|AUS200)/.test(s)) return "index";
  // Forex pairs (3+3 letters, no digits)
  if (/^[A-Z]{6}$/.test(s)) return "forex";
  // Default to stock
  return "stock";
};

/* ── projected fire-time stop (V2 pivot_half_fib variants) ────────
   Constants from engine/run_live.py:139-160. The engine recomputes
   the stop at M10 fire time as:
     offset = |fib_b - fib_a| × pivot_gap_fraction × |impulse_leg|
            = 0.118 × 0.5 × |impulse_leg|
            = 0.059 × |impulse_leg|
     projected_stop = pivot_proxy ∓ offset   (− for long, + for short)
   where pivot_proxy is the deepest point of the forming pullback.
   The watchlist stop_price is the looser classifier-time estimate;
   this projection approximates what the order will actually fire with. */

const PROJ_STOP_FIB_A = 0.382;
const PROJ_STOP_FIB_B = 0.500;
const PROJ_STOP_PIVOT_GAP_FRACTION = 0.5;
const PROJ_STOP_OFFSET_FRAC_OF_LEG =
  Math.abs(PROJ_STOP_FIB_B - PROJ_STOP_FIB_A) * PROJ_STOP_PIVOT_GAP_FRACTION; // 0.059

// Returns true if this account's variant uses the V2 pivot_half_fib
// stop-recomputation at fire time. Source of truth is the dashboard's
// VARIANT_CONFIG.stop_mode (kept in sync with the engine startup banner —
// see useSupabaseData.js line 33 comment). Match is permissive on the
// stop_mode string so spelling drift doesn't silently disable the
// projection.
function variantUsesPivotHalfFib(variantConfig) {
  const mode = (variantConfig?.stop_mode || "").toLowerCase();
  return /half[\s_-]?fib|pivot_half_fib/.test(mode);
}

// Compute the projected fire-time stop for a watchlist entry. Returns
// { projectedStop, pivotProxy, anchorSource } or null when:
//   - variant doesn't use pivot_half_fib
//   - impulse_leg is missing / NaN
//   - direction is missing
//   - no anchor candle data and no fib_786 fallback
// Pure function — no side effects, safe to call inline in render.
function computeProjectedStop(entry, variantConfig) {
  if (!variantUsesPivotHalfFib(variantConfig)) return null;
  if (entry?.impulseLeg == null || isNaN(entry.impulseLeg)) return null;
  if (!entry?.direction) return null;

  const offset = PROJ_STOP_OFFSET_FRAC_OF_LEG * Math.abs(entry.impulseLeg);

  // Anchor for "candles after impulse end" — publisher doesn't ship
  // impulse_end_ts as its own field, so use scan_time as proxy. The
  // H4 scan fires immediately after the bar that completed the impulse,
  // so any M10 candle with ts >= scan_time is part of the forming
  // pullback (or later). Acceptable approximation; if a future publisher
  // change adds impulse_end_ts, prefer it here.
  const anchorTs = entry.scanTime
    ? Math.floor(new Date(entry.scanTime).getTime() / 1000)
    : null;

  let pivotProxy = null;
  let anchorSource = null;
  const m10 = entry.candles?.m10;
  if (anchorTs != null && Array.isArray(m10) && m10.length > 0) {
    const pullback = m10.filter(c => c.t >= anchorTs);
    if (pullback.length > 0) {
      if (entry.direction === "bullish") {
        pivotProxy = Math.min(...pullback.map(c => c.l));
      } else {
        pivotProxy = Math.max(...pullback.map(c => c.h));
      }
      anchorSource = "m10_pullback";
    }
  }

  // Fallback: candles haven't extended past impulse_end yet (fresh
  // setup, or m10 not loaded) → use fib_786 as worst-case anchor.
  if (pivotProxy == null && entry.fib786 != null) {
    pivotProxy = entry.fib786;
    anchorSource = "fib_786_fallback";
  }
  if (pivotProxy == null) return null;

  // Cap: pullback already past fib_786 means the setup will invalidate
  // at the next scan. Pin pivot_proxy at fib_786 as the worst case;
  // engine will use the actual deepest low if it fires before invalid.
  if (entry.fib786 != null) {
    if (entry.direction === "bullish" && pivotProxy < entry.fib786) {
      pivotProxy = entry.fib786;
      anchorSource = "fib_786_capped";
    } else if (entry.direction === "bearish" && pivotProxy > entry.fib786) {
      pivotProxy = entry.fib786;
      anchorSource = "fib_786_capped";
    }
  }

  const projectedStop = entry.direction === "bullish"
    ? pivotProxy - offset
    : pivotProxy + offset;

  return { projectedStop, pivotProxy, offset, anchorSource };
}

/* ── watchlist setup-detail panel ──────────────────────────────── */

function WatchlistDetailPanel({ entry, account, mob }) {
  // Refresh every 30s so countdowns stay live (gate ETA, age)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const e = entry;
  const instType = e.instType || inferInstType(e.symbol);
  const gate = computeGateEta(e.scanTime, instType);

  // Risk per trade $: balance × engine RISK_PCT. Default to 0.80% (V2 PROD/Challenge).
  // Pull true value from the variant config when available.
  const riskPct = (account?.config?.risk_pct ?? 0.008);
  const balance = account?.meta?.currentBalance ?? account?.engineState?.balance ?? 100000;
  const riskUsd = balance * riskPct;

  // Resolve the break level — the price the M10 close must cross to
  // trigger entry. Three sources, in priority order:
  //   1. engine-computed candidate_break_level (precise, not yet wired)
  //   2. impulse_end_price (Impulse Continuation reference: the impulse
  //      extreme is the level the engine watches for re-break confirmation)
  //   3. null → render "calculating…"
  // Source 2 is a faithful approximation for IBO setups (the impulse high
  // for bullish, the impulse low for bearish). For CBO setups it's an
  // upper-bound estimate — the actual M10 pivot the engine fires on tends
  // to be at-or-inside this level, so RR computed here is a conservative
  // floor (real RR may be slightly higher).
  let brk = e.candidateBreakLevel;
  let brkSource = brk != null ? "engine" : null;
  if (brk == null && e.impulseEndPrice != null) {
    brk = e.impulseEndPrice;
    brkSource = "impulse_extreme";
  }

  // Compute RR ratio if we have break level + stop + target
  let rrRatio = null;
  if (brk != null && e.stopPrice != null && e.targetPrice != null) {
    const stopDist = Math.abs(brk - e.stopPrice);
    const targDist = Math.abs(e.targetPrice - brk);
    if (stopDist > 0) rrRatio = targDist / stopDist;
  }

  // Risk distance in $ from break to stop
  let breakToStop = null, breakToTarget = null;
  if (brk != null) {
    if (e.stopPrice != null) breakToStop = Math.abs(brk - e.stopPrice);
    if (e.targetPrice != null) breakToTarget = Math.abs(e.targetPrice - brk);
  }

  // Projected fire-time stop (V2 pivot_half_fib variants only — see
  // computeProjectedStop above for variant gating + algorithm).
  // The watchlist's stop_price is the looser classifier-time estimate;
  // the engine recomputes on M10 fire to a tighter pivot-anchored stop.
  // This projection approximates that fire-time value so the watchlist
  // preview matches the live geometry (was: a NZDJPY watchlist preview
  // suggested RR ~1.5 but the live position fired at RR > 5).
  const projection = computeProjectedStop(e, account?.config);
  const projStop = projection?.projectedStop ?? null;
  let projectedRR = null;
  if (projStop != null && brk != null && e.targetPrice != null) {
    const projStopDist = Math.abs(brk - projStop);
    const targDist = Math.abs(e.targetPrice - brk);
    if (projStopDist > 0) projectedRR = targDist / projStopDist;
  }
  // Show both classifier RR and projected RR side-by-side only when
  // they differ enough to matter; otherwise just the projected (more
  // accurate) value.
  const rrSpread = (rrRatio != null && projectedRR != null)
    ? Math.abs(projectedRR - rrRatio) : 0;
  const showBothRR = rrSpread > 0.5;

  // Setup age derived from scanTime to avoid clock skew
  let ageLabel = fmtAge(e.ageMinutes);
  if (e.scanTime) {
    const ageMin = Math.floor((Date.now() - new Date(e.scanTime).getTime()) / 60000);
    if (!isNaN(ageMin) && ageMin >= 0) ageLabel = fmtAge(ageMin);
  }

  // Section style helpers
  // Mobile uses smaller fonts that match the parent watchlist table
  // (the row text is 11–13px). Previously the detail panel was bigger
  // than its own row which felt jarring.
  const sectionTitle = {
    fontSize: mob ? 9 : 10,
    fontWeight: 700,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: "#888",
    margin: mob ? "0 0 6px" : "0 0 8px",
  };
  const fieldRow = {
    display: "grid",
    gridTemplateColumns: mob ? "minmax(90px,auto) 1fr" : "minmax(140px,auto) 1fr",
    gap: mob ? 6 : 8,
    padding: mob ? "2px 0" : "3px 0",
    fontSize: mob ? 10 : 12,
    lineHeight: mob ? 1.35 : 1.45,
  };
  const fieldLabel = { color: "#888" };
  const fieldVal = { color: "#e0e0ea", fontFamily: "'Space Grotesk', ui-monospace, monospace", wordBreak: "break-word" };
  const sectionBox = {
    background: "#0e0e15",
    borderRadius: mob ? 6 : 8,
    padding: mob ? "9px 10px" : "12px 14px",
    border: "1px solid #1a1a26",
    minWidth: 0,
  };
  const grid = {
    display: "grid",
    gridTemplateColumns: mob ? "1fr" : "1fr 1fr",
    gap: mob ? 8 : 10,
  };

  return (
    <div style={{
      background: "#0a0a10",
      padding: mob ? "10px 8px" : "14px 16px",
      borderTop: "1px solid #1a1a26",
      borderBottom: "1px solid #1a1a26",
    }}>
      {/* Chart (lazy-loaded) */}
      <div style={{ marginBottom: mob ? 10 : 12 }}>
        <Suspense fallback={
          <div style={{
            background: "#0e0e15", borderRadius: mob ? 6 : 8, border: "1px solid #1a1a26",
            padding: 16, textAlign: "center", color: "#555", fontSize: 11, fontStyle: "italic",
          }}>Loading chart…</div>
        }>
          {/* Augment the entry with the projected fire-time stop so
              SetupChart can render the amber "Proj. Stop" line. Pure
              addition — original entry untouched, classifier stopPrice
              still passed through. */}
          <SetupChart
            entry={projStop != null ? { ...entry, projectedStopPrice: projStop } : entry}
            height={mob ? 220 : 280}
          />
        </Suspense>
      </div>

      <div style={grid}>
        {/* TRIGGER */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Trigger</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>{e.direction === "bullish" ? "Break above" : "Break below"}</span>
            <span style={fieldVal}>
              {brk != null ? (
                <>
                  {fmtPrice(brk)}
                  {brkSource === "impulse_extreme" && (
                    <span style={{ color: "#666", marginLeft: 6, fontSize: 10, fontStyle: "italic" }}>
                      (≈ impulse extreme; precise pivot pending engine instrumentation)
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: "#555", fontStyle: "italic" }}>calculating…</span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Pivot price</span>
            <span style={fieldVal}>
              {e.candidatePivotPrice != null ? fmtPrice(e.candidatePivotPrice) : <span style={{ color: "#555", fontStyle: "italic" }}>—</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Direction</span>
            <span style={{ ...fieldVal, color: e.direction === "bullish" ? "#22b89a" : "#cf5b5b" }}>
              {e.direction === "bullish" ? "bullish" : "bearish"} ({e.setupType} {e.setupType === "IBO" ? "breakout" : "continuation"})
            </span>
          </div>
        </div>

        {/* RISK */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Risk (if entry fires at break)</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Stop {projStop != null && <span style={{ color: "#666", fontWeight: 400 }}>(classifier)</span>}</span>
            <span style={{ ...fieldVal, color: "#cf5b5b" }}>
              {fmtPrice(e.stopPrice)}
              {breakToStop != null && <span style={{ color: "#666", marginLeft: 6 }}>(−{fmtPrice(breakToStop)})</span>}
            </span>
          </div>
          {projStop != null && (
            <div style={fieldRow}>
              <span style={fieldLabel}>Stop <span style={{ color: "#f59e0b", fontWeight: 600 }}>(projected)</span></span>
              <span style={{ ...fieldVal, color: "#f59e0b" }}>
                {fmtPrice(projStop)}
                {brk != null && <span style={{ color: "#666", marginLeft: 6 }}>(−{fmtPrice(Math.abs(brk - projStop))})</span>}
              </span>
            </div>
          )}
          <div style={fieldRow}>
            <span style={fieldLabel}>Target</span>
            <span style={{ ...fieldVal, color: "#22b89a" }}>
              {fmtPrice(e.targetPrice)}
              {breakToTarget != null && <span style={{ color: "#666", marginLeft: 6 }}>(+{fmtPrice(breakToTarget)})</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>RR at entry</span>
            <span style={fieldVal}>
              {projectedRR != null ? (
                <>
                  <span style={{ color: "#f59e0b", fontWeight: 700 }}>{`${projectedRR.toFixed(2)} : 1`}</span>
                  {showBothRR && rrRatio != null && (
                    <span style={{ color: "#666", marginLeft: 6, fontSize: 10 }}>
                      (classifier: {rrRatio.toFixed(2)})
                    </span>
                  )}
                </>
              ) : rrRatio != null ? (
                <>
                  {`${rrRatio.toFixed(2)} : 1`}
                  {brkSource === "impulse_extreme" && (
                    <span style={{ color: "#666", marginLeft: 6, fontSize: 10, fontStyle: "italic" }}>(estimated)</span>
                  )}
                </>
              ) : (
                <span style={{ color: "#555", fontStyle: "italic" }}>needs break level</span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Risk per trade</span>
            <span style={fieldVal}>{fmtUsd(riskUsd)} <span style={{ color: "#666" }}>({(riskPct * 100).toFixed(2)}% of {fmtUsd(balance)})</span></span>
          </div>
          {projStop != null ? (
            <div style={{ fontSize: 10, color: "#666", marginTop: 6, fontStyle: "italic", lineHeight: 1.5 }}>
              Projected stop assumes engine fires from current pullback pivot
              ({projection.anchorSource === "fib_786_fallback" ? "fib 0.786 fallback — pullback hasn't formed yet" :
                projection.anchorSource === "fib_786_capped" ? "capped at fib 0.786; setup near invalidation" :
                "from M10 pullback low/high"}). Updates as new candles arrive.
            </div>
          ) : account?.config?.stop_mode && (
            <div style={{ fontSize: 10, color: "#555", marginTop: 6, fontStyle: "italic" }}>
              Note: V2 strategies may shift stop to pivot_half_fib at fire time.
            </div>
          )}
        </div>

        {/* IMPULSE */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Impulse (4H structure)</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Started at</span>
            <span style={fieldVal}>{fmtPrice(e.impulseStartPrice)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Ended at</span>
            <span style={fieldVal}>{fmtPrice(e.impulseEndPrice)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Leg size</span>
            <span style={fieldVal}>
              {e.impulseLeg != null ? fmtPrice(e.impulseLeg) : "—"}
              {e.atrMultiple != null && <span style={{ color: "#666", marginLeft: 6 }}>· {e.atrMultiple.toFixed(2)}× ATR</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Pullback depth</span>
            <span style={fieldVal}>{fmtPct(e.pullbackDepth)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Consistency</span>
            <span style={fieldVal}>{fmtPct(e.consistency)}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Fib 0.786</span>
            <span style={fieldVal}>{fmtPrice(e.fib786)}</span>
          </div>
        </div>

        {/* GATE */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Gate (when does it become tradable)</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Scan time</span>
            <span style={fieldVal}>
              {e.scanTime ? new Date(e.scanTime).toLocaleString("en-US", {
                timeZone: "America/Los_Angeles", month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: false,
              }) + " PDT" : "—"}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Age</span>
            <span style={fieldVal}>{ageLabel}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Bars used</span>
            <span style={fieldVal}>
              {e.barsElapsed ?? "—"} / {e.maxEntryBars ?? "—"}
              {e.barsRemaining != null && <span style={{ color: "#666", marginLeft: 6 }}>({e.barsRemaining} remaining)</span>}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Gate clears</span>
            <span style={{ ...fieldVal, color: gate.ready ? "#22b89a" : "#cfb95b" }}>{gate.label}</span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Inst type</span>
            <span style={fieldVal}>
              {instType}
              {!e.instType && <span style={{ color: "#555", marginLeft: 6, fontStyle: "italic" }}>(inferred)</span>}
            </span>
          </div>
        </div>

        {/* QUALITY */}
        <div style={sectionBox}>
          <div style={sectionTitle}>Quality</div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Score</span>
            <span style={{ ...fieldVal, color: e.qualityScore >= 0.6 ? "#22b89a" : e.qualityScore >= 0.5 ? "#cfb95b" : "#888" }}>
              {(e.qualityScore * 100).toFixed(1)}%
              {account?.config?.quality_gate != null && (
                <span style={{ color: "#666", marginLeft: 6 }}>(gate: {(account.config.quality_gate / 100).toFixed(2)})</span>
              )}
            </span>
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Status</span>
            <span style={fieldVal}>{e.status}</span>
          </div>
          {e.subScores && typeof e.subScores === "object" && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#666" }}>
              <div style={{ marginBottom: 4 }}>Sub-scores:</div>
              {Object.entries(e.subScores).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", paddingLeft: 8 }}>
                  <span>{k}</span>
                  <span style={{ fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>{typeof v === "number" ? v.toFixed(3) : String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── watchlist with priority queue ─────────────────────────────── */

function Watchlist({ account, mob }) {
  const [expanded, setExpanded] = useState(new Set());
  if (!account?.engineState) return null;
  const { watchlist: rawWatchlist, recentRemovals = [] } = account.engineState;

  // Sort by quality score descending — this is the priority queue.
  // When a position slot opens, the highest-scored entry fires first.
  const watchlist = [...rawWatchlist].sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

  // Symbols that already have open positions (can't double up)
  const openSymbols = new Set((account.openPositions || []).map(p => p.symbol));

  return (
    <>
      <SectionHeader>Entry Queue ({watchlist.length} waiting)</SectionHeader>

      {watchlist.length === 0 ? (
        <div style={{ background: "#13131c", borderRadius: 10, padding: 20, border: "1px solid #22222e", textAlign: "center", color: "#666", fontSize: 13 }}>
          No active watchlist entries — waiting for next H4 scan
        </div>
      ) : (
        <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  {["", "#", "Symbol", "Dir", "Type", "Stop", "Target", "Score", "Bars", "Age", "Pullback", "Status"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {watchlist.map((e, i) => {
                  const blocked = openSymbols.has(e.symbol);
                  const rowKey = `${e.symbol}-${e.scanTime || i}`;
                  const isOpen = expanded.has(rowKey);
                  const toggle = () => {
                    const next = new Set(expanded);
                    if (isOpen) next.delete(rowKey);
                    else next.add(rowKey);
                    setExpanded(next);
                  };
                  return (
                  <Fragment key={rowKey}>
                  <tr
                    key={`row-${rowKey}`}
                    onClick={toggle}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } }}
                    aria-expanded={isOpen}
                    style={{
                      borderBottom: isOpen ? "none" : "1px solid #1a1a26",
                      opacity: blocked ? 0.45 : 1,
                      cursor: "pointer",
                      background: isOpen ? "#22223344" : "transparent",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(ev) => { if (!isOpen) ev.currentTarget.style.background = "#22223322"; }}
                    onMouseLeave={(ev) => { if (!isOpen) ev.currentTarget.style.background = "transparent"; }}
                  >
                    <td style={{ padding: "8px 6px 8px 10px", color: "#888", fontSize: 14, width: 24, textAlign: "center", userSelect: "none" }} aria-hidden>
                      {isOpen ? "▾" : "▸"}
                    </td>
                    <td style={{ padding: "8px 10px", color: "#7eb4fa", fontWeight: 700, fontSize: 14 }}>{i + 1}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{e.symbol}{blocked ? " *" : ""}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ color: e.direction === "bullish" ? "#22b89a" : "#cf5b5b", fontSize: 12, fontWeight: 600 }}>
                        {e.direction === "bullish" ? "LONG" : "SHORT"}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ background: e.setupType === "IBO" ? "#7eb4fa22" : "#a78bfa22", color: e.setupType === "IBO" ? "#7eb4fa" : "#a78bfa", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                        {e.setupType}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#cf5b5b", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>{e.stopPrice != null ? e.stopPrice.toFixed(e.stopPrice < 10 ? 4 : 2) : "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#22b89a", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>{e.targetPrice != null ? e.targetPrice.toFixed(e.targetPrice < 10 ? 4 : 2) : "—"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ color: e.qualityScore >= 0.6 ? "#22b89a" : e.qualityScore >= 0.5 ? "#cfb95b" : "#888" }}>
                        {(e.qualityScore * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", fontFamily: "'Space Grotesk', ui-monospace, monospace", fontSize: 12 }}>
                      {e.barsElapsed}/{e.maxEntryBars}
                    </td>
                    <td style={{ padding: "8px 10px", fontSize: 12 }}>{fmtAge(e.ageMinutes)}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12 }}>{e.pullbackDepth != null ? `${(e.pullbackDepth * 100).toFixed(1)}%` : "—"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ background: blocked ? "#cf5b5b22" : "#cfb95b22", color: blocked ? "#cf5b5b" : "#cfb95b", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                        {blocked ? "BLOCKED" : e.status}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`detail-${rowKey}`} style={{ borderBottom: "1px solid #1a1a26" }}>
                      <td colSpan={12} style={{ padding: 0 }}>
                        {/* Mobile-only sticky to keep the detail panel
                            anchored at the visible viewport's left edge
                            even when the table itself overflows
                            horizontally. Same pattern as OpenPositions. */}
                        <div style={mob ? {
                          position: "sticky", left: 0,
                          width: "calc(100vw - 24px)",
                          maxWidth: "100%", boxSizing: "border-box",
                        } : undefined}>
                          <WatchlistDetailPanel entry={e} account={account} mob={mob} />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "6px 10px", borderTop: "1px solid #1a1a26", fontSize: 10, color: "#555", textAlign: "center" }}>
            Sorted by quality score (priority queue) · click any row for setup detail · * = symbol has open position (blocked)
          </div>
        </div>
      )}

      {/* Recent removals */}
      {recentRemovals.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "#888", margin: "0 0 8px" }}>Recent Removals</h3>
          <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #333" }}>
                    {["Symbol", "Type", "Dir", "Reason", "Time"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: "#666", fontWeight: 500, fontSize: 10, textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentRemovals.map((r, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1a1a26" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{r.symbol}</td>
                      <td style={{ padding: "6px 10px" }}>{r.setupType}</td>
                      <td style={{ padding: "6px 10px", color: r.direction === "bullish" ? "#22b89a" : "#cf5b5b" }}>
                        {r.direction === "bullish" ? "LONG" : "SHORT"}
                      </td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{
                          color: r.reason.includes("Stop hit") ? "#cf5b5b" : r.reason.includes("Expired") ? "#888" : "#cfb95b",
                        }}>{r.reason}</span>
                      </td>
                      <td style={{ padding: "6px 10px", color: "#666" }}>{fmtTime(r.time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── scan activity section (per-account) ─────────────────────── */

function ScanActivity({ account, mob }) {
  const [showAllH4, setShowAllH4] = useState(false);
  if (!account?.engineState) return null;

  const m10Scans = account.engineState.recentM10Scans || [];
  const h4Scans = account.h4Scans || [];

  const displayH4 = showAllH4 ? h4Scans : h4Scans.slice(-5);

  return (
    <>
      <SectionHeader>Scan Activity</SectionHeader>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 14 }}>
        {/* H4 Scans */}
        <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", padding: 14, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#ccc" }}>
              H4 Scans <span style={{ color: "#888", fontWeight: 400 }}>({account.engineState.h4Scans} total)</span>
            </h3>
            {h4Scans.length > 5 && (
              <button onClick={() => setShowAllH4(!showAllH4)} style={{
                background: "none", border: "1px solid #333", borderRadius: 4, color: "#888", fontSize: 11, cursor: "pointer", padding: "2px 8px",
              }}>{showAllH4 ? "Show less" : "Show all"}</button>
            )}
          </div>
          {h4Scans.length === 0 ? (
            // 2026-04-30: publisher now aggregates recent H4 scans from
            // logs/events/*.jsonl and pushes them via scan_activity.h4
            // (dict shape). An empty list here means the variant simply
            // hasn't completed an H4 scan in the last ~36h covered by the
            // log window — which is normal for a freshly-started variant
            // (e.g. Challenge waiting on its first scan post-launch).
            <div style={{ fontSize: 12, color: "#888", padding: "8px 4px", lineHeight: 1.5 }}>
              <div style={{ marginBottom: 6 }}>
                Total H4 scans completed:{" "}
                <span style={{ color: "#7eb4fa", fontWeight: 600 }}>
                  {account.engineState?.h4Scans ?? "—"}
                </span>
              </div>
              <div style={{ marginBottom: 6 }}>
                Next H4 scan:{" "}
                <span style={{ color: "#7eb4fa", fontWeight: 600 }}>
                  {account.engineState?.nextH4Scan
                    ? fmtScanTime(getNextH4Scan(account.engineState.nextH4Scan))
                    : "—"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 8 }}>
                Recent-scans list will populate after the next H4 scan
                completes (cTrader grid: 01 / 05 / 09 / 13 / 17 / 21 UTC).
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {displayH4.slice().reverse().map((scan, i) => (
                <div key={i} style={{ background: "#0e0e15", borderRadius: 6, padding: "8px 10px", border: "1px solid #1a1a26" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: scan.additions.length > 0 ? 6 : 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#e0e0ea" }}>
                      Scan #{scan.scanNumber}
                    </span>
                    <span style={{ fontSize: 11, color: "#666" }}>{scan.scanTime}</span>
                  </div>
                  {scan.additions.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {scan.additions.map((a, j) => (
                        <span key={j} style={{
                          fontSize: 10, padding: "2px 6px", borderRadius: 3,
                          background: a.setupType === "IBO" ? "#7eb4fa15" : "#a78bfa15",
                          color: a.setupType === "IBO" ? "#7eb4fa" : "#a78bfa",
                          border: `1px solid ${a.setupType === "IBO" ? "#7eb4fa22" : "#a78bfa22"}`,
                        }}>
                          {a.symbol} {a.direction === "buy" ? "L" : "S"} {a.setupType} ({(a.score * 100).toFixed(0)}%)
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#555" }}>No setups found</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* M10 Scans */}
        <div style={{ background: "#13131c", borderRadius: 10, border: "1px solid #22222e", padding: 14, minWidth: 0 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 10px", color: "#ccc" }}>
            M10 Entry Scans <span style={{ color: "#888", fontWeight: 400 }}>({account.engineState.m10Scans} total)</span>
          </h3>
          {m10Scans.length === 0 ? (
            <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: 12 }}>No M10 scans logged yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {m10Scans.slice().reverse().map((scan, i) => {
                const statusEntries = Object.entries(scan.watchlistStatus || {});
                return (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 10px", background: "#0e0e15", borderRadius: 6, border: "1px solid #1a1a26",
                    flexWrap: "wrap", gap: 6,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: scan.entriesTriggered > 0 ? "#22b89a" : "#333",
                        display: "inline-block",
                      }} />
                      <span style={{ fontSize: 11, color: "#888" }}>{fmtTime(scan.time)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {statusEntries.map(([sym, bars]) => (
                        <span key={sym} style={{ fontSize: 10, color: "#888", fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
                          {sym} <span style={{ color: "#7eb4fa" }}>{bars}</span>
                        </span>
                      ))}
                      {scan.entriesTriggered > 0 && (
                        <span style={{ fontSize: 10, color: "#22b89a", fontWeight: 600 }}>
                          {scan.entriesTriggered} ENTRY
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── trade performance section (per-account) ─────────────────── */

function TradePerformance({ account, mob }) {
  const [view, setView] = useState("equity");
  const [mode, setMode] = useState("All");
  const allTrades = account?.trades || [];
  const balanceCurve = account?.balanceCurve || [];     // TRUTH (cTrader snapshots)
  const engineEventCurve = account?.engineEventCurve || []; // ENGINE VIEW (JSONL)
  const hasTrades = allTrades.length > 0 || balanceCurve.length > 0;

  const allModes = useMemo(() => {
    if (allTrades.length === 0) return ["All"];
    const s = new Set(allTrades.map(t => t.mode));
    return ["All", ...Array.from(s).sort()];
  }, [allTrades]);

  const trades = useMemo(
    () => allTrades.length === 0 ? [] : mode === "All" ? allTrades : allTrades.filter(t => t.mode === mode),
    [mode, allTrades]
  );

  // Equity curve from cTrader balance snapshots (TRUTH).
  // Each point already carries `bal`, `eq`, `pnl`, `dd` from build-data.js.
  const equityData = useMemo(() => {
    if (balanceCurve.length === 0) return [];
    let peak = 100000;
    let maxDd = 0;
    return balanceCurve.map((s, i) => {
      if (s.bal > peak) peak = s.bal;
      const dd = peak > 0 ? ((peak - s.bal) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
      return {
        ...s,
        tn: i + 1,
        dd: Math.round(dd * 100) / 100,
        maxDd: Math.round(maxDd * 100) / 100,
        label: fmtSnapshotTime(s.ts),
      };
    });
  }, [balanceCurve]);

  // R-multiples chart still uses engine events (it's an R-stat view).
  // We label this as "engine view" in the UI.
  const rChartData = useMemo(() => {
    return engineEventCurve.map((e, i) => ({
      ...e,
      tn: i + 1,
      pnl: e.enginePnl,
      bal: e.engineBal,
    }));
  }, [engineEventCurve]);

  const monthlyData = useMemo(() => {
    if (equityData.length === 0) return [];
    // Group snapshots by month, taking PnL delta as the bar value and the
    // last snapshot's balance as the line.
    const byMonth = {};
    let prevBal = 100000;
    for (const t of equityData) {
      const m = t.d ? t.d.substring(0, 7) : "unknown";
      if (!byMonth[m]) byMonth[m] = { month: m, pnl: 0, snapshots: 0, bal: 0 };
      byMonth[m].pnl += (t.bal - prevBal);
      byMonth[m].snapshots++;
      byMonth[m].bal = t.bal;
      prevBal = t.bal;
    }
    return Object.values(byMonth).map(m => ({
      ...m,
      month: m.month.length >= 7 ? months[parseInt(m.month.substring(5, 7)) - 1] + " " + m.month.substring(0, 4) : m.month,
      monthPnl: Math.round(m.pnl * 100) / 100,
    }));
  }, [equityData]);

  const tickIndices = useMemo(() => {
    const result = [];
    let lastMonth = "";
    equityData.forEach((d, i) => {
      const m = d.d ? d.d.substring(5, 7) : "";
      if (m && m !== lastMonth) { result.push(i); lastMonth = m; }
    });
    return result;
  }, [equityData]);

  const modeBreakdown = useMemo(() => {
    const byMode = {};
    for (const t of allTrades) {
      if (!byMode[t.mode]) byMode[t.mode] = [];
      byMode[t.mode].push(t);
    }
    return Object.entries(byMode).map(([m, ts]) => {
      const w = ts.filter(t => t.r > 0).length;
      const tR = Math.round(ts.reduce((s, t) => s + t.r, 0) * 100) / 100;
      return { mode: m, trades: ts.length, wins: w, wr: Math.round((w / ts.length) * 100), totalR: tR, avgR: Math.round((tR / ts.length) * 100) / 100, pf: pf(ts) };
    }).sort((a, b) => b.totalR - a.totalR);
  }, [allTrades]);

  const symbolBreakdown = useMemo(() => {
    const bySym = {};
    for (const t of trades) {
      if (!bySym[t.sym]) bySym[t.sym] = [];
      bySym[t.sym].push(t);
    }
    return Object.entries(bySym).map(([s, ts]) => {
      const w = ts.filter(t => t.r > 0).length;
      const tR = Math.round(ts.reduce((s2, t) => s2 + t.r, 0) * 100) / 100;
      return { sym: s, trades: ts.length, wins: w, wr: Math.round((w / ts.length) * 100), totalR: tR, avgR: Math.round((tR / ts.length) * 100) / 100 };
    }).sort((a, b) => b.totalR - a.totalR);
  }, [trades]);

  if (!hasTrades) {
    return (
      <>
        <SectionHeader>Trade Performance</SectionHeader>
        <div style={{ background: "#13131c", borderRadius: 10, padding: 20, border: "1px solid #22222e", textAlign: "center", color: "#666", fontSize: 13 }}>
          No closed trades yet for {account?.label || "this account"}
        </div>
      </>
    );
  }

  // Outcome-driven counts — backtest parity (run_validation_suite.py:310).
  // Denominator for WR is wins + losses only. Phantom (reconcile-race D-017),
  // timeout, breakeven, and unknown rows are excluded from BOTH numerator and
  // denominator, and surfaced via the Flagged count card below.
  const wins = trades.filter(t => t.outcome === "win").length;
  const losses = trades.filter(t => t.outcome === "loss").length;
  const breakevens = trades.filter(t => t.outcome === "breakeven").length;
  const flagged = trades.filter(t => t.outcome === "phantom"
                                   || t.outcome === "timeout"
                                   || t.outcome === "unknown").length;
  const denom = wins + losses;
  // totalR/avgR unchanged from prior semantics (null r_multiple coerces to 0 in +)
  const totalR = Math.round(trades.reduce((s, t) => s + t.r, 0) * 100) / 100;
  const avgR = trades.length ? Math.round((totalR / trades.length) * 100) / 100 : 0;
  const profitFactor = pf(trades);
  const winRate = denom ? Math.round((wins / denom) * 100) : 0;

  // Live $ figures: from cTrader balance directly (TRUTH).
  const finalBal = account.meta.currentBalance ?? 100000;
  const finalEq  = account.meta.currentEquity ?? finalBal;
  const startBal = account.meta.startBalance ?? 100000;
  const realizedPnl = account.meta.realizedPnl ?? 0;
  const openPnl = account.meta.openPnl ?? 0;
  const maxDD = account.meta.maxDD ?? 0;
  const maxDailyDD = account.meta.maxDailyDD ?? 0;

  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const w = trades[i].r > 0;
    if (i === trades.length - 1) { streak = w ? 1 : -1; continue; }
    if (w && streak > 0) streak++;
    else if (!w && streak < 0) streak--;
    else break;
  }

  const confLabel = trades.length >= 200 ? "Robust" : trades.length >= 50 ? "Moderate" : trades.length >= 20 ? "Early" : "Insufficient";
  const confColor = trades.length >= 200 ? "#22b89a" : trades.length >= 50 ? "#7eb4fa" : trades.length >= 20 ? "#cfb95b" : "#888";

  return (
    <>
      <SectionHeader>Trade Performance</SectionHeader>

      {/* Badges */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ background: confColor + "22", color: confColor, padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600, border: `1px solid ${confColor}44` }}>
          {confLabel} (N={trades.length})
        </span>
        <span style={{
          background: (streak > 0 ? "#22b89a" : "#cf5b5b") + "22",
          color: streak > 0 ? "#22b89a" : "#cf5b5b",
          padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600,
          border: `1px solid ${streak > 0 ? "#22b89a44" : "#cf5b5b44"}`,
        }}>
          Streak: {streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`}
        </span>
      </div>

      {/* Mode filter */}
      {allModes.length > 2 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {allModes.map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
              background: mode === m ? "#22b89a" : "#13131c", color: mode === m ? "#000" : "#888",
            }}>{m === "All" ? "All Modes" : m}</button>
          ))}
        </div>
      )}

      {/* Stat cards: Win Rate / Expectancy / PF are engine-view (R-based);
          Realized $ / Live Balance are TRUTH (cTrader). */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,minmax(0,1fr))" : "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 8 }}>
        <Card
          label="Realized P&L"
          value={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`}
          sub={`Truth: balance − $100k`}
          color={realizedPnl >= 0 ? "#22b89a" : "#cf5b5b"}
        />
        <Card
          label="Live Balance"
          value={`$${finalBal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Equity: $${finalEq.toLocaleString(undefined, { maximumFractionDigits: 2 })} (open ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)})`}
          color={finalBal >= 100000 ? "#22b89a" : "#cf5b5b"}
        />
        <Card
          label="Max Drawdown"
          value={`${maxDD}%`}
          sub={`Daily max: ${maxDailyDD}%`}
          color={maxDD < 10 ? "#22b89a" : "#cf5b5b"}
        />
        <Card
          label="Win Rate"
          value={denom > 0 ? `${winRate}%` : "—"}
          sub={denom > 0 ? `${denom} graded (${wins}W / ${losses}L)` : "No graded trades"}
          color={winRate >= 50 ? "#22b89a" : winRate > 0 ? "#cfb95b" : "#cf5b5b"}
        />
        <div
          title="Phantom closes + timeout exits + unknown-outcome rows excluded from WR denominator per backtest parity"
          style={{ background: "#13131c", borderRadius: 10, padding: 14, border: "1px solid #22222e", color: flagged > 0 ? "#cfb95b" : "#888" }}
        >
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Flagged</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>{flagged}</div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
            Phantom/timeout/unknown · BE: {breakevens}
          </div>
        </div>
        <Card
          label="Return"
          value={realizedPnl !== 0 ? `${realizedPnl >= 0 ? "+" : ""}${((realizedPnl / 100000) * 100).toFixed(2)}%` : "—"}
          sub="On $100k starting capital"
          color={realizedPnl >= 0 ? "#22b89a" : "#cf5b5b"}
        />
      </div>
      <div style={{ fontSize: 11, color: "#666", marginBottom: 16, lineHeight: 1.5 }}>
        All $ figures sourced from cTrader (authoritative). Win/loss from broker trade history.
        {totalR === null && " R-multiples pending (original risk data unavailable for historical trades)."}
      </div>

      {/* Chart tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {[["equity", "Equity Curve"], ["monthly", "Monthly P&L"], ["trades", "R-Multiples"]].map(([v, l]) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: "7px 18px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
            background: view === v ? "#22b89a" : "#13131c", color: view === v ? "#000" : "#888",
          }}>{l}</button>
        ))}
      </div>

      <div style={{ background: "#13131c", borderRadius: 12, border: "1px solid #22222e", padding: "16px 12px 6px" }}>
        {view === "equity" && (<>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, paddingLeft: 8 }}>
            Equity Curve — ${startBal.toLocaleString(undefined, { maximumFractionDigits: 2 })} → ${finalBal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
          {equityData.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#666", fontSize: 12 }}>
              No balance snapshots yet — equity curve will populate after the next dashboard rebuild
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={equityData}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22b89a" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#22b89a" stopOpacity={0.02} />
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                <XAxis
                  dataKey="tn"
                  tick={{ fontSize: 11, fill: "#666" }}
                  tickFormatter={v => { const t = equityData.find(d => d.tn === v); return t?.label || ""; }}
                />
                <YAxis tick={{ fontSize: 11, fill: "#666" }} domain={["auto", "auto"]} tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} />
                <Tooltip content={<Tip />} />
                <ReferenceLine y={100000} stroke="#555" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="bal" stroke="#22b89a" strokeWidth={1.5} fill="url(#g)" dot={equityData.length < 20 ? { r: 3, fill: "#22b89a" } : false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div style={{ fontSize: 11, color: "#555", textAlign: "center", marginTop: 4 }}>
            {equityData.length} cTrader balance snapshot{equityData.length !== 1 ? "s" : ""} · sourced from live account
            {account?.meta?.droppedSnapshots > 0 && (
              <span
                style={{ color: "#cfb95b", marginLeft: 6 }}
                title="Rows where balance is 0 or NULL. Excluded from chart + DD math. Upstream publisher/engine data-quality investigation pending."
              >
                · {account.meta.droppedSnapshots} malformed snapshot{account.meta.droppedSnapshots !== 1 ? "s" : ""} excluded
              </span>
            )}
            {account?.meta?.excludedIncidents > 0 && (
              <span
                style={{ color: "#cfb95b", marginLeft: 6 }}
                title="Rows inside a known-incident window (see EXCLUDED_INCIDENTS in useSupabaseData.js). Removed once upstream root cause is fixed and re-verified."
              >
                · {account.meta.excludedIncidents} row{account.meta.excludedIncidents !== 1 ? "s" : ""} excluded from known incident (2026-04-16 bridge overlap)
              </span>
            )}
          </div>
        </>)}

        {view === "monthly" && (<>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, paddingLeft: 8 }}>Monthly P&L</div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#999" }} />
              <YAxis yAxisId="pnl" tick={{ fontSize: 11, fill: "#666" }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
              <YAxis yAxisId="bal" orientation="right" tick={{ fontSize: 11, fill: "#666" }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<Tip />} />
              <Bar yAxisId="pnl" dataKey="pnl" radius={[4, 4, 0, 0]}>
                {monthlyData.map((m, i) => <Cell key={i} fill={m.pnl >= 0 ? "#22b89a" : "#cf5b5b"} fillOpacity={0.8} />)}
              </Bar>
              <Line yAxisId="bal" type="monotone" dataKey="bal" stroke="#7eb4fa" strokeWidth={2} dot={{ r: 3, fill: "#7eb4fa" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </>)}

        {view === "trades" && (<>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, paddingLeft: 8 }}>
            Trade R-Multiples — {rChartData.length} Events
          </div>
          <div style={{ fontSize: 11, color: "#cfb95b", marginBottom: 8, paddingLeft: 8 }}>
            Engine view — these R values are recorded by the strategy and may not reflect actual fills
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={rChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
              <XAxis dataKey="tn" tick={{ fontSize: 9, fill: "#555" }} interval={Math.max(1, Math.floor(rChartData.length / 12))} />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} domain={[-2, "auto"]} />
              <Tooltip content={<Tip />} />
              <ReferenceLine y={0} stroke="#555" />
              <Bar dataKey="r" maxBarSize={6}>
                {rChartData.map((d, i) => <Cell key={i} fill={d.r >= 0 ? "#22b89a" : "#cf5b5b"} fillOpacity={0.7} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>)}
      </div>

      {/* Mode breakdown */}
      {modeBreakdown.length > 1 && (
        <div style={{ background: "#13131c", borderRadius: 12, border: "1px solid #22222e", padding: 16, marginTop: 14 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px" }}>Performance by Entry Type</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  {["Mode", "Trades", "Win Rate", "Total R", "Avg R", "PF"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {modeBreakdown.map(m => (
                  <tr key={m.mode} style={{ borderBottom: "1px solid #1a1a26" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{m.mode}</td>
                    <td style={{ padding: "6px 8px" }}>{m.trades}</td>
                    <td style={{ padding: "6px 8px" }}>{m.wr}%</td>
                    <td style={{ padding: "6px 8px", color: m.totalR >= 0 ? "#22b89a" : "#cf5b5b" }}>{m.totalR > 0 ? "+" : ""}{m.totalR}</td>
                    <td style={{ padding: "6px 8px", color: m.avgR >= 0 ? "#22b89a" : "#cf5b5b" }}>{m.avgR > 0 ? "+" : ""}{m.avgR}</td>
                    <td style={{ padding: "6px 8px" }}>{m.pf === Infinity ? "\u221e" : m.pf.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Symbol breakdown */}
      {symbolBreakdown.length > 0 && (
        <div style={{ background: "#13131c", borderRadius: 12, border: "1px solid #22222e", padding: 16, marginTop: 14 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 10px" }}>Performance by Symbol</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  {["Symbol", "Trades", "Win Rate", "Total R", "Avg R"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbolBreakdown.map(s => (
                  <tr key={s.sym} style={{ borderBottom: "1px solid #1a1a26" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{s.sym}</td>
                    <td style={{ padding: "6px 8px" }}>{s.trades}</td>
                    <td style={{ padding: "6px 8px" }}>{s.wr}%</td>
                    <td style={{ padding: "6px 8px", color: s.totalR >= 0 ? "#22b89a" : "#cf5b5b" }}>{s.totalR > 0 ? "+" : ""}{s.totalR}</td>
                    <td style={{ padding: "6px 8px", color: s.avgR >= 0 ? "#22b89a" : "#cf5b5b" }}>{s.avgR > 0 ? "+" : ""}{s.avgR}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/* ── account view (wraps all 4 sections) ─────────────────────── */

function AccountView({ account, mob, lastUpdated, refetch }) {
  if (!account) return null;
  return (
    <>
      {/* Account header */}
      <div style={{
        background: "#13131c",
        border: `1px solid ${account.color}44`,
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: account.color, display: "inline-block", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, overflowWrap: "break-word" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{account.fullLabel}</div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
            Account #{account.accountId} · Gate {account.config?.quality_gate} ·
            Delay {account.config?.entry_delay_bars}b ·
            Partial {account.config?.partial_pct ? `${(account.config.partial_pct * 100).toFixed(0)}%` : "—"}@{account.config?.partial_trigger_r}R ·
            Ranking: {account.config?.ranking_method}
          </div>
        </div>
        <StatusPill status={account.status} />
      </div>

      <ErrorBoundary label="Engine Status"><EngineStatus account={account} mob={mob} lastUpdated={lastUpdated} refetch={refetch} /></ErrorBoundary>
      <ErrorBoundary label="Open Positions"><OpenPositions account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Watchlist"><Watchlist account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Trade History"><TradeHistory account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Scan Activity"><ScanActivity account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Trade Performance"><TradePerformance account={account} mob={mob} /></ErrorBoundary>
    </>
  );
}

/* ── main ────────────────────────────────────────────────────── */

export default function App() {
  const mob = useIsMobile();
  const [activeTab, setActiveTab] = useState("main");
  const { accounts: ACCOUNTS, loading, lastUpdated: LAST_UPDATED, error, ACCOUNT_KEYS, refetch } = useSupabaseData();
  // Trade alert hook — diffs each Supabase poll, emits browser
  // notifications + in-page toasts + sound for entries / modifies / closes
  const alerts = useTradeAlerts(ACCOUNTS);

  if (loading) {
    return (
      <div style={{ background: "#0b0b0f", color: "#888", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Urbanist', system-ui, sans-serif" }}>
        Loading dashboard data...
      </div>
    );
  }

  if (error || !ACCOUNTS) {
    return (
      <div style={{ background: "#0b0b0f", color: "#cf5b5b", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Urbanist', system-ui, sans-serif" }}>
        Failed to load data: {error || "No data available"}
      </div>
    );
  }

  const isMain = activeTab === "main";
  const currentAccount = isMain ? null : ACCOUNTS[activeTab];

  return (
    <div style={{ background: "#0b0b0f", color: "#e0e0ea", minHeight: "100vh", padding: mob ? "12px" : "20px", fontFamily: "'Urbanist', system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header — title gradient + alert bell */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{
              fontSize: mob ? 20 : 26,
              fontWeight: 800,
              margin: 0,
              letterSpacing: -0.5,
              background: "linear-gradient(135deg,#2a9daf,#22b89a,#3cc78a)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              FTMO V4 — Multi-Variant Dashboard
            </h1>
            <p style={{ color: "#777", margin: "4px 0 14px", fontSize: 13 }}>
              Production + Challenge + 4 strategy variants · Live cTrader demo accounts
            </p>
          </div>
          <AlertCenter
            events={alerts.events}
            unread={alerts.unread}
            settings={alerts.settings}
            setSettings={alerts.setSettings}
            permission={alerts.permission}
            requestPermission={alerts.requestPermission}
            markAllRead={alerts.markAllRead}
            clearEvents={alerts.clearEvents}
            mob={mob}
          />
        </div>

        {/* Tab navigation */}
        <TabBar activeTab={activeTab} onChange={setActiveTab} mob={mob} ACCOUNTS={ACCOUNTS} ACCOUNT_KEYS={ACCOUNT_KEYS} />

        {/* Content — wrapped so a render error in one section doesn't
            blow away the whole app (previously dropped to loading screen) */}
        <ErrorBoundary label={isMain ? "Main Dashboard" : `Account: ${currentAccount?.label || "?"}`}>
          {isMain
            ? <MainDashboard mob={mob} onSelectAccount={setActiveTab} ACCOUNTS={ACCOUNTS} ACCOUNT_KEYS={ACCOUNT_KEYS} />
            : <AccountView account={currentAccount} mob={mob} lastUpdated={LAST_UPDATED} refetch={refetch} />
          }
        </ErrorBoundary>

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 24, padding: "12px 0", fontSize: 11, color: "#555", borderTop: "1px solid #13131c" }}>
          FTMO V4 Engine · Data snapshot: {LAST_UPDATED ? new Date(LAST_UPDATED).toLocaleString() : "—"}
        </div>
      </div>
    </div>
  );
}
