// server/app.ts
import express from "express";
import { randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { OAuth2Client } from "google-auth-library";

// server/auth.ts
import { promisify } from "node:util";
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// server/db.ts
import mysql from "mysql2/promise";
var pool;
function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}
function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured. Add a MySQL or TiDB connection string before using the API.");
  }
  if (!pool) {
    const connectionUrl = new URL(process.env.DATABASE_URL);
    pool = mysql.createPool({
      host: connectionUrl.hostname,
      port: Number(connectionUrl.port || 3306),
      user: decodeURIComponent(connectionUrl.username),
      password: decodeURIComponent(connectionUrl.password),
      database: connectionUrl.pathname.replace(/^\//, "") || void 0,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
      waitForConnections: true,
      enableKeepAlive: true,
      connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 7e3),
      namedPlaceholders: true,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false, minVersion: "TLSv1.2" } : void 0
    });
  }
  return pool;
}
async function query(sql, params = {}) {
  const [rows] = await getPool().query({ sql, namedPlaceholders: true }, params);
  return rows;
}
async function withTransaction(callback) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
async function databaseHealth() {
  if (!isDatabaseConfigured()) {
    return { configured: false, connected: false };
  }
  try {
    await query("SELECT 1 AS ok");
    return { configured: true, connected: true };
  } catch {
    return { configured: true, connected: false };
  }
}

// server/auth.ts
var scrypt = promisify(scryptCallback);
var SESSION_COOKIE = "eleague_session";
var SESSION_TTL_MS = 1e3 * 60 * 60 * 24 * 30;
function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))])
  );
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}
async function verifyPassword(password, encoded) {
  const [, salt, expectedHex] = encoded.split("$");
  if (!salt || !expectedHex) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
async function findUserByEmail(email) {
  const rows = await query(
    `SELECT u.email, u.display_name, u.role, u.status,
            tm.team_id, t.name AS team_name, t.short_code
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
       LEFT JOIN teams t ON t.id = tm.team_id
      WHERE u.email = :email
      LIMIT 1`,
    { email: email.trim().toLowerCase() }
  );
  return rows[0] ? toCurrentUser(rows[0]) : null;
}
function toCurrentUser(row) {
  return {
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    teamId: row.team_id,
    teamName: row.team_name,
    shortCode: row.short_code
  };
}
async function createSession(email, response) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await query(
    "INSERT INTO sessions (token_hash, user_email, expires_at, created_at) VALUES (:tokenHash, :email, :expiresAt, :createdAt)",
    { tokenHash: tokenHash(token), email, expiresAt, createdAt: now }
  );
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/"
  });
}
async function clearSession(request, response) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) {
    await query("DELETE FROM sessions WHERE token_hash = :tokenHash", { tokenHash: tokenHash(token) });
  }
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}
async function getCurrentUser(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const rows = await query(
    `SELECT u.email, u.display_name, u.role, u.status,
            tm.team_id, t.name AS team_name, t.short_code, s.expires_at
       FROM sessions s
       JOIN users u ON u.email = s.user_email
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
       LEFT JOIN teams t ON t.id = tm.team_id
      WHERE s.token_hash = :tokenHash
        AND s.expires_at > :now
        AND u.status = 'ACTIVE'
      LIMIT 1`,
    { tokenHash: tokenHash(token), now: Date.now() }
  );
  return rows[0] ? toCurrentUser(rows[0]) : null;
}

// server/league-service.ts
var DEFAULT_TIEBREAKERS = ["points", "goalDifference", "goalsFor", "wins", "headToHead"];
function generateRoundRobin(teamIds, startingAt = Date.now(), kickoffGapMs = 1e3 * 60 * 60 * 24) {
  const uniqueIds = teamIds.filter((id, index) => teamIds.indexOf(id) === index);
  if (uniqueIds.length < 2) throw new Error("At least two teams are required to create a schedule.");
  const participants = [...uniqueIds];
  if (participants.length % 2 === 1) participants.push(null);
  const singleLegRounds = participants.length - 1;
  const fixtures = [];
  const rotating = [...participants];
  const half = rotating.length / 2;
  for (let round = 0; round < singleLegRounds; round += 1) {
    const matchday = round + 1;
    const roundFixtures = [];
    for (let index = 0; index < half; index += 1) {
      const left = rotating[index];
      const right = rotating[rotating.length - 1 - index];
      if (left === null || right === null) continue;
      const flipHome = (round + index) % 2 === 1;
      roundFixtures.push({
        matchday,
        homeTeamId: flipHome ? right : left,
        awayTeamId: flipHome ? left : right,
        kickoffAt: startingAt + round * kickoffGapMs + index * 1e3 * 60 * 90
      });
    }
    fixtures.push(...roundFixtures);
    rotating.splice(1, 0, rotating.pop());
  }
  const secondLeg = fixtures.map((fixture) => ({
    ...fixture,
    matchday: fixture.matchday + singleLegRounds,
    homeTeamId: fixture.awayTeamId,
    awayTeamId: fixture.homeTeamId,
    kickoffAt: fixture.kickoffAt + singleLegRounds * kickoffGapMs
  }));
  fixtures.push(...secondLeg);
  assertScheduleIsCompatible(uniqueIds, fixtures);
  return fixtures;
}
function assertScheduleIsCompatible(teamIds, fixtures) {
  const expectedMatches = teamIds.length * (teamIds.length - 1);
  if (fixtures.length !== expectedMatches) {
    throw new Error(`Schedule generated ${fixtures.length} matches; expected ${expectedMatches}.`);
  }
  const directedPairKeys = /* @__PURE__ */ new Set();
  const teamDays = /* @__PURE__ */ new Set();
  for (const fixture of fixtures) {
    if (fixture.homeTeamId === fixture.awayTeamId) throw new Error("A team cannot play itself.");
    const directedKey = `${fixture.homeTeamId}:${fixture.awayTeamId}`;
    if (directedPairKeys.has(directedKey)) throw new Error(`Duplicate home/away fixture detected for ${directedKey}.`);
    directedPairKeys.add(directedKey);
    for (const teamId of [fixture.homeTeamId, fixture.awayTeamId]) {
      const dayKey = `${fixture.matchday}:${teamId}`;
      if (teamDays.has(dayKey)) throw new Error(`Team ${teamId} has more than one match on matchday ${fixture.matchday}.`);
      teamDays.add(dayKey);
    }
  }
  const expectedDirectedPairCount = teamIds.length * (teamIds.length - 1);
  if (directedPairKeys.size !== expectedDirectedPairCount) throw new Error("Every ordered home/away pairing must appear exactly once.");
}
function headToHeadPoints(teamId, opponentId, matches) {
  let points = 0;
  for (const match of matches) {
    const isDirect = match.homeTeamId === teamId && match.awayTeamId === opponentId || match.homeTeamId === opponentId && match.awayTeamId === teamId;
    if (!isDirect) continue;
    const teamScore = match.homeTeamId === teamId ? match.homeScore : match.awayScore;
    const opponentScore = match.homeTeamId === teamId ? match.awayScore : match.homeScore;
    points += teamScore > opponentScore ? 3 : teamScore === opponentScore ? 1 : 0;
  }
  return points;
}
function calculateStandings(teams, matches, tieBreakers = DEFAULT_TIEBREAKERS) {
  const map = /* @__PURE__ */ new Map();
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
  const rows = [];
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

// server/news-service.ts
import { createHash as createHash2 } from "node:crypto";
var LEAGUE_TIME_ZONE = "Asia/Kolkata";
var HUGGING_FACE_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
var DEFAULT_HUGGING_FACE_MODEL = "Qwen/Qwen3-4B-Instruct-2507";
function leagueDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: LEAGUE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function json(value) {
  return JSON.stringify(value ?? []);
}
function clip(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}
function numeric(value) {
  return Number(value || 0);
}
function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function extractJson(value) {
  const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? parseObject(trimmed.slice(start, end + 1)) : null;
}
function modelConfig() {
  const token = process.env.HF_TOKEN?.trim();
  return token ? { token, model: process.env.HF_MODEL?.trim() || DEFAULT_HUGGING_FACE_MODEL } : null;
}
var tablesReady = null;
async function ensureNewsTables() {
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    ]).then(() => void 0).catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}
async function buildEvidence(seasonId) {
  const [seasonRows, teamRows, matchRows, goalRows, archiveRows] = await Promise.all([
    query("SELECT id, name, status FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId }),
    query("SELECT id, name, short_code FROM teams WHERE status = 'APPROVED' ORDER BY id", {}),
    query("SELECT id, matchday, kickoff_at, home_team_id, away_team_id, home_score, away_score, status FROM matches WHERE season_id = :seasonId ORDER BY kickoff_at, id", { seasonId }),
    query("SELECT g.match_id, g.team_id, g.player_email, g.scorer_name, g.minute FROM goals g JOIN matches m ON m.id = g.match_id WHERE m.season_id = :seasonId AND m.status = 'CONFIRMED' ORDER BY m.kickoff_at DESC, g.minute", { seasonId }),
    query("SELECT id, season_id, season_name, completed_at, standings_json FROM season_archives WHERE season_id <> :seasonId ORDER BY completed_at DESC LIMIT 5", { seasonId })
  ]);
  const season = seasonRows[0];
  if (!season) throw new Error("Season not found.");
  const teamById = new Map(teamRows.map((team) => [Number(team.id), team]));
  const confirmedRows = matchRows.filter((match) => match.status === "CONFIRMED" && match.home_score !== null && match.away_score !== null);
  const standings = calculateStandings(teamRows.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), confirmedRows.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: numeric(match.home_score), awayScore: numeric(match.away_score) })));
  const teamPerformanceMap = /* @__PURE__ */ new Map();
  for (const team of teamRows) teamPerformanceMap.set(Number(team.id), { teamId: Number(team.id), teamName: team.name, shortCode: team.short_code, goalsFor: 0, goalsAgainst: 0, matchesPlayed: 0, cleanSheets: 0 });
  for (const match of confirmedRows) {
    const home = teamPerformanceMap.get(Number(match.home_team_id));
    const away = teamPerformanceMap.get(Number(match.away_team_id));
    if (!home || !away) continue;
    home.goalsFor = numeric(home.goalsFor) + numeric(match.home_score);
    home.goalsAgainst = numeric(home.goalsAgainst) + numeric(match.away_score);
    home.matchesPlayed = numeric(home.matchesPlayed) + 1;
    if (numeric(match.away_score) === 0) home.cleanSheets = numeric(home.cleanSheets) + 1;
    away.goalsFor = numeric(away.goalsFor) + numeric(match.away_score);
    away.goalsAgainst = numeric(away.goalsAgainst) + numeric(match.home_score);
    away.matchesPlayed = numeric(away.matchesPlayed) + 1;
    if (numeric(match.home_score) === 0) away.cleanSheets = numeric(away.cleanSheets) + 1;
  }
  const teamPerformance = Array.from(teamPerformanceMap.values()).sort((a, b) => numeric(b.goalsFor) - numeric(a.goalsFor));
  const scorerMap = /* @__PURE__ */ new Map();
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
  const facts = {
    confirmed_matches: `${confirmedRows.length} of ${matchRows.length} scheduled matches are confirmed.`,
    leader: leader ? `${leader.name} leads the table with ${leader.points} points from ${leader.played} matches.` : "There is no confirmed standings leader yet.",
    top_scorer: topScorer ? `${topScorer.name} leads the scoring chart with ${topScorer.goals} goals for ${topScorer.teamName}.` : "No confirmed goals have been recorded yet.",
    clean_sheet_leader: cleanSheetLeader ? `${cleanSheetLeader.teamName} recorded ${cleanSheetLeader.cleanSheets} clean sheet${numeric(cleanSheetLeader.cleanSheets) === 1 ? "" : "s"} from ${cleanSheetLeader.matchesPlayed} confirmed matches.` : "No clean sheets are recorded yet.",
    latest_result: latestResults[0] ? (() => {
      const [homeScore, awayScore] = String(latestResults[0].score).split("-").map(Number);
      const result = homeScore === awayScore ? `${latestResults[0].home} drew ${latestResults[0].away}` : homeScore > awayScore ? `${latestResults[0].home} beat ${latestResults[0].away}` : `${latestResults[0].away} beat ${latestResults[0].home}`;
      return `${result} in the latest recorded scoreline ${latestResults[0].score}.`;
    })() : "There is no confirmed result to recap yet.",
    next_match: upcomingMatches[0] ? `The next listed fixture is ${upcomingMatches[0].home} versus ${upcomingMatches[0].away} on ${upcomingMatches[0].date}.` : "There is no upcoming fixture currently listed."
  };
  return { seasonId, seasonName: season.name, status: season.status, asOfDate: leagueDateKey(), confirmedMatches: confirmedRows.length, totalMatches: matchRows.length, standings: standings.slice(0, 8), topScorers, teamPerformance, latestResults, upcomingMatches, facts, previousSeasons: archiveRows.map((archive) => ({ seasonName: archive.season_name, completedAt: archive.completed_at, standings: parseObject(archive.standings_json) || archive.standings_json })) };
}
function fallbackStories(evidence) {
  const stories = [];
  if (evidence.latestResults.length) stories.push({ storyType: "MATCHDAY_RECAP", headline: `The latest matchday leaves ${evidence.seasonName} with more to watch`, description: `${evidence.facts.latest_result} The official table now has ${evidence.facts.confirmed_matches.toLowerCase()}`, factIds: ["latest_result", "confirmed_matches"] });
  if (evidence.upcomingMatches.length) stories.push({ storyType: "UPCOMING_PREVIEW", headline: `Next up: ${evidence.upcomingMatches[0].home} meet ${evidence.upcomingMatches[0].away}`, description: `${evidence.facts.next_match} The fixture is part of the upcoming schedule and has not been treated as a result.`, factIds: ["next_match"] });
  if (evidence.topScorers.length || evidence.teamPerformance.length) stories.push({ storyType: "STAT_FACT", headline: evidence.topScorers.length ? `${evidence.topScorers[0].name} sets the early scoring pace` : "The league is building its scoring picture", description: `${evidence.facts.top_scorer} ${evidence.facts.leader}`, factIds: ["top_scorer", "leader"] });
  return completeStoryCoverage(stories, evidence);
}
function completeStoryCoverage(stories, evidence) {
  const unique = [];
  const seen = /* @__PURE__ */ new Set();
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
async function aiStories(evidence) {
  const config = modelConfig();
  if (!config) return fallbackStories(evidence);
  const prompt = [
    "You are a careful football league news editor.",
    "Use only the supplied evidence. Do not invent players, goals, scores, rivalries, streaks, transfers, emotions, or statistics.",
    "Choose only factIds that exist in the evidence facts object. If the data is not interesting, say that plainly.",
    'Return JSON only in this exact shape: {"stories":[{"storyType":"MATCHDAY_RECAP|UPCOMING_PREVIEW|STAT_FACT","headline":"...","description":"...","factIds":["..."]}]}.',
    "Write concise sports-report copy. Upcoming fixtures must never be described as completed. Do not include a table; the server will attach a verified data table.",
    JSON.stringify({ evidence, facts: evidence.facts })
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
      const storyType = String(item.storyType || "");
      const factIds = Array.isArray(item.factIds) ? item.factIds.map(String).filter((id) => allowed.has(id)) : [];
      if (!["MATCHDAY_RECAP", "UPCOMING_PREVIEW", "STAT_FACT"].includes(storyType) || !factIds.length) return null;
      return { storyType, headline: clip(item.headline, 180), description: clip(item.description, 900), factIds };
    }).filter((story) => Boolean(story && story.headline && story.description)) : [];
    return stories.length ? completeStoryCoverage(stories, evidence) : fallbackStories(evidence);
  } catch {
    return fallbackStories(evidence);
  } finally {
    clearTimeout(timeout);
  }
}
function storyData(storyType, evidence) {
  if (storyType === "MATCHDAY_RECAP") return { columns: ["Matchday", "Fixture", "Score"], rows: evidence.latestResults.map((match) => [match.matchday, `${match.home} vs ${match.away}`, match.score]) };
  if (storyType === "UPCOMING_PREVIEW") return { columns: ["Matchday", "Date", "Fixture"], rows: evidence.upcomingMatches.map((match) => [match.matchday, match.date, `${match.home} vs ${match.away}`]) };
  if (storyType === "SEASON_SUMMARY") return { columns: ["Rank", "Team", "Points", "Goals For"], rows: evidence.standings.map((row) => [row.rank, row.name, row.points, row.goalsFor]) };
  return { columns: ["Team", "Goals For", "Clean Sheets"], rows: evidence.teamPerformance.slice(0, 5).map((row) => [row.teamName, row.goalsFor, row.cleanSheets]) };
}
async function refreshLeagueNews(seasonId) {
  await ensureNewsTables();
  const evidence = await buildEvidence(seasonId);
  const generated = await aiStories(evidence);
  if (evidence.status === "COMPLETED") generated.push({ storyType: "SEASON_SUMMARY", headline: `Season archive: ${evidence.seasonName}`, description: `${evidence.facts.leader} ${evidence.facts.top_scorer} ${evidence.facts.clean_sheet_leader}`, factIds: ["leader", "top_scorer", "clean_sheet_leader"] });
  const now = Date.now();
  const model = modelConfig()?.model || "evidence-only-fallback";
  for (const story of generated) {
    const evidenceJson = json({ facts: Object.fromEntries(story.factIds.map((id) => [id, evidence.facts[id]])), asOfDate: evidence.asOfDate, confirmedMatches: evidence.confirmedMatches, totalMatches: evidence.totalMatches });
    const dataJson = json(storyData(story.storyType, evidence));
    const signature = createHash2("sha256").update(`${evidenceJson}:${dataJson}`).digest("hex");
    await query(`INSERT INTO league_news (season_id, story_date, story_type, story_key, headline, description, data_json, evidence_json, evidence_signature, model, generated_at, updated_at)
      VALUES (:seasonId, :storyDate, :storyType, :storyKey, :headline, :description, :dataJson, :evidenceJson, :signature, :model, :now, :now)
      ON DUPLICATE KEY UPDATE headline = VALUES(headline), description = VALUES(description), data_json = VALUES(data_json), evidence_json = VALUES(evidence_json), evidence_signature = VALUES(evidence_signature), model = VALUES(model), generated_at = VALUES(generated_at), updated_at = VALUES(updated_at)`, { seasonId, storyDate: evidence.asOfDate, storyType: story.storyType, storyKey: `${seasonId}:${evidence.asOfDate}:${story.storyType}`, headline: story.headline, description: story.description, dataJson, evidenceJson, signature, model, now });
  }
  return { generated: generated.length, storyDate: evidence.asOfDate, stories: await getNewsRows(seasonId) };
}
async function getNewsRows(seasonId) {
  await ensureNewsTables();
  const seasonFilter = seasonId === void 0 ? "" : "WHERE season_id = :seasonId AND story_date = (SELECT MAX(latest.story_date) FROM league_news latest WHERE latest.season_id = :latestSeasonId)";
  return query(`SELECT id, season_id, story_date, story_type, headline, description, data_json, evidence_json, model, generated_at FROM league_news ${seasonFilter} ORDER BY story_date DESC, generated_at DESC, id DESC LIMIT 50`, seasonId === void 0 ? {} : { seasonId, latestSeasonId: seasonId });
}
async function getArchiveRows() {
  await ensureNewsTables();
  return query("SELECT id, season_id, season_name, completed_at, standings_json, player_stats_json, team_performance_json, highlights_json FROM season_archives ORDER BY completed_at DESC LIMIT 20", {});
}
async function archiveSeasonSnapshot(seasonId) {
  await ensureNewsTables();
  const evidence = await buildEvidence(seasonId);
  const existing = await query("SELECT id FROM season_archives WHERE season_id = :seasonId LIMIT 1", { seasonId });
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

// server/app.ts
var app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
var GOOGLE_STATE_COOKIE = "eleague_google_state";
var GOOGLE_STATE_TTL_MS = 10 * 60 * 1e3;
var LEAGUE_TIME_ZONE2 = "Asia/Kolkata";
function leagueDateKey2(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LEAGUE_TIME_ZONE2,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function formatLeagueDateLabel(dateKey) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: LEAGUE_TIME_ZONE2,
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(/* @__PURE__ */ new Date(`${dateKey}T12:00:00Z`));
}
function attachMatchdayDates(matches) {
  const anchors = /* @__PURE__ */ new Map();
  for (const match of matches) {
    const matchday = Number(match.matchday);
    const hasOriginal = match.original_kickoff_at !== null && match.original_kickoff_at !== void 0;
    const candidate = Number(match.kickoff_at);
    if (hasOriginal || !Number.isInteger(matchday) || !Number.isFinite(candidate)) continue;
    const current = anchors.get(matchday);
    if (current === void 0 || candidate < current) anchors.set(matchday, candidate);
  }
  return matches.map((match) => {
    const matchday = Number(match.matchday);
    const hasOriginal = match.original_kickoff_at !== null && match.original_kickoff_at !== void 0;
    const kickoff = Number(match.kickoff_at);
    const candidate = hasOriginal ? kickoff : anchors.get(matchday) ?? kickoff;
    return { ...match, match_date: Number.isFinite(candidate) ? leagueDateKey2(candidate) : "" };
  });
}
function cookieValue(request, name) {
  const cookies = Object.fromEntries((request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
  return cookies[name] || null;
}
function googleConfig(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `${request.protocol}://${request.get("host")}/api/auth/google/callback`;
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}
function oauthErrorRedirect(response, code) {
  response.redirect(`/?google=error&reason=${encodeURIComponent(code)}`);
}
var ApiError = class extends Error {
  statusCode;
  code;
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
};
function duplicateTeamError(error) {
  const candidate = error;
  if (candidate?.code !== "ER_DUP_ENTRY") return null;
  const message = String(candidate.message || "");
  if (message.includes("teams_name_uq") || message.toLowerCase().includes("name")) {
    return new ApiError(409, "TEAM_NAME_IN_USE", "That team name already exists. Choose a different name.");
  }
  if (message.includes("teams_short_code_uq") || message.toLowerCase().includes("short_code")) {
    return new ApiError(409, "TEAM_CODE_IN_USE", "That team code already exists. Choose a different code.");
  }
  return new ApiError(409, "TEAM_IN_USE", "That team name or team code already exists. Choose different values.");
}
var HUGGING_FACE_CHAT_URL2 = "https://router.huggingface.co/v1/chat/completions";
var DEFAULT_HUGGING_FACE_MODEL2 = "Qwen/Qwen3-4B-Instruct-2507";
var MANUAL_FOOTBALLER_NAME_FALLBACKS = {
  "gulit": "Ruud Gullit",
  "gullit": "Ruud Gullit",
  "del piero": "Alessandro Del Piero",
  "van basten": "Marco van Basten",
  "luis suarez": "Luis Su\xE1rez",
  "zlatan": "Zlatan Ibrahimovi\u0107",
  "zlatan ibrahimovic": "Zlatan Ibrahimovi\u0107",
  "zlatan ibrahimovi\u0107": "Zlatan Ibrahimovi\u0107",
  "messi": "Lionel Messi",
  "neymar": "Neymar da Silva Santos J\xFAnior",
  "pele": "Edson Arantes do Nascimento",
  "pel\xE9": "Edson Arantes do Nascimento",
  "maradona": "Diego Armando Maradona",
  "neuer": "Manuel Neuer",
  "gerrard": "Steven Gerrard",
  "cr7": "Cristiano Ronaldo",
  "cristiano": "Cristiano Ronaldo"
};
function huggingFaceConfig() {
  const token = process.env.HF_TOKEN?.trim();
  if (!token) return null;
  return { token, model: process.env.HF_MODEL?.trim() || DEFAULT_HUGGING_FACE_MODEL2 };
}
var scorerReviewTableReady = null;
async function ensureScorerReviewTable() {
  if (!isDatabaseConfigured()) return;
  if (!scorerReviewTableReady) {
    scorerReviewTableReady = query(`
      CREATE TABLE IF NOT EXISTS scorer_name_reviews (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        match_id BIGINT UNSIGNED NOT NULL,
        goal_id BIGINT UNSIGNED NULL,
        team_id BIGINT UNSIGNED NOT NULL,
        submitted_name VARCHAR(120) NOT NULL,
        suggested_name VARCHAR(120) NULL,
        approved_name VARCHAR(120) NULL,
        confidence DECIMAL(5,4) NULL,
        reason VARCHAR(255) NULL,
        matched_email VARCHAR(320) NULL,
        status ENUM('PENDING', 'APPROVED', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'PENDING',
        model VARCHAR(160) NULL,
        error_message VARCHAR(255) NULL,
        reviewed_by_email VARCHAR(320) NULL,
        reviewed_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX scorer_reviews_status_idx (status, created_at),
        INDEX scorer_reviews_match_idx (match_id),
        INDEX scorer_reviews_team_idx (team_id),
        CONSTRAINT scorer_reviews_match_fk FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        CONSTRAINT scorer_reviews_team_fk FOREIGN KEY (team_id) REFERENCES teams(id),
        CONSTRAINT scorer_reviews_matched_user_fk FOREIGN KEY (matched_email) REFERENCES users(email) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `).then(() => void 0);
  }
  await scorerReviewTableReady;
}
function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
function clipText(value, length) {
  return value.trim().slice(0, length);
}
function modelContent(payload) {
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((part) => typeof part === "string" ? part : String(part.text || "")).join("");
  return "";
}
function parseScorerReview(raw, submittedName, knownPlayers) {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error("The name-review model did not return JSON.");
  const parsed = JSON.parse(jsonText);
  const conservativeAlias = MANUAL_FOOTBALLER_NAME_FALLBACKS[normalizeName(submittedName)];
  const modelSuggestion = String(parsed.suggestedFullName || parsed.suggestedName || submittedName);
  const suggestedFullName = clipText(conservativeAlias || modelSuggestion, 120);
  if (!suggestedFullName) throw new Error("The name-review model returned an empty name.");
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1) confidence /= 100;
  confidence = Math.max(0, Math.min(1, confidence));
  const requestedEmail = typeof parsed.matchedEmail === "string" ? parsed.matchedEmail.trim().toLowerCase() : "";
  const exactPlayer = knownPlayers.find((player) => normalizeName(player.displayName) === normalizeName(suggestedFullName));
  const matchedPlayer = knownPlayers.find((player) => player.email.toLowerCase() === requestedEmail) || exactPlayer;
  return {
    suggestedFullName,
    confidence,
    reason: clipText(String(parsed.reason || "Name normalized for admin review."), 255),
    matchedEmail: matchedPlayer?.email || null,
    needsManualReview: parsed.needsManualReview !== false || !matchedPlayer
  };
}
async function processScorerNameReview(reviewId) {
  const reviewRows = await query(
    `SELECT r.id, r.match_id, r.goal_id, r.team_id, r.submitted_name, t.name AS team_name
       FROM scorer_name_reviews r JOIN teams t ON t.id = r.team_id
      WHERE r.id = :reviewId LIMIT 1`,
    { reviewId }
  );
  const review = reviewRows[0];
  if (!review) return { reviewId, status: "MISSING" };
  const knownPlayers = await query(
    `SELECT u.email, u.display_name
       FROM users u JOIN team_memberships tm ON tm.user_email = u.email
      WHERE tm.team_id = :teamId AND u.status = 'ACTIVE'
      ORDER BY u.display_name`,
    { teamId: review.team_id }
  );
  const previousNames = await query(
    `SELECT DISTINCT g.scorer_name
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE g.team_id = :teamId AND g.id <> COALESCE(:goalId, 0)
      ORDER BY g.scorer_name LIMIT 100`,
    { teamId: review.team_id, goalId: review.goal_id || 0 }
  );
  const config = huggingFaceConfig();
  if (!config) {
    await query(
      `UPDATE scorer_name_reviews SET status = 'FAILED', error_message = :message, updated_at = :now WHERE id = :reviewId`,
      { reviewId, message: "Hugging Face is not configured yet. Add HF_TOKEN in Vercel to analyze names.", now: Date.now() }
    );
    return { reviewId, status: "FAILED" };
  }
  const playerContext = knownPlayers.map((player) => `${player.display_name} <${player.email}>`).join("\\n") || "No registered players yet.";
  const previousContext = previousNames.map((item) => item.scorer_name).join(", ") || "No previous scorer names yet.";
  const prompt = [
    "You normalize eFootball scorer names for an administrator. Do not invent a real person or silently approve anything.",
    "Correct spelling, casing, spacing, and common abbreviations only when the supplied context supports it. Prefer an exact registered player from the team roster when one is an obvious match.",
    "Return only one JSON object with exactly these keys: suggestedFullName, confidence, reason, matchedEmail, needsManualReview.",
    "confidence must be a number from 0 to 1. matchedEmail must be null unless the suggestion exactly matches one registered player.",
    "Set needsManualReview to true whenever the correction is uncertain or the name is not an exact registered player.",
    "When the submitted name is a recognizable footballer shorthand or misspelling, return the player\u2019s conventional full name. For example, \u2018Gulit\u2019 should be suggested as \u2018Ruud Gullit\u2019, \u2018Ronaldo\u2019 may be \u2018Cristiano Ronaldo\u2019 only when the team context supports it, and \u2018Messi\u2019 may be \u2018Lionel Messi\u2019 only when the context supports it.",
    "Do not invent a footballer. If several real players could match, keep the submitted name as the suggestion and set needsManualReview to true.",
    `Team: ${review.team_name}`,
    `Submitted scorer name: ${review.submitted_name}`,
    `Registered team players:\\n${playerContext}`,
    `Previous scorer names for this team: ${previousContext}`
  ].join("\\n\\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7e3);
  try {
    const modelResponse = await fetch(HUGGING_FACE_CHAT_URL2, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: "You are a careful name-normalization assistant. Return valid JSON only." }, { role: "user", content: prompt }], temperature: 0, max_tokens: 220 }),
      signal: controller.signal
    });
    const payload = await modelResponse.json().catch(() => null);
    if (modelResponse.status === 402) {
      const fallbackName = clipText(MANUAL_FOOTBALLER_NAME_FALLBACKS[normalizeName(review.submitted_name)] || review.submitted_name, 120);
      await query(
        `UPDATE scorer_name_reviews
            SET suggested_name = :suggestedName, confidence = :confidence,
                reason = :reason, matched_email = NULL, status = 'PENDING',
                model = :model, error_message = NULL, updated_at = :now
          WHERE id = :reviewId`,
        {
          reviewId,
          suggestedName: fallbackName,
          confidence: 0.5,
          reason: "Hugging Face credits are temporarily unavailable (HTTP 402). The submitted name is retained as a manual-review suggestion; approve it only if it is correct.",
          model: `${config.model} \xB7 manual fallback`,
          now: Date.now()
        }
      );
      return { reviewId, status: "PENDING" };
    }
    if (!modelResponse.ok) throw new Error(`Hugging Face returned HTTP ${modelResponse.status}.`);
    const result = parseScorerReview(modelContent(payload), review.submitted_name, knownPlayers.map((player) => ({ email: player.email, displayName: player.display_name })));
    await query(
      `UPDATE scorer_name_reviews
          SET suggested_name = :suggestedName, confidence = :confidence, reason = :reason,
              matched_email = :matchedEmail, status = 'PENDING', model = :model,
              error_message = NULL, updated_at = :now
        WHERE id = :reviewId`,
      { reviewId, suggestedName: result.suggestedFullName, confidence: result.confidence, reason: result.reason, matchedEmail: result.matchedEmail, model: config.model, now: Date.now() }
    );
    return { reviewId, status: "PENDING" };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Hugging Face analysis timed out; retry this name." : error instanceof Error ? error.message : "Hugging Face name review failed.";
    await query(
      `UPDATE scorer_name_reviews SET status = 'FAILED', model = :model, error_message = :message, updated_at = :now WHERE id = :reviewId`,
      { reviewId, model: config.model, message: clipText(message, 255), now: Date.now() }
    );
    return { reviewId, status: "FAILED" };
  } finally {
    clearTimeout(timeout);
  }
}
async function processScorerNameReviews(reviewIds) {
  const ids = reviewIds.slice(0, 3);
  return Promise.all(ids.map((reviewId) => processScorerNameReview(reviewId)));
}
async function backfillScorerReviewRecords() {
  await ensureScorerReviewTable();
  const now = Date.now();
  await query(
    `INSERT INTO scorer_name_reviews (match_id, goal_id, team_id, submitted_name, status, created_at, updated_at)
     SELECT g.match_id, g.id, g.team_id, g.scorer_name, 'PENDING', :now, :now
       FROM goals g
       JOIN matches m ON m.id = g.match_id
       LEFT JOIN scorer_name_reviews r ON r.goal_id = g.id
      WHERE r.id IS NULL`,
    { now }
  );
  const fallbackEntries = Object.entries(MANUAL_FOOTBALLER_NAME_FALLBACKS);
  const fallbackCase = fallbackEntries.map(([submittedName, suggestedName]) => `WHEN '${submittedName.replace(/'/g, "''")}' THEN '${suggestedName.replace(/'/g, "''")}'`).join(" ");
  const fallbackNames = fallbackEntries.map(([submittedName]) => `'${submittedName.replace(/'/g, "''")}'`).join(", ");
  await query(
    `UPDATE scorer_name_reviews
        SET suggested_name = CASE LOWER(TRIM(submitted_name)) ${fallbackCase} END,
            confidence = 0.85,
            reason = CONCAT('Conservative local alias normalization from \u201C', submitted_name, '\u201D. Admin approval is still required.'),
            model = 'local-conservative-fallback', error_message = NULL, updated_at = :now
      WHERE status = 'PENDING'
        AND LOWER(TRIM(submitted_name)) IN (${fallbackNames})
        AND COALESCE(suggested_name, '') <> CASE LOWER(TRIM(submitted_name)) ${fallbackCase} END`,
    { now }
  );
}
async function scorerReviewRows(status) {
  const statusFilter = status === "APPROVED" || status === "REJECTED" || status === "FAILED" || status === "PENDING" ? status : null;
  return query(
    `SELECT r.id, r.match_id, r.goal_id, r.team_id, r.submitted_name, r.suggested_name,
            r.approved_name, r.confidence, r.reason, r.matched_email, r.status,
            r.model, r.error_message, r.created_at, r.updated_at,
            t.name AS team_name, m.matchday, h.name AS home_team_name, a.name AS away_team_name
       FROM scorer_name_reviews r
       JOIN teams t ON t.id = r.team_id
       JOIN matches m ON m.id = r.match_id
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
      WHERE (:status IS NULL OR r.status = :status)
      ORDER BY CASE r.status WHEN 'FAILED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, r.created_at DESC
      LIMIT 100`,
    { status: statusFilter }
  );
}
var asyncRoute = (handler) => (request, response, next) => {
  handler(request, response).catch(next);
};
function requireUser(request, response) {
  const user = request.user;
  if (!user) {
    response.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in to continue." });
    return null;
  }
  return user;
}
function requireAdmin(request, response) {
  const user = requireUser(request, response);
  if (!user) return null;
  if (user.role !== "admin") {
    response.status(403).json({ error: "ADMIN_REQUIRED", message: "This action is limited to league administrators." });
    return null;
  }
  return user;
}
app.use(async (request, _response, next) => {
  try {
    request.user = await getCurrentUser(request);
    next();
  } catch (error) {
    next(error);
  }
});
app.get("/api/health", asyncRoute(async (_request, response) => {
  response.json({ service: "efootball-leagues-api", database: await databaseHealth(), now: Date.now() });
}));
var loginRoute = asyncRoute(async (request, response) => {
  if (!isDatabaseConfigured()) {
    response.status(503).json({ error: "DATABASE_NOT_CONFIGURED", message: "The API needs DATABASE_URL before account sign-in can be enabled." });
    return;
  }
  const email = String(request.body?.email || "").trim().toLowerCase();
  const password = String(request.body?.password || "");
  if (!email || !email.includes("@") || password.length < 8) {
    response.status(400).json({ error: "INVALID_CREDENTIALS", message: "Enter a valid email and a password with at least 8 characters." });
    return;
  }
  const rows = await query(
    "SELECT email, password_hash, status FROM users WHERE email = :email LIMIT 1",
    { email }
  );
  const record = rows[0];
  if (!record || record.status !== "ACTIVE" || !await verifyPassword(password, record.password_hash)) {
    response.status(401).json({ error: "INVALID_CREDENTIALS", message: "The email or password is incorrect." });
    return;
  }
  await createSession(email, response);
  response.json({ user: await findUserByEmail(email) });
});
app.post("/api/auth/login", loginRoute);
app.post("/api/login", loginRoute);
app.get("/api/auth/google", asyncRoute(async (request, response) => {
  const config = googleConfig(request);
  if (!config) {
    oauthErrorRedirect(response, "Google sign-in is not configured yet.");
    return;
  }
  const state = randomBytes2(32).toString("base64url");
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
  response.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: GOOGLE_STATE_TTL_MS,
    path: "/"
  });
  response.redirect(client.generateAuthUrl({ access_type: "online", scope: ["openid", "email", "profile"], state, prompt: "select_account" }));
}));
app.get("/api/auth/google/callback", asyncRoute(async (request, response) => {
  const config = googleConfig(request);
  const state = typeof request.query.state === "string" ? request.query.state : "";
  const storedState = cookieValue(request, GOOGLE_STATE_COOKIE);
  response.clearCookie(GOOGLE_STATE_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  if (!config) {
    oauthErrorRedirect(response, "Google sign-in is not configured yet.");
    return;
  }
  if (!state || !storedState || state.length !== storedState.length || !timingSafeEqual2(Buffer.from(state), Buffer.from(storedState))) {
    oauthErrorRedirect(response, "Google sign-in could not be verified. Please try again.");
    return;
  }
  if (typeof request.query.error === "string") {
    oauthErrorRedirect(response, "Google sign-in was cancelled.");
    return;
  }
  const code = typeof request.query.code === "string" ? request.query.code : "";
  if (!code) {
    oauthErrorRedirect(response, "Google did not return an authorization code.");
    return;
  }
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    oauthErrorRedirect(response, "Google did not return a valid identity token.");
    return;
  }
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
  const payload = ticket.getPayload();
  const email = payload?.email?.trim().toLowerCase();
  if (!email || payload?.email_verified !== true) {
    oauthErrorRedirect(response, "Google returned an unverified email address.");
    return;
  }
  const existing = await findUserByEmail(email);
  if (!existing || existing.status !== "ACTIVE") {
    oauthErrorRedirect(response, "No active eLeague account uses this Google email. Choose Create team first, then use this email for registration.");
    return;
  }
  await createSession(email, response);
  response.redirect("/?google=success");
}));
var meRoute = asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  response.json({ user });
});
app.get("/api/auth/me", meRoute);
app.get("/api/me", meRoute);
var logoutRoute = asyncRoute(async (request, response) => {
  await clearSession(request, response);
  response.json({ ok: true });
});
app.post("/api/auth/logout", logoutRoute);
app.post("/api/logout", logoutRoute);
var registerRoute = asyncRoute(async (request, response) => {
  if (!isDatabaseConfigured()) {
    response.status(503).json({ error: "DATABASE_NOT_CONFIGURED", message: "Registration is unavailable until the database is configured." });
    return;
  }
  const email = String(request.body?.email || "").trim().toLowerCase();
  const displayName = String(request.body?.displayName || "").trim();
  const password = String(request.body?.password || "");
  const teamName = String(request.body?.teamName || "").trim();
  const requestedShortCode = String(request.body?.shortCode || "").trim().toUpperCase();
  const shortCode = (requestedShortCode || teamName.replace(/[^A-Z0-9]/gi, "").slice(0, 3)).slice(0, 12).toUpperCase();
  if (!email.includes("@") || displayName.length < 2 || password.length < 8 || teamName.length < 2 || shortCode.length < 2) {
    response.status(400).json({ error: "INVALID_REGISTRATION", message: "Email, display name, password, team name, and a two-character team code are required." });
    return;
  }
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    response.status(409).json({ error: "EMAIL_IN_USE", message: "That email is already registered. Sign in or use a different email." });
    return;
  }
  const existingTeamName = await query("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) LIMIT 1", { name: teamName });
  const existingTeamCode = await query("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) LIMIT 1", { shortCode });
  if (existingTeamName[0] && existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_NAME_AND_CODE_IN_USE", message: "That team name and team code already exist. Choose different values." });
    return;
  }
  if (existingTeamName[0]) {
    response.status(409).json({ error: "TEAM_NAME_IN_USE", message: "That team name already exists. Choose a different name." });
    return;
  }
  if (existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_CODE_IN_USE", message: "That team code already exists. Choose a different code." });
    return;
  }
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  let teamId = 0;
  try {
    await withTransaction(async (connection) => {
      const [teamResult] = await connection.execute(
        `INSERT INTO teams (name, short_code, manager_name, accent, status, created_by_email, created_at)
       VALUES (?, ?, ?, '#8B1E3F', 'PENDING', ?, ?)`,
        [teamName, shortCode, displayName, email, now]
      );
      teamId = Number(teamResult.insertId);
      await connection.execute(
        `INSERT INTO users (email, display_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'player', 'ACTIVE', ?, ?)`,
        [email, displayName, passwordHash, now, now]
      );
      await connection.execute(
        "INSERT INTO team_memberships (user_email, team_id, membership_role, created_at) VALUES (?, ?, 'CAPTAIN', ?)",
        [email, teamId, now]
      );
      await connection.execute(
        `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'PLAYER_REGISTERED', 'team', ?, JSON_OBJECT('email', ?, 'team', ?, 'status', 'PENDING'), ?)`,
        [email, String(teamId), email, teamName, now]
      );
    });
  } catch (error) {
    const conflict = duplicateTeamError(error);
    if (conflict) throw conflict;
    throw error;
  }
  await createSession(email, response);
  response.status(201).json({ user: await findUserByEmail(email), team: { id: teamId, name: teamName, shortCode, status: "PENDING" } });
});
app.post("/api/auth/register", registerRoute);
app.post("/api/register", registerRoute);
app.post("/api/news/refresh", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await ensureNewsTables();
  const seasonRows = await query("SELECT id, status FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  if (!seasonRows[0]) {
    response.status(404).json({ error: "SEASON_NOT_FOUND", message: "Create a season before refreshing league news." });
    return;
  }
  const result = await refreshLeagueNews(Number(seasonRows[0].id));
  response.json(result);
}));
app.get("/api/cron/news", asyncRoute(async (request, response) => {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.authorization;
  if (cronSecret && authorization !== `Bearer ${cronSecret}`) {
    response.status(401).json({ error: "UNAUTHORIZED_CRON", message: "The newsroom cron request is not authorized." });
    return;
  }
  await ensureNewsTables();
  const seasonRows = await query("SELECT id, status FROM seasons WHERE status IN ('ACTIVE', 'COMPLETED') ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  if (!seasonRows[0]) {
    response.json({ skipped: true, reason: "NO_SEASON" });
    return;
  }
  const seasonId = Number(seasonRows[0].id);
  const result = await refreshLeagueNews(seasonId);
  response.json({ ...result, seasonId, storyDate: leagueDateKey2() });
}));
app.post("/api/admin/seasons/:seasonId/complete", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    response.status(400).json({ error: "INVALID_SEASON_ID", message: "That season identifier is invalid." });
    return;
  }
  const openRows = await query("SELECT COUNT(*) AS count FROM matches WHERE season_id = :seasonId AND status <> 'CONFIRMED'", { seasonId });
  if (Number(openRows[0]?.count || 0) > 0) {
    response.status(409).json({ error: "SEASON_NOT_FINISHED", message: "Every fixture must be officially confirmed before archiving the season." });
    return;
  }
  const result = await archiveSeasonSnapshot(seasonId);
  await query(`INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
    VALUES (:email, 'ARCHIVE_SEASON', 'season', :seasonId, JSON_OBJECT('archived', :archived), :now)`, { email: user.email, seasonId: String(seasonId), archived: result.archived ? 1 : 0, now: Date.now() });
  response.json(result);
}));
async function playerRegistryRows() {
  return query(
    `SELECT g.team_id, t.name AS team_name, t.short_code, t.accent,
            g.scorer_name, g.player_email,
            COUNT(*) AS total_goals,
            SUM(CASE WHEN m.status = 'CONFIRMED' THEN 1 ELSE 0 END) AS official_goals
       FROM goals g
       JOIN teams t ON t.id = g.team_id
       JOIN matches m ON m.id = g.match_id
      GROUP BY g.team_id, t.name, t.short_code, t.accent, g.scorer_name, g.player_email
      ORDER BY t.name, official_goals DESC, total_goals DESC, g.scorer_name`
  );
}
app.get("/api/admin/players", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  response.json({ players: await playerRegistryRows() });
}));
app.patch("/api/admin/players/rename", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const teamId = Number(request.body?.teamId);
  const oldName = clipText(String(request.body?.oldName || ""), 120);
  const newName = clipText(String(request.body?.newName || ""), 120);
  const playerEmail = typeof request.body?.playerEmail === "string" && request.body.playerEmail.trim() ? request.body.playerEmail.trim().toLowerCase() : null;
  if (!Number.isInteger(teamId) || teamId <= 0 || !oldName || !newName) {
    response.status(400).json({ error: "INVALID_PLAYER_RENAME", message: "Choose a team and enter both the existing and new player name." });
    return;
  }
  if (normalizeName(oldName) === normalizeName(newName)) {
    response.status(400).json({ error: "NAME_UNCHANGED", message: "Enter a different player name before saving." });
    return;
  }
  const teamRows = await query("SELECT id, name FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  if (!teamRows[0]) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const matchFilter = playerEmail ? "AND g.player_email = :playerEmail" : "AND (g.player_email IS NULL OR g.player_email = '')";
  const countRows = await query(
    `SELECT COUNT(*) AS total FROM goals g
      WHERE g.team_id = :teamId AND g.scorer_name = :oldName ${matchFilter}`,
    { teamId, oldName, playerEmail }
  );
  const goalCount = Number(countRows[0]?.total || 0);
  if (!goalCount) {
    response.status(404).json({ error: "PLAYER_NOT_FOUND", message: "No matching scorer records were found for that team." });
    return;
  }
  const now = Date.now();
  await ensureScorerReviewTable();
  await withTransaction(async (connection) => {
    await connection.query({
      sql: `UPDATE scorer_name_reviews r
               JOIN goals g ON g.id = r.goal_id
              SET r.submitted_name = :newName,
                  r.approved_name = CASE WHEN r.status = 'APPROVED' THEN :newName ELSE r.approved_name END,
                  r.updated_at = :now
            WHERE g.team_id = :teamId AND g.scorer_name = :oldName ${playerEmail ? "AND g.player_email = :playerEmail" : "AND (g.player_email IS NULL OR g.player_email = '')"}`,
      namedPlaceholders: true
    }, { teamId, oldName, newName, playerEmail, now });
    await connection.query({
      sql: `UPDATE goals SET scorer_name = :newName
              WHERE team_id = :teamId AND scorer_name = :oldName ${playerEmail ? "AND player_email = :playerEmail" : "AND (player_email IS NULL OR player_email = '')"}`,
      namedPlaceholders: true
    }, { teamId, oldName, newName, playerEmail });
    await connection.query({
      sql: `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
            VALUES (:email, 'RENAME_PLAYER', 'team', :teamId,
                    JSON_OBJECT('oldName', :oldName, 'newName', :newName, 'playerEmail', COALESCE(:playerEmail, ''), 'goalCount', :goalCount), :now)`,
      namedPlaceholders: true
    }, { email: user.email, teamId: String(teamId), oldName, newName, playerEmail, goalCount, now });
  });
  response.json({ ok: true, updated: goalCount, teamId, oldName, newName, players: await playerRegistryRows() });
}));
function emailEscape(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}
function emailColor(value, fallback) {
  const candidate = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
}
function emailDateLabel(timestamp) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: LEAGUE_TIME_ZONE2, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(timestamp));
}
function emailTimeLabel(timestamp) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: LEAGUE_TIME_ZONE2, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(timestamp));
}
function notificationSender() {
  const email = process.env.RESEND_FROM_EMAIL?.trim() || "peleefootball07@gmail.com";
  const name = process.env.RESEND_FROM_NAME?.trim() || "League'de Khalpar Matchday";
  return `${name} <${email}>`;
}
function notificationProvider() {
  return { apiKey: process.env.RESEND_API_KEY?.trim() || "", from: notificationSender() };
}
function notificationStandings(teams, confirmedMatches) {
  const base = calculateStandings(teams, confirmedMatches);
  const cleanSheets = /* @__PURE__ */ new Map();
  for (const match of confirmedMatches) {
    if (match.awayScore === 0) cleanSheets.set(match.homeTeamId, (cleanSheets.get(match.homeTeamId) || 0) + 1);
    if (match.homeScore === 0) cleanSheets.set(match.awayTeamId, (cleanSheets.get(match.awayTeamId) || 0) + 1);
  }
  return new Map(base.map((row) => [row.teamId, { ...row, cleanSheets: cleanSheets.get(row.teamId) || 0 }]));
}
async function buildNextFixtureNotifications() {
  const seasonRows = await query("SELECT id, name, status FROM seasons WHERE status IN ('ACTIVE', 'DRAFT') ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0];
  if (!season) throw new ApiError(404, "SEASON_NOT_FOUND", "Create or start a season before sending match notifications.");
  const teams = await query("SELECT id, name, short_code, accent FROM teams ORDER BY name");
  const rawFixtures = await query(
    `SELECT m.id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.status,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code, h.accent AS home_accent,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code, a.accent AS away_accent
       FROM matches m
       JOIN teams h ON h.id = m.home_team_id
       JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId AND m.status IN ('SCHEDULED', 'POSTPONED')
      ORDER BY m.kickoff_at, m.id`,
    { seasonId: season.id }
  );
  const fixtures = attachMatchdayDates(rawFixtures);
  const confirmed = await query(
    "SELECT home_team_id, away_team_id, home_score, away_score FROM matches WHERE season_id = :seasonId AND status = 'CONFIRMED'",
    { seasonId: season.id }
  );
  const teamModels = teams.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code }));
  const standingMap = notificationStandings(teamModels, confirmed.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: Number(match.home_score), awayScore: Number(match.away_score) })));
  const users = await query(
    `SELECT u.email, u.display_name, tm.team_id
       FROM users u
       JOIN team_memberships tm ON tm.user_email = u.email
      WHERE u.role = 'player' AND u.status = 'ACTIVE'
      ORDER BY u.display_name`
  );
  const recipientsByTeam = /* @__PURE__ */ new Map();
  for (const user of users) {
    if (!user.team_id) continue;
    const recipients = recipientsByTeam.get(Number(user.team_id)) || [];
    recipients.push({ email: user.email, displayName: user.display_name });
    recipientsByTeam.set(Number(user.team_id), recipients);
  }
  const nextFixtureByTeam = /* @__PURE__ */ new Map();
  for (const fixture of fixtures) {
    const homeTeamId = Number(fixture.home_team_id);
    const awayTeamId = Number(fixture.away_team_id);
    if (!nextFixtureByTeam.has(homeTeamId)) nextFixtureByTeam.set(homeTeamId, fixture);
    if (!nextFixtureByTeam.has(awayTeamId)) nextFixtureByTeam.set(awayTeamId, fixture);
  }
  const teamById = new Map(teams.map((team) => [Number(team.id), team]));
  const notifications = [];
  for (const [teamId, fixture] of nextFixtureByTeam) {
    const team = teamById.get(teamId);
    if (!team) continue;
    const isHome = Number(fixture.home_team_id) === teamId;
    const opponentId = isHome ? Number(fixture.away_team_id) : Number(fixture.home_team_id);
    const opponent = teamById.get(opponentId);
    const table = standingMap.get(teamId);
    const opponentTable = standingMap.get(opponentId);
    if (!opponent || !table || !opponentTable) continue;
    const kickoffAt = Number(fixture.kickoff_at);
    notifications.push({
      teamId,
      teamName: team.name,
      teamShortCode: team.short_code,
      teamAccent: emailColor(team.accent, "#8b1e3f"),
      recipients: recipientsByTeam.get(teamId) || [],
      fixture: {
        id: Number(fixture.id),
        matchday: Number(fixture.matchday),
        matchDate: String(fixture.match_date || leagueDateKey2(kickoffAt)),
        kickoffAt,
        status: String(fixture.status),
        isHome,
        opponent: { id: opponent.id, name: opponent.name, shortCode: opponent.short_code, accent: emailColor(opponent.accent, "#0d1a21") }
      },
      table,
      opponentTable
    });
  }
  notifications.sort((a, b) => a.fixture.matchday - b.fixture.matchday || a.teamName.localeCompare(b.teamName));
  return { seasonId: Number(season.id), seasonName: season.name, from: notificationSender(), providerConfigured: Boolean(notificationProvider().apiKey), notifications, sent: 0, skipped: notifications.filter((item) => !item.recipients.length).length, failed: [] };
}
function notificationHtml(notification) {
  const team = emailEscape(notification.teamName);
  const opponent = emailEscape(notification.fixture.opponent.name);
  const teamColor = emailColor(notification.teamAccent, "#8b1e3f");
  const opponentColor = emailColor(notification.fixture.opponent.accent, "#0d1a21");
  const matchLabel = `Matchday ${notification.fixture.matchday}`;
  const venueLabel = notification.fixture.isHome ? "Home fixture" : "Away fixture";
  const table = notification.table;
  const opponentTable = notification.opponentTable;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;background:#f3efe7;color:#14222a;font-family:Arial,Helvetica,sans-serif"><div style="padding:28px 12px;background:#f3efe7"><div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 18px 50px rgba(13,26,33,.16)"><div style="padding:28px 30px;background:linear-gradient(135deg,#0d1a21 0%,#172c38 62%,${teamColor} 100%);color:#ffffff"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#e0bf72;font-weight:700">LEAGUE'DE KHALPAR \xB7 MATCHDAY ALERT</div><h1 style="margin:12px 0 6px;font-size:30px;line-height:1.08">Your next fixture is locked in.</h1><p style="margin:0;color:#d7e1e5;font-size:15px;line-height:1.6">${team} should prepare for the next scheduled league match.</p></div><div style="padding:26px 30px"><div style="display:inline-block;padding:7px 11px;border-radius:999px;background:#f4e8c8;color:#6d4e16;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700">${emailEscape(matchLabel)} \xB7 ${emailEscape(venueLabel)}</div><div style="margin:22px 0 12px;text-align:center"><div style="display:inline-block;width:40%;vertical-align:middle;text-align:center"><div style="width:50px;height:50px;margin:0 auto 8px;border-radius:16px;background:${teamColor};color:#fff;line-height:50px;font-weight:800;font-size:16px">${emailEscape(notification.teamShortCode)}</div><div style="font-weight:800;font-size:16px">${team}</div><div style="font-size:12px;color:#7a858a;margin-top:4px">${notification.fixture.isHome ? "HOME" : "AWAY"}</div></div><div style="display:inline-block;width:16%;vertical-align:middle;color:#b08b3c;font-size:20px;font-weight:800">VS</div><div style="display:inline-block;width:40%;vertical-align:middle;text-align:center"><div style="width:50px;height:50px;margin:0 auto 8px;border-radius:16px;background:${opponentColor};color:#fff;line-height:50px;font-weight:800;font-size:16px">${emailEscape(notification.fixture.opponent.shortCode)}</div><div style="font-weight:800;font-size:16px">${opponent}</div><div style="font-size:12px;color:#7a858a;margin-top:4px">${notification.fixture.isHome ? "AWAY" : "HOME"}</div></div></div><div style="padding:16px;border:1px solid #eadfca;border-radius:16px;background:#fffaf0;text-align:center"><div style="font-size:12px;color:#7a858a;text-transform:uppercase;letter-spacing:1px;font-weight:700">Kickoff in league time</div><div style="margin-top:6px;color:#172c38;font-size:20px;font-weight:800">${emailEscape(emailDateLabel(notification.fixture.kickoffAt))}</div><div style="margin-top:3px;color:#8b1e3f;font-size:15px;font-weight:700">${emailEscape(emailTimeLabel(notification.fixture.kickoffAt))} \xB7 IST</div></div><h2 style="margin:26px 0 13px;font-size:18px;color:#172c38">Know the opponent</h2><div style="font-size:14px;color:#526169;line-height:1.7">${opponent} currently sits <strong style="color:#172c38">${opponentTable.rank}${opponentTable.rank === 1 ? "st" : opponentTable.rank === 2 ? "nd" : opponentTable.rank === 3 ? "rd" : "th"}</strong> with <strong style="color:#172c38">${opponentTable.points} points</strong>, a ${opponentTable.wins}-${opponentTable.draws}-${opponentTable.losses} record, and ${opponentTable.cleanSheets} clean sheet${opponentTable.cleanSheets === 1 ? "" : "s"}. Their goal difference is <strong style="color:#172c38">${opponentTable.goalDifference >= 0 ? "+" : ""}${opponentTable.goalDifference}</strong>.</div><h2 style="margin:26px 0 13px;font-size:18px;color:#172c38">Your table snapshot</h2><div style="font-size:0"><div style="display:inline-block;width:48%;margin-right:4%;padding:14px 0;border-top:3px solid ${teamColor};font-size:13px;color:#66747a"><strong style="display:block;color:#172c38;font-size:22px">#${table.rank}</strong>current position</div><div style="display:inline-block;width:48%;padding:14px 0;border-top:3px solid #c7a45a;font-size:13px;color:#66747a"><strong style="display:block;color:#172c38;font-size:22px">${table.points}</strong>points</div><div style="display:inline-block;width:48%;margin-right:4%;padding:14px 0;font-size:13px;color:#66747a"><strong style="display:block;color:#172c38;font-size:18px">${table.played}</strong>played</div><div style="display:inline-block;width:48%;padding:14px 0;font-size:13px;color:#66747a"><strong style="display:block;color:#172c38;font-size:18px">${table.goalsFor}-${table.goalsAgainst}</strong>goals for / against</div></div><div style="margin-top:20px;padding:18px;border-radius:16px;background:#0d1a21;color:#ffffff"><div style="color:#e0bf72;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700">Matchday checklist</div><p style="margin:10px 0 0;color:#d9e4e8;font-size:14px;line-height:1.65">Play the full 7-minute fixture in regular time, confirm both players are ready, and let the home team submit the final score and goal log after the match.</p></div><a href="https://efootball-leagues-one.vercel.app/" style="display:block;margin-top:22px;padding:15px 18px;border-radius:12px;background:${teamColor};color:#ffffff;text-align:center;text-decoration:none;font-weight:800;font-size:14px">Open eLeague fixtures</a></div><div style="padding:18px 30px;background:#f8f5ef;color:#7c878b;font-size:11px;line-height:1.6">This matchday reminder was sent by the league administrator. The schedule and table snapshot reflect the live eLeague database at the time of sending.</div></div></div></body></html>`;
}
function notificationText(notification) {
  const opponent = notification.fixture.opponent.name;
  const table = notification.table;
  const opponentTable = notification.opponentTable;
  return `${notification.teamName} next fixture

Matchday ${notification.fixture.matchday}: ${notification.teamName} ${notification.fixture.isHome ? "vs" : "at"} ${opponent}
${emailDateLabel(notification.fixture.kickoffAt)} \xB7 ${emailTimeLabel(notification.fixture.kickoffAt)} IST

Opponent snapshot: ${opponent} are ${opponentTable.rank}${opponentTable.rank === 1 ? "st" : opponentTable.rank === 2 ? "nd" : opponentTable.rank === 3 ? "rd" : "th"} with ${opponentTable.points} points, a ${opponentTable.wins}-${opponentTable.draws}-${opponentTable.losses} record, ${opponentTable.cleanSheets} clean sheets, and ${opponentTable.goalDifference >= 0 ? "+" : ""}${opponentTable.goalDifference} goal difference.

Your table position: #${table.rank} with ${table.points} points from ${table.played} matches.

Play the full 7-minute fixture in regular time. The home team submits the final score and goal log after both players are ready.

Open fixtures: https://efootball-leagues-one.vercel.app/`;
}
async function sendNextFixtureNotifications(actorEmail) {
  const snapshot = await buildNextFixtureNotifications();
  const provider = notificationProvider();
  if (!provider.apiKey) throw new ApiError(503, "EMAIL_PROVIDER_NOT_CONFIGURED", "Preview is ready, but RESEND_API_KEY is not configured in the production environment.");
  const messages = snapshot.notifications.filter((notification) => notification.recipients.length).map((notification) => ({
    from: provider.from,
    to: notification.recipients.map((recipient) => recipient.email),
    subject: `Matchday ${notification.fixture.matchday} next up: ${notification.teamShortCode} vs ${notification.fixture.opponent.shortCode}`,
    html: notificationHtml(notification),
    text: notificationText(notification)
  }));
  if (!messages.length) {
    throw new ApiError(409, "NO_NOTIFICATION_RECIPIENTS", "No active player accounts are assigned to teams with a next fixture.");
  }
  const fixtureKey = snapshot.notifications.map((notification) => `${notification.teamId}:${notification.fixture.id}`).join("|").slice(0, 180);
  const resendResponse = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `eleague-next-fixtures-${snapshot.seasonId}-${leagueDateKey2()}-${fixtureKey}`.slice(0, 256) },
    body: JSON.stringify(messages)
  });
  const raw = await resendResponse.text();
  if (!resendResponse.ok) {
    let detail = raw;
    try {
      detail = String(JSON.parse(raw).message || JSON.parse(raw).error || raw);
    } catch {
    }
    throw new ApiError(502, "EMAIL_DELIVERY_FAILED", `Resend could not deliver the match notifications: ${detail.slice(0, 220)}`);
  }
  const result = await withTransaction(async (connection) => {
    await connection.query({
      sql: `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
            VALUES (:email, 'NOTIFY_NEXT_FIXTURES', 'season', :seasonId,
                    JSON_OBJECT('sentTeams', :sentTeams, 'skippedTeams', :skippedTeams, 'fixtureKey', :fixtureKey, 'provider', 'resend'), :now)`,
      namedPlaceholders: true
    }, { email: actorEmail, seasonId: String(snapshot.seasonId), sentTeams: messages.length, skippedTeams: snapshot.skipped, fixtureKey, now: Date.now() });
    return { sent: messages.length };
  });
  return { ...snapshot, sent: result.sent };
}
app.get("/api/admin/notifications/next-fixtures", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const snapshot = await buildNextFixtureNotifications();
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.json(snapshot);
}));
app.post("/api/admin/notifications/next-fixtures", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.json(await sendNextFixtureNotifications(user.email));
}));
app.get("/api/dashboard", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  await ensureNewsTables();
  const seasonRows = await query("SELECT id, name, status, matchday_count, current_matchday FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0] || null;
  const teams = await query("SELECT id, name, short_code, manager_name, accent, status, created_by_email FROM teams ORDER BY name");
  const users = await query(
    `SELECT u.email, u.display_name, u.role, u.status, tm.team_id
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
      ORDER BY u.display_name`
  );
  const params = { seasonId: season?.id ?? 0 };
  const rawMatches = season ? await query(
    `SELECT m.id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.rescheduled_at, m.reschedule_reason,
            m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.submitted_at, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId
      ORDER BY m.matchday, m.kickoff_at`,
    params
  ) : [];
  const matches = attachMatchdayDates(rawMatches);
  const matchIds = matches.map((match) => Number(match.id));
  const goals = matchIds.length ? await query(
    `SELECT g.id, g.match_id, g.team_id, g.player_email, g.scorer_name, g.minute
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE m.season_id = :seasonId ORDER BY g.minute`,
    { seasonId: season?.id ?? 0 }
  ) : [];
  const confirmedMatches = season ? await query(
    "SELECT home_team_id, away_team_id, home_score, away_score FROM matches WHERE season_id = :seasonId AND status = 'CONFIRMED'",
    { seasonId: season.id }
  ) : [];
  const stats = await query(
    `SELECT g.player_email, g.scorer_name, g.team_id, t.name AS team_name, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id JOIN teams t ON t.id = g.team_id
      WHERE m.status = 'CONFIRMED'
      GROUP BY g.player_email, g.scorer_name, g.team_id, t.name
      ORDER BY goals DESC, g.scorer_name`
  );
  const scorerReviews = user.role === "admin" ? (await backfillScorerReviewRecords(), await scorerReviewRows()) : [];
  const news = await getNewsRows(season?.id === void 0 ? void 0 : Number(season.id));
  const seasonArchives = await getArchiveRows();
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.json({
    season,
    teams,
    users,
    matches,
    goals,
    standings: calculateStandings(teams.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), confirmedMatches.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: Number(match.home_score), awayScore: Number(match.away_score) }))),
    stats,
    scorerReviews,
    news,
    seasonArchives
  });
}));
app.get("/api/teams", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const rows = await query(
    `SELECT t.id, t.name, t.short_code, t.manager_name, t.accent, t.status, t.created_by_email, COUNT(tm.user_email) AS member_count
       FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id
      GROUP BY t.id ORDER BY t.name`
  );
  response.json({ teams: user.role === "admin" ? rows : rows.filter((team) => team.id === user.teamId) });
}));
app.get("/api/teams/:teamId/scorers", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const teamId = Number(request.params.teamId);
  if (user.role !== "admin" && user.teamId !== teamId) {
    response.status(403).json({ error: "TEAM_ACCESS_REQUIRED", message: "Scorer history is private to the team and league admin." });
    return;
  }
  const scorers = await query(
    `SELECT g.scorer_name AS name, g.player_email AS email, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE g.team_id = :teamId AND m.status IN ('PENDING', 'CONFIRMED', 'DISPUTED')
      GROUP BY g.player_email, g.scorer_name
      ORDER BY goals DESC, name ASC`,
    { teamId }
  );
  response.json({ scorers });
}));
app.get("/api/admin/scorer-reviews", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await backfillScorerReviewRecords();
  response.json({ reviews: await scorerReviewRows(typeof request.query.status === "string" ? request.query.status : void 0) });
}));
app.post("/api/admin/scorer-reviews/analyze", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await backfillScorerReviewRecords();
  const requestedIds = Array.isArray(request.body?.reviewIds) ? request.body.reviewIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0).slice(0, 3) : [];
  const rows = requestedIds.length ? await query(
    `SELECT id FROM scorer_name_reviews WHERE id IN (${requestedIds.join(",")}) AND status IN ('PENDING', 'FAILED') ORDER BY id`
  ) : await query(
    `SELECT id FROM scorer_name_reviews
          WHERE status IN ('PENDING', 'FAILED')
          ORDER BY CASE WHEN suggested_name IS NULL THEN 0 ELSE 1 END, created_at ASC
          LIMIT 3`
  );
  const results = await processScorerNameReviews(rows.map((row) => Number(row.id)));
  response.json({ analyzed: results.filter((item) => item.status === "PENDING").length, failed: results.filter((item) => item.status === "FAILED").length, reviews: await scorerReviewRows() });
}));
app.post("/api/admin/scorer-reviews/:reviewId/approve", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await ensureScorerReviewTable();
  const reviewId = Number(request.params.reviewId);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    response.status(400).json({ error: "INVALID_REVIEW_ID", message: "That scorer review identifier is invalid." });
    return;
  }
  const rows = await query(
    "SELECT id, goal_id, suggested_name, matched_email, status FROM scorer_name_reviews WHERE id = :reviewId LIMIT 1",
    { reviewId }
  );
  const review = rows[0];
  if (!review) {
    response.status(404).json({ error: "REVIEW_NOT_FOUND", message: "That scorer review no longer exists." });
    return;
  }
  if (review.status === "APPROVED") {
    response.json({ reviewId, status: "APPROVED", alreadyApplied: true });
    return;
  }
  const approvedName = clipText(String(request.body?.approvedName || review.suggested_name || ""), 120);
  if (!approvedName) {
    response.status(400).json({ error: "SUGGESTION_REQUIRED", message: "Analyze the scorer name before approving it." });
    return;
  }
  const now = Date.now();
  await withTransaction(async (connection) => {
    if (review.goal_id) {
      await connection.execute("UPDATE goals SET scorer_name = ?, player_email = ? WHERE id = ?", [approvedName, review.matched_email || null, review.goal_id]);
    }
    await connection.execute(
      `UPDATE scorer_name_reviews
          SET approved_name = ?, status = 'APPROVED', reviewed_by_email = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?`,
      [approvedName, user.email, now, now, reviewId]
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'SCORER_NAME_APPROVED', 'scorer_name_review', ?, JSON_OBJECT('approvedName', ?), ?)`,
      [user.email, String(reviewId), approvedName, now]
    );
  });
  response.json({ reviewId, status: "APPROVED", approvedName });
}));
app.post("/api/admin/scorer-reviews/:reviewId/reject", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await ensureScorerReviewTable();
  const reviewId = Number(request.params.reviewId);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    response.status(400).json({ error: "INVALID_REVIEW_ID", message: "That scorer review identifier is invalid." });
    return;
  }
  const now = Date.now();
  const result = await query(
    `UPDATE scorer_name_reviews SET status = 'REJECTED', reviewed_by_email = :email, reviewed_at = :now, updated_at = :now
      WHERE id = :reviewId AND status <> 'APPROVED'`,
    { reviewId, email: user.email, now }
  );
  if (!result.affectedRows) {
    response.status(404).json({ error: "REVIEW_NOT_FOUND", message: "That scorer review is already approved or no longer exists." });
    return;
  }
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:email, 'SCORER_NAME_REJECTED', 'scorer_name_review', :reviewId, JSON_OBJECT(), :now)`,
    { email: user.email, reviewId: String(reviewId), now }
  );
  response.json({ reviewId, status: "REJECTED" });
}));
app.post("/api/admin/teams", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const name = String(request.body?.name || "").trim();
  const shortCode = String(request.body?.shortCode || "").trim().toUpperCase();
  const managerName = String(request.body?.managerName || "").trim();
  const accent = String(request.body?.accent || "#9DD36A").trim();
  if (!name || !shortCode || !managerName) {
    response.status(400).json({ error: "INVALID_TEAM", message: "Team name, short code, and manager name are required." });
    return;
  }
  const existingTeamName = await query("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) LIMIT 1", { name });
  const existingTeamCode = await query("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) LIMIT 1", { shortCode });
  if (existingTeamName[0] && existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_NAME_AND_CODE_IN_USE", message: "That team name and team code already exist. Choose different values." });
    return;
  }
  if (existingTeamName[0]) {
    response.status(409).json({ error: "TEAM_NAME_IN_USE", message: "That team name already exists. Choose a different name." });
    return;
  }
  if (existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_CODE_IN_USE", message: "That team code already exists. Choose a different code." });
    return;
  }
  const now = Date.now();
  try {
    const result = await query(
      "INSERT INTO teams (name, short_code, manager_name, accent, status, created_by_email, approved_by_email, approved_at, created_at) VALUES (:name, :shortCode, :managerName, :accent, 'APPROVED', :createdBy, :approvedBy, :approvedAt, :createdAt)",
      { name, shortCode, managerName, accent, createdBy: user.email, approvedBy: user.email, approvedAt: now, createdAt: now }
    );
    response.status(201).json({ id: result.insertId, status: "APPROVED" });
  } catch (error) {
    const conflict = duplicateTeamError(error);
    if (conflict) throw conflict;
    throw error;
  }
}));
app.patch("/api/admin/teams/:teamId", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const teamId = Number(request.params.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    response.status(400).json({ error: "INVALID_TEAM_ID", message: "That team identifier is invalid." });
    return;
  }
  const name = String(request.body?.name || "").trim();
  const shortCode = String(request.body?.shortCode || "").trim().toUpperCase();
  const managerName = String(request.body?.managerName || "").trim();
  const accent = String(request.body?.accent || "#9DD36A").trim();
  if (!name || !shortCode || !managerName) {
    response.status(400).json({ error: "INVALID_TEAM_UPDATE", message: "Team name, team code, and manager name are required." });
    return;
  }
  if (name.length > 120) {
    response.status(400).json({ error: "INVALID_TEAM_NAME", message: "Team name must be 120 characters or fewer." });
    return;
  }
  if (!/^[A-Z0-9]{2,12}$/.test(shortCode)) {
    response.status(400).json({ error: "INVALID_TEAM_CODE", message: "Team code must contain 2 to 12 letters or numbers." });
    return;
  }
  if (managerName.length > 120 || !/^#[0-9A-Fa-f]{6}$/.test(accent)) {
    response.status(400).json({ error: "INVALID_TEAM_STYLE", message: "Manager name must be 120 characters or fewer and accent must be a six-digit hex color." });
    return;
  }
  const teamRows = await query("SELECT id, name, short_code, manager_name, accent FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  const current = teamRows[0];
  if (!current) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const existingTeamName = await query("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) AND id <> :teamId LIMIT 1", { name, teamId });
  const existingTeamCode = await query("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) AND id <> :teamId LIMIT 1", { shortCode, teamId });
  if (existingTeamName[0] && existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_NAME_AND_CODE_IN_USE", message: "That team name and team code already exist. Choose different values." });
    return;
  }
  if (existingTeamName[0]) {
    response.status(409).json({ error: "TEAM_NAME_IN_USE", message: "That team name already exists. Choose a different name." });
    return;
  }
  if (existingTeamCode[0]) {
    response.status(409).json({ error: "TEAM_CODE_IN_USE", message: "That team code already exists. Choose a different code." });
    return;
  }
  if (current.name === name && current.short_code === shortCode && current.manager_name === managerName && current.accent === accent) {
    response.json({ teamId, name, shortCode, managerName, accent, updated: false });
    return;
  }
  const now = Date.now();
  try {
    await withTransaction(async (connection) => {
      await connection.execute("UPDATE teams SET name = ?, short_code = ?, manager_name = ?, accent = ? WHERE id = ?", [name, shortCode, managerName, accent, teamId]);
      await connection.execute(
        `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
         VALUES (?, 'TEAM_UPDATED', 'team', ?, JSON_OBJECT('oldName', ?, 'newName', ?, 'oldShortCode', ?, 'newShortCode', ?, 'oldManagerName', ?, 'newManagerName', ?, 'oldAccent', ?, 'newAccent', ?), ?)`,
        [user.email, String(teamId), current.name, name, current.short_code, shortCode, current.manager_name, managerName, current.accent, accent, now]
      );
    });
  } catch (error) {
    const conflict = duplicateTeamError(error);
    if (conflict) throw conflict;
    throw error;
  }
  response.json({ teamId, name, shortCode, managerName, accent, updated: true });
}));
app.delete("/api/admin/teams/:teamId", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const teamId = Number(request.params.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    response.status(400).json({ error: "INVALID_TEAM_ID", message: "That team identifier is invalid." });
    return;
  }
  const teamRows = await query("SELECT id, name, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  const team = teamRows[0];
  if (!team) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const fixtureRows = await query("SELECT COUNT(*) AS count FROM matches WHERE home_team_id = :teamId OR away_team_id = :teamId", { teamId });
  if (Number(fixtureRows[0]?.count || 0) > 0) {
    response.status(409).json({ error: "TEAM_HAS_FIXTURES", message: "Teams with fixtures cannot be deleted. Finish or archive the tournament first." });
    return;
  }
  const now = Date.now();
  await withTransaction(async (connection) => {
    await connection.execute("DELETE FROM team_memberships WHERE team_id = ?", [teamId]);
    await connection.execute("DELETE FROM teams WHERE id = ?", [teamId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'TEAM_DELETED', 'team', ?, JSON_OBJECT('name', ?, 'status', ?), ?)`,
      [user.email, String(teamId), team.name, team.status, now]
    );
  });
  response.json({ teamId, deleted: true });
}));
app.post("/api/admin/teams/:teamId/decision", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const teamId = Number(request.params.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    response.status(400).json({ error: "INVALID_TEAM_ID", message: "That team identifier is invalid." });
    return;
  }
  const decision = request.body?.decision === "reject" ? "REJECTED" : request.body?.decision === "approve" ? "APPROVED" : null;
  if (!decision) {
    response.status(400).json({ error: "INVALID_TEAM_DECISION", message: "Choose approve or reject before continuing." });
    return;
  }
  const existing = await query("SELECT id, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  if (!existing[0]) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  if (existing[0].status === decision) {
    response.json({ teamId, status: decision, alreadyApplied: true });
    return;
  }
  const now = Date.now();
  await withTransaction(async (connection) => {
    await connection.execute(
      "UPDATE teams SET status = ?, approved_by_email = ?, approved_at = ? WHERE id = ?",
      [decision, user.email, now, teamId]
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, ?, 'team', ?, JSON_OBJECT('decision', ?), ?)`,
      [user.email, decision === "APPROVED" ? "TEAM_APPROVED" : "TEAM_REJECTED", String(teamId), decision, now]
    );
  });
  response.json({ teamId, status: decision, alreadyApplied: false });
}));
app.post("/api/admin/users", asyncRoute(async (request, response) => {
  const actor = requireAdmin(request, response);
  if (!actor) return;
  const email = String(request.body?.email || "").trim().toLowerCase();
  const displayName = String(request.body?.displayName || "").trim();
  const password = String(request.body?.password || "");
  const role = request.body?.role === "admin" ? "admin" : "player";
  const teamId = request.body?.teamId ? Number(request.body.teamId) : null;
  if (!email.includes("@") || !displayName || password.length < 8) {
    response.status(400).json({ error: "INVALID_USER", message: "Email, display name, and an 8-character password are required." });
    return;
  }
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO users (email, display_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [email, displayName, passwordHash, role, now, now]
    );
    if (teamId && role === "player") {
      await connection.execute(
        "INSERT INTO team_memberships (user_email, team_id, membership_role, created_at) VALUES (?, ?, 'PLAYER', ?)",
        [email, teamId, now]
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'CREATE_USER', 'user', ?, JSON_OBJECT('role', ?), ?)`,
      [actor.email, email, role, now]
    );
  });
  response.status(201).json({ user: await findUserByEmail(email) });
}));
app.patch("/api/admin/users/:email", asyncRoute(async (request, response) => {
  const actor = requireAdmin(request, response);
  if (!actor) return;
  const email = decodeURIComponent(String(request.params.email || "")).trim().toLowerCase();
  const displayName = clipText(String(request.body?.displayName || "").trim(), 120);
  const role = request.body?.role === "admin" ? "admin" : request.body?.role === "player" ? "player" : "";
  const status = ["ACTIVE", "INVITED", "DISABLED"].includes(String(request.body?.status)) ? String(request.body.status) : "";
  const rawTeamId = request.body?.teamId;
  const teamId = rawTeamId === null || rawTeamId === void 0 || rawTeamId === "" ? null : Number(rawTeamId);
  if (!email.includes("@") || !displayName || !role || !status || teamId !== null && (!Number.isInteger(teamId) || teamId <= 0)) {
    response.status(400).json({ error: "INVALID_USER_UPDATE", message: "Provide a display name, valid role, status, and team assignment." });
    return;
  }
  if (email === actor.email && (role !== "admin" || status !== "ACTIVE")) {
    response.status(400).json({ error: "SELF_LOCKOUT_BLOCKED", message: "You cannot remove your own active admin access." });
    return;
  }
  const existingRows = await query(
    "SELECT email, display_name, role, status FROM users WHERE email = :email LIMIT 1",
    { email }
  );
  const existing = existingRows[0];
  if (!existing) {
    response.status(404).json({ error: "USER_NOT_FOUND", message: "That player account no longer exists." });
    return;
  }
  if (role === "player" && teamId !== null) {
    const teamRows = await query("SELECT id, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
    if (!teamRows[0] || teamRows[0].status === "REJECTED") {
      response.status(400).json({ error: "INVALID_TEAM_ASSIGNMENT", message: "Assign the player to an existing non-rejected team." });
      return;
    }
  }
  const now = Date.now();
  await withTransaction(async (connection) => {
    await connection.execute("UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE email = ?", [displayName, role, status, now, email]);
    await connection.execute("DELETE FROM team_memberships WHERE user_email = ?", [email]);
    if (role === "player" && teamId !== null) {
      await connection.execute("INSERT INTO team_memberships (user_email, team_id, membership_role, created_at) VALUES (?, ?, 'PLAYER', ?)", [email, teamId, now]);
    }
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'UPDATE_USER', 'user', ?, JSON_OBJECT('displayName', ?, 'role', ?, 'status', ?, 'teamId', ?), ?)`,
      [actor.email, email, displayName, role, status, teamId, now]
    );
  });
  response.json({ user: await findUserByEmail(email) });
}));
app.post("/api/admin/seasons", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const name = String(request.body?.name || "").trim();
  if (!name) {
    response.status(400).json({ error: "INVALID_SEASON", message: "A season name is required." });
    return;
  }
  const now = Date.now();
  const result = await query(
    "INSERT INTO seasons (name, status, created_at, updated_at) VALUES (:name, 'DRAFT', :createdAt, :updatedAt)",
    { name, createdAt: now, updatedAt: now }
  );
  response.status(201).json({ id: result.insertId });
}));
async function createSeasonSchedule(seasonId, actorEmail) {
  if (!Number.isInteger(seasonId) || seasonId <= 0) throw new ApiError(400, "INVALID_SEASON_ID", "That season identifier is invalid.");
  const seasonRows = await query("SELECT id, name FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId });
  if (!seasonRows[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "Create the league season before starting the tournament.");
  const teamRows = await query("SELECT id FROM teams WHERE status = 'APPROVED' ORDER BY id");
  const teamIds = teamRows.map((team) => Number(team.id));
  if (teamIds.length < 2) throw new ApiError(400, "NOT_ENOUGH_APPROVED_TEAMS", "Approve at least two teams before starting the tournament.");
  const fixtures = generateRoundRobin(teamIds);
  const now = Date.now();
  await withTransaction(async (connection) => {
    const [existing] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    const existingRows = existing;
    if (Number(existingRows[0]?.count || 0) > 0) throw new ApiError(409, "SCHEDULE_EXISTS", "This season already has fixtures. Use the existing tournament instead of starting it again.");
    const fixturePlaceholders = fixtures.map(() => "(?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)").join(", ");
    const fixtureValues = [];
    for (const fixture of fixtures) {
      fixtureValues.push(seasonId, fixture.matchday, fixture.homeTeamId, fixture.awayTeamId, fixture.kickoffAt, now, now);
    }
    await connection.execute(
      `INSERT INTO matches (season_id, matchday, home_team_id, away_team_id, kickoff_at, status, created_at, updated_at)
       VALUES ${fixturePlaceholders}`,
      fixtureValues
    );
    await connection.execute("UPDATE seasons SET status = 'ACTIVE', matchday_count = ?, current_matchday = 1, updated_at = ? WHERE id = ?", [Math.max(...fixtures.map((fixture) => fixture.matchday)), now, seasonId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'GENERATE_SCHEDULE', 'season', ?, JSON_OBJECT('fixtures', ?), ?)`,
      [actorEmail, String(seasonId), fixtures.length, now]
    );
  });
  assertScheduleIsCompatible(teamIds, fixtures);
  return { seasonId, fixturesCreated: fixtures.length, matchdays: Math.max(...fixtures.map((fixture) => fixture.matchday), 0), matchesPerDay: Math.floor(teamIds.length / 2), matchesPerTeam: teamIds.length - 1 };
}
app.post("/api/admin/seasons/:seasonId/schedule", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const result = await createSeasonSchedule(Number(request.params.seasonId), user.email);
  response.status(201).json(result);
}));
app.post("/api/admin/seasons/:seasonId/reset", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    response.status(400).json({ error: "INVALID_SEASON_ID", message: "That season identifier is invalid." });
    return;
  }
  const now = Date.now();
  let deletedMatches = 0;
  await withTransaction(async (connection) => {
    const [seasonResult] = await connection.query("SELECT id, name FROM seasons WHERE id = ? LIMIT 1", [seasonId]);
    const seasons = seasonResult;
    if (!seasons[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "That tournament season no longer exists.");
    const [countResult] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    deletedMatches = Number(countResult[0]?.count || 0);
    await connection.execute("DELETE FROM matches WHERE season_id = ?", [seasonId]);
    await connection.execute("UPDATE seasons SET status = 'DRAFT', matchday_count = 0, current_matchday = 0, updated_at = ? WHERE id = ?", [now, seasonId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'RESET_TOURNAMENT', 'season', ?, JSON_OBJECT('deletedMatches', ?), ?)`,
      [user.email, String(seasonId), deletedMatches, now]
    );
  });
  response.json({ seasonId, deletedMatches, status: "DRAFT" });
}));
app.post("/api/admin/seasons/:seasonId/start", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const existing = await query("SELECT COUNT(*) AS count FROM matches WHERE season_id = :seasonId", { seasonId });
  let result;
  if (Number(existing[0]?.count || 0) === 0) {
    result = await createSeasonSchedule(seasonId, user.email);
  } else {
    const seasonRows = await query("SELECT id, status, matchday_count, current_matchday FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId });
    if (!seasonRows[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "That season no longer exists.");
    const teamRows = await query("SELECT id FROM teams WHERE status = 'APPROVED' ORDER BY id");
    const now = Date.now();
    await withTransaction(async (connection) => {
      await connection.execute("UPDATE seasons SET status = 'ACTIVE', updated_at = ? WHERE id = ?", [now, seasonId]);
      await connection.execute(
        `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
         VALUES (?, 'START_TOURNAMENT', 'season', ?, JSON_OBJECT('existingFixtures', ?), ?)`,
        [user.email, String(seasonId), Number(existing[0]?.count || 0), now]
      );
    });
    result = { seasonId, fixturesCreated: 0, matchdays: Number(seasonRows[0].matchday_count || 0), matchesPerDay: Math.floor(teamRows.length / 2), matchesPerTeam: Math.max(teamRows.length - 1, 0) };
  }
  response.json({ ...result, status: "ACTIVE" });
}));
app.post("/api/matches/:matchId/reschedule", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const matchId = Number(request.params.matchId);
  const kickoffAt = Number(request.body?.kickoffAt);
  const reason = String(request.body?.reason || "Match postponed by league participant").trim().slice(0, 255);
  if (!Number.isFinite(kickoffAt) || kickoffAt <= Date.now()) {
    response.status(400).json({ error: "INVALID_KICKOFF", message: "Choose a future date and time for the adjusted fixture." });
    return;
  }
  const rows = await query("SELECT home_team_id, away_team_id, status, kickoff_at, original_kickoff_at FROM matches WHERE id = :matchId LIMIT 1", { matchId });
  const match = rows[0];
  if (!match) {
    response.status(404).json({ error: "MATCH_NOT_FOUND", message: "That fixture no longer exists." });
    return;
  }
  if (match.status === "CONFIRMED") {
    response.status(409).json({ error: "MATCH_CONFIRMED", message: "Confirmed fixtures cannot be adjusted." });
    return;
  }
  if (user.role !== "admin" && user.teamId !== Number(match.home_team_id) && user.teamId !== Number(match.away_team_id)) {
    response.status(403).json({ error: "TEAM_ACCESS_REQUIRED", message: "Only an admin or one of the participating teams can adjust this fixture." });
    return;
  }
  const now = Date.now();
  await query(
    `UPDATE matches SET status = 'POSTPONED', original_kickoff_at = COALESCE(original_kickoff_at, kickoff_at), kickoff_at = :kickoffAt,
      rescheduled_at = :rescheduledAt, reschedule_reason = :reason, rescheduled_by_email = :rescheduledBy, updated_at = :updatedAt
     WHERE id = :matchId`,
    { kickoffAt, rescheduledAt: now, reason, rescheduledBy: user.email, updatedAt: now, matchId }
  );
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:actor, 'MATCH_RESCHEDULED', 'match', :entityId, JSON_OBJECT('kickoffAt', :kickoffAt, 'reason', :reason), :createdAt)`,
    { actor: user.email, entityId: String(matchId), kickoffAt, reason, createdAt: now }
  );
  response.json({ matchId, status: "POSTPONED", kickoffAt, reason });
}));
app.get("/api/seasons/:seasonId/matches", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const params = { seasonId };
  const teamFilter = user.role === "player" && user.teamId ? "AND (m.home_team_id = :teamId OR m.away_team_id = :teamId)" : "";
  if (user.role === "player" && user.teamId) params.teamId = user.teamId;
  const matches = await query(
    `SELECT m.id, m.season_id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`,
    params
  );
  response.json({ matches: attachMatchdayDates(matches) });
}));
app.get("/api/seasons/:seasonId/standings", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const teams = await query("SELECT id, name, short_code FROM teams ORDER BY name");
  const matches = await query(
    "SELECT home_team_id, away_team_id, home_score, away_score FROM matches WHERE season_id = :seasonId AND status = 'CONFIRMED'",
    { seasonId }
  );
  response.json({ standings: calculateStandings(teams.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), matches.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: Number(match.home_score), awayScore: Number(match.away_score) }))) });
}));
app.post("/api/matches/:matchId/result", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const matchId = Number(request.params.matchId);
  const homeScore = Number(request.body?.homeScore);
  const awayScore = Number(request.body?.awayScore);
  const goals = Array.isArray(request.body?.goals) ? request.body.goals : [];
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0 || homeScore > 99 || awayScore > 99) {
    response.status(400).json({ error: "INVALID_SCORE", message: "Scores must be whole numbers from 0 to 99." });
    return;
  }
  const matchRows = await query(
    `SELECT m.home_team_id, m.away_team_id, m.season_id, m.matchday, m.kickoff_at,
            CASE WHEN m.original_kickoff_at IS NOT NULL THEN m.kickoff_at
              ELSE (SELECT MIN(m2.kickoff_at) FROM matches m2 WHERE m2.season_id = m.season_id AND m2.matchday = m.matchday AND m2.original_kickoff_at IS NULL)
            END AS matchday_anchor_at,
            m.status, m.submitted_by_email
       FROM matches m WHERE m.id = :matchId LIMIT 1`,
    { matchId }
  );
  const match = matchRows[0];
  if (!match) {
    response.status(404).json({ error: "MATCH_NOT_FOUND", message: "That fixture no longer exists." });
    return;
  }
  if (match.status === "CONFIRMED") {
    response.status(409).json({ error: "MATCH_CONFIRMED", message: "Official results cannot be overwritten." });
    return;
  }
  const kickoffAt = Number(match.kickoff_at);
  const matchdayAnchorAt = Number(match.matchday_anchor_at ?? kickoffAt);
  const scheduledDate = Number.isFinite(matchdayAnchorAt) ? leagueDateKey2(matchdayAnchorAt) : "";
  if (!scheduledDate || leagueDateKey2() < scheduledDate) {
    response.status(425).json({ error: "MATCH_NOT_OPEN", message: `This fixture opens on ${scheduledDate ? formatLeagueDateLabel(scheduledDate) : "its scheduled date"}. Results can be entered from the scheduled league date.` });
    return;
  }
  if (user.role !== "admin" && user.teamId !== Number(match.home_team_id)) {
    response.status(403).json({ error: "HOME_TEAM_REQUIRED", message: "Only the home team can enter the match result. The away team can view the fixture and wait for confirmation." });
    return;
  }
  if (match.submitted_by_email && match.submitted_by_email !== user.email && user.role !== "admin") {
    response.status(409).json({ error: "PENDING_REVIEW", message: "Another player has already submitted this result. Ask an administrator to review it." });
    return;
  }
  const now = Date.now();
  await ensureScorerReviewTable();
  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE matches SET status = 'PENDING', home_score = ?, away_score = ?, submitted_by_email = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      [homeScore, awayScore, user.email, now, now, matchId]
    );
    await connection.execute("DELETE FROM scorer_name_reviews WHERE match_id = ?", [matchId]);
    await connection.execute("DELETE FROM goals WHERE match_id = ?", [matchId]);
    for (const goal of goals) {
      const teamId = Number(goal.teamId);
      const minute = Number(goal.minute);
      const scorerName = String(goal.scorerName || "").trim();
      if (!Number.isInteger(teamId) || !Number.isInteger(minute) || !scorerName || minute < 1 || minute > 130) continue;
      const [goalResult] = await connection.execute(
        `INSERT INTO goals (match_id, team_id, player_email, scorer_name, minute, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [matchId, teamId, typeof goal.playerEmail === "string" ? goal.playerEmail.trim().toLowerCase() : null, scorerName, minute, now]
      );
      const goalId = Number(goalResult.insertId || 0);
      await connection.execute(
        `INSERT INTO scorer_name_reviews
          (match_id, goal_id, team_id, submitted_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        [matchId, goalId || null, teamId, scorerName, now, now]
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'SUBMIT_RESULT', 'match', ?, JSON_OBJECT('homeScore', ?, 'awayScore', ?), ?)`,
      [user.email, String(matchId), homeScore, awayScore, now]
    );
  });
  response.status(201).json({ matchId, status: "PENDING" });
}));
app.post("/api/matches/:matchId/confirm", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const matchId = Number(request.params.matchId);
  const now = Date.now();
  const result = await query(
    `UPDATE matches SET status = 'CONFIRMED', confirmed_by_email = :email, confirmed_at = :now, updated_at = :now
      WHERE id = :matchId AND status = 'PENDING' AND home_score IS NOT NULL AND away_score IS NOT NULL`,
    { email: user.email, now, matchId }
  );
  const affectedRows = result.affectedRows;
  if (!affectedRows) {
    response.status(409).json({ error: "NOT_PENDING", message: "Only a complete pending result can be confirmed." });
    return;
  }
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:email, 'CONFIRM_RESULT', 'match', :matchId, JSON_OBJECT(), :now)`,
    { email: user.email, matchId: String(matchId), now }
  );
  response.json({ matchId, status: "CONFIRMED" });
}));
app.get("/api/stats/players", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const rows = await query(
    `SELECT g.player_email, g.scorer_name, g.team_id, t.name AS team_name, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id JOIN teams t ON t.id = g.team_id
      WHERE m.status = 'CONFIRMED'
      GROUP BY g.player_email, g.scorer_name, g.team_id, t.name
      ORDER BY goals DESC, g.scorer_name`
  );
  response.json({ players: rows });
}));
app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  response.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected server error." });
});
var app_default = app;

// server/vercel-api.ts
var vercel_api_default = app_default;
export {
  vercel_api_default as default
};
