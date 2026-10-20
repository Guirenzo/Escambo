# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento
[semântico](https://semver.org/lang/pt-BR/). A versão que está no ar aparece em `GET /api/health`
(`version` e `commit`), e cada release publica as imagens `escambo-api` e `escambo-web` no GHCR
com as tags `latest`, o sha curto e a versão.

## [1.48.0] — 2026-10-20

Verificação em duas etapas por app autenticador (ADR 66). RF: 84 implementados, 1 parcial, 5 não implementados e 2 fora do escopo; RNF: 32, 7, 1 e 2.

### Adicionado

- **Verificação em duas etapas (RF-090, RNF-042):** no Perfil, o cartão "Verificação em duas etapas" ativa o código do app autenticador (Google Authenticator, Microsoft Authenticator, 1Password e outros). Mostra o QR e a chave em texto, confere o primeiro código e entrega 10 códigos de recuperação de uso único, para copiar ou baixar. Depois dá para gerar códigos novos ou desativar, com a senha e um código.
- **Login em dois passos:** numa conta com a verificação ligada, depois da senha vem o código do app ou um de recuperação. O mesmo código não vale duas vezes, e cinco erros seguidos travam a verificação da conta por 15 minutos.
- **Atendimento no painel admin:** o cartão "Atendimento: conta" busca a conta pelo e-mail e desativa a verificação de quem perdeu o celular e os códigos, com o motivo registrado; as sessões da conta caem e o titular recebe um e-mail.
- **`ADMIN_MFA_REQUIRED`:** ligada, o painel admin só abre para quem tem a verificação ativa.
- Avisos por e-mail ao ativar e ao desativar a verificação.

### Alterado

- `POST /auth/login` pode responder com o pedido do segundo fator (`mfaRequired`, `mfaToken`) em vez da sessão; a sessão sai em `POST /auth/login/mfa`.
- A cópia de dados (LGPD) passa ao formato 1.12, com a situação da verificação em duas etapas (sem o segredo).
- A anonimização apaga a verificação em duas etapas da conta.

### Segurança e dados

- O segredo do app é gravado só cifrado (AES-256-GCM, `FIELD_ENCRYPTION_KEY`): sem a chave, a verificação fica indisponível em vez de gravar texto puro. Os códigos de recuperação ficam só como hash.

### Para atualizar

Uma migration (0050). A verificação precisa da `FIELD_ENCRYPTION_KEY` no `.env`; depois de cada admin ativar no perfil, ligue `ADMIN_MFA_REQUIRED=true`. Passo a passo no DEPLOY.md ("Atualizar para a 1.48.0").

## [1.47.0] — 2026-10-20

Texto maior e mais espaçado sem perder conteúdo, e varredura de segredos no CI (ADR 65). RF: 83 implementados, 2 parciais, 5 não implementados e 2 fora do escopo; RNF: 32, 7, 1 e 2.

### Adicionado

- **Teste de texto a 200% e de espaçamento (WCAG 1.4.4 e 1.4.12):** `texto.a11y.spec.ts` abre 24 telas no computador e no celular e reprova texto cortado, texto sobre texto e rolagem lateral da página. Os dois critérios deixam de depender de conferência manual.
- **Varredura de segredos (RNF-020):** o job `segredos` confere que o `.gitignore` cobre `.env`, chaves, backups e dados da API, que nada disso está versionado, e roda o gitleaks em todos os commits. As exceções são por valor, em `.gitleaks.toml`. À mão: `bash scripts/segredos.sh`.

### Alterado

- Nomes, títulos, e-mails e nomes de arquivo quebram a linha em vez de serem cortados com reticências: nome da conta no menu, pódio do ranking, troca, anexo, link do portfólio e título da galeria.
- As grades de cartões têm a largura mínima da coluna em `rem`: com o texto maior, cabem menos colunas por linha. Os indicadores vão até 4 colunas, nenhuma abaixo de 13rem: 4 por linha a partir de 1280 px de tela, 3 um pouco abaixo disso (antes eram 2) e uma no celular.
- O tamanho base da fonte passa de `15px` fixo para `93.75%`: no padrão do navegador é o mesmo, e quem aumenta a fonte nas configurações do navegador passa a ver o site maior.

### Corrigido

- Com o texto a 200%, os valores dos indicadores (início, carteira, admin) invadiam o cartão vizinho, e o e-mail de acesso no perfil invadia o cartão do telefone.
- O e-mail longo no aviso de saque bloqueado fazia a carteira rolar na horizontal.
- No admin, a descrição da denúncia, o trecho denunciado, a nota da decisão, a descrição da disputa e o motivo do pedido de exclusão eram cortados em duas linhas, e o texto inteiro não aparecia em lugar nenhum. Agora aparecem inteiros.
- Nas listas de desistências e de remoções, com a tela estreita e o texto maior, o título passava por cima do botão: os botões descem para a linha de baixo.
- As iniciais do avatar no ranking eram lidas pelo leitor de tela, além do nome ao lado.

### Para atualizar

Nada a fazer na VPS: sem migration nem variável nova.

## [1.46.0] — 2026-10-20

Backup automático que volta, fronteiras entre módulos conferidas pelo lint e acessibilidade auditada critério a critério (ADR 64). RF: 83 implementados, 2 parciais, 5 não implementados e 2 fora do escopo; RNF: 32, 7, 1 e 2.

### Adicionado

- **Backup automático (RNF-009):** o serviço `backup` do compose faz, todo dia às 03:00 de Brasília, o dump do banco e o pacote dos arquivos da API, com `.sha256`, retenção de 7 dias e o resultado em `last-backup.json`, no log, no healthcheck e no alerta `BackupAtrasado` do Grafana. Sem cron na VPS.
- **Cópia fora da VPS (RNF-009):** o perfil opcional `offsite` manda os backups para um bucket S3 (DigitalOcean Spaces, AWS S3, B2) a cada hora, sem apagar nada no destino, com o alerta `BackupForaDaVpsAtrasado`.
- **Restauração testada no CI:** o job `backup` faz o backup como a produção, apaga o banco, restaura e confere linhas, estrutura e triggers. As imagens só são publicadas com ele verde.
- **Fronteiras entre módulos (RNF-021):** o lint reprova um módulo que importa o repository de outro, ou controller e routes que importam repository. Quem é de fora usa o service ou a fachada do módulo dono (13 fachadas). As 15 exceções ficam listadas com o motivo; eram 47 imports assim.
- **Auditoria de acessibilidade (RNF-029):** [docs/acessibilidade.md](./docs/acessibilidade.md) com os 50 critérios WCAG 2.1 A e AA, como cada um é atendido e provado, e o roteiro da verificação com leitor de tela. Novos testes de teclado de ponta a ponta e de estados no navegador.
- "Pular para o conteúdo" no início de toda tela.

### Alterado

- **Avisos (toasts) com tempo ajustável (WCAG 2.2.1):** o de erro fica até a pessoa fechar; os outros saem em 6 s, com o relógio parado enquanto o mouse está em cima ou o foco está dentro. Todos têm o botão de fechar, e no máximo cinco ficam na tela.
- O axe roda em todas as telas, no computador e no celular, e qualquer violação de critério WCAG reprova (antes, só `serious` e `critical`).
- Anel de foco sólido de 2 px com contraste de 3:1 ou mais em botões, campos e áreas de texto; contorno dos campos e trilho do interruptor com 3:1.
- O relatório de uso conta como atividade só as mudanças de status feitas pela pessoa, pela origem gravada no histórico (migration 0048), e não mais pelo texto da nota.

### Corrigido

- Nenhum backup feito desde a 1.45.0 voltava com um `mysql < dump` comum: os triggers da 0046 iam para o dump com um `;` a mais. A 0049 os recria em `BEGIN … END`, e o `restore-db.sh` conserta os dumps antigos na importação.
- A imagem ampliada do chat deixava o Tab sair para a página de trás e, ao fechar, o foco ia para o início do documento.
- No celular, as tabelas que rolam na horizontal não recebiam foco: sem mouse, as colunas da direita ficavam fora de alcance.
- Erros do login, de "esqueci a senha" e de "redefinir senha" só visuais, sem aviso ao leitor de tela; erro de campo sem `aria-invalid`.
- Ao abrir a Sala, a página inteira rolava até o chat.

### Para atualizar

Duas migrations (0048 e 0049), seguras de rodar de novo. Tire do cron as linhas de backup e crie a pasta `backups/`; os scripts de `deploy/backup/` chegam pelo workflow Deploy. Um dump de antes da 1.46.0 só volta pelo `restore-db.sh`. Passo a passo no DEPLOY.md ("Atualizar para a 1.46.0").

## [1.45.0] — 2026-10-19

Terceira leva da auditoria de requisitos (ADR 63): sobram só os requisitos que dependem de decisão do dono ou da VPS. RF: 83 implementados, 2 parciais, 5 não implementados e 2 fora do escopo; RNF: 30, 9, 1 e 2.

### Adicionado

- **Missões (RF-066, RF-063, RN-054):** diárias e semanais, no fuso da conta, com XP ao cumprir e um cartão no Início. O progresso de um período não passa para o seguinte.
- **Ranking por categoria e perto de mim (RF-067, RN-056):** top 10 por nota, depois concluídas, depois XP, num raio de 50 km configurável. Sem filtro, continua o ranking geral por XP.
- **Meus ganhos (RF-082):** na Carteira, o freelancer vê quanto recebeu por dia, semana ou mês, com o número de contratações pagas e o ticket médio. Créditos aparecem à parte.
- **Arquivos na entrega (RF-035):** a entrega, a reentrega e a entrega de marco aceitam até 10 arquivos, com download só pelas partes, retenção e moderação dos anexos do chat.
- **Troca de e-mail com confirmação e telefone (RF-017):** o e-mail novo só vale depois do clique no link enviado a ele, o antigo é avisado e as outras sessões caem. O telefone fica só para o titular.
- **Relatórios do admin (RF-081):** agrupar por semana, uso por período (novos usuários, contratações e usuários ativos) e um resumo de cada dia, semana e mês fechados gravado pelo job `report-snapshots`.
- **Histórico do gateway (RF-050):** cada resposta e cada webhook ficam em `payment_events`, sem dado pessoal.

### Alterado

- **Painel do admin (RF-076):** mostra os chamados de suporte (em aberto, aguardando a equipe, SLA vencido) e se atualiza sozinho a cada 30 s.
- **Troca estimada pelo sistema (RF-084, RN-066):** o lado com preço fechado vale o preço do catálogo, e um valor diferente é recusado. A tela mostra a torna antes de enviar.
- **Listagem de serviços (RNF-004):** com 100 mil serviços, a busca sem texto caiu de 761 ms para 66 ms. Toda ordenação passa a desempatar pelo id, e a busca por proximidade não repete nem pula serviço entre páginas.
- A cópia de dados (LGPD) passa ao formato 1.11, com os pedidos de troca de e-mail.

### Corrigido

- Os catálogos de missões e de planos de impulsionamento não tinham chave única, e o `seed.sql` reaplicado (o CI faz isso) os duplicava: com as missões, a mesma missão pagava o XP duas vezes. A 0047 junta os repetidos e cria as chaves (`uq_missions_title`, `uq_boost_plans_name`).

### Segurança e dados

- **Extrato imutável no banco (RNF-036):** triggers recusam alterar ou apagar lançamentos de R$, de créditos e do gateway.
- **Retenção (RNF-037):** o `audit_logs` só pode perder linha com mais de 90 dias, o expurgo opcional respeita esse piso, e o log dos containers de produção gira por tamanho.

### Para atualizar

Oito migrations (0040 a 0047). A 0046 cria triggers: o banco precisa subir com `log_bin_trust_function_creators=1`, que o compose já passa, e por isso o deploy recria o container do MySQL. A alternativa é um `SET PERSIST` antes. Passo a passo no DEPLOY.md ("Atualizar para a 1.45.0").

## [1.44.0] — 2026-10-19

Segunda leva da auditoria de requisitos: catálogo e busca, leitura no chat, prazo de saque, badges que faltavam, observabilidade (fora do ar, acesso negado, erros do navegador) e a primeira medição de desempenho.

### Adicionado

- **Leitura no chat (RF-059):** as mensagens que você mandou mostram ✓ Enviada ou ✓✓ Lida, em tempo real. A conversa é marcada como lida quando o destinatário a vê com a aba aberta.
- **Prazo de saque (RN-035, RF-046, RF-078):** PIX em até 1 dia útil e transferência em até 2, configuráveis no painel. O prazo aparece ao pedir o saque e na lista, e a fila do admin ordena pelo prazo e marca os atrasados.
- **Extrato de créditos com período e "Carregar mais" (RF-047)**, com o mesmo filtro do extrato em reais.
- **Tags nos serviços (RF-024, RN-018):** até 10 por serviço, de 2 a 30 caracteres; a busca acha pela tag, e clicar numa tag busca por ela.
- **Visualizações (RF-029):** a tela de detalhe do serviço (`/servicos/:id`, nova) conta quem abre, sem contar o dono nem a mesma pessoa duas vezes em 30 minutos; o número aparece em Meus serviços.
- **Remoto e presencial (RF-023):** a terceira opção de modalidade, que aparece nos dois filtros, e o filtro de modalidade na busca.
- **Badges que nunca saíam (RF-065, RN-053):** Fast Delivery (20 contratações entregues até o prazo), Client Favorite (5 clientes que voltaram) e Bom de Troca (5 trocas concluídas) passam a ser concedidas sozinhas, ao concluir uma contratação ou uma troca. Quem já cumpria antes desta versão ganha na reavaliação (`npm run -w @escambo/api badges:reevaluate`, uma vez depois do deploy).
- **Página de fora do ar (RNF-010):** com o web parado, o Caddy serve uma página estática que tenta de novo sozinha a cada 30 s; com a API parada, o app troca a tela pela de fora do ar até ela voltar.
- **Erros do navegador chegam à equipe (RNF-040):** tela quebrada, erro de script e promessa sem `catch` vão à API, que registra, conta na métrica `escambo_client_errors_total` (alerta "ErrosNoApp" no Grafana) e repassa ao Sentry quando ele está ligado.
- **Chave PIX e dados bancários cifrados (RNF-017):** com a `FIELD_ENCRYPTION_KEY` configurada, os destinos de saque são gravados em AES-256-GCM e lidos de volta só pela aplicação; `fields:encrypt` cifra os antigos. Sem a chave, nada muda e a API avisa na subida.
- **Acesso negado registrado (RNF-018):** a recusa por papel, dono ou conta barrada, o webhook com segredo errado e o login falho viram linhas no `audit_logs`, com o IP de quem chamou; o log de cada requisição passa a trazer o IP real e põe 401/403 em `warn`.

### Alterado

- **Busca pelo índice FULLTEXT (RNF-004, RNF-022):** com 100 mil serviços, a busca com texto caiu de 290–520 ms para 10–250 ms. Todas as palavras digitadas passam a ser exigidas, e a palavra vale como prefixo ("design" acha "designer", mas não "webdesign").
- **Manutenção com previsão de volta (RNF-010):** o parâmetro "Previsão de volta da manutenção", em minutos, aparece na tela de manutenção, no `Retry-After` e na mensagem do 503.
- Login de conta inexistente também passa pelo bcrypt: o tempo de resposta não revela se o e-mail tem conta.
- O botão de zoom da galeria do portfólio passa a ter o percentual fora de parênteses no nome acessível ("Tamanho inteiro: 100%"), achado pelo axe-core 4.14.

### Desempenho

- **Primeira medição de carga (RNF-001, RNF-002, RNF-005, RNF-023):** `scripts/carga/` (um comando, sem dependência nova) e [desempenho](./docs/desempenho.md), com método, máquina, números e gargalos. Numa máquina de desenvolvimento, até 200 leituras/s e 100 escritas/s o p95 ficou abaixo de 81 ms e 36 ms; 1000 conexões WebSocket ficaram de pé sem queda, com a mensagem da Sala chegando em p95 de até 34 ms. Com o banco saturado, algumas rotas passam das metas: o documento diz quais e por quê.
- `GET /wallet` deixa de abrir transação com trava em toda leitura para conferir o bônus de boas-vindas: era a leitura mais lenta sob concorrência.

### Para atualizar

Cinco migrations (0035 a 0039). Depois do deploy, rode uma vez `badges:reevaluate` e, com a chave configurada, `fields:encrypt`; a 0035 e a 0039 recriam `services` e `withdrawals` e travam gravações nelas por alguns segundos. Passo a passo no DEPLOY.md ("Atualizar para a 1.44.0") e decisões no ADR 62.

## [1.43.0] — 2026-10-19

Lacunas de interface e de fluxo achadas na auditoria de requisitos de 19/10/2026: cada RF e RNF conferido no código e nos testes, com a evidência e o que falta em `docs/rastreabilidade.md`.

### Adicionado

- **Entregas na Sala (RF-035):** o cliente passa a ver a mensagem de cada entrega (e os links, quando houver), da primeira à reentrega mais recente, e o aviso de entrega traz o começo da mensagem.
- **Meus serviços (RF-030):** aba própria com os pausados marcados e os botões pausar e reativar. Pausado sai da busca e não recebe proposta, mas continua abrindo pelo link (RN-013).
- **Formulário de serviço completo e edição (RF-022, RF-023):** tipo de preço (fixo, por hora ou a combinar), prazo de entrega em dias e modalidade remota ou presencial.
- **Saque por transferência bancária (RF-045)**, além do PIX.
- **Extrato com período e "Carregar mais" (RF-047)**, com os dias no horário da conta.
- **Lista de contratações com filtro por status, total certo e "Carregar mais" (RF-040).**
- **Conquistas e XP no perfil público (RF-015, RF-068)**, com as 3 mais recentes em destaque (RN-058).
- **Trocar a senha estando logado (RF-017):** encerra as outras sessões e avisa por e-mail.
- `docs/rastreabilidade.md` e a coluna de situação nos documentos de requisitos.

### Alterado

- O modal de contratar mostra a taxa real da plataforma e quanto vai ao freelancer, em vez de "85%" fixo (RF-043).
- Mensagens de erro legíveis: sem conexão e serviço fora do ar viram texto em português, em vez de "Failed to fetch" ou "Erro 502" (RNF-028).
- O botão de saque diz o mínimo configurado no painel, em vez de "R$20" fixo.
- O CI passa a conferir a formatação do código com o Prettier (RNF-032), e o OpenAPI documenta todas as rotas (RNF-031).

### Corrigido

- A 320 px de largura, o último ícone da barra de navegação inferior e o botão de enviar do chat da Sala saíam da tela; um teste de ponta a ponta passa a conferir as telas principais a 320 e a 768 px (RNF-026).
- O teste de ponta a ponta do "esqueci minha senha" falhava às vezes: preenchia o e-mail do login enquanto a tela ainda trocava.

## [1.42.0] — 2026-10-19

Implementação do ADR 61: as regras de negócio pendentes (RN-023, RN-026, RN-030 e RN-062), a conta suspensa só de leitura (RN-007), o suporte privado e a proposta única por par (RN-020). A demonstração pública muda quando o deploy for feito.

### Adicionado

- RN-020: uma contratação direta aberta por par cliente→freelancer em dinheiro/créditos, inclusive em envios simultâneos. A recusa não reserva saldo; a tela conserva o formulário e oferece abrir a contratação existente. Legados preservados, trocas independentes, sem migration nova.

- Suporte privado no app e no painel, disponível ao titular suspenso: categoria/assunto/contratação opcional, conversa paginada, notas internas restritas, até três chamados não encerrados, prioridade/SLA e encerramento cinco dias após resolução. Migration 0034 retomável, sem tocar no fluxo financeiro; Termos/Política 1.6, exportação 1.9 e anonimização dos textos de suporte.

- Negociação antes do aceite: até cinco ofertas em três rodadas, vez e validade por oferta, contraproposta de valor/prazo e dos mesmos marcos, prévia de reserva e histórico privado na Sala. Lembrete/expiração seguem o fuso de quem responde; a taxa conserva a da proposta inicial.
- Duas revisões incluídas por entrega única ou por marco, também em troca; o freelancer pode liberar mais uma quando o limite está esgotado. Contratos já registrados com limite NULL ficam ilimitados. Uma proposta de troca antiga aceita após a implantação cria dois contratos novos, cada um com duas revisões incluídas; a data da proposta de troca não torna esses contratos novos ilimitados.
- Janela da disputa manual: 48 h da primeira entrega, ou do aceite se não houve entrega, limitada pela tácita −24 h e mostrada na Sala; snapshots conservados em revisão/reentrega. A disputa automática continua independente.
- Desistências após aceite: somente contagem inclusiva dos últimos 60 dias no perfil/modal; três geram alerta e revisão humana. Confirmação pelo cliente em sete dias, contestação privada pelo titular e decisão auditada no painel; sem suspensão automática ou preenchimento retroativo.
- Reconciliação durável da revisão de desistências, com review_checked_at e job reconcile-dropout-reviews. Falhas posteriores não desfazem o cancelamento confirmado; uma conta com falha não bloqueia o lote inteiro.
- Parâmetros counter_offer_response_hours e extension_response_hours (padrão 48, faixa 24–168 h). Painel mostra para leitura as constantes das regras de revisão, ofertas, disputa e desistência.
- Termos de Uso 1.5, Política de Privacidade 1.5 e exportação escambo-export/1.8, com ofertas dos contratos participantes e desistências apenas do freelancer titular.
- Conta suspensa mantém login, sessão e consulta de contratos, chat, carteira e dados. A Web mostra a suspensão e desativa comandos/formulários/modais; a API e o socket bloqueiam negócios. LGPD, contestações próprias e saída continuam disponíveis. O suporte geral foi acrescentado na etapa 13.
- Avisos opcionais por evento, resumo diário e resumo do silêncio não entregam conteúdo a banidos/excluídos. Ao suspender durante a criação de depósito, o modal fecha; cobranças já existentes continuam consultáveis. RN-007 validada localmente com 403 integrações e 62 E2Es; o suporte geral foi acrescentado e validado na etapa 13.

### Alterado

- A reserva em dinheiro acompanha a última oferta do cliente. Aumento/redução e aceite da contraproposta ajustam a diferença na transação; redução aparece como hold_release no extrato. Saídas de pending reconferem sequência e preço lidos.
- Prévia da desistência informa a consequência pública e reconfere a contagem após as travas e antes do commit. Acordo/decisão reputacional não alteram dinheiro.
- Avisos de entrega/revisão dizem o limite e a abertura da disputa; aceite/recusa saem do serviço com os valores. Mapas completos de e-mail/push têm 42 tipos, com preferências normais e sem nova passagem pelo silêncio.
- Saúde/meta da moderação reconhecem revisão de conta pela origem e causa; denúncia comum imitando prefixo continua na meta. Contestações de desistência de contas ativas aparecem como pendência específica.
- Anonimização apaga contestação/nota de desistência. A cópia da justificativa em admin_actions.description também é substituída por uma indicação de remoção, apenas nas ações dropout_excused/dropout_upheld ligadas às desistências do titular; tipo, autor, alvo e data da ação são preservados, assim como os registros de outras contas. Mutações, avisos e outbox impedem repor texto em conta excluída sob a trava do usuário, mantendo envio pelo provedor fora da transação.

### Corrigido

- Revisões de conta encerradas ficam fora das decisões e da mediana da meta de moderação; denúncias humanas que imitam o prefixo continuam contando. Evita relatório diário indevido após uma revisão de desistências ou reincidência.
- Dependências atualizadas sem mudança de major: compression 1.8.2, sharp 0.35.5, concurrently 9.2.5 e correções transitivas de proxy-addr, source-map-js e shell-quote. Auditoria local sem vulnerabilidades; instalação e processamento nativo de imagem conferidos em Windows e na imagem Linux.
- Criação de carteira por INSERT IGNORE passa a autocommit antes das transações financeiras, evitando a espera entre operações da mesma pessoa e funcionando com pool de uma conexão.
- Operações financeiras adquirem contas e depois carteiras em ordem crescente de ID, após a trava do contrato/acordo existente. A desistência mantém a trava exclusiva da conta cuja contagem muda; acordo segue a mesma ordem. Corrige ciclos 1213 reproduzidos entre aceite/cancelamento/disputa, aprovação de marco/desistência e desistências recíprocas, preservando cálculos, ordem dos efeitos e extrato. As provas controladas não garantem ausência de todo deadlock.
- Primeira entrega de marcos é recuperada do histórico antes de reentrega; conversão de agregados para DATETIME mantém leitura UTC.
- Ação antiga de revisão/liberação não atravessa ciclos de reentrega para consumir ou liberar outro pedido; contadores INT UNSIGNED comportam a revisão 256.
- Erro de limite de revisões de entrega única informa a data/hora futura da disputa no fuso do cliente, inclusive após releitura do snapshot; na abertura exata já orienta a disputa disponível.
- Filas administrativas de desistências identificam a contratação pelo número e título; deixam de oferecer um link para a Sala privada que retornava acesso negado ao administrador.
- Autorização HTTP/socket passa a vincular `uid` e `sub` ao usuário atual no banco e usa seu papel/status atuais, inclusive em conexões abertas e no recebimento de eventos. Banidos e excluídos perdem o acesso autenticado; reativação restaura comandos sem exigir recarga manual. Consultar como suspenso não cria carteira, concede créditos/XP ou cria conversa. Renovação do JWT refaz o handshake do socket; respostas antigas não repõem sessão após sair.
- Detalhes de desistências na moderação ocupam uma linha própria, com a largura da tabela. O histórico da contratação recebe nome acessível próprio para se distinguir do histórico de ofertas.

### Implantação

Migrations 0031–0034, aditivas e sem backfill de desistências ou limite retroativo. O reparo recupera evidências/snapshots de entrega, oferta 1 faltante e ofertas abertas fora de pending. O agendador tem 16 jobs. Consultas, detector de reserva e limites da reversão para 1.41.1 estão no DEPLOY.md. As correções posteriores de contas/carteiras e acesso de suspensos não acrescentam migration; seus cenários e limites estão na [validação de entrega](./docs/validacao-entrega-adr61.md). A suspensão não pausa prazos/jobs nem cancela atomicamente operações já admitidas. O suporte geral da RN-007 e a RN-020 estão implementados na 1.42.0; gateway real e validação da infraestrutura de destino continuam pendentes.

## [1.41.1] — 2026-10-04

Correções da varredura de testes (ADR 60): os pontos que os testes de unidade do ADR 59 acharam no código,
conferidos um a um.

### Corrigido

- **Regras que o código furava:** serviço pausado aceitava proposta pelo link, na contratação e na troca (RN-013); dava para mandar proposta direta a uma conta que não é de freelancer, ou a um administrador; a edição deixava um
  serviço de preço fixo sem preço (RN-016); dava para comprar um segundo impulsionamento enquanto o primeiro
  valia, e impulsionar serviço pausado (RN-017); o ranking mostrava conta suspensa, banida ou excluída.
- **Dinheiro:** saque e contratação com fração de centavo criavam um centavo a cada pedido ou proposta cancelados; valores da troca e da
  contratação sem teto davam erro interno; a troca aceitava oferecer serviço de outra pessoa; uma divisão de
  0% ou 100% numa disputa terminava com o status errado (agora vai de 1% a 99% e precisa dar algo aos dois lados, e o painel vai de 5% a 95%); a troca podia ser proposta a conta suspensa ou banida.
- **Corridas:** dois refresh simultâneos com o mesmo token saíam com duas sessões; dois pedidos de exclusão
  simultâneos criavam duas solicitações; o nível de XP podia ficar abaixo do total.
- **LGPD e moderação:** arquivo da quarentena era marcado como apagado sem ter saído do disco; a cópia de dados
  do titular ficava no disco depois da anonimização ou de uma falha ao gerá-la; baixar uma cópia que sumia
  derrubava a API; uma decisão já gravada respondia erro se um passo depois dela falhasse; a miniatura de uma
  imagem removida podia continuar no ar.
- **Chat:** um evento do socket com retorno inválido derrubava a API; a mensagem nova não aparecia ao vivo na Sala de uma segunda contratação com a mesma pessoa; depois de 200 mensagens a conversa parava de mostrar as novas; pelo socket entrava mensagem vazia
  ou longa demais; a remoção de uma mensagem não aparecia ao vivo numa segunda contratação com a mesma pessoa;
  nome de anexo com acento chegava trocado.
- **Entradas que davam erro interno:** página muito grande, número vazio na busca, `%` e `_` na busca,
  multipart cortado, navegador com nome muito longo, categoria inexistente, destinatário de troca
  inexistente, administrador banindo a si mesmo.
- **Documentação da API:** `/api/docs` abria em branco (também em http fora do localhost); o Swagger UI agora vem da própria API.
- A sequência de dias da gamificação contava em UTC (virava às 21h de Brasília); agora conta no fuso da pessoa.

### Alterado

- Administradores não são suspensos nem banidos pelo painel. A RN-007 passa a dizer o que o código faz: a
  suspensão bloqueia o acesso como o banimento, até o admin reativar.
- A API recusa com códigos novos o que antes aceitava ou quebrava (`service_inactive`, `boost_active`,
  `price_required`, `invalid_category`, `cannot_favorite_self`, `cannot_moderate_admin`, entre outros; a lista
  está no ADR 60).

### Para quem opera

- Sem migration. Dependência nova na API: `swagger-ui-dist` (Apache-2.0). A estatística de instalação que vem
  com ele (`@scarf/scarf`) fica desligada no `package.json` da raiz (`scarfSettings.enabled: false`).
- `PUSH_PROVIDER=webpush` sem `PUSH_PUBLIC_KEY` e `PUSH_PRIVATE_KEY` agora impede a API de subir, com a
  mensagem dizendo qual chave falta.

## [1.41.0] — 2026-10-03

Lembretes de prazo (ADR 58): o que o ADR 57 deixou para o bloco seguinte.

### Adicionado

- **Lembretes antes de cada vencimento**, a partir das 9h no seu horário e em geral na véspera: entregar
  (a quem entrega), responder a uma proposta (ao freelancer), aprovar uma entrega ou os marcos antes da
  aprovação automática (ao cliente) e responder a um pedido de extensão (ao cliente). O título diz o que
  fazer e até quando; o lembrete é um aviso a mais, sai no máximo uma vez e não muda nenhuma hora. Nenhum
  sai durante o "não perturbe".
- **A aprovação automática avisa as duas partes:** o cliente, com até quando pode avaliar; o freelancer, com
  quanto entrou na carteira. Marcos aprovados juntos vão num aviso só.
- **Aviso de revisão parada:** se uma revisão fica 7 dias sem nova entrega, as duas partes são avisadas, uma
  vez por pedido, sem nenhuma sanção. A Sala mostra às duas partes desde quando a revisão está pedida, também
  nas contratações sem prazo, como as de troca.
- A API: `deadlineZone` e `revisionRequestedAt` na contratação, `extension.deadlineZone` no pedido de
  extensão, `dueZone` e `revisionRequestedAt` no marco.
- Termos de Uso 1.4, com faixa informativa para quem aceitou a 1.3.

### Alterado

- **O prazo é um dia no horário de quem entrega**, em todas as telas e avisos: `sex, 02/10/2026, até 23:59`,
  com "(horário de Manaus)" para quem está em outro relógio. Ao contratar, o dia mínimo e o fim do dia são
  os de quem entrega, e a dica diz o horário quando ele é outro; o pedido de extensão escolhe o dia no
  mesmo horário. As horas em que cada um age continuam no horário de quem lê.
- Nos dois resumos (o do fim do "não perturbe" e o diário), os avisos com hora-limite próxima vêm primeiro.
- O prazo para avaliar (7 dias) passa a contar pelo relógio da plataforma, o mesmo dos prazos.

### Corrigido

- Cliente e freelancer em fusos diferentes liam dias diferentes para o mesmo prazo: o prazo era o 23:59 do
  navegador de quem escolhia.
- A demonstração gravava os prazos às 20:59 de Brasília.
- O pedido de revisão de um marco passa a reconferir, com a contratação travada, que ela continua ativa.

### Para quem opera

- Migrations 0029 (a tabela `deadline_reminders` e a hora do pedido de revisão na contratação) e 0030 (a
  hora do pedido de revisão no marco); o reparo preenche a hora das revisões em curso, pela linha do tempo.
  No primeiro dia saem de uma vez os lembretes do que vence nas próximas 48 h e os avisos das revisões
  paradas há mais de 7 dias. Voltar para a 1.40.0 e de novo para a 1.41.0 não pede passo manual.
  Conferências no `DEPLOY.md`.

## [1.40.0] — 2026-10-02

Engenharia de entrega (ADR 59): o que o Playbook de Web Apps exige em volta do produto. Nenhuma tela,
rota pública, migration ou regra de negócio muda.

### Adicionado

- **Deploy contínuo:** com o CI verde em `main`, o workflow **Deploy** põe o commit no ar na VPS: descobre o
  commit da imagem, copia a configuração dele, puxa as imagens, sobe, recarrega o Caddy e confere no
  `/api/health` que o commit certo está no ar. Se a subida ou a conferência falham, a VPS volta sozinha para a
  versão anterior. Rollback pelo mesmo workflow, com a tag anterior; um deploy automático nunca devolve a
  produção a um commit já superado.
- **Testes de unidade nas três camadas do backend**, sem banco: rotas e controllers (com o `authenticate` e o
  tratamento de erros de verdade), _services_ e _repositories_ (com um banco falso que confere cada instrução).
  A cobertura dos unitários foi de 50,2% para **99,1%** (3.042 testes); a meta do Playbook é 75%, e o
  Vitest barra a rodada abaixo de 90%.
- **Cobertura com meta no CI:** além dos unitários, 75% sobre a união unitários + integração (hoje 99,3%) e
  25% no frontend (hoje 99,5%), contando todo arquivo de `src`.
- **SonarCloud** no CI, com a cobertura do backend (liga com o segredo `SONAR_TOKEN`; informativo, não segura o
  deploy), **`npm audit`** barrando vulnerabilidade alta e **Dependabot** para o npm e as actions.
- **Métricas Prometheus** da API numa porta interna: latência por rota declarada, requisições abandonadas
  (status 499), rodadas e duração dos jobs, versão no ar, processo.
- **Monitoramento** num perfil do compose, igual na produção e na demo (`docker compose --profile monitoring up
-d`, Grafana em <http://localhost:3030>): Prometheus, sonda de uptime e Grafana com o painel "Escambo" e
  cinco alertas, que saem **por e-mail** pelo SMTP do sistema.
- **Erros no Sentry** com `SENTRY_DSN`: só as falhas do servidor, sem nenhum dado pessoal (nem e-mail na
  mensagem, nem o texto de erro do banco, nem o rastro das chamadas).
- **Wiki** gerada da pasta `docs/` e publicada a cada push na `main`, com páginas de arquitetura como
  construída, qualidade, observabilidade e deploy.
- Modelos de Pull Request e de issue em `.github/`.

### Corrigido

- **A imagem da API podia subir sem uma dependência.** Quando o npm instala um pacote dentro do workspace em vez
  de na raiz, a imagem não o copiava e a API não iniciava ("Cannot find module"); nenhum teste roda a imagem
  para avisar. A imagem passa a copiar também `apps/api/node_modules`.
- **Vulnerabilidade alta no `nodemailer`** (10.0.3 → 10.0.13) e no `brace-expansion` (desenvolvimento).
- **Origem recusada pelo CORS, URL mal codificada e corpo com charset desconhecido respondiam 500.** Passam a
  responder 403 (`cors_origin`) e o 4xx correspondente.
- **O encerramento da API saía sempre com erro:** o servidor HTTP era fechado duas vezes (o Socket.IO já o
  fecha), e o pool do banco nunca era encerrado.
- O RFC apontava um `docs/escambo.dbml` inexistente e marcava CI/CD, cobertura, análise estática,
  monitoramento e Wiki como "planejado"; a versão 2.4 descreve o que foi construído.

### Alterado

- Node mínimo: 22 (o do CI e das imagens).
- O resumo do job de publicação e o `DEPLOY.md` deixam de mandar atualizar a VPS à mão.

### Para quem opera

- O deploy, o SonarCloud, o Sentry e a Wiki ligam com passos que só o dono do repositório faz (segredos do
  ambiente `production`, `SONAR_TOKEN`, `SENTRY_DSN` e a primeira página da Wiki). Até lá os jobs terminam
  verdes avisando. O passo a passo está em `docs/wiki/Deploy-e-CI-CD.md`, `Qualidade.md` e `Observabilidade.md`.
- O perfil `monitoring` da produção deve ser ligado depois do primeiro deploy pelo workflow, que é quem copia
  `deploy/monitoring/` para a VPS.

## [1.39.0] — 2026-09-28

### Adicionado

- **Cancelar mostra o valor antes de confirmar** (ADR 57). Na Sala, "Cancelar" abre um quadro com
  quanto volta para você e quanto fica com o freelancer, calculado pela mesma conta que liquida; se
  o valor mudar entre abrir e confirmar (o prazo venceu, um marco foi entregue), nada se move e a
  Sala mostra o valor novo.
- **O freelancer pode desistir** de uma contratação aceita: tudo o que está em garantia volta ao
  cliente, a desistência fica na linha do tempo e o cliente é avisado.
- A outra parte passa a ser avisada de todo cancelamento, com o que aconteceu com o dinheiro dela.
- **Horas na Sala**, no seu fuso: até quando responder a uma proposta; até quando aprovar uma
  entrega ou um marco antes da aprovação automática; quando sai o aviso de prazo vencido e a partir
  de quando a disputa automática abre; até quando o cliente responde a um pedido de extensão.
- Aviso de pedido de extensão sem resposta, às duas partes.
- Termos de Uso 1.3, com faixa para quem aceitou a 1.2 (informativa: continuar usando vale como
  aceite).

### Alterado

- **Nada automático por prazo acontece de madrugada.** O aviso de prazo vencido sai a partir das 9h
  do dia seguinte, no horário de quem entrega, e a disputa automática abre a partir da hora dita no
  aviso. A aprovação automática, a validade da proposta e o prazo para responder a um pedido de
  extensão também ficam gravados, nunca entre 20h30 e 9h no horário de quem é afetado (passam para
  as 9h). Mudar esses tempos no painel vale para o que começar depois.
- **O prazo só abre disputa sozinho enquanto há trabalho nunca entregue.** Na entrega única, a
  primeira entrega encerra a cobrança (a revisão não a reabre); por marcos, ela acaba quando todos os
  marcos foram entregues. Contratações em revisão e por marcos com tudo entregue saem da disputa
  automática; o desfecho é aprovar, pedir revisão ou abrir disputa. O aviso de marco atrasado vale só para marco nunca
  entregue.
- **Extensão de prazo:** até 2 pedidos por contratação, e só 1 pode ser aceito, enquanto há
  trabalho nunca entregue. O cliente tem até
  48 horas para responder (nunca de madrugada, e antes da data pedida); sem resposta, o pedido expira
  e vale o prazo atual. Enquanto o cliente decide, a disputa automática espera; depois de uma recusa
  ou expiração, quem entrega tem sempre pelo menos 6 horas de dia para agir. Pedidos pendentes de
  antes desta versão contam como o primeiro e expiram 48 horas depois da atualização.
- **Cancelamento pelo cliente:** com o prazo vencido sem nenhuma entrega, a partir do aviso, devolve
  tudo (antes, 0%). A "metade do prazo" que decide entre 50% e 0% passa a contar do aceite, e não da
  proposta. Com um marco entregue esperando resposta ou em revisão, a contratação não se cancela. Em
  revisão, o botão "Cancelar" some (a API já recusava).
- Proposta com o prazo de entrega já vencido não pode ser aceita; o freelancer vê só "Recusar".
- Só o aviso de prazo vencido a quem entrega sai durante o "não perturbe" (ADR 56 estreitado): a
  recusa de extensão e a revisão pedida esperam o fim do silêncio; a recusa e a expiração de um
  pedido vêm primeiro no resumo.
- Os avisos de prazo, entrega, marco entregue, proposta e extensão dizem a hora-limite no seu fuso.
- As descrições de "Aprovação tácita", "Validade da proposta" e "Carência do prazo" no painel dizem
  que a hora fica gravada; a aprovação tácita é em dias corridos (como os Termos já diziam).
- A API: `GET /contracts/:id` traz `deadline`, `approvalDueAt`, `proposalExpiresAt`,
  `cancellation` e `extension.respondBy/seq`; `POST /contracts/:id/cancel` aceita
  `expectedRefund`; a decisão da extensão aceita `seq`; códigos de erro novos na documentação.
- `JOBS_INTERVAL_MS` tem teto de 30 minutos.

### Corrigido

- A revisão pedida depois de uma entrega atrasada abria disputa na rodada seguinte.
- O cliente lia "não houve entrega" depois de uma entrega.
- A contratação por marcos com tudo entregue recebia o aviso de atraso e ia para disputa.
- Pedidos de extensão repetidos, ou ignorados, seguravam a disputa sem limite.
- O freelancer podia cancelar pela API e ficar com parte do escrow.
- Mudar a carência no painel encurtava a de quem já tinha sido avisado.
- A disputa automática podia abrir numa contratação recém-entregue.
- A extensão podia ser aceita com a data vencida, ou depois da conclusão.
- A linha do tempo da disputa não dizia o status anterior.
- Os avisos de extensão e de disputa não atualizavam a Sala aberta.

**Nota de transição:** quem já estava na carência ou esperando a aprovação automática no deploy
termina na hora já prometida, levada para as 9h se ela cairia de noite. As disputas automáticas já
abertas numa contratação com entrega não mudam sozinhas: o `DEPLOY.md` traz a consulta para o admin
resolvê-las pela mediação. Por alguns segundos no deploy, a versão anterior ainda pode abrir disputa
numa contratação em revisão.

## [1.38.0] — 2026-09-25

### Adicionado

- **O que sai mesmo no silêncio** (ADR 56). No "não perturbe" do cartão Avisos no navegador, quem
  entrega trabalho escolhe se o prazo vencido sai na hora quando ainda dá para evitar a mediação
  automática: o aviso de prazo estourado (salvo numa contratação por marcos com a extensão já
  usada, em que não há o que fazer), a extensão recusada e a revisão pedida com a carência
  correndo. Esses avisos saem com prioridade alta no serviço de push e sem substituir o aviso anterior
  da mesma contratação. A opção vem marcada quando você liga o silêncio sem nunca ter escolhido;
  quem já estava com ele ligado continua sem nada saindo até marcar. Todo o resto espera o fim do silêncio, e o não
  perturbe do próprio aparelho continua valendo por cima.
- Os avisos de prazo dizem a hora-limite no seu fuso ("até 26/09/2026 às 00:03"), em vez de
  "em 24h", e a data do prazo também no seu fuso.

### Alterado

- No aviso do fim do silêncio, os avisos de prazo vêm primeiro.
- Um aviso que pode sair no silêncio, enviado pouco antes dele, fica até 12 horas no serviço de
  push (antes, 15 minutos).
- **Política de Privacidade 1.4**, com faixa para quem respondeu a 1.3, e cópia de dados no
  formato 1.7. As datas dos documentos legais aparecem no dia certo (antes, a faixa e o histórico
  mostravam o dia anterior). O texto de ligar os avisos num aparelho passa a dizer tudo o que o serviço de push
  recebe.
- A descrição de "Carência do prazo" no painel diz como ela conversa com o silêncio.
- A documentação da API passa a descrever `quietHours` e `quietPass` no
  `PUT /notifications/preferences` e `deliversWork` no `GET /notifications/push`.

### Corrigido

- O aviso de prazo estourado oferecia pedir extensão mesmo quando ela já tinha sido usada, e
  "registrar a entrega" numa contratação por marcos, que é entregue marco a marco.

## [1.37.0] — 2026-09-24

### Adicionado

- **Série da saúde da moderação em CSV** (ADR 55). No painel admin, "Exportar CSV" baixa a série
  do período escolhido em dias inteiros de Brasília: denúncias recebidas, sinalizações automáticas,
  decididas com ação e dispensadas, mediana de horas, meta e se passou dela. Ponto e vírgula,
  vírgula decimal e BOM, como o ledger; o nome do arquivo leva as pontas da série; a exportação
  fica nas ações do admin.
- **Relatório diário da meta da moderação.** Uma vez por dia, a partir da hora do resumo diário,
  a API confere o dia anterior e a fila; se a mediana de ontem passou da meta ou alguma denúncia
  espera há mais que a meta, cada admin recebe um e-mail com os números e o link do painel — só
  agregados, no máximo um por dia, com novas tentativas se o envio falhar. A chave "Relatório da
  meta da moderação", nos parâmetros da plataforma, desliga.
- O painel diz quantas denúncias passaram da meta e o que o relatório diário está fazendo
  (hora, provedor, última conferência); a série por dia passa a trazer as denúncias recebidas.

### Alterado

- Entrar pelo link de um e-mail com âncora (`/admin#health-title`) volta para a âncora depois do
  login, e o painel rola até ela e põe o foco no título quando termina de carregar.
- Um só caminho de download por âncora temporária para anexo do chat, ledger, série da
  moderação e cópia de dados.

## [1.36.0] — 2026-09-24

### Adicionado

- **"Não perturbe" nos avisos do navegador** (ADR 54). No cartão de avisos do Perfil, uma janela
  de silêncio em horas cheias, no fuso da conta: durante ela nenhum aparelho recebe push, e ao
  fim chega um aviso só com o que ficou por ver (o próprio aviso, se foi um; um resumo com os
  títulos, se foram vários). Notificações no app e e-mails não mudam; o aviso de teste sai na
  hora mesmo no silêncio.
- **Política de Privacidade 1.3**, com versão por documento e histórico na página: passa a
  descrever os avisos no navegador (a assinatura de cada aparelho e o serviço de push, fora do
  Brasil, que a entrega), o fuso detectado no cadastro, as preferências de aviso e a retenção.
  Quem respondeu a uma versão antiga vê uma faixa no topo do app, com resumo, link e as
  respostas "Li e aceito" e "Não aceito", registradas nos consentimentos.
- O cadastro grava os consentimentos no servidor, na versão vigente, com IP e navegador (o
  corpo exige `legalAccepted: true`); ligar e desligar os avisos em um aparelho ficam na trilha
  de auditoria, só com o host do serviço de push.

### Alterado

- Cópia de dados no formato 1.6: as assinaturas de aviso dos aparelhos (segredo como impressão),
  o horário de silêncio e os avisos retidos, as sessões, os registros de segurança e os e-mails
  enviados.
- O TTL do Web Push acaba no próximo início de silêncio (entre 15 minutos e 12 horas).
- Assinaturas de push sem nenhum aviso aceito há 180 dias são apagadas por job.

### Removido

- O navegador do aparelho (`user_agent`) deixou de ser guardado junto da assinatura de push, e o
  que existia foi apagado (migration 0025).

> Os tratamentos dos ADRs 51 e 52 (fuso do aparelho no cadastro, avisos no navegador) entraram
> no ar em 22/09 sob a Política 1.2; a 1.3 fecha essa lacuna.

## [1.35.0] — 2026-09-22

### Adicionado

- **Ordenar o portfólio pelo teclado** (ADR 53). Na alça, espaço pega o trabalho, as setas
  movem, espaço solta e Esc ou Tab cancelam. Enquanto o item está na mão a lista já mostra a
  ordem nova, mas nada é gravado: soltar grava uma vez só, no lugar das onze gravações que
  levar o último trabalho ao começo custava pelas setas. Cada passo é anunciado para quem usa
  leitor de tela, e as setas de subir e descer continuam onde estavam.

### Corrigido

- Avisos no navegador com o canal desligado no servidor (`PUSH_PROVIDER=off`): o cartão do
  perfil convidava a ligar e o aviso de teste dizia "nenhum aparelho ligado" com um aparelho
  assinado. Agora não há chave pública nesse modo e o cartão explica a situação.

## [1.34.0] — 2026-09-22

### Adicionado

- **Avisos no navegador** (ADR 52). Contratação, entrega, disputa, saque e os demais avisos que
  já iam por e-mail passam a bater no aparelho, mesmo com a aba fechada. Liga-se aparelho por
  aparelho no perfil, com aviso de teste, e o chat fica de fora para não virar barulho. A
  entrega fica atrás de interface: simulada por padrão, Web Push de verdade com chaves VAPID
  (obrigatórias nesse modo) e `off` para desligar o canal.
- Sair de todos os aparelhos e redefinir a senha desligam os avisos junto com as sessões;
  sair de uma sessão desliga o aparelho em que a pessoa está, e encerrar a conta apaga as
  assinaturas na mesma transação que anonimiza os dados.

## [1.33.0] — 2026-09-22

### Adicionado

- **Fuso detectado pelo aparelho** (ADR 51). No cadastro, o fuso do navegador vai junto, e a
  conta já nasce nele. Conta antiga que nunca escolheu fuso, com o aparelho em outro fuso do
  Brasil, vê uma sugestão única ("usar o horário de Manaus?"), e qualquer resposta grava a
  escolha. A sessão passa a trazer `timezoneChosen`, e o cadastro aceita `timezone`.

## [1.32.1] — 2026-09-22

### Corrigido

- Saúde da moderação: as consultas do período fecham no mesmo instante da série, então uma
  decisão gravada durante a consulta não entra no total sem entrar na série. A soma da série
  bate com o total por construção.
- Gráfico de decisões por dia: o respiro entre os segmentos sai de dentro da barra. Dias com o
  mesmo total têm a mesma altura, e o dia de pico não passa do teto do desenho.

## [1.32.0] — 2026-09-21

### Adicionado

- **Série por dia na saúde da moderação** (ADR 50). O painel ganha dois gráficos do período:
  decisões por dia (com ação e dispensadas) e a mediana do tempo até decidir, com a meta
  desenhada. A meta é o novo parâmetro da plataforma `moderation_sla_hours` (padrão 24 h),
  editável no painel; mediana acima da meta pinta o indicador de âmbar.

## [1.31.0] — 2026-09-18

### Adicionado

- **Arrastar para ordenar o portfólio** (ADR 49). Cada trabalho tem uma alça: com mouse, toque
  ou caneta, a linha segue o ponteiro, as outras abrem espaço, a página rola sozinha perto da
  borda e soltar grava a ordem na hora. Esc cancela. As setas de subir e descer continuam como o
  caminho do teclado e do leitor de tela.

## [1.30.0] — 2026-09-17

### Alterado

- **Horário de atendimento no fuso do freelancer** (ADR 48). Os dias e períodos marcados no
  perfil valem no fuso da conta (o mesmo do resumo diário), e não mais em Brasília: o selo
  "atende agora" do card e do perfil público, e o filtro "Atende agora" da busca, comparam a
  agenda de cada freelancer com o relógio de onde ele está. O card e o perfil público informam o
  fuso da agenda (`ownerTimezone`, `timezone`) e o app mostra "(horário de Manaus)" ao lado dos
  dias quando o fuso não é o de quem vê. O editor do perfil diz em que fuso os períodos valem, e
  o cartão "E-mails do Escambo" avisa o freelancer de que o fuso também rege a agenda.
- Demo: Diego Ramos atende de Manaus.

## [1.29.0] — 2026-09-17

### Adicionado

- **Saúde da moderação no painel** (ADR 47). Uma seção só de leitura, com período de 7, 30 ou
  90 dias: o que espera agora (denúncias, automáticas, contestações, contas em revisão), o tempo
  até decidir (mediana e p90), as decisões da fila, as sinalizações automáticas por resultado e o
  acerto por sinal, as contestações mantidas e revertidas e as remoções por tipo.
  `GET /api/admin/moderation/health?days=`.

### Corrigido

- A faixa "Confirme seu e-mail" não alarga mais a tela no celular quando o endereço é comprido.

## [1.28.0] — 2026-09-16

### Adicionado

- **Fuso horário por pessoa** (ADR 46). No cartão de e-mails do perfil, a conta escolhe entre os
  cinco fusos do Brasil; sem escolha, vale Brasília. A hora do resumo do dia, o alerta diário das
  buscas salvas e as datas escritas nos avisos (prazo para contestar, fim do bloqueio de envio)
  passam a valer nesse fuso.
  - `PUT /api/notifications/preferences` aceita `timezone` (`null` volta a Brasília), e a sessão e
    a preferência devolvem o fuso.
  - Migration `0022_fuso_por_pessoa`.

### Alterado

- Os jobs `daily-digest` e `saved-search-alerts` rodam um fuso por vez, com o dia e a hora locais
  de cada um.
- A cópia de dados da LGPD passa ao formato 1.5, com o fuso da conta.

## [1.27.0] — 2026-09-16

### Adicionado

- **Aviso de negociação por fora no chat** (ADR 45). A API procura, em cada mensagem e legenda,
  sinais de pagamento fora da plataforma: chave Pix e CPF, telefone, e-mail, WhatsApp e expressões
  como "por fora" e "sem taxa".
  - Quem digita vê o aviso antes de enviar, e a mensagem sai com o aviso para as duas partes
    (`signals`), sem ser barrada.
  - A mensagem entra sozinha na fila de denúncias como sinalização automática, sem denunciante,
    com o que foi achado; a denúncia humana soma no mesmo grupo, e dispensar ou remover valem igual.
    `AdminReportGroup.automatic`.
  - Migration `0021_aviso_por_fora`: `messages.off_platform` e `content_reports.reporter_id`
    aceitando NULL.

## [1.26.0] — 2026-09-15

### Adicionado

- **Remover avaliação ou mensagem denunciada** (ADR 44). Na fila de denúncias, os grupos de
  avaliação e de mensagem ganham "Remover avaliação" e "Remover mensagem".
  - A avaliação sai do perfil público e da nota média, recalculada na hora; na contratação, as
    partes veem que ela foi removida pela moderação.
  - A mensagem vira um aviso no chat para as duas partes, em tempo real, e o anexo dela deixa de
    ser servido.
  - O autor recebe notificação e e-mail com a nota e o prazo para contestar.
  - `POST /api/admin/reports/:id/remove-content`.
- **Contestação de avaliação e mensagem** (ADR 44). O cartão "Moderação" do perfil mostra o texto
  removido e aceita a contestação; na fila do admin, o texto aparece na decisão, e reverter devolve
  a avaliação, com a nota recalculada, ou a mensagem. A decisão ganha `contentRestored`.

### Alterado

- A tabela `image_removals` passa a se chamar `content_removals` e guarda uma cópia do texto
  removido. Migration `0020_moderacao_conteudo`.
- A reincidência conta qualquer conteúdo removido para a revisão da conta; o bloqueio de envio
  segue só para imagens, e o resumo da reincidência ganha `imageStrikes`.
- As notificações de remoção e de decisão usam `removalId` nos dados; os links continuam aceitando
  `imageRemovalId`.
- A cópia de dados da LGPD passa ao formato 1.4, com o texto removido.

## [1.25.0] — 2026-09-15

### Adicionado

- **Ordem do portfólio** (ADR 43). No perfil, cada trabalho mostra a posição e tem botões para
  subir e descer: a lista muda na hora, a ordem é gravada em fila e sai igual no perfil público. O
  foco fica no mesmo botão e a nova posição é anunciada para leitor de tela.
  `PUT /api/profiles/portfolio/order` com os ids de todos os trabalhos (409
  `portfolio_order_mismatch` se a lista não bate com o portfólio de agora).
- **Zoom na galeria do portfólio** (ADR 43). De 100% a 400%, com pinça e duplo toque no celular e
  com roda, duplo clique, botões e as teclas `+`, `-` e `0` no computador. Ampliada, a imagem se
  arrasta e as setas a deslocam; a versão maior só é baixada quando alguém aproxima.

### Corrigido

- Os botões da galeria não ficam mais verdes ao passar o mouse.

## [1.24.0] — 2026-09-15

### Adicionado

- **Hora do resumo do dia por pessoa** (ADR 42). No cartão de e-mails do perfil, cada pessoa
  escolhe a hora, em Brasília, do resumo diário por e-mail e dos alertas diários das buscas salvas;
  sem escolha, vale `DIGEST_HOUR`. A hora aparece na opção de resumo diário e nos avisos das buscas.
  - `PUT /api/notifications/preferences` aceita `emailFrequency`, `digestHour` ou os dois (`null`
    volta à hora padrão), e a sessão (`GET /api/auth/me`) passa a trazer `digestHour`.
  - Migration `0019_horario_resumo`.

### Alterado

- O job `daily-digest` roda a toda rodada e entrega a cada pessoa a partir da hora dela, mantendo um
  resumo por dia de Brasília; o resultado não tem mais `skipped: 'before_hour'`.
- O alerta diário das buscas salvas vence no horário do resumo do dono.
- A cópia de dados da LGPD passa ao formato 1.3, com a preferência de e-mail e a hora do resumo.

## [1.23.0] — 2026-09-15

### Adicionado

- **Contestação de remoção de imagem** (ADR 41).
  - **No perfil**: o cartão "Moderação" lista as imagens removidas com motivo, nota, prazo e
    situação, e o dono contesta uma vez, dentro do prazo, com um texto de 20 a 1000 caracteres. O
    aviso da remoção já traz a data limite. `GET /api/moderation/removals` e
    `POST /api/moderation/removals/:id/appeal`.
  - **No painel admin**: fila de contestações pendentes e decididas, com a imagem guardada, o texto
    do dono e as remoções dele na janela. Manter apaga o arquivo; reverter devolve a imagem para
    onde estava, se o lugar continua vazio, tira do bloqueio e a remoção deixa de contar. O dono
    recebe notificação e e-mail com a nota. `GET /api/admin/appeals`,
    `GET /api/admin/appeals/:id/image` e `POST /api/admin/appeals/:id/uphold|overturn`.
  - **Quarentena**: a imagem removida sai do ar na hora, mas o arquivo fica em `DATA_DIR/quarantine`
    enquanto cabe contestação; o job `purge-quarantine` apaga o que não pode mais voltar.
- **Reincidência progressiva** (ADR 41).
  - Da segunda remoção em 180 dias, o envio de imagens fica bloqueado por 7 dias vezes as remoções
    depois da primeira (`403 uploads_restricted`, com a data de liberação), e o perfil mostra o
    bloqueio com o medidor de remoções.
  - Na terceira, a conta entra na fila de denúncias para revisão, uma vez enquanto a revisão estiver
    aberta, e o aviso da fila diz ao admin o que a remoção causou.
  - Prazo de contestação, janela, dias de bloqueio e limite de revisão são parâmetros do painel.
    Migration `0018_contestacao_reincidencia`.

### Alterado

- A cópia de dados da LGPD passa ao formato 1.2, com as imagens removidas e as contestações, e a
  anonimização apaga os arquivos em quarentena e o texto das contestações do titular.
- A resposta de `POST /api/admin/reports/:id/remove-image` ganha `removalId`, `ownerStrikes`,
  `uploadsBlockedUntil` e `accountReviewOpened`.

## [1.22.0] — 2026-09-15

### Adicionado

- **Galeria do portfólio** (ADR 40). No perfil público, cada trabalho com imagem abre em tela
  cheia, com título, contador, descrição e link do trabalho.
  - **Navegação**: botões, setas, Home e End ou deslizar no toque, em círculo. Esc fecha e o foco
    volta ao cartão, e a rolagem da página trava enquanto a galeria está aberta.
  - **Link direto**: o trabalho aberto fica na URL (`?trabalho=ID`), e o "voltar" do celular fecha
    a galeria em vez de sair do perfil.
  - **Imagem do tamanho da tela**: `srcset` com 480 px, 960 px e o original; a miniatura aparece
    desfocada enquanto a grande carrega, e as vizinhas são pedidas antes.
  - **API**: nova largura de miniatura, `GET /api/media/…?w=960`.

## [1.21.0] — 2026-09-15

### Adicionado

- **Moderação de imagens e fila de denúncias** (ADR 39).
  - **Denunciar foto e imagem do portfólio**: no perfil público, "Denunciar" pergunta se é o perfil
    ou a foto, e cada trabalho com imagem tem a própria bandeira. O modal mostra a imagem que vai
    para a moderação. A API guarda a imagem como estava na hora e recusa a própria imagem, alvo sem
    imagem e denúncia repetida.
  - **Fila de denúncias no painel admin**: denúncias de todos os tipos agrupadas por alvo e imagem,
    com dono, motivos contados, descrições e se a imagem ainda está no ar, em abas de pendentes e
    resolvidas. `GET /admin/reports` e `POST /admin/reports/:id/dismiss|resolve|remove-image`.
  - **Remover imagem**: a imagem sai de todo perfil e trabalho que a mostra, o arquivo e as
    miniaturas são apagados na hora, o dono recebe notificação e e-mail com o motivo e a nota, e a
    decisão fica nas ações do admin e na auditoria.
  - **Imagem removida não volta**: o envio é recusado (`image_blocked`) quando bate com a
    assinatura do arquivo ou com a impressão perceptual, o que pega a mesma foto reencodada ou
    reduzida. Migration `0017_moderacao_imagens`.

### Corrigido

- **Denúncias sem destino**: até aqui as denúncias eram gravadas, mas não apareciam em lugar
  nenhum do painel.

## [1.20.0] — 2026-09-15

### Adicionado

- **Recorte da foto de perfil e miniaturas** (ADR 38).
  - **Recorte**: escolher a foto abre a janela "Ajustar foto", com arrastar (mouse, toque ou
    setas), zoom (controle, botões, roda do mouse ou + e −) e a prévia do avatar redondo nos dois
    tamanhos em que ele aparece. A foto sobe já quadrada.
  - **A API processa a imagem**: decodifica e reencoda com a sharp. O avatar sai quadrado de até
    512 px, o portfólio cabe em 1600 px e GIF animado continua animado no portfólio. Tudo vira
    WebP, com a orientação da câmera aplicada e sem EXIF, XMP ou ICC. `POST /media` recebe
    `purpose` (`avatar` ou `portfolio`) e devolve largura e altura; imagem acima de 50 megapixels
    ou que não abre é 422.
  - **Miniaturas**: `GET /api/media/…?w=128` ou `?w=480` devolve a miniatura em WebP, gerada na
    primeira leitura e guardada ao lado do original, com o mesmo cache imutável. Vale também para
    as imagens enviadas antes desta versão. Avatares e o portfólio do perfil público passam a
    carregar a miniatura.
  - **Admin**: o card de armazenamento mostra quantas miniaturas existem, e o expurgo remove as
    miniaturas junto com as imagens que ninguém usa.

### Alterado

- **Diálogos com nome acessível**: todo modal passa a ser anunciado pelo título.
- A remoção manual de metadados por segmentos (ADR 36) saiu, porque a reencodagem já descarta
  tudo.

## [1.19.0] — 2026-09-15

### Adicionado

- **Frequência do alerta de busca salva** (ADR 37). Antes todo alerta era de hora em hora; agora
  cada busca escolhe.
  - **Na hora**: avisa na rodada seguinte dos jobs, em poucos minutos.
  - **De hora em hora**: o comportamento anterior, que continua como padrão e vale para as buscas
    que já existiam.
  - **Uma vez por dia**: um aviso no horário do resumo diário de e-mail (`DIGEST_HOUR`, em
    Brasília), com o título "Resumo do dia".
  - **Na tela**: salvar uma busca pede a frequência, e cada busca salva ganhou **Editar** (nome,
    alerta e frequência). O sino mostra a frequência no título, e desligar o alerta guarda a
    escolha.
  - **API**: `alertFrequency` (`instant`, `hourly` ou `daily`) no `POST` e no
    `PATCH /saved-searches`. Trocar a frequência mantém o cursor, então não repete nem pula
    serviço; `name: null` apaga o nome. Migration `0016_frequencia_alerta`.

### Corrigido

- **Cartão de e-mails do perfil com o radio acima do texto.** A lista de opções herdava o estilo global de rótulo, em coluna e negrito; agora o radio fica ao lado do texto, na cor da marca, e a dica volta ao peso normal. A frequência do alerta usa a mesma lista.
- **Cópia de dados (LGPD) sem as buscas salvas.** O arquivo exportado agora traz `buscasSalvas`,
  com texto, filtros, alerta e frequência, e passa ao formato `escambo-export/1.1`.

## [1.18.0] — 2026-09-15

### Adicionado

- **Foto de perfil e imagens do portfólio enviadas do aparelho** (ADR 36). Antes os dois campos
  só aceitavam link; agora têm o botão **Enviar foto** / **Enviar imagem**, e o link continua
  valendo.
  - **No navegador**: a imagem é reduzida para o tamanho de uso (512 px no avatar, 1600 px no
    portfólio), gira conforme a câmera e é reencodada em WebP, o que também descarta o EXIF com
    GPS. GIF vai como está.
  - **Na API**: `POST /media` aceita JPG, PNG, GIF ou WebP até 5 MB, reconhecidos pelo conteúdo,
    e remove de novo os metadados sem decodificar pixels: EXIF, XMP, IPTC e comentários do JPEG;
    eXIf e textos do PNG; EXIF e XMP do WebP. As imagens ficam em `DATA_DIR/media` e são
    servidas em `/api/media/AAAA/MM/<ULID>.<ext>`, públicas, com cache imutável de um ano e
    fora do rate limit.
  - **Perfil e portfólio** aceitam essa URL no lugar de um link externo; caminho inventado é 422.
  - **Expurgo**: imagem enviada que nenhum perfil ou portfólio usa há mais de um dia sai do
    disco. O card de armazenamento do admin mostra a pasta de mídia, e
    `scripts/backup-uploads.sh` passa a guardar `media/` junto com os anexos.

## [1.17.0] — 2026-09-15

### Adicionado

- **Buscas salvas com alerta** (ADR 35). A API de buscas salvas existia sem tela, sem aviso e
  com filtros em JSON livre; agora é recurso completo.
  - **Na busca**: botão **Salvar busca** (texto e filtros atuais, nome e "me avisar de serviços
    novos") e a linha de buscas salvas: aplicar com um clique, ligar/desligar o alerta e apagar.
  - **Job `saved-search-alerts`**: de hora em hora por busca, procura serviços criados desde o
    último aviso que casam com o texto e os filtros, fora os do próprio dono, e manda a
    notificação "3 serviços novos para “logo”" (também por e-mail, conforme a preferência).
    O link leva a `/servicos?busca=ID`, que reaplica a busca.
  - **API**: filtros validados (os mesmos da busca; chave desconhecida é 422), até 20 buscas por
    conta (409 `saved_search_limit`) e `PATCH /saved-searches/:id` para renomear e
    ligar/desligar. Ligar o alerta reinicia o cursor, sem despejar o catálogo antigo.
    Migration `0015` (índice do job).
  - **Notificações**: as que têm destino ganham o link "Abrir" (ou "Ver serviços") na tela de
    notificações, espelhando o link do e-mail.

## [1.16.0] — 2026-09-15

### Adicionado

- **Horário de atendimento** (ADR 34): por dia marcado, os períodos em que o freelancer atende
  (manhã 6h–12h, tarde 12h–18h, noite 18h–24h, horário de Brasília); dia sem período vale o dia
  todo. Migration `0014` (`profiles_freelancer.available_periods`, JSON).
  - **Perfil**: chips de período por dia marcado e a chave **Aceitando novos pedidos**, que pausa
    a agenda sem apagar os dias (antes todo salvamento religava a disponibilidade).
  - **Perfil público e card do serviço**: "atende seg a sex · manhã e tarde" e o selo
    **atende agora** (`availableNow` / `ownerAvailableNow`, calculados na hora).
  - **Busca**: filtro de período junto com o dia (`period`; sem `day` é 422
    `period_requires_day`) e o botão **Atende agora** (`now=true`): aceitando pedidos, no dia e
    no período de agora. De madrugada ninguém atende agora.

## [1.15.0] — 2026-09-15

### Adicionado

- **As chaves restantes de `platform_settings` ganharam efeito** (ADR 33), editáveis no painel
  com tipos (inteiro, decimal, liga/desliga):
  - **Modo de manutenção**: ligado, a API responde 503 `maintenance` (com `Retry-After`) para
    quem não é admin; health, login, parâmetros públicos e o painel admin continuam, e o admin
    passa em qualquer rota. O app mostra a tela "Estamos em manutenção" (tenta de novo sozinho)
    e o admin vê uma faixa lembrando de desligar.
  - **Trocas de serviço on/off**: desligadas, propor troca dá 403 `barter_disabled`; o app esconde
    "Propor troca" e avisa na tela de Trocas. Trocas já propostas seguem o fluxo.
  - **Saque mínimo** e **preço mínimo de serviço** lidos das settings (422 `below_minimum` /
    `price_below_minimum` com o valor vigente); a Carteira e o formulário de serviço mostram o
    mínimo atual.
  - `GET /settings/public` passa a trazer mínimos, trocas e manutenção. Leituras em caminhos
    quentes têm cache de 5 s, limpo no processo a cada mudança.

## [1.14.0] — 2026-09-15

### Adicionado

- **Parâmetros da plataforma no painel admin** (ADR 32): comissão (%), aprovação tácita (dias),
  validade da proposta (horas), carência do prazo (horas) e retenção dos anexos (dias) — só o
  que a API lê em tempo de execução. `GET /admin/settings` e `PUT /admin/settings/:key` com
  limites por chave, autor e data, auditoria (`setting_updated`) e efeito imediato.
- **Comissão deixa de ser fixa no código**: contratações em dinheiro e a torna das trocas leem
  `platform_fee_percentage` na criação e gravam a taxa que valia; o modal de contratação e a
  tela de trocas mostram a taxa vigente (`GET /settings/public`).

## [1.13.0] — 2026-09-14

### Adicionado

- **Expurgo de anexos** (ADR 31): o arquivo de um anexo sai do disco, a mensagem fica e diz por
  quê (`ChatAttachment.purgedAt`/`purgedReason`; download responde 410 `attachment_purged`).
  - **Retenção**: anexos com mais de `platform_settings.attachment_retention_days` dias (180) em
    conversas **sem contratação aberta** entre as duas pessoas. Job `purge-attachments`, uma vez
    por dia a partir de `ATTACHMENT_PURGE_HOUR` (4h, Brasília), com a trava do último expurgo
    guardada em `platform_settings`.
  - **LGPD**: ao concluir a anonimização, os arquivos que o titular enviou saem na hora; o texto
    das mensagens fica e a bolha mostra "removido a pedido do titular".
  - **Órfãos**: arquivo no disco sem linha no banco há mais de 24 h é apagado; linha sem arquivo
    é marcada como indisponível no primeiro download.
  - **Painel admin**: card "Armazenamento" (`GET /admin/storage`) com anexos no disco, pasta de
    uploads, cópias LGPD, removidos, inconsistências, retenção e último expurgo; botão "Rodar
    expurgo agora" (`POST /admin/storage/purge`, auditado).
  - Migration `0013`: `messages.file_purged_at`, `file_purged_reason`, coluna gerada
    `has_file` com índice, e o parâmetro `attachment_retention_days`.

## [1.12.0] — 2026-09-14

### Adicionado

- **Busca por dia de atendimento** (ADR 30): filtro "Atende" na busca (`day=0..6`, com "(hoje)"
  marcado no dia atual) sobre os dias que o freelancer marcou no perfil — só entre quem informou,
  via `JSON_CONTAINS` em `profiles_freelancer.available_days`. O card do serviço mostra
  "atende seg a sex" (`Service.ownerAvailableDays`), e o Perfil avisa quem não marcou dia que
  fica fora desse filtro. Seed com dias variados (Carla só fim de semana, Felipe sem informar).

## [1.11.1] — 2026-09-14

### Corrigido

- **Abrir a Sala podia dar 500 na conversa**: o histórico (REST) e o `contract:join` (socket)
  chegam juntos e os dois tentavam criar a conversa do par; o segundo tomava
  `Duplicate entry` — e uma mensagem enviada nesse instante falhava. A criação virou um único
  `INSERT … ON DUPLICATE KEY UPDATE` (atômico), coberto por teste de integração concorrente.
  Corrida pré-existente, exposta pelo e2e mobile do CI na 1.11.0 (cujas imagens não foram
  publicadas; use a 1.11.1).

## [1.11.0] — 2026-09-14

### Adicionado

- **Anexos no chat** (ADR 29): imagem (JPG, PNG, GIF, WebP) ou arquivo (PDF, ZIP — e docx/xlsx,
  que são ZIP por dentro) por mensagem, com legenda opcional, até `UPLOAD_MAX_MB` (10 MB).
  - `POST /messaging/contracts/:id/attachments` (multipart) e `GET /messaging/attachments/:id`,
    só para as partes do contrato. O tipo é reconhecido pelos **primeiros bytes**: Content-Type e
    extensão declarados são ignorados (HTML disfarçado de PNG e SVG são recusados com 422).
  - Arquivos no volume da API (`DATA_DIR/uploads/AAAA/MM/<ulid>.<ext>`), servidos com o token,
    `Content-Disposition` inline (imagem) ou attachment (arquivo), nome de download limpo e com a
    extensão real. Migration `0012` (`messages.file_mime`).
  - Sala: botão de clipe, colar da área de transferência e arrastar sobre o chat; prévia antes de
    enviar; imagem em miniatura que abre em tamanho real; cartão de arquivo com nome, tamanho e
    download.
  - Notificação "Enviou uma imagem" / "Enviou o arquivo …" quando não há legenda; a cópia de dados
    LGPD passa a listar nome e tamanho dos anexos.
  - `scripts/backup-uploads.sh`: os anexos vivem fora do banco e entram no backup. O nginx aceita
    corpo de 25 MB em `/api/` e a CSP permite `blob:` em `img-src`.

### Alterado

- `ChatMessage` ganha `type` (`text` | `image` | `file`) e `attachment` (`name`, `mime`,
  `size`, `url`).

## [1.10.0] — 2026-09-14

### Adicionado

- **Perfil do freelancer mais rico** (ADR 28):
  - **Portfólio**: até 12 trabalhos com imagem e/ou link, editados no Perfil e exibidos numa
    galeria no perfil público. `GET/POST /profiles/portfolio`, `PUT/DELETE /profiles/portfolio/:id`;
    a tabela `freelancer_portfolio_items` do baseline finalmente tem uso.
  - **Dias em que atende**: chips de segunda a domingo no Perfil; o público mostra "atende seg a
    sex". Migration `0011` (`profiles_freelancer.available_days`, JSON).
  - **Tempo de resposta visível**: o chat já calculava a média móvel para o Score; agora o
    perfil público diz "responde em 2 h" (ou "menos de 1 h", "1 dia").

## [1.9.0] — 2026-09-14

### Adicionado

- **Preferência de e-mail e resumo diário** (ADR 27). No Perfil, cada pessoa escolhe: **a cada
  evento** (padrão, como era), **resumo diário** (um e-mail por dia, a partir de `DIGEST_HOUR`
  em Brasília, com as notificações desde o resumo anterior) ou **só o essencial** (confirmação
  de e-mail e redefinição de senha). As notificações no app não mudam.
  `GET/PUT /notifications/preferences`, template `digest` na caixa de saída, job
  `daily-digest` com trava de um por dia (`users.last_digest_at`). Migration `0010`.

## [1.8.0] — 2026-09-14

### Adicionado

- **Busca com filtros e ordenação**. Além do texto, da categoria e do "perto de mim" com raio:
  faixa de preço, prazo máximo (3/7/15/30 dias), nota mínima do prestador (3+/4+/4,5+) e
  ordenação por relevância (destaque + recência, ou destaque + proximidade), menor/maior
  preço, melhor avaliados, mais recentes e, com localização, mais perto. Aplicam na hora, com
  "Limpar filtros" e estado vazio específico. Destaque (impulsionamento) só manda na
  relevância: quem pede "menor preço" recebe o menor preço. Serviço "a combinar" (sem preço)
  fica de fora quando há filtro de preço e vai para o fim nas ordenações por preço.
  `GET /services?minPrice&maxPrice&maxDeliveryDays&minRating&sort`.

## [1.7.0] — 2026-09-14

### Adicionado

- **Financeiro do admin**. O painel tinha só totais acumulados; agora há um relatório por
  período (por dia ou por mês, presets de 30 dias, 6 e 12 meses ou datas livres):
  - **Receita da plataforma derivada do ledger de R$**: −Σ(disponível + retido) das linhas que
    não são depósito nem saque. Fecha centavo a centavo com a liquidação de cada contratação,
    inclusive quando cancelamento ou disputa devolve parte da taxa (ADR 26).
  - Depósitos, saques (líquidos de estornos), reembolsos, contratações em dinheiro concluídas e
    GMV, com gráfico de barras e tabela; fotografia do escrow e do saldo dos usuários.
  - **Exportação do ledger em CSV** (ponto e vírgula, vírgula decimal, BOM: abre direto no
    Excel pt-BR), registrada como ação do admin. `GET /admin/finance` e
    `GET /admin/finance/export.csv`.

## [1.6.0] — 2026-09-14

### Adicionado

- **Marcos em créditos Escambo** (RN-069 + créditos). Até aqui os marcos só existiam em dinheiro.
  - Contratar em créditos aceita "Dividir em marcos": marcos inteiros, sem taxa, somando os
    créditos da contratação; "Dividir igualmente" reparte em inteiros (o último absorve a sobra).
  - Aceite retém todos os créditos e financia os marcos; cada marco aprovado (ou aprovado
    tacitamente) libera só os seus créditos, com linha no ledger; o último conclui.
  - Cancelar e disputar liquidam só os créditos dos marcos ainda abertos.
  - Sala e notificações falam em créditos ("50 créditos liberados") quando a contratação é em
    créditos; demo com "Manutenção elétrica em 2 visitas (em créditos)".

## [1.5.0] — 2026-09-14

### Adicionado

- **Prazo por marco** (RN-069 + RN-029). `due_at` existia e nunca era preenchido.
  - **Contratar**: cada marco ganha um prazo opcional; "Distribuir prazos" espalha os prazos por
    igual até o prazo da contratação (o último cai nele). A API valida: no futuro, em ordem e
    nunca depois do prazo da contratação.
  - **Sala**: cada marco mostra "até dd/mm" e, enquanto está em escrow, "faltam N dias" ou
    "atrasado há N dias"; marco entregue depois do prazo aparece como "entregue com atraso".
  - **Job**: marco financiado com prazo vencido avisa as duas partes uma vez
    (`milestone_overdue`, também por e-mail). Não abre disputa: a mediação automática continua
    sendo pelo prazo da contratação. Migration `0009`.

## [1.4.0] — 2026-09-11

### Adicionado

- **Prazo de entrega com regra** (RN-021, RN-028, RN-029). O campo `deadline_at` existia e alimentava
  o Score, mas nada o definia nem o cobrava.
  - **Contratar** pede o prazo (sugerido pelo prazo do serviço); a Sala mostra quanto falta ou há
    quanto tempo estourou; o Início mostra "faltam N dias" na contratação.
  - **Extensão única** (RN-028): o freelancer pede pela Sala, com novo prazo e motivo; o cliente
    aceita ou recusa. Aceitar troca o prazo, registra na linha do tempo e trava a segunda extensão.
    `POST /contracts/:id/extension` e `/extension/accept|decline`.
  - **Proposta expira** (RN-021): job `expire-proposals` encerra propostas sem resposta em
    `proposal_expiry_hours` (padrão 72) e devolve a reserva ao cliente; os dois são avisados.
  - **Prazo estourado** (RN-029): job `overdue-contracts` avisa as duas partes uma vez e,
    `deadline_grace_hours` (padrão 24) depois sem entrega nem extensão aprovada, abre a disputa em
    nome do cliente (motivo "prazo") — o escrow congela até a mediação. Pedido de extensão
    pendente segura o job: a decisão é do cliente.
  - Notificações e e-mails: `contract_expired`, `contract_overdue`,
    `deadline_extension_requested|accepted|declined`.
  - Migration `0008`: colunas da extensão e do aviso, índices das varreduras, parâmetros em
    `platform_settings`.

### Corrigido

- `deadline_at` e `due_at` (marcos) chegavam ao MySQL como string ISO e eram recusados; como
  nenhuma tela enviava prazo, o erro nunca tinha aparecido. O repositório passa `Date`.

## [1.3.0] — 2026-09-10

### Adicionado

- **Identidade e instalação**: favicon SVG, ícones 192/512 (com variante _maskable_),
  `apple-touch-icon`, `site.webmanifest` (o app instala como PWA básica) e capa de
  compartilhamento (prévia do link em WhatsApp, LinkedIn e afins). Todos gerados a partir do
  SVG da marca por `scripts/gen-icons.mjs`.
- **Título por tela** (WCAG 2.4.2): a aba, o histórico e os favoritos passam a dizer onde a
  pessoa está ("Carteira · Escambo"), com o número de notificações não lidas quando houver.
  Uma região viva anuncia a troca de tela para leitores de tela, que o SPA antes fazia em silêncio.
- **Página 404**: endereço inexistente mostra uma página com saídas, em vez de redirecionar
  para a home em silêncio.
- **Cabeçalhos de segurança no nginx**: Content-Security-Policy fechada em `'self'`,
  Permissions-Policy, Referrer-Policy, X-Frame-Options e nosniff em toda resposta.

### Alterado

- **Fontes empacotadas** (`@fontsource`) no lugar do Google Fonts: nenhuma requisição sai para
  terceiros (privacidade, LGPD e uma CSP que pode ser restritiva), e a tipografia carrega junto
  com o app.
- **Índices do banco** (migration `0007`): as listas do produto (notificações, chat,
  contratações, extratos, depósitos e a fila de saques) passam a ter índices compostos
  `(dono, recência)`, que resolvem filtro e ordenação; os índices de coluna única que viraram
  prefixo foram removidos.
- **Dependências sem vulnerabilidade conhecida** (`npm audit` limpo, produção e desenvolvimento):
  nodemailer 10, vitest 5, react-router 7 e `qs` 6.16 fixado por `overrides`.

### Corrigido

- **Início**: a tabela de contratações mostra só as ações que avançam o contrato (aceitar,
  entregar, aprovar, avaliar) e cabe numa linha; recusar, cancelar, pedir revisão e abrir disputa
  ficam na Sala, onde há contexto. A saudação e a barra lateral usam o primeiro nome do perfil
  em vez da parte local do e-mail.
- Falha não tratada na API (`unhandledRejection` / `uncaughtException`) agora é registrada e
  encerra o processo drenando conexões, em vez de deixá-lo em estado desconhecido.

## [1.2.0] — 2026-09-10

### Adicionado

- **Publicação automática de imagens**: quarto job do CI (só em `main`, só com os três de teste
  verdes) constrói e publica `ghcr.io/guirenzo/escambo-api` e `escambo-web`.
- **Produção numa VPS**: `docker-compose.prod.yml` com imagens do registro fixadas por
  `IMAGE_TAG`, segredos obrigatórios, banco e API sem porta no host, e **Caddy** na borda
  (HTTPS automático, HTTP/3, HSTS). Guia completo em [DEPLOY.md](./DEPLOY.md).
- **Backup e restauração** do banco (`scripts/backup-db.sh`, `scripts/restore-db.sh`).
- `GET /api/health` devolve `version`, `commit` e `uptime`; o commit é gravado na imagem pelo CI.
- Primeira subida em banco vazio carrega o catálogo de referência pelo job de migrations.

### Alterado

- **Saque exige e-mail confirmado** (403 `email_not_verified`): é a única ação que tira dinheiro
  da plataforma. A Carteira mostra o bloqueio e o reenvio do link.

## [1.1.0] — 2026-08-24 a 2026-09-10

Monorepo (npm workspaces) com API, web e tipos compartilhados. Blocos entregues nesta linha:

| Data       | Bloco                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-09-10 | **Escrow por marcos** (RN-069): 2 a 10 marcos por contratação, liberação parcial, revisão e aprovação tácita por marco |
| 2026-09-09 | **E-mail transacional** com caixa de saída, confirmação de e-mail e recuperação de senha                               |
| 2026-09-09 | **LGPD**: cópia de dados baixável, exclusão por anonimização e fila do admin                                           |
| 2026-09-09 | **Torna da troca** reservada na carteira, liquidada com taxa e devolvida em recusa/disputa                             |
| 2026-09-09 | **Carteira pré-paga**: depósito PIX (gateway simulado), ledger de R$, reembolsos reais e fila de saques                |
| 2026-09-09 | **Contas e conformidade**: moderação imediata, consentimento no cadastro, páginas legais, avatar                       |
| 2026-09-09 | **Polimento do marketplace**: paginação, propor troca pelo card, Score responsivo, sair de todos os dispositivos       |
| 2026-09-09 | **Confiança**: disputas com mediação, painel admin, denúncia e moderação                                               |
| 2026-09-09 | **Engajamento**: notificações ao vivo, favoritos, busca por categoria e onboarding                                     |
| 2026-09-08 | **Ciclo completo**: sessão com refresh rotativo, ações por papel, revisão, aprovação tácita e perfil público           |
| 2026-09-08 | **Avaliações** que alimentam perfil, cards e Escambo Score                                                             |
| 2026-09-03 | **Stack completa** no Docker Compose, e2e com Playwright, dados de demonstração e README de produto                    |
| 2026-09-03 | **Redesign** do front: app shell com sidebar, sistema de design, telas dos quatro diferenciais                         |
| 2026-09-02 | **Quatro diferenciais** na API: créditos de tempo, descoberta local, Escambo Score e impulsionamento                   |
| 2026-09-02 | **Hardening** da API e runner de migrations forward-only                                                               |
| 2026-08-31 | **Chat em tempo real** (Socket.IO) e testes de integração com MySQL de verdade                                         |
| 2026-08-27 | Módulos de **favoritos, buscas salvas, denúncias, disputas, mediação e LGPD**                                          |

## [1.0.0] — 2026-08-24

Base do produto: autenticação com JWT, perfis, catálogo de serviços, contratações com escrow,
carteira, notificações e o schema das 50 tabelas com seed de referência.
