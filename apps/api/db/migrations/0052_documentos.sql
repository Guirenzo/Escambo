-- Documentos (1.53.0): o CPF do freelancer (RF-020, RN-009, RN-075) e a conta de empresa (RF-018).
--
-- profiles_freelancer.cpf_verified existe desde o baseline e nunca foi usada. A API passa a gravar,
-- quando o freelancer informa o CPF e a data de nascimento no Perfil ("Dados para receber"):
--
--   cpf_encrypted    o CPF, só cifrado pela API com a FIELD_ENCRYPTION_KEY (AES-256-GCM, o texto
--                    `enc:v1:...` do field-crypto): sem a chave, nada é gravado;
--   cpf_index        o índice cego do CPF: HMAC-SHA256 com uma chave derivada da FIELD_ENCRYPTION_KEY
--                    (contexto próprio), em hex. Com IV aleatório, a coluna cifrada não se compara;
--                    é este valor que deixa a chave única recusar o mesmo CPF em duas contas;
--   birth_date       a data de nascimento (maior de 18, RN-009);
--   cpf_verified_at  quando passou na validação (dígitos verificadores, unicidade e idade; não é
--                    consulta à Receita). cpf_verified vira 1 no mesmo UPDATE.
--
-- profiles_company também existe desde o baseline sem código. company_name passa a ser a razão
-- social, e entra trade_name, o nome fantasia (o nome exibido). O cnpj continua VARCHAR(18) UNIQUE,
-- gravado com 14 caracteres em maiúsculas, sem máscara (aceita o CNPJ alfanumérico da IN RFB
-- 2.229/2024).
--
-- Só aditiva. Acrescentar colunas no fim é instantâneo no MySQL 8, e a chave única nasce sobre colunas
-- vazias. DDL confirma sozinho: se o processo cair no meio, a próxima execução confere o
-- information_schema e faz só o que falta; rodando de novo com tudo feito, nada muda.

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
       AND column_name = 'cpf_encrypted'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_freelancer ADD COLUMN cpf_encrypted VARCHAR(255) NULL'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
       AND column_name = 'cpf_index'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_freelancer ADD COLUMN cpf_index CHAR(64) NULL'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
       AND column_name = 'birth_date'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_freelancer ADD COLUMN birth_date DATE NULL'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
       AND column_name = 'cpf_verified_at'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_freelancer ADD COLUMN cpf_verified_at DATETIME NULL'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'profiles_freelancer'
       AND index_name = 'uq_pf_cpf_index'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_freelancer ADD UNIQUE KEY uq_pf_cpf_index (cpf_index)'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;

SET @doc_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'profiles_company'
       AND column_name = 'trade_name'
  ),
  'SELECT 1',
  'ALTER TABLE profiles_company ADD COLUMN trade_name VARCHAR(150) NULL'
);
PREPARE escambo_doc_migration FROM @doc_sql;
EXECUTE escambo_doc_migration;
DEALLOCATE PREPARE escambo_doc_migration;
