-- ============================================================
-- Migration 002 — Phase 1 (Full Realtime)
-- ============================================================
-- Adds client-generated message id (client_msg_id) for idempotent
-- realtime message delivery, plus lookup indexes.
-- Run:  mysql -u root blackmeet < sql/migrations/002_phase1_realtime.sql
-- Safe to re-run.

USE `blackmeet`;

SET @dbname = DATABASE();

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='messages' AND COLUMN_NAME='client_msg_id');
SET @sql := IF(@col=0, 'ALTER TABLE `messages` ADD COLUMN `client_msg_id` VARCHAR(64) NULL DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='pv_messages' AND COLUMN_NAME='client_msg_id');
SET @sql := IF(@col=0, 'ALTER TABLE `pv_messages` ADD COLUMN `client_msg_id` VARCHAR(64) NULL DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Dedupe uniqueness: one client_msg_id per (meeting,user) / per (user,from)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='messages' AND INDEX_NAME='uq_msg_client');
SET @sql := IF(@idx=0, 'ALTER TABLE `messages` ADD UNIQUE KEY `uq_msg_client` (`meeting_id`,`user_id`,`client_msg_id`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA=@dbname AND TABLE_NAME='pv_messages' AND INDEX_NAME='uq_pv_client');
SET @sql := IF(@idx=0, 'ALTER TABLE `pv_messages` ADD UNIQUE KEY `uq_pv_client` (`user_id`,`from_manager`,`client_msg_id`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

INSERT IGNORE INTO `migrations` (`name`) VALUES ('002_phase1_realtime');
