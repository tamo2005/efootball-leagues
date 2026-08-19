-- eFootball Leagues production schema
-- MySQL 8+ / TiDB compatible. All timestamps are UTC epoch milliseconds.

CREATE TABLE IF NOT EXISTS users (
  email VARCHAR(320) NOT NULL PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'player') NOT NULL DEFAULT 'player',
  status ENUM('ACTIVE', 'INVITED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX users_role_idx (role),
  INDEX users_status_idx (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS teams (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  short_code VARCHAR(12) NOT NULL,
  manager_name VARCHAR(120) NOT NULL,
  accent VARCHAR(32) NOT NULL DEFAULT '#9DD36A',
  status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'APPROVED',
  created_by_email VARCHAR(320) NULL,
  approved_by_email VARCHAR(320) NULL,
  approved_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY teams_name_uq (name),
  UNIQUE KEY teams_short_code_uq (short_code),
  INDEX teams_status_idx (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS team_memberships (
  user_email VARCHAR(320) NOT NULL,
  team_id BIGINT UNSIGNED NOT NULL,
  membership_role ENUM('CAPTAIN', 'PLAYER') NOT NULL DEFAULT 'PLAYER',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_email, team_id),
  UNIQUE KEY team_memberships_one_team_uq (user_email),
  CONSTRAINT team_memberships_user_fk FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
  CONSTRAINT team_memberships_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS seasons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  status ENUM('DRAFT', 'ACTIVE', 'COMPLETED') NOT NULL DEFAULT 'DRAFT',
  matchday_count INT NOT NULL DEFAULT 0,
  current_matchday INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  season_id BIGINT UNSIGNED NOT NULL,
  matchday INT NOT NULL,
  home_team_id BIGINT UNSIGNED NOT NULL,
  away_team_id BIGINT UNSIGNED NOT NULL,
  kickoff_at BIGINT NOT NULL,
  status ENUM('SCHEDULED', 'PENDING', 'CONFIRMED', 'POSTPONED', 'CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
  original_kickoff_at BIGINT NULL,
  rescheduled_at BIGINT NULL,
  reschedule_reason VARCHAR(255) NULL,
  rescheduled_by_email VARCHAR(320) NULL,
  home_score INT NULL,
  away_score INT NULL,
  submitted_by_email VARCHAR(320) NULL,
  confirmed_by_email VARCHAR(320) NULL,
  submitted_at BIGINT NULL,
  confirmed_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY matches_fixture_uq (season_id, home_team_id, away_team_id),
  INDEX matches_season_day_idx (season_id, matchday),
  INDEX matches_status_idx (status),
  CONSTRAINT matches_season_fk FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  CONSTRAINT matches_home_team_fk FOREIGN KEY (home_team_id) REFERENCES teams(id),
  CONSTRAINT matches_away_team_fk FOREIGN KEY (away_team_id) REFERENCES teams(id),
  CONSTRAINT matches_submitter_fk FOREIGN KEY (submitted_by_email) REFERENCES users(email) ON DELETE SET NULL,
  CONSTRAINT matches_confirmer_fk FOREIGN KEY (confirmed_by_email) REFERENCES users(email) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  team_id BIGINT UNSIGNED NOT NULL,
  player_email VARCHAR(320) NULL,
  scorer_name VARCHAR(120) NOT NULL,
  minute INT NOT NULL,
  created_at BIGINT NOT NULL,
  INDEX goals_match_idx (match_id),
  INDEX goals_player_idx (player_email),
  CONSTRAINT goals_match_fk FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT goals_team_fk FOREIGN KEY (team_id) REFERENCES teams(id),
  CONSTRAINT goals_player_fk FOREIGN KEY (player_email) REFERENCES users(email) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_email VARCHAR(320) NULL,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NOT NULL,
  payload JSON NULL,
  created_at BIGINT NOT NULL,
  INDEX audit_entity_idx (entity_type, entity_id),
  INDEX audit_created_idx (created_at),
  CONSTRAINT audit_actor_fk FOREIGN KEY (actor_email) REFERENCES users(email) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_email VARCHAR(320) NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  INDEX sessions_expiry_idx (expires_at),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


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


CREATE TABLE IF NOT EXISTS league_news (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS season_archives (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS league_notifications (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_predictions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_proofs (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matchday_awards (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discord_settings (
  id TINYINT NOT NULL PRIMARY KEY,
  webhook_url VARCHAR(500) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  label VARCHAR(120) NOT NULL DEFAULT 'League Discord',
  updated_by_email VARCHAR(320) NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT discord_settings_user_fk FOREIGN KEY (updated_by_email) REFERENCES users(email) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
