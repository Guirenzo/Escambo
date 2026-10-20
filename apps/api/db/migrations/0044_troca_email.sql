-- Troca de e-mail com login (RF-017): o pedido guarda o endereço novo e o hash SHA-256 do token do
-- link enviado a ele. O e-mail da conta só muda quando esse link é aberto (uso único, com
-- validade); até lá o acesso segue pelo endereço antigo, que recebe o aviso do pedido.
-- Pendente = used_at NULL e expires_at no futuro. outcome diz como o pedido terminou: confirmado
-- pelo link, cancelado (pelo titular, ou por uma troca/redefinição de senha) ou substituído por um
-- pedido mais novo. O índice (user_id, created_at) serve ao pendente da conta e ao teto diário.
--
-- O telefone não precisa de coluna: users.phone (VARCHAR(20)) existe desde o baseline e o E.164
-- brasileiro tem no máximo 14 caracteres (+55, DDD e 9 dígitos). Esta migration não mexe em users.
--
-- Tabela nova e DDL atômico no MySQL 8: se o processo cair antes de registrar a migration, a
-- próxima execução encontra a tabela (com o índice) e o IF NOT EXISTS não faz nada.
CREATE TABLE IF NOT EXISTS email_change_requests (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  new_email  VARCHAR(255)    NOT NULL,
  token      CHAR(64)        NOT NULL,
  expires_at DATETIME        NOT NULL,
  used_at    DATETIME        NULL,
  outcome    ENUM('confirmed', 'cancelled', 'replaced') NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ecr_token (token),
  INDEX idx_ecr_user (user_id, created_at),
  CONSTRAINT fk_ecr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
