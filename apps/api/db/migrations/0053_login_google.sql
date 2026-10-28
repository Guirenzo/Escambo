-- Login com Google (1.54.0, RF-002).
--
-- users.google_sub  o identificador da conta Google (a claim `sub` do ID token), que não muda nem
--                   quando a pessoa troca o e-mail no Google. Único: uma conta Google entra numa
--                   conta do Escambo só. ASCII com comparação exata (ascii_bin): o `sub` é um texto
--                   opaco de até 255 caracteres, e a collation do resto da tabela ignoraria
--                   maiúsculas. NULL = conta sem Google. A anonimização (RN-072) o apaga.
--
-- google_login_tickets  os passes de uso único do fluxo, guardados só como hash SHA-256:
--   state     o `state` de cada ida ao Google, gravado na volta: o mesmo não passa duas vezes,
--             nem com o cookie copiado;
--   exchange  o código que o callback manda ao web no endereço, trocado em POST
--             /auth/google/exchange pela sessão (ou pelo passe da 2FA, ou pelo de conta nova);
--   signup    o passe da conta nova até "Concluir cadastro", com o sub, o e-mail e o nome que o
--             Google mandou.
-- A linha sai da tabela quando é usada, e as vencidas saem a cada passe novo: o e-mail e o nome de
-- quem não concluiu o cadastro não ficam. Nenhum token do Google (access, refresh, id) é guardado.
--
-- A tabela user_social_logins do baseline continua sem uso: com um provedor só, a coluna única em
-- users resolve o vínculo numa consulta, e a coluna `token` de lá convidaria a guardar o token do
-- Google, que o Escambo não usa depois do login.
--
-- Só aditiva. A coluna nova entra no fim de users (instantâneo no MySQL 8), e a chave única nasce
-- sobre uma coluna vazia. Cada passo confere o information_schema: se o processo cair no meio, a
-- próxima execução faz só o que falta; rodando de novo com tudo feito, nada muda.

SET @google_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'google_sub'
  ),
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN google_sub VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL'
);
PREPARE escambo_google_migration FROM @google_sql;
EXECUTE escambo_google_migration;
DEALLOCATE PREPARE escambo_google_migration;

SET @google_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'users'
       AND index_name = 'uq_users_google_sub'
  ),
  'SELECT 1',
  'ALTER TABLE users ADD UNIQUE KEY uq_users_google_sub (google_sub)'
);
PREPARE escambo_google_migration FROM @google_sql;
EXECUTE escambo_google_migration;
DEALLOCATE PREPARE escambo_google_migration;

CREATE TABLE IF NOT EXISTS google_login_tickets (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_hash CHAR(64)        CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- SHA-256 do passe
  purpose     ENUM('state', 'exchange', 'signup') NOT NULL,
  user_id     BIGINT UNSIGNED NULL,          -- exchange de conta que já existe
  google_sub  VARCHAR(255)    CHARACTER SET ascii COLLATE ascii_bin NULL, -- conta nova
  email       VARCHAR(255)    NULL,          -- conta nova: o e-mail confirmado pelo Google
  name        VARCHAR(150)    NULL,          -- conta nova: o nome da conta Google, sugestão
  expires_at  DATETIME        NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_glt_hash (ticket_hash),
  INDEX idx_glt_expires (expires_at),
  INDEX idx_glt_user (user_id),
  CONSTRAINT fk_glt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
