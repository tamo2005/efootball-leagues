export type BackendUser = {
  email: string;
  displayName: string;
  role: "admin" | "player";
  status: "ACTIVE" | "INVITED" | "DISABLED";
  teamId: number | null;
  teamName: string | null;
  shortCode: string | null;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    ...options,
  });
  const payload = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || "The backend request failed.");
  return payload;
}

export function backendEnabled() {
  return import.meta.env.VITE_BACKEND_ENABLED === "true";
}

export async function backendMe() {
  try {
    const result = await request<{ user: BackendUser }>("/api/me");
    return result.user;
  } catch (error) {
    if (error instanceof Error && error.message === "Sign in to continue.") return null;
    return null;
  }
}

export function backendLogin(email: string, password: string) {
  return request<{ user: BackendUser }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function backendLogout() {
  return request<{ ok: true }>("/api/logout", { method: "POST" });
}

export function toLocalUser(user: BackendUser) {
  return {
    id: user.email,
    name: user.displayName,
    email: user.email,
    role: user.role,
    teamId: user.teamId === null ? undefined : String(user.teamId),
    passwordHash: "",
    active: user.status === "ACTIVE",
  };
}

export type BackendDashboard = {
  season: { id: number; name: string; status: string; matchday_count: number; current_matchday: number } | null;
  teams: Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string }>;
  users: Array<{ email: string; display_name: string; role: string; status: string; team_id: number | null }>;
  matches: Array<Record<string, unknown>>;
  goals: Array<{ id: number; match_id: number; team_id: number; player_email: string | null; scorer_name: string; minute: number }>;
  standings: Array<Record<string, unknown>>;
  stats: Array<{ player_email: string | null; scorer_name: string; team_id: number; team_name: string; goals: number }>;
};

export function backendDashboard() {
  return request<BackendDashboard>("/api/dashboard");
}

import type { Goal, LeagueDatabase, Match } from "./league-db";

export function mergeBackendDashboard(current: LeagueDatabase, snapshot: BackendDashboard): LeagueDatabase {
  const teams = snapshot.teams.map((team) => ({
    id: String(team.id),
    name: team.name,
    shortName: team.short_code,
    manager: team.manager_name,
    accent: team.accent,
  }));
  const users = snapshot.users.map((user) => ({
    id: user.email,
    name: user.display_name,
    email: user.email,
    role: user.role === "admin" ? "admin" as const : "player" as const,
    teamId: user.team_id === null ? undefined : String(user.team_id),
    passwordHash: "",
    active: user.status === "ACTIVE",
  }));
  const goalsByMatch = new Map<string, Goal[]>();
  for (const goal of snapshot.goals) {
    const matchKey = String(goal.match_id);
    const matchGoals = goalsByMatch.get(matchKey) || [];
    matchGoals.push({ id: String(goal.id), teamId: String(goal.team_id), playerName: goal.scorer_name, minute: Number(goal.minute) });
    goalsByMatch.set(matchKey, matchGoals);
  }
  const matches: Match[] = snapshot.matches.map((match) => ({
    id: String(match.id),
    matchday: Number(match.matchday),
    date: new Date(Number(match.kickoff_at)).toISOString().slice(0, 10),
    homeTeamId: String(match.home_team_id),
    awayTeamId: String(match.away_team_id),
    homeScore: match.home_score === null || match.home_score === undefined ? null : Number(match.home_score),
    awayScore: match.away_score === null || match.away_score === undefined ? null : Number(match.away_score),
    status: String(match.status) as Match["status"],
    submittedBy: match.submitted_by_email ? String(match.submitted_by_email) : undefined,
    goals: goalsByMatch.get(String(match.id)) || [],
  }));
  return {
    ...current,
    league: snapshot.season ? { ...current.league, name: snapshot.season.name, season: snapshot.season.name, status: snapshot.season.status === "ACTIVE" ? "ACTIVE" : snapshot.season.status === "COMPLETED" ? "COMPLETED" : "DRAFT", teamsCount: teams.length } : current.league,
    teams,
    users,
    matches,
    activities: [],
  };
}

export function backendSubmitResult(matchId: string, homeScore: number, awayScore: number, goals: Goal[]) {
  return request<{ matchId: string; status: string }>(`/api/matches/${matchId}/result`, {
    method: "POST",
    body: JSON.stringify({
      homeScore,
      awayScore,
      goals: goals.map((goal) => ({ teamId: Number(goal.teamId), scorerName: goal.playerName, minute: goal.minute })),
    }),
  });
}

export function backendConfirmResult(matchId: string) {
  return request<{ matchId: string; status: string }>(`/api/matches/${matchId}/confirm`, { method: "POST" });
}

export function backendCreateTeam(name: string, shortCode: string, managerName: string, accent: string) {
  return request<{ id: number }>("/api/admin/teams", { method: "POST", body: JSON.stringify({ name, shortCode, managerName, accent }) });
}

export function backendCreateUser(payload: { email: string; displayName: string; password: string; role: "admin" | "player"; teamId?: number }) {
  return request<{ user: BackendUser }>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
}

export function backendGenerateSchedule(seasonId: number) {
  return request<{ seasonId: number; fixturesCreated: number; matchdays: number }>(`/api/admin/seasons/${seasonId}/schedule`, { method: "POST" });
}
