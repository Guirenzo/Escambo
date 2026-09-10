# Decisões de arquitetura (ADRs)

Registro curto das decisões que moldam o Escambo, no formato contexto → decisão → consequências.
Serve para a banca e para quem for evoluir o sistema: cada item explica **por que** está assim.

## 1. Monorepo com tipos compartilhados

- **Contexto:** API (Node) e Web (React) trocam dezenas de DTOs; duplicar tipos gera drift.
- **Decisão:** npm workspaces com `packages/types` consumido da fonte pelos dois lados; um `npm install` na raiz.
- **Consequências:** mudar um contrato quebra o `typecheck` dos dois lados no mesmo PR. O pacote não é publicado; não há versionamento entre front e back.

## 2. Escrow como transação única no banco

- **Contexto:** dinheiro (ou créditos) retido e liberado em transições de estado do contrato; inconsistência aqui destrói a confiança.
- **Decisão:** cada transição (`contractsRepository.transition`) atualiza status, histórico e carteira/ledger **na mesma transação MySQL**, com guarda de saldo (`>= 0`) e `UPDATE … WHERE status = :from` para concorrência otimista (409 se mudou).
- **Consequências:** sem saldo negativo e sem "status mudou, dinheiro não". O custo é SQL mais longo por transição; efeitos secundários (XP, notificações) ficam fora da transação e nunca a derrubam.

## 3. Créditos Escambo como ledger, não como coluna mágica

- **Contexto:** o banco de tempo precisa de rastreabilidade (de onde veio, para onde foi).
- **Decisão:** saldo e pendente na carteira **mais** `credit_transactions` com `balance_after` e `reason`, gravados na mesma transação dos efeitos.
- **Consequências:** o extrato é auditável e reconstruível; toda movimentação de créditos passa pela transição do contrato ou pelos serviços de créditos/boost.

## 4. Migrations com baseline e ledger, sem ORM

- **Contexto:** o schema nasce de um `schema.sql` gerado da modelagem; precisamos evoluí-lo com segurança em dev, CI e Docker.
- **Decisão:** runner próprio: `schema.sql` é a migration `0000_baseline`; se as tabelas já existem (initdb do Docker), só registra; `db/migrations/NNNN_*.sql` são aplicadas em ordem com checksum em `schema_migrations`. No compose, um job `migrate` roda antes da API.
- **Consequências:** idempotente e transparente; forward-only (sem `down`). Sem ORM, as queries são SQL explícito, testadas por integração contra MySQL real.

## 5. Pirâmide de testes com banco de verdade

- **Contexto:** regras de dinheiro e estado não podem depender só de mocks.
- **Decisão:** unitários com repositórios mockados (rápidos), **integração via Supertest contra MySQL real** (`escambo_test` recriado a cada run, inclusive no CI) e **e2e com Playwright** em desktop e mobile, com auditoria de acessibilidade (axe) e asserção de "sem overflow horizontal".
- **Consequências:** três jobs no CI; e2e precisa de app no ar (Vite preview + API no CI). Testes criam seus próprios usuários (e-mails únicos) e são independentes.

## 6. Sessão: JWT curto + refresh token rotativo

- **Contexto:** JWT de 1h sozinho derruba o usuário toda hora; refresh sem rotação é roubável.
- **Decisão:** access token de 1h; refresh token armazenado como hash, **rotacionado** a cada uso e revogável (logout, logout-all, moderação). O client web renova sozinho num 401 (single-flight) e repete a chamada uma vez.
- **Consequências:** sessões longas sem token longo; "sair de todos os dispositivos" é trivial. O socket recebe o token novo por evento.

## 7. Moderação com efeito imediato

- **Contexto:** suspender/banir precisa valer agora, mas o JWT vigente dura até 1h.
- **Decisão:** status checado no login e no refresh (banco) **e** lista de bloqueio em memória hidratada na subida e mantida pela moderação, consultada pelo middleware e pelo handshake do socket; sessões são revogadas ao suspender/banir.
- **Consequências:** efeito instantâneo na instância que moderou; em cluster, outras instâncias convergem no refresh (≤1h) — aceitável para o porte atual. Uma versão distribuída trocaria o `Set` por Redis.

## 8. Tempo real com Socket.IO, salas por contrato e por usuário

- **Contexto:** chat por contrato e notificações em qualquer tela.
- **Decisão:** um servidor Socket.IO acoplado ao HTTP, autenticado pelo mesmo JWT; sala `contract:<id>` (só as partes) para chat e sala `user:<id>` para notificações. A camada de serviço emite via `realtime` (no-op sem servidor anexado, útil nos testes).
- **Consequências:** o web mostra badge/toast e invalida caches sem polling agressivo; o polling de 30 s continua como rede de segurança.

## 9. Jobs no processo da API

- **Contexto:** aprovação tácita precisa rodar sem ação humana; não há infraestrutura de filas.
- **Decisão:** agendador em processo (`setInterval`, sem sobreposição, falhas isoladas), ligado por `JOBS_ENABLED`, e um comando `jobs:run` para cron externo.
- **Consequências:** simples de operar num container; em cluster, ligar em uma instância só (documentado). Idempotência garantida pelas transições com `WHERE status = :from`.

## 10. Escambo Score explicável e alimentado por dados reais

- **Contexto:** reputação opaca não gera confiança nem é defensável na banca.
- **Decisão:** índice 0–100 com quatro dimensões visíveis (qualidade, experiência, prova social, responsividade), pesos fixos e fórmulas simples. Nota média e contagem são recalculadas na transação da avaliação; a responsividade é uma média móvel do tempo de resposta no chat.
- **Consequências:** o usuário entende o que subir; os pesos são um ponto único de ajuste. Não há aprendizado de máquina, de propósito.

## 11. Descoberta local no banco, sem serviço externo

- **Contexto:** "perto de mim" precisa funcionar sem custo por chamada.
- **Decisão:** Haversine em SQL, filtrado numa tabela derivada (evita `HAVING` sem `GROUP BY` no MySQL 8); coordenadas ficam no perfil do freelancer, preenchidas pela geolocalização do navegador.
- **Consequências:** sem dependência de mapas; para milhões de linhas, evoluir para índice espacial.

## 12. Admins por lista de e-mails

- **Contexto:** não existia caminho para a primeira conta admin.
- **Decisão:** `ADMIN_EMAILS` (e-mails ou `@dominio`) promove no cadastro/login; padrão só na demo do compose.
- **Consequências:** zero UI para gestão de admins (proposital neste estágio); em produção a variável é o controle.

## 13. Front sem gerenciador de estado global

- **Contexto:** dados são majoritariamente de servidor.
- **Decisão:** TanStack Query para tudo que vem da API (chaves centralizadas, invalidação nas mutations, `useInfiniteQuery` na busca); contexto React só para sessão e toasts.
- **Consequências:** menos código e menos bugs de sincronização; cada tela declara o que precisa.

## 14. Um comando para subir tudo

- **Contexto:** a banca e qualquer pessoa precisam rodar sem instalar Node.
- **Decisão:** `docker compose up -d --build` (db → migrate → api → web/nginx sem root) e `docker compose run --rm demo-seed` que popula pela própria API HTTP, idempotente.
- **Consequências:** a demo exercita as mesmas rotas do produto; portas e segredos por `.env`.

## 15. Carteira pré-paga, gateway atrás de interface e ledger de R$

- **Contexto:** o escrow creditava o freelancer sem nunca debitar o cliente: não existia entrada de dinheiro, reembolso real nem processamento de saque. Integrar um gateway de verdade exige contrato, credenciais e homologação — fora do escopo acadêmico, mas o produto precisa do caminho pronto.
- **Decisão:** modelo **pré-pago** (como no iFood). O cliente deposita via PIX; a proposta em dinheiro **reserva** o valor na mesma transação da criação (402 sem saldo); no aceite a reserva paga a contratação (líquido → escrow do freelancer, taxa → plataforma); recusa, cancelamento e disputa devolvem ao cliente a fração do **preço** e liberam ao freelancer a fração do **líquido**, sem sobra. O gateway fica atrás de uma interface (`PaymentGateway`) com uma única implementação **simulada**, que gera BR Code válido (EMV + CRC16); a confirmação chega por **webhook** com segredo (o caminho real) ou pelo endpoint de simulação (`PAYMENTS_SIMULATE`, só demo/dev). Toda movimentação de R$ grava linha em `wallet_transactions` (disponível, retido, saldos resultantes, motivo e referência), espelhando o ledger de créditos. Saques nascem `requested` e são processados pelo admin (`processing` → `completed` | `failed` com estorno); o titular pode cancelar antes.
- **Consequências:** o dinheiro fecha em qualquer caminho (cliente + freelancer + taxa = preço) e é auditável; trocar de gateway é implementar a interface e apontar o webhook. Créditos continuam retidos só no aceite (já estão na carteira). Propostas pendentes anteriores ao modelo foram encerradas pela migration `0002` (nunca tiveram valor reservado). O custo é o cliente precisar depositar antes de propor — mitigado pelo depósito dentro do próprio modal de contratação.

## 16. Torna da troca pela mesma carteira, com taxa só sobre a torna

- **Contexto:** a troca (o nome do produto) registrava a torna mas nunca movia dinheiro ("settlement TODO"). Com a carteira pré-paga passou a existir um meio de cobrar. A regra original previa comissão de 15% sobre o maior valor estimado — o que exigiria cobrar dinheiro dos dois lados numa transação pensada para não ter dinheiro.
- **Decisão:** a torna é reservada da carteira de quem paga no momento em que essa pessoa se compromete (proponente ao propor, receptor ao aceitar; 402 sem saldo, com depósito no próprio card). Fica retida enquanto os dois contratos recíprocos correm e, quando ambos são aprovados, o outro lado recebe torna − 15% e a plataforma fica com a taxa; troca equilibrada não tem taxa. Recusa, cancelamento antes do aceite e cancelamento de um dos contratos (troca em disputa) devolvem a reserva. O dinheiro tem máquina de estados própria (`torna_status`: none → pending → held → paid | refunded), separada do status do acordo; acordos antigos já ativos liquidam sem movimentar dinheiro.
- **Consequências:** a troca fecha financeiramente pelo mesmo ledger das contratações e a receita da plataforma soma as taxas de torna liquidadas. RN-066 foi alinhada à regra implementada. O custo é o pagador precisar de saldo antes de se comprometer — o mesmo trade-off da carteira pré-paga.

## 17. Direitos do titular: cópia gerada na hora e exclusão por anonimização

- **Contexto:** portabilidade e esquecimento (LGPD, art. 18) existiam só como registro de pedido, sem arquivo e sem efeito. Apagar fisicamente uma conta quebra contratações, avaliações e extratos de terceiros e as obrigações fiscais.
- **Decisão:** a cópia de dados é montada na hora do pedido (o volume por titular é pequeno), em JSON legível, gravada em `DATA_DIR` (volume no Docker) e baixada por rota autenticada só pelo titular, com validade de `EXPORT_TTL_DAYS`; um job apaga os arquivos vencidos. A exclusão é um pedido analisado pelo admin: contratações abertas ou dinheiro na carteira barram o pedido (a plataforma não pode sumir com escrow); concluir **anonimiza** (e-mail, telefone, senha, perfil, serviços, favoritos, buscas salvas e notificações) numa transação, revoga sessões e bloqueia o token vigente; contratações, mensagens, avaliações e extratos ficam sem identificação. Recusar exige justificativa, que o titular vê no Perfil e recebe por notificação.
- **Consequências:** o direito é atendido de fato e é auditável (ações do admin em `admin_actions` e `audit_logs`), sem corromper o histórico das outras partes. Um export assíncrono (fila) seria o próximo passo se o volume crescer; a máquina de estados já prevê `pending → processing → ready`.

## 18. E-mail transacional com caixa de saída, confirmação de e-mail e recuperação de senha

- **Contexto:** não existia nenhum e-mail — nem recuperação de senha, nem confirmação do endereço — e a demo precisa funcionar sem credenciais de um provedor.
- **Decisão:** provedor de e-mail atrás de interface (o mesmo desenho do gateway de pagamento): `simulated` grava cada e-mail em `email_outbox` e considera entregue (o admin lê a caixa de saída no painel; a demo e os testes tiram os links dela); `smtp` envia via nodemailer com `SMTP_*`. Todo e-mail passa pela caixa de saída (auditoria, status e erro), e o envio é melhor esforço: nunca derruba cadastro, pagamento ou notificação. Tokens de confirmação e de redefinição são de uso único, guardados como hash (como os de sessão), consumidos numa transação e com validade curta; um pedido novo invalida o anterior. "Esqueci minha senha" responde igual exista ou não a conta; redefinir troca a senha, confirma o e-mail e encerra todas as sessões. A confirmação é **suave**: o app funciona sem ela, com um lembrete e reenvio, porque exigir confirmação antes de qualquer uso mataria a demo e a conversão. Notificações relevantes (contratação, troca, disputa, pagamento, LGPD) também vão por e-mail; chat não.
- **Consequências:** trocar de provedor é implementar a interface; nada de segredo no repositório. Sem SMTP, os links ficam acessíveis só a admins (caixa de saída), o que é exatamente o que a demo precisa. Verificação obrigatória para ações sensíveis (saque, por exemplo) fica como evolução simples: o campo já existe em `PublicUser`.

## 19. Escrow por marcos como camada sobre o contrato, não como outro contrato

- **Contexto:** RN-069 previa marcos financiados e liberados individualmente, mas o contrato só tinha entrega e aprovação únicas. Modelar cada marco como um contrato separado duplicaria proposta, aceite, chat, disputa e avaliação.
- **Decisão:** o contrato continua um só (uma proposta, uma reserva na carteira, um aceite, um chat, uma avaliação); os marcos são uma tabela filha com a própria máquina de estados (`pending → funded → delivered → released`, ou `cancelled`) e o próprio líquido, calculado com a mesma taxa e com o último marco absorvendo o arredondamento para a soma bater com o líquido do contrato. O aceite financia todos os marcos na mesma transição; a aprovação de um marco libera só o líquido daquele marco na mesma transação que muda o status e grava o histórico; a última aprovação conclui o contrato. Contrato por marcos não aceita entrega/aprovação únicas (409). Cancelamento e disputa liquidam apenas o que ainda não foi liberado (`escrowRemaining`), e a aprovação tácita do job também vale por marco. Só em dinheiro nesta versão: créditos continuam de entrega única.
- **Consequências:** projetos longos reduzem o risco dos dois lados sem duplicar fluxos; o histórico do contrato conta a história marco a marco. A revisão por marco não muda o status do contrato (o marco volta a `funded` com a nota). Marcos em créditos e prazos por marco com alerta ficam como evolução natural da mesma tabela.

## 20. Produção como caminho de primeira classe: imagens do CI, compose de produção e borda com HTTPS

- **Contexto:** o projeto subia em um comando na máquina de quem avalia, mas publicar de verdade exigia clonar o repositório na VPS, compilar lá, configurar TLS à mão e torcer para o schema estar em dia. Sem imagem versionada não existe rollback; sem backup não existe operação; e o catálogo (categorias, planos, configurações) só entrava pelo init do Docker, que não roda num banco gerenciado nem num volume já existente.
- **Decisão:** o CI ganha um quarto job, só em `main` e só depois dos três jobs de teste, que constrói as duas imagens e publica no GHCR com três tags (`latest`, sha curto e versão do `package.json`). Um `docker-compose.prod.yml` **separado** (não um override) descreve a produção: imagens do registro fixadas por `IMAGE_TAG`, segredos obrigatórios (`${VAR:?}`), banco e API sem porta no host, `TRUST_PROXY=2`, simulador de pagamento desligado, SMTP, e o Caddy como única porta de entrada, com certificado automático, HTTP/3 e HSTS. O job de migrations passa a carregar o seed de referência quando o catálogo está vazio (uma vez só, para não sobrescrever o que o admin alterar), e `GET /api/health` devolve versão e commit gravados na imagem (`GIT_SHA`), para conferir o que está no ar. Backup e restauração são dois scripts que rodam `mysqldump`/`mysql` dentro do container do banco, sem senha em argumento nem em arquivo. Junto vai um hardening que só faz sentido com usuários reais: **saque exige e-mail confirmado** (403 `email_not_verified`; a Carteira mostra o bloqueio e o reenvio do link), porque é a única ação que tira dinheiro da plataforma e uma sessão roubada não pode mandá-lo para uma chave PIX de terceiro.
- **Consequências:** deploy e rollback viram trocar uma tag e rodar `up -d`; a VPS não precisa de Node nem do repositório; o que está no ar é conferível pelo health. O arquivo separado duplica o bloco de ambiente do compose da demo de propósito: os defaults de produção são o oposto dos da demo, e um override com `!reset` esconderia isso. Pagamento real continua fora (ADR 15): em produção o depósito só se confirma por webhook. Sem SMTP, o freelancer não saca até um admin confirmar o e-mail pela caixa de saída — trade-off assumido.
