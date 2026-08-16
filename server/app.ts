import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { clearSession, createSession, findUserByEmail, getCurrentUser, hashPassword, verifyPassword, type CurrentUser } from "./auth";
import { databaseHealth, isDatabaseConfigured, query, withTransaction } from "./db";
import { assertScheduleIsCompatible, calculateStandings, generateRoundRobin } from "./league-service";
import { archiveSeasonSnapshot, ensureNewsTables, getArchiveRows, getNewsRows, refreshLeagueNews } from "./news-service";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const GOOGLE_STATE_COOKIE = "eleague_google_state";
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
const LEAGUE_TIME_ZONE = "Asia/Kolkata";

function leagueDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LEAGUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatLeagueDateLabel(dateKey: string) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: LEAGUE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function attachMatchdayDates<T extends Record<string, unknown>>(matches: T[]) {
  const anchors = new Map<number, number>();
  for (const match of matches) {
    const matchday = Number(match.matchday);
    const hasOriginal = match.original_kickoff_at !== null && match.original_kickoff_at !== undefined;
    const candidate = Number(match.kickoff_at);
    if (hasOriginal || !Number.isInteger(matchday) || !Number.isFinite(candidate)) continue;
    const current = anchors.get(matchday);
    if (current === undefined || candidate < current) anchors.set(matchday, candidate);
  }
  return matches.map((match) => {
    const matchday = Number(match.matchday);
    const hasOriginal = match.original_kickoff_at !== null && match.original_kickoff_at !== undefined;
    const kickoff = Number(match.kickoff_at);
    const candidate = hasOriginal ? kickoff : anchors.get(matchday) ?? kickoff;
    return { ...match, match_date: Number.isFinite(candidate) ? leagueDateKey(candidate) : "" };
  });
}

function cookieValue(request: Request, name: string) {
  const cookies = Object.fromEntries((request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
  return cookies[name] || null;
}

function googleConfig(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `${request.protocol}://${request.get("host")}/api/auth/google/callback`;
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}

function oauthErrorRedirect(response: Response, code: string) {
  response.redirect(`/?google=error&reason=${encodeURIComponent(code)}`);
}

class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function duplicateTeamError(error: unknown) {
  const candidate = error as { code?: string; message?: string } | null;
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

const HUGGING_FACE_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
const DEFAULT_HUGGING_FACE_MODEL = "Qwen/Qwen3-4B-Instruct-2507";
const MANUAL_FOOTBALLER_NAME_FALLBACKS: Record<string, string> = {
  "gulit": "Ruud Gullit",
  "gullit": "Ruud Gullit",
  "del piero": "Alessandro Del Piero",
  "van basten": "Marco van Basten",
  "luis suarez": "Luis Suárez",
  "zlatan": "Zlatan Ibrahimović",
  "zlatan ibrahimovic": "Zlatan Ibrahimović",
  "zlatan ibrahimović": "Zlatan Ibrahimović",
  "messi": "Lionel Messi",
  "neymar": "Neymar da Silva Santos Júnior",
  "pele": "Edson Arantes do Nascimento",
  "pelé": "Edson Arantes do Nascimento",
  "maradona": "Diego Armando Maradona",
  "neuer": "Manuel Neuer",
  "gerrard": "Steven Gerrard",
  "cr7": "Cristiano Ronaldo",
  "cristiano": "Cristiano Ronaldo",
};

type ScorerReviewModelResult = {
  suggestedFullName: string;
  confidence: number;
  reason: string;
  matchedEmail: string | null;
  needsManualReview: boolean;
};

function huggingFaceConfig() {
  const token = process.env.HF_TOKEN?.trim();
  if (!token) return null;
  return { token, model: process.env.HF_MODEL?.trim() || DEFAULT_HUGGING_FACE_MODEL };
}

let scorerReviewTableReady: Promise<void> | null = null;
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
    `).then(() => undefined);
  }
  await scorerReviewTableReady;
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function clipText(value: string, length: number) {
  return value.trim().slice(0, length);
}

function modelContent(payload: unknown) {
  const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((part) => typeof part === "string" ? part : String((part as { text?: unknown }).text || "")).join("");
  return "";
}

function parseScorerReview(raw: string, submittedName: string, knownPlayers: Array<{ email: string; displayName: string }>): ScorerReviewModelResult {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error("The name-review model did not return JSON.");
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
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
    needsManualReview: parsed.needsManualReview !== false || !matchedPlayer,
  };
}

async function processScorerNameReview(reviewId: number) {
  const reviewRows = await query<Array<{ id: number; match_id: number; goal_id: number | null; team_id: number; submitted_name: string; team_name: string }>>(
    `SELECT r.id, r.match_id, r.goal_id, r.team_id, r.submitted_name, t.name AS team_name
       FROM scorer_name_reviews r JOIN teams t ON t.id = r.team_id
      WHERE r.id = :reviewId LIMIT 1`,
    { reviewId },
  );
  const review = reviewRows[0];
  if (!review) return { reviewId, status: "MISSING" as const };
  const knownPlayers = await query<Array<{ email: string; display_name: string }>>(
    `SELECT u.email, u.display_name
       FROM users u JOIN team_memberships tm ON tm.user_email = u.email
      WHERE tm.team_id = :teamId AND u.status = 'ACTIVE'
      ORDER BY u.display_name`,
    { teamId: review.team_id },
  );
  const previousNames = await query<Array<{ scorer_name: string }>>(
    `SELECT DISTINCT g.scorer_name
       FROM goals g JOIN matches m ON m.id = g.match_id
      WHERE g.team_id = :teamId AND g.id <> COALESCE(:goalId, 0)
      ORDER BY g.scorer_name LIMIT 100`,
    { teamId: review.team_id, goalId: review.goal_id || 0 },
  );
  const config = huggingFaceConfig();
  if (!config) {
    await query(
      `UPDATE scorer_name_reviews SET status = 'FAILED', error_message = :message, updated_at = :now WHERE id = :reviewId`,
      { reviewId, message: "Hugging Face is not configured yet. Add HF_TOKEN in Vercel to analyze names.", now: Date.now() },
    );
    return { reviewId, status: "FAILED" as const };
  }
  const playerContext = knownPlayers.map((player) => `${player.display_name} <${player.email}>`).join("\\n") || "No registered players yet.";
  const previousContext = previousNames.map((item) => item.scorer_name).join(", ") || "No previous scorer names yet.";
  const prompt = [
    "You normalize eFootball scorer names for an administrator. Do not invent a real person or silently approve anything.",
    "Correct spelling, casing, spacing, and common abbreviations only when the supplied context supports it. Prefer an exact registered player from the team roster when one is an obvious match.",
    "Return only one JSON object with exactly these keys: suggestedFullName, confidence, reason, matchedEmail, needsManualReview.",
    "confidence must be a number from 0 to 1. matchedEmail must be null unless the suggestion exactly matches one registered player.",
    "Set needsManualReview to true whenever the correction is uncertain or the name is not an exact registered player.",
    "When the submitted name is a recognizable footballer shorthand or misspelling, return the player’s conventional full name. For example, ‘Gulit’ should be suggested as ‘Ruud Gullit’, ‘Ronaldo’ may be ‘Cristiano Ronaldo’ only when the team context supports it, and ‘Messi’ may be ‘Lionel Messi’ only when the context supports it.",
    "Do not invent a footballer. If several real players could match, keep the submitted name as the suggestion and set needsManualReview to true.",
    `Team: ${review.team_name}`,
    `Submitted scorer name: ${review.submitted_name}`,
    `Registered team players:\\n${playerContext}`,
    `Previous scorer names for this team: ${previousContext}`,
  ].join("\\n\\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const modelResponse = await fetch(HUGGING_FACE_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: "You are a careful name-normalization assistant. Return valid JSON only." }, { role: "user", content: prompt }], temperature: 0, max_tokens: 220 }),
      signal: controller.signal,
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
          model: `${config.model} · manual fallback`,
          now: Date.now(),
        },
      );
      return { reviewId, status: "PENDING" as const };
    }
    if (!modelResponse.ok) throw new Error(`Hugging Face returned HTTP ${modelResponse.status}.`);
    const result = parseScorerReview(modelContent(payload), review.submitted_name, knownPlayers.map((player) => ({ email: player.email, displayName: player.display_name })));
    await query(
      `UPDATE scorer_name_reviews
          SET suggested_name = :suggestedName, confidence = :confidence, reason = :reason,
              matched_email = :matchedEmail, status = 'PENDING', model = :model,
              error_message = NULL, updated_at = :now
        WHERE id = :reviewId`,
      { reviewId, suggestedName: result.suggestedFullName, confidence: result.confidence, reason: result.reason, matchedEmail: result.matchedEmail, model: config.model, now: Date.now() },
    );
    return { reviewId, status: "PENDING" as const };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Hugging Face analysis timed out; retry this name." : error instanceof Error ? error.message : "Hugging Face name review failed.";
    await query(
      `UPDATE scorer_name_reviews SET status = 'FAILED', model = :model, error_message = :message, updated_at = :now WHERE id = :reviewId`,
      { reviewId, model: config.model, message: clipText(message, 255), now: Date.now() },
    );
    return { reviewId, status: "FAILED" as const };
  } finally {
    clearTimeout(timeout);
  }
}

async function processScorerNameReviews(reviewIds: number[]) {
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
    { now },
  );
  const fallbackEntries = Object.entries(MANUAL_FOOTBALLER_NAME_FALLBACKS);
  const fallbackCase = fallbackEntries.map(([submittedName, suggestedName]) => `WHEN '${submittedName.replace(/'/g, "''")}' THEN '${suggestedName.replace(/'/g, "''")}'`).join(" ");
  const fallbackNames = fallbackEntries.map(([submittedName]) => `'${submittedName.replace(/'/g, "''")}'`).join(", ");
  await query(
    `UPDATE scorer_name_reviews
        SET suggested_name = CASE LOWER(TRIM(submitted_name)) ${fallbackCase} END,
            confidence = 0.85,
            reason = CONCAT('Conservative local alias normalization from “', submitted_name, '”. Admin approval is still required.'),
            model = 'local-conservative-fallback', error_message = NULL, updated_at = :now
      WHERE status = 'PENDING'
        AND LOWER(TRIM(submitted_name)) IN (${fallbackNames})
        AND COALESCE(suggested_name, '') <> CASE LOWER(TRIM(submitted_name)) ${fallbackCase} END`,
    { now },
  );
}

async function scorerReviewRows(status?: string) {
  const statusFilter = status === "APPROVED" || status === "REJECTED" || status === "FAILED" || status === "PENDING" ? status : null;
  return query<Array<Record<string, unknown>>>(
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
    { status: statusFilter },
  );
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

app.get("/api/auth/google", asyncRoute(async (request, response) => {
  const config = googleConfig(request);
  if (!config) {
    oauthErrorRedirect(response, "Google sign-in is not configured yet.");
    return;
  }
  const state = randomBytes(32).toString("base64url");
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
  response.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: GOOGLE_STATE_TTL_MS,
    path: "/",
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
  if (!state || !storedState || state.length !== storedState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))) {
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
  const existingTeamName = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) LIMIT 1", { name: teamName });
  const existingTeamCode = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) LIMIT 1", { shortCode });
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
  const seasonRows = await query<Array<{ id: number; status: string }>>("SELECT id, status FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
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
  const seasonRows = await query<Array<{ id: number; status: string }>>("SELECT id, status FROM seasons WHERE status IN ('ACTIVE', 'COMPLETED') ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  if (!seasonRows[0]) {
    response.json({ skipped: true, reason: "NO_SEASON" });
    return;
  }
  const seasonId = Number(seasonRows[0].id);
  // The upsert is intentionally repeated once per day: a result may be confirmed
  // after an earlier manual refresh on the same IST date.
  const result = await refreshLeagueNews(seasonId);
  response.json({ ...result, seasonId, storyDate: leagueDateKey() });
}));

app.post("/api/admin/seasons/:seasonId/complete", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  const seasonId = Number(request.params.seasonId);
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    response.status(400).json({ error: "INVALID_SEASON_ID", message: "That season identifier is invalid." });
    return;
  }
  const openRows = await query<Array<{ count: number }>>("SELECT COUNT(*) AS count FROM matches WHERE season_id = :seasonId AND status <> 'CONFIRMED'", { seasonId });
  if (Number(openRows[0]?.count || 0) > 0) {
    response.status(409).json({ error: "SEASON_NOT_FINISHED", message: "Every fixture must be officially confirmed before archiving the season." });
    return;
  }
  const result = await archiveSeasonSnapshot(seasonId);
  await query(`INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
    VALUES (:email, 'ARCHIVE_SEASON', 'season', :seasonId, JSON_OBJECT('archived', :archived), :now)`, { email: user.email, seasonId: String(seasonId), archived: result.archived ? 1 : 0, now: Date.now() });
  response.json(result);
}));

type PlayerRegistryRow = {
  team_id: number;
  team_name: string;
  short_code: string;
  accent: string;
  scorer_name: string;
  player_email: string | null;
  total_goals: number;
  official_goals: number;
};

async function playerRegistryRows() {
  return query<PlayerRegistryRow[]>(
    `SELECT g.team_id, t.name AS team_name, t.short_code, t.accent,
            g.scorer_name, g.player_email,
            COUNT(*) AS total_goals,
            SUM(CASE WHEN m.status = 'CONFIRMED' THEN 1 ELSE 0 END) AS official_goals
       FROM goals g
       JOIN teams t ON t.id = g.team_id
       JOIN matches m ON m.id = g.match_id
      GROUP BY g.team_id, t.name, t.short_code, t.accent, g.scorer_name, g.player_email
      ORDER BY t.name, official_goals DESC, total_goals DESC, g.scorer_name`,
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
  const teamRows = await query<Array<{ id: number; name: string }>>("SELECT id, name FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  if (!teamRows[0]) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const matchFilter = playerEmail ? "AND g.player_email = :playerEmail" : "AND (g.player_email IS NULL OR g.player_email = '')";
  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM goals g
      WHERE g.team_id = :teamId AND g.scorer_name = :oldName ${matchFilter}`,
    { teamId, oldName, playerEmail },
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
      namedPlaceholders: true,
    }, { teamId, oldName, newName, playerEmail, now } as any);
    await connection.query({
      sql: `UPDATE goals SET scorer_name = :newName
              WHERE team_id = :teamId AND scorer_name = :oldName ${playerEmail ? "AND player_email = :playerEmail" : "AND (player_email IS NULL OR player_email = '')"}`,
      namedPlaceholders: true,
    }, { teamId, oldName, newName, playerEmail } as any);
    await connection.query({
      sql: `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
            VALUES (:email, 'RENAME_PLAYER', 'team', :teamId,
                    JSON_OBJECT('oldName', :oldName, 'newName', :newName, 'playerEmail', COALESCE(:playerEmail, ''), 'goalCount', :goalCount), :now)`,
      namedPlaceholders: true,
    }, { email: user.email, teamId: String(teamId), oldName, newName, playerEmail, goalCount, now } as any);
  });
  response.json({ ok: true, updated: goalCount, teamId, oldName, newName, players: await playerRegistryRows() });
}));

app.get("/api/dashboard", asyncRoute(async (request, response) => {
  const user = requireUser(request, response);
  if (!user) return;
  await ensureNewsTables();
  const seasonRows = await query<Array<{ id: number; name: string; status: string; matchday_count: number; current_matchday: number }>>("SELECT id, name, status, matchday_count, current_matchday FROM seasons ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id DESC LIMIT 1");
  const season = seasonRows[0] || null;
  const teams = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string; status: string; created_by_email: string | null }>>("SELECT id, name, short_code, manager_name, accent, status, created_by_email FROM teams ORDER BY name");
  const users = await query<Array<{ email: string; display_name: string; role: string; status: string; team_id: number | null }>>(
    `SELECT u.email, u.display_name, u.role, u.status, tm.team_id
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
      ORDER BY u.display_name`,
  );
  // Fixture visibility is league-wide. Players may browse every fixture; submission and confirmation permissions remain enforced separately.
  const params: Record<string, unknown> = { seasonId: season?.id ?? 0 };
  const rawMatches = season ? await query<Array<Record<string, unknown>>>(
    `SELECT m.id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.rescheduled_at, m.reschedule_reason,
            m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.submitted_at, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId
      ORDER BY m.matchday, m.kickoff_at`, params,
  ) : [];
  const matches = attachMatchdayDates(rawMatches);
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
  const scorerReviews = user.role === "admin" ? (await backfillScorerReviewRecords(), await scorerReviewRows()) : [];
  const news = await getNewsRows();
  const seasonArchives = await getArchiveRows();
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
    seasonArchives,
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

app.get("/api/admin/scorer-reviews", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await backfillScorerReviewRecords();
  response.json({ reviews: await scorerReviewRows(typeof request.query.status === "string" ? request.query.status : undefined) });
}));

app.post("/api/admin/scorer-reviews/analyze", asyncRoute(async (request, response) => {
  const user = requireAdmin(request, response);
  if (!user) return;
  await backfillScorerReviewRecords();
  const requestedIds = Array.isArray(request.body?.reviewIds)
    ? request.body.reviewIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isInteger(value) && value > 0).slice(0, 3)
    : [];
  const rows = requestedIds.length
    ? await query<Array<{ id: number }>>(
        `SELECT id FROM scorer_name_reviews WHERE id IN (${requestedIds.join(",")}) AND status IN ('PENDING', 'FAILED') ORDER BY id`,
      )
    : await query<Array<{ id: number }>>(
        `SELECT id FROM scorer_name_reviews
          WHERE status IN ('PENDING', 'FAILED')
          ORDER BY CASE WHEN suggested_name IS NULL THEN 0 ELSE 1 END, created_at ASC
          LIMIT 3`,
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
  const rows = await query<Array<{ id: number; goal_id: number | null; suggested_name: string | null; matched_email: string | null; status: string }>>(
    "SELECT id, goal_id, suggested_name, matched_email, status FROM scorer_name_reviews WHERE id = :reviewId LIMIT 1",
    { reviewId },
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
      [approvedName, user.email, now, now, reviewId],
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'SCORER_NAME_APPROVED', 'scorer_name_review', ?, JSON_OBJECT('approvedName', ?), ?)`,
      [user.email, String(reviewId), approvedName, now],
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
  const result = await query<{ affectedRows: number } & Record<string, never>>(
    `UPDATE scorer_name_reviews SET status = 'REJECTED', reviewed_by_email = :email, reviewed_at = :now, updated_at = :now
      WHERE id = :reviewId AND status <> 'APPROVED'`,
    { reviewId, email: user.email, now },
  );
  if (!(result as unknown as { affectedRows: number }).affectedRows) {
    response.status(404).json({ error: "REVIEW_NOT_FOUND", message: "That scorer review is already approved or no longer exists." });
    return;
  }
  await query(
    `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
     VALUES (:email, 'SCORER_NAME_REJECTED', 'scorer_name_review', :reviewId, JSON_OBJECT(), :now)`,
    { email: user.email, reviewId: String(reviewId), now },
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
  const existingTeamName = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) LIMIT 1", { name });
  const existingTeamCode = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) LIMIT 1", { shortCode });
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
    const result = await query<{ insertId: number } & Record<string, never>>(
      "INSERT INTO teams (name, short_code, manager_name, accent, status, created_by_email, approved_by_email, approved_at, created_at) VALUES (:name, :shortCode, :managerName, :accent, 'APPROVED', :createdBy, :approvedBy, :approvedAt, :createdAt)",
      { name, shortCode, managerName, accent, createdBy: user.email, approvedBy: user.email, approvedAt: now, createdAt: now },
    );
    response.status(201).json({ id: (result as unknown as { insertId: number }).insertId, status: "APPROVED" });
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
  const teamRows = await query<Array<{ id: number; name: string; short_code: string; manager_name: string; accent: string }>>("SELECT id, name, short_code, manager_name, accent FROM teams WHERE id = :teamId LIMIT 1", { teamId });
  const current = teamRows[0];
  if (!current) {
    response.status(404).json({ error: "TEAM_NOT_FOUND", message: "That team no longer exists." });
    return;
  }
  const existingTeamName = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE LOWER(name) = LOWER(:name) AND id <> :teamId LIMIT 1", { name, teamId });
  const existingTeamCode = await query<Array<{ id: number }>>("SELECT id FROM teams WHERE UPPER(short_code) = UPPER(:shortCode) AND id <> :teamId LIMIT 1", { shortCode, teamId });
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
        [user.email, String(teamId), current.name, name, current.short_code, shortCode, current.manager_name, managerName, current.accent, accent, now],
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

app.patch("/api/admin/users/:email", asyncRoute(async (request, response) => {
  const actor = requireAdmin(request, response);
  if (!actor) return;
  const email = decodeURIComponent(String(request.params.email || "")).trim().toLowerCase();
  const displayName = clipText(String(request.body?.displayName || "").trim(), 120);
  const role = request.body?.role === "admin" ? "admin" : request.body?.role === "player" ? "player" : "";
  const status = ["ACTIVE", "INVITED", "DISABLED"].includes(String(request.body?.status)) ? String(request.body.status) : "";
  const rawTeamId = request.body?.teamId;
  const teamId = rawTeamId === null || rawTeamId === undefined || rawTeamId === "" ? null : Number(rawTeamId);
  if (!email.includes("@") || !displayName || !role || !status || (teamId !== null && (!Number.isInteger(teamId) || teamId <= 0))) {
    response.status(400).json({ error: "INVALID_USER_UPDATE", message: "Provide a display name, valid role, status, and team assignment." });
    return;
  }
  if (email === actor.email && (role !== "admin" || status !== "ACTIVE")) {
    response.status(400).json({ error: "SELF_LOCKOUT_BLOCKED", message: "You cannot remove your own active admin access." });
    return;
  }
  const existingRows = await query<Array<{ email: string; display_name: string; role: string; status: string }>>(
    "SELECT email, display_name, role, status FROM users WHERE email = :email LIMIT 1",
    { email },
  );
  const existing = existingRows[0];
  if (!existing) {
    response.status(404).json({ error: "USER_NOT_FOUND", message: "That player account no longer exists." });
    return;
  }
  if (role === "player" && teamId !== null) {
    const teamRows = await query<Array<{ id: number; status: string }>>("SELECT id, status FROM teams WHERE id = :teamId LIMIT 1", { teamId });
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
      [actor.email, email, displayName, role, status, teamId, now],
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
    const fixturePlaceholders = fixtures.map(() => "(?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)").join(", ");
    const fixtureValues: number[] = [];
    for (const fixture of fixtures) {
      fixtureValues.push(seasonId, fixture.matchday, fixture.homeTeamId, fixture.awayTeamId, fixture.kickoffAt, now, now);
    }
    await connection.execute(
      `INSERT INTO matches (season_id, matchday, home_team_id, away_team_id, kickoff_at, status, created_at, updated_at)
       VALUES ${fixturePlaceholders}`,
      fixtureValues,
    );
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
    `SELECT m.id, m.season_id, m.matchday, m.kickoff_at, m.original_kickoff_at, m.status, m.home_score, m.away_score,
            h.id AS home_team_id, h.name AS home_team_name, h.short_code AS home_short_code,
            a.id AS away_team_id, a.name AS away_team_name, a.short_code AS away_short_code,
            m.submitted_by_email, m.confirmed_by_email
       FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.season_id = :seasonId ${teamFilter}
      ORDER BY m.matchday, m.kickoff_at`,
    params,
  );
  response.json({ matches: attachMatchdayDates(matches) });
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
  const matchRows = await query<Array<{ home_team_id: number; away_team_id: number; season_id: number; matchday: number; kickoff_at: number; matchday_anchor_at: number | null; status: string; submitted_by_email: string | null }>>(
    `SELECT m.home_team_id, m.away_team_id, m.season_id, m.matchday, m.kickoff_at,
            CASE WHEN m.original_kickoff_at IS NOT NULL THEN m.kickoff_at
              ELSE (SELECT MIN(m2.kickoff_at) FROM matches m2 WHERE m2.season_id = m.season_id AND m2.matchday = m.matchday AND m2.original_kickoff_at IS NULL)
            END AS matchday_anchor_at,
            m.status, m.submitted_by_email
       FROM matches m WHERE m.id = :matchId LIMIT 1`,
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
  const kickoffAt = Number(match.kickoff_at);
  const matchdayAnchorAt = Number(match.matchday_anchor_at ?? kickoffAt);
  const scheduledDate = Number.isFinite(matchdayAnchorAt) ? leagueDateKey(matchdayAnchorAt) : "";
  if (!scheduledDate || leagueDateKey() < scheduledDate) {
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
      [homeScore, awayScore, user.email, now, now, matchId],
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
        [matchId, teamId, typeof goal.playerEmail === "string" ? goal.playerEmail.trim().toLowerCase() : null, scorerName, minute, now],
      );
      const goalId = Number((goalResult as { insertId?: number }).insertId || 0);
      await connection.execute(
        `INSERT INTO scorer_name_reviews
          (match_id, goal_id, team_id, submitted_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        [matchId, goalId || null, teamId, scorerName, now, now],
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
