-- ============================================================
-- Migration 001 — Phase 0 (Stabilize + Security)
-- ============================================================
-- Consolidates every implicit "runtime patch" that used to live in
-- functions.php (ensure_users_limited_column / ensure_schema_extras)
-- and auth.php (current_user self-heal) into a single, idempotent,
-- out-of-band migration.
--
-- Run once:  mysql -u root blackmeet < sql/migrations/001_phase0_schema.sql
-- (or import via phpMyAdmin). Safe to re-run: every statement is
-- conditional / IF NOT EXISTS.
--
-- Documented implicit migrations that were previously executed on the
-- request path:
--   1. users.is_limited     TINYINT(1) NOT NULL DEFAULT 0
--   2. users.avatar         VARCHAR(255) NULL
--   3. users.last_activity  DATETIME NULL
--   4. table meeting_blocks (meeting_id, user_id)
--   5. table pv_messages    (PM console + forgot-password thread)
--   6. table announcements  (manager broadcasts)
-- ============================================================

USE `blackmeet`;

-- Migration ledger (applied once; tracks future migrations too)
CREATE TABLE IF NOT EXISTS `migrations` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(120) NOT NULL,
  `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_migration_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1..3: users columns
-- MySQL 8: ADD COLUMN IF NOT EXISTS is not supported for MariaDB <10.5 /
-- MySQL 8.0 -> use information_schema-guarded dynamic SQL (idempotent).
SET @dbname = DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='users' AND COLUMN_NAME='is_limited');
SET @sql := IF(@col=0, 'ALTER TABLE `users` ADD COLUMN `is_limited` TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='users' AND COLUMN_NAME='avatar');
SET @sql := IF(@col=0, 'ALTER TABLE `users` ADD COLUMN `avatar` VARCHAR(255) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='users' AND COLUMN_NAME='last_activity');
SET @sql := IF(@col=0, 'ALTER TABLE `users` ADD COLUMN `last_activity` DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4: meeting blocks
CREATE TABLE IF NOT EXISTS `meeting_blocks` (
  `meeting_id` INT UNSIGNED NOT NULL,
  `user_id`    INT UNSIGNED NOT NULL,
  PRIMARY KEY (`meeting_id`, `user_id`),
  KEY `idx_mb_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5: private messages (manager <-> user console, forgot-password thread)
CREATE TABLE IF NOT EXISTS `pv_messages` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT UNSIGNED NOT NULL,
  `from_manager` TINYINT(1) NOT NULL DEFAULT 0,
  `body`        TEXT NOT NULL,
  `seen`        TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_uid` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6: announcements (manager broadcast)
CREATE TABLE IF NOT EXISTS `announcements` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `body`       TEXT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Performance indexes for chat history pagination (Phase 0 prep)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='messages' AND INDEX_NAME='idx_meeting_msg');
SET @sql := IF(@idx=0, 'ALTER TABLE `messages` ADD INDEX `idx_meeting_msg` (`meeting_id`, `id`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='emoji_events' AND INDEX_NAME='idx_meeting_emoji');
SET @sql := IF(@idx=0, 'ALTER TABLE `emoji_events` ADD INDEX `idx_meeting_emoji` (`meeting_id`, `id`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='verification_codes' AND INDEX_NAME='idx_ident_purpose');
SET @sql := IF(@idx=0, 'ALTER TABLE `verification_codes` ADD INDEX `idx_ident_purpose` (`identifier`, `purpose`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Register this migration
INSERT IGNORE INTO `migrations` (`name`) VALUES ('001_phase0_schema');
