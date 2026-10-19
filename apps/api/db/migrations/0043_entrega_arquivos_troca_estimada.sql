-- Entrega com arquivo (RF-035) e troca estimada pelo catálogo (RF-084), 1.45.0.
--
-- delivery_files: cada arquivo de uma entrega é um anexo do chat do par (ADR 29). A linha em
-- messages guarda a chave no disco, o nome, o tipo, o tamanho, o expurgo (ADR 31) e a remoção pela
-- moderação (ADR 44); esta tabela só diz de que entrega ele é: a entrega única (delivery_id, uma
-- linha de deliveries por entrega e reentrega) ou a entrega de um marco (milestone_id). Exatamente
-- um dos dois é preenchido; quem garante é a API, porque o MySQL não aceita CHECK em coluna com
-- ação de chave estrangeira. contract_id repete o contrato para a Sala achar tudo com um índice.
-- Tabela nova e vazia: não trava nada, e CREATE TABLE IF NOT EXISTS pode rodar de novo.
CREATE TABLE IF NOT EXISTS delivery_files (
  message_id   BIGINT UNSIGNED NOT NULL,
  contract_id  BIGINT UNSIGNED NOT NULL,
  delivery_id  BIGINT UNSIGNED NULL,
  milestone_id BIGINT UNSIGNED NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (message_id),
  INDEX idx_df_contract  (contract_id, message_id),
  INDEX idx_df_delivery  (delivery_id),
  INDEX idx_df_milestone (milestone_id),
  CONSTRAINT fk_df_message   FOREIGN KEY (message_id)   REFERENCES messages(id)            ON DELETE CASCADE,
  CONSTRAINT fk_df_contract  FOREIGN KEY (contract_id)  REFERENCES contracts(id)           ON DELETE CASCADE,
  CONSTRAINT fk_df_delivery  FOREIGN KEY (delivery_id)  REFERENCES deliveries(id)          ON DELETE CASCADE,
  CONSTRAINT fk_df_milestone FOREIGN KEY (milestone_id) REFERENCES contract_milestones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Troca (RF-084): de onde veio o valor de cada lado. 'catalog' = preço fechado do serviço no
-- catálogo, conferido pela API; 'informed' = digitado pelo proponente (serviço a combinar, por hora,
-- sem preço, ou oferta descrita). NULL nas trocas anteriores, em que os dois valores eram digitados:
-- a API as mostra como 'informed'. Só acrescenta colunas; a tabela é pequena.
-- DDL confirma sozinho: se o processo cair antes de registrar a migration, a próxima execução só
-- acrescenta o que falta.
SET @barter_source_parts = CONCAT_WS(', ',
  IF((SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'barter_agreements'
         AND column_name = 'offered_value_source') = 0,
     'ADD COLUMN offered_value_source ENUM(''catalog'', ''informed'') NULL AFTER estimated_value_requested', NULL),
  IF((SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'barter_agreements'
         AND column_name = 'requested_value_source') = 0,
     'ADD COLUMN requested_value_source ENUM(''catalog'', ''informed'') NULL AFTER estimated_value_requested', NULL)
);
SET @barter_source_sql = IF(@barter_source_parts = '', 'SELECT 1',
                            CONCAT('ALTER TABLE barter_agreements ', @barter_source_parts));
PREPARE escambo_barter_source_migration FROM @barter_source_sql;
EXECUTE escambo_barter_source_migration;
DEALLOCATE PREPARE escambo_barter_source_migration;
