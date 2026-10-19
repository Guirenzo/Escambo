-- Regras pendentes (ADR 61), parte 1. Tabelas e parâmetros vêm antes do ALTER:
-- podem ser reaplicados se o ALTER falhar. O ALTER único é atômico no MySQL 8.
-- O baseline e as migrations anteriores continuam intactos.

-- Cada oferta de uma negociação (RN-030). A proposta é a oferta 1; ímpares do
-- cliente, pares do freelancer. A contratação espelha a última oferta do cliente,
-- que é a reserva da carteira. milestones guarda os mesmos marcos e sua ordem:
-- [{id, amount, freelancerNet, dueAt}]. NULL somente na entrega sem marcos.
CREATE TABLE IF NOT EXISTS contract_offers (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  contract_id    BIGINT UNSIGNED  NOT NULL,
  seq            TINYINT UNSIGNED NOT NULL,
  made_by        ENUM('client', 'freelancer') NOT NULL,
  price          DECIMAL(10, 2)   NOT NULL,
  platform_fee   DECIMAL(10, 2)   NOT NULL,
  freelancer_net DECIMAL(10, 2)   NOT NULL,
  deadline_at    DATETIME         NULL,
  milestones     JSON             NULL,
  message        VARCHAR(500)     NULL,
  respond_by     DATETIME         NULL,
  outcome        ENUM('open', 'countered', 'accepted', 'declined', 'withdrawn', 'expired', 'closed') NOT NULL DEFAULT 'open',
  created_at     DATETIME         NOT NULL,
  resolved_at    DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_offer_seq (contract_id, seq),
  CONSTRAINT chk_offer_seq CHECK (seq BETWEEN 1 AND 5),
  CONSTRAINT fk_offer_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Desistências depois do aceite (RN-026), gravadas com o cancelamento. Nasce
-- vazia: o histórico anterior não vira reincidência. review_checked_at nulo é o
-- trabalho durável que o processamento imediato e o job de reconciliação conferem.
CREATE TABLE IF NOT EXISTS freelancer_dropouts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id      BIGINT UNSIGNED NOT NULL,
  freelancer_id    BIGINT UNSIGNED NOT NULL,
  dropped_at       DATETIME        NOT NULL,
  client_agreed_at DATETIME        NULL,
  appeal_text      VARCHAR(1000)   NULL,
  appealed_at      DATETIME        NULL,
  decision         ENUM('excused', 'upheld') NULL,
  decided_by       BIGINT UNSIGNED NULL,
  decided_at       DATETIME        NULL,
  decision_note    VARCHAR(500)    NULL,
  review_checked_at DATETIME       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dropout_contract (contract_id),
  INDEX idx_dropout_freelancer (freelancer_id, dropped_at),
  INDEX idx_dropout_appeal (appealed_at, decided_at),
  INDEX idx_dropout_review_pending (review_checked_at, id),
  CONSTRAINT fk_dropout_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_dropout_freelancer FOREIGN KEY (freelancer_id) REFERENCES users(id),
  CONSTRAINT fk_dropout_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reaplicar atualiza a explicação, preservando o valor escolhido pelo admin.
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('counter_offer_response_hours', '48', 'integer', 'Horas para responder a uma contraproposta; sem resposta, a negociação se encerra e a reserva volta ao cliente (RN-030, ADR 61)'),
  ('extension_response_hours',     '48', 'integer', 'Horas para o cliente responder a um pedido de extensão; sem resposta, ele expira e vale como recusa (RN-028, ADR 61)')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- A taxa nula do legado é recuperada e validada pela regra pura antes de mexer
-- em dinheiro. offer_seq 1 mantém a proposta antiga. Limite nulo mantém revisões
-- antigas ilimitadas; INT UNSIGNED comporta a revisão 256 e liberações posteriores.
-- As horas de primeira entrega e abertura de disputa são preenchidas pelo reparo
-- sob trava e preservadas na revisão/reentrega (RN-062).
ALTER TABLE contracts
  ADD COLUMN fee_percentage DECIMAL(5, 2) NULL AFTER freelancer_net,
  ADD COLUMN offer_seq TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER proposal_expires_at,
  ADD COLUMN revision_limit INT UNSIGNED NULL AFTER revision_requested_at,
  ADD COLUMN revisions_used INT UNSIGNED NOT NULL DEFAULT 0 AFTER revision_limit,
  ADD COLUMN first_delivery_at DATETIME NULL AFTER revisions_used,
  ADD COLUMN delivery_dispute_opens_at DATETIME NULL AFTER first_delivery_at,
  ADD CONSTRAINT chk_contract_offer_seq CHECK (offer_seq BETWEEN 1 AND 5);
