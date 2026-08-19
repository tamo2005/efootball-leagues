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

export type BackendPunditEditorial = {
  id: number;
  season_id: number | null;
  publish_date: string;
  section: string;
  headline: string;
  dek: string;
  body: string;
  image_key: string;
  facts_json: unknown;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
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

export type BackendNextFixtureNotification = {
  teamId: number;
  teamName: string;
  teamShortCode: string;
  teamAccent: string;
  recipients: Array<{ email: string; displayName: string }>;
  fixture: {
    id: number;
    matchday: number;
    matchDate: string;
    kickoffAt: number;
    status: string;
    isHome: boolean;
    opponent: { id: number; name: string; shortCode: string; accent: string };
  };
  table: {
    rank: number;
    played: number;
    points: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDifference: number;
    cleanSheets: number;
  };
  opponentTable: {
    rank: number;
    played: number;
    points: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDifference: number;
    cleanSheets: number;
  };
};

export type BackendNextFixtureNotificationsResponse = {
  seasonId: number;
  seasonName: string;
  from: string;
  providerConfigured: boolean;
  notifications: BackendNextFixtureNotification[];
  sent: number;
  skipped: number;
  failed: Array<{ email: string; reason: string }>;
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
  pundits: BackendPunditEditorial[];
  seasonArchives: Array<{ id: number; season_id: number; season_name: string; completed_at: number; standings_json: unknown; player_stats_json: unknown; team_performance_json: unknown; highlights_json: unknown }>;
};

export function backendDashboard() {
  return request<BackendDashboard>("/api/dashboard");
}
export async function backendDownloadDatabaseExport() {
  const response = await fetch("/api/admin/database/export", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw || response.statusText || "The database export failed.";
    try {
      const payload = JSON.parse(raw) as { message?: string; error?: string };
      message = payload.message || payload.error || message;
    } catch { /* keep the raw response */ }
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  const contentDisposition = response.headers.get("content-disposition") || "";
  const filename = contentDisposition.match(/filename=\"([^\"]+)\"/)?.[1] || `efootball-league-database-${new Date().toISOString().slice(0, 10)}.json`;
  return { blob: await response.blob(), filename };
}

export function backendGetPlayers() {
  return request<{ players: BackendPlayerRegistryEntry[] }>("/api/admin/players");
}

export function backendGetPundits(seasonId?: number) {
  const suffix = seasonId === undefined ? "" : `?seasonId=${encodeURIComponent(String(seasonId))}`;
  return request<{ pundits: BackendPunditEditorial[] }>(`/api/pundit-editorials${suffix}`);
}

export function backendCreatePundit(input: { seasonId: number | null; publishDate: string; section: string; headline: string; dek: string; body: string; imageKey: string; facts: string[]; editorial?: ChronicleEditorial }) {
  return request<{ pundit: BackendPunditEditorial }>("/api/admin/pundits", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function backendDeletePundit(id: number) {
  return request<{ deleted: boolean; id: number }>(`/api/admin/pundits/${id}`, { method: "DELETE" });
}

export function backendGetNextFixtureNotifications() {
  return request<BackendNextFixtureNotificationsResponse>("/api/admin/notifications/next-fixtures");
}

export function backendSendNextFixtureNotifications() {
  return request<BackendNextFixtureNotificationsResponse>("/api/admin/notifications/next-fixtures", {
    method: "POST",
    body: JSON.stringify({ send: true }),
  });
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
import type { ChronicleAward, ChronicleBentoHighlight, ChronicleCrisisWatch, ChronicleEditorial, ChronicleLeadStory, ChronicleManagerPressure, ChronicleQuote, ChronicleTouchlineDispatch, Goal, LeagueDatabase, LeagueNewsStory, Match, PunditEditorial, SeasonArchive } from "./league-db";

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

function jsonFacts(value: unknown): string[] {
  const parsed = Array.isArray(value) ? value : typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : [];
  const facts = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { facts?: unknown }).facts) ? (parsed as { facts: unknown[] }).facts : [];
  return facts.map((fact) => typeof fact === "string" ? fact.trim() : fact && typeof fact === "object" ? String((fact as { value?: unknown }).value || (fact as { label?: unknown }).label || "").trim() : "").filter(Boolean).slice(0, 6);
}

function jsonEditorial(value: unknown): ChronicleEditorial | undefined {
  const parsed = jsonObject(value);
  const raw = parsed && jsonObject(parsed.editorial) ? jsonObject(parsed.editorial) : parsed;
  if (!raw || (!raw.leadStory && !Array.isArray(raw.bentoHighlights) && !raw.crisisWatch && !Array.isArray(raw.managerPressure) && !Array.isArray(raw.awards))) return undefined;
  const asNumber = (input: unknown, fallback = 0) => Number.isFinite(Number(input)) ? Number(input) : fallback;
  const leadRaw = jsonObject(raw.leadStory);
  const leadStatRaw = leadRaw ? jsonObject(leadRaw.statHighlight) : undefined;
  const leadStory: ChronicleLeadStory | undefined = leadRaw ? {
    tag: String(leadRaw.tag || "LEAD STORY").slice(0, 80),
    kicker: leadRaw.kicker ? String(leadRaw.kicker).slice(0, 100) : undefined,
    headline: String(leadRaw.headline || "").slice(0, 180),
    subdeck: String(leadRaw.subdeck || "").slice(0, 280),
    leadParagraph: leadRaw.leadParagraph ? String(leadRaw.leadParagraph).slice(0, 1100) : undefined,
    bodyParagraphs: Array.isArray(leadRaw.bodyParagraphs) ? leadRaw.bodyParagraphs.map(String).map((item) => item.slice(0, 900)).filter(Boolean).slice(0, 8) : undefined,
    statHighlight: leadStatRaw ? { value: String(leadStatRaw.value || leadStatRaw.metric || "").slice(0, 24), metric: leadStatRaw.metric ? String(leadStatRaw.metric).slice(0, 24) : undefined, label: String(leadStatRaw.label || "").slice(0, 80) } : undefined,
    body: String(leadRaw.body || "").slice(0, 5000),
    accentColor: String(leadRaw.accentColor || "#8B1E3F").slice(0, 16),
  } : undefined;
  const bentoHighlights: ChronicleBentoHighlight[] = (Array.isArray(raw.bentoHighlights) ? raw.bentoHighlights : []).slice(0, 6).map((item) => {
    const row = jsonObject(item) || {};
    const scorelineRaw = jsonObject(row.scoreline);
    return {
      type: String(row.type || row.badge || "FACT").slice(0, 40),
      tag: String(row.tag || row.badge || "THE NUMBERS").slice(0, 80),
      title: String(row.title || row.headline || "League detail").slice(0, 180),
      detail: String(row.detail || row.summary || "").slice(0, 600),
      quote: row.quote ? String(row.quote).slice(0, 360) : undefined,
      accentColor: String(row.accentColor || "#8B1E3F").slice(0, 16),
      scoreline: scorelineRaw ? { home: String(scorelineRaw.home || "Home").slice(0, 80), homeScore: asNumber(scorelineRaw.homeScore), away: String(scorelineRaw.away || "Away").slice(0, 80), awayScore: asNumber(scorelineRaw.awayScore), timeline: Array.isArray(scorelineRaw.timeline) ? scorelineRaw.timeline.slice(0, 8).map((event) => { const entry = jsonObject(event) || {}; return { player: String(entry.player || "Scorer").slice(0, 80), minute: String(entry.minute || "—").slice(0, 12) }; }) : undefined } : undefined,
    };
  });
  const chalkboardRaw = jsonObject(raw.chalkboard);
  const crisisRaw = jsonObject(raw.crisisWatch) || (chalkboardRaw ? jsonObject(chalkboardRaw.crisisRadar) : undefined);
  const crisisStats = crisisRaw ? jsonObject(crisisRaw.stats) : undefined;
  const crisisWatch: ChronicleCrisisWatch | undefined = crisisRaw ? { team: String(crisisRaw.team || "Red-zone team").slice(0, 120), status: String(crisisRaw.status || crisisRaw.badge || "WATCH").slice(0, 40), badge: crisisRaw.badge ? String(crisisRaw.badge).slice(0, 40) : undefined, statSummary: crisisRaw.statSummary ? String(crisisRaw.statSummary).slice(0, 180) : undefined, stats: { played: asNumber(crisisStats?.played), points: asNumber(crisisStats?.points), gd: asNumber(crisisStats?.gd), goalsAgainst: crisisStats?.goalsAgainst === undefined ? undefined : asNumber(crisisStats.goalsAgainst), goalsAgainstPerGame: crisisStats?.goalsAgainstPerGame === undefined ? undefined : asNumber(crisisStats.goalsAgainstPerGame), cleanSheets: crisisStats?.cleanSheets === undefined ? undefined : asNumber(crisisStats.cleanSheets) }, verdict: String(crisisRaw.verdict || "The next fixture carries pressure.").slice(0, 360) } : undefined;
  const managerPressure: ChronicleManagerPressure[] = (Array.isArray(raw.managerPressure) ? raw.managerPressure : []).slice(0, 8).map((item) => { const row = jsonObject(item) || {}; return { manager: String(row.manager || "Manager").slice(0, 120), team: String(row.team || "Team").slice(0, 120), label: String(row.label || row.status || "UNDER REVIEW").slice(0, 40), score: Math.max(0, Math.min(100, asNumber(row.score))), note: String(row.note || row.verdict || "Pressure is building.").slice(0, 360) }; });
  const awards: ChronicleAward[] = (Array.isArray(raw.awards) ? raw.awards : []).slice(0, 6).map((item) => { const row = jsonObject(item) || {}; return { kind: String(row.kind || "TEAM_OF_WEEK").slice(0, 40), label: String(row.label || "WEEKLY FILE").slice(0, 60), name: String(row.name || row.player || row.team || "League figure").slice(0, 120), team: row.team ? String(row.team).slice(0, 120) : undefined, detail: String(row.detail || row.note || "").slice(0, 360) }; });
  const quoteRaw = jsonObject(raw.quoteOfMatchday);
  const quoteOfMatchday: ChronicleQuote | undefined = typeof raw.quoteOfMatchday === "string" ? { quote: String(raw.quoteOfMatchday).slice(0, 420) } : quoteRaw ? { quote: String(quoteRaw.quote || quoteRaw.text || "").slice(0, 420), attribution: quoteRaw.attribution ? String(quoteRaw.attribution).slice(0, 160) : undefined } : undefined;
  const touchlineDispatches: ChronicleTouchlineDispatch[] = (Array.isArray(raw.touchlineDispatches) ? raw.touchlineDispatches : []).slice(0, 6).map((item) => { const row = jsonObject(item) || {}; return { tag: String(row.tag || "TOUCHLINE DISPATCH").slice(0, 80), title: String(row.title || "Dispatch").slice(0, 180), blurb: String(row.blurb || row.description || "").slice(0, 500) }; });
  return { edition: raw.edition ? String(raw.edition).slice(0, 120) : undefined, dateline: raw.dateline ? String(raw.dateline).slice(0, 140) : undefined, leadStory, bentoHighlights, crisisWatch, managerPressure, awards, quoteOfMatchday: quoteOfMatchday?.quote ? quoteOfMatchday : undefined, touchlineDispatches };
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
    punditEditorials: snapshot.pundits.map((story): PunditEditorial => ({
      id: String(story.id),
      seasonId: story.season_id === null ? undefined : String(story.season_id),
      publishDate: story.publish_date,
      section: story.section,
      headline: story.headline,
      dek: story.dek,
      body: story.body,
      imageKey: story.image_key,
      facts: jsonFacts(story.facts_json),
      editorial: jsonEditorial(story.facts_json),
      createdByEmail: story.created_by_email || undefined,
      createdAt: new Date(Number(story.created_at)).toISOString(),
    })),
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


export type ProposedNotification = {
  id: number;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: number;
};

export type BackendMatchDetails = {
  match: { id: number; seasonId: number; matchday: number; kickoffAt: number; status: string; homeScore: number | null; awayScore: number | null; home: { id: number; name: string; shortCode: string; accent: string }; away: { id: number; name: string; shortCode: string; accent: string } };
  goals: Array<{ id: number; teamId: number; teamName: string; teamShortCode: string; playerName: string; playerEmail: string | null; minute: number }>;
  proofs: Array<{ id: number; uploadedByEmail: string; fileName: string; mimeType: string; fileSize: number; dataUrl: string; status: "PENDING" | "APPROVED" | "REJECTED"; reviewNote: string | null; createdAt: number; reviewedAt: number | null }>;
  predictions: Array<{ userEmail: string; displayName: string; homeScore: number; awayScore: number; points: number | null; updatedAt: number; isMine: boolean }>;
  meetings: Array<{ id: number; matchday: number; kickoffAt: number; homeScore: number; awayScore: number; homeTeamName: string; awayTeamName: string }>;
};

export type PredictionDashboard = {
  mine: Array<{ matchId: number; matchday: number; kickoffAt: number; status: string; homeTeamName: string; awayTeamName: string; homeScore: number; awayScore: number; points: number | null; updatedAt: number }>;
  leaderboard: Array<{ rank: number; email: string; displayName: string; points: number; predictions: number; scoredPredictions: number }>;
};

export type FeatureAward = { id: number; seasonId: number; matchday: number; awardType: string; subjectName: string; teamId: number | null; teamName: string | null; citation: string; createdAt: number };
export type HeadToHeadResult = { meetings: Array<{ id: number; matchday: number; kickoffAt: number; homeTeamId: number; awayTeamId: number; homeScore: number; awayScore: number; homeTeamName: string; awayTeamName: string }>; aggregate: { teamA: { wins: number; draws: number; goals: number }; teamB: { wins: number; draws: number; goals: number } } };
export type DiscordSettings = { enabled: boolean; label: string; configured: boolean; updatedAt: number | null };

export function backendGetNotifications() { return request<{ notifications: ProposedNotification[]; unreadCount: number }>("/api/notifications"); }
export function backendMarkNotificationRead(id: number) { return request<{ ok: true }>(`/api/notifications/${id}/read`, { method: "POST" }); }
export function backendMarkAllNotificationsRead() { return request<{ ok: true }>("/api/notifications/read-all", { method: "POST" }); }
export function backendGetMatchDetails(matchId: number) { return request<BackendMatchDetails>(`/api/matches/${matchId}/details`); }
export function backendSavePrediction(matchId: number, homeScore: number, awayScore: number) { return request<{ ok: true }>(`/api/matches/${matchId}/prediction`, { method: "POST", body: JSON.stringify({ homeScore, awayScore }) }); }
export function backendGetPredictions(seasonId?: number) { const suffix = seasonId === undefined ? "" : `?seasonId=${encodeURIComponent(String(seasonId))}`; return request<PredictionDashboard>(`/api/predictions${suffix}`); }
export function backendUploadProof(matchId: number, input: { fileName: string; mimeType: string; fileSize: number; dataUrl: string }) { return request<{ id: number }>(`/api/matches/${matchId}/proof`, { method: "POST", body: JSON.stringify(input) }); }
export function backendReviewProof(matchId: number, proofId: number, status: "APPROVED" | "REJECTED", note = "") { return request<{ ok: true; status: string }>(`/api/admin/matches/${matchId}/proofs/${proofId}/review`, { method: "POST", body: JSON.stringify({ status, note }) }); }
export function backendGetAwards(seasonId?: number) { const suffix = seasonId === undefined ? "" : `?seasonId=${encodeURIComponent(String(seasonId))}`; return request<{ awards: FeatureAward[] }>(`/api/awards${suffix}`); }
export function backendCreateAward(input: { seasonId: number; matchday: number; awardType: string; subjectName: string; teamId?: number | null; citation: string }) { return request<{ id: number }>("/api/admin/awards", { method: "POST", body: JSON.stringify(input) }); }
export function backendDeleteAward(id: number) { return request<{ ok: true }>(`/api/admin/awards/${id}`, { method: "DELETE" }); }
export function backendGetHeadToHead(teamA: number, teamB: number) { return request<HeadToHeadResult>(`/api/head-to-head?teamA=${encodeURIComponent(String(teamA))}&teamB=${encodeURIComponent(String(teamB))}`); }
export async function backendDownloadCalendar(seasonId?: number) { const suffix = seasonId === undefined ? "" : `?seasonId=${encodeURIComponent(String(seasonId))}`; const response = await fetch(`/api/calendar.ics${suffix}`, { credentials: "include", cache: "no-store" }); if (!response.ok) throw new Error((await response.text()) || "Calendar export failed."); return { blob: await response.blob(), filename: "eleague-fixtures.ics" }; }
export function backendGetDiscordSettings() { return request<DiscordSettings>("/api/admin/discord-settings"); }
export function backendSaveDiscordSettings(input: { webhookUrl: string; enabled: boolean; label: string }) { return request<DiscordSettings>("/api/admin/discord-settings", { method: "POST", body: JSON.stringify(input) }); }
export function backendTestDiscord() { return request<{ posted: boolean; reason?: string }>("/api/admin/discord/test", { method: "POST" }); }
export function backendGetPunditFeed() { return request<{ pundits: BackendPunditEditorial[] }>("/api/pundit-editorials"); }
