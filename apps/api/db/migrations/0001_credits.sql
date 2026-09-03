-- Créditos Escambo (time-bank): moeda interna de troca.
-- Estende a carteira com saldo de créditos + escrow, cria o ledger e habilita
-- o payment_mode 'credits' nas contratações.

-- Saldo de créditos na carteira (inteiros — 1 crédito, sem centavos).
ALTER TABLE wallets
  ADD COLUMN credits_balance BIGINT NOT NULL DEFAULT 0 AFTER balance_pending,
  ADD COLUMN credits_pending BIGINT NOT NULL DEFAULT 0 AFTER credits_balance;

-- Ledger de créditos: toda movimentação, assinada, com saldo resultante e motivo.
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  amount        BIGINT          NOT NULL,        -- + entra, - sai
  balance_after BIGINT          NOT NULL,        -- credits_balance após o movimento
  reason        VARCHAR(60)     NOT NULL,        -- welcome | escrow_hold | escrow_in | escrow_release | escrow_refund | refund
  contract_id   BIGINT UNSIGNED NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_credit_tx_user (user_id),
  INDEX idx_credit_tx_contract (contract_id),
  CONSTRAINT fk_credit_tx_user     FOREIGN KEY (user_id)     REFERENCES users(id),
  CONSTRAINT fk_credit_tx_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Habilita a modalidade de pagamento em créditos.
ALTER TABLE contracts
  MODIFY COLUMN payment_mode ENUM('cash', 'barter', 'credits') NOT NULL DEFAULT 'cash';
