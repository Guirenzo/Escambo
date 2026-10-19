-- Snapshots dos relatórios do admin (RF-081): o job report-snapshots grava em report_snapshots o
-- dia, a semana (segunda a domingo) e o mês de Brasília que fecharam; o relatório de uso lê dali.
-- A tabela já vem no baseline (schema.sql) desde o início, sem código; o CREATE abaixo é o mesmo
-- do baseline e só age num banco que, por algum motivo, não a tenha.
-- Os índices servem à contagem de usuários ativos por período (sessões criadas, mensagens enviadas
-- e mudanças de status de contratação, cada uma pela data), que sem eles lê as tabelas inteiras.
-- Só aditiva. Cada ALTER confere o information_schema antes: se o processo cair depois de um
-- ALTER (DDL confirma sozinho) e antes de registrar a migration, a próxima execução só cria o que
-- falta. ADD INDEX no InnoDB do MySQL 8 é online: não trava gravações nas tabelas.
CREATE TABLE IF NOT EXISTS report_snapshots (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_type     ENUM('daily', 'weekly', 'monthly') NOT NULL,
  period_start    DATE            NOT NULL,
  period_end      DATE            NOT NULL,
  new_users       INT UNSIGNED    NOT NULL DEFAULT 0,
  new_contracts   INT UNSIGNED    NOT NULL DEFAULT 0,
  completed_contracts INT UNSIGNED NOT NULL DEFAULT 0,
  cancelled_contracts INT UNSIGNED NOT NULL DEFAULT 0,
  total_revenue   DECIMAL(12, 2)  NOT NULL DEFAULT 0.00,
  platform_fees   DECIMAL(12, 2)  NOT NULL DEFAULT 0.00,
  avg_rating      DECIMAL(3, 2)   NOT NULL DEFAULT 0.00,
  active_users    INT UNSIGNED    NOT NULL DEFAULT 0,
  payload         JSON            NULL,
  generated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_report_period (period_type, period_start),
  INDEX idx_report_type  (period_type),
  INDEX idx_report_start (period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @report_sql = IF(EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'user_sessions'
       AND index_name = 'idx_sessions_created_user'),
  'SELECT 1',
  'ALTER TABLE user_sessions ADD INDEX idx_sessions_created_user (created_at, user_id)');
PREPARE escambo_report_migration FROM @report_sql;
EXECUTE escambo_report_migration;
DEALLOCATE PREPARE escambo_report_migration;

SET @report_sql = IF(EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'messages'
       AND index_name = 'idx_msg_created_sender'),
  'SELECT 1',
  'ALTER TABLE messages ADD INDEX idx_msg_created_sender (created_at, sender_id)');
PREPARE escambo_report_migration FROM @report_sql;
EXECUTE escambo_report_migration;
DEALLOCATE PREPARE escambo_report_migration;

SET @report_sql = IF(EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'contract_status_history'
       AND index_name = 'idx_csh_created'),
  'SELECT 1',
  'ALTER TABLE contract_status_history ADD INDEX idx_csh_created (created_at)');
PREPARE escambo_report_migration FROM @report_sql;
EXECUTE escambo_report_migration;
DEALLOCATE PREPARE escambo_report_migration;
