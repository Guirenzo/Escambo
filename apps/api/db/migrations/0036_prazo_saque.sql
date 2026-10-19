-- Prazo de saque (RN-035, RF-078): a hora-limite do pagamento fica gravada no saque, calculada no
-- pedido com o parâmetro que valia (dias úteis por PIX ou por transferência). Mudar o parâmetro
-- depois não mexe no que já foi pedido. O índice serve à fila do admin e à contagem de atrasados.
-- DDL do MySQL confirma implicitamente: se o processo cair antes de registrar a migration, a
-- próxima execução acrescenta só o que falta, e o preenchimento não sobrescreve prazo já gravado.
SET @withdrawal_parts = CONCAT_WS(', ',
  IF((SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND column_name = 'due_at') = 0,
     'ADD COLUMN due_at DATETIME NULL AFTER processed_at', NULL),
  IF((SELECT COUNT(*) FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND index_name = 'idx_wd_status_due') = 0,
     'ADD INDEX idx_wd_status_due (status, due_at)', NULL)
);
SET @withdrawal_sql = IF(@withdrawal_parts = '', 'SELECT 1',
                         CONCAT('ALTER TABLE withdrawals ', @withdrawal_parts));
PREPARE escambo_withdrawal_migration FROM @withdrawal_sql;
EXECUTE escambo_withdrawal_migration;
DEALLOCATE PREPARE escambo_withdrawal_migration;

-- Parâmetros do painel (também no seed, para bancos novos). Reaplicar atualiza a explicação,
-- preservando o valor escolhido pelo admin.
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('withdrawal_pix_business_days',  '1', 'integer', 'Dias úteis (seg a sex no calendário de Brasília, sem feriados) para pagar um saque por PIX, gravados no saque no pedido (RN-035)'),
  ('withdrawal_bank_business_days', '2', 'integer', 'Dias úteis (seg a sex no calendário de Brasília, sem feriados) para pagar um saque por transferência bancária, gravados no saque no pedido (RN-035)')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- Saques ainda em aberto ganham o prazo do padrão da RN-035 (1 dia útil por PIX, 2 por TED),
-- contado do dia do pedido em Brasília. UTC−3 fixo: o Brasil não tem horário de verão desde 2019,
-- e CONVERT_TZ dependeria das tabelas de fuso carregadas no servidor. Feriados ficam de fora,
-- como em utils/business-days.ts, que faz a mesma conta: o n-ésimo dia útil depois do dia D é
-- D + 7·⌊k/5⌋ + (k mod 5) − dow(D), com dow de segunda = 0 e k = min(dow(D), 4) + n (sábado e
-- domingo contam como a sexta). Vence às 23:59:59 de Brasília desse dia, gravado em UTC.
-- Saques encerrados ficam sem prazo (NULL): nunca tiveram um.
UPDATE withdrawals
   SET due_at = TIMESTAMP(
         DATE(created_at - INTERVAL 3 HOUR)
           + INTERVAL (7 * FLOOR((LEAST(WEEKDAY(created_at - INTERVAL 3 HOUR), 4)
                                  + IF(pix_key IS NULL, 2, 1)) / 5)
                       + MOD(LEAST(WEEKDAY(created_at - INTERVAL 3 HOUR), 4)
                             + IF(pix_key IS NULL, 2, 1), 5)
                       - WEEKDAY(created_at - INTERVAL 3 HOUR)) DAY,
         '23:59:59') + INTERVAL 3 HOUR,
       updated_at = updated_at
 WHERE due_at IS NULL AND status IN ('requested', 'processing');
