-- Listagem de serviços (RNF-004, gargalo 1 de docs/desempenho.md): a busca pagina pelos ids
-- (deferred join) e só depois lê as linhas inteiras. Os dois índices servem a página de ids.
--
-- Os dois guardam tudo o que a página de ids lê de services numa busca sem texto: o filtro dos
-- ativos (is_active, deleted_at), a ordem padrão (created_at, id) e as colunas dos outros filtros
-- e ordenações (dono, categoria, preço, prazo, modalidade). A página sai do índice, sem ler a
-- linha do serviço, que carrega a descrição. O id vem explícito logo depois do
-- created_at para o índice já estar na ordem "mais recentes" (created_at DESC, id DESC) e o LIMIT
-- parar cedo; sem ele, o InnoDB o poria no fim, depois das outras colunas.
-- - idx_svc_listing começa pelos ativos: é o caminho da busca que percorre o catálogo.
-- - idx_svc_owner_listing começa pelo dono: é o caminho da busca que parte dos prestadores (perto
--   de mim, com o raio filtrando os perfis primeiro) e da lista de um prestador (perfil público).
-- Filtro ou ordenação nova na busca: a coluna entra nos dois, senão a página volta a ler a linha.
--
-- boosts fica como está: o conjunto dos serviços com destaque ativo, que a busca junta aos
-- serviços, sai do idx_boost_status do baseline em ~1 ms com 100 mil serviços; um índice composto
-- ali não mudou a medição.
--
-- Aditiva: os índices antigos ficam. ADD INDEX é online no MySQL 8 (INPLACE, sem travar as
-- gravações; poucos segundos com 100 mil serviços). DDL confirma sozinho: se o processo cair antes
-- de registrar a migration, a próxima execução vê em information_schema os índices já criados e
-- cria só os que faltam.
SET @listagem_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'services'
       AND index_name = 'idx_svc_listing'
  ),
  'SELECT 1',
  'ALTER TABLE services ADD INDEX idx_svc_listing (is_active, deleted_at, created_at, id, user_id, category_id, price, delivery_days, is_remote, is_onsite)'
);
PREPARE escambo_listagem_migration FROM @listagem_sql;
EXECUTE escambo_listagem_migration;
DEALLOCATE PREPARE escambo_listagem_migration;

SET @listagem_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'services'
       AND index_name = 'idx_svc_owner_listing'
  ),
  'SELECT 1',
  'ALTER TABLE services ADD INDEX idx_svc_owner_listing (user_id, is_active, deleted_at, created_at, id, category_id, price, delivery_days, is_remote, is_onsite)'
);
PREPARE escambo_listagem_migration FROM @listagem_sql;
EXECUTE escambo_listagem_migration;
DEALLOCATE PREPARE escambo_listagem_migration;
