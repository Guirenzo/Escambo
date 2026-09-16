-- Fuso horário por pessoa (ADR 46). timezone é o fuso IANA da conta, entre os do Brasil
-- (America/Noronha, America/Sao_Paulo, America/Cuiaba, America/Manaus, America/Rio_Branco); NULL
-- segue America/Sao_Paulo. A hora do resumo do dia (digest_hour), o alerta diário das buscas salvas
-- e as datas nos avisos passam a valer nesse fuso.
ALTER TABLE users
  ADD COLUMN timezone VARCHAR(40) NULL AFTER digest_hour;
