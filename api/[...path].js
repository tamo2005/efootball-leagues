// server/app.ts
import express from "express";

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
    pool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
      waitForConnections: true,
      enableKeepAlive: true,
      namedPlaceholders: true,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : void 0
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
function generateRoundRobin(teamIds, startingAt = Date.now(), kickoffGapMs = 1e3 * 60 * 60 * 24 * 7) {
  const uniqueIds = teamIds.filter((id, index) => teamIds.indexOf(id) === index);
  if (uniqueIds.length < 2) throw new Error("At least two teams are required to create a schedule.");
  const participants = [...uniqueIds];
  if (participants.length % 2 === 1) participants.push(null);
  const rounds = participants.length - 1;
  const fixtures = [];
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
        kickoffAt: startingAt + round * kickoffGapMs + index * 1e3 * 60 * 90
      });
    }
    rotating.splice(1, 0, rotating.pop());
  }
  assertScheduleIsCompatible(uniqueIds, fixtures);
  return fixtures;
}
function assertScheduleIsCompatible(teamIds, fixtures) {
  const expectedMatches = teamIds.length * (teamIds.length - 1) / 2;
  if (fixtures.length !== expectedMatches) {
    throw new Error(`Schedule generated ${fixtures.length} matches; expected ${expectedMatches}.`);
  }
  const pairKeys = /* @__PURE__ */ new Set();
  const teamDays = /* @__PURE__ */ new Set();
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

// server/app.ts
var app = express();
app.use(express.json({ limit: "1mb" }));
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
app.use(asyncRoute(async (request, _response) => {
  request.user = await getCurrentUser(request);
}));
app.get("/api/health", asyncRoute(async (_request, response) => {
  response.json({ service: "efootball-leagues-api", database: await databaseHealth(), now: Date.now() });
}));
app.post("/api/auth/login", asyncRoute(async (request, response) => {
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
}));
app.get("/api/auth/me", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  response.json({ user });
}));
app.post("/api/auth/logout", asyncRoute(async (request, response) => {
  await clearSession(request, response);
  response.json({ ok: true });
}));
app.get("/api/dashboard", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonRows = await query("SELECT id, name, status, matchday_count, current_matchday FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0] || null;
  const teams = await query("SELECT id, name, short_code, manager_name, accent FROM teams ORDER BY name");
  const params = { seasonId: season?.id ?? 0 };
  const teamFilter = user.role === "player" && user.teamId ? "AND (m.home_team_id = :teamId OR m.away_team_id = :teamId)" : "";
  if (user.role === "player" && user.teamId) params.teamId = user.teamId;
  const matches = season ? await query(
    `SELECT m.id, m.matchday, m.kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`,
    params
  ) : [];
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
  response.json({
    season,
    teams,
    matches,
    goals,
    standings: calculateStandings(teams.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), confirmedMatches.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: Number(match.home_score), awayScore: Number(match.away_score) }))),
    stats
  });
}));
app.get("/api/teams", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const rows = await query(
    `SELECT t.id, t.name, t.short_code, t.manager_name, t.accent, COUNT(tm.user_email) AS member_count
       FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id
      GROUP BY t.id ORDER BY t.name`
  );
  response.json({ teams: user.role === "admin" ? rows : rows.filter((team) => team.id === user.teamId) });
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
  const now = Date.now();
  const result = await query(
    "INSERT INTO teams (name, short_code, manager_name, accent, created_at) VALUES (:name, :shortCode, :managerName, :accent, :createdAt)",
    { name, shortCode, managerName, accent, createdAt: now }
  );
  response.status(201).json({ id: result.insertId });
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
app.post("/api/admin/seasons/:seasonId/schedule", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const teamRows = await query("SELECT id FROM teams ORDER BY id");
  const teamIds = teamRows.map((team) => Number(team.id));
  const fixtures = generateRoundRobin(teamIds);
  const now = Date.now();
  await withTransaction(async (connection) => {
    const [existing] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    const existingRows = existing;
    if (Number(existingRows[0]?.count || 0) > 0) throw new Error("This season already has fixtures. Create a new season before generating another schedule.");
    for (const fixture of fixtures) {
      await connection.execute(
        `INSERT INTO matches (season_id, matchday, home_team_id, away_team_id, kickoff_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)`,
        [seasonId, fixture.matchday, fixture.homeTeamId, fixture.awayTeamId, fixture.kickoffAt, now, now]
      );
    }
    await connection.execute("UPDATE seasons SET status = 'ACTIVE', matchday_count = ?, current_matchday = 1, updated_at = ? WHERE id = ?", [Math.max(...fixtures.map((fixture) => fixture.matchday)), now, seasonId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'GENERATE_SCHEDULE', 'season', ?, JSON_OBJECT('fixtures', ?), ?)`,
      [user.email, String(seasonId), fixtures.length, now]
    );
  });
  assertScheduleIsCompatible(teamIds, fixtures);
  response.status(201).json({ seasonId, fixturesCreated: fixtures.length, matchdays: Math.max(...fixtures.map((fixture) => fixture.matchday)) });
}));
app.get("/api/seasons/:seasonId/matches", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const params = { seasonId };
  const teamFilter = user.role === "player" && user.teamId ? "AND (m.home_team_id = :teamId OR m.away_team_id = :teamId)" : "";
  if (user.role === "player" && user.teamId) params.teamId = user.teamId;
  const matches = await query(
    `SELECT m.id, m.season_id, m.matchday, m.kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`,
    params
  );
  response.json({ matches });
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
    "SELECT home_team_id, away_team_id, status, submitted_by_email FROM matches WHERE id = :matchId LIMIT 1",
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
  if (user.role !== "admin" && user.teamId !== Number(match.home_team_id) && user.teamId !== Number(match.away_team_id)) {
    response.status(403).json({ error: "TEAM_ACCESS_REQUIRED", message: "Players can only submit results for fixtures involving their team." });
    return;
  }
  if (match.submitted_by_email && match.submitted_by_email !== user.email && user.role !== "admin") {
    response.status(409).json({ error: "PENDING_REVIEW", message: "Another player has already submitted this result. Ask an administrator to review it." });
    return;
  }
  const now = Date.now();
  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE matches SET status = 'PENDING', home_score = ?, away_score = ?, submitted_by_email = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      [homeScore, awayScore, user.email, now, now, matchId]
    );
    await connection.execute("DELETE FROM goals WHERE match_id = ?", [matchId]);
    for (const goal of goals) {
      const teamId = Number(goal.teamId);
      const minute = Number(goal.minute);
      const scorerName = String(goal.scorerName || "").trim();
      if (!Number.isInteger(teamId) || !Number.isInteger(minute) || !scorerName || minute < 1 || minute > 130) continue;
      await connection.execute(
        `INSERT INTO goals (match_id, team_id, player_email, scorer_name, minute, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [matchId, teamId, typeof goal.playerEmail === "string" ? goal.playerEmail.trim().toLowerCase() : null, scorerName, minute, now]
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
  response.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected server error." });
});
var app_default = app;

// server/vercel-api.ts
var vercel_api_default = app_default;
export {
  vercel_api_default as default
};
