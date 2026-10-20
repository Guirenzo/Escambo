-- Resposta do gateway guardada para auditoria (RF-050). Antes, `payments.gateway_response` recebia
-- só {pixCode} na criação, o corpo do webhook não era persistido e a liquidação não deixava rastro
-- do que o gateway mandou.
--
-- Agora cada cobrança tem um histórico, uma linha por acontecimento, nunca sobrescrita:
--   source  charge (resposta da criação) | webhook (corpo recebido) | simulation (demo, no papel
--           do gateway)
--   outcome created | applied (liquidou a cobrança, gravado na mesma transação da liquidação) |
--           ignored (repetido ou atrasado: o efeito continua idempotente, mas fica registrado) |
--           not_found (cobrança desconhecida) | invalid (corpo fora do formato; a API responde 422)
-- O corpo (`payload`) vai sem dado pessoal: campos de nome, documento, e-mail, conta etc. saem como
-- "[omitido]" (payment-events.ts). O segredo do webhook (cabeçalho) nunca entra.
-- `payment_id` é nulo só no webhook de cobrança desconhecida (ou inválido sem id que exista); aí o
-- `gateway_payment_id` recebido é o que liga a linha ao gateway.
--
-- Só cria a tabela (aditiva): cobranças anteriores ficam sem histórico, com o {pixCode} que já
-- tinham em gateway_response. CREATE TABLE IF NOT EXISTS pode rodar de novo sem erro.
CREATE TABLE IF NOT EXISTS payment_events (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id         BIGINT UNSIGNED NULL,
  gateway            VARCHAR(50)     NOT NULL,
  gateway_payment_id VARCHAR(100)    NULL,
  source             ENUM('charge', 'webhook', 'simulation') NOT NULL,
  event              VARCHAR(60)     NULL,
  status             VARCHAR(20)     NULL,
  outcome            ENUM('created', 'applied', 'ignored', 'not_found', 'invalid') NOT NULL,
  payload            JSON            NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  INDEX idx_pev_payment (payment_id, id),
  INDEX idx_pev_gateway (gateway_payment_id),
  CONSTRAINT fk_pev_payment FOREIGN KEY (payment_id) REFERENCES payments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
