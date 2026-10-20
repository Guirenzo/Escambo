-- Registro imutável das transações (RNF-036) e retenção mínima da auditoria (RNF-037), no banco.
--
-- Os extratos wallet_transactions (R$) e credit_transactions (créditos) já eram gravados só com
-- INSERT, na mesma transação do efeito (ADR 3/15); agora o banco recusa qualquer UPDATE ou DELETE
-- neles. Lançamento errado se corrige com outro lançamento (estorno), nunca editando a linha.
-- O histórico do gateway (payment_events, migration 0042: uma linha por resposta ou webhook)
-- também é só INSERT e passa a recusar UPDATE e DELETE do mesmo jeito.
-- O audit_logs também não aceita UPDATE, e só aceita DELETE de linha com mais de 90 dias: é a
-- retenção mínima (AUDIT_LOG_MIN_RETENTION_DAYS em src/modules/audit/audit.retention.ts). O
-- expurgo opcional (AUDIT_LOG_PURGE_DAYS, desligado por padrão) só apaga o que passou disso.
-- O admin_actions fica de fora: a anonimização da LGPD reescreve a descrição dele.
--
-- A recusa sai como SQLSTATE 45000 (erro 1644 no cliente), com a mensagem abaixo.
--
-- O que trigger não cobre: TRUNCATE e DROP TABLE não disparam trigger; ação de FK também não (o
-- ON DELETE SET NULL de contract_id, payment_id e withdrawal_id do extrato de R$ ao apagar o
-- registro pai); e quem tem o privilégio TRIGGER pode apagar os triggers. Protege contra
-- UPDATE/DELETE da aplicação ou de um comando manual, não contra quem administra o banco.
--
-- Com o binlog ligado (padrão do MySQL 8), criar trigger pede SUPER ou
-- log_bin_trust_function_creators=1. O usuário da aplicação não tem SUPER: os dois docker-compose
-- sobem o MySQL com --log-bin-trust-function-creators=1.
--
-- Sem DELIMITER: o runner manda o arquivo inteiro de uma vez (multipleStatements) e o servidor
-- separa as instruções, inclusive o IF ... END IF do corpo. Idempotente: cada trigger é apagado
-- (se existir) e criado de novo, então o arquivo pode rodar mais de uma vez.

DROP TRIGGER IF EXISTS trg_wallet_tx_no_update;
CREATE TRIGGER trg_wallet_tx_no_update
  BEFORE UPDATE ON wallet_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'wallet_transactions é imutável (RNF-036): lançamento não se altera, corrige-se com um estorno';

DROP TRIGGER IF EXISTS trg_wallet_tx_no_delete;
CREATE TRIGGER trg_wallet_tx_no_delete
  BEFORE DELETE ON wallet_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'wallet_transactions é imutável (RNF-036): lançamento não se apaga, corrige-se com um estorno';

DROP TRIGGER IF EXISTS trg_credit_tx_no_update;
CREATE TRIGGER trg_credit_tx_no_update
  BEFORE UPDATE ON credit_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'credit_transactions é imutável (RNF-036): lançamento não se altera, corrige-se com um estorno';

DROP TRIGGER IF EXISTS trg_credit_tx_no_delete;
CREATE TRIGGER trg_credit_tx_no_delete
  BEFORE DELETE ON credit_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'credit_transactions é imutável (RNF-036): lançamento não se apaga, corrige-se com um estorno';

DROP TRIGGER IF EXISTS trg_payment_events_no_update;
CREATE TRIGGER trg_payment_events_no_update
  BEFORE UPDATE ON payment_events FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'payment_events é imutável (RNF-036): o histórico do gateway não se altera';

DROP TRIGGER IF EXISTS trg_payment_events_no_delete;
CREATE TRIGGER trg_payment_events_no_delete
  BEFORE DELETE ON payment_events FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'payment_events é imutável (RNF-036): o histórico do gateway não se apaga';

DROP TRIGGER IF EXISTS trg_audit_logs_no_update;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE ON audit_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_logs é imutável (RNF-037): registro de auditoria não se altera';

DROP TRIGGER IF EXISTS trg_audit_logs_retention;
CREATE TRIGGER trg_audit_logs_retention
  BEFORE DELETE ON audit_logs FOR EACH ROW
  IF OLD.created_at > NOW() - INTERVAL 90 DAY THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_logs guarda cada registro por no mínimo 90 dias (RNF-037): este ainda não pode sair';
  END IF;
