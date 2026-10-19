-- Badges automáticas (RF-065, RN-053): as badges por entregas no prazo e por clientes que voltam
-- contam as contratações concluídas de um freelancer, e a segunda agrupa pelo cliente. O índice
-- (freelancer_id, status, client_id) leva o filtro direto às concluídas e resolve o agrupamento sem
-- ler a linha. O (freelancer_id, created_at) da 0007 fica: é o das listas por recência. As trocas
-- concluídas usam os índices de proponente e de receptor que já existem.
-- Só DDL, num ALTER só (atômico no MySQL 8). Quem já cumpria um critério antes desta versão ganha
-- a badge na reavaliação (npm run -w @escambo/api badges:reevaluate), não aqui.
ALTER TABLE contracts
  ADD INDEX idx_contract_freelancer_status (freelancer_id, status, client_id);
