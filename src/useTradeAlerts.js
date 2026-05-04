/* useTradeAlerts — diff polled account data and surface trade events
   as browser notifications + in-page toasts + optional sound.

   Three event types:
     ENTRY     — a position appears that wasn't in the previous poll
     MODIFIED  — same positionId, but stopLoss or takeProfit moved
                 (typically trailing-stop activation)
     CLOSED    — a position present last poll is gone now; we look up
                 the matching row in account.trades to surface exit
                 reason + R + P&L

   Settings live in localStorage under "ftmo-v4-alerts" so they persist
   across page loads. Browser permission is requested only when the user
   clicks "Enable" — never auto-prompted (browsers penalize unsolicited
   prompts and may permanently deny).

   Multi-tab: notifications use the `tag` parameter, which the browser
   uses to dedupe — opening the dashboard in 3 tabs still shows one
   notification per event.
*/

import { useEffect, useRef, useState, useCallback } from "react";

const STORAGE_KEY = "ftmo-v4-alerts";

const DEFAULT_SETTINGS = {
  enabled: true,           // master switch (in-app toast + browser if perm granted)
  browser: false,          // browser notifications (requires permission)
  sound: true,             // play a beep on each event
  entry: true,             // ENTRY events
  modified: true,          // MODIFIED events
  closed: true,            // CLOSED events
};

function loadSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (_) { /* quota / private browsing */ }
}

// Build a comparable snapshot of all open positions across all accounts.
// Indexed by `${variantKey}::${positionId}` so the diff is O(n) and
// resilient to position-id collisions across variants.
function snapshotPositions(accounts) {
  const map = new Map();
  if (!accounts) return map;
  for (const [key, acct] of Object.entries(accounts)) {
    const positions = acct?.openPositions || [];
    for (const p of positions) {
      if (!p.positionId) continue; // can't track without a stable id
      map.set(`${key}::${p.positionId}`, {
        accountKey: key,
        accountLabel: acct.label || key,
        accountColor: acct.color || "#888",
        positionId: p.positionId,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      });
    }
  }
  return map;
}

// Build a snapshot of the latest closed trade per account so we can
// detect "a new trade has been closed" without depending on position-id
// (a closed position disappears from openPositions; the trade row may
// take a poll cycle to appear in account.trades).
function snapshotLatestClose(accounts) {
  const map = new Map();
  if (!accounts) return map;
  for (const [key, acct] of Object.entries(accounts)) {
    const trades = acct?.trades || [];
    if (trades.length === 0) continue;
    // useSupabaseData sorts trades ASC by exit_time
    const latest = trades[trades.length - 1];
    if (latest?.ts) map.set(key, latest.ts);
  }
  return map;
}

// Generate a soft beep using Web Audio API. No asset to load and the
// AudioContext is created lazily on first sound (browser autoplay
// policy: requires user interaction first; silent failure is fine).
let _audioCtx = null;
function playBeep(kind = "neutral") {
  if (typeof window === "undefined") return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    // Different frequencies for different events — subtle distinction
    const freq = kind === "win" ? 880 : kind === "loss" ? 392 : 660;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch (_) { /* silent */ }
}

// Send a Web Notifications API notification. Returns true if dispatched.
function sendBrowserNotification(event) {
  if (typeof window === "undefined") return false;
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  try {
    // tag dedupes across multiple tabs and replaces stale notifications
    // for the same event (e.g., re-open same trade later in same tag).
    const tag = `ftmo-v4-${event.kind}-${event.accountKey}-${event.positionId || event.symbol}`;
    new Notification(event.title, {
      body: event.body,
      tag,
      icon: "/favicon.svg",
      silent: false,
    });
    return true;
  } catch (_) { return false; }
}

function fmtPrice(p) {
  if (p == null || isNaN(p)) return "—";
  if (Math.abs(p) < 10) return p.toFixed(5);
  if (Math.abs(p) < 100) return p.toFixed(3);
  if (Math.abs(p) < 1000) return p.toFixed(2);
  return p.toFixed(2);
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
}

// Diff the previous and current account snapshots to produce a list of
// alert events. Each event is a fully-formed { kind, title, body,
// accountKey, accountLabel, accountColor, symbol, positionId, ... }.
function diffSnapshots(prev, curr, accounts) {
  const events = [];

  // ENTRY: position in current but not in previous
  for (const [key, pos] of curr.positions) {
    if (!prev.positions.has(key)) {
      events.push({
        kind: "entry",
        accountKey: pos.accountKey,
        accountLabel: pos.accountLabel,
        accountColor: pos.accountColor,
        positionId: pos.positionId,
        symbol: pos.symbol,
        title: `${pos.accountLabel} · ENTRY ${pos.symbol}`,
        body: `${pos.side === "BUY" ? "LONG" : "SHORT"} @ ${fmtPrice(pos.entryPrice)} · stop ${fmtPrice(pos.stopLoss)} · target ${fmtPrice(pos.takeProfit)}`,
        timestamp: Date.now(),
      });
    }
  }

  // MODIFIED: position in both, but stopLoss or takeProfit changed
  for (const [key, pos] of curr.positions) {
    const before = prev.positions.get(key);
    if (!before) continue;
    const stopChanged = before.stopLoss != null && pos.stopLoss != null
      && Math.abs(before.stopLoss - pos.stopLoss) > 1e-9;
    const tpChanged = before.takeProfit != null && pos.takeProfit != null
      && Math.abs(before.takeProfit - pos.takeProfit) > 1e-9;
    if (!stopChanged && !tpChanged) continue;
    const parts = [];
    if (stopChanged) parts.push(`stop ${fmtPrice(before.stopLoss)} → ${fmtPrice(pos.stopLoss)}`);
    if (tpChanged) parts.push(`target ${fmtPrice(before.takeProfit)} → ${fmtPrice(pos.takeProfit)}`);
    events.push({
      kind: "modified",
      accountKey: pos.accountKey,
      accountLabel: pos.accountLabel,
      accountColor: pos.accountColor,
      positionId: pos.positionId,
      symbol: pos.symbol,
      title: `${pos.accountLabel} · MODIFIED ${pos.symbol}`,
      body: parts.join(" · "),
      timestamp: Date.now(),
    });
  }

  // CLOSED: position in previous but not in current.
  // Look up the matching closed trade in account.trades for exit details.
  for (const [key, pos] of prev.positions) {
    if (curr.positions.has(key)) continue;
    const tradesForAccount = accounts?.[pos.accountKey]?.trades || [];
    const matchingTrade = tradesForAccount.find(t => t.posId && String(t.posId) === String(pos.positionId));
    const r = matchingTrade?.r;
    const pnl = matchingTrade?.brokerPnl ?? matchingTrade?.enginePnl;
    const reason = matchingTrade?.reason || "closed";
    const winning = (r ?? 0) >= 0;
    const bodyParts = [reason];
    if (r != null) bodyParts.push(`${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
    if (pnl != null) bodyParts.push(fmtUsd(pnl));
    events.push({
      kind: "closed",
      accountKey: pos.accountKey,
      accountLabel: pos.accountLabel,
      accountColor: pos.accountColor,
      positionId: pos.positionId,
      symbol: pos.symbol,
      winning,
      title: `${pos.accountLabel} · CLOSED ${pos.symbol} ${winning ? "✓" : "✗"}`,
      body: bodyParts.join(" · "),
      timestamp: Date.now(),
    });
  }

  return events;
}

export function useTradeAlerts(accounts) {
  const [settings, setSettingsState] = useState(loadSettings);
  const [permission, setPermission] = useState(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission;
  });
  const [events, setEvents] = useState([]);   // recent, capped
  const [unread, setUnread] = useState(0);
  const prevSnapshotRef = useRef(null);

  // Persist settings on change
  useEffect(() => { saveSettings(settings); }, [settings]);

  const setSettings = useCallback((patch) => {
    setSettingsState(prev => ({ ...prev, ...patch }));
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        // Auto-enable browser notifications once permission granted
        setSettings({ browser: true });
      }
      return result;
    } catch (_) { return "denied"; }
  }, [setSettings]);

  const markAllRead = useCallback(() => setUnread(0), []);
  const clearEvents = useCallback(() => { setEvents([]); setUnread(0); }, []);

  // Diff each accounts update against the previous snapshot
  useEffect(() => {
    if (!accounts) return;

    const positions = snapshotPositions(accounts);
    const lastClose = snapshotLatestClose(accounts);
    const snapshot = { positions, lastClose };

    // First poll — establish baseline, do NOT fire alerts for the
    // existing state (otherwise every reload would alert on every
    // currently-open position).
    if (prevSnapshotRef.current === null) {
      prevSnapshotRef.current = snapshot;
      return;
    }

    const newEvents = diffSnapshots(prevSnapshotRef.current, snapshot, accounts);
    prevSnapshotRef.current = snapshot;

    if (newEvents.length === 0) return;

    // Filter by per-event-kind toggles + master switch
    const filtered = newEvents.filter(ev => {
      if (!settings.enabled) return false;
      if (ev.kind === "entry" && !settings.entry) return false;
      if (ev.kind === "modified" && !settings.modified) return false;
      if (ev.kind === "closed" && !settings.closed) return false;
      return true;
    });

    if (filtered.length === 0) return;

    // Dispatch
    for (const ev of filtered) {
      if (settings.browser) sendBrowserNotification(ev);
      if (settings.sound) {
        playBeep(ev.kind === "closed" ? (ev.winning ? "win" : "loss") : "neutral");
      }
    }

    // Append to in-app event log (cap at 50 most recent)
    setEvents(prev => [...filtered.reverse(), ...prev].slice(0, 50));
    setUnread(prev => prev + filtered.length);
  }, [accounts, settings]);

  return {
    settings,
    setSettings,
    permission,
    requestPermission,
    events,
    unread,
    markAllRead,
    clearEvents,
  };
}
