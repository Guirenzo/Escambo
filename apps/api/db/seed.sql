-- =====================================================================
-- Escambo — Seed de dados de referência (catálogo)
-- Roda DEPOIS de schema.sql. Idempotente via INSERT ... ON DUPLICATE KEY.
-- =====================================================================

USE escambo;
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Categorias (raízes)
-- ---------------------------------------------------------------------
INSERT INTO service_categories (id, parent_id, name, slug, sort_order, is_active) VALUES
  (1, NULL, 'Tecnologia',           'tecnologia',           1, 1),
  (2, NULL, 'Design',               'design',               2, 1),
  (3, NULL, 'Reformas e Reparos',   'reformas-reparos',     3, 1),
  (4, NULL, 'Aulas e Cursos',       'aulas-cursos',         4, 1),
  (5, NULL, 'Serviços Domésticos',  'servicos-domesticos',  5, 1),
  (6, NULL, 'Marketing',            'marketing',            6, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Subcategorias
INSERT INTO service_categories (id, parent_id, name, slug, sort_order, is_active) VALUES
  (10, 1, 'Desenvolvimento Web',  'desenvolvimento-web',  1, 1),
  (11, 1, 'Aplicativos Mobile',   'aplicativos-mobile',   2, 1),
  (12, 1, 'Suporte Técnico',      'suporte-tecnico',      3, 1),
  (13, 2, 'Identidade Visual',    'identidade-visual',    1, 1),
  (14, 2, 'UI/UX Design',         'ui-ux-design',         2, 1),
  (15, 3, 'Elétrica',             'eletrica',             1, 1),
  (16, 3, 'Hidráulica',           'hidraulica',           2, 1),
  (17, 3, 'Pintura',              'pintura',              3, 1),
  (18, 5, 'Diarista / Faxina',    'diarista-faxina',      1, 1),
  (19, 6, 'Social Media',         'social-media',         1, 1),
  (20, 6, 'Tráfego Pago',         'trafego-pago',         2, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------------
-- Badges (catálogo) — `criteria` em JSON
-- ---------------------------------------------------------------------
INSERT INTO badges (name, slug, description, xp_reward, criteria, is_active) VALUES
  ('First Deal',      'first-deal',      'Concluiu o primeiro serviço',                 50,  JSON_OBJECT('contracts_completed', 1),                       1),
  ('Fast Delivery',   'fast-delivery',   'Entrega consistentemente dentro do prazo',    100, JSON_OBJECT('on_time_deliveries', 20),                       1),
  ('Top Rated',       'top-rated',       '50+ avaliações com média maior ou igual a 4.5', 200, JSON_OBJECT('reviews_min', 50, 'avg_rating_min', 4.5),     1),
  ('Client Favorite', 'client-favorite', 'Recontratado por 5 clientes diferentes',      150, JSON_OBJECT('repeat_clients', 5),                            1),
  ('Bom de Troca',    'bom-de-troca',    'Concluiu 5 trocas de serviço (escambo)',      120, JSON_OBJECT('barters_completed', 5),                         1)
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Missions (catálogo) — `criteria` em JSON
-- ---------------------------------------------------------------------
INSERT INTO missions (title, description, xp_reward, type, criteria, is_active) VALUES
  ('Maratona da semana',  'Conclua 3 serviços nesta semana',                 200, 'weekly', JSON_OBJECT('action', 'complete_contracts', 'count', 3),  1),
  ('Resposta rápida',     'Responda propostas em menos de 2 horas',          100, 'weekly', JSON_OBJECT('action', 'fast_response_hours', 'count', 2), 1),
  ('Presença diária',     'Acesse a plataforma hoje',                        10,  'daily',  JSON_OBJECT('action', 'daily_login', 'count', 1),         1),
  ('Primeira troca',      'Feche sua primeira troca de serviço',             150, 'achievement', JSON_OBJECT('action', 'complete_barter', 'count', 1), 1)
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Planos de impulsionamento
-- ---------------------------------------------------------------------
INSERT INTO boost_plans (name, description, duration_days, price, features, is_active) VALUES
  ('Destaque 7 dias',  'Topo da busca na sua categoria por 7 dias',  7,  29.90, JSON_OBJECT('top_search', true, 'badge', 'Destaque'),                  1),
  ('Destaque 30 dias', 'Topo da busca + selo por 30 dias',           30, 99.90, JSON_OBJECT('top_search', true, 'badge', 'Destaque', 'homepage', true), 1)
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ---------------------------------------------------------------------
-- Configurações globais da plataforma
-- ---------------------------------------------------------------------
INSERT INTO platform_settings (key_name, value, type, description) VALUES
  ('platform_fee_percentage', '15',    'integer', 'Comissão (%) cobrada do freelancer sobre o valor bruto'),
  ('min_withdrawal_amount',   '20.00', 'decimal', 'Valor mínimo de saque (R$)'),
  ('min_service_price',       '10.00', 'decimal', 'Preço mínimo de um serviço (R$)'),
  ('tacit_approval_days',     '5',     'integer', 'Dias úteis para aprovação tácita da entrega'),
  ('max_boost_days',          '30',    'integer', 'Duração máxima de um impulsionamento'),
  ('ranking_radius_km',       '50',    'integer', 'Raio (km) do ranking local'),
  ('barter_enabled',          'true',  'boolean', 'Habilita a troca de serviços (escambo)'),
  ('maintenance_mode',        'false', 'boolean', 'Modo de manutenção da plataforma')
ON DUPLICATE KEY UPDATE value = VALUES(value);
