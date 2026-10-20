-- Origem explícita de cada mudança de status (ADR 63: a dívida do relatório de uso, RF-081).
--
-- contract_status_history.changed_by é a parte em nome de quem a mudança foi feita, e a plataforma
-- grava mudanças em nome do cliente: a aprovação tácita de entrega ou de marco (RN-024), a proposta
-- ou oferta expirada (RN-021/RN-030) e a disputa aberta por prazo (RN-029). O relatório de uso
-- conta como ativo quem mudou status, e até a 1.45.0 reconhecia essas mudanças automáticas pelo
-- texto da nota. Agora cada linha diz de onde veio, na coluna source: 'user' (a pessoa agiu, ou o
-- admin na mediação) ou 'system' (a plataforma agiu sozinha). A API passa a origem em toda gravação;
-- o DEFAULT 'user' só vale para INSERT feito à mão.
--
-- Backfill das linhas antigas, uma vez: o mesmo reconhecimento por texto que o relatório usava
-- (nota começando por "Aprovação tácita", nota com "expirada: sem resposta" e a entrada em
-- 'disputed' de contratação cuja disputa foi "Aberta automaticamente"), mais as propostas que a
-- 0002 encerrou em nome do cliente na migração para a carteira pré-paga. Assim o uso de um período
-- antigo, calculado agora, não muda com a troca da regra.
--
-- Por que fica uma vez só: a coluna nasce NULL (= linha ainda sem origem), o backfill preenche só
-- as NULL e, no fim, ela vira NOT NULL DEFAULT 'user'. Se o processo cair no meio, a próxima
-- execução confere o information_schema e faz só o que falta; rodando de novo com tudo feito, nada
-- muda, e uma linha gravada depois pela API nunca é reclassificada pelo texto. Se a API antiga
-- gravar uma linha entre o backfill e o NOT NULL (o deploy roda o migrate com ela no ar), o ALTER
-- final recusa a linha NULL e o migrate sai com erro sem se registrar: rodar de novo classifica a
-- linha e termina.
--
-- A tabela não tem trigger: a 0046 tornou imutáveis só os extratos, o payment_events e o
-- audit_logs, então o UPDATE do backfill passa. Acrescentar a coluna no fim é instantâneo no
-- MySQL 8; o NOT NULL refaz a tabela em modo online (leituras e gravações continuam).

SET @origem_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'contract_status_history'
       AND column_name = 'source'
  ),
  'SELECT 1',
  'ALTER TABLE contract_status_history ADD COLUMN source ENUM(''user'', ''system'') NULL'
);
PREPARE escambo_origem_migration FROM @origem_sql;
EXECUTE escambo_origem_migration;
DEALLOCATE PREPARE escambo_origem_migration;

UPDATE contract_status_history h
   SET h.source = IF(
         COALESCE(h.note, '') LIKE 'Aprovação tácita%'
         OR COALESCE(h.note, '') LIKE '%expirada: sem resposta%'
         OR COALESCE(h.note, '') =
              'Encerrada na migração para a carteira pré-paga (proposta sem valor reservado)'
         OR (h.new_status = 'disputed' AND EXISTS (
              SELECT 1 FROM disputes d
               WHERE d.contract_id = h.contract_id
                 AND d.description LIKE 'Aberta automaticamente%')),
         'system',
         'user')
 WHERE h.source IS NULL;

SET @origem_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'contract_status_history'
       AND column_name = 'source' AND is_nullable = 'YES'
  ),
  'ALTER TABLE contract_status_history MODIFY COLUMN source ENUM(''user'', ''system'') NOT NULL DEFAULT ''user''',
  'SELECT 1'
);
PREPARE escambo_origem_migration FROM @origem_sql;
EXECUTE escambo_origem_migration;
DEALLOCATE PREPARE escambo_origem_migration;
