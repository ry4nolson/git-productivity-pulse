export interface WeekPoint {
  week: number; // unix seconds (week start)
  date: string; // YYYY-MM-DD
  commits: number;
  additions: number;
  deletions: number;
  net: number;
  churn: number;
  avgCommitSize: number;
}

export interface RepoWeek {
  w: number; // unix seconds (week start)
  c: number; // commits
  a: number; // additions
  d: number; // deletions
}

export interface RepoTotal {
  repo: string;
  language: string;
  commits: number;
  additions: number;
  deletions: number;
  weeks: number;
  firstWeek: number;
  lastWeek: number;
  weekly?: RepoWeek[];
}

export interface LangTotal {
  language: string;
  commits: number;
  additions: number;
  deletions: number;
  repos: number;
}

export interface Dataset {
  meta: {
    user: string;
    orgs: string[];
    users: string[];
    since: string | null;
    generatedAt: string;
    reposScanned: number;
    reposContributed: number;
    collectorSeconds: number;
    skipped?: string[]; // repos GitHub was still computing; re-run to include
  };
  totals: {
    commits: number;
    additions: number;
    deletions: number;
    net: number;
    churn: number;
    weeksActive: number;
    weeksSpan: number;
  };
  weeks: WeekPoint[];
  repos: RepoTotal[];
  languages: LangTotal[];
}
