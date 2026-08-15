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
