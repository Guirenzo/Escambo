-- Lembretes antes de cada vencimento (ADR 58), parte 1. A tabela vem ANTES do ALTER: o runner não usa
-- transação, CREATE TABLE IF NOT EXISTS é idempotente e o ALTER é um só (atômico no MySQL 8); se o
-- ALTER falhar, o arquivo roda de novo inteiro sem efeito duplicado.
--
-- deadline_reminders: o livro dos lembretes. Uma linha por (tipo, objeto, vencimento, armação),
-- gravada na MESMA transação que confere o estado e grava a notificação: no máximo uma vez. Um
-- vencimento novo (extensão aceita, nova entrega, novo pedido, nova revisão) é uma chave nova, e não
-- há nada para zerar. Sem user_id e sem dado pessoal: quem foi avisado está em notifications.
--   entity_id  contracts.id; contract_milestones.id nos tipos milestone_*
--   due_at     o vencimento lembrado; nos tipos de revisão, a hora do pedido (o aviso sai 7 dias depois)
--   seq        número da armação quando o vencimento sozinho não a identifica: no pedido de extensão
--              é extension_requests (dois pedidos para a mesma data têm a mesma hora de resposta);
--              nos demais, 0
CREATE TABLE IF NOT EXISTS deadline_reminders (
  id        BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  kind      ENUM('proposal', 'delivery', 'approval', 'milestone_approval', 'extension',
                 'revision', 'milestone_revision') NOT NULL,
  entity_id BIGINT UNSIGNED  NOT NULL,
  due_at    DATETIME         NOT NULL,
  seq       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at   DATETIME         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deadline_reminder (kind, entity_id, due_at, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- revision_requested_at: quando o cliente pediu a revisão em aberto (aviso de revisão parada, ADR 58).
-- O preenchimento das contratações já em revisão é do reparo (jobs/repair-deadlines.ts), em Node.
ALTER TABLE contracts
  ADD COLUMN revision_requested_at DATETIME NULL AFTER proposal_expires_at,
  ADD INDEX idx_contract_status_revision (status, revision_requested_at);
