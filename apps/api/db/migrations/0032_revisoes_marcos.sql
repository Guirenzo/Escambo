-- Regras pendentes (ADR 61), parte 2. Limite nulo mantém revisões antigas sem
-- limite; os contadores comportam a revisão 256. A abertura da disputa é gravada
-- por marco e não anda para frente quando ele é revisado/reentregue (RN-062).
-- Um único ALTER atômico, sem preenchimento do histórico em SQL.
ALTER TABLE contract_milestones
  ADD COLUMN revision_limit INT UNSIGNED NULL AFTER revision_requested_at,
  ADD COLUMN revisions_used INT UNSIGNED NOT NULL DEFAULT 0 AFTER revision_limit,
  ADD COLUMN dispute_opens_at DATETIME NULL AFTER revisions_used;
