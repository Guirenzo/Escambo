# Revisão por Pares — Escambo

> **Versão:** 1.57.0\
> **Disciplina:** PAC Extensionista VIII — Católica SC (Validação por Pares)\
> **Autor:** Guilherme Renzo\
> **Atualizado em:** 23/11/2026

O PAC VIII pede duas coisas dos pares:
- revisão de código por Pull Request no GitHub;
- testes cruzados, com issue reproduzível onde houver defeito e a conferência de que o defeito foi corrigido.

Esta página reúne as evidências nos dois sentidos: o Escambo revisado por um colega e o autor revisando o projeto do colega. Tudo está público no GitHub, com data e autor.

## O Escambo revisado por um colega

O colega `gustavovieiira` (projeto `TCC-USAI2.0`) revisou o Escambo em dois momentos.

| Data | O quê | Evidência | Resultado |
|---|---|---|---|
| 21/09/2026 | Revisão comentada da ordenação do portfólio por arrastar (ADR 49), entregue em três PRs | [PR #2](https://github.com/Guirenzo/Escambo/pull/2), [PR #3](https://github.com/Guirenzo/Escambo/pull/3) e [PR #4](https://github.com/Guirenzo/Escambo/pull/4) | Comentários sobre o desempenho do arrastar sem re-renderizar a lista, a estabilidade do teste E2E e a versão da release (1.31.0) |
| 11/11/2026 | Teste cruzado da N2: três defeitos abertos como issues | [#57](https://github.com/Guirenzo/Escambo/issues/57), [#58](https://github.com/Guirenzo/Escambo/issues/58) e [#59](https://github.com/Guirenzo/Escambo/issues/59) | Os três corrigidos no [PR #60](https://github.com/Guirenzo/Escambo/pull/60), publicados na 1.55.0 (13/11/2026) |

### O que os defeitos da N2 mudaram no código

| Issue | Defeito | Correção |
|---|---|---|
| #57 | A decisão do admin numa disputa não atualizava a troca vinculada ao contrato | A decisão resolve o escrow e a troca na mesma transação (`disputes.repository.ts` e `barter.repository.ts`), com teste de integração novo em `barter-flow.int.test.ts` |
| #58 | O link de redefinição de senha ficava gravado na caixa de saída e aparecia na listagem do admin | A caixa de saída guarda só os dados da entrega, e o link vai só ao provedor de e-mail (`mail.service.ts`). A migration 0054 limpa os registros antigos |
| #59 | A exclusão de conta (LGPD) não apagava o portfólio, e a exportação não o incluía | A exclusão apaga e a exportação inclui o portfólio (`lgpd.repository.ts` e `lgpd.export.ts`). A migration 0055 remove o que ficou de contas já excluídas |

## O autor revisando o projeto do colega

| Data | O quê | Evidência | Resultado |
|---|---|---|---|
| 21/09/2026 | Revisão comentada de um PR de testes do controller de conversas (caso do usuário sem condomínio, 403) | [TCC-USAI2.0 PR #3](https://github.com/gustavovieiira/TCC-USAI2.0/pull/3) | Comentário sobre a asserção de que o banco nem é consultado antes da recusa |
| 11/11/2026 | Teste cruzado da N2: dois defeitos abertos como issues | [TCC-USAI2.0 #25](https://github.com/gustavovieiira/TCC-USAI2.0/issues/25) (o simulador mantinha o preço mensal cheio no período anual) e [TCC-USAI2.0 #26](https://github.com/gustavovieiira/TCC-USAI2.0/issues/26) (o cadastro de morador usava o link completo como código do condomínio) | As duas fechadas pelo colega em 11/11/2026 |

## Revisão automática em todo PR

Além da revisão humana, todo PR do Escambo passa pelos 6 checks obrigatórios do CI antes do merge, e a `main` é protegida:

- lint, tipos, testes de unidade e build;
- integração com MySQL;
- E2E;
- cobertura com meta;
- varredura de segredos;
- backup com restauração testada.

O SonarCloud comenta o quality gate no PR. Detalhes em [Qualidade](./wiki/Qualidade.md).

## Limitações

- As revisões registradas são com um colega só. O PAC VIII prevê squads de 3 a 5 alunos.
- As revisões nos PRs são comentários, sem aprovação formal: a `main` não exige aprovação de outra pessoa, porque isso só faz sentido com um segundo revisor fixo (ADR 59).

---

<div align="center">

*revisao-por-pares.md — Escambo v1.57.0 — Católica SC — 2026*

</div>
