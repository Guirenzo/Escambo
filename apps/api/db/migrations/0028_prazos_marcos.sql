-- Prazos de dia (ADR 57), parte 2: marcos. A aprovação tácita de cada marco (RN-024 e RN-069)
-- passa a ter a hora gravada na entrega, entre 9h e 20h30 no fuso do cliente; a revisão a zera, e
-- a nova entrega grava outra. Um ALTER só, como na 0027.
ALTER TABLE contract_milestones
  ADD COLUMN approval_due_at DATETIME NULL AFTER delivered_at,
  ADD INDEX idx_milestone_status_approval (status, approval_due_at);
