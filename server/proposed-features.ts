import { query } from "./db";

type Row = Record<string, any>;

let featureTablesReady: Promise<void> | null = null;

export async function ensureProposedFeatureTables() {
  if (!featureTablesReady) {
    featureTablesReady = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS league_notifications (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_email VARCHAR(320) NOT NULL,
        notification_type VARCHAR(80) NOT NULL,
        title VARCHAR(180) NOT NULL,
        body TEXT NOT NULL,
        payload_json JSON NULL,
        dedupe_key VARCHAR(220) NULL,
        read_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        INDEX notifications_user_idx (user_email, created_at),
        INDEX notifications_unread_idx (user_email, read_at),
        UNIQUE KEY notifications_dedupe_uq (user_email, dedupe_key),
        CONSTRAINT notifications_user_fk FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
      await query(`CREATE TABLE IF NOT EXISTS match_predictions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        match_id BIGINT UNSIGNED NOT NULL,
        user_email VARCHAR(320) NOT NULL,
        home_score INT NOT NULL,
        away_score INT NOT NULL,
        points INT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY predictions_match_user_uq (match_id, user_email),
        INDEX predictions_user_idx (user_email, updated_at),
        CONSTRAINT predictions_match_fk FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        CONSTRAINT predictions_user_fk FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
      await query(`CREATE TABLE IF NOT EXISTS match_proofs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        match_id BIGINT UNSIGNED NOT NULL,
        uploaded_by_email VARCHAR(320) NOT NULL,
        file_name VARCHAR(180) NOT NULL,
        mime_type VARCHAR(80) NOT NULL,
        file_size INT NOT NULL,
        data_url MEDIUMTEXT NOT NULL,
        status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
        review_note VARCHAR(255) NULL,
        reviewed_by_email VARCHAR(320) NULL,
        reviewed_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        INDEX proofs_match_idx (match_id, created_at),
        CONSTRAINT proofs_match_fk FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        CONSTRAINT proofs_uploader_fk FOREIGN KEY (uploaded_by_email) REFERENCES users(email) ON DELETE CASCADE,
        CONSTRAINT proofs_reviewer_fk FOREIGN KEY (reviewed_by_email) REFERENCES users(email) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
      await query(`CREATE TABLE IF NOT EXISTS matchday_awards (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        season_id BIGINT UNSIGNED NOT NULL,
        matchday INT NOT NULL,
        award_type VARCHAR(40) NOT NULL,
        subject_name VARCHAR(160) NOT NULL,
        team_id BIGINT UNSIGNED NULL,
        citation TEXT NOT NULL,
        created_by_email VARCHAR(320) NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY awards_round_type_uq (season_id, matchday, award_type),
        INDEX awards_season_idx (season_id, matchday),
        CONSTRAINT awards_season_fk FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
        CONSTRAINT awards_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
        CONSTRAINT awards_creator_fk FOREIGN KEY (created_by_email) REFERENCES users(email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
      await query(`CREATE TABLE IF NOT EXISTS discord_settings (
        id TINYINT NOT NULL PRIMARY KEY,
        webhook_url VARCHAR(500) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        label VARCHAR(120) NOT NULL DEFAULT 'League Discord',
        updated_by_email VARCHAR(320) NULL,
        updated_at BIGINT NOT NULL,
        CONSTRAINT discord_settings_user_fk FOREIGN KEY (updated_by_email) REFERENCES users(email) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    })().catch((error) => {
      featureTablesReady = null;
      throw error;
    });
  }
  await featureTablesReady;
}

function parseJson(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

function cleanInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function createLeagueNotification(input: { userEmail: string; type: string; title: string; body: string; payload?: Record<string, unknown>; dedupeKey?: string }) {
  await ensureProposedFeatureTables();
  const now = Date.now();
  await query(
    `INSERT INTO league_notifications (user_email, notification_type, title, body, payload_json, dedupe_key, created_at)
     VALUES (:userEmail, :type, :title, :body, :payload, :dedupeKey, :now)
     ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), payload_json = VALUES(payload_json)`,
    { userEmail: input.userEmail, type: input.type, title: input.title, body: input.body, payload: JSON.stringify(input.payload || {}), dedupeKey: input.dedupeKey || null, now },
  );
}

export async function getNotificationFeed(userEmail: string) {
  await ensureProposedFeatureTables();
  const rows = await query<Row[]>(`SELECT id, notification_type, title, body, payload_json, read_at, created_at
    FROM league_notifications WHERE user_email = :userEmail ORDER BY created_at DESC LIMIT 80`, { userEmail });
  return { notifications: rows.map((row) => ({ id: Number(row.id), type: row.notification_type, title: row.title, body: row.body, payload: parseJson(row.payload_json) || {}, read: row.read_at !== null, createdAt: Number(row.created_at) })), unreadCount: rows.filter((row) => row.read_at === null).length };
}

export async function markNotificationRead(id: number, userEmail: string) {
  await ensureProposedFeatureTables();
  await query("UPDATE league_notifications SET read_at = :now WHERE id = :id AND user_email = :userEmail", { id, userEmail, now: Date.now() });
}

export async function markAllNotificationsRead(userEmail: string) {
  await ensureProposedFeatureTables();
  await query("UPDATE league_notifications SET read_at = :now WHERE user_email = :userEmail AND read_at IS NULL", { userEmail, now: Date.now() });
}

async function matchAccess(matchId: number, userEmail: string) {
  const rows = await query<Row[]>(`SELECT m.id, m.season_id, m.matchday, m.kickoff_at, m.status, m.home_score, m.away_score,
    m.home_team_id, m.away_team_id, h.name home_team_name, h.short_code home_short_code, h.accent home_accent,
    a.name away_team_name, a.short_code away_short_code, a.accent away_accent,
    EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id = m.home_team_id AND tm.user_email = :userEmail) AS is_home_member,
    EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id = m.away_team_id AND tm.user_email = :userEmail) AS is_away_member
    FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id WHERE m.id = :matchId LIMIT 1`, { matchId, userEmail });
  return rows[0] || null;
}

export async function getMatchDetails(matchId: number, userEmail: string, isAdmin: boolean) {
  await ensureProposedFeatureTables();
  const match = await matchAccess(matchId, userEmail);
  if (!match) return null;
  if (!isAdmin && !Number(match.is_home_member) && !Number(match.is_away_member)) return null;
  const [goals, proofs, predictionRows, meetings] = await Promise.all([
    query<Row[]>(`SELECT g.id, g.team_id, g.scorer_name, g.player_email, g.minute, t.name team_name, t.short_code team_short_code
      FROM goals g JOIN teams t ON t.id = g.team_id WHERE g.match_id = :matchId ORDER BY g.minute, g.id`, { matchId }),
    query<Row[]>(`SELECT id, uploaded_by_email, file_name, mime_type, file_size, data_url, status, review_note, created_at, reviewed_at
      FROM match_proofs WHERE match_id = :matchId ORDER BY created_at DESC`, { matchId }),
    query<Row[]>(`SELECT p.user_email, p.home_score, p.away_score, p.points, p.updated_at, u.display_name
      FROM match_predictions p JOIN users u ON u.email = p.user_email WHERE p.match_id = :matchId ORDER BY p.updated_at DESC`, { matchId }),
    query<Row[]>(`SELECT m.id, m.matchday, m.kickoff_at, m.home_score, m.away_score, m.status, h.name home_team_name, a.name away_team_name
      FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.status = 'CONFIRMED' AND ((m.home_team_id = :homeTeam AND m.away_team_id = :awayTeam) OR (m.home_team_id = :awayTeam AND m.away_team_id = :homeTeam))
      ORDER BY m.kickoff_at DESC LIMIT 5`, { homeTeam: Number(match.home_team_id), awayTeam: Number(match.away_team_id) }),
  ]);
  return {
    match: { id: Number(match.id), seasonId: Number(match.season_id), matchday: Number(match.matchday), kickoffAt: Number(match.kickoff_at), status: match.status, homeScore: match.home_score === null ? null : Number(match.home_score), awayScore: match.away_score === null ? null : Number(match.away_score), home: { id: Number(match.home_team_id), name: match.home_team_name, shortCode: match.home_short_code, accent: match.home_accent }, away: { id: Number(match.away_team_id), name: match.away_team_name, shortCode: match.away_short_code, accent: match.away_accent } },
    goals: goals.map((goal) => ({ id: Number(goal.id), teamId: Number(goal.team_id), teamName: goal.team_name, teamShortCode: goal.team_short_code, playerName: goal.scorer_name, playerEmail: goal.player_email, minute: Number(goal.minute) })),
    proofs: proofs.map((proof) => ({ id: Number(proof.id), uploadedByEmail: proof.uploaded_by_email, fileName: proof.file_name, mimeType: proof.mime_type, fileSize: Number(proof.file_size), dataUrl: proof.data_url, status: proof.status, reviewNote: proof.review_note, createdAt: Number(proof.created_at), reviewedAt: proof.reviewed_at === null ? null : Number(proof.reviewed_at) })),
    predictions: predictionRows.map((prediction) => ({ userEmail: prediction.user_email, displayName: prediction.display_name, homeScore: Number(prediction.home_score), awayScore: Number(prediction.away_score), points: prediction.points === null ? null : Number(prediction.points), updatedAt: Number(prediction.updated_at), isMine: prediction.user_email === userEmail })),
    meetings: meetings.map((meeting) => ({ id: Number(meeting.id), matchday: Number(meeting.matchday), kickoffAt: Number(meeting.kickoff_at), homeScore: Number(meeting.home_score), awayScore: Number(meeting.away_score), homeTeamName: meeting.home_team_name, awayTeamName: meeting.away_team_name })),
  };
}

export async function addMatchProof(input: { matchId: number; userEmail: string; fileName: string; mimeType: string; fileSize: number; dataUrl: string }) {
  await ensureProposedFeatureTables();
  const match = await matchAccess(input.matchId, input.userEmail);
  if (!match || !Number(match.is_home_member)) throw new Error("Only an active home-team member can attach match proof.");
  if (match.status === "CONFIRMED") throw new Error("Confirmed matches cannot receive new evidence.");
  const result = await query<Row>(`INSERT INTO match_proofs (match_id, uploaded_by_email, file_name, mime_type, file_size, data_url, created_at)
    VALUES (:matchId, :userEmail, :fileName, :mimeType, :fileSize, :dataUrl, :now)`, { ...input, now: Date.now() });
  return { id: Number(result.insertId || 0) };
}

export async function reviewMatchProof(proofId: number, reviewerEmail: string, status: "APPROVED" | "REJECTED", note: string) {
  await ensureProposedFeatureTables();
  await query(`UPDATE match_proofs SET status = :status, review_note = :note, reviewed_by_email = :reviewerEmail, reviewed_at = :now WHERE id = :proofId`, { proofId, status, note: note.slice(0, 255), reviewerEmail, now: Date.now() });
}

export async function savePrediction(matchId: number, userEmail: string, homeScore: number, awayScore: number) {
  await ensureProposedFeatureTables();
  if (homeScore < 0 || awayScore < 0 || homeScore > 30 || awayScore > 30) throw new Error("Predictions must use scores from 0 to 30.");
  const match = await matchAccess(matchId, userEmail);
  if (!match || (!Number(match.is_home_member) && !Number(match.is_away_member))) throw new Error("Only players in this fixture can predict it.");
  if (match.status !== "SCHEDULED" && match.status !== "POSTPONED") throw new Error("Predictions close when a result is submitted.");
  if (Number(match.kickoff_at) <= Date.now()) throw new Error("Predictions close at kickoff.");
  const now = Date.now();
  await query(`INSERT INTO match_predictions (match_id, user_email, home_score, away_score, created_at, updated_at)
    VALUES (:matchId, :userEmail, :homeScore, :awayScore, :now, :now)
    ON DUPLICATE KEY UPDATE home_score = VALUES(home_score), away_score = VALUES(away_score), updated_at = VALUES(updated_at)`, { matchId, userEmail, homeScore, awayScore, now });
}

export async function getPredictionDashboard(userEmail: string, seasonId?: number) {
  await ensureProposedFeatureTables();
  const seasonFilter = Number.isInteger(seasonId) ? "AND m.season_id = :seasonId" : "";
  const params: Record<string, unknown> = { userEmail };
  if (Number.isInteger(seasonId)) params.seasonId = seasonId;
  const [mine, leaderboard] = await Promise.all([
    query<Row[]>(`SELECT p.match_id, p.home_score, p.away_score, p.points, p.updated_at, m.matchday, m.kickoff_at, m.status, h.name home_team_name, a.name away_team_name
      FROM match_predictions p JOIN matches m ON m.id = p.match_id JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE p.user_email = :userEmail ${seasonFilter} ORDER BY m.kickoff_at DESC LIMIT 100`, params),
    query<Row[]>(`SELECT p.user_email, u.display_name, COALESCE(SUM(p.points), 0) points, COUNT(*) predictions, SUM(p.points IS NOT NULL) scored_predictions
      FROM match_predictions p JOIN users u ON u.email = p.user_email JOIN matches m ON m.id = p.match_id
      WHERE p.points IS NOT NULL ${seasonFilter} GROUP BY p.user_email, u.display_name ORDER BY points DESC, predictions ASC LIMIT 50`, params),
  ]);
  return { mine: mine.map((row) => ({ matchId: Number(row.match_id), matchday: Number(row.matchday), kickoffAt: Number(row.kickoff_at), status: row.status, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name, homeScore: Number(row.home_score), awayScore: Number(row.away_score), points: row.points === null ? null : Number(row.points), updatedAt: Number(row.updated_at) })), leaderboard: leaderboard.map((row, index) => ({ rank: index + 1, email: row.user_email, displayName: row.display_name, points: Number(row.points), predictions: Number(row.predictions), scoredPredictions: Number(row.scored_predictions) })) };
}

export async function scorePredictions(matchId: number, homeScore: number, awayScore: number) {
  await ensureProposedFeatureTables();
  const rows = await query<Row[]>("SELECT id, home_score, away_score FROM match_predictions WHERE match_id = :matchId", { matchId });
  for (const row of rows) {
    const exact = Number(row.home_score) === homeScore && Number(row.away_score) === awayScore;
    const outcome = Math.sign(Number(row.home_score) - Number(row.away_score)) === Math.sign(homeScore - awayScore);
    const points = exact ? 5 : outcome ? 2 : 0;
    await query("UPDATE match_predictions SET points = :points, updated_at = :now WHERE id = :id", { id: row.id, points, now: Date.now() });
  }
}

export async function getAwards(seasonId?: number) {
  await ensureProposedFeatureTables();
  const params: Record<string, unknown> = {};
  const filter = Number.isInteger(seasonId) ? "WHERE a.season_id = :seasonId" : "";
  if (Number.isInteger(seasonId)) params.seasonId = seasonId;
  const rows = await query<Row[]>(`SELECT a.id, a.season_id, a.matchday, a.award_type, a.subject_name, a.team_id, t.name team_name, a.citation, a.created_at
    FROM matchday_awards a LEFT JOIN teams t ON t.id = a.team_id ${filter} ORDER BY a.season_id DESC, a.matchday DESC, a.id DESC LIMIT 100`, params);
  return rows.map((row) => ({ id: Number(row.id), seasonId: Number(row.season_id), matchday: Number(row.matchday), awardType: row.award_type, subjectName: row.subject_name, teamId: row.team_id === null ? null : Number(row.team_id), teamName: row.team_name, citation: row.citation, createdAt: Number(row.created_at) }));
}

export async function createAward(input: { seasonId: number; matchday: number; awardType: string; subjectName: string; teamId?: number | null; citation: string; createdByEmail: string }) {
  await ensureProposedFeatureTables();
  const result = await query<Row>(`INSERT INTO matchday_awards (season_id, matchday, award_type, subject_name, team_id, citation, created_by_email, created_at)
    VALUES (:seasonId, :matchday, :awardType, :subjectName, :teamId, :citation, :createdByEmail, :now)
    ON DUPLICATE KEY UPDATE subject_name = VALUES(subject_name), team_id = VALUES(team_id), citation = VALUES(citation), created_by_email = VALUES(created_by_email)`, { ...input, now: Date.now() });
  return { id: Number(result.insertId || 0) };
}

export async function deleteAward(id: number) { await ensureProposedFeatureTables(); await query("DELETE FROM matchday_awards WHERE id = :id", { id }); }

export async function getHeadToHead(teamA: number, teamB: number) {
  await ensureProposedFeatureTables();
  const rows = await query<Row[]>(`SELECT m.id, m.matchday, m.kickoff_at, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
    h.name home_team_name, a.name away_team_name FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
    WHERE m.status = 'CONFIRMED' AND ((m.home_team_id = :teamA AND m.away_team_id = :teamB) OR (m.home_team_id = :teamB AND m.away_team_id = :teamA)) ORDER BY m.kickoff_at DESC`, { teamA, teamB });
  const meetings = rows.map((row) => ({ id: Number(row.id), matchday: Number(row.matchday), kickoffAt: Number(row.kickoff_at), homeTeamId: Number(row.home_team_id), awayTeamId: Number(row.away_team_id), homeScore: Number(row.home_score), awayScore: Number(row.away_score), homeTeamName: row.home_team_name, awayTeamName: row.away_team_name }));
  const aggregate = { teamA: { wins: 0, draws: 0, goals: 0 }, teamB: { wins: 0, draws: 0, goals: 0 } };
  for (const match of meetings) {
    const aScore = match.homeTeamId === teamA ? match.homeScore : match.awayScore;
    const bScore = match.homeTeamId === teamA ? match.awayScore : match.homeScore;
    aggregate.teamA.goals += aScore; aggregate.teamB.goals += bScore;
    if (aScore > bScore) aggregate.teamA.wins += 1; else if (bScore > aScore) aggregate.teamB.wins += 1; else { aggregate.teamA.draws += 1; aggregate.teamB.draws += 1; }
  }
  return { meetings, aggregate };
}

export async function getCalendarMatches(userEmail: string, seasonId?: number) {
  const params: Record<string, unknown> = { userEmail };
  const filter = Number.isInteger(seasonId) ? "AND m.season_id = :seasonId" : "";
  if (Number.isInteger(seasonId)) params.seasonId = seasonId;
  return query<Row[]>(`SELECT m.id, m.matchday, m.kickoff_at, m.status, h.name home_team_name, a.name away_team_name
    FROM matches m JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
    WHERE (EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id = m.home_team_id AND tm.user_email = :userEmail)
      OR EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id = m.away_team_id AND tm.user_email = :userEmail)) ${filter}
    ORDER BY m.kickoff_at, m.id`, params);
}

export async function getDiscordSettings() {
  await ensureProposedFeatureTables();
  const rows = await query<Row[]>("SELECT id, enabled, label, webhook_url, updated_at FROM discord_settings WHERE id = 1 LIMIT 1");
  const row = rows[0];
  return { enabled: Boolean(row?.enabled), label: row?.label || "League Discord", configured: Boolean(row?.webhook_url), updatedAt: row?.updated_at ? Number(row.updated_at) : null };
}

export async function saveDiscordSettings(input: { webhookUrl: string; enabled: boolean; label: string; email: string }) {
  await ensureProposedFeatureTables();
  await query(`INSERT INTO discord_settings (id, webhook_url, enabled, label, updated_by_email, updated_at)
    VALUES (1, :webhookUrl, :enabled, :label, :email, :now)
    ON DUPLICATE KEY UPDATE webhook_url = VALUES(webhook_url), enabled = VALUES(enabled), label = VALUES(label), updated_by_email = VALUES(updated_by_email), updated_at = VALUES(updated_at)`, { webhookUrl: input.webhookUrl.trim(), enabled: input.enabled ? 1 : 0, label: input.label.trim().slice(0, 120) || "League Discord", email: input.email, now: Date.now() });
}

export async function postToDiscord(content: string, embeds?: Array<Record<string, unknown>>) {
  await ensureProposedFeatureTables();
  const rows = await query<Row[]>("SELECT webhook_url, enabled FROM discord_settings WHERE id = 1 LIMIT 1");
  const row = rows[0];
  if (!row?.enabled || !row.webhook_url) return { posted: false, reason: "disabled" };
  const response = await fetch(String(row.webhook_url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: content.slice(0, 2000), embeds: embeds?.slice(0, 10) }) });
  if (!response.ok) throw new Error(`Discord webhook returned ${response.status}.`);
  return { posted: true };
}

export function toIcsDate(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function calendarIcs(rows: Row[]) {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/[,;\n]/g, (match) => `\\${match}`);
  const events = rows.map((row) => `BEGIN:VEVENT\r\nUID:eleague-match-${row.id}@efootball-leagues-one.vercel.app\r\nDTSTAMP:${toIcsDate(Date.now())}\r\nDTSTART:${toIcsDate(Number(row.kickoff_at))}\r\nDTEND:${toIcsDate(Number(row.kickoff_at) + 7 * 60 * 1000)}\r\nSUMMARY:${escape(`Matchday ${row.matchday}: ${row.home_team_name} vs ${row.away_team_name}`)}\r\nSTATUS:${row.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"}\r\nEND:VEVENT`);
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//eLeague Khalpar//Fixtures//EN\r\nCALSCALE:GREGORIAN\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}
