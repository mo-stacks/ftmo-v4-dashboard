# Variant State — full per-variant deploy notes

**Last refreshed:** 2026-05-14 (post C-revert)
**Refresh policy:** edit this file on every Rule-2 deploy that changes per-variant behavior. Pair with a `useSupabaseData.js` `VARIANT_CONFIG` field update if a structured field changes.

The dashboard's "Variant Configuration" table renders only structured at-a-glance fields. The prose below is the full deploy state, rationale, and code-path lineage for each variant — kept here so the dashboard table doesn't become a wall of text.

Source-of-truth precedence:
1. Running engine startup banner (Rule-1 ground truth)
2. `config_*.yaml` in the FTMO_V4 repo
3. `engine/run_live.py` hardcoded constants
4. `tools/system_health_state.yaml` (cross-tool canonical mirror)

---

## Recent Rule-2 deploys (2026-05-04 → 2026-05-14)

Read top-to-bottom for the timeline.

### 2026-05-04 — Charlie ported to Production-style config
Charlie was previously a Production-mirror but on V1 (classifier stop, original mgmt, +0.5R coincident BE). Ported to V2 code path (half-fib stop + V3 mgmt) with one differentiator: trail width set to 5% (vs Production's then-5%, now 12%). Goal: have a Spotware-side variant tracking V2 behavior in parallel with the FTMO Free demo.

### 2026-05-08 — Production trail widened 5% → 12% (commit `c3bbe9a`)
After ~10 days of live V2 trading, the 5% trail was triggering exits on noise wicks. Widened to 12% to give the strategy more room to breathe. Charlie kept the 5% trail as the A/B counterpoint.

### 2026-05-11 — Challenge ported to Delta-style config (later reverted)
Briefly ported to V1 classifier + original mgmt + 24% trail + bundle_match impulse. Saw mixed results.

### 2026-05-12 — Challenge impulse reverted bundle_match → legacy_tight (commit `fcd187c`)
Interim adjustment after the May 11 port. Kept V1 wrapper.

### 2026-05-13 — Production FTMO Free credentials renewed
FTMO Free demo accounts expire every 14 days. Swapped accountId 47151641 → **47311022**, displayId 17102428 → **17112322**. Automated going forward via `tools/rotate_ftmo_free_credentials.sh`.

### 2026-05-14 — C-REVERT: Challenge back to canonical V2+V3+bundle_match (commit `882330e`)
**THE major change.** Challenge reverted from the May 11 Delta-config port (V1 + original + legacy_tight + 24% trail) back to the canonical config the project has been building toward: **V2 half-fib + V3 mgmt + bundle_match + 12% trail**. Now forms a clean **impulse-only A/B vs PROD** — identical wrapper (half-fib + V3 + Trail 12% + RISK-BASED 8%), only differentiator is `bundle_match` (Challenge) vs `legacy_tight` (PROD).

### 2026-05-14 — Plan A''' Option α: widened safety buffers (all 6 engines)
Daily-DD pause buffer **$500 → $1,500** above the FTMO daily floor. Emergency close buffer **$400 → $1,000** above the floor. Gives ~3× more runway to react before the actual breach. Specific per-variant absolute thresholds visible on the Daily DD bar in the dashboard.

### 2026-05-14 — Spotware Q-gate raised 58 → 63 (Alpha/Bravo/Charlie/Delta)
PROD and Challenge stay at 58 (FTMO accounts have less margin for noise). Spotware demos run a higher quality bar (63) — fewer signals admitted, higher per-signal precision.

### 2026-05-14 — Floating-risk cap split: PROD/Challenge 4.5% → 8.0% (Charlie unchanged at 4.5%)
PROD and Challenge moved to RISK-BASED with 8% floating cap (paired with the wider Plan A''' buffers gives them runway to size into setups). Charlie kept on RISK-BASED 4.5% as the narrow-cap A/B counterpart. Alpha/Bravo/Delta on COUNT-BASED (5 active / 8 hard ceiling).

### 2026-05-14 — New engine code paths active (informational)
- **C1 direction-conflict filter** — refuses new entries when an opposite-direction position is already open on the same symbol. Emits `GATE_DECISION` shadow_trades events with `reason=direction_conflict`.
- **C2 impulse-profile-change detection** — drops watchlist on engine restart if `impulse_profile_name` marker differs from current YAML. Prevents stale watchlist confusion across config changes.
- Delta watchlist ported to Challenge (avoids 16.7h cold-start).

---

## Challenge — FTMO 2-Step Challenge (Step-1 target = 10%)

- **Account:** ctidTraderAccountId `47142181`, login `7545753` (cTrader demo env, vs PROD's live env). Same OAuth + bridge as Production; bridge auto-routes by accountId.
- **Started:** 2026-04-30. $900 fee paid. Step-1 profit target = 10% ($110k from $100k start).
- **Code path (CURRENT, post-2026-05-14 C-revert):** **V2 half-fib stop + Phase 5 ON + V3 management (D2 BE-decouple @1.0R + D3 partial 20%@0.6R) + Trail 12% / 12R cap + `bundle_match` impulse profile.** Forms clean impulse-only A/B vs PROD.
- **Code path history:** Original V2 (April) → V1 Delta-style port (May 11) → V1 + legacy_tight (May 12) → reverted to V2+V3+bundle_match (May 14).
- **Engine-wide gate=100** (deployed 2026-04-30): `_find_m10_entry` waits until 100+ M10 forward bars (~16.7h) past scan_ts before attempting entry detection.
- **Universe:** `ftmo_full` (74 syms minus exclusions; incl. ETHUSD).
- **Initial TP:** 1.272 Fib extension. Move to BE only after MFE crosses +1.0R (decoupled).
- **Stocks LIMIT entries** @ entry-bar open with 600s expiry.
- **Hard $90k static max-loss floor** (FTMO 2-Step rule). RISK-BASED slot mode: 8.0% floating cap, 1.60% per-symbol cap, 24-position hard ceiling.
- **Plan A''' thresholds:** pause at day_start − $3,500, emergency at day_start − $4,000.
- **Day start (Prague, 2026-05-14):** $96,159. Daily floor $91,159 / Pause $92,659 / Emergency $92,159.

## Production — FTMO Free Demo (no profit target)

- **Account (CURRENT, 2026-05-13):** ctidTraderAccountId **`47311022`**, login **`17112322`**. Renewed every 14 days via `rotate_ftmo_free_credentials.sh`.
- **Account history:** 47151641/17102428 (replaced 2026-05-13); 46992359/17092574 (replaced 2026-04-28).
- **Purpose:** V2 / Plan A/B/C reference deployment — identical wrapper to Charlie + Challenge; this is the variant that practices the real-money trade path.
- **Code path:** V2 half-fib stop + Phase 5 ON + V3 management (+1.0R decoupled BE / 20%@0.6R partial) + Trail 12% / 12R cap (widened 5% → 12% on 2026-05-08, commit `c3bbe9a`).
- **Impulse profile:** `legacy_tight` (IBO_CONFIG override) — the only non-bundle_match dimension vs Challenge.
- **Slot mode:** RISK-BASED, 8.0% floating-risk cap (widened from 4.5% on 2026-05-14 alongside Plan A'''), 1.60% per-symbol cap, 24-position hard ceiling.
- **Universe:** `ftmo_full` (74 syms − exclusions; incl. ETHUSD).
- **Plan A''' thresholds:** pause at day_start − $3,500, emergency at day_start − $4,000.
- **Day start (Prague, 2026-05-14):** $100,295. Daily floor $95,295 / Pause $96,795 / Emergency $96,295.
- **Pre-midnight cut:** -$3,500 floating at 23:00 CET. Trailing floor $90,000 (FTMO 2-Step STATIC).

## Alpha — Spotware Demo · CONTROL variant (no trail)

- **Account:** Spotware paper `46915262`, login `5797573` on `localhost:3101`.
- **Role:** A/B control variant — measures trail-stop delta vs the rest of the fleet. **NO TRAIL.**
- **Code path:** V1 classifier stop + original mgmt (+0.5R coincident BE / 30%@0.5R partial).
- **Impulse profile:** `legacy_tight`.
- **Quality gate:** 63 (Spotware bar — higher than PROD/Challenge's 58).
- **Slot mode:** COUNT-BASED, 5 max positions / 8 hard ceiling.
- **Universe:** `spotware_full` (36 syms · includes ETHUSD).

## Bravo — Spotware Demo · forex-only specialist

- **Account:** Spotware paper `46915271`, login `5797576`.
- **Role:** Tests whether a focused forex universe outperforms PROD's mixed approach.
- **Code path:** V1 classifier + original mgmt.
- **Trail-C5:** ENABLED — activate 60% / trail 10% / 12R cap.
- **Impulse profile:** `legacy_tight`.
- **Quality gate:** 63.
- **Slot mode:** COUNT-BASED, 5 max / 8 hard.
- **Universe:** `forex_only` (17 forex pairs).

## Charlie — Spotware Demo · narrow-trail / narrow-cap A/B

- **Account:** Spotware paper `46915274`, login `5797577`.
- **Role:** V2+V3 reproducibility validator with two differentiators vs PROD: tighter trail (5% vs PROD 12%) AND narrower floating-risk cap (4.5% vs PROD 8%). Same Spotware platform as Alpha/Bravo/Delta but on V2+V3 wrapper.
- **Code path:** V2 half-fib + V3 mgmt (+1.0R decoupled BE / 20%@0.6R partial) + Trail 5% / 12R cap.
- **Impulse profile:** `legacy_tight`.
- **Quality gate:** 63.
- **Slot mode:** RISK-BASED, **4.5%** floating-risk cap (kept narrow as A/B vs PROD/Challenge's 8%), 1.60% per-symbol cap, 24-position hard ceiling.
- **Universe:** `spotware_full` (36 syms).

## Delta — Spotware Demo · V1 + bundle_match (the live wrapper-A/B)

- **Account:** Spotware paper `46915276`, login `5797579`.
- **Role:** Distinct from Challenge's bundle_match deployment because Delta is **V1 wrapper + bundle_match** while Challenge is **V2+V3 wrapper + bundle_match**. The two together form a wrapper-on-bundle_match comparison.
- **Code path:** V1 classifier + original mgmt (+0.5R coincident BE / 30%@0.5R partial) + Trail 10% / 12R cap.
- **Impulse profile:** `bundle_match`.
- **Quality gate:** 63.
- **Slot mode:** COUNT-BASED, 5 max / 8 hard.
- **Universe:** `spotware_full` (36 syms · incl. ETHUSD).

---

## At-a-glance dimensional matrix (mirrors the dashboard table)

| Variant | Stop | Mgmt | Trail | Impulse | Slot | Q-gate |
|---|---|---|---|---|---|---|
| **Challenge** | half-fib | V3 (+1.0R / 20%@0.6R) | C5 / 12% | **bundle_match** | RISK 8% | 58 |
| **Production** | half-fib | V3 (+1.0R / 20%@0.6R) | C5 / 12% | legacy_tight | RISK 8% | 58 |
| Alpha | classifier | original (+0.5R / 30%@0.5R) | OFF | legacy_tight | COUNT 5 | 63 |
| Bravo | classifier | original (+0.5R / 30%@0.5R) | C5 / 10% | legacy_tight | COUNT 5 | 63 |
| Charlie | half-fib | V3 (+1.0R / 20%@0.6R) | C5 / 5% | legacy_tight | RISK 4.5% | 63 |
| Delta | classifier | original (+0.5R / 30%@0.5R) | C5 / 10% | **bundle_match** | COUNT 5 | 63 |

**Active A/Bs** post-2026-05-14:
- **Impulse-only**: Challenge (bundle_match) vs PROD (legacy_tight) — identical wrapper (half-fib + V3 + Trail 12% + RISK 8%)
- **Wrapper-on-bundle_match**: Challenge (V2+V3) vs Delta (V1 + original)
- **Trail-width**: PROD (12%) vs Charlie (5%) — same V2+V3 wrapper, same impulse, narrower cap
- **Floating-risk cap**: PROD/Challenge (8%) vs Charlie (4.5%) — same wrapper, same impulse
- **Trail vs no-trail control**: Alpha (no trail) vs Bravo/Delta (10% trail) — same V1 + original wrapper

---

## Plan A''' Option α — safety buffers (all 6 variants)

Engine pauses trading at `day_start − $3,500` (= daily floor + $1,500 buffer) and emergency-closes positions at `day_start − $4,000` (= daily floor + $1,000 buffer). Both buffers widened from the prior $500/$400 on 2026-05-14.

Per-variant absolute $ thresholds are derived in the dashboard from `dayStartBalance` and rendered under the Daily DD bar. The buffers themselves are constants — same value across all 6 engines.

---

## Refresh checklist (per Rule-2 deploy)

1. Update the relevant section above (account, code path, deploy commit hash, etc.).
2. Update the corresponding entry in `src/useSupabaseData.js` `VARIANT_CONFIG` if a structured field changed.
3. Bump the `Last refreshed:` date at the top of this file.
4. Add an entry to the "Recent Rule-2 deploys" timeline.
5. Update the dimensional matrix at the bottom + Active A/Bs list.
6. Pair with a refresh of `tools/system_health_state.yaml` and `docs/process/ROADMAP.md` "Active deploys" in the FTMO_V4 repo.

If a structured field changes, the dashboard's table column it feeds will update automatically — but the prose section above won't, so re-read this file as part of the deploy ritual.
