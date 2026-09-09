-- Pagamentos de verdade: carteira pré-paga, ledger de dinheiro e saques processáveis.
--
-- 1) `payments` passa a registrar também DEPÓSITOS na carteira (top-up via gateway):
--    sem contrato e sem beneficiário; `kind` distingue; `expires_at` é a validade da cobrança PIX.
-- 2) `wallet_transactions` é o extrato de R$ (espelho do ledger de créditos): toda movimentação
--    de saldo disponível e/ou retido, com saldos resultantes e motivo, gravada na MESMA transação
--    do efeito (depósito, reserva na proposta, escrow, liberação, reembolso, saque, estorno).

ALTER TABLE payments
  MODIFY COLUMN contract_id BIGINT UNSIGNED NULL,
  MODIFY COLUMN payee_id    BIGINT UNSIGNED NULL,
  ADD COLUMN kind       ENUM('topup', 'contract') NOT NULL DEFAULT 'contract' AFTER id,
  ADD COLUMN expires_at DATETIME NULL AFTER paid_at;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  amount         DECIMAL(10, 2)  NOT NULL,                 -- variação do saldo DISPONÍVEL (+ entra, - sai)
  pending_delta  DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,    -- variação do saldo RETIDO (escrow / reserva)
  balance_after  DECIMAL(10, 2)  NOT NULL,                 -- disponível após o movimento
  pending_after  DECIMAL(10, 2)  NOT NULL,                 -- retido após o movimento
  reason         VARCHAR(40)     NOT NULL,                 -- deposit | hold | payment | escrow_in | escrow_release | escrow_refund | refund | withdrawal | withdrawal_refund
  contract_id    BIGINT UNSIGNED NULL,
  payment_id     BIGINT UNSIGNED NULL,
  withdrawal_id  BIGINT UNSIGNED NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_wtx_user (user_id, id),
  INDEX idx_wtx_contract (contract_id),
  CONSTRAINT fk_wtx_user       FOREIGN KEY (user_id)       REFERENCES users(id),
  CONSTRAINT fk_wtx_contract   FOREIGN KEY (contract_id)   REFERENCES contracts(id)   ON DELETE SET NULL,
  CONSTRAINT fk_wtx_payment    FOREIGN KEY (payment_id)    REFERENCES payments(id)    ON DELETE SET NULL,
  CONSTRAINT fk_wtx_withdrawal FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Propostas 'pending' em dinheiro anteriores ao modelo pré-pago nunca tiveram valor reservado:
--    não poderiam ser aceitas (nada a pagar) nem devolvidas. São encerradas com nota no histórico.
INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
  SELECT id, client_id, 'pending', 'cancelled',
         'Encerrada na migração para a carteira pré-paga (proposta sem valor reservado)'
    FROM contracts
   WHERE status = 'pending' AND payment_mode = 'cash';

UPDATE contracts
   SET status = 'cancelled', cancelled_at = NOW()
 WHERE status = 'pending' AND payment_mode = 'cash';
