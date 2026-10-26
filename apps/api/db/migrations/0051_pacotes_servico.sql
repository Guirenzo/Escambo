-- Pacotes Básico, Padrão e Premium por serviço (RF-086, RN-068, ADR 69). A tabela service_packages
-- existe desde o baseline (schema.sql), sem código; o CREATE abaixo é o mesmo do baseline e só age
-- num banco que, por algum motivo, não a tenha. A chave única (service_id, tier) é a que garante um
-- pacote por nível: a API grava os pacotes com upsert nela.
--
-- A contratação de um pacote guarda o nível e uma cópia do pacote como estava publicado (nome,
-- descrição, preço, prazo, revisões e itens): editar ou tirar o pacote depois não muda o que foi
-- contratado. As duas colunas ficam NULL nas contratações sem pacote e nas antigas.
--
--   package_tier      basic, standard ou premium; NULL sem pacote;
--   package_snapshot  o pacote em JSON ({tier,name,description,price,deliveryDays,revisions,features}).
--
-- Só aditiva. Acrescentar colunas no fim é instantâneo no MySQL 8. DDL confirma sozinho: se o
-- processo cair no meio, a próxima execução confere o information_schema e faz só o que falta;
-- rodando de novo com tudo feito, nada muda.
CREATE TABLE IF NOT EXISTS service_packages (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id    BIGINT UNSIGNED NOT NULL,
  tier          ENUM('basic', 'standard', 'premium') NOT NULL,
  name          VARCHAR(100)    NOT NULL,
  description   TEXT            NULL,
  price         DECIMAL(10, 2)  NOT NULL,
  delivery_days INT UNSIGNED    NOT NULL,
  revisions     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  features      JSON            NULL,
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_service_tier (service_id, tier),
  INDEX idx_pkg_service (service_id),
  CONSTRAINT fk_pkg_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @pkg_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'service_packages'
       AND index_name = 'uq_service_tier'
  ),
  'SELECT 1',
  'ALTER TABLE service_packages ADD UNIQUE KEY uq_service_tier (service_id, tier)'
);
PREPARE escambo_pkg_migration FROM @pkg_sql;
EXECUTE escambo_pkg_migration;
DEALLOCATE PREPARE escambo_pkg_migration;

SET @pkg_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'contracts'
       AND column_name = 'package_tier'
  ),
  'SELECT 1',
  'ALTER TABLE contracts ADD COLUMN package_tier ENUM(''basic'', ''standard'', ''premium'') NULL'
);
PREPARE escambo_pkg_migration FROM @pkg_sql;
EXECUTE escambo_pkg_migration;
DEALLOCATE PREPARE escambo_pkg_migration;

SET @pkg_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'contracts'
       AND column_name = 'package_snapshot'
  ),
  'SELECT 1',
  'ALTER TABLE contracts ADD COLUMN package_snapshot JSON NULL'
);
PREPARE escambo_pkg_migration FROM @pkg_sql;
EXECUTE escambo_pkg_migration;
DEALLOCATE PREPARE escambo_pkg_migration;
