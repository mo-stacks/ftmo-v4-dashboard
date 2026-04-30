import { useState, useMemo, useEffect, Component } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, BarChart, Bar, Cell, ReferenceLine, ComposedChart, Line, LineChart, Legend,
} from "recharts";
import { useSupabaseData } from "./useSupabaseData.js";
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
          border: "1px solid #f87171",
          borderRadius: 10,
          padding: 16,
          margin: "12px 0",
          color: "#fca5a5",
          fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "#f87171" }}>
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
    <div style={{ background: "#1a1a2e", border: "1px solid #444", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#e0e0e0", maxWidth: 260 }}>
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
              background: isPartial ? "#facc1522" : "#60a5fa22",
              color: isPartial ? "#facc15" : "#60a5fa",
            }}>{d.type}</span>
          )}
        </div>
      )}
      {d.month && <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.month}</div>}
      {d.bal !== undefined && <div>Balance: <span style={{ color: "#4ade80" }}>${d.bal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.eq !== undefined && d.eq !== d.bal && <div>Equity: <span style={{ color: "#60a5fa" }}>${d.eq.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.pnl !== undefined && d.tn === undefined && <div>P&L vs $100k: <span style={{ color: d.pnl >= 0 ? "#4ade80" : "#f87171" }}>{d.pnl >= 0 ? "+" : ""}${d.pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
      {d.enginePnl !== undefined && <div style={{ color: "#888", fontSize: 11 }}>Engine claimed: {d.enginePnl >= 0 ? "+" : ""}${d.enginePnl.toFixed(2)}</div>}
      {d.sym && <div>{d.sym}{d.mode ? ` ${d.mode}` : ""} — {d.r > 0 ? "+" : ""}{d.r}R</div>}
      {d.reason && <div style={{ color: "#888", fontSize: 11 }}>Exit: {d.reason}</div>}
      {d.trades && <div>{d.trades} events | {d.wr}% WR</div>}
      {d.monthPnl !== undefined && <div>Month P&L: <span style={{ color: d.monthPnl >= 0 ? "#4ade80" : "#f87171" }}>${d.monthPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>}
    </div>
  );
};

/* ── stat card ───────────────────────────────────────────────── */

const Card = ({ label, value, sub, color = "#4ade80" }) => (
  <div style={{ background: "#1a1a2e", borderRadius: 10, padding: "14px 16px", border: "1px solid #2a2a3e" }}>
    <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 3 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{sub}</div>}
  </div>
);

/* ── section header ──────────────────────────────────────────── */

const SectionHeader = ({ children }) => (
  <h2 style={{ fontSize: 16, fontWeight: 700, margin: "24px 0 12px", color: "#fff", borderBottom: "1px solid #2a2a3e", paddingBottom: 8 }}>
    {children}
  </h2>
);

/* ── status pill ─────────────────────────────────────────────── */

const StatusPill = ({ status }) => {
  const map = {
    ACTIVE:  { bg: "#4ade8022", fg: "#4ade80", border: "#4ade8044" },
    PAUSED:  { bg: "#f8717122", fg: "#f87171", border: "#f8717144" },
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
      borderBottom: "1px solid #2a2a3e", paddingBottom: 12,
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
              border: isActive ? `1px solid ${t.color}66` : "1px solid #2a2a3e",
              background: isActive ? `${t.color}22` : "#1a1a2e",
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
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,1fr)" : "repeat(6,1fr)", gap: 10, marginBottom: 20 }}>
        <Card label="Active Accounts" value={`${totals.activeCount} / ${accounts.length}`} sub="Engines running" color="#4ade80" />
        <Card
          label="Total Equity"
          value={`$${totals.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Across ${accounts.length} accounts`}
          color="#60a5fa"
        />
        <Card
          label="Total Closes"
          value={totals.totalTrades}
          sub={`Realized: ${totals.totalRealized >= 0 ? "+" : ""}$${totals.totalRealized.toFixed(2)}`}
          color="#c084fc"
        />
        <Card label="Watchlist" value={totals.totalWatchlist} sub="Active setups" color="#facc15" />
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
          color="#38bdf8"
        />
        <Card
          label="Best / Worst"
          value={bestVariant}
          sub={worstVariant !== "—" ? `Worst: ${worstVariant}` : "Need more data"}
          color="#4ade80"
        />
      </div>

      {/* Per-account performance table */}
      <SectionHeader>Account Performance</SectionHeader>
      <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", overflow: "hidden", marginBottom: 14 }}>
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
                      borderBottom: "1px solid #1f1f2f",
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
                    <td style={{ padding: "10px 12px", color: "#e0e0e0", fontFamily: "monospace" }}>
                      ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ padding: "10px 12px", color: equity >= balance ? "#4ade80" : "#f87171", fontFamily: "monospace" }}>
                      ${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ padding: "10px 12px", color: openPnl >= 0 ? "#4ade80" : "#f87171", fontFamily: "monospace" }}>
                      {openPnl >= 0 ? "+" : ""}${openPnl.toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 12px", color: realized >= 0 ? "#4ade80" : "#f87171", fontFamily: "monospace", fontWeight: 600 }}>
                      {realized >= 0 ? "+" : ""}${realized.toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 12px", color: dayPnl == null ? "#555" : dayPnl >= 0 ? "#4ade80" : "#f87171", fontFamily: "monospace" }}>
                      {dayPnl == null ? "—" : `${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {a.meta.totalTrades}
                      {a.meta.partialCount > 0 && (
                        <span style={{ fontSize: 10, color: "#facc15", marginLeft: 4 }}>+{a.meta.partialCount}p</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", color: a.meta.maxDD < 5 ? "#4ade80" : a.meta.maxDD < 10 ? "#facc15" : "#f87171" }}>
                      {a.meta.maxDD > 0 ? `${a.meta.maxDD}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 12px", borderTop: "1px solid #1f1f2f", fontSize: 11, color: "#555", textAlign: "center" }}>
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
      <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", overflow: "hidden", marginBottom: 14 }}>
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
                const trailColor = trailIsOff ? "#888" : "#facc15";
                // Account type + target: Challenge gets a tinted badge so it
                // stands out against the demo rows. Production = FTMO Free
                // Demo (also tinted, lighter) since it's the V2/Plan-A/B/C
                // reference. Spotware demos are neutral.
                const isChallenge = c.account_type?.includes("Challenge");
                const isProduction = c.account_type?.includes("FTMO Free");
                const acctColor = isChallenge ? "#fb923c" : isProduction ? "#4ade80" : "#888";
                return (
                  <tr key={a.key} style={{ borderBottom: "1px solid #1f1f2f" }}>
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
                    <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>{c.quality_gate ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>{partialStr}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: "#aaa" }}>{c.be_move ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", color: "#4ade80" }}
                        title="Phase 1 fleet-wide RISK_PCT (engine constant)">
                      {riskStr}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", color: "#60a5fa" }}>{c.stop_mode ?? "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", color: trailColor }}>{c.trail ?? "—"}</td>
                    <td style={{ padding: "10px 12px", color: "#aaa", fontSize: 11 }}>{c.universe_filter ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 12px", borderTop: "1px solid #1f1f2f", fontSize: 11, color: "#555", textAlign: "center" }}>
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
                  background: chartMode === v ? "#4ade80" : "#1a1a2e",
                  color: chartMode === v ? "#000" : "#888",
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div style={{ background: "#1a1a2e", borderRadius: 12, border: "1px solid #2a2a3e", padding: "16px 12px 6px", marginBottom: 14 }}>
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
                      <div style={{ background: "#1a1a2e", border: "1px solid #444", borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
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

function EngineStatus({ account, mob }) {
  if (!account?.engineState) {
    return (
      <>
        <SectionHeader>Engine Status</SectionHeader>
        <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 20, border: "1px solid #2a2a3e", textAlign: "center", color: "#666", fontSize: 13 }}>
          No engine state available for {account?.label || "this account"}
        </div>
      </>
    );
  }
  const s = account.engineState;

  const trailingDdUsed = s.highestEodBalance - s.trailingDdFloor;
  const trailingDdPct = trailingDdUsed > 0 ? ((s.highestEodBalance - s.equity) / trailingDdUsed * 100).toFixed(1) : "0";
  const dailyDdPct = s.dailyDdLimit > 0 ? ((s.dailyLoss / s.dailyDdLimit) * 100).toFixed(1) : "0";

  return (
    <>
      <SectionHeader>Engine Status</SectionHeader>

      {/* Status indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: s.tradingPaused ? "#f8717122" : "#4ade8022",
          color: s.tradingPaused ? "#f87171" : "#4ade80",
          padding: "4px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600,
          border: `1px solid ${s.tradingPaused ? "#f8717144" : "#4ade8044"}`,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {s.tradingPaused ? "TRADING PAUSED" : "ACTIVE"}
        </span>
        <span style={{ fontSize: 12, color: "#888" }}>
          Updated {timeAgo(s.updated)}
        </span>
        <span style={{ fontSize: 11, color: "#555" }}>
          ({fmtTime(s.updated)})
        </span>
      </div>

      {/* Next scan times */}
      {(() => {
        const nextH4 = getNextH4Scan(s.nextH4Scan);
        return (
          <div style={{ background: "#1a1a2e", borderRadius: 8, padding: "10px 14px", border: "1px solid #2a2a3e", marginBottom: 14, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Next H4 Scan:</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#60a5fa" }}>{fmtScanTime(nextH4)}</span>
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
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,1fr)" : "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
        <Card label="Balance" value={`$${s.balance.toLocaleString()}`} sub={`Day start: $${s.dayStartBalance.toLocaleString()}`} color="#60a5fa" />
        <Card label="Equity" value={`$${s.equity.toLocaleString()}`} sub={`P&L: $${(s.equity - s.dayStartBalance).toFixed(2)}`} color={s.equity >= s.dayStartBalance ? "#4ade80" : "#f87171"} />
        <Card label="Activity" value={`${s.h4Scans} / ${s.m10Scans}`} sub={`H4 scans / M10 scans`} color="#60a5fa" />
        <Card label="Trades Placed" value={s.tradesPlaced} sub="Since engine start" color="#c084fc" />
      </div>

      {/* Prop firm drawdown bars */}
      <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 16, border: "1px solid #2a2a3e" }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "#ccc" }}>Drawdown Limits</h3>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1fr 1fr", gap: 16 }}>
          {/* Daily DD */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "#888" }}>Daily Loss</span>
              <span style={{ color: parseFloat(dailyDdPct) > 80 ? "#f87171" : "#4ade80" }}>
                ${s.dailyLoss.toFixed(2)} / ${s.dailyDdLimit.toFixed(2)}
              </span>
            </div>
            <div style={{ background: "#222", borderRadius: 4, height: 8, overflow: "hidden" }}>
              <div style={{
                background: parseFloat(dailyDdPct) > 80 ? "#f87171" : parseFloat(dailyDdPct) > 50 ? "#facc15" : "#4ade80",
                height: "100%", width: `${Math.min(100, parseFloat(dailyDdPct))}%`, borderRadius: 4, transition: "width 0.3s",
              }} />
            </div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{dailyDdPct}% of daily limit used</div>
          </div>
          {/* Trailing DD */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "#888" }}>Trailing DD</span>
              <span style={{ color: parseFloat(trailingDdPct) > 80 ? "#f87171" : "#4ade80" }}>
                ${(s.highestEodBalance - s.equity).toFixed(2)} / ${trailingDdUsed.toFixed(2)}
              </span>
            </div>
            <div style={{ background: "#222", borderRadius: 4, height: 8, overflow: "hidden" }}>
              <div style={{
                background: parseFloat(trailingDdPct) > 80 ? "#f87171" : parseFloat(trailingDdPct) > 50 ? "#facc15" : "#4ade80",
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
  const positions = account?.openPositions || [];
  if (positions.length === 0) {
    return (
      <>
        <SectionHeader>Open Positions (0 / 5)</SectionHeader>
        <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 16, border: "1px solid #2a2a3e", textAlign: "center", color: "#666", fontSize: 13, marginBottom: 14 }}>
          No open positions — all slots available
        </div>
      </>
    );
  }
  return (
    <>
      <SectionHeader>Open Positions ({positions.length} / 5)</SectionHeader>
      <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", overflow: "hidden", marginBottom: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                {["Symbol", "Side", "Entry", "Unrealized P&L"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #1f1f2f" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>{p.symbol}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ color: p.side === "BUY" ? "#4ade80" : "#f87171", fontSize: 12, fontWeight: 600 }}>
                      {p.side}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>
                    {typeof p.entryPrice === "number" ? p.entryPrice.toFixed(p.entryPrice < 10 ? 4 : 2) : "—"}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", fontWeight: 600, color: (p.unrealizedPnl ?? 0) >= 0 ? "#4ade80" : "#f87171" }}>
                    {p.unrealizedPnl != null ? `${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "6px 10px", borderTop: "1px solid #1f1f2f", fontSize: 10, color: "#555", textAlign: "center" }}>
          {5 - positions.length} slot{5 - positions.length !== 1 ? "s" : ""} available for new entries
        </div>
      </div>
    </>
  );
}

/* ── watchlist with priority queue ─────────────────────────────── */

function Watchlist({ account, mob }) {
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
        <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 20, border: "1px solid #2a2a3e", textAlign: "center", color: "#666", fontSize: 13 }}>
          No active watchlist entries — waiting for next H4 scan
        </div>
      ) : (
        <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  {["#", "Symbol", "Dir", "Type", "Stop", "Target", "Score", "Bars", "Age", "Pullback", "Status"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 500, fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {watchlist.map((e, i) => {
                  const blocked = openSymbols.has(e.symbol);
                  return (
                  <tr key={i} style={{ borderBottom: "1px solid #1f1f2f", opacity: blocked ? 0.45 : 1 }}>
                    <td style={{ padding: "8px 10px", color: "#60a5fa", fontWeight: 700, fontSize: 14 }}>{i + 1}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{e.symbol}{blocked ? " *" : ""}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ color: e.direction === "bullish" ? "#4ade80" : "#f87171", fontSize: 12, fontWeight: 600 }}>
                        {e.direction === "bullish" ? "LONG" : "SHORT"}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ background: e.setupType === "IBO" ? "#60a5fa22" : "#c084fc22", color: e.setupType === "IBO" ? "#60a5fa" : "#c084fc", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                        {e.setupType}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#f87171", fontFamily: "monospace", fontSize: 12 }}>{e.stopPrice != null ? e.stopPrice.toFixed(e.stopPrice < 10 ? 4 : 2) : "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#4ade80", fontFamily: "monospace", fontSize: 12 }}>{e.targetPrice != null ? e.targetPrice.toFixed(e.targetPrice < 10 ? 4 : 2) : "—"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ color: e.qualityScore >= 0.6 ? "#4ade80" : e.qualityScore >= 0.5 ? "#facc15" : "#888" }}>
                        {(e.qualityScore * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>
                      {e.barsElapsed}/{e.maxEntryBars}
                    </td>
                    <td style={{ padding: "8px 10px", fontSize: 12 }}>{fmtAge(e.ageMinutes)}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12 }}>{e.pullbackDepth != null ? `${(e.pullbackDepth * 100).toFixed(1)}%` : "—"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ background: blocked ? "#f8717122" : "#facc1522", color: blocked ? "#f87171" : "#facc15", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                        {blocked ? "BLOCKED" : e.status}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "6px 10px", borderTop: "1px solid #1f1f2f", fontSize: 10, color: "#555", textAlign: "center" }}>
            Sorted by quality score (priority queue) · * = symbol has open position (blocked)
          </div>
        </div>
      )}

      {/* Recent removals */}
      {recentRemovals.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "#888", margin: "0 0 8px" }}>Recent Removals</h3>
          <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", overflow: "hidden" }}>
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
                    <tr key={i} style={{ borderBottom: "1px solid #1f1f2f" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{r.symbol}</td>
                      <td style={{ padding: "6px 10px" }}>{r.setupType}</td>
                      <td style={{ padding: "6px 10px", color: r.direction === "bullish" ? "#4ade80" : "#f87171" }}>
                        {r.direction === "bullish" ? "LONG" : "SHORT"}
                      </td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{
                          color: r.reason.includes("Stop hit") ? "#f87171" : r.reason.includes("Expired") ? "#888" : "#facc15",
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
        <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", padding: 14 }}>
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
                <span style={{ color: "#60a5fa", fontWeight: 600 }}>
                  {account.engineState?.h4Scans ?? "—"}
                </span>
              </div>
              <div style={{ marginBottom: 6 }}>
                Next H4 scan:{" "}
                <span style={{ color: "#60a5fa", fontWeight: 600 }}>
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
                <div key={i} style={{ background: "#12121f", borderRadius: 6, padding: "8px 10px", border: "1px solid #1f1f2f" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: scan.additions.length > 0 ? 6 : 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#e0e0e0" }}>
                      Scan #{scan.scanNumber}
                    </span>
                    <span style={{ fontSize: 11, color: "#666" }}>{scan.scanTime}</span>
                  </div>
                  {scan.additions.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {scan.additions.map((a, j) => (
                        <span key={j} style={{
                          fontSize: 10, padding: "2px 6px", borderRadius: 3,
                          background: a.setupType === "IBO" ? "#60a5fa15" : "#c084fc15",
                          color: a.setupType === "IBO" ? "#60a5fa" : "#c084fc",
                          border: `1px solid ${a.setupType === "IBO" ? "#60a5fa22" : "#c084fc22"}`,
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
        <div style={{ background: "#1a1a2e", borderRadius: 10, border: "1px solid #2a2a3e", padding: 14 }}>
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
                    padding: "6px 10px", background: "#12121f", borderRadius: 6, border: "1px solid #1f1f2f",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: scan.entriesTriggered > 0 ? "#4ade80" : "#333",
                        display: "inline-block",
                      }} />
                      <span style={{ fontSize: 11, color: "#888" }}>{fmtTime(scan.time)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {statusEntries.map(([sym, bars]) => (
                        <span key={sym} style={{ fontSize: 10, color: "#888", fontFamily: "monospace" }}>
                          {sym} <span style={{ color: "#60a5fa" }}>{bars}</span>
                        </span>
                      ))}
                      {scan.entriesTriggered > 0 && (
                        <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 600 }}>
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
        <div style={{ background: "#1a1a2e", borderRadius: 10, padding: 20, border: "1px solid #2a2a3e", textAlign: "center", color: "#666", fontSize: 13 }}>
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
  const confColor = trades.length >= 200 ? "#4ade80" : trades.length >= 50 ? "#60a5fa" : trades.length >= 20 ? "#facc15" : "#888";

  return (
    <>
      <SectionHeader>Trade Performance</SectionHeader>

      {/* Badges */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ background: confColor + "22", color: confColor, padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600, border: `1px solid ${confColor}44` }}>
          {confLabel} (N={trades.length})
        </span>
        <span style={{
          background: (streak > 0 ? "#4ade80" : "#f87171") + "22",
          color: streak > 0 ? "#4ade80" : "#f87171",
          padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600,
          border: `1px solid ${streak > 0 ? "#4ade8044" : "#f8717144"}`,
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
              background: mode === m ? "#4ade80" : "#1a1a2e", color: mode === m ? "#000" : "#888",
            }}>{m === "All" ? "All Modes" : m}</button>
          ))}
        </div>
      )}

      {/* Stat cards: Win Rate / Expectancy / PF are engine-view (R-based);
          Realized $ / Live Balance are TRUTH (cTrader). */}
      <div style={{ display: "grid", gridTemplateColumns: mob ? "repeat(2,1fr)" : "repeat(6,1fr)", gap: 10, marginBottom: 8 }}>
        <Card
          label="Realized P&L"
          value={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`}
          sub={`Truth: balance − $100k`}
          color={realizedPnl >= 0 ? "#4ade80" : "#f87171"}
        />
        <Card
          label="Live Balance"
          value={`$${finalBal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Equity: $${finalEq.toLocaleString(undefined, { maximumFractionDigits: 2 })} (open ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)})`}
          color={finalBal >= 100000 ? "#4ade80" : "#f87171"}
        />
        <Card
          label="Max Drawdown"
          value={`${maxDD}%`}
          sub={`Daily max: ${maxDailyDD}%`}
          color={maxDD < 10 ? "#4ade80" : "#f87171"}
        />
        <Card
          label="Win Rate"
          value={denom > 0 ? `${winRate}%` : "—"}
          sub={denom > 0 ? `${denom} graded (${wins}W / ${losses}L)` : "No graded trades"}
          color={winRate >= 50 ? "#4ade80" : winRate > 0 ? "#facc15" : "#f87171"}
        />
        <div
          title="Phantom closes + timeout exits + unknown-outcome rows excluded from WR denominator per backtest parity"
          style={{ background: "#1a1a2e", borderRadius: 10, padding: 14, border: "1px solid #2a2a3e", color: flagged > 0 ? "#facc15" : "#888" }}
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
          color={realizedPnl >= 0 ? "#4ade80" : "#f87171"}
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
            background: view === v ? "#4ade80" : "#1a1a2e", color: view === v ? "#000" : "#888",
          }}>{l}</button>
        ))}
      </div>

      <div style={{ background: "#1a1a2e", borderRadius: 12, border: "1px solid #2a2a3e", padding: "16px 12px 6px" }}>
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
                  <stop offset="0%" stopColor="#4ade80" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#4ade80" stopOpacity={0.02} />
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
                <Area type="monotone" dataKey="bal" stroke="#4ade80" strokeWidth={1.5} fill="url(#g)" dot={equityData.length < 20 ? { r: 3, fill: "#4ade80" } : false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div style={{ fontSize: 11, color: "#555", textAlign: "center", marginTop: 4 }}>
            {equityData.length} cTrader balance snapshot{equityData.length !== 1 ? "s" : ""} · sourced from live account
            {account?.meta?.droppedSnapshots > 0 && (
              <span
                style={{ color: "#facc15", marginLeft: 6 }}
                title="Rows where balance is 0 or NULL. Excluded from chart + DD math. Upstream publisher/engine data-quality investigation pending."
              >
                · {account.meta.droppedSnapshots} malformed snapshot{account.meta.droppedSnapshots !== 1 ? "s" : ""} excluded
              </span>
            )}
            {account?.meta?.excludedIncidents > 0 && (
              <span
                style={{ color: "#facc15", marginLeft: 6 }}
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
                {monthlyData.map((m, i) => <Cell key={i} fill={m.pnl >= 0 ? "#4ade80" : "#f87171"} fillOpacity={0.8} />)}
              </Bar>
              <Line yAxisId="bal" type="monotone" dataKey="bal" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3, fill: "#60a5fa" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </>)}

        {view === "trades" && (<>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, paddingLeft: 8 }}>
            Trade R-Multiples — {rChartData.length} Events
          </div>
          <div style={{ fontSize: 11, color: "#facc15", marginBottom: 8, paddingLeft: 8 }}>
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
                {rChartData.map((d, i) => <Cell key={i} fill={d.r >= 0 ? "#4ade80" : "#f87171"} fillOpacity={0.7} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>)}
      </div>

      {/* Mode breakdown */}
      {modeBreakdown.length > 1 && (
        <div style={{ background: "#1a1a2e", borderRadius: 12, border: "1px solid #2a2a3e", padding: 16, marginTop: 14 }}>
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
                  <tr key={m.mode} style={{ borderBottom: "1px solid #1f1f2f" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{m.mode}</td>
                    <td style={{ padding: "6px 8px" }}>{m.trades}</td>
                    <td style={{ padding: "6px 8px" }}>{m.wr}%</td>
                    <td style={{ padding: "6px 8px", color: m.totalR >= 0 ? "#4ade80" : "#f87171" }}>{m.totalR > 0 ? "+" : ""}{m.totalR}</td>
                    <td style={{ padding: "6px 8px", color: m.avgR >= 0 ? "#4ade80" : "#f87171" }}>{m.avgR > 0 ? "+" : ""}{m.avgR}</td>
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
        <div style={{ background: "#1a1a2e", borderRadius: 12, border: "1px solid #2a2a3e", padding: 16, marginTop: 14 }}>
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
                  <tr key={s.sym} style={{ borderBottom: "1px solid #1f1f2f" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{s.sym}</td>
                    <td style={{ padding: "6px 8px" }}>{s.trades}</td>
                    <td style={{ padding: "6px 8px" }}>{s.wr}%</td>
                    <td style={{ padding: "6px 8px", color: s.totalR >= 0 ? "#4ade80" : "#f87171" }}>{s.totalR > 0 ? "+" : ""}{s.totalR}</td>
                    <td style={{ padding: "6px 8px", color: s.avgR >= 0 ? "#4ade80" : "#f87171" }}>{s.avgR > 0 ? "+" : ""}{s.avgR}</td>
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

function AccountView({ account, mob }) {
  if (!account) return null;
  return (
    <>
      {/* Account header */}
      <div style={{
        background: "#1a1a2e",
        border: `1px solid ${account.color}44`,
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: account.color, display: "inline-block" }} />
        <div style={{ flex: 1 }}>
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

      <ErrorBoundary label="Engine Status"><EngineStatus account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Open Positions"><OpenPositions account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Watchlist"><Watchlist account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Scan Activity"><ScanActivity account={account} mob={mob} /></ErrorBoundary>
      <ErrorBoundary label="Trade Performance"><TradePerformance account={account} mob={mob} /></ErrorBoundary>
    </>
  );
}

/* ── main ────────────────────────────────────────────────────── */

export default function App() {
  const mob = useIsMobile();
  const [activeTab, setActiveTab] = useState("main");
  const { accounts: ACCOUNTS, loading, lastUpdated: LAST_UPDATED, error, ACCOUNT_KEYS } = useSupabaseData();

  if (loading) {
    return (
      <div style={{ background: "#0f0f1a", color: "#888", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
        Loading dashboard data...
      </div>
    );
  }

  if (error || !ACCOUNTS) {
    return (
      <div style={{ background: "#0f0f1a", color: "#f87171", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
        Failed to load data: {error || "No data available"}
      </div>
    );
  }

  const isMain = activeTab === "main";
  const currentAccount = isMain ? null : ACCOUNTS[activeTab];

  return (
    <div style={{ background: "#0f0f1a", color: "#e0e0e0", minHeight: "100vh", padding: mob ? "12px" : "20px", fontFamily: "system-ui,-apple-system,sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <h1 style={{ fontSize: mob ? 20 : 26, fontWeight: 700, margin: 0, color: "#fff" }}>
          FTMO V4 — Multi-Variant Dashboard
        </h1>
        <p style={{ color: "#888", margin: "4px 0 14px", fontSize: 13 }}>
          Production + Challenge + 4 strategy variants · Live cTrader demo accounts
        </p>

        {/* Tab navigation */}
        <TabBar activeTab={activeTab} onChange={setActiveTab} mob={mob} ACCOUNTS={ACCOUNTS} ACCOUNT_KEYS={ACCOUNT_KEYS} />

        {/* Content — wrapped so a render error in one section doesn't
            blow away the whole app (previously dropped to loading screen) */}
        <ErrorBoundary label={isMain ? "Main Dashboard" : `Account: ${currentAccount?.label || "?"}`}>
          {isMain
            ? <MainDashboard mob={mob} onSelectAccount={setActiveTab} ACCOUNTS={ACCOUNTS} ACCOUNT_KEYS={ACCOUNT_KEYS} />
            : <AccountView account={currentAccount} mob={mob} />
          }
        </ErrorBoundary>

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 24, padding: "12px 0", fontSize: 11, color: "#555", borderTop: "1px solid #1a1a2e" }}>
          FTMO V4 Engine · Data snapshot: {LAST_UPDATED ? new Date(LAST_UPDATED).toLocaleString() : "—"}
        </div>
      </div>
    </div>
  );
}
