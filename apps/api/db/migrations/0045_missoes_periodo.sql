-- Missões com prazo (RF-066, RN-054): cada linha de user_missions é o progresso de uma pessoa numa
-- missão num período, e o período é a chave. period_key vem do fuso da conta no momento do evento:
-- 'd:AAAA-MM-DD' (missão diária, o dia), 'w:AAAA-MM-DD' (semanal, a segunda-feira da semana) e
-- 'sempre' (conquista sem prazo). Quando o dia ou a semana vira, a chave nova abre outra linha e a
-- antiga deixa de ser lida: o progresso que não chegou à meta se perde sem job de expiração.
-- expires_at continua sendo o fim do período (23:59:59 do dia ou do domingo), só para exibir.
--
-- A chave única do baseline (user_id, mission_id, expires_at) não serve: a conquista não tem
-- expires_at (NULL não colide no UNIQUE), e o instante muda se a pessoa troca de fuso no meio do
-- período. Ela é trocada por (user_id, mission_id, period_key), que é o que a API grava e trava.
--
-- Nenhum código gravava em user_missions antes desta versão; uma linha inserida à mão recebe uma
-- chave própria ('legado:<id>'), para a chave única nova não colidir. Os índices de user_id e de
-- mission_id do baseline continuam servindo às FKs.
--
-- DDL confirma sozinho no MySQL 8: se o processo cair no meio, a próxima execução confere o
-- information_schema e faz só o que falta.
SET @missoes_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'user_missions'
       AND column_name = 'period_key'
  ),
  'SELECT 1',
  'ALTER TABLE user_missions ADD COLUMN period_key VARCHAR(32) NOT NULL DEFAULT '''' AFTER mission_id'
);
PREPARE escambo_missoes_migration FROM @missoes_sql;
EXECUTE escambo_missoes_migration;
DEALLOCATE PREPARE escambo_missoes_migration;

UPDATE user_missions SET period_key = CONCAT('legado:', id) WHERE period_key = '';

SET @missoes_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'user_missions'
       AND index_name = 'uq_user_mission_period'
  ),
  'SELECT 1',
  CONCAT(
    'ALTER TABLE user_missions ADD UNIQUE KEY uq_user_mission_period (user_id, mission_id, period_key)',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'user_missions'
           AND index_name = 'uq_user_mission_active'
      ),
      ', DROP INDEX uq_user_mission_active',
      ''
    )
  )
);
PREPARE escambo_missoes_migration FROM @missoes_sql;
EXECUTE escambo_missoes_migration;
DEALLOCATE PREPARE escambo_missoes_migration;
