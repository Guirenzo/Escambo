-- Regras pendentes (ADR 61), parte 3: lembrete na vez de o cliente responder a
-- uma contraproposta (RN-079). Membro novo no fim: os antigos mantêm a posição.
ALTER TABLE deadline_reminders
  MODIFY COLUMN kind ENUM('proposal', 'delivery', 'approval', 'milestone_approval', 'extension',
                          'revision', 'milestone_revision', 'counter_offer') NOT NULL;
