-- Índices das consultas quentes: todas as listas do produto filtram por dono e ordenam por
-- recência com LIMIT/OFFSET. Índices de uma coluna só resolvem o filtro e deixam a ordenação
-- para um filesort; os compostos abaixo resolvem as duas coisas.
--
-- Onde o índice antigo virou prefixo do novo, ele é removido (redundante, e todo INSERT paga
-- por índice). A ordem importa: o composto entra antes, para as chaves estrangeiras nunca
-- ficarem sem índice.

-- Notificações: lista por usuário (ORDER BY id DESC) e contagem de não lidas.
ALTER TABLE notifications
  ADD INDEX idx_notif_user_recent (user_id, id),
  ADD INDEX idx_notif_user_unread (user_id, is_read);
ALTER TABLE notifications
  DROP INDEX idx_notif_user,
  DROP INDEX idx_notif_read;

-- Chat: mensagens de uma conversa em ordem cronológica.
ALTER TABLE messages ADD INDEX idx_msg_conv_recent (conversation_id, id);
ALTER TABLE messages DROP INDEX idx_msg_conversation;

-- Contratações: "minhas" é client_id OR freelancer_id, sempre por data.
ALTER TABLE contracts
  ADD INDEX idx_contract_client_recent (client_id, created_at),
  ADD INDEX idx_contract_freelancer_recent (freelancer_id, created_at);
ALTER TABLE contracts
  DROP INDEX idx_contract_client,
  DROP INDEX idx_contract_freelancer;

-- Extrato de créditos (o de reais já nasceu com (user_id, id) na 0002).
ALTER TABLE credit_transactions ADD INDEX idx_credit_tx_user_recent (user_id, id);
ALTER TABLE credit_transactions DROP INDEX idx_credit_tx_user;

-- Depósitos do usuário (kind = 'topup') e fila de saques do admin (por status, mais antigos primeiro).
ALTER TABLE payments ADD INDEX idx_pay_payer_recent (payer_id, kind, id);
ALTER TABLE payments DROP INDEX idx_pay_payer;

ALTER TABLE withdrawals
  ADD INDEX idx_wd_user_recent (user_id, created_at),
  ADD INDEX idx_wd_status_recent (status, created_at);
ALTER TABLE withdrawals
  DROP INDEX idx_wd_user,
  DROP INDEX idx_wd_status;
