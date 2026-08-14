export type TieBreaker = "points" | "goalDifference" | "goalsFor" | "wins" | "headToHead";

export const DEFAULT_TIEBREAKERS: TieBreaker[] = ["points", "goalDifference", "goalsFor", "wins", "headToHead"];

type Fixture = {
  matchday: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: number;
};

type ConfirmedMatch = {
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
};

type Team = { id: number; name: string; shortCode: string };

export function generateRoundRobin(teamIds: number[], startingAt = Date.now(), kickoffGapMs = 1000 * 60 * 60 * 24 * 7): Fixture[] {
  const uniqueIds = teamIds.filter((id, index) => teamIds.indexOf(id) === index);
  if (uniqueIds.length < 2) throw new Error("At least two teams are required to create a schedule.");

  const participants: Array<number | null> = [...uniqueIds];
  if (participants.length % 2 === 1) participants.push(null);
  const rounds = participants.length - 1;
  const fixtures: Fixture[] = [];
  const rotating = [...participants];
  const half = rotating.length / 2;

  for (let round = 0; round < rounds; round += 1) {
    const matchday = round + 1;
    for (let index = 0; index < half; index += 1) {
      const left = rotating[index];
      const right = rotating[rotating.length - 1 - index];
      if (left === null || right === null) continue;
      const flipHome = (round + index) % 2 === 1;
      fixtures.push({
        matchday,
        homeTeamId: flipHome ? right : left,
        awayTeamId: flipHome ? left : right,
        kickoffAt: startingAt + round * kickoffGapMs + index * 1000 * 60 * 90,
      });
    }
    rotating.splice(1, 0, rotating.pop() as number | null);
  }

  assertScheduleIsCompatible(uniqueIds, fixtures);
  return fixtures;
}

export function assertScheduleIsCompatible(teamIds: number[], fixtures: Fixture[]) {
  const expectedMatches = (teamIds.length * (teamIds.length - 1)) / 2;
  if (fixtures.length !== expectedMatches) {
    throw new Error(`Schedule generated ${fixtures.length} matches; expected ${expectedMatches}.`);
  }

  const pairKeys = new Set<string>();
  const teamDays = new Set<string>();
  for (const fixture of fixtures) {
    if (fixture.homeTeamId === fixture.awayTeamId) throw new Error("A team cannot play itself.");
    const pairKey = [fixture.homeTeamId, fixture.awayTeamId].sort((a, b) => a - b).join(":");
    if (pairKeys.has(pairKey)) throw new Error(`Duplicate pairing detected for ${pairKey}.`);
    pairKeys.add(pairKey);
    for (const teamId of [fixture.homeTeamId, fixture.awayTeamId]) {
      const dayKey = `${fixture.matchday}:${teamId}`;
      if (teamDays.has(dayKey)) throw new Error(`Team ${teamId} has more than one match on matchday ${fixture.matchday}.`);
      teamDays.add(dayKey);
    }
  }
}

function headToHeadPoints(teamId: number, opponentId: number, matches: ConfirmedMatch[]) {
  let points = 0;
  for (const match of matches) {
    const isDirect = (match.homeTeamId === teamId && match.awayTeamId === opponentId) || (match.homeTeamId === opponentId && match.awayTeamId === teamId);
    if (!isDirect) continue;
    const teamScore = match.homeTeamId === teamId ? match.homeScore : match.awayScore;
    const opponentScore = match.homeTeamId === teamId ? match.awayScore : match.homeScore;
    points += teamScore > opponentScore ? 3 : teamScore === opponentScore ? 1 : 0;
  }
  return points;
}

export function calculateStandings(teams: Team[], matches: ConfirmedMatch[], tieBreakers = DEFAULT_TIEBREAKERS) {
  const map = new Map<number, {
    teamId: number;
    name: string;
    shortCode: string;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDifference: number;
    points: number;
  }>();
  for (const team of teams) {
    map.set(team.id, { teamId: team.id, name: team.name, shortCode: team.shortCode, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 });
  }

  for (const match of matches) {
    const home = map.get(match.homeTeamId);
    const away = map.get(match.awayTeamId);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    home.goalsFor += match.homeScore;
    home.goalsAgainst += match.awayScore;
    away.goalsFor += match.awayScore;
    away.goalsAgainst += match.homeScore;
    if (match.homeScore > match.awayScore) {
      home.wins += 1;
      home.points += 3;
      away.losses += 1;
    } else if (match.homeScore < match.awayScore) {
      away.wins += 1;
      away.points += 3;
      home.losses += 1;
    } else {
      home.draws += 1;
      away.draws += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  const rows: Array<{ teamId: number; name: string; shortCode: string; played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; goalDifference: number; points: number }> = [];
  map.forEach((row) => {
    row.goalDifference = row.goalsFor - row.goalsAgainst;
    rows.push(row);
  });
  rows.sort((a, b) => {
    for (const tieBreaker of tieBreakers) {
      const difference = tieBreaker === "points" ? b.points - a.points : tieBreaker === "goalDifference" ? b.goalDifference - a.goalDifference : tieBreaker === "goalsFor" ? b.goalsFor - a.goalsFor : tieBreaker === "wins" ? b.wins - a.wins : headToHeadPoints(b.teamId, a.teamId, matches) - headToHeadPoints(a.teamId, b.teamId, matches);
      if (difference !== 0) return difference;
    }
    return a.name.localeCompare(b.name);
  });
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}
