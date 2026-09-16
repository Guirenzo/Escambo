-- Aviso de negociação por fora no chat (ADR 45). A API procura sinais de pagamento fora da
-- plataforma no texto de cada mensagem (chave Pix, telefone, e-mail, WhatsApp, "por fora") e guarda
-- o que achou em off_platform ("pix,phone"); NULL = nada. A mensagem não é barrada: as duas partes
-- veem um aviso e ela entra sozinha na fila de denúncias.
ALTER TABLE messages
  ADD COLUMN off_platform VARCHAR(120) NULL AFTER removed_at;

-- Denúncia automática não tem denunciante: reporter_id passa a aceitar NULL (a FK continua).
ALTER TABLE content_reports
  MODIFY reporter_id BIGINT UNSIGNED NULL;
