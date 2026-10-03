-- Lembretes (ADR 58), parte 2: quando o cliente pediu a revisão do marco. O marco volta a 'funded'
-- guardando delivered_at; a nova entrega não zera esta coluna (o status sai de 'funded' e o marco deixa
-- de ser candidato), e uma nova revisão a reescreve. Um ALTER só, como na 0028.
ALTER TABLE contract_milestones
  ADD COLUMN revision_requested_at DATETIME NULL AFTER approval_due_at,
  ADD INDEX idx_milestone_status_revision (status, revision_requested_at);
