-- Contestação e reincidência na moderação de imagens (ADR 41). Cada remoção vira um registro: de
-- quem era a imagem, de onde ela saiu (cleared_refs, para poder recolocar) e o arquivo guardado em
-- quarentena fora do ar (quarantine_file) enquanto o dono pode contestar. status segue a vida da
-- remoção: removed (sem contestação), appealed (contestada, esperando o admin), upheld (mantida) e
-- overturned (revertida, com a imagem de volta). Remoções não revertidas dentro da janela contam
-- como ocorrências de reincidência.
CREATE TABLE image_removals (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id       BIGINT UNSIGNED NULL,
  owner_id        BIGINT UNSIGNED NOT NULL,
  target_type     ENUM('avatar', 'portfolio_item') NOT NULL,
  target_id       BIGINT UNSIGNED NOT NULL,
  image_url       VARCHAR(512)    NOT NULL,
  reason          ENUM('spam', 'fraud', 'offensive', 'off_platform', 'illegal', 'other') NOT NULL,
  note            VARCHAR(500)    NULL,
  cleared_refs    JSON            NOT NULL,
  quarantine_file VARCHAR(80)     NULL,
  blocklist_id    BIGINT UNSIGNED NULL,
  removed_by      BIGINT UNSIGNED NULL,
  removed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status          ENUM('removed', 'appealed', 'upheld', 'overturned') NOT NULL DEFAULT 'removed',
  appeal_text     VARCHAR(1000)   NULL,
  appealed_at     DATETIME        NULL,
  decided_by      BIGINT UNSIGNED NULL,
  decided_at      DATETIME        NULL,
  decision_note   VARCHAR(500)    NULL,
  file_purged_at  DATETIME        NULL,

  PRIMARY KEY (id),
  INDEX idx_removal_owner (owner_id, removed_at),
  INDEX idx_removal_status (status, removed_at),
  CONSTRAINT fk_removal_report FOREIGN KEY (report_id) REFERENCES content_reports(id) ON DELETE SET NULL,
  CONSTRAINT fk_removal_owner FOREIGN KEY (owner_id) REFERENCES users(id),
  CONSTRAINT fk_removal_blocklist FOREIGN KEY (blocklist_id) REFERENCES media_blocklist(id) ON DELETE SET NULL,
  CONSTRAINT fk_removal_admin FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_removal_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Parâmetros da plataforma (também no seed, para bancos novos).
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('appeal_window_days',       '14',  'integer', 'Dias que o dono de uma imagem removida tem para contestar, depois a imagem em quarentena é apagada (ADR 41)'),
  ('strike_window_days',       '180', 'integer', 'Janela em que remoções de imagem não revertidas contam juntas como reincidência (ADR 41)'),
  ('strike_upload_block_days', '7',   'integer', 'Dias sem enviar imagens a partir da segunda remoção na janela, multiplicados a cada nova remoção, com 0 desligando o bloqueio (ADR 41)'),
  ('strike_review_threshold',  '3',   'integer', 'Remoções na janela que abrem uma denúncia da conta para revisão do admin (ADR 41)')
ON DUPLICATE KEY UPDATE description = VALUES(description);
