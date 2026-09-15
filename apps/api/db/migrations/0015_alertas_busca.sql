-- Alertas de busca salva (ADR 35): o job saved-search-alerts avisa quando aparece serviço novo
-- que casa com a busca. last_alert_at (existia no baseline sem uso) vira o cursor "já conferido
-- até": serviços criados a partir dele entram no próximo aviso. O índice deixa o job achar as
-- buscas com alerta vencidas sem varrer a tabela.
ALTER TABLE saved_searches
  ADD INDEX idx_saved_alert (alert_enabled, last_alert_at);
