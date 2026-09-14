-- Anexos no chat (ADR 29): imagem ou arquivo por mensagem. As colunas type/file_url/file_name/
-- file_size_bytes já existiam no baseline sem uso; file_url passa a guardar a CHAVE do arquivo
-- no armazenamento da API (DATA_DIR/uploads), servido só às partes por
-- GET /messaging/attachments/:id — nunca uma URL pública. O tipo real (reconhecido pelos
-- primeiros bytes, não pela extensão) fica em file_mime.
ALTER TABLE messages
  ADD COLUMN file_mime VARCHAR(100) NULL AFTER file_url;
