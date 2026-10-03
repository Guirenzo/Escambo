# Deploy e CI/CD

**Integração contínua:** os pushes e os PRs passam pelo workflow **CI** (ver [Qualidade](Qualidade)).
**Entrega contínua:** em `main`, com os testes, o E2E e a cobertura verdes, o CI publica as imagens `escambo-api` e `escambo-web` no GHCR
com as tags `latest`, o sha curto e a versão.
**Deploy contínuo:** o workflow **Deploy** roda quando o CI termina verde em `main` e põe aquele commit no ar na
VPS. Ninguém entra na máquina para atualizar: o SSH é só o transporte do pipeline, com uma chave exclusiva dele.

## O que o workflow Deploy faz

1. **Descobre o commit da imagem.** Cada imagem leva o commit de onde saiu (rótulo gravado pelo CI). No deploy
   automático é o commit que o CI aprovou; no rollback, o commit da tag pedida. Tag que não existe no GHCR para
   aqui, antes de tocar na VPS.
2. **Não volta no tempo sozinho.** Se o commit a subir já foi superado pelo que está no ar (um CI antigo
   reexecutado, dois merges cujo CI termina fora de ordem), o deploy automático não faz nada.
3. **Copia a configuração daquele commit** (`docker-compose.prod.yml` e a pasta `deploy/`: Caddyfile e
   monitoramento) para uma pasta de espera na VPS. O `.env` com os segredos fica só na VPS e nunca passa pelo
   GitHub.
4. **Puxa as imagens novas** e só então troca a configuração e grava `IMAGE_TAG=<sha curto>` no `.env`; a
   configuração anterior fica guardada.
5. **Sobe** com `up -d` (o job `migrate` roda antes da API, como sempre), **recarrega o Caddy** (o reload valida
   o Caddyfile e não derruba conexões) e reinicia o monitoramento se a configuração dele mudou.
6. **Confere** que o `GET /api/health` mostra **o commit esperado**, por até 5 minutos.
7. **Se a subida, o Caddyfile ou a conferência falham, volta sozinho** para a tag e a configuração anteriores, e
   o deploy fica vermelho no Actions com o log da API.
8. Apaga as imagens antigas do Escambo, guardando a atual e a anterior.

Um deploy por vez (`concurrency`): o segundo espera o primeiro terminar. Com três merges seguidos, o do meio é
substituído pelo mais novo.

## Rollback

**Actions → Deploy → Run workflow** (na `main`), com a tag anterior: o sha curto ou a versão, por exemplo
`1.38.0`. É o mesmo caminho do deploy, com a configuração do commit daquela imagem, sem mexer na VPS à mão. Só
existe imagem de commit que passou pelo CI (commits com `[skip ci]` não têm). As migrations são só aditivas,
então a imagem anterior funciona sobre o schema mais novo.

## Ligar o deploy (uma vez)

Com a [primeira subida](Guia-de-Deploy) já feita. Na **sua máquina**, crie uma chave só para o deploy (sem
senha, usada só pelo GitHub Actions) e autorize-a no usuário da VPS que roda o Docker:

```bash
ssh-keygen -t ed25519 -N '' -C 'deploy-escambo' -f deploy_escambo
ssh-copy-id -i deploy_escambo.pub usuario@SEU_HOST
```

Ainda na sua máquina, pegue a identidade da VPS e confira a impressão digital com a que a própria VPS mostra em
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`:

```bash
ssh-keyscan -H SEU_HOST > known_hosts_escambo        # com outra porta: ssh-keyscan -p PORTA -H SEU_HOST
ssh-keygen -lf known_hosts_escambo                   # as impressões digitais, para conferir
```

Depois de cadastrar os segredos abaixo, apague `deploy_escambo` da sua máquina: a chave privada só precisa
existir no GitHub.

No GitHub, **Settings → Environments → New environment → `production`**:

| Tipo     | Nome                 | Valor                                              |
| -------- | -------------------- | -------------------------------------------------- |
| Segredo  | `DEPLOY_HOST`        | IP ou nome da VPS                                  |
| Segredo  | `DEPLOY_USER`        | usuário SSH, no grupo `docker`                     |
| Segredo  | `DEPLOY_SSH_KEY`     | conteúdo de `deploy_escambo` (a chave **privada**) |
| Segredo  | `DEPLOY_KNOWN_HOSTS` | conteúdo de `known_hosts_escambo`, já conferido    |
| Variável | `DEPLOY_URL`         | `https://seu-dominio`                              |
| Variável | `DEPLOY_PATH`        | pasta na VPS, se não for `/opt/escambo`            |
| Variável | `DEPLOY_PORT`        | porta SSH, se não for 22                           |

Sem esses valores o workflow termina verde com o aviso "Deploy desligado" (ou vermelho, depois de criada a
variável de repositório `DELIVERY_ENFORCED=true`). Para conferir que ligou: **Actions → Deploy → Run workflow**
e, no resumo, "No ar: versão (commit)". Em **Environments → production** dá para exigir aprovação manual antes
de cada deploy (_Required reviewers_), se quiser.

As imagens do GHCR precisam estar públicas, ou a VPS logada no GHCR com um token `read:packages` (ver
[Guia de Deploy](Guia-de-Deploy)).

## Ambientes

| Ambiente        | Onde                                            | Para quê                                                  |
| --------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Desenvolvimento | `npm run dev` ou `docker compose up` na máquina | trabalho do dia a dia, com o gateway e o e-mail simulados |
| Demonstração    | `docker compose up` + `demo-seed`               | apresentar com dados prontos                              |
| Produção        | VPS, `docker-compose.prod.yml`                  | o sistema no ar, atualizado pelo workflow Deploy          |

O passo a passo completo da VPS (DNS, primeira subida, backup, restauração, operação e checklist de
segurança) está no [Guia de Deploy](Guia-de-Deploy).
