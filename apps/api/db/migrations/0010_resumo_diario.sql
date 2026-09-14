-- Preferência de e-mail por usuário (ADR 27):
--   instant  cada notificação relevante vira um e-mail na hora (comportamento até aqui);
--   daily    um resumo por dia (job daily-digest, na hora DIGEST_HOUR em Brasília);
--   off      só e-mails essenciais (confirmação de e-mail e redefinição de senha).
-- last_digest_at marca o último resumo enviado: é a trava de "um por dia" e o ponto de corte
-- do próximo ("novidades desde…").
ALTER TABLE users
  ADD COLUMN email_frequency ENUM('instant', 'daily', 'off') NOT NULL DEFAULT 'instant' AFTER email_verified_at,
  ADD COLUMN last_digest_at  DATETIME NULL AFTER email_frequency,
  ADD INDEX idx_users_digest (email_frequency, last_digest_at);
