import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Dataset, WeekPoint } from '../lib/types';
import { fmt, rolling } from '../lib/data';
import { ChartTooltip } from './primitives';

const AXIS = { fontSize: 11, fill: 'rgba(255,255,255,0.4)' };
const GRID = 'rgba(255,255,255,0.06)';

function yearTicks(weeks: WeekPoint[]): number[] {
  const ticks: number[] = [];
  let last = '';
  for (const w of weeks) {
    const y = w.date.slice(0, 4);
    if (y !== last) {
      ticks.push(w.week);
      last = y;
    }
  }
  return ticks;
}

const labelDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function MarkerLine({ marker }: { marker: number }) {
  return (
    <ReferenceLine
      x={marker}
      stroke="var(--color-amber)"
      strokeDasharray="4 4"
      strokeWidth={1.5}
      label={{ value: 'AI', position: 'top', fill: 'var(--color-amber)', fontSize: 11, fontWeight: 700 }}
    />
  );
}

/** Weekly commits with a rolling trend line, marker at AI adoption. */
export function CommitsChart({ ds, marker }: { ds: Dataset; marker: number }) {
  const data = useMemo(() => {
    const roll = rolling(ds.weeks, 'commits', 8);
    return ds.weeks.map((w, i) => ({ ...w, trend: Math.round(roll[i] * 10) / 10 }));
  }, [ds]);
  const ticks = useMemo(() => yearTicks(ds.weeks), [ds]);
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 18, right: 8, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="gCommits" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="week" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={(v) => new Date(v * 1000).getUTCFullYear().toString()} tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={42} tickFormatter={fmt} />
        <Tooltip content={<ChartTooltip fmtLabel={labelDate} />} />
        <Area isAnimationActive={false} type="monotone" dataKey="commits" name="Commits" stroke="var(--color-accent)" strokeWidth={1} fill="url(#gCommits)" />
        <Line isAnimationActive={false} type="monotone" dataKey="trend" name="8-wk avg" stroke="var(--color-accent-2)" strokeWidth={2.5} dot={false} />
        <MarkerLine marker={marker} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Lines added (up) vs deleted (down) — diverging area. */
export function LinesChart({ ds, marker }: { ds: Dataset; marker: number }) {
  const data = useMemo(() => ds.weeks.map((w) => ({ ...w, deletionsNeg: -w.deletions })), [ds]);
  const ticks = useMemo(() => yearTicks(ds.weeks), [ds]);
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 18, right: 8, left: -2, bottom: 0 }}>
        <defs>
          <linearGradient id="gAdd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-pos)" stopOpacity={0.6} />
            <stop offset="100%" stopColor="var(--color-pos)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="gDel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-neg)" stopOpacity={0.05} />
            <stop offset="100%" stopColor="var(--color-neg)" stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="week" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={(v) => new Date(v * 1000).getUTCFullYear().toString()} tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => fmt(Math.abs(v))} />
        <Tooltip content={<ChartTooltip fmtLabel={labelDate} />} />
        <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
        <Area isAnimationActive={false} type="monotone" dataKey="additions" name="Added" stroke="var(--color-pos)" strokeWidth={1} fill="url(#gAdd)" />
        <Area isAnimationActive={false} type="monotone" dataKey="deletionsNeg" name="Deleted" stroke="var(--color-neg)" strokeWidth={1} fill="url(#gDel)" />
        <MarkerLine marker={marker} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Average lines-of-code per commit over time (rolling). */
export function CommitSizeChart({ ds, marker }: { ds: Dataset; marker: number }) {
  const data = useMemo(() => {
    const active = ds.weeks.map((w) => ({ ...w }));
    const roll = rolling(active.filter(() => true), 'avgCommitSize', 8);
    return active.map((w, i) => ({ ...w, trend: Math.round(roll[i]) }));
  }, [ds]);
  const ticks = useMemo(() => yearTicks(ds.weeks), [ds]);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 18, right: 8, left: -6, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="week" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={(v) => new Date(v * 1000).getUTCFullYear().toString()} tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={46} tickFormatter={fmt} />
        <Tooltip content={<ChartTooltip fmtLabel={labelDate} />} />
        <Bar isAnimationActive={false} dataKey="avgCommitSize" name="LOC/commit" fill="rgba(167,139,250,0.25)" radius={[2, 2, 0, 0]} />
        <Line isAnimationActive={false} type="monotone" dataKey="trend" name="8-wk avg" stroke="var(--color-accent-2)" strokeWidth={2.5} dot={false} />
        <MarkerLine marker={marker} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Cumulative net lines of code. */
export function CumulativeChart({ ds, marker }: { ds: Dataset; marker: number }) {
  const data = useMemo(() => {
    let net = 0;
    let commits = 0;
    return ds.weeks.map((w) => {
      net += w.net;
      commits += w.commits;
      return { week: w.week, date: w.date, cumNet: net, cumCommits: commits };
    });
  }, [ds]);
  const ticks = useMemo(() => yearTicks(ds.weeks), [ds]);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 18, right: 8, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="gCum" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-2)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--color-accent-2)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="week" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={(v) => new Date(v * 1000).getUTCFullYear().toString()} tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={50} tickFormatter={fmt} />
        <Tooltip content={<ChartTooltip fmtLabel={labelDate} />} />
        <Area isAnimationActive={false} type="monotone" dataKey="cumNet" name="Net LOC" stroke="var(--color-accent-2)" strokeWidth={2} fill="url(#gCum)" />
        <MarkerLine marker={marker} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const REPO_COLORS = ['#6ee7ff', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#f472b6', '#4ade80', '#c084fc', '#22d3ee'];

/** Top repos by commits. */
export function RepoBar({ ds }: { ds: Dataset }) {
  const data = useMemo(
    () => ds.repos.slice(0, 12).map((r) => ({ ...r, name: r.repo.split('/')[1] || r.repo })),
    [ds],
  );
  return (
    <ResponsiveContainer width="100%" height={Math.max(260, data.length * 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={fmt} />
        <YAxis type="category" dataKey="name" tick={{ ...AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={130} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar isAnimationActive={false} dataKey="commits" name="Commits" radius={[0, 4, 4, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={REPO_COLORS[i % REPO_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export { REPO_COLORS };
