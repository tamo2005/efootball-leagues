export type MatchStatus = "SCHEDULED" | "PENDING" | "CONFIRMED" | "DISPUTED";

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
};

export type Goal = {
  id: string;
  teamId: string;
  playerName: string;
  minute: number;
};

export type Match = {
  id: string;
  matchday: number;
  date: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  status: MatchStatus;
  submittedBy?: string;
  submittedAt?: string;
  goals: Goal[];
};

export type Activity = {
  id: string;
  kind: "result" | "update" | "leaderboard";
  title: string;
  detail: string;
  time: string;
};

export type LeagueDatabase = {
  league: League;
  teams: Team[];
  matches: Match[];
  activities: Activity[];
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

export const DB_KEY = "eleague-manager-database-v1";

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
    { index: 1, homeScore: 2, awayScore: 2, status: "CONFIRMED", goals: [["blue-harbor", "Neymar", 21], ["blue-harbor", "Messi", 63], ["old-town", "Ronaldo", 38], ["old-town", "Mbappe", 79]] },
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
      submittedBy: "home-team",
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
    matches,
    activities: [
      { id: "activity-1", kind: "result", title: "Alex submitted a result", detail: "East End 1–0 Golden State · awaiting confirmation", time: "12 min ago" },
      { id: "activity-2", kind: "leaderboard", title: "Messi moved into first", detail: "4 goals · North London", time: "36 min ago" },
      { id: "activity-3", kind: "update", title: "Fixtures generated", detail: "28 matches across 7 matchdays", time: "Yesterday" },
    ],
  };
}

export function getDatabase(): LeagueDatabase {
  if (typeof window === "undefined") return createSeedDatabase();
  try {
    const stored = window.localStorage.getItem(DB_KEY);
    if (!stored) return createSeedDatabase();
    const parsed = JSON.parse(stored) as LeagueDatabase;
    if (!parsed.league || !Array.isArray(parsed.teams) || !Array.isArray(parsed.matches)) return createSeedDatabase();
    return parsed;
  } catch {
    return createSeedDatabase();
  }
}

export function saveDatabase(database: LeagueDatabase) {
  if (typeof window !== "undefined") window.localStorage.setItem(DB_KEY, JSON.stringify(database));
}

export function teamById(teams: Team[], id: string) {
  return teams.find((team) => team.id === id);
}

export function formatMatchDate(date: string) {
  return readableDate(date);
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

  return rows.map((team) => ({ ...team, goalDifference: team.goalsFor - team.goalsAgainst, form: team.form.slice(-5) })).sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor || a.name.localeCompare(b.name));
}

export function leaderboard(database: LeagueDatabase) {
  const totals = new Map<string, { name: string; teamId: string; goals: number; teamName: string }>();
  database.matches.filter((match) => match.status === "CONFIRMED").forEach((match) => {
    match.goals.forEach((goal) => {
      const key = `${goal.playerName.toLowerCase()}-${goal.teamId}`;
      const team = teamById(database.teams, goal.teamId);
      const current = totals.get(key) ?? { name: goal.playerName, teamId: goal.teamId, goals: 0, teamName: team?.name ?? "Unknown" };
      current.goals += 1;
      totals.set(key, current);
    });
  });
  return Array.from(totals.values()).sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name));
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
