import { createHash } from "node:crypto";
import { query } from "./db";
import { calculateStandings } from "./league-service";

const LEAGUE_TIME_ZONE = "Asia/Kolkata";
const HUGGING_FACE_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
const DEFAULT_HUGGING_FACE_MODEL = "Qwen/Qwen3-4B-Instruct-2507";

type NewsStoryType = "MATCHDAY_RECAP" | "UPCOMING_PREVIEW" | "STAT_FACT" | "SEASON_SUMMARY";
type NewsRow = { id: number; season_id: number | null; story_date: string; story_type: NewsStoryType; headline: string; description: string; data_json: unknown; evidence_json: unknown; model: string | null; generated_at: number };
type ArchiveRow = { id: number; season_id: number; season_name: string; completed_at: number; standings_json: unknown; player_stats_json: unknown; team_performance_json: unknown; highlights_json: unknown };
export type PunditRow = { id: number; season_id: number | null; publish_date: string; section: string; headline: string; dek: string; body: string; image_key: string; facts_json: unknown; created_by_email: string | null; created_at: number; updated_at: number };

type Evidence = {
  seasonId: number;
  seasonName: string;
  status: string;
  asOfDate: string;
  confirmedMatches: number;
  totalMatches: number;
  standings: Array<Record<string, unknown>>;
  topScorers: Array<Record<string, unknown>>;
  teamPerformance: Array<Record<string, unknown>>;
  latestResults: Array<Record<string, unknown>>;
  upcomingMatches: Array<Record<string, unknown>>;
  facts: Record<string, string>;
  previousSeasons: Array<Record<string, unknown>>;
};

type GeneratedStory = { storyType: NewsStoryType; headline: string; description: string; factIds: string[] };

function leagueDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: LEAGUE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function json(value: unknown) { return JSON.stringify(value ?? []); }
function clip(value: unknown, limit: number) { return String(value ?? "").trim().slice(0, limit); }
function numeric(value: unknown) { return Number(value || 0); }
function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function extractJson(value: string): Record<string, unknown> | null {
  const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? parseObject(trimmed.slice(start, end + 1)) : null;
}

function safeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringList(value: unknown, maxItems = 8, itemLimit = 600) {
  return Array.isArray(value) ? value.map((item) => clip(item, itemLimit)).filter(Boolean).slice(0, maxItems) : [];
}

function normalizeEditorial(value: unknown): Record<string, unknown> | null {
  const raw = parseObject(value);
  if (!raw) return null;
  const lead = parseObject(raw.leadStory);
  const leadStat = lead ? parseObject(lead.statHighlight) : null;
  const bodyParagraphs = lead ? stringList(lead.bodyParagraphs, 8, 900) : [];
  const leadParagraph = lead?.leadParagraph ? clip(lead.leadParagraph, 1100) : undefined;
  const body = clip(lead?.body || [leadParagraph, ...bodyParagraphs].filter(Boolean).join("\n\n"), 5000);
  const bentoHighlights = (Array.isArray(raw.bentoHighlights) ? raw.bentoHighlights : []).slice(0, 6).map((item) => {
    const row = parseObject(item);
    if (!row) return null;
    const scoreline = parseObject(row.scoreline);
    return {
      type: clip(row.type || row.badge || "FACT", 40),
      tag: clip(row.tag || row.badge || "THE NUMBERS", 80),
      title: clip(row.title || row.headline || "League detail", 180),
      detail: clip(row.detail || row.summary || "", 600),
      quote: row.quote ? clip(row.quote, 360) : undefined,
      accentColor: clip(row.accentColor || "#8B1E3F", 16),
      scoreline: scoreline ? {
        home: clip(scoreline.home || "Home", 80),
        homeScore: Math.max(0, Math.min(99, safeNumber(scoreline.homeScore))),
        away: clip(scoreline.away || "Away", 80),
        awayScore: Math.max(0, Math.min(99, safeNumber(scoreline.awayScore))),
        timeline: Array.isArray(scoreline.timeline) ? scoreline.timeline.slice(0, 8).map((event) => { const entry = parseObject(event); return entry ? { player: clip(entry.player || "Scorer", 80), minute: clip(entry.minute || "—", 12) } : null; }).filter(Boolean) : undefined,
      } : undefined,
    };
  }).filter(Boolean);
  const chalkboard = parseObject(raw.chalkboard);
  const crisis = parseObject(raw.crisisWatch) || (chalkboard ? parseObject(chalkboard.crisisRadar) : null);
  const crisisStats = crisis ? parseObject(crisis.stats) : null;
  const managerPressure = (Array.isArray(raw.managerPressure) ? raw.managerPressure : []).slice(0, 8).map((item) => {
    const row = parseObject(item);
    if (!row) return null;
    return {
      manager: clip(row.manager || "Manager", 120),
      team: clip(row.team || "Team", 120),
      label: clip(row.label || row.status || "UNDER REVIEW", 40),
      score: Math.max(0, Math.min(100, safeNumber(row.score))),
      note: clip(row.note || row.verdict || "Pressure is building.", 360),
    };
  }).filter(Boolean);
  const awards = (Array.isArray(raw.awards) ? raw.awards : []).slice(0, 6).map((item) => {
    const row = parseObject(item);
    if (!row) return null;
    return {
      kind: clip(row.kind || "TEAM_OF_WEEK", 40),
      label: clip(row.label || "WEEKLY FILE", 60),
      name: clip(row.name || row.player || row.team || "League figure", 120),
      team: row.team ? clip(row.team, 120) : undefined,
      detail: clip(row.detail || row.note || "", 360),
    };
  }).filter(Boolean);
  const quoteRaw = parseObject(raw.quoteOfMatchday);
  const quoteOfMatchday = typeof raw.quoteOfMatchday === "string" ? { quote: clip(raw.quoteOfMatchday, 420) } : quoteRaw ? { quote: clip(quoteRaw.quote || quoteRaw.text || "", 420), attribution: quoteRaw.attribution ? clip(quoteRaw.attribution, 160) : undefined } : undefined;
  const touchlineDispatches = (Array.isArray(raw.touchlineDispatches) ? raw.touchlineDispatches : []).slice(0, 6).map((item) => {
    const row = parseObject(item);
    if (!row) return null;
    return { tag: clip(row.tag || "TOUCHLINE DISPATCH", 80), title: clip(row.title || "Dispatch", 180), blurb: clip(row.blurb || row.description || "", 500) };
  }).filter(Boolean);
  return {
    edition: raw.edition ? clip(raw.edition, 120) : undefined,
    dateline: raw.dateline ? clip(raw.dateline, 140) : undefined,
    leadStory: lead ? {
      tag: clip(lead.tag || "LEAD STORY", 80),
      kicker: lead.kicker ? clip(lead.kicker, 100) : undefined,
      headline: clip(lead.headline || "", 180),
      subdeck: clip(lead.subdeck || "", 280),
      leadParagraph,
      bodyParagraphs,
      statHighlight: leadStat ? { value: clip(leadStat.value || leadStat.metric || "", 24), metric: leadStat.metric ? clip(leadStat.metric, 24) : undefined, label: clip(leadStat.label || "", 80) } : undefined,
      body,
      accentColor: clip(lead.accentColor || "#8B1E3F", 16),
    } : undefined,
    bentoHighlights,
    crisisWatch: crisis ? {
      team: clip(crisis.team || "Red-zone team", 120),
      status: clip(crisis.status || crisis.badge || "WATCH", 40),
      badge: crisis.badge ? clip(crisis.badge, 40) : undefined,
      statSummary: crisis.statSummary ? clip(crisis.statSummary, 180) : undefined,
      stats: { played: Math.max(0, safeNumber(crisisStats?.played)), points: Math.max(0, safeNumber(crisisStats?.points)), gd: safeNumber(crisisStats?.gd), goalsAgainst: crisisStats?.goalsAgainst === undefined ? undefined : Math.max(0, safeNumber(crisisStats.goalsAgainst)), goalsAgainstPerGame: crisisStats?.goalsAgainstPerGame === undefined ? undefined : Math.max(0, safeNumber(crisisStats.goalsAgainstPerGame)), cleanSheets: crisisStats?.cleanSheets === undefined ? undefined : Math.max(0, safeNumber(crisisStats.cleanSheets)) },
      verdict: clip(crisis.verdict || "The next fixture carries pressure.", 360),
    } : undefined,
    managerPressure,
    awards,
    quoteOfMatchday: quoteOfMatchday?.quote ? quoteOfMatchday : undefined,
    touchlineDispatches,
  };
}
function modelConfig() {
  const token = process.env.HF_TOKEN?.trim();
  return token ? { token, model: process.env.HF_MODEL?.trim() || DEFAULT_HUGGING_FACE_MODEL } : null;
}

let tablesReady: Promise<void> | null = null;
export async function ensureNewsTables() {
  if (!tablesReady) {
    tablesReady = Promise.all([
      query(`CREATE TABLE IF NOT EXISTS league_news (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        season_id BIGINT UNSIGNED NULL,
        story_date VARCHAR(10) NOT NULL,
        story_type ENUM('MATCHDAY_RECAP', 'UPCOMING_PREVIEW', 'STAT_FACT', 'SEASON_SUMMARY') NOT NULL,
        story_key VARCHAR(160) NOT NULL,
        headline VARCHAR(180) NOT NULL,
        description TEXT NOT NULL,
        data_json JSON NULL,
        evidence_json JSON NOT NULL,
        evidence_signature CHAR(64) NOT NULL,
        model VARCHAR(160) NULL,
        generated_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY league_news_cycle_uq (season_id, story_date, story_type),
        INDEX league_news_season_idx (season_id, generated_at),
        CONSTRAINT league_news_season_fk FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
      query(`CREATE TABLE IF NOT EXISTS season_archives (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        season_id BIGINT UNSIGNED NOT NULL,
        season_name VARCHAR(120) NOT NULL,
        completed_at BIGINT NOT NULL,
        standings_json JSON NOT NULL,
        player_stats_json JSON NOT NULL,
        team_performance_json JSON NOT NULL,
        highlights_json JSON NOT NULL,
        UNIQUE KEY season_archives_season_uq (season_id),
        INDEX season_archives_completed_idx (completed_at),
        CONSTRAINT season_archives_season_fk FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
      query(`CREATE TABLE IF NOT EXISTS pundit_editorials (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        season_id BIGINT UNSIGNED NULL,
        publish_date VARCHAR(10) NOT NULL,
        section VARCHAR(80) NOT NULL DEFAULT 'THE PUNDIT DESK',
        headline VARCHAR(180) NOT NULL,
        dek VARCHAR(280) NOT NULL,
        body TEXT NOT NULL,
        image_key VARCHAR(80) NOT NULL DEFAULT 'goal-celebration',
        facts_json JSON NULL,
        created_by_email VARCHAR(255) NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX pundit_editorials_date_idx (publish_date, updated_at),
        INDEX pundit_editorials_season_idx (season_id),
        CONSTRAINT pundit_editorials_season_fk FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`),
    ]).then(() => undefined).catch((error) => { tablesReady = null; throw error; });
  }
  await tablesReady;
}

async function buildEvidence(seasonId: number): Promise<Evidence> {
  const [seasonRows, teamRows, matchRows, goalRows, archiveRows] = await Promise.all([
    query<Array<{ id: number; name: string; status: string }>>("SELECT id, name, status FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId }),
    query<Array<{ id: number; name: string; short_code: string }>>("SELECT id, name, short_code FROM teams WHERE status = 'APPROVED' ORDER BY id", {}),
    query<Array<{ id: number; matchday: number; kickoff_at: number; home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null; status: string }>>("SELECT id, matchday, kickoff_at, home_team_id, away_team_id, home_score, away_score, status FROM matches WHERE season_id = :seasonId ORDER BY kickoff_at, id", { seasonId }),
    query<Array<{ match_id: number; team_id: number; player_email: string | null; scorer_name: string; minute: number }>>("SELECT g.match_id, g.team_id, g.player_email, g.scorer_name, g.minute FROM goals g JOIN matches m ON m.id = g.match_id WHERE m.season_id = :seasonId AND m.status = 'CONFIRMED' ORDER BY m.kickoff_at DESC, g.minute", { seasonId }),
    query<Array<{ id: number; season_id: number; season_name: string; completed_at: number; standings_json: unknown }>>("SELECT id, season_id, season_name, completed_at, standings_json FROM season_archives WHERE season_id <> :seasonId ORDER BY completed_at DESC LIMIT 5", { seasonId }),
  ]);
  const season = seasonRows[0];
  if (!season) throw new Error("Season not found.");
  const teamById = new Map(teamRows.map((team) => [Number(team.id), team]));
  const confirmedRows = matchRows.filter((match) => match.status === "CONFIRMED" && match.home_score !== null && match.away_score !== null);
  const standings = calculateStandings(teamRows.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), confirmedRows.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: numeric(match.home_score), awayScore: numeric(match.away_score) })));
  const teamPerformanceMap = new Map<number, Record<string, unknown>>();
  for (const team of teamRows) teamPerformanceMap.set(Number(team.id), { teamId: Number(team.id), teamName: team.name, shortCode: team.short_code, goalsFor: 0, goalsAgainst: 0, matchesPlayed: 0, cleanSheets: 0 });
  for (const match of confirmedRows) {
    const home = teamPerformanceMap.get(Number(match.home_team_id));
    const away = teamPerformanceMap.get(Number(match.away_team_id));
    if (!home || !away) continue;
    home.goalsFor = numeric(home.goalsFor) + numeric(match.home_score); home.goalsAgainst = numeric(home.goalsAgainst) + numeric(match.away_score); home.matchesPlayed = numeric(home.matchesPlayed) + 1; if (numeric(match.away_score) === 0) home.cleanSheets = numeric(home.cleanSheets) + 1;
    away.goalsFor = numeric(away.goalsFor) + numeric(match.away_score); away.goalsAgainst = numeric(away.goalsAgainst) + numeric(match.home_score); away.matchesPlayed = numeric(away.matchesPlayed) + 1; if (numeric(match.home_score) === 0) away.cleanSheets = numeric(away.cleanSheets) + 1;
  }
  const teamPerformance = Array.from(teamPerformanceMap.values()).sort((a, b) => numeric(b.goalsFor) - numeric(a.goalsFor));
  const scorerMap = new Map<string, Record<string, unknown>>();
  for (const goal of goalRows) {
    const key = `${goal.team_id}:${goal.player_email || goal.scorer_name.toLowerCase()}`;
    const current = scorerMap.get(key) || { name: goal.scorer_name, playerEmail: goal.player_email, teamId: Number(goal.team_id), teamName: teamById.get(Number(goal.team_id))?.name || "Unknown team", goals: 0 };
    current.goals = numeric(current.goals) + 1;
    scorerMap.set(key, current);
  }
  const topScorers = Array.from(scorerMap.values()).sort((a, b) => numeric(b.goals) - numeric(a.goals)).slice(0, 8);
  const latestResults = confirmedRows.slice(-6).reverse().map((match) => ({ matchday: Number(match.matchday), date: leagueDateKey(Number(match.kickoff_at)), home: teamById.get(Number(match.home_team_id))?.name, away: teamById.get(Number(match.away_team_id))?.name, score: `${numeric(match.home_score)}-${numeric(match.away_score)}` }));
  const upcomingMatches = matchRows.filter((match) => match.status === "SCHEDULED" || match.status === "POSTPONED").slice(0, 6).map((match) => ({ matchday: Number(match.matchday), date: leagueDateKey(Number(match.kickoff_at)), kickoffAt: Number(match.kickoff_at), home: teamById.get(Number(match.home_team_id))?.name, away: teamById.get(Number(match.away_team_id))?.name }));
  const leader = standings[0];
  const topScorer = topScorers[0];
  const cleanSheetLeader = [...teamPerformance].sort((a, b) => numeric(b.cleanSheets) - numeric(a.cleanSheets))[0];
  const facts: Record<string, string> = {
    confirmed_matches: `${confirmedRows.length} of ${matchRows.length} scheduled matches are confirmed.`,
    leader: leader ? `${leader.name} leads the table with ${leader.points} points from ${leader.played} matches.` : "There is no confirmed standings leader yet.",
    top_scorer: topScorer ? `${topScorer.name} leads the scoring chart with ${topScorer.goals} goals for ${topScorer.teamName}.` : "No confirmed goals have been recorded yet.",
    clean_sheet_leader: cleanSheetLeader ? `${cleanSheetLeader.teamName} recorded ${cleanSheetLeader.cleanSheets} clean sheet${numeric(cleanSheetLeader.cleanSheets) === 1 ? "" : "s"} from ${cleanSheetLeader.matchesPlayed} confirmed matches.` : "No clean sheets are recorded yet.",
    latest_result: latestResults[0] ? (() => { const [homeScore, awayScore] = String(latestResults[0].score).split("-").map(Number); const result = homeScore === awayScore ? `${latestResults[0].home} drew ${latestResults[0].away}` : homeScore > awayScore ? `${latestResults[0].home} beat ${latestResults[0].away}` : `${latestResults[0].away} beat ${latestResults[0].home}`; return `${result} in the latest recorded scoreline ${latestResults[0].score}.`; })() : "There is no confirmed result to recap yet.",
    next_match: upcomingMatches[0] ? `The next listed fixture is ${upcomingMatches[0].home} versus ${upcomingMatches[0].away} on ${upcomingMatches[0].date}.` : "There is no upcoming fixture currently listed.",
  };
  return { seasonId, seasonName: season.name, status: season.status, asOfDate: leagueDateKey(), confirmedMatches: confirmedRows.length, totalMatches: matchRows.length, standings: standings.slice(0, 8) as unknown as Array<Record<string, unknown>>, topScorers, teamPerformance, latestResults, upcomingMatches, facts, previousSeasons: archiveRows.map((archive) => ({ seasonName: archive.season_name, completedAt: archive.completed_at, standings: parseObject(archive.standings_json) || archive.standings_json })) };
}

function fallbackStories(evidence: Evidence): GeneratedStory[] {
  const stories: GeneratedStory[] = [];
  if (evidence.latestResults.length) stories.push({ storyType: "MATCHDAY_RECAP", headline: `The latest matchday leaves ${evidence.seasonName} with more to watch`, description: `${evidence.facts.latest_result} The official table now has ${evidence.facts.confirmed_matches.toLowerCase()}`, factIds: ["latest_result", "confirmed_matches"] });
  if (evidence.upcomingMatches.length) stories.push({ storyType: "UPCOMING_PREVIEW", headline: `Next up: ${evidence.upcomingMatches[0].home} meet ${evidence.upcomingMatches[0].away}`, description: `${evidence.facts.next_match} The fixture is part of the upcoming schedule and has not been treated as a result.`, factIds: ["next_match"] });
  if (evidence.topScorers.length || evidence.teamPerformance.length) stories.push({ storyType: "STAT_FACT", headline: evidence.topScorers.length ? `${evidence.topScorers[0].name} sets the early scoring pace` : "The league is building its scoring picture", description: `${evidence.facts.top_scorer} ${evidence.facts.leader}`, factIds: ["top_scorer", "leader"] });
  return completeStoryCoverage(stories, evidence);
}

function completeStoryCoverage(stories: GeneratedStory[], evidence: Evidence): GeneratedStory[] {
  const unique: GeneratedStory[] = [];
  const seen = new Set<NewsStoryType>();
  for (const story of stories) {
    if (!seen.has(story.storyType)) {
      seen.add(story.storyType);
      unique.push(story);
    }
  }
  if (evidence.latestResults.length && !seen.has("MATCHDAY_RECAP")) unique.push({ storyType: "MATCHDAY_RECAP", headline: `Latest results reshape ${evidence.seasonName}`, description: `${evidence.facts.latest_result} ${evidence.facts.confirmed_matches}`, factIds: ["latest_result", "confirmed_matches"] });
  if (evidence.upcomingMatches.length && !seen.has("UPCOMING_PREVIEW")) unique.push({ storyType: "UPCOMING_PREVIEW", headline: `Next up: ${evidence.upcomingMatches[0].home} meet ${evidence.upcomingMatches[0].away}`, description: `${evidence.facts.next_match} This is a scheduled fixture, not a completed result.`, factIds: ["next_match"] });
  if (evidence.teamPerformance.length && !seen.has("STAT_FACT")) unique.push({ storyType: "STAT_FACT", headline: evidence.topScorers.length ? `${evidence.topScorers[0].name} sets the early scoring pace` : "The league is building its scoring picture", description: `${evidence.facts.top_scorer} ${evidence.facts.leader}`, factIds: ["top_scorer", "leader"] });
  return unique.slice(0, 3);
}

async function aiStories(evidence: Evidence): Promise<GeneratedStory[]> {
  const config = modelConfig();
  if (!config) return fallbackStories(evidence);
  const prompt = [
    "You are a careful football league news editor.",
    "Use only the supplied evidence. Do not invent players, goals, scores, rivalries, streaks, transfers, emotions, or statistics.",
    "Choose only factIds that exist in the evidence facts object. If the data is not interesting, say that plainly.",
    "Return JSON only in this exact shape: {\"stories\":[{\"storyType\":\"MATCHDAY_RECAP|UPCOMING_PREVIEW|STAT_FACT\",\"headline\":\"...\",\"description\":\"...\",\"factIds\":[\"...\"]}]}.",
    "Write concise sports-report copy. Upcoming fixtures must never be described as completed. Do not include a table; the server will attach a verified data table.",
    JSON.stringify({ evidence, facts: evidence.facts }),
  ].join("\n\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(HUGGING_FACE_CHAT_URL, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: "Return valid JSON only." }, { role: "user", content: prompt }], temperature: 0.2, max_tokens: 600 }), signal: controller.signal });
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? extractJson(content) : null;
    const allowed = new Set(Object.keys(evidence.facts));
    const stories = Array.isArray(parsed?.stories) ? parsed.stories.map((story) => {
      const item = parseObject(story);
      if (!item) return null;
      const storyType = String(item.storyType || "") as NewsStoryType;
      const factIds = Array.isArray(item.factIds) ? item.factIds.map(String).filter((id) => allowed.has(id)) : [];
      if (!["MATCHDAY_RECAP", "UPCOMING_PREVIEW", "STAT_FACT"].includes(storyType) || !factIds.length) return null;
      return { storyType, headline: clip(item.headline, 180), description: clip(item.description, 900), factIds };
    }).filter((story): story is GeneratedStory => Boolean(story && story.headline && story.description)) : [];
    return stories.length ? completeStoryCoverage(stories, evidence) : fallbackStories(evidence);
  } catch { return fallbackStories(evidence); } finally { clearTimeout(timeout); }
}

function storyData(storyType: NewsStoryType, evidence: Evidence) {
  if (storyType === "MATCHDAY_RECAP") return { columns: ["Matchday", "Fixture", "Score"], rows: evidence.latestResults.map((match) => [match.matchday, `${match.home} vs ${match.away}`, match.score]) };
  if (storyType === "UPCOMING_PREVIEW") return { columns: ["Matchday", "Date", "Fixture"], rows: evidence.upcomingMatches.map((match) => [match.matchday, match.date, `${match.home} vs ${match.away}`]) };
  if (storyType === "SEASON_SUMMARY") return { columns: ["Rank", "Team", "Points", "Goals For"], rows: evidence.standings.map((row) => [row.rank, row.name, row.points, row.goalsFor]) };
  return { columns: ["Team", "Goals For", "Clean Sheets"], rows: evidence.teamPerformance.slice(0, 5).map((row) => [row.teamName, row.goalsFor, row.cleanSheets]) };
}

export async function refreshLeagueNews(seasonId: number) {
  await ensureNewsTables();
  const evidence = await buildEvidence(seasonId);
  const generated = await aiStories(evidence);
  if (evidence.status === "COMPLETED") generated.push({ storyType: "SEASON_SUMMARY", headline: `Season archive: ${evidence.seasonName}`, description: `${evidence.facts.leader} ${evidence.facts.top_scorer} ${evidence.facts.clean_sheet_leader}`, factIds: ["leader", "top_scorer", "clean_sheet_leader"] });
  const now = Date.now();
  const model = modelConfig()?.model || "evidence-only-fallback";
  for (const story of generated) {
    const evidenceJson = json({ facts: Object.fromEntries(story.factIds.map((id) => [id, evidence.facts[id]])), asOfDate: evidence.asOfDate, confirmedMatches: evidence.confirmedMatches, totalMatches: evidence.totalMatches });
    const dataJson = json(storyData(story.storyType, evidence));
    const signature = createHash("sha256").update(`${evidenceJson}:${dataJson}`).digest("hex");
    await query(`INSERT INTO league_news (season_id, story_date, story_type, story_key, headline, description, data_json, evidence_json, evidence_signature, model, generated_at, updated_at)
      VALUES (:seasonId, :storyDate, :storyType, :storyKey, :headline, :description, :dataJson, :evidenceJson, :signature, :model, :now, :now)
      ON DUPLICATE KEY UPDATE headline = VALUES(headline), description = VALUES(description), data_json = VALUES(data_json), evidence_json = VALUES(evidence_json), evidence_signature = VALUES(evidence_signature), model = VALUES(model), generated_at = VALUES(generated_at), updated_at = VALUES(updated_at)`, { seasonId, storyDate: evidence.asOfDate, storyType: story.storyType, storyKey: `${seasonId}:${evidence.asOfDate}:${story.storyType}`, headline: story.headline, description: story.description, dataJson, evidenceJson, signature, model, now });
  }
  return { generated: generated.length, storyDate: evidence.asOfDate, stories: await getNewsRows(seasonId) };
}

export async function getNewsRows(seasonId?: number) {
  await ensureNewsTables();
  const seasonFilter = seasonId === undefined ? "" : "WHERE season_id = :seasonId AND story_date = (SELECT MAX(latest.story_date) FROM league_news latest WHERE latest.season_id = :latestSeasonId)";
  return query<NewsRow[]>(`SELECT id, season_id, story_date, story_type, headline, description, data_json, evidence_json, model, generated_at FROM league_news ${seasonFilter} ORDER BY story_date DESC, generated_at DESC, id DESC LIMIT 50`, seasonId === undefined ? {} : { seasonId, latestSeasonId: seasonId });
}

export async function getArchiveRows() {
  await ensureNewsTables();
  return query<ArchiveRow[]>("SELECT id, season_id, season_name, completed_at, standings_json, player_stats_json, team_performance_json, highlights_json FROM season_archives ORDER BY completed_at DESC LIMIT 20", {});
}

export async function getPunditRows(seasonId?: number) {
  await ensureNewsTables();
  const where = seasonId === undefined ? "" : "WHERE season_id = :seasonId OR season_id IS NULL";
  return query<PunditRow[]>(`SELECT id, season_id, publish_date, section, headline, dek, body, image_key, facts_json, created_by_email, created_at, updated_at FROM pundit_editorials ${where} ORDER BY publish_date DESC, updated_at DESC, id DESC LIMIT 50`, seasonId === undefined ? {} : { seasonId });
}

export async function createPunditEditorial(input: { seasonId: number | null; publishDate: string; section: string; headline: string; dek: string; body: string; imageKey: string; facts: unknown; editorial?: unknown; createdByEmail: string | null }) {
  await ensureNewsTables();
  const now = Date.now();
  const editorial = normalizeEditorial(input.editorial);
  const facts = Array.isArray(input.facts) ? input.facts.map((fact) => clip(fact, 360)).filter(Boolean).slice(0, 6) : [];
  const factsPayload = editorial ? { facts, editorial } : facts;
  const result = await query<{ insertId: number }>(`INSERT INTO pundit_editorials (season_id, publish_date, section, headline, dek, body, image_key, facts_json, created_by_email, created_at, updated_at)
    VALUES (:seasonId, :publishDate, :section, :headline, :dek, :body, :imageKey, :factsJson, :createdByEmail, :now, :now)`, { seasonId: input.seasonId, publishDate: input.publishDate, section: input.section, headline: input.headline, dek: input.dek, body: input.body, imageKey: input.imageKey, factsJson: json(factsPayload), createdByEmail: input.createdByEmail, now });
  const id = Number(result[0]?.insertId || 0);
  const rows = await query<PunditRow[]>("SELECT id, season_id, publish_date, section, headline, dek, body, image_key, facts_json, created_by_email, created_at, updated_at FROM pundit_editorials WHERE id = :id LIMIT 1", { id });
  return rows[0];
}

export async function deletePunditEditorial(id: number) {
  await ensureNewsTables();
  await query("DELETE FROM pundit_editorials WHERE id = :id", { id });
  return { deleted: true, id };
}

export async function archiveSeasonSnapshot(seasonId: number) {
  await ensureNewsTables();
  const evidence = await buildEvidence(seasonId);
  const existing = await query<Array<{ id: number }>>("SELECT id FROM season_archives WHERE season_id = :seasonId LIMIT 1", { seasonId });
  if (!existing[0]) {
    const highlights = Object.entries(evidence.facts).map(([key, value]) => ({ key, value }));
    const playerStats = evidence.topScorers;
    await query(`INSERT INTO season_archives (season_id, season_name, completed_at, standings_json, player_stats_json, team_performance_json, highlights_json)
      VALUES (:seasonId, :seasonName, :completedAt, :standings, :playerStats, :teamPerformance, :highlights)`, { seasonId, seasonName: evidence.seasonName, completedAt: Date.now(), standings: json(evidence.standings), playerStats: json(playerStats), teamPerformance: json(evidence.teamPerformance), highlights: json(highlights) });
  }
  await query("UPDATE seasons SET status = 'COMPLETED', updated_at = :now WHERE id = :seasonId", { seasonId, now: Date.now() });
  await refreshLeagueNews(seasonId);
  return { archived: !existing[0], seasonId, status: "COMPLETED" };
}
