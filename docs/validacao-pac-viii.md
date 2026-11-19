# Validação com a Comunidade (PAC VIII) — Escambo

> **Versão:** 1.57.0\
> **Disciplina:** PAC Extensionista VIII — Católica SC\
> **Autor:** Guilherme Renzo\
> **Data:** 19/11/2026\
> **Modalidade:** Comunidade (PAC Extensionista VIII, seção 3.1)

O Escambo não tem parceiro corporativo. A validação extensionista segue a modalidade Comunidade e é comprovada pelo conjunto de evidências da seção 3.1 do PAC VIII:

- o relatório das sessões com usuários reais;
- o feedback documentado;
- a declaração da comunidade atendida;
- as correções rastreáveis em issues e PRs.

Os participantes aparecem só por código (P1, P2 e P3), pelo mesmo cuidado de LGPD do sistema. Os nomes, os prints das respostas e a declaração assinada ficam com o autor e vão ao professor junto com a entrega. Nada disso entra no repositório.

A validação feita antes do código, no PAC VII (entrevistas e teste dos wireframes), está em [Evidências de Validação](./evidencias-validacao.md).

## Comunidade atendida

São pessoas que contratam ou prestam serviços no dia a dia, da rede de contato do autor. O participante P3 representa o grupo e assinou a declaração.

## Sessões com usuários reais

As três sessões foram remotas:

- O autor mandou o link da produção (https://escambo.68-183-49-126.sslip.io).
- Cada participante usou o sistema no próprio aparelho, com conta própria.
- Os pagamentos dessa versão eram simulados, sem dinheiro de verdade.

| Sessão | Data | Participante | Versão | O que foi testado | O que foi apontado |
|---|---|---|---|---|---|
| 1 | 03/11/2026 | P1 | 1.54.2 (`2a385da`) | Cadastro, acesso e navegação pelas telas | Gostou do projeto. Pediu um design novo para a interface. |
| 2 | 06/11/2026 | P2 | 1.54.2 (`2a385da`) | Cadastro, acesso e, principalmente, a página inicial | Pediu que a página inicial tivesse uma parte sobre segurança. |
| 3 | 11/11/2026 | P3 | 1.54.2 (`2a385da`) | Cadastro, acesso e navegação pelas telas | Gostou bastante e achou o projeto muito legal. Não pediu mudança. |

A 1.54.2 estava no ar nessas datas. O deploy dela foi em 30/10/2026, e o da 1.55.0 só em 13/11/2026.

Os três criaram a conta e entraram sem ajuda relatada. Ninguém apontou dificuldade.

## Do feedback à correção

| Pedido | Issue e PR | Versão | Reteste | Resultado |
|---|---|---|---|---|
| P1: design novo | PR #61 (identidade "Álbum de troca") | 1.55.0, 13/11/2026 | Mensagem com o link da versão nova | Aprovou: "Ficou muito bom, deu uma identidade" |
| P2: segurança na página inicial | Issue #78, PR #79 | No ar em 18/11/2026; lançado na 1.57.0 | Ligação com P2, 19/11/2026 | Aprovou a seção |
| Versão nova para todos | — | 1.55.0 em diante | Mensagem com o link, respondida por P2 e por P3 (P3 em 16/11/2026) | P2: "Sim"; P3: "Tudo certo!" |

As duas mudanças pedidas foram entregues e aprovadas por quem pediu. Nenhum pedido ficou aberto.

## Devolutiva à comunidade

- **Entrega:** link da produção com a versão nova, enviado por mensagem entre 16 e 18/11/2026. Cada participante entra com a conta criada nas sessões.
- **Orientação:** curta, por mensagem, junto com o link: como criar a conta, entrar e navegar. Não houve treinamento formal.
- **Dúvidas:** nenhuma; ninguém mandou pergunta.
- **Material de uso:** a [Wiki do projeto](https://github.com/Guirenzo/Escambo/wiki).
- **Suporte:** o Suporte dentro do app e o contato direto com o autor.
- **Limitações desta versão:** o pagamento é de teste (Mercado Pago em sandbox), e o endereço não é um domínio próprio.

## Declaração da comunidade

O representante (P3) mandou a declaração em 19/11/2026. Ela confirma:

- a participação nas três sessões;
- o que o grupo usou;
- as duas sugestões, ambas atendidas;
- o recebimento da versão nova.

A avaliação dele, nas palavras dele:

> Considerei o Escambo uma ferramenta útil para aproximar quem precisa contratar um serviço de quem oferece seu trabalho. A organização das telas facilita o entendimento da proposta e o uso do sistema. O novo design deixou a apresentação mais clara, e a inclusão das informações sobre segurança ajuda a orientar os usuários e transmitir confiança. Avalio que o sistema pode facilitar a busca por serviços e dar mais visibilidade aos prestadores.

## Limitações

- As sessões foram remotas, e o registro é o relato do autor, sem gravação.
- As sessões cobriram cadastro, acesso e navegação. Não cobriram uma contratação nem uma troca de ponta a ponta.
- O grupo é pequeno: três pessoas da rede de contato do autor.

## Onde estão as evidências

| Evidência | Onde |
|---|---|
| Relatório das sessões e do reteste | Esta página |
| Pedidos e correções | Issue #78, PRs #61 e #79 e [CHANGELOG](../CHANGELOG.md) (1.55.0 e 1.57.0) |
| Respostas dos participantes (prints) e declaração assinada | Com o autor, entregues ao professor (têm nomes) |

---

<div align="center">

*validacao-pac-viii.md — Escambo v1.57.0 — Católica SC — 2026*

</div>
