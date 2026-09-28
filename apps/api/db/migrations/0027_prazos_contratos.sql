-- Prazos de dia (ADR 57), parte 1: contratações. Só DDL, num ALTER só (atômico no MySQL 8): se
-- falhar, nada muda e a migration roda de novo. O preenchimento das contratações em andamento NÃO
-- fica aqui: o reparo (jobs/repair-deadlines.ts) faz em Node, com as mesmas funções de hora que a
-- API usa ao gravar, no fim do db:migrate e em toda rodada dos jobs (cobre também os segundos em
-- que a API antiga ainda grava, durante o deploy).
--   extension_requests    pedidos de extensão feitos (RN-028: até 2, um aceito); é também o
--                         número do pedido no compare-and-set da decisão do cliente
--   extension_respond_by  até quando o cliente responde; passou, o pedido expira ('expired')
--   'closed'              pedido encerrado porque a contratação saiu da vez de quem entrega
--   grace_ends_at         fim da carência da RN-029, gravado no aviso: a hora avisada é a cumprida
--   approval_due_at       aprovação tácita da entrega única (RN-024), gravada na entrega
--   proposal_expires_at   validade da proposta (RN-021), gravada na criação
-- Os instantes gravados caem entre 9h e 20h30 no fuso de quem é afetado. Membros novos NO FIM do ENUM.
ALTER TABLE contracts
  MODIFY COLUMN extension_status ENUM('none', 'pending', 'accepted', 'declined', 'expired', 'closed') NOT NULL DEFAULT 'none',
  ADD COLUMN extension_requests   TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER extension_status,
  ADD COLUMN extension_respond_by DATETIME         NULL AFTER extension_requested_at,
  ADD COLUMN grace_ends_at        DATETIME         NULL AFTER overdue_notified_at,
  ADD COLUMN approval_due_at      DATETIME         NULL AFTER grace_ends_at,
  ADD COLUMN proposal_expires_at  DATETIME         NULL AFTER approval_due_at,
  ADD INDEX idx_contract_status_grace      (status, grace_ends_at),
  ADD INDEX idx_contract_status_approval   (status, approval_due_at),
  ADD INDEX idx_contract_status_proposal   (status, proposal_expires_at),
  ADD INDEX idx_contract_extension_respond (extension_status, extension_respond_by);
