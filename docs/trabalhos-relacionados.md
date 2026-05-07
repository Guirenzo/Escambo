# NP2 — Trabalhos Relacionados e Fundamentação Teórica

> **Versão:** 1.0.0  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Autor:** [Seu Nome]  
> **Data:** 2026

---

## Índice

1. [Introdução](#1-introdução)
2. [Tema 1 — Marketplaces Two-Sided](#2-tema-1--marketplaces-two-sided)
3. [Tema 2 — Gamificação em Plataformas Digitais](#3-tema-2--gamificação-em-plataformas-digitais)
4. [Tema 3 — Confiança e Reputação em Mercados Digitais](#4-tema-3--confiança-e-reputação-em-mercados-digitais)
5. [Tema 4 — Economia Gig e Uberização do Trabalho](#5-tema-4--economia-gig-e-uberização-do-trabalho)
6. [Tema 5 — Pagamentos Digitais e PIX no Brasil](#6-tema-5--pagamentos-digitais-e-pix-no-brasil)
7. [Mapa de Relação com o Escambo](#7-mapa-de-relação-com-o-escambo)
8. [Referências Completas](#8-referências-completas)

---

## 1. Introdução

Esta seção apresenta a fundamentação teórica do Escambo a partir de cinco eixos temáticos que embasam as decisões de design, arquitetura e modelo de negócio da plataforma. Para cada tema são apresentados trabalhos acadêmicos relevantes, dados de mercado e a relação direta com as escolhas do projeto.

A revisão cobre literatura acadêmica (IEEE, ACM, Springer) e fontes de mercado consolidadas (IBGE, Banco Central, relatórios setoriais), refletindo a natureza aplicada do projeto.

---

## 2. Tema 1 — Marketplaces Two-Sided

### 2.1 Conceito

Plataformas **two-sided** (de dois lados) são mercados digitais que conectam dois grupos distintos de usuários que se beneficiam mutuamente da interação — no caso do Escambo, **clientes** e **freelancers**. O valor da plataforma cresce à medida que cada lado atrai mais participantes do outro lado, fenômeno conhecido como **efeito de rede** (ROCHET; TIROLE, 2003).

### 2.2 O Problema do Ovo e da Galinha

O principal desafio estrutural de qualquer marketplace two-sided é o chamado **"problema do ovo ou da galinha"**: sem freelancers cadastrados, clientes não têm motivo para entrar; sem clientes ativos, freelancers não têm motivo para se cadastrar (PARKER; VAN ALSTYNE, 2005).

Estratégias documentadas na literatura para superar esse problema incluem:

- **Subsidiar um dos lados** — oferecer benefícios extras para o lado mais difícil de atrair inicialmente (ROCHET; TIROLE, 2003)
- **Seeding manual** — recrutar ativamente os primeiros participantes de um lado antes do lançamento público
- **Foco em nicho geográfico** — crescer primeiro em uma cidade ou região antes de expandir (EISENMANN; PARKER; VAN ALSTYNE, 2006)

**Relação com o Escambo:** o projeto prevê estratégia de seed manual de freelancers antes do lançamento, além de gamificação para aumentar a retenção dos primeiros usuários — estratégias diretamente embasadas nessa literatura.

### 2.3 Trabalhos Relacionados

**ROCHET, J. C.; TIROLE, J. (2003).** *Platform Competition in Two-Sided Markets.* Journal of the European Economic Association, v. 1, n. 4, p. 990–1029.

> Artigo fundacional sobre competição em mercados de dois lados. Define formalmente o conceito, modela o comportamento de precificação ótima e demonstra como a estrutura de taxas afeta o equilíbrio entre os dois grupos. Base teórica para a definição do modelo de comissionamento do Escambo.

**PARKER, G. G.; VAN ALSTYNE, M. W. (2005).** *Two-Sided Network Effects: A Theory of Information Product Design.* Management Science, v. 51, n. 10, p. 1494–1504.

> Formaliza o conceito de efeitos de rede em mercados digitais. Demonstra matematicamente por que o crescimento de um lado gera valor exponencial no outro — fundamentando a decisão de priorizar onboarding de freelancers antes de clientes no MVP.

**EISENMANN, T.; PARKER, G.; VAN ALSTYNE, M. (2006).** *Strategies for Two-Sided Markets.* Harvard Business Review, v. 84, n. 10, p. 92–101.

> Artigo prático derivado da pesquisa acadêmica. Apresenta seis estratégias para superar o dilema do ovo ou da galinha — incluindo subsidiar um lado, criar demanda artificial e crescer por nicho. Diretamente aplicável ao plano de lançamento do Escambo.

---

## 3. Tema 2 — Gamificação em Plataformas Digitais

### 3.1 Conceito

**Gamificação** é definida como o uso de elementos de design de jogos em contextos que não são jogos, com o objetivo de aumentar o engajamento, a motivação e o comportamento desejado dos usuários (DETERDING et al., 2011). Os elementos mais utilizados incluem: pontos, níveis, badges (medalhas), rankings, missões e recompensas.

### 3.2 Evidências de Eficácia

Pesquisas demonstram que a gamificação aumenta significativamente métricas de engajamento em plataformas digitais. Um estudo conduzido em plataforma de marketplace de dois lados demonstrou que tornar a conquista de badges mais difícil (aumentando o desafio percebido) **aumenta o número de contribuições dos usuários** — reforçando a importância de calibrar o sistema de recompensas (PAVLOV et al., 2017).

Segundo Hamari, Koivisto e Sarsa (2014), em revisão sistemática de 24 estudos sobre gamificação, **a grande maioria reportou efeitos positivos** sobre engajamento, satisfação e desempenho — especialmente quando os elementos gamificados são contextualizados ao comportamento desejado.

### 3.3 Gamificação e Retenção de Freelancers

O problema de retenção em plataformas de serviços é crítico: usuários tendem a usar a plataforma uma única vez e migrar para fora dela após o primeiro contato. A gamificação endereça esse problema ao criar um **sistema de progressão** que gera valor incremental com o tempo — tornando a saída da plataforma mais custosa do ponto de vista do freelancer (perda de XP, nível e badges acumulados).

**Relação com o Escambo:** o módulo de gamificação (XP, níveis, badges, missões, ranking local) foi concebido diretamente a partir dessa literatura, com o objetivo de aumentar a retenção de freelancers e estimular comportamentos desejados (resposta rápida, conclusão de contratos, alta avaliação).

### 3.4 Trabalhos Relacionados

**DETERDING, S. et al. (2011).** *From game design elements to gamefulness: Defining gamification.* In: Proceedings of the 15th International Academic MindTrek Conference. ACM, p. 9–15.

> Artigo seminal que define formalmente o conceito de gamificação. Distingue elementos de jogos completos de elementos isolados e propõe um framework de análise. É a referência mais citada na área — fundamental para embasar o design do módulo de gamificação do Escambo.

**HAMARI, J.; KOIVISTO, J.; SARSA, H. (2014).** *Does Gamification Work? — A Literature Review of Empirical Studies on Gamification.* In: Proceedings of the 47th Hawaii International Conference on System Sciences. IEEE, p. 3025–3034.

> Revisão sistemática de 24 estudos empíricos sobre gamificação. Conclui que a gamificação funciona — mas sua eficácia depende do contexto, do perfil dos usuários e da qualidade do design dos elementos. Orientou a decisão de contextualizar cada elemento do sistema de XP ao comportamento esperado do freelancer.

**PAVLOV, O. V. et al. (2017).** *Social Big Data Analytics of Consumer Choices: A Two Sided Online Platform Perspective.* arXiv, 2017. Disponível em: https://arxiv.org/abs/1702.07074.

> Estudo empírico sobre gamificação em plataforma de dois lados. Demonstra que o efeito dos elementos gamificados é heterogêneo entre perfis de usuários — e que tornar badges mais difíceis de conquistar aumenta contribuições. Embasou a decisão de design das missões semanais e mensais do Escambo.

---

## 4. Tema 3 — Confiança e Reputação em Mercados Digitais

### 4.1 Conceito

Em mercados digitais, a **assimetria de informação** — situação em que uma parte tem mais informações que a outra — é o principal obstáculo à troca. Um cliente não consegue verificar a qualidade de um serviço antes de contratá-lo, e um freelancer não consegue verificar a seriedade de um cliente antes de aceitar um projeto (AKERLOF, 1970).

Sistemas de **reputação e avaliação** surgem como mecanismo de redução dessa assimetria: ao tornar o histórico de comportamento passado visível, permitem que as partes tomem decisões mais informadas (RESNICK et al., 2000).

### 4.2 Avaliações e Qualidade do Serviço

Estudos empíricos demonstram que avaliações positivas aumentam significativamente a probabilidade de contratação em plataformas de serviços. Mais importante: a **verificação das avaliações** — garantindo que são reais e ligadas a transações concluídas — é determinante para a credibilidade do sistema (DELLAROCAS, 2003).

**Relação com o Escambo:** o módulo de avaliações foi projetado para vincular obrigatoriamente cada avaliação a uma contratação concluída e paga — eliminando avaliações falsas e garantindo a credibilidade do sistema de reputação.

### 4.3 Trabalhos Relacionados

**RESNICK, P. et al. (2000).** *Reputation systems.* Communications of the ACM, v. 43, n. 12, p. 45–48.

> Artigo pioneiro sobre sistemas de reputação em mercados eletrônicos. Define os requisitos fundamentais de um sistema de reputação eficaz: visibilidade do histórico, longo prazo e captação de feedback. Base para o design do sistema de avaliações do Escambo.

**DELLAROCAS, C. (2003).** *The digitization of word of mouth: Promise and challenges of online feedback mechanisms.* Management Science, v. 49, n. 10, p. 1407–1424.

> Analisa os desafios dos sistemas de feedback online, incluindo manipulação de avaliações e comportamento estratégico. Motivou a decisão de vincular avaliações a contratos concluídos e de não permitir avaliação antes da entrega confirmada.

**AKERLOF, G. A. (1970).** *The Market for "Lemons": Quality Uncertainty and the Market Mechanism.* The Quarterly Journal of Economics, v. 84, n. 3, p. 488–500.

> Artigo clássico de economia que descreve o problema da assimetria de informação. Embasa a necessidade de mecanismos de sinalização de qualidade (como avaliações e badges) em mercados onde compradores não podem verificar a qualidade antes da compra — exatamente o caso de serviços freelance.

---

## 5. Tema 4 — Economia Gig e Uberização do Trabalho

### 5.1 Conceito

A **economia gig** (ou economia de bicos) refere-se a um modelo de trabalho baseado em contratos de curto prazo e tarefas específicas, mediados por plataformas digitais. O termo **uberização** — derivado do modelo do Uber — descreve a tendência de transformar trabalho tradicional em serviço sob demanda via aplicativo (SCHOLZ, 2017).

### 5.2 O Cenário Brasileiro

O Brasil apresenta características únicas que tornam o mercado de serviços via plataforma especialmente relevante:

- **25,5 milhões de trabalhadores por conta própria** (IBGE, PNAD Contínua 2024)
- **74,3% sem CNPJ** — a maioria dos autônomos opera sem qualquer formalização digital
- Rendimento médio do conta própria sem CNPJ: **R$ 2.084/mês** — 51% inferior ao empregado CLT (IBGE, 2025)
- Crescimento do contingente em 10% nos últimos cinco anos

Esses dados evidenciam um mercado com enorme potencial represado: milhões de trabalhadores qualificados sem ferramentas digitais adequadas para competir, se apresentar e ser remunerado de forma segura.

### 5.3 Trabalhos Relacionados

**SCHOLZ, T. (2017).** *Uberworked and Underpaid: How Workers Are Disrupting the Digital Economy.* Cambridge: Polity Press.

> Obra de referência sobre o impacto social da uberização. Analisa como plataformas digitais redistribuem riscos e custos para trabalhadores, argumentando pela necessidade de plataformas mais equitativas. Fundamenta a missão social do Escambo: empoderar freelancers com ferramentas de gestão, e não apenas conectá-los a clientes.

**IBGE. PNAD Contínua — Características adicionais do mercado de trabalho 2024.** Rio de Janeiro: IBGE, 2025.

> Fonte primária de dados sobre o mercado de trabalho autônomo no Brasil. Fornece a base quantitativa para o dimensionamento do problema (25,5 milhões de conta própria, 74,3% sem CNPJ) e a oportunidade de mercado do Escambo.

**SUNDARARAJAN, A. (2016).** *The Sharing Economy: The End of Employment and the Rise of Crowd-Based Capitalism.* Cambridge: MIT Press.

> Analisa o surgimento das plataformas de economia compartilhada e seu impacto no emprego e na regulação. Apresenta evidências de que plataformas bem desenhadas aumentam renda e autonomia dos prestadores de serviço — embasando a proposta de valor do Escambo para freelancers.

---

## 6. Tema 5 — Pagamentos Digitais e PIX no Brasil

### 6.1 Contexto

O lançamento do **PIX em novembro de 2020** pelo Banco Central do Brasil transformou o ecossistema de pagamentos do país. Em 2023, o sistema processou **42 bilhões de transações totalizando R$ 17,2 trilhões** — tornando-se a infraestrutura de pagamento mais utilizada no Brasil (BCB, 2024).

Para plataformas de serviços, o PIX resolve dois problemas históricos: a **lentidão** das transferências bancárias tradicionais e o **custo** das taxas de cartão. Isso permite que pagamentos entre clientes e freelancers sejam instantâneos, gratuitos e verificáveis.

### 6.2 Pagamentos em Escrow

O modelo de **escrow digital** — onde o pagamento fica retido por uma terceira parte até o cumprimento das condições acordadas — é amplamente utilizado em plataformas internacionais (Upwork, Fiverr) e é considerado um fator crítico para a construção de confiança (PAVLOU; FYGENSON, 2006).

**Relação com o Escambo:** o módulo de pagamentos foi projetado com suporte a PIX via MercadoPago e modelo de escrow — liberando o pagamento ao freelancer somente após a confirmação de conclusão pelo cliente. Isso endereça diretamente o risco de não pagamento identificado no benchmarking.

### 6.3 Trabalhos Relacionados

**BANCO CENTRAL DO BRASIL. (2024).** *Estatísticas do PIX 2023.* Brasília: BCB. Disponível em: https://www.bcb.gov.br.

> Fonte oficial com dados de volume e transações do PIX. Embasou a decisão de priorizar PIX como método principal de pagamento no Escambo — dado que apenas 8% dos pagamentos freelance ainda usam boleto, contra crescimento exponencial do PIX (BCB, 2024).

**PAVLOU, P. A.; FYGENSON, M. (2006).** *Understanding and Predicting Electronic Commerce Adoption: An Extension of the Theory of Planned Behavior.* MIS Quarterly, v. 30, n. 1, p. 115–143.

> Analisa os fatores que determinam a adoção de e-commerce, identificando confiança e percepção de controle como determinantes principais. Embasou a decisão de implementar escrow (aumenta controle percebido do cliente) e avaliações verificadas (aumenta confiança).

**MERCADOPAGO. (2024).** *Documentação da API MercadoPago v2.* Buenos Aires: MercadoPago. Disponível em: https://www.mercadopago.com.br/developers.

> Documentação técnica do gateway de pagamentos adotado. A escolha do MercadoPago foi baseada em sua cobertura no Brasil, suporte nativo a PIX, cartão de crédito e boleto, além de SDK bem documentado para Node.js.

---

## 7. Mapa de Relação com o Escambo

| Tema | Decisão de Projeto Embasada |
|---|---|
| Marketplaces Two-Sided | Estratégia de seed de freelancers; modelo de comissionamento; prioridade de onboarding |
| Gamificação | Módulo de XP, níveis, badges e missões; design de retenção de freelancers |
| Confiança e Reputação | Avaliações vinculadas a contratos; badges de verificação; histórico público |
| Economia Gig | Missão social do produto; foco em autônomos sem CNPJ; dashboard de gestão financeira |
| Pagamentos Digitais | PIX como método principal; escrow; carteira digital; saques programados |

---

## 8. Referências Completas

- AKERLOF, G. A. The Market for "Lemons": Quality Uncertainty and the Market Mechanism. **The Quarterly Journal of Economics**, v. 84, n. 3, p. 488–500, 1970.

- BANCO CENTRAL DO BRASIL. **Estatísticas do PIX 2023–2024**. Brasília: BCB, 2024. Disponível em: https://www.bcb.gov.br/estabilidadefinanceira/pix. Acesso em: abr. 2026.

- DELLAROCAS, C. The digitization of word of mouth: Promise and challenges of online feedback mechanisms. **Management Science**, v. 49, n. 10, p. 1407–1424, 2003.

- DETERDING, S. et al. From game design elements to gamefulness: Defining gamification. In: **Proceedings of the 15th International Academic MindTrek Conference**. ACM, 2011. p. 9–15.

- EISENMANN, T.; PARKER, G.; VAN ALSTYNE, M. Strategies for Two-Sided Markets. **Harvard Business Review**, v. 84, n. 10, p. 92–101, 2006.

- HAMARI, J.; KOIVISTO, J.; SARSA, H. Does Gamification Work? A Literature Review of Empirical Studies on Gamification. In: **Proceedings of the 47th Hawaii International Conference on System Sciences**. IEEE, 2014. p. 3025–3034.

- IBGE. **PNAD Contínua — Características adicionais do mercado de trabalho 2024**. Rio de Janeiro: IBGE, 2025. Disponível em: https://www.ibge.gov.br. Acesso em: abr. 2026.

- MERCADOPAGO. **Documentação da API MercadoPago**. Buenos Aires: MercadoPago, 2024. Disponível em: https://www.mercadopago.com.br/developers. Acesso em: abr. 2026.

- PARKER, G. G.; VAN ALSTYNE, M. W. Two-Sided Network Effects: A Theory of Information Product Design. **Management Science**, v. 51, n. 10, p. 1494–1504, 2005.

- PAVLOV, O. V. et al. Social Big Data Analytics of Consumer Choices: A Two Sided Online Platform Perspective. **arXiv**, 2017. Disponível em: https://arxiv.org/abs/1702.07074. Acesso em: abr. 2026.

- PAVLOU, P. A.; FYGENSON, M. Understanding and Predicting Electronic Commerce Adoption: An Extension of the Theory of Planned Behavior. **MIS Quarterly**, v. 30, n. 1, p. 115–143, 2006.

- RESNICK, P. et al. Reputation systems. **Communications of the ACM**, v. 43, n. 12, p. 45–48, 2000.

- ROCHET, J. C.; TIROLE, J. Platform Competition in Two-Sided Markets. **Journal of the European Economic Association**, v. 1, n. 4, p. 990–1029, 2003.

- SCHOLZ, T. **Uberworked and Underpaid: How Workers Are Disrupting the Digital Economy**. Cambridge: Polity Press, 2017.

- SUNDARARAJAN, A. **The Sharing Economy: The End of Employment and the Rise of Crowd-Based Capitalism**. Cambridge: MIT Press, 2016.

---

<div align="center">

*trabalhos-relacionados.md — Escambo v1.0.0 — NP2 — PAC Extensionista VII — Católica SC — 2026*

</div>
