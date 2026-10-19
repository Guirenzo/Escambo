-- Atendimento privado: SLA de primeira resposta pública e encerramento após resolução.
-- DDL MySQL confirma implicitamente. Se o processo cair antes de registrar a migration,
-- a próxima execução acrescenta somente o que falta, conservando o backfill já realizado.
SET @support_columns = (
  SELECT GROUP_CONCAT(CONCAT('ADD COLUMN ', wanted.column_name, ' DATETIME NULL')
                      ORDER BY wanted.position SEPARATOR ', ')
  FROM (
    SELECT 'first_response_at' AS column_name, 1 AS position
    UNION ALL SELECT 'sla_due_at', 2
    UNION ALL SELECT 'sla_alerted_at', 3
  ) wanted
  LEFT JOIN information_schema.columns present
    ON present.table_schema = DATABASE() AND present.table_name = 'support_tickets'
   AND present.column_name = wanted.column_name
  WHERE present.column_name IS NULL
);
SET @support_sql = IF(@support_columns IS NULL, 'SELECT 1',
                     CONCAT('ALTER TABLE support_tickets ', @support_columns));
PREPARE escambo_support_migration FROM @support_sql;
EXECUTE escambo_support_migration;
DEALLOCATE PREPARE escambo_support_migration;

UPDATE support_tickets t
SET t.first_response_at = COALESCE(t.first_response_at, (
  SELECT MIN(m.created_at) FROM support_ticket_messages m
  WHERE m.ticket_id = t.id AND m.is_internal = 0 AND m.sender_id <> t.user_id
)),
t.sla_due_at = COALESCE(t.sla_due_at, TIMESTAMPADD(HOUR,
  CASE t.priority WHEN 'low' THEN 72 WHEN 'high' THEN 8 WHEN 'critical' THEN 2 ELSE 24 END,
  t.created_at)),
t.updated_at = t.updated_at;

SET @support_indexes = (
  SELECT GROUP_CONCAT(wanted.definition ORDER BY wanted.index_name SEPARATOR ', ')
  FROM (
    SELECT 'idx_st_sla' AS index_name,
           'ADD INDEX idx_st_sla (first_response_at, sla_alerted_at, sla_due_at)' AS definition
    UNION ALL SELECT 'idx_st_resolved', 'ADD INDEX idx_st_resolved (status, resolved_at)'
  ) wanted
  LEFT JOIN information_schema.statistics present
    ON present.table_schema = DATABASE() AND present.table_name = 'support_tickets'
   AND present.index_name = wanted.index_name
  WHERE present.index_name IS NULL
);
SET @support_sql = CONCAT('ALTER TABLE support_tickets MODIFY COLUMN sla_due_at DATETIME NOT NULL',
                         IF(@support_indexes IS NULL, '', CONCAT(', ', @support_indexes)));
PREPARE escambo_support_migration FROM @support_sql;
EXECUTE escambo_support_migration;
DEALLOCATE PREPARE escambo_support_migration;
