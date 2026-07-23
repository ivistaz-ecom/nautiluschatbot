-- Run this once in phpMyAdmin (SQL tab) on database u186687036_nautilus
-- Adds OpenAI embedding storage for semantic PDF search.

ALTER TABLE `document_chunks`
  ADD COLUMN `embedding` JSON DEFAULT NULL AFTER `content`,
  ADD COLUMN `embedding_model` VARCHAR(64) DEFAULT NULL AFTER `embedding`,
  ADD COLUMN `embedded_at` TIMESTAMP NULL DEFAULT NULL AFTER `embedding_model`;
