-- Verificação em duas etapas por TOTP (RF-090, RNF-042, ADR 66). A tabela user_mfa existe desde o
-- baseline (uma linha por conta e método, o segredo em VARBINARY e os hashes dos códigos de
-- recuperação em JSON), mas nada gravava nela antes desta versão. A API passa a usar a linha
-- 'totp' e precisa de três colunas a mais:
--
--   last_used_step   o último passo de 30 s aceito: o mesmo código (ou um mais velho que ele) não
--                    vale duas vezes, nem se alguém o viu por cima do ombro;
--   failed_attempts  os códigos errados seguidos; o acerto zera;
--   locked_until     no quinto erro seguido, a 2FA da conta trava por 15 minutos (429 mfa_locked)
--                    e o contador volta a zero.
--
-- O segredo continua em `secret`, sempre cifrado pela API com a FIELD_ENCRYPTION_KEY (AES-256-GCM,
-- o texto `enc:v1:...` do field-crypto): sem a chave, a 2FA fica indisponível e nada é gravado.
--
-- Acrescentar colunas no fim é instantâneo no MySQL 8. DDL confirma sozinho: se o processo cair no
-- meio, a próxima execução confere o information_schema e faz só o que falta; rodando de novo com
-- tudo feito, nada muda.

SET @mfa_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'user_mfa'
       AND column_name = 'last_used_step'
  ),
  'SELECT 1',
  'ALTER TABLE user_mfa ADD COLUMN last_used_step BIGINT NULL AFTER recovery_codes'
);
PREPARE escambo_mfa_migration FROM @mfa_sql;
EXECUTE escambo_mfa_migration;
DEALLOCATE PREPARE escambo_mfa_migration;

SET @mfa_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'user_mfa'
       AND column_name = 'failed_attempts'
  ),
  'SELECT 1',
  'ALTER TABLE user_mfa ADD COLUMN failed_attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_used_step'
);
PREPARE escambo_mfa_migration FROM @mfa_sql;
EXECUTE escambo_mfa_migration;
DEALLOCATE PREPARE escambo_mfa_migration;

SET @mfa_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'user_mfa'
       AND column_name = 'locked_until'
  ),
  'SELECT 1',
  'ALTER TABLE user_mfa ADD COLUMN locked_until DATETIME NULL AFTER failed_attempts'
);
PREPARE escambo_mfa_migration FROM @mfa_sql;
EXECUTE escambo_mfa_migration;
DEALLOCATE PREPARE escambo_mfa_migration;
