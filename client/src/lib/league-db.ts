export type MatchStatus = "SCHEDULED" | "PENDING" | "CONFIRMED" | "DISPUTED" | "POSTPONED";
export type UserRole = "admin" | "player";
export type TiebreakerRule = "points" | "goalDifference" | "goalsFor" | "headToHead" | "wins";

export type League = {
  id: string;
  name: string;
  season: string;
  status: "ACTIVE" | "DRAFT" | "COMPLETED";
  teamsCount: number;
  matchesPerDay: number;
  startDate: string;
};

export type Team = {
  id: string;
  name: string;
  shortName: string;
  manager: string;
  accent: string;
  approvalStatus?: "PENDING" | "APPROVED" | "REJECTED";
  createdByEmail?: string;
};

export type UserAccount = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  teamId?: string;
  passwordHash: string;
  active: boolean;
  status?: "ACTIVE" | "INVITED" | "DISABLED";
};

export type Goal = {
  id: string;
  teamId: string;
  playerName: string;
  playerEmail?: string;
  minute: number;
};

export type Match = {
  id: string;
  matchday: number;
  date: string;
  kickoffAt?: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  status: MatchStatus;
  submittedBy?: string;
  submittedAt?: string;
  originalKickoffAt?: string;
  rescheduledAt?: string;
  rescheduleReason?: string;
  goals: Goal[];
};

export type Activity = {
  id: string;
  kind: "result" | "update" | "leaderboard";
  title: string;
  detail: string;
  time: string;
};

export type LeagueNewsStory = {
  id: string;
  seasonId?: string;
  storyDate: string;
  storyType: "MATCHDAY_RECAP" | "UPCOMING_PREVIEW" | "STAT_FACT" | "SEASON_SUMMARY";
  headline: string;
  description: string;
  data?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  model?: string;
  generatedAt: string;
};

export type SeasonArchive = {
  id: string;
  seasonId: string;
  seasonName: string;
  completedAt: string;
  standings: Array<Record<string, unknown>>;
  playerStats: Array<Record<string, unknown>>;
  teamPerformance: Array<Record<string, unknown>>;
  highlights: Array<Record<string, unknown>>;
};

export type ChronicleStatHighlight = {
  value: string;
  label: string;
  metric?: string;
};

export type ChronicleLeadStory = {
  tag: string;
  kicker?: string;
  headline: string;
  subdeck: string;
  leadParagraph?: string;
  bodyParagraphs?: string[];
  statHighlight?: ChronicleStatHighlight;
  body: string;
  accentColor?: string;
};

export type ChronicleScoreline = {
  home: string;
  homeScore: number;
  away: string;
  awayScore: number;
  timeline?: Array<{ player: string; minute: string }>;
};

export type ChronicleBentoHighlight = {
  type: string;
  tag: string;
  title: string;
  detail: string;
  scoreline?: ChronicleScoreline;
  quote?: string;
  accentColor?: string;
};

export type ChronicleCrisisWatch = {
  team: string;
  status: string;
  badge?: string;
  statSummary?: string;
  stats: {
    played: number;
    points: number;
    gd: number;
    goalsAgainst?: number;
    goalsAgainstPerGame?: number;
    cleanSheets?: number;
  };
  verdict: string;
};

export type ChronicleManagerPressure = {
  manager: string;
  team: string;
  label: string;
  score: number;
  note: string;
};

export type ChronicleAward = {
  kind: "TEAM_OF_WEEK" | "FLOP_OF_WEEK" | string;
  label: string;
  name: string;
  team?: string;
  detail: string;
};

export type ChronicleTouchlineDispatch = {
  tag: string;
  title: string;
  blurb: string;
};

export type ChronicleQuote = {
  quote: string;
  attribution?: string;
};

export type ChroniclePrediction = {
  matchday: number;
  date: string;
  fixture: string;
  pick: "HOME WIN" | "DRAW" | "AWAY WIN";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  rationale: string;
  factIds?: string[];
};

export type ChronicleUpcomingFixtureFact = {
  matchday: number;
  date: string;
  fixture: string;
  facts: string[];
  factIds?: string[];
};

export type ChronicleEditorial = {
  edition?: string;
  dateline?: string;
  leadStory?: ChronicleLeadStory;
  bentoHighlights: ChronicleBentoHighlight[];
  crisisWatch?: ChronicleCrisisWatch;
  managerPressure?: ChronicleManagerPressure[];
  awards?: ChronicleAward[];
  quoteOfMatchday?: ChronicleQuote;
  predictions?: ChroniclePrediction[];
  upcomingFixtureFacts?: ChronicleUpcomingFixtureFact[];
  touchlineDispatches?: ChronicleTouchlineDispatch[];
};

export type PunditEditorial = {
  id: string;
  seasonId?: string;
  publishDate: string;
  section: string;
  headline: string;
  dek: string;
  body: string;
  imageKey: string;
  facts: string[];
  editorial?: ChronicleEditorial;
  createdByEmail?: string;
  createdAt: string;
};

export type LeagueDatabase = {
  league: League;
  teams: Team[];
  users: UserAccount[];
  matches: Match[];
  activities: Activity[];
  news?: LeagueNewsStory[];
  punditEditorials?: PunditEditorial[];
  seasonArchives?: SeasonArchive[];
  currentUserId: string | null;
  tiebreakers: TiebreakerRule[];
};

export type Standing = Team & {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: ("W" | "D" | "L")[];
};

export type TeamPerformance = {
  teamId: string;
  teamName: string;
  shortName: string;
  goalsFor: number;
  goalsAgainst: number;
  matchesPlayed: number;
  cleanSheets: number;
};

export type PlayerStat = {
  name: string;
  playerEmail?: string;
  teamId: string;
  teamName: string;
  officialGoals: number;
  pendingGoals: number;
  totalGoals: number;
  appearances: number;
  averageMinute: number;
  lastMinute: number;
  hatTricks: number;
};

export const DB_KEY = "eleague-manager-database-v2";
export const DEFAULT_TIEBREAKERS: TiebreakerRule[] = ["points", "goalDifference", "goalsFor", "headToHead", "wins"];

const seedTeams: Team[] = [
  { id: "north-london", name: "North London", shortName: "NLD", manager: "Alex Morgan", accent: "#9dd36a" },
  { id: "river-city", name: "River City", shortName: "RVC", manager: "Sam Carter", accent: "#79b9f2" },
  { id: "blue-harbor", name: "Blue Harbor", shortName: "BLH", manager: "Jordan Lee", accent: "#bf9cf3" },
  { id: "old-town", name: "Old Town", shortName: "OLD", manager: "Ravi Patel", accent: "#f1b664" },
  { id: "east-end", name: "East End", shortName: "ESE", manager: "Mina Park", accent: "#f28d9d" },
  { id: "golden-state", name: "Golden State", shortName: "GLD", manager: "Owen Wright", accent: "#e8d25f" },
  { id: "metro-stars", name: "Metro Stars", shortName: "MTR", manager: "Chris Evans", accent: "#70d6c6" },
  { id: "coastline", name: "Coastline", shortName: "CST", manager: "Diana Ross", accent: "#e9a2cd" },
];

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateWithOffset(offset: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

function readableDate(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

export function makeId(prefix = "id") {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

export function hashPasscode(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function generateFixtures(teamIds: string[], matchesPerDay: number, startDate = dateWithOffset(0)): Match[] {
  const rotation = [...teamIds];
  const fixtures: Array<{ home: string; away: string; round: number }> = [];
  const rounds = rotation.length - 1;
  const half = rotation.length / 2;

  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < half; index += 1) {
      const home = rotation[index];
      const away = rotation[rotation.length - 1 - index];
      fixtures.push({ home: round % 2 === 0 ? home : away, away: round % 2 === 0 ? away : home, round });
    }
    const last = rotation.pop();
    if (last) rotation.splice(1, 0, last);
  }

  return fixtures.map((fixture, index) => {
    const dayOffset = Math.floor(index / matchesPerDay);
    const date = new Date(`${startDate}T12:00:00`);
    date.setDate(date.getDate() + dayOffset);
    return {
      id: `match-${String(index + 1).padStart(2, "0")}`,
      matchday: dayOffset + 1,
      date: dayKey(date),
      homeTeamId: fixture.home,
      awayTeamId: fixture.away,
      homeScore: null,
      awayScore: null,
      status: "SCHEDULED",
      goals: [],
    };
  });
}

function applySeedResults(matches: Match[]): Match[] {
  const resultSeed: Array<{ index: number; homeScore: number; awayScore: number; status: MatchStatus; goals: Array<[string, string, number]> }> = [
    { index: 0, homeScore: 3, awayScore: 1, status: "CONFIRMED", goals: [["north-london", "Messi", 12], ["north-london", "Messi", 58], ["north-london", "Etoo", 76], ["river-city", "Ronaldo", 44]] },
    { index: 1, homeScore: 2, awayScore: 2, status: "CONFIRMED", goals: [["blue-harbor", "Neymar", 21], ["blue-harbor", "Vinicius Jr", 63], ["old-town", "Ronaldo", 38], ["old-town", "Mbappe", 79]] },
    { index: 2, homeScore: 1, awayScore: 0, status: "PENDING", goals: [["east-end", "Etoo", 67]] },
  ];

  return matches.map((match, index) => {
    const seed = resultSeed.find((item) => item.index === index);
    if (!seed) return match;
    return {
      ...match,
      homeScore: seed.homeScore,
      awayScore: seed.awayScore,
      status: seed.status,
      submittedBy: "player-sam",
      submittedAt: new Date().toISOString(),
      goals: seed.goals.map(([teamId, playerName, minute]) => ({ id: makeId("goal"), teamId, playerName, minute })),
    };
  });
}

export function createSeedDatabase(): LeagueDatabase {
  const matches = applySeedResults(generateFixtures(seedTeams.map((team) => team.id), 4, dateWithOffset(-2)));
  return {
    league: {
      id: "river-city-league",
      name: "River City eLeague",
      season: "2026 · Season 01",
      status: "ACTIVE",
      teamsCount: seedTeams.length,
      matchesPerDay: 4,
      startDate: dateWithOffset(-2),
    },
    teams: seedTeams,
    users: [
      { id: "admin-alex", name: "Alex Morgan", email: "alex@eleague.local", role: "admin", passwordHash: hashPasscode("admin123"), active: true },
      { id: "player-sam", name: "Sam Carter", email: "sam@eleague.local", role: "player", teamId: "river-city", passwordHash: hashPasscode("player123"), active: true },
      { id: "player-jordan", name: "Jordan Lee", email: "jordan@eleague.local", role: "player", teamId: "blue-harbor", passwordHash: hashPasscode("player123"), active: true },
    ],
    matches,
    currentUserId: "admin-alex",
    tiebreakers: [...DEFAULT_TIEBREAKERS],
    activities: [
      { id: "activity-1", kind: "result", title: "Sam submitted a result", detail: "East End 1–0 Golden State · awaiting confirmation", time: "12 min ago" },
      { id: "activity-2", kind: "leaderboard", title: "Messi moved into first", detail: "4 official goals · North London and Blue Harbor scorers", time: "36 min ago" },
      { id: "activity-3", kind: "update", title: "Fixtures generated", detail: "28 matches across 7 matchdays", time: "Yesterday" },
    ],
  };
}

function normalizeDatabase(parsed: Partial<LeagueDatabase>): LeagueDatabase {
  const seed = createSeedDatabase();
  return {
    ...seed,
    ...parsed,
    users: Array.isArray(parsed.users) && parsed.users.length ? parsed.users : seed.users,
    currentUserId: parsed.currentUserId === undefined ? seed.currentUserId : parsed.currentUserId,
    tiebreakers: Array.isArray(parsed.tiebreakers) && parsed.tiebreakers.length ? parsed.tiebreakers : seed.tiebreakers,
    activities: Array.isArray(parsed.activities) ? parsed.activities : seed.activities,
  };
}

export function getDatabase(): LeagueDatabase {
  if (typeof window === "undefined") return createSeedDatabase();
  try {
    const stored = window.localStorage.getItem(DB_KEY);
    if (!stored) return createSeedDatabase();
    const parsed = JSON.parse(stored) as Partial<LeagueDatabase>;
    if (!parsed.league || !Array.isArray(parsed.teams) || !Array.isArray(parsed.matches)) return createSeedDatabase();
    return normalizeDatabase(parsed);
  } catch {
    return createSeedDatabase();
  }
}

export function saveDatabase(database: LeagueDatabase) {
  if (typeof window !== "undefined") window.localStorage.setItem(DB_KEY, JSON.stringify(database));
}

export function authenticateUser(database: LeagueDatabase, email: string, passcode: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const hash = hashPasscode(passcode);
  return database.users.find((user) => user.active && user.email.toLowerCase() === normalizedEmail && user.passwordHash === hash) ?? null;
}

export function currentUser(database: LeagueDatabase) {
  return database.users.find((user) => user.id === database.currentUserId && user.active) ?? null;
}

export const LEAGUE_TIME_ZONE = "Asia/Kolkata";

export function leagueDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LEAGUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function matchDateKey(timestamp: number | string | Date) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isFinite(date.getTime()) ? leagueDateKey(date) : "";
}

export function isMatchDateOpen(match: Pick<Match, "date" | "kickoffAt">, now = new Date()) {
  // `date` is the canonical IST matchday date supplied by the backend. The
  // kickoff timestamp is display-only because late slots can cross UTC midnight.
  return Boolean(match.date) && match.date <= leagueDateKey(now);
}

export function formatMatchKickoff(match: Pick<Match, "date" | "kickoffAt">) {
  if (!match.kickoffAt) return "Time TBC";
  const kickoff = new Date(match.kickoffAt);
  if (!Number.isFinite(kickoff.getTime())) return "Time TBC";
  return new Intl.DateTimeFormat("en-GB", { timeZone: LEAGUE_TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(kickoff);
}

export function canSubmitMatch(user: UserAccount | null, match: Match) {
  if (!user || match.status === "CONFIRMED" || !isMatchDateOpen(match)) return false;
  return user.role === "admin" || user.teamId === match.homeTeamId;
}

export function canConfirmMatch(user: UserAccount | null, match: Match) {
  return Boolean(user?.role === "admin" && (match.status === "PENDING" || match.status === "DISPUTED"));
}

export function teamById(teams: Team[], id: string) {
  return teams.find((team) => team.id === id);
}

export function formatMatchDate(date: string) {
  return readableDate(date);
}

function headToHeadPoints(database: LeagueDatabase, firstId: string, secondId: string) {
  let points = 0;
  database.matches.filter((match) => match.status === "CONFIRMED" && match.homeScore !== null && match.awayScore !== null && ((match.homeTeamId === firstId && match.awayTeamId === secondId) || (match.homeTeamId === secondId && match.awayTeamId === firstId))).forEach((match) => {
    const firstIsHome = match.homeTeamId === firstId;
    const firstScore = firstIsHome ? match.homeScore ?? 0 : match.awayScore ?? 0;
    const secondScore = firstIsHome ? match.awayScore ?? 0 : match.homeScore ?? 0;
    points += firstScore === secondScore ? 1 : firstScore > secondScore ? 3 : 0;
  });
  return points;
}

export function calculateStandings(database: LeagueDatabase): Standing[] {
  const rows = database.teams.map((team) => ({ ...team, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, form: [] as ("W" | "D" | "L")[] }));
  const byId = new Map(rows.map((team) => [team.id, team]));

  database.matches.filter((match) => match.status === "CONFIRMED" && match.homeScore !== null && match.awayScore !== null).forEach((match) => {
    const home = byId.get(match.homeTeamId);
    const away = byId.get(match.awayTeamId);
    if (!home || !away) return;
    home.played += 1;
    away.played += 1;
    home.goalsFor += match.homeScore ?? 0;
    home.goalsAgainst += match.awayScore ?? 0;
    away.goalsFor += match.awayScore ?? 0;
    away.goalsAgainst += match.homeScore ?? 0;
    if (match.homeScore === match.awayScore) {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
      home.form.push("D");
      away.form.push("D");
    } else if ((match.homeScore ?? 0) > (match.awayScore ?? 0)) {
      home.won += 1;
      away.lost += 1;
      home.points += 3;
      home.form.push("W");
      away.form.push("L");
    } else {
      away.won += 1;
      home.lost += 1;
      away.points += 3;
      home.form.push("L");
      away.form.push("W");
    }
  });

  const rules = database.tiebreakers?.length ? database.tiebreakers : DEFAULT_TIEBREAKERS;
  return rows.map((team) => ({ ...team, goalDifference: team.goalsFor - team.goalsAgainst, form: team.form.slice(-5) })).sort((a, b) => {
    for (const rule of rules) {
      const difference = rule === "points" ? b.points - a.points : rule === "goalDifference" ? b.goalDifference - a.goalDifference : rule === "goalsFor" ? b.goalsFor - a.goalsFor : rule === "wins" ? b.won - a.won : headToHeadPoints(database, b.id, a.id) - headToHeadPoints(database, a.id, b.id);
      if (difference !== 0) return difference;
    }
    return a.name.localeCompare(b.name);
  });
}

export function calculateTeamPerformance(database: LeagueDatabase): TeamPerformance[] {
  const rows = new Map(database.teams.map((team) => [team.id, { teamId: team.id, teamName: team.name, shortName: team.shortName, goalsFor: 0, goalsAgainst: 0, matchesPlayed: 0, cleanSheets: 0 }]));
  database.matches.filter((match) => match.status === "CONFIRMED" && match.homeScore !== null && match.awayScore !== null).forEach((match) => {
    const home = rows.get(match.homeTeamId);
    const away = rows.get(match.awayTeamId);
    if (!home || !away) return;
    home.matchesPlayed += 1;
    away.matchesPlayed += 1;
    home.goalsFor += match.homeScore ?? 0;
    home.goalsAgainst += match.awayScore ?? 0;
    away.goalsFor += match.awayScore ?? 0;
    away.goalsAgainst += match.homeScore ?? 0;
    if (match.awayScore === 0) home.cleanSheets += 1;
    if (match.homeScore === 0) away.cleanSheets += 1;
  });
  return Array.from(rows.values());
}

export function livePlayerStats(database: LeagueDatabase): PlayerStat[] {
  const totals = new Map<string, PlayerStat & { matchIds: Set<string>; minuteTotal: number }>();
  database.matches.filter((match) => match.status === "CONFIRMED" || match.status === "PENDING" || match.status === "DISPUTED").forEach((match) => {
    const goalsByPlayer = new Map<string, number>();
    match.goals.forEach((goal) => {
      const team = teamById(database.teams, goal.teamId);
      const scorerIdentity = goal.playerEmail?.trim().toLowerCase() || goal.playerName.trim().toLowerCase();
      const key = `${goal.teamId}-${scorerIdentity}`;
      const current = totals.get(key) ?? { name: goal.playerName, playerEmail: goal.playerEmail, teamId: goal.teamId, teamName: team?.name ?? "Unknown", officialGoals: 0, pendingGoals: 0, totalGoals: 0, appearances: 0, averageMinute: 0, lastMinute: 0, hatTricks: 0, matchIds: new Set<string>(), minuteTotal: 0 };
      current.totalGoals += 1;
      current.minuteTotal += goal.minute;
      current.lastMinute = Math.max(current.lastMinute, goal.minute);
      current.matchIds.add(match.id);
      if (match.status === "CONFIRMED") current.officialGoals += 1;
      else current.pendingGoals += 1;
      goalsByPlayer.set(key, (goalsByPlayer.get(key) ?? 0) + 1);
      totals.set(key, current);
    });
    goalsByPlayer.forEach((count, key) => {
      const current = totals.get(key);
      if (current && count >= 3) current.hatTricks += 1;
    });
  });
  return Array.from(totals.values()).map(({ matchIds, minuteTotal, ...stat }) => ({ ...stat, appearances: matchIds.size, averageMinute: stat.totalGoals ? Math.round(minuteTotal / stat.totalGoals) : 0 })).sort((a, b) => b.officialGoals - a.officialGoals || b.totalGoals - a.totalGoals || a.name.localeCompare(b.name));
}

export function leaderboard(database: LeagueDatabase) {
  return livePlayerStats(database).filter((player) => player.officialGoals > 0).map((player) => ({ name: player.name, playerEmail: player.playerEmail, teamId: player.teamId, goals: player.officialGoals, teamName: player.teamName }));
}

export function countConfirmed(database: LeagueDatabase) {
  return database.matches.filter((match) => match.status === "CONFIRMED").length;
}

export function countPending(database: LeagueDatabase) {
  return database.matches.filter((match) => match.status === "PENDING" || match.status === "DISPUTED").length;
}

export function matchLabel(database: LeagueDatabase, match: Match) {
  return `${teamById(database.teams, match.homeTeamId)?.name ?? "Home"} ${match.homeScore ?? "–"}–${match.awayScore ?? "–"} ${teamById(database.teams, match.awayTeamId)?.name ?? "Away"}`;
}

export function ruleLabel(rule: TiebreakerRule) {
  return rule === "points" ? "Points" : rule === "goalDifference" ? "Goal difference" : rule === "goalsFor" ? "Goals scored" : rule === "headToHead" ? "Head-to-head points" : "Wins";
}
