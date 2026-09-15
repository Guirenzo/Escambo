-- Expurgo de anexos do chat (ADR 31): o arquivo sai do disco, a mensagem fica e diz por quê.
--   retention → passou da retenção (platform_settings.attachment_retention_days) numa conversa
--               sem contratação aberta entre as duas pessoas
--   lgpd      → o remetente pediu a exclusão da conta (anonimização concluída pelo admin)
--   missing   → a linha apontava para um arquivo que já não existia no disco
-- has_file é coluna gerada só para o índice: poucas mensagens têm arquivo, e o job precisa
-- achá-las sem varrer o histórico inteiro.
ALTER TABLE messages
  ADD COLUMN file_purged_at     DATETIME NULL AFTER file_size_bytes,
  ADD COLUMN file_purged_reason ENUM('retention', 'lgpd', 'missing') NULL AFTER file_purged_at,
  ADD COLUMN has_file TINYINT(1) GENERATED ALWAYS AS (file_url IS NOT NULL) STORED,
  ADD INDEX idx_msg_file (has_file, file_purged_at, created_at);

-- Parâmetro da plataforma (também no seed, para bancos novos).
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('attachment_retention_days', '180', 'integer', 'Dias que um anexo do chat fica no disco depois de enviado, quando não há mais contratação aberta entre as duas pessoas; a mensagem fica, sem o arquivo (ADR 31)')
ON DUPLICATE KEY UPDATE description = VALUES(description);
