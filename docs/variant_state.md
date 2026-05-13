# Variant State — full per-variant deploy notes

**Last refreshed:** 2026-05-13
**Refresh policy:** edit this file on every Rule-2 deploy that changes per-variant behavior. Pair with a `useSupabaseData.js` `VARIANT_CONFIG` field update if a structured field changes.

The dashboard's "Variant Configuration" table renders only structured at-a-glance fields. The prose below is the full deploy state, rationale, and code-path lineage for each variant — kept here so the dashboard table doesn't become a wall of text.

Source-of-truth precedence:
1. Running engine startup banner (Rule-1 ground truth)
2. `config_*.yaml` in the FTMO_V4 repo
3. `engine/run_live.py` hardcoded constants
4. `tools/system_health_state.yaml` (cross-tool canonical mirror)

---

## Recent Rule-2 deploys (2026-05-04 → 2026-05-13)

These four deploys are why this file is being refreshed today. Read them top-to-bottom for the timeline.

### 2026-05-04 — Charlie ported to Production-style config
Charlie was previously a Production-mirror but on V1 (classifier stop, original mgmt, +0.5R coincident BE). On 2026-05-04 it was ported to the V2 code path (half-fib stop + V3 mgmt) with one differentiator: trail width set to **5%** (vs Production's then-5%, now 12%). Goal: have a Spotware-side variant tracking V2 behavior in parallel with the FTMO Free demo, so any V2 regressions surface on both rails simultaneously.

### 2026-05-08 — Production trail widened 5% → 12% (commit `c3bbe9a`)
After ~10 days of live V2 trading, the 5% trail was triggering exits on noise wicks during otherwise healthy moves. Widened to 12% to give the strategy more room to breathe through normal volatility. Charlie kept the 5% trail as the A/B counterpoint: same V2 stop/mgmt, different trail tightness.

### 2026-05-11 — Challenge ported to Delta-style config
Challenge was on V2 (half-fib stop + V3 mgmt + 5% trail). The Spotware demo Delta had been running V1 (classifier stop + original mgmt + 10% trail) successfully and the trader wanted to bring that profile to the funded-pathway account with one twist: trail widened to **24%** to maximize runway capture on what should be the highest-conviction setups (since Challenge has the smallest universe of approved entries). Impulse stayed `bundle_match` initially (matching Delta).

### 2026-05-12 — Challenge impulse reverted bundle_match → legacy_tight (commit `fcd187c`)
After ~24 hours on `bundle_match`, post-trade analysis showed the wider impulse leg was admitting setups whose pullback pattern was less geometrically clean than the legacy IBO_CONFIG `legacy_tight` profile produced. Reverted impulse to `legacy_tight` while keeping the rest of the Delta-style config (V1 classifier + original mgmt + 24% trail). Net: Challenge is now V1 + original mgmt + Trail 24% + legacy_tight impulse — a unique combination not run on any other variant.

### 2026-05-13 — Production FTMO Free credentials renewed
FTMO Free demo accounts expire every 14 days. The renewal swapped:
- `accountId` 47151641 → 47311022
- `displayId` (login) 17102428 → 17112322
- Account balance reset to fresh $100,000

The publisher (`tools/publish_to_supabase.py`) was updated in the same session to point at the new credentials; the dashboard's Production tile auto-heals from Supabase on the next publisher cron tick. The rotation is automated going forward via `tools/rotate_ftmo_free_credentials.sh` (built 2026-05-13) — runs every 14 days.

---

## Challenge — FTMO 2-Step Challenge (Step-1 target = 10%)

- **Account:** ctidTraderAccountId 47142181, login 7545753 (cTrader demo env, vs Production's live env). Same OAuth + bridge as Production; bridge auto-routes by accountId.
- **Started:** 2026-04-30. $900 fee paid. Step-1 profit target = 10% ($110k from $100k start).
- **Code path (CURRENT, post-2026-05-12):** **V1 classifier stop + original mgmt (+0.5R coincident BE / 30%@0.5R partial) + Trail 24% / 12R cap + `legacy_tight` impulse profile.** Ported from Delta on 2026-05-11; impulse reverted to legacy_tight on 2026-05-12.
- **Code path (ORIGINAL):** V2 half-fib stop + Phase 5 ON + V3 management (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + 5% trail. Replaced 2026-05-11.
- **Engine-wide gate=100** (deployed 2026-04-30): `_find_m10_entry` waits until 100+ M10 forward bars (~16.7h) past scan_ts before attempting entry detection.
- **Universe:** 61 syms · incl. ETHUSD (Phase C-1 enabled crypto class 2026-05-02).
- **Initial TP:** 1.272 Fib extension. Move to BE coincident with partial fire (per Delta-style original mgmt).
- **Stocks LIMIT entries** @ entry-bar open with 600s expiry (caps slippage on RTH tape).
- **Hard $90k static max-loss floor** (FTMO 2-Step rule). `MAX_FLOATING_RISK_PCT=0.045` and `MAX_POSITIONS_HARD_CAP=24` (Phase C-1 raise) are the binding caps.
- **Classifier `_sequence` pre-seeded** from 1+ year of cTrader bars on every restart (avoids cold-start IBO bias). Watchlist preserved across restarts via `load_watchlist_state`.

## Production — FTMO Free Demo (no profit target)

- **Account (CURRENT, 2026-05-13):** ctidTraderAccountId **47311022**, login **17112322**. Renewed every 14 days via `rotate_ftmo_free_credentials.sh`.
- **Account history:** 47151641/17102428 (replaced 2026-05-13 on FTMO Free renewal); 46992359/17092574 (replaced 2026-04-28 on prior renewal, commit `b889150`).
- **Purpose:** V2 / Plan A/B/C reference deployment — code path mirrors Charlie; this is the variant that practices the real-money trade path before the Challenge purchase.
- **Code path:** V2 half-fib stop + Phase 5 ON + V3 management (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + Trail 12% / 12R cap (widened 5% → 12% on 2026-05-08, commit `c3bbe9a`).
- **Impulse profile:** `legacy_tight` (IBO_CONFIG override).
- **Initial TP:** 1.272 Fib extension. Move to BE only after MFE crosses +1.0R (decoupled).
- **Stocks LIMIT entries** @ entry-bar open with 600s expiry.
- **Hard $90k static max-loss floor** (was trailing → death spiral; emergency fix `c9b791f`).
- **Classifier `_sequence` pre-seeded** on every restart from 1+ year of cTrader bars.
- **Universe:** 61 syms · incl ETHUSD (Phase C-1 enabled crypto class 2026-05-02).
- **`max_positions_hard_cap: 24`** (Phase C-1 raise from 15 on 2026-05-02). BE+ positions are 0R, so 4.5% floating cap is the binding gate; HARD_CAP only fires when >24 positions are profit-locked.
- **`max_per_symbol_risk_pct: 0.016`** (D-031 deploy 2026-05-07 — replaces hard-block; allows 2 concurrent positions per symbol).

## Alpha — Spotware Demo · CONTROL variant

- **Account:** Spotware paper 46915262, login 5797573 on `localhost:3101`.
- **Role:** A/B control variant — designed to measure trail-stop delta vs the rest of the fleet. **NO TRAIL.**
- **Code path:** V1 classifier stop + original mgmt (+0.5R coincident BE / 30%@0.5R partial).
- **Impulse profile:** `legacy_tight` (IBO_CONFIG override).
- **Universe:** 36 syms · includes ETHUSD.
- **Phase 1 risk dial (0.80%) IS active.**

## Bravo — Spotware Demo · forex-only specialist

- **Account:** Spotware paper 46915271, login 5797576.
- **Role:** Tests whether a focused forex universe outperforms PROD's mixed approach. Forex is 79% of backtest trades.
- **Code path:** V1 classifier stop + original mgmt.
- **Trail-C5:** ENABLED — after partial fires, trail activates at 60% of distance to TP, follows price by **10%**, capped at 12R. On activation, broker TP is amended FROM 1.272 Fib TO the 12R safety ceiling.
- **Impulse profile:** `legacy_tight`.
- **Universe:** 17 forex pairs (no stocks/indices/metals/commodities).
- **Phase 1 risk dial (0.80%) active.**

## Charlie — Spotware Demo · V2 mirror with tighter trail

- **Account:** Spotware paper 46915274, login 5797577.
- **Role (CURRENT, post-2026-05-04):** V2 reproducibility validator with a tighter trail than Production. Same V2 stop + mgmt + impulse as Production; differentiated only on trail width (5% vs Production's 12%) and the broker (Spotware demo vs FTMO Free demo).
- **Role (ORIGINAL):** V1 classifier stop + 10% trail; same Spotware code path as Bravo/Delta. Replaced 2026-05-04.
- **Code path (CURRENT):** V2 half-fib stop + V3 mgmt (+1.0R decoupled BE / 20%@0.6R partial) + Trail 5% / 12R cap.
- **Impulse profile:** `legacy_tight`.
- **Universe:** 35 syms.
- **Phase 1 risk dial (0.80%) active.**

## Delta — Spotware Demo · `bundle_match` impulse (only)

- **Account:** Spotware paper 46915276, login 5797579.
- **Role:** Mixed universe like Production, but the **only variant currently on `bundle_match` impulse profile** — primary A/B test dimension for the wide-leg / dataclass-defaults manifest vs the IBO_CONFIG-override `legacy_tight` profile that the other 5 run.
- **Code path:** V1 classifier stop + original mgmt (+0.5R coincident BE / 30%@0.5R partial) + Trail 10% / 12R cap.
- **Impulse profile:** **`bundle_match`** (only variant).
- **Universe:** 36 syms incl. ETHUSD.
- **Phase 1 risk dial (0.80%) active.**

---

## At-a-glance dimensional matrix (mirrors the dashboard table)

| Variant   | Stop         | BE/Partial mgmt           | Trail         | Impulse        | Universe                |
|-----------|--------------|---------------------------|---------------|----------------|-------------------------|
| Challenge | classifier   | original (+0.5R / 30%@0.5R) | C5 / 24%      | legacy_tight   | 61 syms · incl ETHUSD   |
| Production| half-fib     | V3 (+1.0R / 20%@0.6R)     | C5 / 12%      | legacy_tight   | 61 syms · incl ETHUSD   |
| Alpha     | classifier   | original (+0.5R / 30%@0.5R) | OFF           | legacy_tight   | 36 syms · incl ETHUSD   |
| Bravo     | classifier   | original (+0.5R / 30%@0.5R) | C5 / 10%      | legacy_tight   | 17 forex pairs          |
| Charlie   | half-fib     | V3 (+1.0R / 20%@0.6R)     | C5 / 5%       | legacy_tight   | 35 syms                 |
| Delta     | classifier   | original (+0.5R / 30%@0.5R) | C5 / 10%      | **bundle_match** | 36 syms · incl ETHUSD |

---

## Refresh checklist (per Rule-2 deploy)

When a Rule-2 deploy lands that changes per-variant state:

1. Update the relevant section above (account, code path, deploy commit hash, etc.).
2. Update the corresponding entry in `src/useSupabaseData.js` `VARIANT_CONFIG` if a structured field changed (account_type, target_pct, partial_*, be_move, risk_pct, stop_mode, trail, impulse_profile, universe_filter, etc.).
3. Bump the `Last refreshed:` date at the top of this file.
4. Add an entry to the "Recent Rule-2 deploys" timeline at the top so the change is discoverable.
5. Pair with a refresh of `tools/system_health_state.yaml` and `docs/process/ROADMAP.md` "Active deploys" in the FTMO_V4 repo (canonical state.yaml, narrative ROADMAP, dashboard mirror).

If a structured field changes (e.g., new `be_move` rule lands), the table column it feeds will update automatically — but the prose section above won't, so re-read this file as part of the deploy ritual.
