-- Perfil do freelancer mais rico (ADR 28): dias da semana em que atende (JSON com números
-- 0=domingo … 6=sábado; NULL = não informou). O portfólio usa a tabela que já existia
-- (freelancer_portfolio_items) e o tempo de resposta já era calculado pelo chat.
ALTER TABLE profiles_freelancer
  ADD COLUMN available_days JSON NULL AFTER is_available;
