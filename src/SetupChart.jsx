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
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";

const CHART_COLORS = {
  bg: "#0d0d18",
  grid: "#1f1f2f",
  text: "#888",
  upBody: "#4ade80",
  downBody: "#f87171",
  upWick: "#4ade80",
  downWick: "#f87171",
  // Annotation colors
  breakLevel: "#facc15",   // amber — the level price must cross
  stop: "#f87171",          // red
  target: "#4ade80",        // green
  fib786: "#a78bfa",        // purple
  impulseStart: "#60a5fa",  // blue
};

export default function SetupChart({ entry, height = 280 }) {
  const [tf, setTf] = useState("h4");
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
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
    addLine(entry?.targetPrice, CHART_COLORS.target, "Target");
    addLine(entry?.fib786, CHART_COLORS.fib786, "Fib 0.786");
    addLine(entry?.impulseStartPrice, CHART_COLORS.impulseStart, "Impulse start");

    // Fit content to the new data
    chartRef.current.timeScale().fitContent();
  }, [candles, entry, hasData]);

  const tfBtn = (key, label) => {
    const active = tf === key;
    return (
      <button
        key={key}
        onClick={() => setTf(key)}
        style={{
          background: active ? "#2a2a3e" : "transparent",
          color: active ? "#e0e0e0" : "#666",
          border: `1px solid ${active ? "#444" : "#1f1f2f"}`,
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
    <div style={{ background: CHART_COLORS.bg, borderRadius: 8, border: "1px solid #1f1f2f", padding: 8, minWidth: 0 }}>
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
