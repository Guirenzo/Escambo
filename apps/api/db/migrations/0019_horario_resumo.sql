-- Horário do resumo por pessoa (ADR 42). digest_hour é a hora, em Brasília, a partir da qual saem o
-- resumo diário de e-mail e os alertas diários das buscas salvas daquela conta. NULL segue a hora
-- padrão da plataforma (DIGEST_HOUR), então nada muda para quem não escolher.
ALTER TABLE users
  ADD COLUMN digest_hour TINYINT UNSIGNED NULL AFTER email_frequency,
  ADD CONSTRAINT chk_users_digest_hour CHECK (digest_hour IS NULL OR digest_hour <= 23);
