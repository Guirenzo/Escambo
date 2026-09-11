-- Prazos (RN-021, RN-028, RN-029): a contratação já tinha deadline_at, mas nada o cobrava.
--
-- Extensão de prazo (RN-028): o freelancer pede UMA vez, o cliente aceita ou recusa no app.
--   extension_status      none | pending | accepted | declined (o último pedido)
--   extension_deadline_at prazo proposto; vira deadline_at se o cliente aceitar
--   deadline_extended_at  preenchido no aceite — trava a segunda extensão
-- Prazo estourado (RN-029): overdue_notified_at marca o aviso às duas partes; passado o período
-- de carência (deadline_grace_hours) sem entrega nem extensão, a plataforma abre a disputa.
ALTER TABLE contracts
  ADD COLUMN extension_status       ENUM('none', 'pending', 'accepted', 'declined') NOT NULL DEFAULT 'none' AFTER deadline_at,
  ADD COLUMN extension_deadline_at  DATETIME     NULL AFTER extension_status,
  ADD COLUMN extension_reason       VARCHAR(500) NULL AFTER extension_deadline_at,
  ADD COLUMN extension_requested_at DATETIME     NULL AFTER extension_reason,
  ADD COLUMN extension_resolved_at  DATETIME     NULL AFTER extension_requested_at,
  ADD COLUMN deadline_extended_at   DATETIME     NULL AFTER extension_resolved_at,
  ADD COLUMN overdue_notified_at    DATETIME     NULL AFTER deadline_extended_at;

-- Varreduras dos jobs: propostas paradas (status + criação) e prazos vencidos (status + prazo).
ALTER TABLE contracts
  ADD INDEX idx_contract_status_created  (status, created_at),
  ADD INDEX idx_contract_status_deadline (status, deadline_at);

-- Parâmetros da plataforma (também no seed, para bancos novos).
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('proposal_expiry_hours', '72', 'integer', 'Horas para o freelancer responder a uma proposta; depois ela expira e a reserva volta ao cliente (RN-021)'),
  ('deadline_grace_hours',  '24', 'integer', 'Horas após o aviso de prazo estourado sem entrega nem extensão até a plataforma abrir a disputa (RN-029)')
ON DUPLICATE KEY UPDATE description = VALUES(description);
