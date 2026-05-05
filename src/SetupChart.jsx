/* SetupChart — lazy-loaded TradingView Lightweight Chart for a watchlist
   setup. Renders H4 or M10 candles (toggle), with horizontal price lines
   at the engine's reference levels (impulse extreme, stop, target,
   fib 0.786). The chart is dark-themed to match the dashboard.

   Data source: each watchlist entry on Supabase carries a `candles`
   object shaped like:
     { h4: [{t, o, h, l, c}, ...], m10: [{t, o, h, l, c}, ...] }
   `t` is unix seconds (UTC). Empty arrays render an honest empty-state
   message rather than a broken chart. The engine-side publishing of
   this field is tracked in SESSION_HANDOFF Watchlist Setup-Chart.

   Lazy import keeps lightweight-charts (~150KB) out of the initial
   dashboard bundle. The library only loads when a user expands a
   watchlist row AND the row has candle data. */

import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from "lightweight-charts";

// Palette aligned with the rest of the dashboard (and with the
// ICS-V2 investor presentation). See index.css + App.jsx for the
// project-wide tokens.
const CHART_COLORS = {
  bg: "#0a0a10",
  grid: "#1a1a26",
  text: "#888",
  upBody: "#22b89a",
  downBody: "#cf5b5b",
  upWick: "#22b89a",
  downWick: "#cf5b5b",
  // Annotation colors
  breakLevel: "#cfb95b",   // gold — the level price must cross
  stop: "#cf5b5b",          // red — classifier-time stop estimate
  projectedStop: "#f59e0b", // amber — projected fire-time stop (V2 pivot_half_fib)
  target: "#22b89a",        // green
  fib786: "#a78bfa",        // purple
  impulseStart: "#7eb4fa",  // blue
  entry: "#7eb4fa",         // blue — entry-price line (position panels)
};

export default function SetupChart({
  entry,
  height = 280,
  // Optional: unix-seconds time to center the visible range on. When set,
  // the chart pans to a window around this time instead of defaulting to
  // the most recent bars. Used by TradeDetailPanel to focus on the
  // entry-to-exit window of a closed trade.
  focusTime = null,
  // Optional series markers (entry/exit dots for closed trades).
  // Each item: { time: unix-seconds, position, color, shape, text }
  markers = null,
}) {
  const [tf, setTf] = useState("h4");
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  // Ref read from inside the chart's autoscaleInfoProvider so it always
  // has the freshest annotation prices without re-creating the chart on
  // every entry change.
  const annotationPricesRef = useRef([]);
  const markersRef = useRef(null); // primitive returned by createSeriesMarkers
  const [empty, setEmpty] = useState(false);

  // Pull candles for the selected timeframe. Defensive against missing/null.
  const candles = entry?.candles?.[tf] ?? [];
  const hasData = Array.isArray(candles) && candles.length > 0;

  // Mount/unmount the chart with the container.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: "solid", color: CHART_COLORS.bg },
        textColor: CHART_COLORS.text,
        fontSize: 10,
      },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: CHART_COLORS.grid,
      },
      rightPriceScale: {
        borderColor: CHART_COLORS.grid,
        // 18% padding above and below the auto-scaled price range so the
        // setup (and its annotation lines) sit comfortably away from the
        // top/bottom edges of the chart canvas.
        scaleMargins: { top: 0.18, bottom: 0.18 },
      },
      crosshair: {
        mode: 1, // magnet
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.upBody,
      downColor: CHART_COLORS.downBody,
      borderUpColor: CHART_COLORS.upBody,
      borderDownColor: CHART_COLORS.downBody,
      wickUpColor: CHART_COLORS.upWick,
      wickDownColor: CHART_COLORS.downWick,
    });

    // Auto-scale provider — extends the auto-computed price range to
    // include all annotation prices, so stop/target/break lines never
    // fall off the top or bottom of the chart even when they sit
    // outside the visible candle range. Reads the current entry from
    // a ref so this provider closure always sees the latest annotations.
    series.applyOptions({
      autoscaleInfoProvider: (originalProvider) => {
        const orig = originalProvider();
        if (!orig?.priceRange) return orig;
        const ann = annotationPricesRef.current || [];
        let { minValue, maxValue } = orig.priceRange;
        for (const p of ann) {
          if (p == null || isNaN(p)) continue;
          if (p < minValue) minValue = p;
          if (p > maxValue) maxValue = p;
        }
        return {
          priceRange: { minValue, maxValue },
          // Pixel-level padding on top of the % scaleMargins above —
          // gives annotation labels (Stop / Target / Break ▲) breathing
          // room from the chart edges.
          margins: { above: 18, below: 18 },
        };
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Resize on container width changes
    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (markersRef.current) {
        try { markersRef.current.detach(); } catch (_) { /* noop */ }
        markersRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  // Apply candles + annotations whenever timeframe or entry changes
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    if (!hasData) {
      seriesRef.current.setData([]);
      setEmpty(true);
      return;
    }
    setEmpty(false);

    // Lightweight-charts expects time as Unix-seconds; sort ascending and
    // dedupe just in case the publisher sends overlapping windows.
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    const seen = new Set();
    const data = sorted.flatMap(c => {
      if (seen.has(c.t)) return [];
      seen.add(c.t);
      return [{ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }];
    });
    seriesRef.current.setData(data);

    // Clear any prior price lines (reattach fresh each render)
    // Lightweight-charts v5: priceLines created via createPriceLine return
    // handles we have to track. We re-create the series instead — simpler.
    // For incremental: remove via series.removePriceLine(handle).
    // Here we just track with a local array on the series.
    const series = seriesRef.current;
    if (series._annotations) {
      series._annotations.forEach(h => series.removePriceLine(h));
    }
    series._annotations = [];

    const addLine = (price, color, title) => {
      if (price == null || isNaN(price)) return;
      const handle = series.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title,
      });
      series._annotations.push(handle);
    };

    // The break level is the engine's reference for entry — for IBO it's
    // the impulse extreme; for CBO the engine's pivot is at-or-inside that
    // extreme. We show impulse_end_price as a stand-in until the engine
    // persists candidate_break_level (then prefer that).
    const breakLevel = entry?.candidateBreakLevel ?? entry?.impulseEndPrice;
    addLine(breakLevel, CHART_COLORS.breakLevel,
            entry?.direction === "bullish" ? "Break ▲" : "Break ▼");
    addLine(entry?.stopPrice, CHART_COLORS.stop, "Stop");
    // 2026-05-04: Projected fire-time stop for V2 pivot_half_fib variants.
    // Computed in App.jsx WatchlistDetailPanel via computeProjectedStop()
    // and passed through as `entry.projectedStopPrice`. Amber dashed line
    // sits closer to the candidate break than the red classifier Stop —
    // visually shows how much tighter the actual fire will be vs the
    // looser watchlist-time estimate.
    addLine(entry?.projectedStopPrice, CHART_COLORS.projectedStop, "Proj. Stop");
    addLine(entry?.targetPrice, CHART_COLORS.target, "Target");
    addLine(entry?.fib786, CHART_COLORS.fib786, "Fib 0.786");
    addLine(entry?.impulseStartPrice, CHART_COLORS.impulseStart, "Impulse start");
    // 2026-05-03: position-panel charts pass entryPrice. Watchlist
    // entries don't (they have no entry yet — entry is what we WAIT
    // for). For position charts the impulse*/break/fib786 props are
    // null, so this is the only annotation between Stop and Target.
    addLine(entry?.entryPrice, CHART_COLORS.entry, "Entry");

    // Sync the autoscale provider's annotation list and trigger a
    // re-scale so the chart fits both candles AND annotation lines
    // with the configured margins.
    annotationPricesRef.current = [
      breakLevel,
      entry?.stopPrice,
      entry?.projectedStopPrice,
      entry?.targetPrice,
      entry?.fib786,
      entry?.impulseStartPrice,
      entry?.entryPrice,
    ].filter(p => p != null && !isNaN(p));
    series.priceScale().applyOptions({ autoScale: true });

    // Series markers (entry/exit dots for closed-trade charts).
    // Uses lightweight-charts v5 createSeriesMarkers primitive — created
    // lazily on first non-null markers prop, then setMarkers() to update.
    if (markers && Array.isArray(markers) && markers.length > 0) {
      // Lightweight-charts requires markers to be sorted by time ascending.
      const sortedMarkers = [...markers].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      if (!markersRef.current) {
        markersRef.current = createSeriesMarkers(series, sortedMarkers);
      } else {
        markersRef.current.setMarkers(sortedMarkers);
      }
    } else if (markersRef.current) {
      markersRef.current.setMarkers([]);
    }

    // Pan logic — two modes:
    //   focusTime mode: center on the given timestamp (used by the
    //     TradeDetailPanel chart for closed trades — show the entry-to-
    //     exit window, not the most recent bars)
    //   default mode: pan right to show the most recent ~40 (H4) or
    //     ~60 (M10) bars (used for live watchlist + open positions)
    const totalBars = data.length;
    if (totalBars > 0) {
      const ts = chartRef.current.timeScale();
      const halfWindow = tf === "h4" ? 25 : 40;
      if (focusTime) {
        // Find the bar index closest to focusTime (or the markers'
        // earliest time if focusTime falls outside the loaded window)
        let targetIdx = -1;
        for (let i = 0; i < data.length; i++) {
          if (data[i].time >= focusTime) { targetIdx = i; break; }
        }
        if (targetIdx === -1) targetIdx = data.length - 1;
        ts.setVisibleLogicalRange({
          from: Math.max(0, targetIdx - halfWindow),
          to: Math.min(totalBars - 1 + 5, targetIdx + halfWindow),
        });
      } else {
        const visibleBars = tf === "h4" ? 40 : 60;
        ts.setVisibleLogicalRange({
          from: Math.max(0, totalBars - visibleBars),
          to: totalBars - 1 + 5, // small right padding
        });
      }
    }
  }, [candles, entry, hasData, tf, focusTime, markers]);

  const tfBtn = (key, label) => {
    const active = tf === key;
    return (
      <button
        key={key}
        onClick={() => setTf(key)}
        style={{
          background: active ? "#22222e" : "transparent",
          color: active ? "#e0e0ea" : "#666",
          border: `1px solid ${active ? "#444" : "#1a1a26"}`,
          borderRadius: 4,
          padding: "3px 10px",
          fontSize: 10,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div style={{ background: CHART_COLORS.bg, borderRadius: 8, border: "1px solid #1a1a26", padding: 8, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 10, color: "#666", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
          {entry?.symbol} chart
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {tfBtn("h4", "H4")}
          {tfBtn("m10", "M10")}
        </div>
      </div>
      <div ref={containerRef} style={{ width: "100%", minWidth: 0, position: "relative" }}>
        {empty && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "#555", fontSize: 11, fontStyle: "italic", textAlign: "center", padding: 16,
            pointerEvents: "none",
          }}>
            No {tf.toUpperCase()} candle data yet — engine publishing pending.
          </div>
        )}
      </div>
    </div>
  );
}
