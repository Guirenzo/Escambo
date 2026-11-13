-- Mantém os metadados de entrega e remove as credenciais de recuperação dos registros antigos.
UPDATE email_outbox
   SET text_body = 'Link de redefinição protegido.',
       html_body = '',
       error = CASE WHEN error IS NOT NULL THEN 'Falha no envio do e-mail de redefinição.' END
 WHERE template = 'password_reset';
