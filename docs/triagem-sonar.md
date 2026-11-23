# Triagem do SonarCloud

Triagem dos alertas de **segurança** e de **confiabilidade** que o SonarCloud abriu na `main` da versão 1.57.0
(análise de 23/11/2026): **127 alertas**, 31 de segurança e 96 de confiabilidade, com nota E nas duas
categorias. A nota E vinha de alertas de severidade _blocker_: a senha do MySQL dos testes escrita nos comandos do
CI, os dois `UPDATE` sem `WHERE` de migrations antigas e um laço de script cuja condição de parada o analisador não
via mudar.

Regra da triagem: o que procede é **corrigido no código**. O que não procede fica em `sonar-project.properties`
(`sonar.issue.ignore.multicriteria`), regra a regra e arquivo a arquivo, com o motivo ao lado. Assim a decisão fica
versionada e revisada no PR, e não num "Aceitar" no painel, que ninguém vê no repositório. Os _security hotspots_
estavam zerados.

Painel: [sonarcloud.io/project/overview?id=Guirenzo_Escambo](https://sonarcloud.io/project/overview?id=Guirenzo_Escambo).

## Resumo

| Destino                                     | Alertas | Onde                                                                     |
| ------------------------------------------- | ------: | ------------------------------------------------------------------------ |
| Corrigido no código                         |     107 | CI, Dockerfiles, scripts de backup e de carga, API e web                 |
| Não procede, registrado com o motivo        |      20 | credenciais de teste, migrations já aplicadas, ferramentas do operador, acessibilidade que já está certa |

## Corrigidos

### CI e imagens (segurança)

| Regra                                                           | Qtd. | O que mudou                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets:S6697` senha do MySQL no código (_blocker_)             |    4 | O _health check_ dos contêineres de MySQL do CI usa `mysqladmin ping` sem senha (o comando sai com 0 mesmo com acesso negado: só confere que o servidor responde). O seed do E2E lê a senha de `DB_PASSWORD` via `MYSQL_PWD`. |
| `githubactions:S7637` action de terceiro sem SHA                 |    5 | `sonarqube-scan-action`, `setup-buildx-action`, `login-action` e `build-push-action` fixadas no SHA do commit, com a versão em comentário (o Dependabot de `github-actions` continua atualizando).                              |
| `githubactions:S6505` / `docker:S6505` scripts de instalação     |    8 | `npm ci --ignore-scripts` no CI e nos dois Dockerfiles. Nenhum pacote do projeto precisa de script de instalação: os que têm são telemetria (`@scarf/scarf`), o `esbuild` (o binário vem como dependência opcional da plataforma) e o `fsevents` (só macOS). |
| `githubactions:S8543` `npx` sem versão                           |    1 | O Chromium do Playwright é instalado pelo binário local (`node_modules/.bin/playwright`), na versão do lockfile.                                                                                                                |

O deploy também ganhou a condição explícita de que o CI que dispara o deploy automático é de um push **neste**
repositório (`head_repository.full_name == github.repository`).

### Scripts de shell e de manutenção (confiabilidade)

| Regra                                         | Qtd. | O que mudou                                                                                                                                                                                                 |
| --------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell:S7688` `[` em vez de `[[`              |   44 | Os testes dos scripts bash de backup, restauração, segredos e do teste de backup passaram a `[[ ]]`. O trecho que roda em `sh -c` dentro do contêiner continua com `[`, porque lá não é bash.                 |
| `javascript:S2189` laço sem condição de parada |    2 | O teste de carga para os usuários virtuais por `AbortController`, em vez de uma variável que só muda fora do laço.                                                                                          |
| `javascript:S9383` promessa solta              |    1 | A requisição em voo do teste de carga sai do conjunto com sucesso ou erro (`then(sair, sair)`), sem rejeição sem tratamento.                                                                                 |
| `javascript:S2871` `sort()` sem comparador     |    4 | Comparador explícito com a mesma ordem de antes (por unidade de código). A saída do `module-graph.mjs` ficou idêntica.                                                                                       |
| `javascript:S8786` regex com retrocesso        |    1 | O texto de link do `wiki-build.mjs` não aceita colchete, e cada `[` vira no máximo uma tentativa. As 25 páginas geradas ficaram idênticas.                                                                  |
| `jssecurity:S5145` injeção em log              |    1 | O `demo-seed.mjs` troca quebra de linha por espaço antes de escrever no terminal.                                                                                                                           |

### API (confiabilidade e segurança)

| Regra                                         | Qtd. | O que mudou                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript:S8786` regex com retrocesso       |   11 | As regex trocadas por leitura em tempo linear (`utils/text-scan.ts`, `trimEndChar`, `trimEdges`), com a mesma semântica. O caso que importa é a detecção de e-mail no chat (`off-platform.ts`), que roda sobre texto do usuário: era um ReDoS de verdade. Os testes comparam o resultado novo com a regex antiga em milhares de textos sorteados e medem o tempo com entrada maliciosa de 40 mil a 200 mil caracteres. |
| `typescript:S9383` promessa solta             |    3 | `void` explícito, com comentário: `deliver()` do tempo real já captura a falha, registra no log e nunca rejeita.                                                                                                                                  |
| `typescript:S7727` `.map(fn)` direto          |    2 | Arrow explícita no ranking (`(r, i) => toLeaderboardEntry(r, i)`): a função usa o índice como posição.                                                                                                                                             |
| `typescript:S7737` objeto literal como padrão |    1 | Constante `SINGLE_FILE_LIMITS` no upload.                                                                                                                                                                                                         |
| `typescript:S7773` `NaN` global               |    1 | `Number.NaN`.                                                                                                                                                                                                                                     |

### Web (acessibilidade, confiabilidade e segurança)

| Regra                                            | Qtd. | O que mudou                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript:S6852` contêiner interativo sem foco |   11 | O tratador de teclado das abas (setas, Home, End) saiu do contêiner `tablist` e foi para cada `role="tab"`, onde o foco fica, como no padrão de abas da WAI-ARIA. O `onTablistKeyDown` acha a lista por `closest('[role="tablist"]')`. |
| `typescript:S6848` elemento não nativo clicável  |    2 | No anexo do chat, o fundo do visualizador só fecha quando o clique é nele mesmo (`target === currentTarget`), sem `stopPropagation`. Na galeria, o palco de gestos é `role="presentation"`: tudo tem equivalente no teclado e nos botões. |
| `tssecurity:S8475` armazenamento envenenado      |    1 | Só vai para o `localStorage` (e só volta dele) o que tem forma de token: base64url e ponto, até 4 KB. Do login com Google, o papel só grava `client` ou `freelancer`, e o nome perde os caracteres de controle e fica em 150 (o alerta desse nome está em "Não procedem"). |
| `typescript:S8786` regex com retrocesso          |    1 | A mesma detecção de e-mail da API, em leitura linear (`offPlatform.ts`), com teste contra a regex antiga e entrada de 200 mil caracteres.                                                                                          |
| `typescript:S7773` / `S7737`                     |    3 | `Number.NaN`, `Number.parseFloat` e a constante `ORIGIN` como padrão do parâmetro.                                                                                                                                                 |

## Não procedem (registrados em `sonar-project.properties`)

| Regra                                         | Qtd. | Onde                                                                 | Por que não procede                                                                                                                                                                                       |
| --------------------------------------------- | ---: | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript:S2068` / `javascript:S2068`       |    5 | configuração dos testes de integração e do E2E, `scripts/carga`, `scripts/demo-seed.mjs` | É a senha padrão do MySQL descartável dos testes (o do CI e o do `docker-compose.yml` de desenvolvimento), sobrescrita por variável de ambiente, e a senha das contas fictícias da demonstração, publicada no README de propósito para o avaliador entrar. Nenhuma vale para dado real. |
| `plsql:DeleteOrUpdateWithoutWhereCheck`       |    2 | migrations `0003` e `0025`                                           | É de propósito: a `0003` preenche a coluna nova em todas as linhas, e a `0025` apaga o `user_agent` de todas as inscrições de push (minimização, LGPD). Migration já aplicada não muda: o `migrate` confere o checksum. |
| `plsql:NullComparison`                        |    1 | migration `0045`                                                     | A regra é do dialeto Oracle, em que `''` é `NULL`. No MySQL, `period_key = ''` compara com o texto vazio, que é o padrão da coluna.                                                                       |
| `jssecurity:S7044` / `jssecurity:S8476`       |    2 | `scripts/demo-seed.mjs`                                              | Ferramenta do operador, fora da aplicação: o endereço da API vem do próprio operador (`API_URL`), e o script só chama a API que ele mandou popular.                                                         |
| `githubactions:S7631` código de fork          |    1 | `.github/workflows/deploy.yml`                                       | O checkout é do commit que o CI aprovou num push na `main` deste repositório, conferido contra o rótulo da imagem; execução de pull request, de fork ou não, nunca chega ao job (condição explícita no `if`). |
| `jssecurity:S8707` caminho vindo de argumento |    2 | `scripts/wiki-build.mjs`                                             | O argumento só é aceito como nome simples `.wiki-*` (sem barra), conferido antes de virar caminho; qualquer outro é recusado antes de apagar qualquer coisa.                                                |
| `typescript:S6845` `tabIndex` em não interativo |    2 | `AvatarCropper.tsx`, `components/ui/index.tsx`                       | De propósito: o recorte do avatar é operado pelo teclado (setas movem, + e − dão zoom), e a tabela rolável precisa de foco para rolar sem mouse (regra `scrollable-region-focusable` do axe, WCAG 2.1.1). |
| `typescript:S6852` contêiner sem foco          |    1 | `Stars.tsx`                                                          | As estrelas são rádios nativos e o foco fica neles. O grupo só tem `onMouseLeave`, para limpar a prévia; torná-lo focável criaria uma parada de Tab inútil.                                                  |
| `typescript:S6853` rótulo sem texto            |    3 | `EmailPreferencesCard.tsx`, `ContratarModal.tsx`, `SavedSearches.tsx` | O rótulo tem texto, três níveis abaixo (`span > strong > texto`), e a regra só olha dois. Os testes acham os rádios pelo nome, e `ContratarModal.test.tsx` confere o nome acessível.                        |
| `tssecurity:S8475` armazenamento envenenado    |    1 | `apps/web/src/lib/google.ts`                                         | O nome da conta Google vem da nossa própria API e fica no `sessionStorage` só durante o retorno do Google, para sugerir o nome do perfil. Ele só preenche o campo (o React escapa) e a API valida ao salvar; mesmo assim sai sem caracteres de controle e com no máximo 150. A análise da `main` depois da triagem acusou só este. |

## Como conferir

- O painel do SonarCloud mostra a análise da `main` depois do merge; o PR mostra o que ele mesmo introduz.
- A justificativa de cada alerta que não procede está ao lado da regra em `sonar-project.properties`.
- Os testes da API e do web rodam no CI como sempre (unidade, integração, E2E e cobertura) e o teste de backup
  exercita os scripts de shell alterados.
