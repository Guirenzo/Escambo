-- O que sai durante o "não perturbe" (ADR 56). A plataforma mantém a lista fechada do que PODE
-- sair (hoje só 'deadline': o prazo vencido num trabalho que a pessoa entrega, com a mediação
-- automática da RN-029 contando); a pessoa escolhe o que SAI.
-- NULL = nunca escolheu, e vale como nada (falha fechada): quem ligou o silêncio sob a Política
-- 1.3 ("nenhum aviso bate") continua assim até marcar, e uma API ou um web antigos no ar durante
-- o deploy não gravam nada aqui. '' = escolheu que nada sai. A opção vem marcada pela tela no
-- gesto de ligar o silêncio, com a caixa visível — nunca pelo banco.
-- SET, e não JSON, bitmask ou tabela: o banco recusa categoria desconhecida (modo estrito), o
-- Adminer mostra o nome, e um membro novo NO FIM da lista (até 8) é só metadado. Cada categoria
-- nova exige ADR e versão da Política de Privacidade.
ALTER TABLE users
  ADD COLUMN push_quiet_pass SET('deadline') NULL DEFAULT NULL AFTER push_quiet_end;
