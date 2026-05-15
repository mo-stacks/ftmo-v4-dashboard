// Lazy-fetch hook for watchlist setup-chart candles.
//
// Background: on 2026-05-11 the publisher stripped candles from
// account_state.watchlist[].candles to fix Supabase egress overage
// (was 13.28 GB / 5 GB free-tier limit). Bulk-poll payload dropped
// 92%, but inline watchlist setup-charts went dark.
//
// On 2026-05-15 the engine session shipped a per-symbol candle cache
// (table: symbol_candles_cache) + a SECURITY DEFINER Postgres function
// (get_watchlist_candles(p_variant, p_symbol)) so the dashboard can
// fetch candles on-demand when a watchlist row expands. This file is
// the dashboard-side hook that calls that function.
//
// Per-expansion cost: ~10 KB gzipped. Operator typically expands 5-10
// rows per session × ~5 sessions/day = ~500 KB/day → ~15 MB/month.
// Negligible vs the 5 GB monthly cap.
//
// Architecture:
//   - Module-level Map cache keyed by `${variant}::${symbol}`
//   - 5-minute TTL — fresh enough for a setup-chart preview
//   - In-flight dedupe so simultaneous expands of the same row
//     don't double-fetch
//   - Fail-soft: any error → returns empty candles (chart shows
//     "no data" empty state, not a crash)

import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// 5-min TTL — long enough that collapse + re-expand within a session
// reuses the cached payload, short enough that a stale preview gets
// refreshed if the user comes back to the symbol later in the day.
const TTL_MS = 5 * 60 * 1000;

// Module-level state — shared across all WatchlistDetailPanel instances.
// Map<key, { candles, fetchedAt }> for the cache.
// Map<key, Promise> for in-flight dedupe.
const cache    = new Map();
const inFlight = new Map();

const cacheKey = (variant, symbol) => `${variant}::${symbol}`;

async function fetchCandles(variant, symbol) {
  const key = cacheKey(variant, symbol);

  // Cache hit (within TTL) → return immediately
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < TTL_MS) {
    return cached.candles;
  }

  // In-flight dedupe — if another expansion is already fetching this
  // (variant, symbol), reuse the same promise instead of firing a
  // second RPC.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  // Fresh fetch via Supabase RPC
  const promise = (async () => {
    try {
      const { data, error } = await supabase.rpc("get_watchlist_candles", {
        p_variant: variant,
        p_symbol:  symbol,
      });
      if (error) {
        // Common case during transition window: function doesn't exist yet
        // (engine session hasn't run the migration). Log once, return empty
        // — dashboard renders the empty state, no crash, no spam.
        // eslint-disable-next-line no-console
        console.warn(`[useWatchlistCandles] RPC error for ${symbol}:`, error.message);
        return {};
      }
      // Function returns the JSONB blob directly: {h4:[...], m10:[...]}
      // (or null if not yet cached for this symbol — publisher hasn't
      // hit it yet). Normalize null → {} so downstream `?.h4 ?? []`
      // patterns work uniformly.
      const candles = data ?? {};
      cache.set(key, { candles, fetchedAt: Date.now() });
      return candles;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[useWatchlistCandles] fetch failed for ${symbol}:`, err);
      return {};
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Hook: fetch + cache watchlist setup-chart candles for a single
 * (variant, symbol) pair. Fires lazily — only when the panel renders
 * (i.e. when the user expands a watchlist row).
 *
 * Returns: { candles, loading }
 *   - candles: { h4: [...], m10: [...] } (empty {} until fetched)
 *   - loading: true while the RPC is in-flight on the first call
 *
 * If the underlying RPC fails (function doesn't exist, network error,
 * etc.), candles is returned as {} and loading flips to false. The
 * SetupChart component already handles missing candles gracefully.
 */
export function useWatchlistCandles(variant, symbol) {
  const key = (variant && symbol) ? cacheKey(variant, symbol) : null;
  const cachedHit = key ? cache.get(key) : null;
  const initialCandles = (cachedHit && (Date.now() - cachedHit.fetchedAt) < TTL_MS)
    ? cachedHit.candles
    : {};
  const [candles, setCandles] = useState(initialCandles);
  const [loading, setLoading] = useState(!cachedHit && !!key);

  useEffect(() => {
    if (!variant || !symbol) {
      setCandles({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchCandles(variant, symbol).then((c) => {
      if (cancelled) return;
      setCandles(c);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [variant, symbol]);

  return { candles, loading };
}

/**
 * Test-only / debug helper: clear the in-memory cache. Not exported
 * for production use — TTL handles staleness automatically.
 */
export function _clearCache() {
  cache.clear();
  inFlight.clear();
}
