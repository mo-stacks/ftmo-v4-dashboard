/* AlertCenter — bell icon in the dashboard header that:
   - Shows unread count badge for new trade alerts
   - Click → dropdown with recent events + a settings panel
   - Settings: master enable, browser perm, sound, per-event toggles
   - In-app toast for the most recent event slides in from bottom-right
     (visible across all tabs of the dashboard)

   Pairs with useTradeAlerts.js — that hook owns the event diffing
   and dispatching; this component is purely presentation. */

import { useEffect, useState, useRef } from "react";

const PALETTE = {
  bg: "#13131c",
  bgDeep: "#0e0e15",
  border: "#22222e",
  text: "#e0e0ea",
  muted: "#888",
  mutedDim: "#555",
  green: "#22b89a",
  red: "#cf5b5b",
  blue: "#7eb4fa",
  gold: "#cfb95b",
  purple: "#a78bfa",
};

const KIND_ACCENT = {
  entry:    PALETTE.blue,
  modified: PALETTE.gold,
  closed:   PALETTE.green,   // overridden to red for losing closes
};

const KIND_LABEL = {
  entry:    "Entry",
  modified: "Modified",
  closed:   "Closed",
};

function fmtRel(ts) {
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function AlertCenter({
  events, unread, settings, setSettings,
  permission, requestPermission,
  markAllRead, clearEvents,
  mob,
}) {
  const [open, setOpen] = useState(false);
  // The most-recent event also slides in as a toast at the bottom-right
  // for ~6 seconds. Tracks separately from `open` so the toast can show
  // even when the dropdown is closed.
  const [toast, setToast] = useState(null);
  const lastSeenTsRef = useRef(0);

  // Detect a new top event since last render → show toast
  useEffect(() => {
    if (!events || events.length === 0) return;
    const top = events[0];
    if (top.timestamp > lastSeenTsRef.current) {
      setToast(top);
      lastSeenTsRef.current = top.timestamp;
      const id = setTimeout(() => setToast(null), 6500);
      return () => clearTimeout(id);
    }
  }, [events]);

  const wrapperRef = useRef(null);
  // Click-outside to close dropdown
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // When opening, mark events as read
  useEffect(() => { if (open) markAllRead(); }, [open, markAllRead]);

  const bellIcon = (
    <svg width={mob ? 18 : 20} height={mob ? 18 : 20} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.7 21a2 2 0 0 1-3.4 0"/>
    </svg>
  );

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Alerts (${unread} unread)`}
        style={{
          background: open ? PALETTE.bgDeep : "transparent",
          border: `1px solid ${open ? PALETTE.border : "transparent"}`,
          borderRadius: 8,
          padding: mob ? "6px 8px" : "8px 10px",
          cursor: "pointer",
          color: settings.enabled ? PALETTE.text : PALETTE.mutedDim,
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          transition: "background 0.15s",
        }}
      >
        {bellIcon}
        {unread > 0 && (
          <span style={{
            position: "absolute",
            top: -2,
            right: -2,
            background: PALETTE.red,
            color: "#fff",
            borderRadius: 10,
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 5px",
            minWidth: 16,
            textAlign: "center",
            lineHeight: 1.4,
          }}>{unread > 99 ? "99+" : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          zIndex: 50,
          width: mob ? "calc(100vw - 24px)" : 380,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "75vh",
          overflowY: "auto",
          background: PALETTE.bg,
          border: `1px solid ${PALETTE.border}`,
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          fontFamily: "'Urbanist', system-ui, sans-serif",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 14px",
            borderBottom: `1px solid ${PALETTE.border}`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>Alerts</div>
            {events.length > 0 && (
              <button
                onClick={clearEvents}
                style={{
                  background: "transparent",
                  border: "none",
                  color: PALETTE.muted,
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >Clear all</button>
            )}
          </div>

          {/* Settings panel */}
          <div style={{
            padding: "10px 14px",
            background: PALETTE.bgDeep,
            borderBottom: `1px solid ${PALETTE.border}`,
            fontSize: 11,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ color: PALETTE.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>Settings</span>
            </div>

            <ToggleRow
              label="Enable alerts"
              checked={settings.enabled}
              onChange={(v) => setSettings({ enabled: v })}
            />
            <ToggleRow
              label="Sound on alert"
              checked={settings.sound}
              onChange={(v) => setSettings({ sound: v })}
              disabled={!settings.enabled}
            />

            {/* Browser permission row */}
            {permission === "unsupported" ? (
              <div style={{ color: PALETTE.mutedDim, fontStyle: "italic", padding: "4px 0" }}>
                Browser notifications not supported on this device.
              </div>
            ) : permission === "granted" ? (
              <ToggleRow
                label="Browser notifications"
                checked={settings.browser}
                onChange={(v) => setSettings({ browser: v })}
                disabled={!settings.enabled}
                hint="OS-level toasts even when this tab is in the background"
              />
            ) : (
              <div style={{
                background: PALETTE.bg, borderRadius: 6, padding: "8px 10px",
                margin: "4px 0", border: `1px solid ${PALETTE.border}`,
              }}>
                <div style={{ color: PALETTE.text, fontSize: 11, marginBottom: 4 }}>
                  Browser notifications {permission === "denied" ? "blocked" : "not enabled"}
                </div>
                <div style={{ color: PALETTE.muted, fontSize: 10, marginBottom: 6 }}>
                  {permission === "denied"
                    ? "Re-enable in your browser's site settings."
                    : "OS-level toasts that show even when this tab isn't active."}
                </div>
                {permission !== "denied" && (
                  <button
                    onClick={requestPermission}
                    style={{
                      background: PALETTE.green + "22",
                      border: `1px solid ${PALETTE.green}55`,
                      color: PALETTE.green,
                      borderRadius: 4,
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >Enable browser notifications</button>
                )}
              </div>
            )}

            <div style={{ marginTop: 8, color: PALETTE.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700, fontSize: 10 }}>Event types</div>
            <ToggleRow label="Trade entries" checked={settings.entry} onChange={(v) => setSettings({ entry: v })} disabled={!settings.enabled} small />
            <ToggleRow label="Stop / target moves" checked={settings.modified} onChange={(v) => setSettings({ modified: v })} disabled={!settings.enabled} small />
            <ToggleRow label="Trade closes" checked={settings.closed} onChange={(v) => setSettings({ closed: v })} disabled={!settings.enabled} small />

            <div style={{ marginTop: 6, fontSize: 10, color: PALETTE.mutedDim, fontStyle: "italic" }}>
              Polling cadence: 2 min. Add to Home Screen on iOS / install on Android for background alerts.
            </div>
          </div>

          {/* Events list */}
          {events.length === 0 ? (
            <div style={{
              padding: 18, textAlign: "center", color: PALETTE.mutedDim,
              fontSize: 12, fontStyle: "italic",
            }}>No alerts yet. New trade events will appear here.</div>
          ) : (
            <div>
              {events.map((ev, i) => (
                <EventRow key={i} event={ev} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* In-page toast — slides up from bottom-right */}
      {toast && settings.enabled && (
        <Toast event={toast} onDismiss={() => setToast(null)} mob={mob} />
      )}
    </div>
  );
}

function ToggleRow({ label, checked, onChange, disabled, hint, small }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: small ? "3px 0" : "6px 0",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
    }}>
      <span style={{ flex: 1 }}>
        <span style={{ color: PALETTE.text, fontSize: small ? 11 : 12 }}>{label}</span>
        {hint && <div style={{ color: PALETTE.muted, fontSize: 10, marginTop: 1 }}>{hint}</div>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: PALETTE.green, cursor: disabled ? "not-allowed" : "pointer" }}
      />
    </label>
  );
}

function EventRow({ event }) {
  const accent = event.kind === "closed"
    ? (event.winning ? PALETTE.green : PALETTE.red)
    : KIND_ACCENT[event.kind];
  return (
    <div style={{
      padding: "10px 14px",
      borderBottom: `1px solid ${PALETTE.border}`,
      borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: 0.5, textTransform: "uppercase" }}>
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%",
            background: event.accountColor, marginRight: 6, verticalAlign: "middle",
          }}/>
          {event.accountLabel} · {KIND_LABEL[event.kind]}
        </div>
        <div style={{ fontSize: 10, color: PALETTE.mutedDim }}>{fmtRel(event.timestamp)}</div>
      </div>
      <div style={{ fontSize: 12, color: PALETTE.text, fontWeight: 600 }}>{event.symbol}</div>
      <div style={{ fontSize: 11, color: PALETTE.muted, marginTop: 2, fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
        {event.body}
      </div>
    </div>
  );
}

function Toast({ event, onDismiss, mob }) {
  const accent = event.kind === "closed"
    ? (event.winning ? PALETTE.green : PALETTE.red)
    : KIND_ACCENT[event.kind];
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      style={{
        position: "fixed",
        bottom: mob ? 16 : 24,
        right: mob ? 12 : 24,
        left: mob ? 12 : "auto",
        maxWidth: mob ? "calc(100vw - 24px)" : 360,
        background: PALETTE.bg,
        border: `1px solid ${PALETTE.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 10,
        padding: "10px 14px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        cursor: "pointer",
        zIndex: 9999,
        animation: "ftmoToastIn 0.25s ease-out",
        fontFamily: "'Urbanist', system-ui, sans-serif",
      }}
    >
      <style>{`
        @keyframes ftmoToastIn {
          from { transform: translateY(20px); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: accent, letterSpacing: 0.5, textTransform: "uppercase" }}>
          {event.accountLabel} · {KIND_LABEL[event.kind]}
        </div>
        <div style={{ fontSize: 10, color: PALETTE.mutedDim }}>tap to dismiss</div>
      </div>
      <div style={{ fontSize: 13, color: PALETTE.text, fontWeight: 700 }}>{event.symbol}</div>
      <div style={{ fontSize: 11, color: PALETTE.muted, marginTop: 3, fontFamily: "'Space Grotesk', ui-monospace, monospace" }}>
        {event.body}
      </div>
    </div>
  );
}
