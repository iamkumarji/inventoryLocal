"use client";

import { format, parseISO } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { formatDecimal } from "@/lib/api/finance";

type Point = { month: string; demand: string };

/** Rounds the axis maximum up to 1, 2 or 5 × 10^n so gridlines land on readable values. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/**
 * Monthly demand history (solid) with the level forecast (dashed), hand-drawn in SVG.
 * Quantities are converted to numbers only to place marks on screen; labels show the API's figures.
 */
export function ForecastChart({ history, forecast, unitLabel = "Demand" }: { history: Point[]; forecast: Point[]; unitLabel?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = [...history.map((p) => ({ ...p, kind: "history" as const })), ...forecast.map((p) => ({ ...p, kind: "forecast" as const }))];
  const height = 240;
  const m = { top: 16, right: 16, bottom: 28, left: 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => Number(p.demand))));
  const x = (i: number) => m.left + (points.length <= 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: string) => m.top + innerH - (Math.max(0, Number(v)) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 56))));
  const path = (pts: { i: number; demand: string }[]) => pts.map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.demand).toFixed(1)}`).join(" ");
  const hist = points.map((p, i) => ({ ...p, i })).filter((p) => p.kind === "history");
  const fc = points.map((p, i) => ({ ...p, i })).filter((p) => p.kind === "forecast");
  const bridge = hist.length && fc.length ? [hist[hist.length - 1], ...fc] : fc;

  const onMove = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const px = clientX - rect.left - m.left;
    const i = Math.round((px / innerW) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <figure className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1.5"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="var(--chart-1)" strokeWidth="2" /></svg>Actual demand</span>
        <span className="flex items-center gap-1.5"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="var(--chart-3)" strokeWidth="2" strokeDasharray="4 3" /></svg>Forecast</span>
      </div>
      <div ref={wrap} className="relative w-full min-w-0 overflow-hidden touch-none select-none"
        onPointerMove={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={`${unitLabel} by month: ${history.length} months of history and ${forecast.length} forecast months`} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(String(t))} y2={y(String(t))} stroke="var(--border)" strokeWidth="1" />
              <text x={m.left - 8} y={y(String(t))} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted-foreground)" className="num">{formatDecimal(t, { dp: t < 10 && max < 10 ? 1 : 0 })}</text>
            </g>
          ))}
          {fc.length > 0 && <rect x={x(fc[0].i) - (innerW / Math.max(1, points.length - 1)) / 2} y={m.top} width={width - m.right - x(fc[0].i) + (innerW / Math.max(1, points.length - 1)) / 2} height={innerH} fill="var(--muted)" opacity="0.5" />}
          {points.map((p, i) => i % labelEvery === 0 && (
            <text key={p.month} x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">{format(parseISO(p.month), points.length > 12 ? "MMM yy" : "MMM")}</text>
          ))}
          {hp && <line x1={x(hover!)} x2={x(hover!)} y1={m.top} y2={m.top + innerH} stroke="var(--foreground)" strokeOpacity="0.35" strokeWidth="1" />}
          <path d={path(hist)} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <path d={path(bridge)} fill="none" stroke="var(--chart-3)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
          {points.map((p, i) => (
            <circle key={p.month} cx={x(i)} cy={y(p.demand)} r={hover === i ? 5 : 3.5} fill={p.kind === "history" ? "var(--chart-1)" : "var(--chart-3)"} stroke="var(--card)" strokeWidth="2" />
          ))}
        </svg>
        {hp && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: Math.min(width - 150, Math.max(0, x(hover!) + 10)) }}>
            <p className="num text-sm font-semibold">{formatDecimal(hp.demand, { dp: 2 })}</p>
            <p className="text-muted-foreground">{format(parseISO(hp.month), "MMMM yyyy")} · {hp.kind === "history" ? "actual" : "forecast"}</p>
          </div>
        )}
      </div>
    </figure>
  );
}
