-- Catálogo e busca (1.44.0), RF-023: além de remoto ou presencial, o serviço pode atender dos
-- dois jeitos. is_remote continua sendo "atende remoto" (quem só lê ou só grava is_remote segue
-- funcionando) e is_onsite passa a dizer "atende presencial"; "os dois" é is_remote = 1 e
-- is_onsite = 1. O DEFAULT (1 - is_remote) preenche as linhas que já existem no próprio ALTER e
-- vale também para quem grava sem a coluna nova: serviço que não é remoto é presencial.
-- As tags (RF-024) usam service_tags e service_tag_pivot do baseline, que já têm os índices da
-- busca (UNIQUE do nome para o prefixo, PK e FK do pivô); a busca de texto usa o FULLTEXT
-- ft_svc_search do baseline. Nada disso precisa de DDL aqui.
-- DDL MySQL confirma implicitamente: se o processo cair antes de registrar a migration, a próxima
-- execução não tenta criar a coluna de novo.
SET @catalog_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'services'
            AND column_name = 'is_onsite'),
  'SELECT 1',
  'ALTER TABLE services ADD COLUMN is_onsite TINYINT(1) NOT NULL DEFAULT (1 - is_remote) AFTER is_remote'
);
PREPARE escambo_catalog_migration FROM @catalog_sql;
EXECUTE escambo_catalog_migration;
DEALLOCATE PREPARE escambo_catalog_migration;
