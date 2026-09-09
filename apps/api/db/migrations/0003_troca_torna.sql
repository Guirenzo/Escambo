-- Torna da troca com dinheiro de verdade (carteira pré-paga).
--
-- `torna_status` é a máquina de estados do dinheiro da troca, separada do status do acordo:
--   none     – troca equilibrada (sem torna) ou acordo antigo já ativo (nunca houve reserva)
--   pending  – há torna, mas ainda não foi reservada (quem paga é o receptor, ou acordo antigo
--              ainda proposto): a reserva acontece no aceite
--   held     – torna reservada na carteira do pagador (balance_pending)
--   paid     – troca concluída: torna paga ao outro lado, menos a taxa da plataforma
--   refunded – recusa, cancelamento ou disputa: torna devolvida ao pagador
ALTER TABLE barter_agreements
  ADD COLUMN torna_status ENUM('none', 'pending', 'held', 'paid', 'refunded') NOT NULL DEFAULT 'none' AFTER platform_fee;

-- Acordos anteriores ao modelo: propostos ainda podem reservar no aceite; ativos nunca tiveram
-- reserva e liquidam sem movimentar dinheiro (a torna fica registrada, não cobrada).
UPDATE barter_agreements
   SET torna_status = CASE
         WHEN cash_difference > 0 AND status = 'proposed' THEN 'pending'
         ELSE 'none'
       END;

-- A taxa da plataforma passa a incidir só sobre a torna (troca equilibrada não tem taxa);
-- acordos antigos ainda abertos são recalculados para não cobrar a regra anterior.
UPDATE barter_agreements
   SET platform_fee = ROUND(cash_difference * 0.15, 2)
 WHERE status IN ('proposed', 'active');
