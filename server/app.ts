import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { clearSession, createSession, findUserByEmail, getCurrentUser, hashPassword, verifyPassword, type CurrentUser } from "./auth";
import { databaseHealth, isDatabaseConfigured, query, withTransaction } from "./db";
import { assertScheduleIsCompatible, calculateStandings, generateRoundRobin } from "./league-service";

const app = express();
app.use(express.json({ limit: "1mb" }));

class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

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

const registerRoute = asyncRoute(async (request, response) => {
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
  const existingTeam = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) OR UPPER(short_code) = UPPER(:shortCode) LIMIT 1", { name: teamName, shortCode });
  if (existingTeam[0]) {
    response.status(409).json({ error: "TEAM_IN_USE", message: "That team name or short code is already in the league." });
    return;
  }
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  let teamId = 0;
  await withTransaction(async (connection) => {
    const [teamResult] = await connection.execute(
      `INSERT INTO teams (name, short_code, manager_name, accent, status, created_by_email, created_at)
       VALUES (?, ?, ?, '#8B1E3F', 'PENDING', ?, ?)`,
      [teamName, shortCode, displayName, email, now],
    );
    teamId = Number((teamResult as { insertId: number }).insertId);
    await connection.execute(
      `INSERT INTO users (email, display_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'player', 'ACTIVE', ?, ?)`,
      [email, displayName, passwordHash, now, now],
    );
    await connection.execute(
      "INSERT INTO team_memberships (user_email, team_id, membership_role, created_at) VALUES (?, ?, 'CAPTAIN', ?)",
      [email, teamId, now],
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'PLAYER_REGISTERED', 'team', ?, JSON_OBJECT('email', ?, 'team', ?, 'status', 'PENDING'), ?)`,
      [email, String(teamId), email, teamName, now],
    );
  });
  await createSession(email, response);
  response.status(201).json({ user: await findUserByEmail(email), team: { id: teamId, name: teamName, shortCode, status: "PENDING" } });
});
app.post("/api/auth/register", registerRoute);
app.post("/api/register", registerRoute);

app.get("/api/dashboard", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  const seasonRows = await query<Array<{ id: number; name: string; status: string; matchday_count: number; current_matchday: number }>>("SELECT id, name, status, matchday_count, current_matchday FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0] || null;
  const teams = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string; status: string; created_by_email: string | null }>>("SELECT id, name, short_code, manager_name, accent, status, created_by_email FROM teams ORDER BY name");
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
    `SELECT m.id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.rescheduled_at, m.reschedule_reason,
            m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.submitted_at, m.confirmed_by_email
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
  const rows = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string; status: string; created_by_email: string | null; member_count: number }>>(
    `SELECT t.id, t.name, t.short_code, t.manager_name, t.accent, t.status, t.created_by_email, COUNT(tm.user_email) AS member_count
       FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id
      GROUP BY t.id ORDER BY t.name`,
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
  const scorers = await query<Array<{ name: string; email: string | null; goals: number }>>(
    `SELECT g.scorer_name AS name, g.player_email AS email, COUNT(*) AS goals
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE g.team_id = :teamId AND m.status IN ('PENDING', 'CONFIRMED', 'DISPUTED')
      GROUP BY g.player_email, g.scorer_name
      ORDER BY goals DESC, name ASC`,
    { teamId },
  );
  response.json({ scorers });
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
    "INSERT INTO teams (name, short_code, manager_name, accent, status, created_by_email, approved_by_email, approved_at, created_at) VALUES (:name, :shortCode, :managerName, :accent, 'APPROVED', :createdBy, :approvedBy, :approvedAt, :createdAt)",
    { name, shortCode, managerName, accent, createdBy: user.email, approvedBy: user.email, approvedAt: now, createdAt: now },
  );
  response.status(201).json({ id: (result as unknown as { insertId: number }).insertId, status: "APPROVED" });
}));

app.delete("/api/admin/teams/:teamId", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const teamId = Number(request.params.teamId);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    response.status(400).json({ error: "INVALID_TEAM_ID", message: "That team identifier is invalid." });
    return;
  }
  const teamRows = await query<Array<{ id: number; name: string; status: string }>>("SELECT id, name, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  const team = teamRows[0];
  if (!team) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const fixtureRows = await query<Array<{ count: number }>>("SELECT COUNT(*) AS count FROM matches WHERE home_team_id = :teamId OR away_team_id = :teamId", { teamId });
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
      [user.email, String(teamId), team.name, team.status, now],
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
  const existing = await query<Array<{ id: number; status: string }>>("SELECT id, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
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
      [decision, user.email, now, teamId],
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, ?, 'team', ?, JSON_OBJECT('decision', ?), ?)`,
      [user.email, decision === "APPROVED" ? "TEAM_APPROVED" : "TEAM_REJECTED", String(teamId), decision, now],
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

async function createSeasonSchedule(seasonId: number, actorEmail: string) {
  if (!Number.isInteger(seasonId) || seasonId <= 0) throw new ApiError(400, "INVALID_SEASON_ID", "That season identifier is invalid.");
  const seasonRows = await query<Array<{ id: number; name: string }>>("SELECT id, name FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId });
  if (!seasonRows[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "Create the league season before starting the tournament.");
  const teamRows = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE status = 'APPROVED' ORDER BY id");
  const teamIds = teamRows.map((team) => Number(team.id));
  if (teamIds.length < 2) throw new ApiError(400, "NOT_ENOUGH_APPROVED_TEAMS", "Approve at least two teams before starting the tournament.");
  const fixtures = generateRoundRobin(teamIds);
  const now = Date.now();
  await withTransaction(async (connection) => {
    const [existing] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    const existingRows = existing as Array<{ count: number }>;
    if (Number(existingRows[0]?.count || 0) > 0) throw new ApiError(409, "SCHEDULE_EXISTS", "This season already has fixtures. Use the existing tournament instead of starting it again.");
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
      [actorEmail, String(seasonId), fixtures.length, now],
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
    const seasons = seasonResult as Array<{ id: number; name: string }>;
    if (!seasons[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "That tournament season no longer exists.");
    const [countResult] = await connection.query("SELECT COUNT(*) AS count FROM matches WHERE season_id = ?", [seasonId]);
    deletedMatches = Number((countResult as Array<{ count: number }>)[0]?.count || 0);
    await connection.execute("DELETE FROM matches WHERE season_id = ?", [seasonId]);
    await connection.execute("UPDATE seasons SET status = 'DRAFT', matchday_count = 0, current_matchday = 0, updated_at = ? WHERE id = ?", [now, seasonId]);
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'RESET_TOURNAMENT', 'season', ?, JSON_OBJECT('deletedMatches', ?), ?)`,
      [user.email, String(seasonId), deletedMatches, now],
    );
  });
  response.json({ seasonId, deletedMatches, status: "DRAFT" });
}));

app.post("/api/admin/seasons/:seasonId/start", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  const existing = await query<Array<{ count: number }>>("SELECT COUNT(*) AS count FROM matches WHERE season_id = :seasonId", { seasonId });
  let result: { seasonId: number; fixturesCreated: number; matchdays: number; matchesPerDay: number; matchesPerTeam: number };
  if (Number(existing[0]?.count || 0) === 0) {
    result = await createSeasonSchedule(seasonId, user.email);
  } else {
    const seasonRows = await query<Array<{ id: number; status: string; matchday_count: number; current_matchday: number }>>("SELECT id, status, matchday_count, current_matchday FROM seasons WHERE id = :seasonId LIMIT 1", { seasonId });
    if (!seasonRows[0]) throw new ApiError(404, "SEASON_NOT_FOUND", "That season no longer exists.");
    const teamRows = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE status = 'APPROVED' ORDER BY id");
    const now = Date.now();
    await withTransaction(async (connection) => {
      await connection.execute("UPDATE seasons SET status = 'ACTIVE', updated_at = ? WHERE id = ?", [now, seasonId]);
      await connection.execute(
        `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
         VALUES (?, 'START_TOURNAMENT', 'season', ?, JSON_OBJECT('existingFixtures', ?), ?)`,
        [user.email, String(seasonId), Number(existing[0]?.count || 0), now],
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
  const rows = await query<Array<{ home_team_id: number; away_team_id: number; status: string; kickoff_at: number; original_kickoff_at: number | null }>>("SELECT home_team_id, away_team_id, status, kickoff_at, original_kickoff_at FROM matches WHERE id = :matchId LIMIT 1", { matchId });
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
    { kickoffAt, rescheduledAt: now, reason, rescheduledBy: user.email, updatedAt: now, matchId },
  );
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:actor, 'MATCH_RESCHEDULED', 'match', :entityId, JSON_OBJECT('kickoffAt', :kickoffAt, 'reason', :reason), :createdAt)`,
    { actor: user.email, entityId: String(matchId), kickoffAt, reason, createdAt: now },
  );
  response.json({ matchId, status: "POSTPONED", kickoffAt, reason });
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
  const matchRows = await query<Array<{ home_team_id: number; away_team_id: number; kickoff_at: number; status: string; submitted_by_email: string | null }>>(
    "SELECT home_team_id, away_team_id, kickoff_at, status, submitted_by_email FROM matches WHERE id = :matchId LIMIT 1",
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
  const kickoffDate = new Date(Number(match.kickoff_at)).toISOString().slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  if (todayDate < kickoffDate) {
    response.status(425).json({ error: "MATCH_NOT_OPEN", message: `This fixture opens on ${kickoffDate}. Results cannot be entered before the scheduled date.` });
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
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  response.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected server error." });
});

export function createApp() {
  return app;
}

export function createHttpServer() {
  return createServer(app);
}

export default app;
