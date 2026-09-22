-- Avisos push no navegador (ADR 52). Cada linha é um aparelho que aceitou receber: o endpoint do
-- serviço de push do navegador (único) e as chaves que cifram a mensagem para aquele aparelho.
-- Não há preferência por conta: a assinatura é a preferência, e some quando a pessoa desliga ou
-- quando o serviço de push diz que o endpoint morreu (404/410).
CREATE TABLE push_subscriptions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  endpoint     VARCHAR(512)    NOT NULL,
  p256dh       VARCHAR(255)    NOT NULL,
  auth_key     VARCHAR(255)    NOT NULL,
  user_agent   VARCHAR(255)    NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at TIMESTAMP       NULL,
  last_error   VARCHAR(255)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint (endpoint),
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
