# Guia de Contribuição — Escambo

Obrigado por fazer parte do squad! Este documento define os padrões de colaboração para garantir qualidade, rastreabilidade e um histórico de commits profissional.

---

## 📋 Índice

- [Fluxo de Trabalho](#fluxo-de-trabalho)
- [Padrão de Branches](#padrão-de-branches)
- [Conventional Commits](#conventional-commits)
- [Pull Requests](#pull-requests)
- [Code Review (QA Cruzado)](#code-review-qa-cruzado)
- [Padrões de Código](#padrões-de-código)

---

## Fluxo de Trabalho

Este projeto adota o **GitHub Flow** — simples, linear e adequado para squads ágeis:

```
main  ←── pull request aprovado
  │
  └── feat/nome-da-feature   (sua branch de trabalho)
```

**Regras:**
- `main` é sempre estável. Nunca commitar diretamente.
- Todo trabalho acontece em branches.
- Todo merge passa por Pull Request com ao menos **1 aprovação** do squad.

---

## Padrão de Branches

```
feat/nome-curto-da-feature     # nova funcionalidade
fix/descricao-do-bug           # correção de bug
docs/secao-atualizada          # apenas documentação
refactor/nome-do-modulo        # refatoração sem nova feature
test/cobertura-do-modulo       # adição ou correção de testes
chore/nome-da-tarefa           # configs, dependências, CI
```

**Exemplos:**
```bash
git checkout -b feat/modulo-chat
git checkout -b fix/autenticacao-jwt-expirado
git checkout -b docs/atualiza-modelagem-banco
```

---

## Conventional Commits

Todo commit deve seguir o padrão [Conventional Commits](https://www.conventionalcommits.org/):

```
<tipo>(escopo opcional): descrição curta em minúsculas
```

| Tipo | Quando usar |
|---|---|
| `feat` | Nova funcionalidade |
| `fix` | Correção de bug |
| `docs` | Alterações na documentação |
| `style` | Formatação (sem mudança de lógica) |
| `refactor` | Refatoração de código |
| `test` | Adição ou correção de testes |
| `chore` | Tarefas de manutenção (deps, configs) |
| `perf` | Melhoria de performance |

**Exemplos:**
```bash
git commit -m "feat(chat): implementa envio de mensagens em tempo real"
git commit -m "fix(auth): corrige expiração incorreta do token JWT"
git commit -m "docs(rfc): atualiza seção de requisitos não funcionais"
git commit -m "chore: adiciona eslint e prettier ao projeto"
```

---

## Pull Requests

Ao abrir um PR, use o template abaixo:

```markdown
## O que este PR faz?
Descrição clara e objetiva da mudança.

## Módulo relacionado
[ ] Autenticação  [ ] Perfis  [ ] Chat  [ ] Pagamentos  [ ] Gamificação  [ ] Outro: ___

## Tipo de mudança
[ ] feat — nova funcionalidade
[ ] fix — correção de bug
[ ] docs — documentação
[ ] refactor — refatoração

## Como testar?
1. Passo 1
2. Passo 2
3. Resultado esperado: ...

## Checklist
- [ ] Código segue os padrões do projeto (ESLint/Prettier)
- [ ] Nenhum `console.log` esquecido
- [ ] Variáveis de ambiente sensíveis não foram commitadas
- [ ] Documentação atualizada se necessário
```

---

## Code Review (QA Cruzado)

O squad atua como equipe de **Quality Assurance**. Ao revisar um PR:

**O que verificar:**
- ✅ O código faz o que o PR descreve?
- ✅ Existe algum edge case não tratado?
- ✅ A lógica está clara e legível?
- ✅ Há algum risco de segurança (ex.: SQL injection, dados expostos)?
- ✅ O código segue os padrões do projeto?

**Como comentar:**
- Use prefixos para deixar claro o tipo de feedback:
  - `[blocker]` — deve ser resolvido antes do merge
  - `[suggestion]` — melhoria opcional
  - `[question]` — dúvida, não necessariamente um problema
  - `[nitpick]` — detalhe estético, sem impacto funcional

---

## Padrões de Código

### TypeScript
- Tipagem explícita sempre que possível — evite `any`
- Prefira `interface` a `type` para objetos
- Use `async/await` em vez de `.then().catch()`

### Nomenclatura
- **Variáveis e funções:** `camelCase`
- **Classes e interfaces:** `PascalCase`
- **Constantes globais:** `UPPER_SNAKE_CASE`
- **Arquivos:** `kebab-case.ts`

### Estrutura de pastas (API)
```
src/
├── modules/
│   └── nome-do-modulo/
│       ├── nome-do-modulo.controller.ts
│       ├── nome-do-modulo.service.ts
│       ├── nome-do-modulo.repository.ts
│       └── nome-do-modulo.routes.ts
├── shared/
│   ├── middlewares/
│   └── utils/
└── app.ts
```

---

*Dúvidas? Abra uma [Discussion](../../discussions) no repositório.*
