-- Moderação de avaliações e mensagens (ADR 44). A tabela de remoções passa a guardar qualquer
-- conteúdo removido pela moderação: imagem (foto de perfil, trabalho do portfólio), avaliação ou
-- mensagem. image_url e cleared_refs só existem para imagem, e content_snapshot guarda o texto
-- removido da avaliação ou da mensagem, para o dono ver o que saiu e o admin decidir a contestação.
RENAME TABLE image_removals TO content_removals;

ALTER TABLE content_removals
  MODIFY target_type ENUM('avatar', 'portfolio_item', 'review', 'message') NOT NULL,
  MODIFY image_url VARCHAR(512) NULL,
  MODIFY cleared_refs JSON NULL,
  ADD COLUMN content_snapshot VARCHAR(1200) NULL AFTER image_url;

-- Avaliação e mensagem removidas saem do ar, mas a linha fica, para a contestação e o histórico.
ALTER TABLE reviews
  ADD COLUMN removed_at DATETIME NULL AFTER is_public;

ALTER TABLE messages
  ADD COLUMN removed_at DATETIME NULL AFTER file_purged_reason;

-- A reincidência passa a contar qualquer conteúdo removido, e o bloqueio de envio segue só para imagens.
UPDATE platform_settings
   SET description = 'Janela em que remoções de conteúdo não revertidas (imagem, avaliação ou mensagem) contam juntas como reincidência (ADR 41 e 44)'
 WHERE key_name = 'strike_window_days';
UPDATE platform_settings
   SET description = 'Dias sem enviar imagens a partir da segunda imagem removida na janela, multiplicados a cada nova imagem removida, com 0 desligando o bloqueio (ADR 41)'
 WHERE key_name = 'strike_upload_block_days';
UPDATE platform_settings
   SET description = 'Remoções de conteúdo na janela que abrem uma denúncia da conta para revisão do admin (ADR 41 e 44)'
 WHERE key_name = 'strike_review_threshold';
