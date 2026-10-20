-- Catálogos do seed com chave única (ADR 63). O seed.sql termina os INSERTs de missions e de
-- boost_plans com ON DUPLICATE KEY UPDATE, mas as duas tabelas não tinham chave única além do id:
-- rodar o seed de novo (o CI roda depois do migrate, e um operador pode reaplicá-lo) duplicava
-- o catálogo. Com as missões da 1.45.0, a duplicata virou XP em dobro: duas "Resposta rápida",
-- cumpridas juntas. Aqui cada título de missão e cada nome de plano fica um só.
--
-- Para cada grupo repetido fica o menor id. O progresso das missões repetidas passa para a que
-- fica quando ela ainda não tem linha naquele período; a que sobra sai (o XP já creditado fica no
-- extrato, que é imutável, ADR 63). Os impulsionamentos apontam para o plano que fica. Depois, as
-- chaves únicas impedem que volte a acontecer.
--
-- Pode rodar de novo: sem repetidos os UPDATE/DELETE não acham nada, e as chaves são conferidas
-- no information_schema antes de criar.

CREATE TEMPORARY TABLE IF NOT EXISTS tmp_catalogo_missoes AS
  SELECT title, MIN(id) AS keep_id FROM missions GROUP BY title;

UPDATE user_missions um
  JOIN missions m ON m.id = um.mission_id
  JOIN tmp_catalogo_missoes k ON k.title = m.title AND k.keep_id <> m.id
  LEFT JOIN user_missions kept
    ON kept.user_id = um.user_id AND kept.mission_id = k.keep_id AND kept.period_key = um.period_key
   SET um.mission_id = k.keep_id
 WHERE kept.id IS NULL;

DELETE um FROM user_missions um
  JOIN missions m ON m.id = um.mission_id
  JOIN tmp_catalogo_missoes k ON k.title = m.title AND k.keep_id <> m.id;

DELETE m FROM missions m
  JOIN tmp_catalogo_missoes k ON k.title = m.title AND k.keep_id <> m.id;

DROP TEMPORARY TABLE IF EXISTS tmp_catalogo_missoes;

CREATE TEMPORARY TABLE IF NOT EXISTS tmp_catalogo_planos AS
  SELECT name, MIN(id) AS keep_id FROM boost_plans GROUP BY name;

UPDATE boosts b
  JOIN boost_plans p ON p.id = b.plan_id
  JOIN tmp_catalogo_planos k ON k.name = p.name AND k.keep_id <> p.id
   SET b.plan_id = k.keep_id;

DELETE p FROM boost_plans p
  JOIN tmp_catalogo_planos k ON k.name = p.name AND k.keep_id <> p.id;

DROP TEMPORARY TABLE IF EXISTS tmp_catalogo_planos;

SET @catalogo_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'missions'
       AND index_name = 'uq_missions_title'
  ),
  'SELECT 1',
  'ALTER TABLE missions ADD UNIQUE KEY uq_missions_title (title)'
);
PREPARE escambo_catalogo_migration FROM @catalogo_sql;
EXECUTE escambo_catalogo_migration;
DEALLOCATE PREPARE escambo_catalogo_migration;

SET @catalogo_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'boost_plans'
       AND index_name = 'uq_boost_plans_name'
  ),
  'SELECT 1',
  'ALTER TABLE boost_plans ADD UNIQUE KEY uq_boost_plans_name (name)'
);
PREPARE escambo_catalogo_migration FROM @catalogo_sql;
EXECUTE escambo_catalogo_migration;
DEALLOCATE PREPARE escambo_catalogo_migration;
