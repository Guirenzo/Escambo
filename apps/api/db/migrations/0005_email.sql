-- E-mail transacional, verificação de e-mail e recuperação de senha.
--
-- `email_outbox` registra TODO e-mail que a plataforma gera (assunto, corpo, destinatário,
-- provedor e resultado): é a trilha de auditoria e, no provedor simulado, é a própria
-- "entrega" (o admin lê a caixa de saída; a demo e os testes pegam os links dela).
CREATE TABLE IF NOT EXISTS email_outbox (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NULL,
  to_email   VARCHAR(255)    NOT NULL,
  subject    VARCHAR(255)    NOT NULL,
  template   VARCHAR(60)     NOT NULL,   -- verify_email | password_reset | notification
  text_body  TEXT            NOT NULL,
  html_body  MEDIUMTEXT      NOT NULL,
  status     ENUM('queued', 'sent', 'failed') NOT NULL DEFAULT 'queued',
  provider   VARCHAR(20)     NOT NULL,   -- simulated | smtp
  error      VARCHAR(500)    NULL,
  sent_at    DATETIME        NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_outbox_user (user_id, id),
  INDEX idx_outbox_status (status),
  CONSTRAINT fk_outbox_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token de verificação de e-mail (guardado como hash SHA-256, como os de sessão e de senha).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token      VARCHAR(255)    NOT NULL UNIQUE,
  expires_at DATETIME        NOT NULL,
  used_at    DATETIME        NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_evt_user (user_id),
  CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
