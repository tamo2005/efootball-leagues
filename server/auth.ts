import { promisify } from "node:util";
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { query, withTransaction } from "./db";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "eleague_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

type UserRow = {
  email: string;
  display_name: string;
  role: "admin" | "player";
  status: "ACTIVE" | "INVITED" | "DISABLED";
  team_id: number | null;
  team_name: string | null;
  short_code: string | null;
};

export type CurrentUser = {
  email: string;
  displayName: string;
  role: "admin" | "player";
  status: UserRow["status"];
  teamId: number | null;
  teamName: string | null;
  shortCode: string | null;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]),
  );
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [, salt, expectedHex] = encoded.split("$");
  if (!salt || !expectedHex) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export async function findUserByEmail(email: string) {
  const rows = await query<UserRow[]>(
    `SELECT u.email, u.display_name, u.role, u.status,
            tm.team_id, t.name AS team_name, t.short_code
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_email = u.email
       LEFT JOIN teams t ON t.id = tm.team_id
      WHERE u.email = :email
      LIMIT 1`,
    { email: email.trim().toLowerCase() },
  );
  return rows[0] ? toCurrentUser(rows[0]) : null;
}

function toCurrentUser(row: UserRow): CurrentUser {
  return {
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    teamId: row.team_id,
    teamName: row.team_name,
    shortCode: row.short_code,
  };
}

export async function createSession(email: string, response: Response) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await query(
    "INSERT INTO sessions (token_hash, user_email, expires_at, created_at) VALUES (:tokenHash, :email, :expiresAt, :createdAt)",
    { tokenHash: tokenHash(token), email, expiresAt, createdAt: now },
  );
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export async function clearSession(request: Request, response: Response) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) {
    await query("DELETE FROM sessions WHERE token_hash = :tokenHash", { tokenHash: tokenHash(token) });
  }
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}

export async function getCurrentUser(request: Request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const rows = await query<(UserRow & { expires_at: number })[]>(
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
    { tokenHash: tokenHash(token), now: Date.now() },
  );
  return rows[0] ? toCurrentUser(rows[0]) : null;
}

export async function bootstrapAdmin(email: string, displayName: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) return existing;
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO users (email, display_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'ACTIVE', ?, ?)`,
      [normalizedEmail, displayName.trim(), passwordHash, now, now],
    );
    await connection.execute(
      `INSERT INTO audit_events (actor_email, event_type, entity_type, entity_id, payload, created_at)
       VALUES (?, 'BOOTSTRAP_ADMIN', 'user', ?, JSON_OBJECT('role', 'admin'), ?)`,
      [normalizedEmail, normalizedEmail, now],
    );
  });
  return findUserByEmail(normalizedEmail);
}
