import type { ReactNode } from 'react';
import { fmt } from '../lib/data';

export function Section({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="card rise p-5 sm:p-6">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-white/45">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent = 'accent',
  big = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: 'accent' | 'accent-2' | 'pos' | 'neg' | 'amber';
  big?: boolean;
}) {
  const color = `var(--color-${accent})`;
  return (
    <div className="card rise relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-20 blur-2xl"
        style={{ background: color }}
      />
      <div className="text-[11px] font-medium uppercase tracking-widest text-white/40">{label}</div>
      <div
        className={`tnum mt-2 font-bold tracking-tight ${big ? 'text-4xl sm:text-5xl' : 'text-3xl'}`}
        style={{ color }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-sm text-white/50">{sub}</div>}
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'up' | 'down' | 'neutral' }) {
  const map = {
    up: 'text-pos bg-pos/10 border-pos/30',
    down: 'text-neg bg-neg/10 border-neg/30',
    neutral: 'text-white/60 bg-white/5 border-white/10',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[tone]}`}>
      {children}
    </span>
  );
}

export function multiple(r: number): string {
  if (!isFinite(r)) return '∞';
  if (r >= 10) return r.toFixed(0) + '×';
  return r.toFixed(1) + '×';
}

export function ChartTooltip({ active, payload, label, fmtLabel }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card !rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-semibold text-white/80">{fmtLabel ? fmtLabel(label) : label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-white/55">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color || p.stroke }} />
            {p.name}
          </span>
          <span className="tnum font-medium text-white">{fmt(Math.abs(p.value))}</span>
        </div>
      ))}
    </div>
  );
}
