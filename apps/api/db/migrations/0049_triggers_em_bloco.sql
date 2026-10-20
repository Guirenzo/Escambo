-- Triggers do extrato imutável em BEGIN ... END (RNF-036, ADR 64). Na 0046, os sete triggers de
-- uma instrução só (SIGNAL direto, sem bloco) ficaram gravados com o ';' final no corpo, porque o
-- runner manda a migration como multi-statement. O mysqldump põe esse ';' dentro do comentário
-- versionado ('...'; */;;), e o mysql recusa o dump na restauração (ERROR 1064 near ' */'): nenhum
-- backup feito desde a 1.45.0 voltava com um 'mysql < dump' comum. Em bloco, o corpo termina em
-- END, e o dump sai válido. A recusa e as mensagens são as mesmas; o trigger da retenção do
-- audit_logs (IF ... END IF) já era composto e não muda.
--
-- Pode rodar de novo: cada trigger é apagado e recriado. Criar trigger com o binlog ligado pede
-- log_bin_trust_function_creators=1 (DEPLOY.md, 1.45.0).

DROP TRIGGER IF EXISTS trg_wallet_tx_no_update;
CREATE TRIGGER trg_wallet_tx_no_update
  BEFORE UPDATE ON wallet_transactions FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'wallet_transactions é imutável (RNF-036): lançamento não se altera, corrige-se com um estorno';
  END;

DROP TRIGGER IF EXISTS trg_wallet_tx_no_delete;
CREATE TRIGGER trg_wallet_tx_no_delete
  BEFORE DELETE ON wallet_transactions FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'wallet_transactions é imutável (RNF-036): lançamento não se apaga, corrige-se com um estorno';
  END;

DROP TRIGGER IF EXISTS trg_credit_tx_no_update;
CREATE TRIGGER trg_credit_tx_no_update
  BEFORE UPDATE ON credit_transactions FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'credit_transactions é imutável (RNF-036): lançamento não se altera, corrige-se com um estorno';
  END;

DROP TRIGGER IF EXISTS trg_credit_tx_no_delete;
CREATE TRIGGER trg_credit_tx_no_delete
  BEFORE DELETE ON credit_transactions FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'credit_transactions é imutável (RNF-036): lançamento não se apaga, corrige-se com um estorno';
  END;

DROP TRIGGER IF EXISTS trg_payment_events_no_update;
CREATE TRIGGER trg_payment_events_no_update
  BEFORE UPDATE ON payment_events FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'payment_events é imutável (RNF-036): o histórico do gateway não se altera';
  END;

DROP TRIGGER IF EXISTS trg_payment_events_no_delete;
CREATE TRIGGER trg_payment_events_no_delete
  BEFORE DELETE ON payment_events FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'payment_events é imutável (RNF-036): o histórico do gateway não se apaga';
  END;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE ON audit_logs FOR EACH ROW
  BEGIN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_logs é imutável (RNF-037): registro de auditoria não se altera';
  END;
