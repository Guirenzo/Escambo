-- Horário de atendimento (ADR 34): por dia marcado em available_days, os períodos em que o
-- freelancer atende — JSON objeto {"1": ["morning", "afternoon"], "6": ["evening"]}.
-- Dia sem chave = o dia todo (compatível com quem já tinha só os dias). Períodos, no horário
-- de Brasília: morning 06–12, afternoon 12–18, evening 18–24.
ALTER TABLE profiles_freelancer
  ADD COLUMN available_periods JSON NULL AFTER available_days;
