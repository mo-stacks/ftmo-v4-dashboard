/**
 * Build script: reads FTMO V4 trade JSONL + engine state for ALL 5 accounts
 * (production + alpha/bravo/charlie/delta variants).
 *
 * Sources (per account, where {suffix} is "" for production, "_alpha" etc. for variants):
 *   1. /Users/mmmacbook/Projects/FTMO_V4/runs/shadow_metrics/shadow_trades{suffix}.jsonl
 *   2. /Users/mmmacbook/Projects/FTMO_V4/watchlist_state{suffix}.json
 *   3. /Users/mmmacbook/Projects/FTMO_V4/ibo_cbo_live{suffix}.log
 *
 * Output: src/tradeData.js  (imported by App.jsx at build time)
 *   - ACCOUNTS:  per-account dict { production: {...}, alpha: {...}, ... }
 *   - ACCOUNT_KEYS, ACCOUNT_LIST, LAST_UPDATED
 *   - Backward-compat: TRADES / META / ENGINE_STATE / H4_SCANS (production)
 *
 * Run: `node scripts/build-data.js`
 * Called automatically by `npm run build`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FTMO_ROOT = "/Users/mmmacbook/Projects/FTMO_V4";
const OUT_PATH = join(__dirname, "..", "src", "tradeData.js");
const HISTORY_PATH = join(__dirname, "..", "data", "balance_history.json");
const HISTORY_DIR = join(__dirname, "..", "data");

/* ── Quote currency mapping ───────────────────────────────────── */

const INDEX_QUOTE_CCY = {
  "JP225": "JPY", "JAPAN 225": "JPY",
  "GER40": "EUR", "GERMANY 40": "EUR",
  "UK100": "GBP", "UK 100": "GBP",
  // USD-quoted indices — no conversion needed
  "US30": "USD", "US 30": "USD", "US30.cash": "USD",
  "US500": "USD", "US 500": "USD", "US500.cash": "USD",
  "US100": "USD", "US TECH 100": "USD",
  "US2000": "USD",
};

const STOCK_SYMBOLS = new Set([
  "TSLA", "NVDA", "AMD", "META", "GOOG", "AMZN", "NFLX", "AAPL", "MSTR",
  "XOM", "DIS", "MA", "GS", "V", "CAT", "HD", "FDX",
  "GOLDMANSACHS", "VISA", "CATERPILLAR", "MASTERCARD", "HOMEDEPOT",
  "FEDEX", "WALTDISNEY", "EXXONMOBIL",
]);

function getQuoteCcy(symbol) {
  const clean = (symbol || "").replace("_", "").toUpperCase();
  if (INDEX_QUOTE_CCY[clean]) return INDEX_QUOTE_CCY[clean];
  if (INDEX_QUOTE_CCY[symbol]) return INDEX_QUOTE_CCY[symbol]; // exact match with spaces
  if (STOCK_SYMBOLS.has(clean)) return "USD";
  // Crypto: all USD-quoted (BTCUSD, ETHUSD, etc.)
  if (clean.endsWith("USD") && clean.length <= 8) return "USD";
  // Metals
  if (clean === "XAUUSD" || clean === "XAGUSD") return "USD";
  // Oil
  if (["USOIL", "WTI", "BRENT"].includes(clean)) return "USD";
  // Forex: last 3 chars = quote currency
  const alphaOnly = clean.replace(/[^A-Z]/g, "");
  if (alphaOnly.length === 6) return alphaOnly.slice(3);
  return "USD"; // fallback
}

/* ── FX rate cache ───────────────────────────────────────────── */

// Maps CCY → USD/CCY rate (how many CCY per 1 USD)
// For JPY: USDJPY ≈ 155 → divide by rate to get USD
// For EUR: 1/EURUSD ≈ 0.91 → divide by rate to get USD
// For GBP: 1/GBPUSD ≈ 0.77 → divide by rate to get USD
// For CHF: USDCHF ≈ 0.89 → divide by rate to get USD
const FX_RATE_SOURCES = {
  JPY: { symbol: "USDJPY", invert: false },
  CAD: { symbol: "USDCAD", invert: false },
  CHF: { symbol: "USDCHF", invert: false },
  GBP: { symbol: "GBPUSD", invert: true },
  EUR: { symbol: "EURUSD", invert: true },
  AUD: { symbol: "AUDUSD", invert: true },
  NZD: { symbol: "NZDUSD", invert: true },
};

// Fallback rates (used if bridge unavailable)
const FALLBACK_RATES = {
  JPY: 155, CAD: 1.38, CHF: 0.89, GBP: 0.77, EUR: 0.91, AUD: 1.54, NZD: 1.68,
};

let _fxRates = {}; // populated by fetchFxRates()

function fetchFxRates(bridgePort) {
  _fxRates = { ...FALLBACK_RATES };
  for (const [ccy, { symbol, invert }] of Object.entries(FX_RATE_SOURCES)) {
    try {
      const raw = execSync(
        `curl -s --max-time 5 "http://localhost:${bridgePort}/candles?symbol=${symbol}&period=H4&count=1"`,
        { encoding: "utf-8" }
      );
      const d = JSON.parse(raw);
      if (d.success && d.candles && d.candles.length > 0) {
        const close = d.candles[0].close || d.candles[0].c;
        if (close && close > 0) {
          _fxRates[ccy] = invert ? (1.0 / close) : close;
        }
      }
    } catch { /* keep fallback */ }
  }
  console.log("FX rates (USD/CCY):", Object.entries(_fxRates).map(([k,v]) => `${k}=${v.toFixed(4)}`).join(", "));
}

function convertToUsd(pnlInQuoteCcy, quoteCcy) {
  if (!quoteCcy || quoteCcy === "USD") return pnlInQuoteCcy;
  const rate = _fxRates[quoteCcy];
  if (!rate || rate <= 0) return pnlInQuoteCcy;
  return pnlInQuoteCcy / rate;
}

/* ── Bridge position fetcher ──────────────────────────────────── */
function fetchPositions(accountId, bridgePort) {
  try {
    const raw = execSync(
      `curl -s --max-time 8 "http://localhost:${bridgePort}/positions?accountId=${accountId}"`,
      { encoding: "utf-8" }
    );
    if (!raw || !raw.trim()) return [];
    const d = JSON.parse(raw);
    const positions = Array.isArray(d) ? d : (d.positions || []);
    return positions.map(p => {
      const symbol = p.symbolName || p.symbol || "?";
      const side = p.tradeSide || p.side || (p.direction === "long" ? "BUY" : "SELL") || "?";
      const entry = p.entryPrice || 0;
      const current = p.currentPrice || 0;
      const units = p.units || 0;
      const quoteCcy = getQuoteCcy(symbol);

      // Per-position P&L: prefer broker's unrealizedPnl (includes swaps +
      // commissions). Fall back to currency-converted computation for
      // non-USD instruments where the broker returns null.
      let pnlUsd = null;
      const brokerPnl = p.unrealizedPnl ?? p.pnl ?? null;
      if (brokerPnl != null) {
        pnlUsd = brokerPnl;
      } else if (entry > 0 && current > 0 && units > 0) {
        // Fallback: compute and convert for non-USD instruments
        const rawPnl = side === "SELL"
          ? (entry - current) * units
          : (current - entry) * units;
        pnlUsd = convertToUsd(rawPnl, quoteCcy);
      }

      return {
        symbol,
        side,
        entryPrice: entry,
        currentPrice: current,
        unrealizedPnl: pnlUsd != null ? Math.round(pnlUsd * 100) / 100 : null,
        quoteCcy: quoteCcy !== "USD" ? quoteCcy : undefined,
        positionId: p.positionId || p.id || "",
      };
    });
  } catch {
    return [];
  }
}
/* ── Bridge account fetcher ───────────────────────────────────── */
function fetchAccount(accountId, bridgePort) {
  try {
    const raw = execSync(
      `curl -s --max-time 8 "http://localhost:${bridgePort}/account?accountId=${accountId}"`,
      { encoding: "utf-8" }
    );
    if (!raw || !raw.trim()) return null;
    const d = JSON.parse(raw);
    if (!d.success || !d.account) return null;
    return {
      balance: d.account.balance || 0,
      equity: d.account.equity || d.account.balance || 0,
    };
  } catch {
    return null;
  }
}
const HISTORY_MAX_ENTRIES = 500;
const STARTING_BALANCE = 100000;

/* ── Account registry ───────────────────────────────────────── */

const ACCOUNTS = [
  {
    key: "production",
    label: "Production",
    fullLabel: "ICS V1 (Production)",
    suffix: "_ftmo_prod",
    accountId: "46992359",
    displayId: "17083057",  // cTrader frontend account number
    bridgePort: 3100,
    color: "#4ade80",
    config: {
      name: "ICS_PROD",
      quality_gate: 58,
      entry_delay_bars: 0,
      partial_trigger_r: 0.5,
      partial_pct: 0.30,
      ranking_method: "quality_score",
    },
  },
  {
    key: "alpha",
    label: "Alpha",
    fullLabel: "Alpha Variant",
    suffix: "_alpha",
    accountId: "46915262",
    displayId: "5797573",  // cTrader frontend account number
    bridgePort: 3101,
    color: "#60a5fa",
    config: {
      name: "ALPHA",
      quality_gate: 58,
      entry_delay_bars: 0,
      partial_trigger_r: 0.5,
      partial_pct: 0.30,
      ranking_method: "quality_score",
    },
  },
  {
    key: "bravo",
    label: "Bravo",
    fullLabel: "Bravo Variant",
    suffix: "_bravo",
    accountId: "46915271",
    displayId: "5797576",  // cTrader frontend account number
    bridgePort: 3101,
    color: "#c084fc",
    config: {
      name: "BRAVO",
      quality_gate: 58,
      entry_delay_bars: 0,
      partial_trigger_r: 0.5,
      partial_pct: 0.30,
      ranking_method: "quality_score",
      slot_mode: "risk_based",
      max_floating_risk_pct: 6.5,
    },
  },
  {
    key: "charlie",
    label: "Charlie",
    fullLabel: "Charlie Variant",
    suffix: "_charlie",
    accountId: "46915274",
    displayId: "5797577",  // cTrader frontend account number
    bridgePort: 3101,
    color: "#facc15",
    config: {
      name: "CHARLIE",
      quality_gate: 56,
      entry_delay_bars: 0,
      partial_trigger_r: 0.5,
      partial_pct: 0.40,
      ranking_method: "consistency",
    },
  },
  {
    key: "delta",
    label: "Delta",
    fullLabel: "Delta Variant",
    suffix: "_delta",
    accountId: "46915276",
    displayId: "5797579",  // cTrader frontend account number
    bridgePort: 3101,
    color: "#f87171",
    config: {
      name: "DELTA",
      quality_gate: 58,
      entry_delay_bars: 0,
      partial_trigger_r: 0.5,
      partial_pct: 0.30,
      ranking_method: "quality_score",
      slot_mode: "risk_based",
      max_floating_risk_pct: 6.5,
    },
  },
  {
    key: "challenge",
    label: "Challenge",
    fullLabel: "FTMO 2-Step Challenge (V2 + gate=100)",
    suffix: "_ftmo_challenge",
    accountId: "47142181",
    displayId: "7545753",  // FTMO trading login
    bridgePort: 3100,         // shared bridge with production (multi-account; demo.ctraderapi.com host)
    color: "#fb923c",         // orange — distinct from production green
    config: {
      name: "FTMO_CHALLENGE",
      quality_gate: 58,
      entry_delay_bars: 0,
      partial_trigger_r: 0.6,        // D3 (Plan A 2026-04-27)
      partial_pct: 0.20,             // D3
      be_decouple_r: 1.0,            // D2 (Plan C 2026-04-27)
      ranking_method: "quality_score",
      slot_mode: "risk_based",
      max_floating_risk_pct: 4.5,
      max_positions_hard_cap: 15,
      entry_search_h4_confirmation_bars: 1,  // Phase 5 ON
      stop_mode: "pivot_half_fib",
      trailing_enabled: false,
      // 2026-04-30 deploy-wide engine const (applies to all variants):
      // search_start_gate=100 (was -5) — engine-validator gate for entry detection
    },
  },
];

/* ── Trade data (per account) ───────────────────────────────── */

/**
 * IMPORTANT: The engine's r_multiple values in shadow_trades*.jsonl are
 * UNRELIABLE — they don't match the actual cTrader balance. This loader
 * returns the events for display purposes only. $ PnL is derived from the
 * cTrader balance directly (see buildAccountData).
 *
 * Returns:
 *   closes:         list of CLOSE events (each is a "trade" for stats)
 *   engineEvents:   chronological list of CLOSE + PARTIAL events as the
 *                   engine recorded them (used for engine-view trade list)
 */
function loadTrades(suffix, label) {
  const jsonlPath = `${FTMO_ROOT}/runs/shadow_metrics/shadow_trades${suffix}.jsonl`;
  if (!existsSync(jsonlPath)) {
    console.log(`  [${label}] No JSONL at ${jsonlPath}`);
    return { closes: [], engineEvents: [] };
  }

  const lines = readFileSync(jsonlPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  // Pass 1: index OPEN events by position_id to recover risk_usd later
  const opensByPositionId = {};
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.event === "OPEN" && rec.position_id) {
        opensByPositionId[rec.position_id] = rec;
      }
    } catch { /* skip */ }
  }

  const closes = [];
  const engineEvents = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);

      if (rec.event === "CLOSE") {
        const open = opensByPositionId[rec.position_id] || {};
        const riskUsd = open.risk_usd || 0;
        // NOTE: enginePnl is the engine's CLAIMED PnL — not authoritative.
        const enginePnl = (rec.r_multiple || 0) * riskUsd;
        const brokerPnl = rec.realized_pnl_usd ?? null;  // from broker reconstruction
        const closeRec = {
          ts: rec.timestamp,
          sym: rec.symbol,
          dir: rec.direction,
          mode: rec.setup_type || (rec.profile || "").replace("ibo_cbo_", "").toUpperCase(),
          entry: rec.entry_price,
          exit: rec.exit_price,
          sl: rec.stop_price,
          tp: rec.tp_price,
          r: rec.r_multiple ?? null,
          riskUsd,
          enginePnl: brokerPnl ?? Math.round(enginePnl * 100) / 100,
          brokerPnl,
          reason: rec.exit_reason,
          score: rec.quality_score,
          rr: rec.rr,
          posId: rec.position_id,
          outcome: rec.outcome || (rec.r_multiple > 0 ? "win" : "loss"),
        };
        closes.push(closeRec);
        engineEvents.push({
          ts: rec.timestamp,
          type: "CLOSE",
          sym: rec.symbol,
          r: rec.r_multiple,
          enginePnl,
        });
      }

      if (rec.event === "PARTIAL") {
        const open = opensByPositionId[rec.position_id] || {};
        const riskUsd = open.risk_usd || 0;
        const partialR = (rec.partial_r || 0) * (rec.partial_pct || 0);
        const enginePnl = partialR * riskUsd;
        engineEvents.push({
          ts: rec.timestamp,
          type: "PARTIAL",
          sym: rec.symbol,
          r: partialR,
          enginePnl,
        });
      }
    } catch {
      // skip malformed lines
    }
  }

  closes.sort((a, b) => (a.ts > b.ts ? 1 : -1));
  engineEvents.sort((a, b) => (a.ts > b.ts ? 1 : -1));

  const engineSum = engineEvents.reduce((s, e) => s + e.enginePnl, 0);
  console.log(
    `  [${label}] Loaded ${closes.length} CLOSE + ${engineEvents.length - closes.length} PARTIAL events ` +
    `(engine-claimed PnL: $${engineSum.toFixed(2)} — NOT authoritative)`
  );

  return { closes, engineEvents };
}

/* ── Snapshot history (per account, time-series of cTrader balance) ── */

/**
 * Reads the persisted balance history file. Returns a dict
 * { [accountKey]: [{ts, balance, equity}, ...] } sorted oldest → newest.
 * Returns empty dict if the file doesn't exist yet.
 */
function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    return raw || {};
  } catch (err) {
    console.log(`  [history] Failed to read ${HISTORY_PATH}: ${err.message}`);
    return {};
  }
}

/**
 * Writes the history dict back to disk, creating the data dir if needed.
 */
function saveHistory(history) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Appends a snapshot for `accountKey` if balance/equity has changed since
 * the last entry. Caps the per-account list at HISTORY_MAX_ENTRIES.
 * Returns the (possibly updated) per-account history list.
 */
function appendSnapshot(history, accountKey, snapshot) {
  if (!history[accountKey]) history[accountKey] = [];
  const list = history[accountKey];
  const last = list[list.length - 1];
  const changed =
    !last ||
    Math.abs((last.balance ?? 0) - snapshot.balance) > 0.005 ||
    Math.abs((last.equity ?? 0) - snapshot.equity) > 0.005;

  if (changed) {
    list.push(snapshot);
    if (list.length > HISTORY_MAX_ENTRIES) {
      // Keep first entry (anchor) + most recent (HISTORY_MAX_ENTRIES - 1)
      history[accountKey] = [list[0], ...list.slice(-(HISTORY_MAX_ENTRIES - 1))];
    }
  }
  return history[accountKey];
}

/* ── Engine state (per account) ─────────────────────────────── */

function loadEngineState(suffix, label) {
  const statePath = `${FTMO_ROOT}/watchlist_state${suffix}.json`;
  if (!existsSync(statePath)) {
    console.log(`  [${label}] No state file at ${statePath}`);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    console.log(
      `  [${label}] Loaded engine state (${raw.count || 0} watchlist, ${raw.m10_scans || 0} M10 scans)`
    );
    return {
      updated: raw.updated,
      balance: raw.balance,
      equity: raw.equity,
      dayStartBalance: raw.day_start_balance,
      highestEodBalance: raw.highest_eod_balance,
      trailingDdFloor: raw.trailing_dd_floor,
      dailyLoss: raw.daily_loss,
      dailyDdLimit: raw.daily_dd_limit,
      tradingPaused: raw.trading_paused,
      h4Scans: raw.h4_scans,
      m10Scans: raw.m10_scans,
      tradesPlaced: raw.trades_placed,
      nextH4Scan: raw.next_h4_scan || null,
      nextM10Scan: raw.next_m10_scan || null,
      variantName: raw.variant_name || null,
      variantConfig: raw.variant_config || null,
      watchlist: (raw.entries || []).map(e => ({
        symbol: e.symbol,
        direction: e.direction,
        setupType: e.setup_type,
        stopPrice: e.stop_price,
        targetPrice: e.target_price,
        qualityScore: e.quality_score,
        barsElapsed: e.bars_elapsed,
        maxEntryBars: e.max_entry_bars,
        barsRemaining: e.bars_remaining,
        ageMinutes: e.age_minutes,
        pullbackDepth: e.pullback_depth,
        status: e.status,
      })),
      recentRemovals: (raw.recent_removals || []).map(r => ({
        symbol: r.symbol,
        setupType: r.setup_type,
        direction: r.direction,
        reason: r.reason,
        time: r.time,
      })),
      recentM10Scans: (raw.recent_m10_scans || []).slice(-10).map(s => ({
        time: s.time,
        symbolsChecked: s.symbols_checked,
        entriesTriggered: s.entries_triggered,
        entrySymbols: s.entry_symbols,
        watchlistStatus: s.watchlist_status,
      })),
    };
  } catch (err) {
    console.log(`  [${label}] Error reading state: ${err.message}`);
    return null;
  }
}

/* ── H4 scan history from log (per account) ─────────────────── */

function loadH4Scans(suffix, label) {
  const logPath = `${FTMO_ROOT}/ibo_cbo_live${suffix}.log`;
  if (!existsSync(logPath)) {
    console.log(`  [${label}] No log file at ${logPath}`);
    return [];
  }

  try {
    let grepOutput = "";
    try {
      grepOutput = execSync(`grep -E "H4 SCAN|WATCHLIST ADD" "${logPath}"`, { encoding: "utf-8" });
    } catch {
      /* grep returns 1 if no matches */
    }
    const lines = grepOutput.split("\n");

    const h4Scans = [];
    let currentScan = null;

    for (const line of lines) {
      const scanMatch = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*H4 SCAN #(\d+) at (.+)/);
      if (scanMatch) {
        if (currentScan) h4Scans.push(currentScan);
        currentScan = {
          logTime: scanMatch[1],
          scanNumber: parseInt(scanMatch[2]),
          scanTime: scanMatch[3].trim(),
          additions: [],
        };
        continue;
      }

      if (currentScan) {
        const addMatch = line.match(
          /WATCHLIST ADD \| (\w+) (BUY|SELL) (IBO|CBO) \| .* score=([\d.]+) \| pullback=([\d.]+)%/
        );
        if (addMatch) {
          currentScan.additions.push({
            symbol: addMatch[1],
            direction: addMatch[2].toLowerCase(),
            setupType: addMatch[3],
            score: parseFloat(addMatch[4]),
            pullback: parseFloat(addMatch[5]),
          });
        }
      }
    }
    if (currentScan) h4Scans.push(currentScan);

    // Deduplicate by scan number — engine restarts during the same H4
    // boundary produce multiple entries with the same scan#. Keep the
    // last one (most complete, has the most additions).
    const byNumber = new Map();
    for (const scan of h4Scans) {
      const existing = byNumber.get(scan.scanNumber);
      if (!existing || scan.additions.length >= existing.additions.length) {
        byNumber.set(scan.scanNumber, scan);
      }
    }
    const deduped = Array.from(byNumber.values())
      .sort((a, b) => a.scanNumber - b.scanNumber);
    const recent = deduped.slice(-10);
    console.log(`  [${label}] Parsed ${h4Scans.length} H4 scans, deduped to ${deduped.length} (showing last ${recent.length})`);
    return recent;
  } catch (err) {
    console.log(`  [${label}] Error parsing log: ${err.message}`);
    return [];
  }
}

/* ── Per-account aggregation ────────────────────────────────── */

function buildAccountData(account, history) {
  console.log(`\nProcessing ${account.label}...`);
  const { closes, engineEvents } = loadTrades(account.suffix, account.label);
  const engineState = loadEngineState(account.suffix, account.label);
  const h4Scans = loadH4Scans(account.suffix, account.label);

  // SOURCE OF TRUTH: broker balance & equity queried live from the bridge.
  // Never compute equity — the broker's number includes all fees, swaps,
  // and actual fill prices. Any computation will drift.
  const brokerAccount = fetchAccount(account.accountId, account.bridgePort);
  const currentBalance = brokerAccount?.balance ?? engineState?.balance ?? STARTING_BALANCE;
  const currentEquity  = brokerAccount?.equity  ?? engineState?.equity  ?? currentBalance;
  const realizedPnl = currentBalance - STARTING_BALANCE;
  if (brokerAccount) {
    console.log(`  [${account.label}] Broker balance=$${currentBalance.toFixed(2)}, equity=$${currentEquity.toFixed(2)}`);
  } else {
    console.log(`  [${account.label}] Bridge unavailable, using engine state fallback`);
  }

  // Append the live snapshot to the persisted history (only if changed).
  // history is mutated in place; we get back the per-account list.
  const accountHistory = appendSnapshot(history, account.key, {
    ts: engineState?.updated || new Date().toISOString(),
    balance: Math.round(currentBalance * 100) / 100,
    equity: Math.round(currentEquity * 100) / 100,
  });

  // Build the equity curve from the persisted history. If the only entry so
  // far is the current snapshot, prepend an anchor at $100k so the chart has
  // a 2-point baseline to render against.
  const curveSource = accountHistory.length === 1
    ? [{ ts: accountHistory[0].ts, balance: STARTING_BALANCE, equity: STARTING_BALANCE }, accountHistory[0]]
    : accountHistory;

  let peak = STARTING_BALANCE;
  let maxDD = 0;
  const balanceCurve = curveSource.map((s, i) => {
    if (s.balance > peak) peak = s.balance;
    const dd = peak > 0 ? ((peak - s.balance) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    return {
      idx: i,
      ts: s.ts,
      d: s.ts ? s.ts.substring(0, 10) : "",
      bal: Math.round(s.balance * 100) / 100,
      eq:  Math.round(s.equity  * 100) / 100,
      pnl: Math.round((s.balance - STARTING_BALANCE) * 100) / 100,
      dd:  Math.round(dd * 100) / 100,
    };
  });

  // Engine-view event curve: this is the JSONL-derived running curve, NOT
  // anchored to truth. We keep it for the trade list view but never use it
  // for $ totals or live balance display. Each event's `enginePnl` represents
  // the engine's CLAIM, which may be wrong.
  let engineBal = STARTING_BALANCE;
  const engineEventCurve = engineEvents.map((e, i) => {
    engineBal += e.enginePnl;
    return {
      idx: i + 1,
      ts: e.ts,
      d: e.ts ? e.ts.substring(0, 10) : "",
      type: e.type,
      sym: e.sym,
      r: Math.round((e.r || 0) * 10000) / 10000,
      enginePnl: Math.round(e.enginePnl * 100) / 100,
      engineBal: Math.round(engineBal * 100) / 100,
    };
  });

  // Per-trade list (CLOSE events) for trade stats: win rate, PF, R-stats.
  // These metrics use r_multiple (a ratio, not a $ amount) — we still surface
  // them, but tagged as "engine view" in the UI.
  const enriched = closes.map((t, i) => ({
    ...t,
    tn: i + 1,
    d: t.ts ? t.ts.substring(0, 10) : "",
  }));

  // Win/loss from outcome field (works for broker-reconstructed AND engine records)
  const wins = closes.filter(t => t.outcome === "win").length;
  const losses = closes.length - wins;
  // R-based stats: only from trades with real r_multiple (not null)
  const tradesWithR = closes.filter(t => t.r != null && t.r !== undefined);
  const totalR = tradesWithR.length ? Math.round(tradesWithR.reduce((s, t) => s + t.r, 0) * 100) / 100 : null;
  const avgR = tradesWithR.length ? Math.round((totalR / tradesWithR.length) * 100) / 100 : null;

  // Daily DD%: derived from the snapshot history (truth), denominated against
  // $100k for FTMO comparison.
  const dailyPnL = {};
  let prevBal = STARTING_BALANCE;
  for (const s of accountHistory) {
    const day = s.ts.substring(0, 10);
    dailyPnL[day] = (dailyPnL[day] || 0) + (s.balance - prevBal);
    prevBal = s.balance;
  }
  let maxDailyDD = 0;
  for (const pnl of Object.values(dailyPnL)) {
    const ddPct = (Math.abs(Math.min(0, pnl)) / STARTING_BALANCE) * 100;
    if (ddPct > maxDailyDD) maxDailyDD = ddPct;
  }

  const meta = {
    totalTrades: closes.length,
    engineEventCount: engineEvents.length,
    partialCount: engineEvents.length - closes.length,
    wins,
    losses,
    totalR,   // null if no trades have r_multiple
    avgR,     // null if no trades have r_multiple
    // $ figures derived from cTrader balance — TRUTH
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    startBalance: STARTING_BALANCE,
    currentBalance: Math.round(currentBalance * 100) / 100,
    currentEquity: Math.round(currentEquity * 100) / 100,
    finalBalance: Math.round(currentBalance * 100) / 100, // alias
    openPnl: Math.round((currentEquity - currentBalance) * 100) / 100,
    maxDD: Math.round(maxDD * 100) / 100,
    maxDailyDD: Math.round(maxDailyDD * 100) / 100,
    historyPoints: accountHistory.length,
  };

  // Status: derive from engineState
  let status = "OFFLINE";
  if (engineState) {
    if (engineState.tradingPaused) status = "PAUSED";
    else status = "ACTIVE";
  }

  // Fetch live open positions from bridge
  const openPositions = fetchPositions(account.accountId, account.bridgePort);

  return {
    key: account.key,
    label: account.label,
    fullLabel: account.fullLabel,
    accountId: account.accountId,
    displayId: account.displayId || null,
    color: account.color,
    // Prefer live engine config from state file over hardcoded defaults
    config: engineState?.variantConfig
      ? {
          ...account.config,
          ...engineState.variantConfig,
          // Normalize field names: engine state uses entry_delay, dashboard uses entry_delay_bars
          entry_delay_bars: engineState.variantConfig.entry_delay ?? account.config.entry_delay_bars,
        }
      : account.config,
    status,
    trades: enriched,           // CLOSE events for trade list / R-stats
    balanceCurve,               // TRUTH: cTrader balance/equity time-series
    engineEventCurve,           // ENGINE VIEW: JSONL r_multiple events (unreliable $)
    meta,
    engineState,
    h4Scans,
    openPositions,              // Live positions from bridge at build time
  };
}

/* ── Build & emit ───────────────────────────────────────────── */

const history = loadHistory();
console.log(
  `Loaded balance history: ${Object.keys(history).length} accounts, ` +
  `${Object.values(history).reduce((s, l) => s + l.length, 0)} total snapshots`
);

// Fetch FX rates from both bridges (PROD=3100, demo=3101) before position queries.
// Use demo bridge — it has the superset of forex symbols.
console.log("\nFetching FX rates for P&L conversion...");
fetchFxRates(3101);

const accountData = {};
for (const acc of ACCOUNTS) {
  accountData[acc.key] = buildAccountData(acc, history);
}

// Persist updated history back to disk
saveHistory(history);
console.log(
  `\nSaved balance history: ${Object.values(history).reduce((s, l) => s + l.length, 0)} total snapshots`
);

const lastUpdated = new Date().toISOString();
const accountKeys = ACCOUNTS.map(a => a.key);

const output = `// Auto-generated by build-data.js — do not edit
// Last built: ${lastUpdated}

export const ACCOUNTS = ${JSON.stringify(accountData)};
export const ACCOUNT_KEYS = ${JSON.stringify(accountKeys)};
export const ACCOUNT_LIST = ACCOUNT_KEYS.map(k => ACCOUNTS[k]);
export const LAST_UPDATED = ${JSON.stringify(lastUpdated)};

// Backward-compatibility exports (production account)
export const TRADES = ACCOUNTS.production.trades;
export const META = { ...ACCOUNTS.production.meta, lastUpdated: LAST_UPDATED };
export const ENGINE_STATE = ACCOUNTS.production.engineState;
export const H4_SCANS = ACCOUNTS.production.h4Scans;
`;

writeFileSync(OUT_PATH, output);

const totalTrades = Object.values(accountData).reduce((s, a) => s + a.trades.length, 0);
console.log(
  `\nWrote ${ACCOUNTS.length} accounts (${totalTrades} total trades) to src/tradeData.js (${(output.length / 1024).toFixed(1)} KB)`
);
console.log("\nPnL source: cTrader balance (TRUTH). Engine r_multiple values are display-only.");
for (const acc of ACCOUNTS) {
  const m = accountData[acc.key].meta;
  const sign = m.realizedPnl >= 0 ? "+" : "";
  console.log(`  ${acc.label.padEnd(12)} balance=$${m.currentBalance.toFixed(2).padStart(11)}  realized=${sign}$${m.realizedPnl.toFixed(2)}  open=${m.openPnl >= 0 ? "+" : ""}$${m.openPnl.toFixed(2)}`);
}
