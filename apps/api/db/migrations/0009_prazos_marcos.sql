-- Prazo por marco (RN-069 + RN-029): due_at já existia; agora é validado na criação (no futuro,
-- em ordem, nunca depois do prazo da contratação) e cobrado pelo job: marco financiado com prazo
-- vencido avisa as duas partes uma vez. A disputa automática continua sendo pelo prazo da
-- contratação — o marco atrasado é sinal, não sentença.
ALTER TABLE contract_milestones
  ADD COLUMN overdue_notified_at DATETIME NULL AFTER due_at,
  ADD INDEX idx_milestone_status_due (status, due_at);
