-- "Não perturbe" nos avisos do navegador (ADR 54). Janela de silêncio em horas cheias (0 a 23), no
-- fuso da conta (users.timezone, ADR 46), semiaberta como um horário de atendimento: 22 -> 7
-- silencia de 22:00:00 a 06:59:59 e cruza a meia-noite. NULL nas duas = desligado (padrão).
-- push_quiet_summary_id é a marca d'água do resumo ao fim do silêncio: avisos retidos até esse id
-- já foram resumidos (ou descartados ao desligar). Marca por id, e não por instante, porque o
-- DATETIME arredonda para o segundo e dois retidos no mesmo segundo se confundiriam.
-- O CHECK escreve os dois lados com IS NULL de propósito: em MySQL um CHECK que avalia como NULL
-- passa, e "um lado preenchido, o outro NULL" entraria sem isso.
ALTER TABLE users
  ADD COLUMN push_quiet_start      TINYINT UNSIGNED NULL AFTER timezone,
  ADD COLUMN push_quiet_end        TINYINT UNSIGNED NULL AFTER push_quiet_start,
  ADD COLUMN push_quiet_summary_id BIGINT UNSIGNED  NULL AFTER push_quiet_end,
  ADD CONSTRAINT chk_users_push_quiet CHECK (
    (push_quiet_start IS NULL) = (push_quiet_end IS NULL)
    AND (push_quiet_start IS NULL
         OR (push_quiet_start <= 23 AND push_quiet_end <= 23 AND push_quiet_start <> push_quiet_end))
  );

-- Aviso retido pelo silêncio: a própria notificação guarda o instante em que o push deixou de
-- sair. É a "fila" do resumo ao fim da janela, sem tabela nova. NULL = o push saiu, ou não cabia.
ALTER TABLE notifications
  ADD COLUMN push_held_at DATETIME NULL AFTER sent_at,
  ADD INDEX idx_notif_push_held (user_id, push_held_at);
