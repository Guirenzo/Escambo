-- Escrow por marcos (RN-069): cada marco tem o próprio líquido (o último absorve o
-- arredondamento para a soma bater com freelancer_net), a entrega (data + mensagem) e a
-- nota de revisão pedida pelo cliente.
ALTER TABLE contract_milestones
  ADD COLUMN freelancer_net DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER amount,
  ADD COLUMN delivered_at   DATETIME NULL AFTER due_at,
  ADD COLUMN delivery_note  TEXT     NULL AFTER delivered_at,
  ADD COLUMN revision_note  TEXT     NULL AFTER delivery_note;
