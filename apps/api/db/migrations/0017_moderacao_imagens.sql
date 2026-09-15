-- Moderação de imagens (ADR 39). Foto de perfil e imagem do portfólio viram alvos de denúncia, e a
-- denúncia guarda o endereço da imagem como estava na hora (image_url): o dono pode trocar a foto
-- depois, mas a moderação vê e age sobre o que foi denunciado. resolution_note guarda o porquê da
-- decisão. media_blocklist impede que uma imagem removida volte: guarda a assinatura exata do
-- arquivo (sha256) e, quando a imagem tem detalhe suficiente, a impressão perceptual de 64 bits
-- (dhash), que continua parecida mesmo reencodada ou redimensionada.
ALTER TABLE content_reports
  MODIFY COLUMN target_type ENUM('user', 'service', 'review', 'message', 'avatar', 'portfolio_item') NOT NULL,
  ADD COLUMN image_url VARCHAR(512) NULL AFTER target_id,
  ADD COLUMN resolution_note VARCHAR(500) NULL AFTER reviewed_at;

CREATE TABLE media_blocklist (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sha256     CHAR(64)        NOT NULL,
  dhash      BIGINT UNSIGNED NULL,
  report_id  BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_blocklist_sha (sha256),
  CONSTRAINT fk_blocklist_report FOREIGN KEY (report_id) REFERENCES content_reports(id) ON DELETE SET NULL,
  CONSTRAINT fk_blocklist_admin FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
