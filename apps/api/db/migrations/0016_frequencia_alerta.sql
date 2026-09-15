-- Frequência do alerta de busca salva (ADR 37). Cada busca escolhe quando avisar: na hora (a
-- cada rodada dos jobs), de hora em hora (o comportamento do ADR 35, que fica como padrão, então
-- as buscas que já existem não mudam) ou uma vez por dia, no horário do resumo diário.
-- alert_enabled segue como liga/desliga: desligar não esquece a frequência escolhida.
ALTER TABLE saved_searches
  ADD COLUMN alert_frequency ENUM('instant', 'hourly', 'daily') NOT NULL DEFAULT 'hourly'
    AFTER alert_enabled;
