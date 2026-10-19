-- Leitura no chat (RF-059): as colunas is_read/read_at existem desde o baseline sem uso; read_at
-- passa a ser a fonte do "Lida" (is_read acompanha). Ao abrir a conversa, a API procura as
-- mensagens ainda não lidas da conversa (conversation_id = ? AND read_at IS NULL): com o índice,
-- a consulta e o UPDATE percorrem só as não lidas, em vez do histórico inteiro a cada abertura.
-- O idx_msg_read (is_read) do baseline fica: esta migration é aditiva.
--
-- Sem backfill: mensagem antiga continua "não lida" até o destinatário abrir a conversa. Inferir a
-- leitura (por exemplo, pela resposta) inventaria um horário que o sistema não registrou.
--
-- DDL confirma sozinho: se o processo cair antes de registrar a migration, a próxima execução vê o
-- índice em information_schema e não tenta criá-lo de novo.
SET @leitura_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'messages'
       AND index_name = 'idx_msg_conv_unread'
  ),
  'SELECT 1',
  'ALTER TABLE messages ADD INDEX idx_msg_conv_unread (conversation_id, read_at)'
);
PREPARE escambo_leitura_migration FROM @leitura_sql;
EXECUTE escambo_leitura_migration;
DEALLOCATE PREPARE escambo_leitura_migration;
