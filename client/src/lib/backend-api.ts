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
    cache: "no-store",
    ...options,
  });
  const raw = await response.text();
  let payload: (T & { error?: string; message?: string }) | null = null;
  try {
    payload = raw ? JSON.parse(raw) as T & { error?: string; message?: string } : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload?.message || payload?.error || raw || response.statusText || "The backend request failed.";
    throw new Error(`${detail} (HTTP ${response.status})`);
  }
  return (payload || {}) as T;
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

export function backendRegister(email: string, password: string, displayName: string, teamName: string, shortCode: string) {
  return request<{ user: BackendUser; team: { id: number; name: string; shortCode: string; status: string } }>("/api/register", {
    method: "POST",
    body: JSON.stringify({ email, password, displayName, teamName, shortCode }),
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
    status: user.status,
  };
}

export type BackendScorerReview = {
  id: number;
  match_id: number;
  goal_id: number | null;
  team_id: number;
  submitted_name: string;
  suggested_name: string | null;
  approved_name: string | null;
  confidence: number | null;
  reason: string | null;
  matched_email: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "FAILED";
  model: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  team_name: string;
  matchday: number;
  home_team_name: string;
  away_team_name: string;
};

export type BackendPlayerRegistryEntry = {
  team_id: number;
  team_name: string;
  short_code: string;
  accent: string;
  scorer_name: string;
  player_email: string | null;
  total_goals: number;
  official_goals: number;
};

export type BackendDashboard = {
  season: { id: number; name: string; status: string; matchday_count: number; current_matchday: number } | null;
  teams: Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string; status: string; created_by_email: string | null }>;
  users: Array<{ email: string; display_name: string; role: string; status: string; team_id: number | null }>;
  matches: Array<Record<string, unknown>>;
  goals: Array<{ id: number; match_id: number; team_id: number; player_email: string | null; scorer_name: string; minute: number }>;
  standings: Array<Record<string, unknown>>;
  stats: Array<{ player_email: string | null; scorer_name: string; team_id: number; team_name: string; goals: number }>;
  scorerReviews: BackendScorerReview[];
  news: Array<{ id: number; season_id: number | null; story_date: string; story_type: string; headline: string; description: string; data_json: unknown; evidence_json: unknown; model: string | null; generated_at: number }>;
  seasonArchives: Array<{ id: number; season_id: number; season_name: string; completed_at: number; standings_json: unknown; player_stats_json: unknown; team_performance_json: unknown; highlights_json: unknown }>;
};

export function backendDashboard() {
  return request<BackendDashboard>("/api/dashboard");
}

export function backendGetPlayers() {
  return request<{ players: BackendPlayerRegistryEntry[] }>("/api/admin/players");
}

export function backendRenamePlayer(teamId: number, oldName: string, newName: string, playerEmail?: string | null) {
  return request<{ ok: true; updated: number; teamId: number; oldName: string; newName: string; players: BackendPlayerRegistryEntry[] }>("/api/admin/players/rename", {
    method: "PATCH",
    body: JSON.stringify({ teamId, oldName, newName, playerEmail: playerEmail || undefined }),
  });
}

export function backendRefreshNews() {
  return request<{ generated: number; stories: BackendDashboard["news"] }>("/api/news/refresh", { method: "POST" });
}

export function backendCompleteSeason(seasonId: string) {
  return request<{ seasonId: string; status: string; archived: boolean }>(`/api/admin/seasons/${seasonId}/complete`, { method: "POST" });
}

export function backendCreateSeason(name: string) {
  return request<{ id: number }>("/api/admin/seasons", { method: "POST", body: JSON.stringify({ name }) });
}

import { matchDateKey } from "./league-db";
import type { Goal, LeagueDatabase, LeagueNewsStory, Match, SeasonArchive } from "./league-db";

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
    } catch { return []; }
  }
  return [];
}

export function mergeBackendDashboard(current: LeagueDatabase, snapshot: BackendDashboard): LeagueDatabase {
  const teams = snapshot.teams.map((team) => ({
    id: String(team.id),
    name: team.name,
    shortName: team.short_code,
    manager: team.manager_name,
    accent: team.accent,
    approvalStatus: team.status as "PENDING" | "APPROVED" | "REJECTED",
    createdByEmail: team.created_by_email || undefined,
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
    matchGoals.push({ id: String(goal.id), teamId: String(goal.team_id), playerName: goal.scorer_name, playerEmail: goal.player_email || undefined, minute: Number(goal.minute) });
    goalsByMatch.set(matchKey, matchGoals);
  }
  const matches: Match[] = snapshot.matches.map((match) => ({
    id: String(match.id),
    matchday: Number(match.matchday),
    date: typeof match.match_date === "string" && match.match_date ? match.match_date : match.kickoff_at ? matchDateKey(Number(match.kickoff_at)) : "",
    kickoffAt: match.kickoff_at ? new Date(Number(match.kickoff_at)).toISOString() : undefined,
    homeTeamId: String(match.home_team_id),
    awayTeamId: String(match.away_team_id),
    homeScore: match.home_score === null || match.home_score === undefined ? null : Number(match.home_score),
    awayScore: match.away_score === null || match.away_score === undefined ? null : Number(match.away_score),
    status: String(match.status) as Match["status"],
    submittedBy: match.submitted_by_email ? String(match.submitted_by_email) : undefined,
    submittedAt: match.submitted_at ? new Date(Number(match.submitted_at)).toISOString() : undefined,
    originalKickoffAt: match.original_kickoff_at ? new Date(Number(match.original_kickoff_at)).toISOString() : undefined,
    rescheduledAt: match.rescheduled_at ? new Date(Number(match.rescheduled_at)).toISOString() : undefined,
    rescheduleReason: match.reschedule_reason ? String(match.reschedule_reason) : undefined,
    goals: goalsByMatch.get(String(match.id)) || [],
  }));
  return {
    ...current,
    league: snapshot.season ? { ...current.league, id: String(snapshot.season.id), name: snapshot.season.name, season: snapshot.season.name, status: snapshot.season.status === "ACTIVE" ? "ACTIVE" : snapshot.season.status === "COMPLETED" ? "COMPLETED" : "DRAFT", teamsCount: teams.length } : current.league,
    teams,
    users,
    matches,
    activities: [],
    news: snapshot.news.map((story): LeagueNewsStory => ({
      id: String(story.id),
      seasonId: story.season_id === null ? undefined : String(story.season_id),
      storyDate: story.story_date,
      storyType: story.story_type as LeagueNewsStory["storyType"],
      headline: story.headline,
      description: story.description,
      data: jsonObject(story.data_json),
      evidence: jsonObject(story.evidence_json),
      model: story.model || undefined,
      generatedAt: new Date(Number(story.generated_at)).toISOString(),
    })),
    seasonArchives: snapshot.seasonArchives.map((archive): SeasonArchive => ({
      id: String(archive.id),
      seasonId: String(archive.season_id),
      seasonName: archive.season_name,
      completedAt: new Date(Number(archive.completed_at)).toISOString(),
      standings: jsonArray(archive.standings_json),
      playerStats: jsonArray(archive.player_stats_json),
      teamPerformance: jsonArray(archive.team_performance_json),
      highlights: jsonArray(archive.highlights_json),
    })),
  };
}

export function backendSubmitResult(matchId: string, homeScore: number, awayScore: number, goals: Goal[]) {
  return request<{ matchId: string; status: string }>(`/api/matches/${matchId}/result`, {
    method: "POST",
    body: JSON.stringify({
      homeScore,
      awayScore,
      goals: goals.map((goal) => ({ teamId: Number(goal.teamId), playerEmail: goal.playerEmail, scorerName: goal.playerName, minute: goal.minute })),
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
  return request<{ seasonId: number; fixturesCreated: number; matchdays: number; matchesPerDay: number; matchesPerTeam: number; status?: string }>(`/api/admin/seasons/${seasonId}/schedule`, { method: "POST" });
}

export function backendStartTournament(seasonId: number) {
  return request<{ seasonId: number; fixturesCreated: number; matchdays: number; matchesPerDay: number; matchesPerTeam: number; status: string }>(`/api/admin/seasons/${seasonId}/start`, { method: "POST" });
}

export function backendResetTournament(seasonId: number) {
  return request<{ seasonId: number; deletedMatches: number; status: string }>(`/api/admin/seasons/${seasonId}/reset`, { method: "POST" });
}

export function backendUpdateTeam(teamId: string, name: string, shortCode: string, managerName?: string, accent?: string) {
  return request<{ teamId: number; name: string; shortCode: string; managerName?: string; accent?: string; updated: boolean }>(`/api/admin/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify({ name, shortCode, ...(managerName === undefined ? {} : { managerName }), ...(accent === undefined ? {} : { accent }) }),
  });
}

export function backendUpdateUser(email: string, payload: { displayName: string; role: "admin" | "player"; status: "ACTIVE" | "INVITED" | "DISABLED"; teamId: number | null }) {
  return request<{ user: BackendUser }>(`/api/admin/users/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}


export function backendDeleteTeam(teamId: string) {
  return request<{ teamId: number; deleted: true }>(`/api/admin/teams/${teamId}`, { method: "DELETE" });
}

export function backendApproveTeam(teamId: string, decision: "approve" | "reject") {
  return request<{ teamId: number; status: string }>(`/api/admin/teams/${teamId}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

export function backendScorerSuggestions(teamId: string) {
  return request<{ scorers: Array<{ name: string; email: string | null; goals: number }> }>(`/api/teams/${teamId}/scorers`);
}

export function backendAnalyzeScorerReviews(reviewIds?: number[]) {
  return request<{ analyzed: number; failed: number; reviews: BackendScorerReview[] }>("/api/admin/scorer-reviews/analyze", { method: "POST", body: JSON.stringify(reviewIds?.length ? { reviewIds } : {}) });
}

export function backendApproveScorerReview(reviewId: number, approvedName?: string) {
  return request<{ reviewId: number; status: string; approvedName?: string }>(`/api/admin/scorer-reviews/${reviewId}/approve`, { method: "POST", body: JSON.stringify(approvedName ? { approvedName } : {}) });
}

export function backendRejectScorerReview(reviewId: number) {
  return request<{ reviewId: number; status: string }>(`/api/admin/scorer-reviews/${reviewId}/reject`, { method: "POST", body: JSON.stringify({}) });
}

export function backendRescheduleMatch(matchId: string, kickoffAt: number, reason: string) {
  return request<{ matchId: number; status: string; kickoffAt: number; reason: string }>(`/api/matches/${matchId}/reschedule`, { method: "POST", body: JSON.stringify({ kickoffAt, reason }) });
}
