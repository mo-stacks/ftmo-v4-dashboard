// Per-variant timeline of changes that affect strategy / risk / mechanics.
// Surfaced as markers on the equity-curve chart with hover tooltips.
//
// Each entry: { ts, label, title, details }
//   - ts:      ISO 8601 timestamp (UTC) when the change took effect on the
//              RUNNING engine (not the commit time). For deploys, this is
//              the engine restart that picked up the code.
//   - label:   short caption (~12 chars max — used as the marker badge)
//   - title:   tooltip header — one line summarizing the change
//   - details: tooltip body — what mechanically changed and which commit
//
// Refresh pattern: when a Rule-2 deploy lands, APPEND a new entry to the
// affected variant in the SAME commit as the engine/YAML change. Otherwise
// the dashboard won't know when the curve's behavior changed.

export const VARIANT_CHANGE_EVENTS = {
  production: [
    {
      ts: "2026-04-19T00:22:00Z",  // 2026-04-18 17:22 PDT
      label: "Restart",
      title: "Engine restart — clean baseline",
      details:
        "All 5 engines restarted (Apr 18 17:22 PDT). Loaded pre-3f79783 code — V1 classifier-stop logic active. " +
        "Subsequent commits (V2 half-fib stop, Phase 1, Plan A/B/C) only take effect on the next restart, " +
        "which on Production happened 2026-04-24.",
    },
    {
      ts: "2026-04-24T17:40:34Z",
      label: "Phase 1",
      title: "Phase 1 deploy — risk dial + V2 stop + trail off",
      details:
        "Per-trade risk: 1.65% → 0.80%. " +
        "Trail-C5 disabled (was net-negative on V2 per audit/baseline_barbybar_20260424). " +
        "V2 half-fib stop now executing (engine restart loaded post-3f79783 code). " +
        "Commit 566c688.",
    },
    {
      ts: "2026-04-28T02:02:12Z",
      label: "Plan A+B",
      title: "D3 Codex partial + bridge silent-fail surfaced",
      details:
        "Plan A: partial trigger 0.5R → 0.6R; partial size 30% → 20%. " +
        "Plan B: bridge silently-rejected SL amends now surfaced as success=false (was returning success=true blindly); " +
        "engine-side aggregate margin pre-check removed (broker is the gate). " +
        "Commit 566bbcc.",
    },
    {
      ts: "2026-04-28T03:51:00Z",
      label: "Plan C",
      title: "BE decouple + risk-based 4.5% slot cap",
      details:
        "BE moves to break-even ONLY after MFE crosses +1.0R (was coincident with partial — survives noise wicks). " +
        "max_floating_risk_pct 4.5% activated (cosmetic for now — count-cap of 5 positions still dominates). " +
        "Commit 0489219.",
    },
    {
      ts: "2026-04-28T13:14:28Z",
      label: "$90k floor",
      title: "EMERGENCY — FTMO 2-Step static max-loss floor",
      details:
        "Hard $90,000 STATIC floor activated. Was previously trailing the high-water-mark — caused death-spiral risk " +
        "(equity could only ratchet down). On any equity touching $90k, all positions force-close and engine halts new entries. " +
        "Commit c9b791f.",
    },
    {
      ts: "2026-04-28T17:30:21Z",
      label: "Telemetry",
      title: "Telemetry bug fixes (#2 / #4 / #5 / #6)",
      details:
        "Bug #2: margin telemetry surfaced on accepted ENTRY_DECISION events. " +
        "Bug #4: POSITION_CLOSE enriched with hold_time / mfe / mae / first_management_event. " +
        "Bug #5: restored positions populate MFE / MAE / first_management_event on engine restart. " +
        "Bug #6: bridge.get_quote retries on cache_not_warm (numeric fill prices instead of 'deferred_to_close' sentinels). " +
        "Strategy unchanged — observability fixes only. Commits 7881d62 / a74e1e1 / 6bbeec7 / e9d4db5.",
    },
    {
      ts: "2026-04-28T18:20:54Z",
      label: "Track 1",
      title: "Classifier _sequence pre-seeded on engine restart",
      details:
        "Engine startup now loads classifier _sequence from 1+ year of cTrader history (39/39 syms). " +
        "Avoids cold-start IBO bias. Measured impact on first H4 scan post-deploy: " +
        "IBO bias 79.8% (17-day baseline) → 27.3% (n=11 setups). " +
        "Commit 152417c.",
    },
    {
      ts: "2026-04-28T18:44:56Z",
      label: "New acct",
      title: "FTMO Free demo 47151641 — replaced expired 46992359",
      details:
        "Original FTMO_PROD demo (login 17092574) expired today. Switched bridge + engine to a fresh " +
        "FTMO Free demo (login 17102428, account 47151641). " +
        "Balance reset to $100,000. Static floor reset to $90,000 ($10k cushion vs $2.9k on old account). " +
        "Commit b889150.",
    },
    {
      ts: "2026-04-28T19:41:00Z",
      label: "Stocks LIMIT",
      title: "Stock entries switched to LIMIT orders",
      details:
        "Stock instruments (16/44 of universe) now submit LIMIT orders @ entry-bar open with 600s GoodTillDate, " +
        "instead of MARKET. Caps slippage on RTH tape; unfilled limits auto-cancel after 10 minutes. " +
        "Commit f974d6b.",
    },
  ],
  alpha: [
    {
      ts: "2026-04-19T00:22:00Z",
      label: "Restart",
      title: "Engine restart — current state, pre-3f79783",
      details:
        "Engine restarted 2026-04-18 17:22 PDT, BEFORE commit 3f79783 (the V2 half-fib stop port that landed " +
        "Apr 18 22:01 PDT). Running code: V1 classifier-stop, no trail (intentional A/B control variant). " +
        "Engine has NOT been restarted since — none of the FTMO_PROD-only deploys (Phase 1, Plan A/B/C, " +
        "telemetry fixes, Track 1, Stocks LIMIT) are active on this account.",
    },
  ],
  bravo: [
    {
      ts: "2026-04-19T00:22:00Z",
      label: "Restart",
      title: "Engine restart — current state, pre-3f79783",
      details:
        "Engine restarted 2026-04-18 17:22 PDT, BEFORE commit 3f79783. Running code: V1 classifier-stop + Trail-C5 hybrid. " +
        "Forex-only universe. Pre-Phase-1 risk dial (1.65%). " +
        "Engine has NOT been restarted since. None of the FTMO_PROD-only deploys are active on this account.",
    },
  ],
  charlie: [
    {
      ts: "2026-04-19T00:22:00Z",
      label: "Restart",
      title: "Engine restart — current state, pre-3f79783",
      details:
        "Engine restarted 2026-04-18 17:22 PDT, BEFORE commit 3f79783. Running code: V1 classifier-stop + Trail-C5 hybrid. " +
        "Full universe. Pre-Phase-1 risk dial (1.65%). " +
        "Engine has NOT been restarted since. None of the FTMO_PROD-only deploys are active on this account.",
    },
  ],
  delta: [
    {
      ts: "2026-04-19T00:22:00Z",
      label: "Restart",
      title: "Engine restart — current state, pre-3f79783",
      details:
        "Engine restarted 2026-04-18 17:22 PDT, BEFORE commit 3f79783. Running code: V1 classifier-stop + Trail-C5 hybrid. " +
        "Full universe + ETHUSD (only variant currently allowed crypto). Pre-Phase-1 risk dial (1.65%). " +
        "Engine has NOT been restarted since. None of the FTMO_PROD-only deploys are active on this account.",
    },
  ],
};

// Helper: project change events onto an equity-compare timeline. Each chart
// row gets a `${variantKey}_changes` array containing all events that fall
// at or before that row's ts (and after the previous row's ts). The first
// row that satisfies row.ts >= event.ts is the carrier.
//
// Multiple events can fall on the same row (e.g. rapid telemetry commits).
// The chart marker reads this array and concatenates titles in the tooltip.
export function attachChangeEvents(equityCompare, eventsByVariant) {
  if (!equityCompare?.length) return equityCompare;
  // Shallow-clone rows so we don't mutate the source array
  const out = equityCompare.map(row => ({ ...row }));
  for (const [variantKey, events] of Object.entries(eventsByVariant || {})) {
    if (!events?.length) continue;
    // Sort events by ts ascending (defensive — should already be sorted)
    const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const event of sorted) {
      // Find the first row whose ts >= event.ts. That row is the carrier.
      let carrierIdx = -1;
      for (let i = 0; i < out.length; i++) {
        if (out[i].ts >= event.ts) { carrierIdx = i; break; }
      }
      if (carrierIdx === -1) carrierIdx = out.length - 1;  // event after last snapshot
      const field = `${variantKey}_changes`;
      if (!out[carrierIdx][field]) out[carrierIdx][field] = [];
      out[carrierIdx][field].push(event);
    }
  }
  return out;
}
