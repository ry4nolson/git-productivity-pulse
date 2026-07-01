import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AuthorStat } from '../lib/types';
import { fmt } from '../lib/data';
import { ChartTooltip } from './primitives';
import { REPO_COLORS } from './Charts';

const MEDALS = ['🥇', '🥈', '🥉'];
const AXIS = { fontSize: 11, fill: 'rgba(255,255,255,0.4)' };

interface Row {
  login: string;
  avatarUrl: string;
  repos: number;
  commits: number;
  additions: number;
  deletions: number;
  months: Map<string, number>;
}

export function Leaderboard({
  authors,
  startUnix,
  endUnix,
  highlight,
}: {
  authors: AuthorStat[];
  startUnix: number;
  endUnix: number;
  highlight: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo<Row[]>(
    () =>
      authors
        .filter((a) => !a.login.endsWith('[bot]'))
        .map((a) => {
          const weeks = a.weekly.filter((w) => w.w >= startUnix && w.w <= endUnix);
          const months = new Map<string, number>();
          let commits = 0,
            additions = 0,
            deletions = 0;
          for (const w of weeks) {
            commits += w.c;
            additions += w.a;
            deletions += w.d;
            const m = new Date(w.w * 1000).toISOString().slice(0, 7);
            months.set(m, (months.get(m) ?? 0) + w.c);
          }
          return { login: a.login, avatarUrl: a.avatarUrl, repos: a.repos, commits, additions, deletions, months };
        })
        .filter((r) => r.commits > 0)
        .sort((a, b) => b.commits - a.commits),
    [authors, startUnix, endUnix],
  );

  const top = rows.slice(0, 6);
  const chartData = useMemo(() => {
    const monthKeys = [...new Set(top.flatMap((r) => [...r.months.keys()]))].sort();
    return monthKeys.map((m) => {
      const row: Record<string, string | number> = { month: m };
      for (const r of top) row[r.login] = r.months.get(m) ?? 0;
      return row;
    });
  }, [top]);

  const visible = showAll ? rows : rows.slice(0, 10);
  const maxCommits = rows[0]?.commits ?? 1;

  if (rows.length === 0) return <p className="text-sm text-white/40">No contributors in the selected range.</p>;

  return (
    <div className="flex flex-col gap-6">
      {top.length > 1 && (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} minTickGap={40} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} width={40} tickFormatter={fmt} />
            <Tooltip content={<ChartTooltip />} />
            {top.map((r, i) => (
              <Line
                key={r.login}
                isAnimationActive={false}
                type="monotone"
                dataKey={r.login}
                name={r.login}
                stroke={REPO_COLORS[i % REPO_COLORS.length]}
                strokeWidth={r.login === highlight ? 3 : 1.75}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-white/35">
              <th className="pb-2 pr-2 font-medium">#</th>
              <th className="pb-2 pr-4 font-medium">Contributor</th>
              <th className="pb-2 pr-4 text-right font-medium">Commits</th>
              <th className="pb-2 pr-4 text-right font-medium">Added</th>
              <th className="pb-2 pr-4 text-right font-medium">Deleted</th>
              <th className="pb-2 text-right font-medium">Repos</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={r.login}
                className={`border-t border-line/60 ${r.login === highlight ? 'bg-accent/5' : ''}`}
              >
                <td className="py-2 pr-2 text-white/40">{MEDALS[i] ?? i + 1}</td>
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-2.5">
                    {r.avatarUrl ? (
                      <img src={r.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                    ) : (
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-white/10 text-[10px]">
                        {r.login[0]?.toUpperCase()}
                      </span>
                    )}
                    <span className={r.login === highlight ? 'font-semibold text-accent' : 'text-white/85'}>
                      {r.login}
                    </span>
                  </span>
                </td>
                <td className="tnum py-2 pr-4 text-right">
                  <span className="flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-white/5 sm:block">
                      <span
                        className="block h-full rounded-full bg-accent/60"
                        style={{ width: `${(r.commits / maxCommits) * 100}%` }}
                      />
                    </span>
                    <span className="w-14 font-semibold text-white">{fmt(r.commits)}</span>
                  </span>
                </td>
                <td className="tnum py-2 pr-4 text-right text-pos/90">+{fmt(r.additions)}</td>
                <td className="tnum py-2 pr-4 text-right text-neg/90">-{fmt(r.deletions)}</td>
                <td className="tnum py-2 text-right text-white/60">{r.repos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 10 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="self-center rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-xs text-white/60 transition hover:border-accent hover:text-white"
        >
          {showAll ? 'Show top 10' : `Show all ${rows.length} contributors`}
        </button>
      )}
    </div>
  );
}
