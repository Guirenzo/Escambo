-- Direitos do titular (LGPD) processados de verdade.
-- A recusa de uma solicitação de exclusão precisa de justificativa visível ao titular.
ALTER TABLE data_deletion_requests
  ADD COLUMN admin_note VARCHAR(500) NULL AFTER status;
