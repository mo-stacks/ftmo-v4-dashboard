# Variant State — full per-variant deploy notes

**Last refreshed:** 2026-04-30
**Refresh policy:** edit this file on every Rule-2 deploy that changes per-variant behavior. Pair with a `useSupabaseData.js` `VARIANT_CONFIG` field update if a structured field changes.

The dashboard's "Variant Configuration" table renders only structured at-a-glance fields. The prose below is the full deploy state, rationale, and code-path lineage for each variant — kept here so the dashboard table doesn't become a wall of text.

Source-of-truth precedence:
1. Running engine startup banner (Rule-1 ground truth)
2. `config_*.yaml` in the FTMO_V4 repo
3. `engine/run_live.py` hardcoded constants
4. `tools/system_health_state.yaml` (cross-tool canonical mirror)

---

## Challenge — FTMO 2-Step Challenge (Step-1 target = 10%)

- **Account:** ctidTraderAccountId 47142181, login 7545753 (cTrader demo env, vs Production's live env). Same OAuth + bridge as Production; bridge auto-routes by accountId.
- **Started:** 2026-04-30. $900 fee paid. Step-1 profit target = 10% ($110k from $100k start).
- **Code path:** V2 half-fib stop + Phase 5 ON + V3 management (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + no trail + EMA-as-soft-factor only. Same code path as Production.
- **Engine-wide gate=100** (deployed 2026-04-30): `_find_m10_entry` waits until 100+ M10 forward bars (~16.7h) past scan_ts before attempting entry detection. Live-replay 4y backtest: 74.4% WR / +1188R / 0.33% Prague-daily DD / FTMO PASS by huge margin.
- **Universe revised 2026-04-30:** 17 → 10 exclusions. Un-excluded AMZN/GOOG/META/MSTR/XOM/JP225/GER40 — all 73-87% WR / net +R in gate=100 backtest. Still excluded: CAT/DIS/FDX/GS/HD/MA/V (no backtest data anywhere) + UK100 (gate=100 backtest = 33% WR / -$3,678) + AUDNZD/GBPCAD (not yet backtested at gate=100).
- **Initial TP:** 1.272 Fib extension. Move to BE only after MFE crosses +1.0R (decoupled — survives noise wicks).
- **Stocks LIMIT entries** @ entry-bar open with 600s expiry (caps slippage on RTH tape).
- **Hard $90k static max-loss floor** (FTMO 2-Step rule). Was trailing initially; switched to static after death-spiral risk. `MAX_FLOATING_RISK_PCT=0.045` and `MAX_POSITIONS_HARD_CAP=15` are the binding caps.
- **Classifier `_sequence` pre-seeded** from 1+ year of cTrader bars on every restart (avoids cold-start IBO bias). Watchlist preserved across restarts via `load_watchlist_state`.

## Production — FTMO Free Demo (no profit target)

- **Account:** ctidTraderAccountId 47151641, login 17102428 (FTMO Free demo on `live.ctraderapi.com`). Replaced expired demo 17092574/46992359 on 2026-04-28 (`b889150`).
- **Purpose:** V2 / Plan A/B/C reference deployment — code path mirrors Challenge; this is the variant that practices the real-money trade path before the Challenge purchase.
- **Code path:** V2 half-fib stop + Phase 5 ON + V3 management (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + no trail.
- **Initial TP:** 1.272 Fib extension. Move to BE only after MFE crosses +1.0R (decoupled).
- **Stocks LIMIT entries** @ entry-bar open with 600s expiry.
- **Hard $90k static max-loss floor** (was trailing → death spiral; emergency fix `c9b791f`).
- **Classifier `_sequence` pre-seeded** on every restart from 1+ year of cTrader bars.
- **Universe:** 44 syms · crypto excluded.
- **`max_positions_hard_cap: 15`** raised from 8 on 2026-04-29 — BE+ positions are 0R, so 4.5% floating cap is the binding gate; HARD_CAP only fires when >15 positions are profit-locked.

## Alpha — Spotware Demo · CONTROL variant

- **Account:** Spotware paper 46915262, login 5797573 on `localhost:3101`.
- **Role:** A/B control variant — designed to measure trail-stop delta vs the rest of the fleet. NO TRAIL.
- **Code path:** Classifier-stop (V1, pre-`3f79783`).
- **Initial TP:** 1.272 Fib extension. Move to BE at +0.5R (coincident with partial fire).
- **Universe:** 36 syms · includes ETHUSD.
- **Phase 1 risk dial (0.80%) IS active** — engine restarted 2026-04-28 well after the Phase 1 deploy. Any "V2-style" behavior here would be coincidence (still classifier-stop code path).
- V2 rollout to demos is a separate Rule-2 plan (not yet scheduled).

## Bravo — Spotware Demo · forex-only specialist

- **Account:** Spotware paper 46915271, login 5797576.
- **Role:** Tests whether a focused forex universe outperforms PROD's mixed approach. Forex is 79% of backtest trades.
- **Code path:** Classifier-stop (V1).
- **Initial TP:** 1.272 Fib extension. BE at +0.5R (coincident).
- **Trail-C5:** ENABLED — after partial fires, trail activates at 60% of distance to TP, follows price by 10%, capped at 12R. On activation, broker TP is amended FROM 1.272 Fib TO the 12R safety ceiling.
- **Universe:** 17 forex pairs (no stocks/indices/metals/commodities).
- **Phase 1 risk dial (0.80%) active.**

## Charlie — Spotware Demo · PROD mirror

- **Account:** Spotware paper 46915274, login 5797577.
- **Role:** Validates reproducibility against production. Future home of spread-aware entry test variant.
- **Code path:** Classifier-stop (V1).
- **Initial TP:** 1.272 Fib extension. BE at +0.5R (coincident).
- **Trail-C5:** ENABLED (same params as Bravo).
- **Universe:** 35 syms · forex + indices + metals + commodities + stocks.
- **Phase 1 risk dial (0.80%) active.**

## Delta — Spotware Demo · ETHUSD-allowed

- **Account:** Spotware paper 46915276, login 5797579.
- **Role:** Mixed universe like Production, but the only variant currently allowed crypto exposure (ETHUSD).
- **Code path:** Classifier-stop (V1).
- **Initial TP:** 1.272 Fib extension. BE at +0.5R (coincident).
- **Trail-C5:** ENABLED.
- **Universe:** 36 syms incl. ETHUSD.
- **Phase 1 risk dial (0.80%) active.**

---

## Refresh checklist (per Rule-2 deploy)

When a Rule-2 deploy lands that changes per-variant state:

1. Update the relevant section above (account, code path, deploy commit hash, etc.).
2. Update the corresponding entry in `src/useSupabaseData.js` `VARIANT_CONFIG` if a structured field changed (account_type, target_pct, partial_*, be_move, risk_pct, stop_mode, trail, universe_filter, etc.).
3. Bump the `Last refreshed:` date at the top of this file.
4. Pair with a refresh of `tools/system_health_state.yaml` and `docs/process/ROADMAP.md` "Active deploys" in the FTMO_V4 repo (canonical state.yaml, narrative ROADMAP, dashboard mirror).

If a structured field changes (e.g., new `be_move` rule lands), the table column it feeds will update automatically — but the prose section above won't, so re-read this file as part of the deploy ritual.
