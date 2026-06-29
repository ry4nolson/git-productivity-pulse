import { useMemo } from 'react';
import type { WeekPoint } from '../lib/types';
import { heatmap } from '../lib/data';

function color(c: number, max: number): string {
  if (c <= 0) return 'rgba(255,255,255,0.04)';
  const t = Math.min(1, Math.log(c + 1) / Math.log(max + 1));
  // interpolate cyan -> violet by intensity
  const r = Math.round(110 + (167 - 110) * t);
  const g = Math.round(231 + (139 - 231) * t);
  const b = Math.round(255 + (250 - 255) * t);
  const a = 0.25 + 0.75 * t;
  return `rgba(${r},${g},${b},${a})`;
}

export function Heatmap({ weeks, markerYear, markerWeek }: { weeks: WeekPoint[]; markerYear: number; markerWeek: number }) {
  const rows = useMemo(() => heatmap(weeks), [weeks]);
  const max = useMemo(() => Math.max(1, ...weeks.map((w) => w.commits)), [weeks]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="flex items-center gap-2">
          <div className="w-10" />
          <div className="grid flex-1 text-[10px] text-white/30" style={{ gridTemplateColumns: 'repeat(53, minmax(0, 1fr))' }}>
            {Array.from({ length: 12 }).map((_, m) => (
              <div key={m} style={{ gridColumn: `${Math.round((m * 53) / 12) + 1} / span 4` }}>
                {new Date(Date.UTC(2020, m, 1)).toLocaleString('en-US', { month: 'short' })}
              </div>
            ))}
          </div>
        </div>
        {rows.map((row) => {
          const cellsByWeek = new Map(row.cells.map((c) => [c.week, c]));
          return (
            <div key={row.year} className="mt-1 flex items-center gap-2">
              <div className="w-10 text-right text-[11px] font-medium text-white/45">{row.year}</div>
              <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: 'repeat(53, minmax(0, 1fr))' }}>
                {Array.from({ length: 53 }).map((_, wk) => {
                  const cell = cellsByWeek.get(wk);
                  const isMarker = row.year === markerYear && wk === markerWeek;
                  return (
                    <div
                      key={wk}
                      title={cell ? `${cell.date}: ${cell.commits} commits` : ''}
                      className="aspect-square rounded-[3px]"
                      style={{
                        background: color(cell?.commits ?? 0, max),
                        outline: isMarker ? '1.5px solid var(--color-amber)' : undefined,
                        outlineOffset: isMarker ? '1px' : undefined,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-white/40">
          <span>less</span>
          {[0, 1, 3, 8, max].map((c, i) => (
            <span key={i} className="h-3 w-3 rounded-[3px]" style={{ background: color(c, max) }} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}
