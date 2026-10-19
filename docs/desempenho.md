# Desempenho e carga — RNF-001, RNF-002, RNF-005 e RNF-023

Medição feita em **19/10/2026** sobre a API **1.43.0** (commit `dfd1622` do ramo `feat/lacunas-interface`; a API é idêntica à do `c27ada1`, o commit seguinte só mexe no web e no CHANGELOG). Os scripts estão em [`scripts/carga/`](../scripts/carga/) e os números brutos, em JSON e em tabela, em [`scripts/carga/resultados/`](../scripts/carga/resultados/).

Esta é uma medição numa **máquina de desenvolvimento Windows com o MySQL em Docker Desktop**, com o gerador de carga na mesma máquina. Não é a VPS de produção (1 vCPU / 2 GB, ver [DEPLOY.md](../DEPLOY.md)). Os números dizem como o código se comporta e onde ele trava; não dizem quanto a VPS aguenta. A seção [Limites](#limites-da-medição) detalha o que isso muda.

## Resumo

| RNF | Meta | O que foi medido (execução B) | Veredito |
|---|---|---|---|
| RNF-001 | P95 ≤ 300 ms nas leituras | Em taxa fixa até 200 req/s, o pior p95 entre as 10 rotas foi 80,5 ms (busca sem texto). Em laço fechado: 10 VUs, pior p95 115,6 ms; 50 VUs, só `GET /wallet` passou de 300 ms (425,8 ms); 100 VUs, 5 das 10 rotas passaram de 300 ms. Capacidade da mistura: ~375 req/s, limitada pelo MySQL. | **Atende com ressalva** |
| RNF-002 | P95 ≤ 500 ms nas escritas | Em taxa fixa até 100 req/s, o pior p95 foi 35,4 ms (proposta). Em laço fechado: 10 e 50 VUs passam (pior 400,8 ms); 100 VUs, proposta 789 ms e pagamento simulado 540 ms. Capacidade: ~200 req/s, limitada pelo commit em disco. Em outras execuções, com o disco disputado, 50 req/s já deu p95 de 1,3 s. | **Atende com ressalva** |
| RNF-005 | Entrega em tempo real ≤ 500 ms | Mensagem da Sala: p95 de 26,6 a 34,2 ms sem carga e com leitura a 100 req/s; aviso (`notification:new`): p95 ≤ 43,4 ms; 100% abaixo de 500 ms, com 500 e 1000 conexões abertas. Com a API saturada (leitura em 50 VUs), p95 de 711 a 820 ms. | **Atende com ressalva** |
| RNF-023 | ≥ 500 conexões WebSocket simultâneas | 500 e 1000 conexões autenticadas: 0 falhas, 0 quedas, todas de pé por 194 s e recebendo o ping do servidor. A latência da Sala ficou igual nos dois totais. | **Atende** (com os limites do ambiente) |

"Com ressalva" quer dizer: a meta é cumprida em carga moderada, e deixa de ser quando o banco satura. Neste ambiente, a saturação vem antes de 100 usuários sem tempo de pensar. Na VPS de 1 vCPU, ela deve vir bem antes (ver [Limites](#limites-da-medição)).

## Como rodar

Pré-requisitos: `npm install` já feito (o teste usa `mysql2`, `socket.io-client` e `tsx` que já estão no `node_modules`, sem dependência nova), o MySQL do `docker compose` no ar em `127.0.0.1:3306` com o usuário root, e a porta 3340 livre.

```bash
node scripts/carga/rodar-tudo.mjs                     # tudo, ~25 min (o seed leva ~4–5 min)
node scripts/carga/rodar-tudo.mjs --rapido            # fumaça, ~5 min, só para ver se funciona

# A API de outro checkout (foi assim nesta medição):
CARGA_API_DIR=C:/Users/guilherme/Documents/EscamboRepo-lacunas/apps/api node scripts/carga/rodar-tudo.mjs

# Repetir uma parte sem recriar o banco (usa o seed da última execução):
node scripts/carga/rodar-tudo.mjs --reaproveitar --pular leitura,leitura-taxa,teto,ws
```

O `rodar-tudo.mjs` faz, em ordem:

1. Apaga e recria o banco `escambo_carga` e aplica `schema.sql` + migrations + seed de referência pelo mesmo runner da produção (`src/scripts/migrate.ts`). Por segurança, o script recusa qualquer banco sem "carga" no nome. O banco `escambo` não é tocado.
2. Sobe a API (`node --import tsx src/server.ts`, um processo, sem watch) na porta 3340, apontando para o `escambo_carga`.
3. Semeia pela própria API HTTP, com os mesmos dados a cada execução (semente fixa).
4. Roda escrita, leitura, o teto sem banco e o WebSocket.
5. Derruba a API (também no Ctrl+C) e grava `scripts/carga/resultados/carga-<data>.json` e `.md`.

Variáveis de ambiente: `CARGA_API_DIR`, `CARGA_PORTA` (3340), `CARGA_DB_HOST/PORT/USER/PASSWORD/NAME`, `CARGA_DB_POOL` (10), `CARGA_FREELANCERS` (250), `CARGA_CLIENTES` (250), `CARGA_SERVICOS` (10 000) e `CARGA_PARES_WS` (30). Opções: `--niveis`, `--taxas-escrita`, `--taxas-leitura`, `--duracao`, `--aquecimento`, `--conexoes`, `--latencia`, `--fundos`, `--pular` e `--reaproveitar` (cabeçalho do `rodar-tudo.mjs`). O estado do seed, com os tokens das contas de teste, fica em `%TEMP%/escambo-carga/` e nunca no repositório. O log da API fica na mesma pasta.

| Arquivo | Papel |
|---|---|
| `scripts/carga/rodar-tudo.mjs` | Orquestra tudo e escreve os resultados |
| `scripts/carga/ambiente.mjs` | Banco de carga, subida e queda da API, CPU e memória dos processos, observação do MySQL (`performance_schema`), dados da máquina |
| `scripts/carga/semear.mjs` | Massa de dados pela API |
| `scripts/carga/carga-http.mjs` | Carga HTTP em laço fechado e em taxa fixa (também roda sozinho) |
| `scripts/carga/carga-ws.mjs` | Conexões Socket.IO e latência da Sala (também roda sozinho) |
| `scripts/carga/lib.mjs` | Cliente HTTP, percentis, coletor por rota, tabelas |

## Método

### Ambiente

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 7 5700X, 8 núcleos / 16 threads |
| RAM | 31,9 GB |
| Sistema | Windows 11 Pro 10.0.26200 |
| Node | 22.14.0 (API e gerador de carga, na mesma máquina) |
| MySQL | 8.0.46 no container `escambo-mysql` (Docker Desktop 29.5.3, VM com 16 CPUs e 16 GB), buffer pool de 128 MB (padrão), `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1` |
| Custo de um commit | ~6,9 ms de p50 (200 INSERTs com autocommit numa conexão, sem carga): é o fsync do disco virtual do Docker Desktop |

Configuração da API sob teste: `NODE_ENV=production`, `LOG_LEVEL=info` (log por requisição gravado em arquivo, como em produção), `DB_CONNECTION_LIMIT=10` (o padrão; a produção não muda), `JOBS_ENABLED=false`, `MAIL_PROVIDER=simulated` (o e-mail vira linha no banco), `PUSH_PROVIDER=simulated`, `PAYMENTS_SIMULATE=true` (gateway simulado, ADR 15) e `METRICS_PORT=0`.

**Rate limit.** Toda a carga sai de 127.0.0.1, e o limite por IP de produção (120 req/min) barraria o teste no primeiro segundo. O teste sobe `RATE_LIMIT_MAX` e `LOGIN_RATE_LIMIT_MAX` por variável de ambiente, sem mudar código. O limitador continua no caminho de toda requisição: só o teto muda.

**Usuário do banco.** A API do teste conecta como root no `escambo_carga`, para não criar usuário nem mexer em permissões no MySQL compartilhado. Isso não muda o custo das consultas.

### Massa de dados

Tudo pela API, como o front faz: 250 freelancers e 250 clientes (cadastro com aceite dos termos, login), perfil de freelancer com cidade, coordenadas e dias de atendimento, **10 000 serviços** distribuídos entre os freelancers e 17 categorias, um depósito PIX de R$ 50.000 "pago" no gateway simulado para cada cliente, e 30 propostas que abrem as Salas do teste de WebSocket. Leva ~4–5 min, quase tudo no bcrypt de 12 rodadas do cadastro e do login (1000 operações).

Único atalho fora da API: o e-mail das contas `@carga.test` é marcado como confirmado direto no banco de carga, com o mesmo UPDATE que o link de confirmação executa. O saque exige e-mail confirmado (ADR 20), e o link só existe na caixa de saída simulada.

No fim da execução B o banco tinha 11 776 contratações, 9107 pagamentos, 8799 saques, 25 179 lançamentos de carteira, 8226 mensagens, 24 606 notificações e 16 880 e-mails na caixa de saída. As leituras rodam depois das escritas, então medem um banco já cheio.

### Carga HTTP

Duas formas de gerar carga, cada uma com 10 s de aquecimento descartado e 30 s medidos por nível:

- **Laço fechado** com 10, 50 e 100 usuários virtuais (VUs). Cada VU manda a próxima requisição assim que a anterior responde, sem tempo de pensar. É uma carga de estresse: 10 VUs sem pausa já mantêm o pool de 10 conexões do banco sempre ocupado. Mede a capacidade e o que acontece na fila.
- **Taxa fixa de chegada**: 25, 50 e 100 req/s de escrita, e 50, 100 e 200 req/s de leitura. As requisições saem em intervalos fixos, sem esperar a anterior, como usuários independentes chegando. É a medida que corresponde a "carga normal". A latência inclui a fila, sem o viés do laço fechado (*coordinated omission*). O timer do Windows tem granularidade de ~15 ms, então as chegadas saem em pequenas rajadas.

Cada operação é sorteada com pesos (semente fixa por VU):

| Leitura (RNF-001) | Peso | Escrita (RNF-002) | Peso |
|---|---|---|---|
| `GET /services` sem texto (páginas 1–5) | 15 | `POST /contracts`: proposta em dinheiro a partir de um serviço | 40 |
| `GET /services?q=` (9 termos e 1 sem resultado) | 15 | `POST /wallet/deposits`: cobrança PIX (metade é "paga" em seguida com `POST /wallet/deposits/:id/simulate`, contada à parte) | 30 |
| `GET /services` com categoria, preço máximo e ordem por preço | 10 | `POST /withdrawals`: saque PIX de R$ 20–40 | 30 |
| `GET /services` por proximidade (lat/lng, 50 km) | 5 | | |
| `GET /services/:id` | 15 | | |
| `GET /categories` | 5 | | |
| `GET /profiles/freelancer/:ulid` | 10 | | |
| `GET /gamification/leaderboard` (ranking, autenticado) | 5 | | |
| `GET /wallet` (carteira) | 10 | | |
| `GET /wallet/transactions` (extrato) | 10 | | |

Pré-condições das escritas: a proposta reserva o valor na carteira do cliente (por isso o depósito no seed). Pela RN-020, cada proposta usa um par cliente→freelancer ainda sem proposta aberta (o script percorre os 62 500 pares sem repetir). O saque é feito por clientes com e-mail confirmado e saldo.

Estatística: percentil por posição sobre todas as amostras da janela. Só entra a requisição que começou e terminou dentro da janela. A latência vai do envio ao último byte (com `Accept-Encoding: gzip`, como o navegador) e é calculada só sobre respostas 2xx; as demais contam como erro, por código. **Nenhuma requisição falhou em nenhuma das medições.** Vazão = requisições na janela / 30 s.

Instrumentação, toda de leitura: CPU e memória do processo da API (`Get-Process` no início e no fim da janela), CPU do container do MySQL (`docker stats` no meio da janela), comandos SQL por requisição e as consultas mais caras da janela (`performance_schema.events_statements_summary_by_digest`, diferença entre o início e o fim), e quais **outros bancos** do mesmo servidor MySQL estavam executando algo (a cada 2 s). Isso importou: outros agentes rodavam testes de integração e benchmarks no mesmo container durante parte das medições (ver [Repetição](#repetição-e-variação)).

### WebSocket

Para 500 e depois 1000 conexões:

1. Abre as conexões em lotes de 50, cada uma com o JWT de uma conta (`transports: ['websocket']`, `forceNew`, sem reconexão automática). Com 500, é uma conexão por conta. Com 1000, duas por conta, como duas abas ou aparelhos.
2. O freelancer de cada uma das 30 Salas entra na sala do contrato (`contract:join`).
3. Mede a latência: em cada Sala, o cliente manda 1 mensagem por segundo. O relógio vai do envio até o `message:new` chegar no socket do freelancer e até o `notification:new` (o aviso) chegar na sala pessoal dele. Envio e recepção ficam no mesmo processo, então o relógio é o mesmo. Há dois caminhos de envio: `POST /api/messaging/contracts/:id`, que é o que o web usa, e o evento `message:send` do próprio socket. Mensagem que não chega em 5 s conta como não entregue; envio recusado conta à parte.
4. Mede sem carga (15 s), depois com carga de leitura de fundo num processo separado: **100 req/s em taxa fixa** (carga moderada) e **50 VUs em laço fechado** (API saturada). Cada caso roda 30 s por caminho de envio.
5. No fim (194 s depois de abrir), conta as conexões vivas, as quedas não pedidas e quantas receberam o ping do servidor (o Socket.IO pinga a cada 25 s, então isso prova que a conexão estava viva de fato).

## Resultados

Execução principal: **B**, `scripts/carga/resultados/carga-20261019-1540.*`. Nela, nenhum outro banco do servidor estava ativo durante as janelas. Tabelas completas por rota e nível estão no `.md` da execução. Aqui vão as linhas que decidem os vereditos.

### Leitura (RNF-001)

Taxa fixa (carga normal):

| Rota | p95 a 50 req/s | p95 a 100 req/s | p95 a 200 req/s | p99 a 200 req/s |
|---|---|---|---|---|
| `GET /services` sem texto | 65,7 | 68,3 | **80,5** | 94,7 |
| `GET /services?q=` | 36,2 | 39,0 | 44,1 | 52,3 |
| `GET /services` categoria + preço | 5,1 | 5,8 | 6,1 | 7,7 |
| `GET /services` proximidade | 11,1 | 14,7 | 15,4 | 18,4 |
| `GET /services/:id` | 2,2 | 2,5 | 3,3 | 4,6 |
| `GET /categories` | 2,3 | 3,1 | 3,5 | 4,7 |
| `GET /profiles/freelancer/:ulid` | 3,4 | 3,8 | 4,9 | 6,8 |
| `GET /gamification/leaderboard` | 4,0 | 3,8 | 5,4 | 6,8 |
| `GET /wallet` | 16,7 | 19,5 | 20,8 | 34,2 |
| `GET /wallet/transactions` | 4,1 | 4,2 | 5,7 | 7,3 |

Em ms. As três taxas foram atendidas por inteiro (49,9 / 100 / 199,9 req/s). A CPU da API ficou entre 0,11 e 0,33 núcleo e o MySQL entre 57% e 319% de CPU.

Laço fechado (estresse):

| Nível | Vazão | Pior p95 (rota) | Rotas com p95 > 300 ms | CPU API / MySQL |
|---|---|---|---|---|
| 10 VUs | 375,3 req/s | 115,6 ms (busca sem texto) | 0 de 10 | 0,68 núcleo / 848% |
| 50 VUs | 371,2 req/s | 425,8 ms (`GET /wallet`) | 1 de 10 | 0,71 núcleo / 880% |
| 100 VUs | 379,7 req/s | 842,9 ms (`GET /wallet`) | 5 de 10 (carteira, extrato 372,6, perfil 365,6, ranking 364,4, busca sem texto 300,6) | 0,72 núcleo / 869% |

A vazão não cresce de 10 para 100 VUs: o MySQL já está no limite com 10 (perto de 9 núcleos ocupados pelas 10 conexões do pool), e o que sobra vira fila. Até rotas que custam 2 ms sozinhas (`/categories`, detalhe) chegam a 200 ms de p95 a 100 VUs, porque esperam a vez no pool atrás das listagens.

### Escrita (RNF-002)

Taxa fixa (carga normal):

| Rota | p95 a 25 req/s | p95 a 50 req/s | p95 a 100 req/s | p99 a 100 req/s |
|---|---|---|---|---|
| `POST /contracts` (proposta) | 28,2 | 30,9 | **35,4** | 39,1 |
| `POST /wallet/deposits` (cobrança PIX) | 12,5 | 14,3 | 17,3 | 20,8 |
| `POST /wallet/deposits/:id/simulate` (pagamento simulado) | 23,2 | 24,7 | 29,7 | 35,2 |
| `POST /withdrawals` (saque) | 21,7 | 23,7 | 27,8 | 35,6 |

As taxas foram atendidas: 28,7, 57,4 e 114,5 req/s. A medida é por rota, e o pagamento simulado vem junto com metade dos depósitos, por isso a vazão passa da taxa nominal.

Laço fechado (estresse):

| Nível | Vazão | p95 proposta | p95 cobrança PIX | p95 pagamento simulado | p95 saque |
|---|---|---|---|---|---|
| 10 VUs | 204,4 req/s | 85,8 | 35,4 | 66,7 | 58,2 |
| 50 VUs | 205,1 req/s | 400,8 | 149,8 | 282,7 | 244,6 |
| 100 VUs | 199,8 req/s | **789,4** | 288,0 | **540,0** | 473,0 |

Cada requisição de escrita gera em média **14 comandos SQL**, contra 2,1 de uma leitura. Os que mais ocupam o banco são `COMMIT`, `INSERT INTO audit_logs` e `UPDATE email_outbox SET status = 'sent'`, com ~10 ms cada sob carga, porque cada um espera o fsync. A API usa 0,68 núcleo e o MySQL 78% de CPU. O limite é a durabilidade do commit, não a CPU.

### Teto sem banco

`GET /health/live` passa pelos mesmos middlewares (helmet, compression, log por requisição, métricas, rate limit) e não consulta o banco: **2406 req/s com 1,13 núcleo** (p95 24,9 ms a 50 VUs), ou seja, ~0,47 ms de CPU por requisição só no caminho comum do Express. Não é o gargalo hoje, mas é o piso de qualquer rota.

### WebSocket (RNF-023 e RNF-005)

| Conexões | Conectadas | Falhas | Tempo para abrir todas | Conexão p50 / p95 | De pé por | Vivas no fim | Com ping do servidor | Quedas |
|---|---|---|---|---|---|---|---|---|
| 500 | 500 | 0 | 0,7 s | 57,0 / 70,8 ms | 194 s | 500 | 500 | 0 |
| 1000 | 1000 | 0 | 1,3 s | 59,3 / 64,2 ms | 194 s | 1000 | 1000 | 0 |

Latência de entrega, do envio até o evento chegar ao outro lado (ms):

| Conexões | Carga de fundo | Envio por | Mensagens | Mensagem p50 / p95 / p99 | ≤ 500 ms | Aviso p50 / p95 / p99 |
|---|---|---|---|---|---|---|
| 500 | nenhuma | REST | 448 | 21,5 / 26,6 / 28,6 | 100% | 26,7 / 34,2 / 35,9 |
| 500 | leitura 100 req/s | REST | 893 | 23,4 / 32,1 / 36,8 | 100% | 29,5 / 39,6 / 43,7 |
| 500 | leitura 100 req/s | socket | 892 | 22,9 / 29,6 / 33,6 | 100% | 29,0 / 37,8 / 42,0 |
| 500 | leitura 50 VUs (saturada) | REST | 897 | 592,5 / 711,1 / 748,3 | 5,1% | 670,8 / 798,0 / 832,6 |
| 500 | leitura 50 VUs (saturada) | socket | 896 | 594,0 / 819,6 / 1067,8 | 3,2% | 670,9 / 912,9 / 1189,5 |
| 1000 | nenhuma | REST | 447 | 22,0 / 29,4 / 36,4 | 100% | 28,1 / 38,2 / 45,2 |
| 1000 | leitura 100 req/s | REST | 891 | 23,5 / 32,7 / 36,5 | 100% | 30,1 / 40,5 / 45,6 |
| 1000 | leitura 100 req/s | socket | 891 | 23,7 / 34,2 / 44,2 | 100% | 30,9 / 43,4 / 53,9 |
| 1000 | leitura 50 VUs (saturada) | REST | 897 | 596,7 / 723,4 / 798,3 | 2,5% | 671,4 / 811,1 / 878,2 |
| 1000 | leitura 50 VUs (saturada) | socket | 895 | 580,6 / 727,3 / 806,3 | 7,7% | 659,9 / 826,2 / 901,1 |

Nenhuma mensagem ou aviso deixou de chegar, e nenhum envio falhou. Ir de 500 para 1000 conexões não mudou a latência. O que a derruba é a saturação do banco. A mensagem só é emitida depois de passar pelo mesmo pool de 10 conexões: autenticação, contrato, gravação, e depois a revalidação de cada destinatário. Com a leitura saturando o pool, o chat entra na mesma fila. A memória da API (working set) não mudou de forma mensurável ao abrir as conexões (665 → 659 MB com 500; 295 → 278 MB com 1000): o efeito ficou dentro do ruído do coletor de lixo, então este método não estima o custo por conexão.

### Plano da busca no MySQL

A forma real da consulta de `services.repository.ts`, numa conexão só e sem carga (mediana de 20 execuções, 10 000 serviços):

| Consulta | Acesso | Índice | Mediana |
|---|---|---|---|
| Busca sem texto (como a API) | varredura (`ALL`) | — | 46,8 ms |
| Busca com texto, `LIKE '%react%'` (como a API) | varredura (`ALL`) | — | 28,8 ms |
| Termo inexistente, `LIKE` (como a API) | varredura (`ALL`) | — | 25,1 ms |
| Comparação: o mesmo texto via `MATCH ... AGAINST` | `fulltext` | `ft_svc_search` | 5,2 ms |
| Comparação: sem texto e sem o destaque na ordenação | varredura (`ALL`) | — | 14,8 ms |

Sob carga, o `performance_schema` registrou para a busca sem texto ~30 000 linhas lidas por execução e 92–98 ms de média. Para a busca com texto, ~10 800 linhas e 45–48 ms.

## Gargalos encontrados

Nenhum foi corrigido aqui. São registros para quem for mexer, com o número que os mostra.

1. **A listagem de serviços custa O(N) em toda chamada.** A consulta calcula `EXISTS(SELECT 1 FROM boosts ...)` (o destaque) para cada serviço ativo, ordena por ele e só depois aplica o `LIMIT 20`, levando `s.*` (com a `description` inteira) de todas as linhas para a ordenação. Com 10 000 serviços, são ~30 000 linhas lidas por chamada: 47 ms sozinha e ~95 ms sob carga. Tirar só o destaque da ordenação já leva a 14,8 ms. É a consulta que mais ocupa o banco em todos os níveis. No laço fechado com 10 VUs, a busca sem texto e a com texto somaram 233 dos ~300 conexão·s disponíveis na janela (10 conexões × 30 s), sendo só 30% das requisições. O custo cresce com o catálogo.
2. **A busca textual usa `LIKE '%q%'` e ignora o índice FULLTEXT.** `ft_svc_search (title, description)` existe no schema, mas a consulta faz varredura completa (`ALL`, ~10 800 linhas lidas por execução): 28,8 ms contra 5,2 ms do `MATCH ... AGAINST` no mesmo banco. **Corrigido na 1.44.0** (ADR 62): a busca com texto passou a usar o `MATCH ... AGAINST`, com fallback para termo curto. Com 100 mil serviços, caiu de 290–520 ms para 10–250 ms por consulta (EXPLAIN e tempos no ADR 62). Este registro fica como a linha de base.
3. **Um pool de 10 conexões compartilhado por tudo.** Rotas baratas, efeitos assíncronos (avisos, e-mails, auditoria) e o chat fazem fila atrás das listagens. `GET /categories` vai de 2 ms (p50 sozinha) para 200 ms de p95 a 100 VUs. A mensagem da Sala vai de 30 ms para 720 ms de p95 com a leitura saturada. Aumentar o pool só ajuda enquanto o MySQL tiver núcleos sobrando, o que não é o caso numa VPS de 1 vCPU.
4. **`GET /wallet` escreve e trava a cada leitura.** Para conferir o bônus de boas-vindas em créditos, toda consulta da carteira faz dois `INSERT IGNORE INTO wallets` e abre uma transação com `SELECT ... FOR UPDATE` na conta e na carteira (`credits.repository.ts`, `grantWelcomeIfNew`), mesmo quando o bônus já foi dado. É a pior leitura em todos os níveis do laço fechado (p95 de 425,8 ms a 50 VUs e 842,9 ms a 100 VUs) e disputa trava com as escritas da mesma carteira. **Corrigido na 1.44.0:** uma leitura sem trava confere antes se o bônus já saiu, e só a primeira consulta da carteira abre a transação (`creditsRepository.hasWelcome`).
5. **Cada escrita faz ~14 comandos SQL e vários commits independentes.** Além da transação principal, cada escrita grava `audit_logs`, insere o e-mail na caixa de saída e depois o marca como enviado, e grava `notifications`, cada um com o seu fsync. O commit custa 5–10 ms neste disco (até 37 ms quando outro processo disputa o disco). Por isso a capacidade de escrita para em ~200 req/s com a CPU sobrando, e a cauda cresce rápido acima disso.
6. **Autorização consultada no banco a cada requisição e a cada evento.** O `authenticate` faz uma consulta por requisição autenticada (`currentAccount`). O tempo real revalida cada socket destinatário no banco antes de emitir (`realtime.ts`, `deliver`). É uma escolha deliberada (a suspensão e o banimento valem na hora) e custa pouco por vez (0,5 s de banco somados na janela), mas multiplica as idas ao pool. Fica como observação, não como defeito.

## Repetição e variação

Foram três execuções completas. A escrita é a parte que mais varia, porque depende do disco do Docker Desktop, compartilhado com os outros containers da máquina:

| Execução | Arquivo | Condição | Escrita, laço fechado (vazão em 10 / 50 / 100 VUs) | Escrita, taxa fixa |
|---|---|---|---|---|
| 1 | `carga-20261019-1447` | Versão anterior do script (sem taxa fixa; o "plano da busca" dela usa uma consulta simplificada) | 155 / **45** / **22** req/s; p95 da proposta 134 ms / 5,8 s / 7,6 s | — |
| A | `carga-20261019-1515` | Testes de integração e benchmarks de outros agentes no mesmo MySQL (`escambo_test_catalogo*`) em 13/13 amostras da taxa fixa | 96 / 189 / 188 req/s | 25 req/s: p95 ≤ 30,7 ms. 50 req/s: p95 de 1279 ms na proposta. 100 req/s: não sustentou (37,8 req/s, p95 de 25 s) |
| **B** | `carga-20261019-1540` | Nenhum outro banco ativo | 204 / 205 / 200 req/s | 25, 50 e 100 req/s com p95 ≤ 35,4 ms |

Na execução A, o `COMMIT` custou em média 22 ms a 50 req/s e 37 ms a 100 req/s. Na B, 5,7 ms e 7,8 ms. A leitura variou menos (capacidade de 284–317 req/s na A e de 371–380 req/s na B), mas a busca por proximidade foi de 12 ms (B) a 65 ms (A) de média no banco. Como não investiguei a causa, fica registrada como instabilidade, sem explicação. Conclusão prática: os números de escrita deste documento valem para um disco sem disputa. Com o disco disputado, o mesmo código ultrapassou a meta já a 50 req/s.

## Limites da medição

- **Não é a VPS.** Aqui o MySQL usou até ~9 núcleos para servir a leitura (848–880% de CPU no laço fechado). Na VPS de 1 vCPU, API, MySQL e Caddy dividem um núcleo. A mistura de leitura gastou de 11 a 16 ms de CPU do MySQL por requisição em taxa fixa (do `docker stats`, uma amostra por janela, então é uma estimativa grosseira). Isso põe a capacidade de leitura na VPS na ordem de **algumas dezenas de req/s**, contra ~375 aqui, antes de contar o Node. Isso não foi medido lá. Por outro lado, o fsync de um SSD de VPS costuma ser mais rápido que o do Docker Desktop, então a escrita lá pode não ser pior. Também não foi medido.
- **Gerador de carga na mesma máquina.** O gerador disputa CPU com a API e o MySQL. Não há rede real, TLS nem proxy reverso (Caddy/nginx) no caminho.
- **MySQL compartilhado.** É o mesmo container da demonstração (banco `escambo`, ocioso durante os testes) e, em parte das execuções, de testes de outros agentes. O monitor registra isso por nível e as tabelas da execução A mostram onde aconteceu.
- **Código carregado pelo `tsx`**, não pelo `dist/` da imagem. O código é transformado uma vez, na carga do módulo, e depois roda igual. Diferença esperada: desprezível.
- **Rate limit afrouxado** por variável de ambiente (o limitador continua ativo). **E-mail simulado** (grava no banco em vez de falar com SMTP) e **gateway de pagamento simulado** (ADR 15): a latência de um PSP real e de um SMTP real não está nos números.
- **Laço fechado sem tempo de pensar não é usuário real.** 10 VUs assim equivalem a centenas de pessoas navegando. A taxa fixa é a medida de "carga normal", e o laço fechado mostra a capacidade e a fila.
- **Janelas curtas** (30 s por nível): não há teste de resistência (horas), de pico súbito nem de vazamento de memória.
- **WebSocket**: um único processo cliente; só o transporte `websocket` (o navegador começa por polling e faz upgrade); com 1000 conexões, duas por conta; uma instância da API sem adapter (Redis), como em produção hoje. A memória por conexão não foi estimada (ruído do GC).
- **Volume**: 10 000 serviços e 500 contas. A listagem piora com o catálogo (gargalo 1), então outro volume dá outro número.

## O que isso significa para os RNFs

- **RNF-001 — atende com ressalva.** Em carga normal (até 200 req/s em taxa fixa) todas as leituras ficaram abaixo de 81 ms de p95, longe dos 300 ms. A meta deixa de ser cumprida quando o banco satura (a partir de ~370 req/s aqui, bem menos numa VPS de 1 vCPU), e a primeira rota a estourar é `GET /wallet`. O que limita é a consulta de listagem (gargalos 1 e 2), não a API.
- **RNF-002 — atende com ressalva.** Com o disco sem disputa, propostas, cobranças PIX, pagamentos simulados e saques ficaram abaixo de 36 ms de p95 até 100 req/s em taxa fixa, e abaixo de 500 ms até 50 VUs em laço fechado. A capacidade (~200 req/s) é limitada pelo custo do commit multiplicado pelos ~14 comandos por escrita. Com o disco disputado, a meta caiu já a 50 req/s. O pagamento continua simulado (ADR 15): a latência de um gateway real fica fora.
- **RNF-005 — atende com ressalva.** Mensagens da Sala e avisos chegaram em 21–31 ms de p50 e no máximo 54 ms de p99 sem carga e com leitura moderada, com 500 e com 1000 conexões abertas. Nenhuma mensagem se perdeu. Com a API saturada, a entrega passa de 500 ms (p95 de 711–820 ms), porque o envio e a revalidação dos destinatários usam o mesmo pool do banco (gargalo 3).
- **RNF-023 — atende.** 1000 conexões autenticadas simultâneas, o dobro da meta, abriram em 1,3 s sem falha, ficaram 194 s de pé sem queda e responderam ao ping, e a latência da Sala não mudou entre 500 e 1000. O "pool de conexões configurado" da métrica é o pool do mysql2 (10), que vale também para os eventos do socket. Fica a ressalva de que tudo roda numa instância e foi testado na mesma máquina.

Para a [rastreabilidade](./rastreabilidade.md), os números acima e os arquivos de `scripts/carga/resultados/` são a evidência que faltava nas linhas da RNF-001, RNF-002, RNF-005 e RNF-023 ("não há teste de carga nem número medido"). Este documento não muda a situação registrada lá.
