-- Minimização (LGPD art. 6, III; ADR 54): o navegador do aparelho (user_agent) era gravado ao
-- ligar os avisos (ADR 52) e nunca foi lido por nada. A API deixa de gravar e o que existe é
-- apagado. Sem volta, de propósito: a Política de Privacidade 1.3 diz que esse dado não é
-- guardado, e o banco precisa ser verdade antes de o texto entrar no ar. A coluna fica vazia
-- (migrations aditivas, README.md desta pasta).
UPDATE push_subscriptions SET user_agent = NULL;
