-- Cifragem de campo (RNF-017): com FIELD_ENCRYPTION_KEY configurada, a API grava a chave PIX e os
-- dados bancários dos saques cifrados (AES-256-GCM), no formato enc:v1:<chave>:<iv>:<tag>:<cifra>
-- em base64url, com 56 + ⌈4·bytes/3⌉ caracteres. As colunas crescem para caber o maior valor que a
-- API aceita depois de cifrado (até 3 bytes por caractere em UTF-8): pixKey 255 → 1076,
-- bankName 100 → 456, bankAgency 10 → 96, bankAccount 20 → 136, com folga.
-- Só aumenta: as linhas em texto puro cabem como estão e continuam legíveis. Esta migration não
-- cifra nada; as linhas antigas são cifradas depois, com a chave, pelo fields:encrypt.
-- Nenhuma consulta busca, compara ou indexa pelo valor dessas colunas (a 0036 só olha
-- pix_key IS NULL, que continua valendo), então o IV aleatório não quebra nada.
-- Agência e conta passam de 255 bytes: o MySQL recria a tabela (curto, mas trava gravações nela).
-- DDL confirma sozinho: se o processo cair antes de registrar a migration, a próxima execução só
-- aumenta o que ainda for menor.
SET @withdrawal_crypto_parts = CONCAT_WS(', ',
  IF((SELECT character_maximum_length FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND column_name = 'bank_name') < 500,
     'MODIFY COLUMN bank_name VARCHAR(500) NULL', NULL),
  IF((SELECT character_maximum_length FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND column_name = 'bank_agency') < 120,
     'MODIFY COLUMN bank_agency VARCHAR(120) NULL', NULL),
  IF((SELECT character_maximum_length FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND column_name = 'bank_account') < 160,
     'MODIFY COLUMN bank_account VARCHAR(160) NULL', NULL),
  IF((SELECT character_maximum_length FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
         AND column_name = 'pix_key') < 1100,
     'MODIFY COLUMN pix_key VARCHAR(1100) NULL', NULL)
);
SET @withdrawal_crypto_sql = IF(@withdrawal_crypto_parts = '', 'SELECT 1',
                                CONCAT('ALTER TABLE withdrawals ', @withdrawal_crypto_parts));
PREPARE escambo_withdrawal_crypto_migration FROM @withdrawal_crypto_sql;
EXECUTE escambo_withdrawal_crypto_migration;
DEALLOCATE PREPARE escambo_withdrawal_crypto_migration;
