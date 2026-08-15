import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { clearSession, createSession, findUserByEmail, getCurrentUser, hashPassword, verifyPassword, type CurrentUser } from "./auth";
import { databaseHealth, isDatabaseConfigured, query, withTransaction } from "./db";
import { assertScheduleIsCompatible, calculateStandings, generateRoundRobin } from "./league-service";

const app = express();
app.use(express.json({ limit: "1mb" }));

const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => {
  handler(request, response).catch(next);
};

function requireUser(request: Request, response: Response) {
  const user = (request as Request & { user?: CurrentUser | null }).user;
  if (!user) {
    response.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in to continue." });
    return null;
  }
  return user;
}

function requireAdmin(request: Request, response: Response) {
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
    (request as Request & { user?: CurrentUser | null }).user = await getCurrentUser(request);
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", asyncRoute(async (_request, response) => {
  response.json({ service: "efootball-leagues-api", database: await databaseHealth(), now: Date.now() });
}));

const loginRoute = asyncRoute(async (request, response) => {
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
  const rows = await query<Array<{ email: string; password_hash: string; status: string }>>(
    "SELECT email, password_hash, status FROM users WHERE email = :email LIMIT 1",
    { email },
  );
  const record = rows[0];
  if (!record || record.status !== "ACTIVE" || !(await verifyPassword(password, record.password_hash))) {
    response.status(401).json({ error: "INVALID_CREDENTIALS", message: "The email or password is incorrect." });
    return;
  }
  await createSession(email, response);
  response.json({ user: await findUserByEmail(email) });
});
app.post("/api/auth/login", loginRoute);
app.post("/api/login", loginRoute);

const meRoute = asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  response.json({ user });
});
app.get("/api/auth/me", meRoute);
app.get("/api/me", meRoute);

const logoutRoute = asyncRoute(async (request, response) => {
  await clearSession(request, response);
  response.json({ ok: true });
});
app.post("/api/auth/logout", logoutRoute);
app.post("/api/logout", logoutRoute);

app.get("/api/dashboard", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonRows = await query<Array<{ id: number; name: string; status: string; matchday_count: number; current_matchday: number }>>("SELECT id, name, status, matchday_count, current_matchday FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0] || null;
  const teams = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string }>>("SELECT id, name, short_code, manager_name, accent FROM teams ORDER BY name");
  const users = await query<Array<{ email: string; display_name: string; role: string; status: string; team_id: number | null }>>(
    `SELECT u.email, u.display_name, u.role, u.status, tm.team_id
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
      ORDER BY u.display_name`,
  );
  const params: Record<string, unknown> = { seasonId: season?.id ?? 0 };
  const teamFilter = user.role === "player" && user.teamId ? "AND (m.home_team_id = :teamId OR m.away_team_id = :teamId)" : "";
  if (user.role === "player" && user.teamId) params.teamId = user.teamId;
  const matches = season ? await query<Array<Record<string, unknown>>>(
    `SELECT m.id, m.matchday, m.kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`, params,
  ) : [];
  const matchIds = matches.map((match) => Number(match.id));
  const goals = matchIds.length ? await query<Array<Record<string, unknown>>>(
    `SELECT g.id, g.match_id, g.team_id, g.player_email, g.scorer_name, g.minute
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE m.season_id = :seasonId ORDER BY g.minute`, { seasonId: season?.id ?? 0 },
  ) : [];
  const confirmedMatches = season ? await query<Array<{ home_team_id: number; away_team_id: number; home_score: number; away_score: number }>>(
    "SELECT home_team_id, away_team_id, home_score, away_score FROM matches WHERE season_id = :seasonId AND status = 'CONFIRMED'",
    { seasonId: season.id },
  ) : [];
  const stats = await query<Array<{ player_email: string | null; scorer_name: string; team_id: number; team_name: string; goals: number }>>(
    `SELECT g.player_email, g.scorer_name, g.team_id, t.name AS team_name, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id JOIN teams t ON t.id = g.team_id
      WHERE m.status = 'CONFIRMED'
      GROUP BY g.player_email, g.scorer_name, g.team_id, t.name
      ORDER BY goals DESC, g.scorer_name`,
  );
  response.json({
    season,
    teams,
    users,
    matches,
    goals,
    standings: calculateStandings(teams.map((team) => ({ id: Number(team.id), name: team.name, shortCode: team.short_code })), confirmedMatches.map((match) => ({ homeTeamId: Number(match.home_team_id), awayTeamId: Number(match.away_team_id), homeScore: Number(match.home_score), awayScore: Number(match.away_score) }))),
    stats,
  });
}));

app.get("/api/teams", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const rows = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string; member_count: number }>>(
    `SELECT t.id, t.name, t.short_code, t.manager_name, t.accent, COUNT(tm.user_email) AS member_count
       FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id
      GROUP BY t.id ORDER BY t.name`,
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
  const result = await query<{ insertId: number } & Record<string, never>>(
    "INSERT INTO teams (name, short_code, manager_name, accent, created_at) VALUES (:name, :shortCode, :managerName, :accent, :createdAt)",
    { name, shortCode, managerName, accent, createdAt: now },
  );
  response.status(201).json({ id: (result as unknown as { insertId: number }).insertId });
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
      [email, displayName, passwordHash, role, now, now],
    );
    if (teamId && role === "player") {
      await connection.execute(
        "INSERT INTO team_memberships (user_email, team_id, membership_role, created_at) VALUES (?, ?, 'PLAYER', ?)",
        [email, teamId, now],
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'CREATE_USER', 'user', ?, JSON_OBJECT('role', ?), ?)`,
      [actor.email, email, role, now],
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
  const result = await query<{ insertId: number } & Record<string, never>>(
    "INSERT INTO seasons (name, status, created_at, updated_at) VALUES (:name, 'DRAFT', :createdAt, :updatedAt)",
    { name, createdAt: now, updatedAt: now },
  );
  response.status(201).json({ id: (result as unknown as { insertId: number }).insertId });
}));

app.post("/api/admin/seasons/:seasonId/schedule", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const teamRows = await query<Array<{ id: number }>>("SELECT id FROM teams ORDER BY id");
  const teamIds = teamRows.map((team) => Number(team.id));
  const fixtures = generateRoundRobin(teamIds);
  const now = Date.now();
  await withTransaction(async (connection) => {
    const [existing] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    const existingRows = existing as Array<{ count: number }>;
    if (Number(existingRows[0]?.count || 0) > 0) throw new Error("This season already has fixtures. Create a new season before generating another schedule.");
    for (const fixture of fixtures) {
      await connection.execute(
        `INSERT INTO matches (season_id, matchday, home_team_id, away_team_id, kickoff_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)`,
        [seasonId, fixture.matchday, fixture.homeTeamId, fixture.awayTeamId, fixture.kickoffAt, now, now],
      );
    }
    await connection.execute("UPDATE seasons SET status = 'ACTIVE', matchday_count = ?, current_matchday = 1, updated_at = ? WHERE id = ?", [Math.max(...fixtures.map((fixture) => fixture.matchday)), now, seasonId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'GENERATE_SCHEDULE', 'season', ?, JSON_OBJECT('fixtures', ?), ?)`,
      [user.email, String(seasonId), fixtures.length, now],
    );
  });
  assertScheduleIsCompatible(teamIds, fixtures);
  response.status(201).json({ seasonId, fixturesCreated: fixtures.length, matchdays: Math.max(...fixtures.map((fixture) => fixture.matchday)) });
}));

app.get("/api/seasons/:seasonId/matches", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const params: Record<string, unknown> = { seasonId };
  const teamFilter = user.role === "player" && user.teamId ? "AND (m.home_team_id = :teamId OR m.away_team_id = :teamId)" : "";
  if (user.role === "player" && user.teamId) params.teamId = user.teamId;
  const matches = await query<Array<Record<string, unknown>>>(
    `SELECT m.id, m.season_id, m.matchday, m.kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`,
    params,
  );
  response.json({ matches });
}));

app.get("/api/seasons/:seasonId/standings", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const teams = await query<Array<{ id: number; name: string; short_code: string }>>("SELECT id, name, short_code FROM teams ORDER BY name");
  const matches = await query<Array<{ home_team_id: number; away_team_id: number; home_score: number; away_score: number }>>(
    "SELECT home_team_id, away_team_id, home_score, away_score FROM matches WHERE season_id = :seasonId AND status = 'CONFIRMED'",
    { seasonId },
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
  const matchRows = await query<Array<{ home_team_id: number; away_team_id: number; status: string; submitted_by_email: string | null }>>(
    "SELECT home_team_id, away_team_id, status, submitted_by_email FROM matches WHERE id = :matchId LIMIT 1",
    { matchId },
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
      [homeScore, awayScore, user.email, now, now, matchId],
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
        [matchId, teamId, typeof goal.playerEmail === "string" ? goal.playerEmail.trim().toLowerCase() : null, scorerName, minute, now],
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'SUBMIT_RESULT', 'match', ?, JSON_OBJECT('homeScore', ?, 'awayScore', ?), ?)`,
      [user.email, String(matchId), homeScore, awayScore, now],
    );
  });
  response.status(201).json({ matchId, status: "PENDING" });
}));

app.post("/api/matches/:matchId/confirm", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const matchId = Number(request.params.matchId);
  const now = Date.now();
  const result = await query<{ affectedRows: number } & Record<string, never>>(
    `UPDATE matches SET status = 'CONFIRMED', confirmed_by_email = :email, confirmed_at = :now, updated_at = :now
      WHERE id = :matchId AND status = 'PENDING' AND home_score IS NOT NULL AND away_score IS NOT NULL`,
    { email: user.email, now, matchId },
  );
  const affectedRows = (result as unknown as { affectedRows: number }).affectedRows;
  if (!affectedRows) {
    response.status(409).json({ error: "NOT_PENDING", message: "Only a complete pending result can be confirmed." });
    return;
  }
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:email, 'CONFIRM_RESULT', 'match', :matchId, JSON_OBJECT(), :now)`,
    { email: user.email, matchId: String(matchId), now },
  );
  response.json({ matchId, status: "CONFIRMED" });
}));

app.get("/api/stats/players", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const rows = await query<Array<{ player_email: string | null; scorer_name: string; team_id: number; team_name: string; goals: number }>>(
    `SELECT g.player_email, g.scorer_name, g.team_id, t.name AS team_name, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id JOIN teams t ON t.id = g.team_id
      WHERE m.status = 'CONFIRMED'
      GROUP BY g.player_email, g.scorer_name, g.team_id, t.name
      ORDER BY goals DESC, g.scorer_name`,
  );
  response.json({ players: rows });
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected server error." });
});

export function createApp() {
  return app;
}

export function createHttpServer() {
  return createServer(app);
}

export default app;
