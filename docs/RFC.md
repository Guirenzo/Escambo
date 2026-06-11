RFC — Escambo: Plataforma Digital de Serviços Freelance

**Engenharia de Software — Católica SC**

---

## Identificação

**Título do Projeto:**
Escambo — Plataforma Digital de Serviços Freelance

**Linha de Projeto:**
Web App (avaliação principal). A evolução para Mobile está planejada como Fase 2, posterior à entrega da versão web — ver seção "Linha de Avaliação e Aderência às Directions".

**Autor:**
Guilherme Renzo

**Data da Proposta:**
Abril de 2026

**Revisão:**
Junho de 2026

**Versão:**
2.1

**Repositório:**
https://github.com/Guirenzo/Escambo

**Licença:**
MIT — Open Source

---

## Histórico de Revisões

| Versão | Data | Mudanças principais |
|---|---|---|
| 1.0 | Mar/2026 | Versão inicial da proposta |
| 2.0 | Abr/2026 | Documentação completa: requisitos, personas, casos de uso, arquitetura C4, mockups |
| 2.1 | Jun/2026 | Revisão após avaliação da banca: linha declarada como Web App (mobile movido para Fase 2); benchmark ampliado para três plataformas com fontes rastreáveis; correção da análise de mercado (Workana cobra do cliente); plano técnico de CI/CD, testes (TDD), análise estática e observabilidade detalhado; seção de instalação/deploy adicionada; padronização dos números entre RFC e README; ajuste de tom para registro acadêmico |

---

## Linha de Avaliação e Aderência às Directions

Depois de uma primeira rodada de avaliação, decidi declarar de forma explícita como este projeto deve ser lido pela banca, porque a rotulação "Web + Mobile" gerava ambiguidade sobre o que estaria pronto e quando.

**Linha principal de avaliação: Web App.** A entrega que será concluída até o fim de 2026 é a plataforma web completa (cliente e freelancer), com todos os módulos descritos neste documento. O aplicativo mobile (React Native + Expo) é uma evolução planejada para a Fase 2, em 2027, reaproveitando a mesma API e a lógica de negócio já validada. Tratei a parte mobile assim por uma razão prática: prefiro entregar uma plataforma web sólida, testada e em produção do que dois produtos pela metade. A arquitetura, no entanto, já foi pensada para suportar o mobile sem retrabalho (seção 5.6).

Uma observação importante sobre o escopo: apesar de o Escambo ter carteira digital, escrow e saques, ele não é um sistema financeiro genérico. As funcionalidades financeiras existem apenas para dar segurança às transações de serviços (reter o pagamento até a entrega e repassar ao freelancer). O foco do produto é o marketplace de serviços, não a movimentação de dinheiro como fim.

### Checklist de aderência (linha Web App)

| Requisito das Directions | Situação | Onde está tratado |
|---|---|---|
| Repositório público | Atendido | github.com/Guirenzo/Escambo |
| README, LICENSE, CONTRIBUTING, pasta `docs/` | Atendido | Raiz do repositório |
| Documentação: requisitos, casos de uso, arquitetura | Atendido | Seções 2 e 5 + apêndices |
| Instruções de deploy/instalação | Atendido | Seção 8 (nova) |
| Benchmark com 3 a 5 soluções | Atendido | Seção 1.3 (três plataformas + referência internacional) |
| CI/CD | Planejado — M2 | Seção 7.3 |
| Cobertura de testes (TDD): 75% backend / 25% frontend | Planejado — M2 a M5 | Seção 7.1 e 7.2 |
| Análise estática de código e segurança | Planejado — M2 | Seção 7.4 |
| Monitoramento / observabilidade / analytics | Planejado — M4 | Seção 7.5 |
| Wiki do repositório | Planejado — M5 | Seção 9 (planejamento) |

A linha Mobile não é avaliada nesta entrega por decisão de escopo. Seus critérios das Directions (arquitetura mobile, testes, build do app) passam a valer na Fase 2, cujo ponto de partida arquitetural está documentado na seção 5.6.

---

## 1. Visão do Produto e Impacto

### 1.1 Contexto e Problema

O nome Escambo vem de uma palavra antiga que significa troca. Escolhi esse nome porque é exatamente o que a plataforma faz: conecta quem precisa de um serviço com quem sabe executá-lo, de forma direta e sem burocracia. A ideia, porém, vai além de uma troca simples. A proposta é que os dois lados saiam ganhando de forma consistente.

A motivação nasceu de uma observação do dia a dia. Vivemos num momento em que quase tudo se resolve pelo celular em minutos, mas contratar um eletricista, um desenvolvedor freelancer ou uma diarista continua sendo um processo trabalhoso e incerto. A pessoa pede indicação num grupo de WhatsApp, recebe cinco contatos, passa dois dias tentando agendar, não sabe se o profissional é confiável, paga adiantado e fica na expectativa de que dê certo. Em 2026, esse fluxo está muito atrás do que a tecnologia já permite.

Do outro lado, há os trabalhadores autônomos. Segundo a Pesquisa Nacional por Amostra de Domicílios Contínua do IBGE, o Brasil tem mais de 25 milhões de pessoas trabalhando por conta própria. A maioria depende quase exclusivamente de indicações para conseguir clientes novos. Não tem portfólio digital, não tem histórico de avaliações verificáveis e não tem controle financeiro organizado. São profissionais que trabalham bem, mas permanecem invisíveis para quem nunca ouviu falar deles.

As plataformas que existem hoje não resolvem isso por completo, e cada uma falha em um ponto diferente. O GetNinjas cobra do profissional por cada contato de cliente, sem nenhuma garantia de que o serviço será fechado, e toda a negociação acontece fora da plataforma. A Workana e o 99Freelas oferecem pagamento intermediado, mas cobram comissões que chegam a 20% e atendem basicamente serviços digitais, ignorando o trabalho local e presencial. Nenhuma dessas plataformas combina alcance local, pagamento seguro e um sistema de progressão que faça o profissional querer voltar.

A lacuna é clara: falta uma plataforma que junte a simplicidade dos aplicativos de delivery, a segurança de pagamento dos aplicativos de mobilidade e um sistema de progressão que valorize quem trabalha bem, não só pelo dinheiro, mas pelo crescimento dentro da própria plataforma.

### 1.2 Origem da Demanda e Evidências

#### Pesquisa com usuários

Entre março e abril de 2026 conduzi entrevistas semiestruturadas com 8 pessoas (5 freelancers e 3 clientes de serviços) nas regiões de Itajaí, Joinville e Blumenau, em Santa Catarina. As entrevistas seguiram um roteiro fixo, aplicado sempre antes de eu apresentar qualquer solução, justamente para mapear as dores reais sem induzir as respostas.

**Metodologia.** O roteiro foi organizado em quatro blocos: como a pessoa contrata ou divulga serviços hoje, quais problemas já enfrentou, o que ela considera confiável e o que a faria mudar de comportamento. Cada participante autorizou verbalmente o uso anônimo das respostas, e nenhum dado pessoal identificável foi registrado. Os participantes são referenciados por código (F01 a F05 para freelancers, C01 a C03 para clientes). O roteiro completo, a síntese tabulada dos achados e os registros anonimizados estão no Apêndice H.

**Perfil dos entrevistados:**

| # | Perfil | Cidade | Usa plataforma? |
|---|---|---|---|
| F01 | Eletricista autônomo | Itajaí, SC | Não |
| F02 | Desenvolvedor front-end | Joinville, SC | Sim (Workana) |
| F03 | Diarista | Itajaí, SC | Não |
| F04 | Designer gráfico | Blumenau, SC | Sim (GetNinjas) |
| F05 | Técnico de informática | Itajaí, SC | Sim (GetNinjas) |
| C01 | Analista de RH | Blumenau, SC | Sim (GetNinjas, experiência negativa) |
| C02 | Empreendedora / MEI | Itajaí, SC | Sim (Workana) |
| C03 | Gerente de loja | Blumenau, SC | Grupos de WhatsApp |

**Principais dores dos freelancers:**

- 4 de 5 relataram depender exclusivamente de indicações para conseguir clientes novos
- Os 3 que já usaram plataformas relataram insatisfação com o modelo de monetização
- 4 de 5 não usam nenhuma ferramenta digital de controle financeiro
- 5 de 5 não têm portfólio digital organizado e verificável

> *"Meu serviço é bom, todo mundo que me chama volta. Mas como eu faço para chegar em quem nunca me chamou?"*
> — F01, eletricista, 42 anos, Itajaí

> *"Paguei R$ 60 em moedas no GetNinjas. Mandei proposta para 8 clientes. Fechei zero. Nunca mais."*
> — F05, técnico de informática, 36 anos, Itajaí

**Principais dores dos clientes:**

- 3 de 3 citaram a confiança como principal barreira para contratar um profissional desconhecido
- 2 de 3 relataram insegurança no pagamento adiantado sem qualquer garantia
- 3 de 3 descreveram o processo de contratação como lento e burocrático

> *"Paguei metade adiantado para um designer pelo GetNinjas. Ele sumiu depois de mandar uma versão ruim. Não tinha como recuperar o dinheiro."*
> — C01, analista de RH, 34 anos, Blumenau

#### Evidências de comunidade

Durante a fase de pesquisa, observei dois grupos locais de troca de serviços:

| Grupo | Plataforma | Membros | Padrão observado |
|---|---|---|---|
| Serviços Itajaí e Região | WhatsApp | ~320 | 15 a 20 pedidos por dia, sem avaliação nem preço padronizado |
| Freelancers SC | Facebook | ~1.800 | Mistura de portfólio e pedidos, sem intermediação de pagamento |

Nos dois grupos, os clientes pedem recomendações antes de contratar qualquer desconhecido, e há relatos frequentes de calote, não comparecimento e qualidade abaixo do esperado.

### 1.3 Análise de Soluções Existentes (Benchmark)

Analisei três plataformas com operação consolidada no Brasil, cobrindo tanto o segmento de serviços locais quanto o de serviços digitais. As informações sobre modelo de cobrança foram conferidas nas centrais de ajuda e nos materiais oficiais de cada plataforma (referências na seção 10).

**GetNinjas** — https://www.getninjas.com.br
Atende principalmente serviços locais e presenciais. Seus pontos fortes são a base ampla de usuários, a cobertura geográfica nacional e o aplicativo mobile. O modelo de receita é a venda de "moedas": o profissional compra créditos para liberar o contato dos clientes e enviar orçamentos, sem nenhuma garantia de que vai fechar o serviço. A plataforma não cobra comissão sobre o trabalho (o profissional fica com 100% do valor), mas, em compensação, toda a negociação e o pagamento acontecem fora da plataforma. Não há pagamento intermediado, dashboard financeiro nem gamificação. Na prática, o profissional assume o risco financeiro antes mesmo de saber se haverá serviço.

**Workana** — https://www.workana.com
Atende serviços digitais (tecnologia, design, marketing). Oferece pagamento intermediado por depósito de garantia, o que dá segurança às duas partes. A comissão cobrada do freelancer é escalonada conforme o histórico com cada cliente: 20% até os primeiros US$ 300, 10% entre US$ 301 e US$ 3.000, e 5% acima disso. Além da comissão do profissional, a plataforma cobra do cliente um "custo de serviço" de aproximadamente 4,5%. O cadastro é gratuito, mas com limite de propostas no plano básico, sendo necessário assinar um plano pago para ampliar a visibilidade. Não atende serviços locais e não tem gamificação.

**99Freelas** — https://www.99freelas.com.br
Plataforma brasileira de serviços digitais, com funcionamento parecido com o da Workana: o cliente publica o projeto, os freelancers enviam propostas e o pagamento fica retido até a conclusão. A taxa de intermediação varia de 5% a 20% (com mínimo de R$ 10) conforme o plano do freelancer — 20% no plano gratuito, 15% no Pro e 10% no Premium. O cadastro é gratuito, com limite de propostas mensais, e nas primeiras 24 horas os projetos ficam disponíveis apenas para assinantes. Também não atende serviços locais nem oferece gamificação.

**Referência internacional.** Plataformas globais como o Fiverr possuem sistemas de níveis de vendedor (seller levels) baseados em desempenho. Vale registrar que isso é o que existe de mais próximo a uma gamificação no setor, mas trata-se de um sistema de reputação por faixas, e não de uma mecânica de engajamento com XP, missões, conquistas e ranking local como a que o Escambo propõe.

| Critério | GetNinjas | Workana | 99Freelas | Escambo |
|---|---|---|---|---|
| Pagamento com escrow | Não | Sim | Sim | Sim |
| Serviços locais e presenciais | Sim | Não | Não | Sim |
| Serviços digitais | Parcial | Sim | Sim | Sim |
| Cadastro gratuito | Sim | Com limite | Com limite | Sim |
| Cobrança do profissional | Compra de leads | Comissão 5–20% | Comissão 5–20% | Comissão fixa de 15% |
| Taxa cobrada do cliente | Não | ~4,5% | Incluída na oferta | Não |
| Chat integrado em tempo real | Não | Parcial | Parcial | Sim |
| Dashboard financeiro | Não | Básico | Básico | Completo |
| Gamificação (XP, missões) | Não | Não | Não | Sim |
| Ranking local por proximidade | Não | Não | Não | Sim |

#### Diferencial do projeto

O Escambo ataca uma combinação que nenhuma das plataformas analisadas oferece hoje: une o alcance de serviços locais do GetNinjas com o pagamento seguro da Workana e do 99Freelas, e acrescenta o que nenhuma das três tem — gamificação real de engajamento, dashboard financeiro completo e um chat integrado em tempo real. Dois pontos do modelo de cobrança reforçam esse diferencial. Primeiro, a comissão do profissional é fixa e transparente (15%) e só é cobrada quando o serviço é concluído, ao contrário da compra de leads sem garantia do GetNinjas. Segundo, o cliente não paga taxa nenhuma, diferente da Workana, que cobra cerca de 4,5% do contratante.

### 1.4 Público-Alvo

O Escambo atende três perfis de usuário:

**Freelancer autônomo** — profissional que oferece serviços de qualquer área, de eletricistas e diaristas a desenvolvedores e designers. Tem perfil técnico variado, usa smartphone no dia a dia e quer visibilidade sem precisar pagar adiantado por leads que talvez não convertam.

**Cliente pessoa física** — pessoa que precisa contratar um serviço com agilidade e segurança. Tem nível técnico médio e está acostumada a aplicativos de delivery e transporte. Sua principal dor é não saber se pode confiar em quem nunca viu.

**Empresa / MEI** — negócio que contrata freelancers de forma recorrente e quer centralizar isso numa única ferramenta, com histórico e nota dos profissionais.

### 1.5 Objetivos do Projeto

**Objetivo geral**

Tornar a contratação de serviços tão simples quanto o uso de um aplicativo de delivery, com pagamento seguro, avaliações verificadas e um sistema de progressão que premia quem trabalha bem.

**Objetivos específicos**

- Criar o fluxo completo de contratação: proposta → aceite → execução → entrega → avaliação
- Implementar pagamento via MercadoPago com escrow, mantendo o valor retido até a confirmação da entrega
- Desenvolver o sistema de gamificação com XP, níveis, badges, missões e ranking local
- Disponibilizar chat em tempo real entre cliente e freelancer dentro da plataforma
- Construir um dashboard para o freelancer acompanhar ganhos, contratos e progresso de nível
- Garantir conformidade com a LGPD desde o início
- Entregar a plataforma web em produção, com pipeline de CI/CD, testes automatizados e observabilidade

### 1.6 Métricas de Sucesso (KPIs)

- Fluxo completo de contratação funcionando do início ao fim sem erros
- Pagamento via MercadoPago processado e saldo creditado na carteira do freelancer
- API respondendo em menos de 300ms em 95% das requisições
- Banco de dados com 48 tabelas implementado e validado
- 82 requisitos funcionais e 40 requisitos não funcionais cobertos
- Cobertura de testes de ao menos 75% no backend e 25% no frontend nos módulos críticos
- Pipeline de CI/CD ativo, com lint, testes e build executados a cada push
- Teste de usabilidade com pelo menos 3 usuários reais concluindo as tarefas principais sem ajuda

---

## 2. Engenharia de Requisitos

### 2.1 Personas

#### Persona 1 — Rafael Souza (Freelancer Digital)

Rafael tem 27 anos e trabalha como desenvolvedor front-end freelancer em Joinville há dois anos. Saiu de um emprego CLT em busca de mais liberdade, mas a renda é irregular e a captação de clientes depende quase toda de indicação. Já tentou a Workana, ficou meses na fila de espera e, quando entrou, não conseguiu fechar nada no primeiro mês por causa da concorrência com quem cobra muito abaixo do mercado.

Não tem portfólio digital organizado e acaba mandando prints por WhatsApp. Controla os ganhos numa planilha manual. Responde clientes pelo WhatsApp pessoal, misturado com conversas de família.

> *"Sei que sou bom no que faço, mas não consigo provar isso para quem ainda não me conhece."*

#### Persona 2 — Camila Ferreira (Cliente)

Camila tem 34 anos e é analista de RH em Blumenau. Já foi prejudicada ao pagar adiantado para um designer pelo GetNinjas: o profissional sumiu depois de entregar uma versão ruim do trabalho. Desde então, desconfia de qualquer plataforma que não tenha garantia de pagamento.

Quer contratar serviços com a mesma facilidade com que pede comida por aplicativo, sem garimpar em grupos de WhatsApp, sem negociar por fora e sem correr risco de calote.

> *"Não é que eu não queira pagar bem. É que não tenho como saber se vai valer a pena antes de contratar."*

#### Persona 3 — Marcos Oliveira (Autônomo Local)

Marcos tem 42 anos e trabalha como eletricista autônomo há 15 anos em Itajaí. Nunca teve carteira assinada e sempre viveu de indicações. Tentou o GetNinjas, mas desistiu quando percebeu que precisaria comprar moedas sem garantia de fechar serviço. Não tem portfólio, não tem CNPJ e recebe tudo em dinheiro ou PIX.

Nos meses fracos, fica duas ou três semanas sem trabalho. Quer aparecer para clientes que precisam de um eletricista agora, perto dele, sem pagar adiantado por lead.

> *"Meu serviço é bom, todo mundo que me chama volta. Mas como eu faço para chegar em quem nunca me chamou?"*

### 2.2 Casos de Uso Principais

Os principais fluxos do sistema são:

1. Cadastrar e autenticar (e-mail/senha ou Google OAuth2)
2. Criar e gerenciar perfil (foto, bio, portfólio, disponibilidade)
3. Publicar e gerenciar serviços (categoria, preço, prazo, tags)
4. Buscar e contratar serviço (filtros, geolocalização, proposta)
5. Gerenciar contratação (aceite, execução, entrega, revisão, conclusão)
6. Realizar pagamento (PIX, cartão, boleto via MercadoPago com escrow)
7. Avaliar serviço (nota, comentário, resposta do freelancer)
8. Usar o chat (mensagens em tempo real, arquivos, histórico)
9. Acompanhar gamificação (XP, nível, badges, missões, ranking)
10. Abrir ticket de suporte (categorias, histórico, mediação de disputas)
11. Administrar a plataforma (painel admin, métricas, configurações)

### 2.3 Requisitos Funcionais

Os requisitos estão organizados por módulo. Abaixo, os principais de cada um.

**Módulo de Autenticação**

- RF-001 — O sistema deve permitir que o usuário crie conta via e-mail e senha
- RF-002 — O sistema deve permitir que o usuário faça login via Google OAuth2
- RF-003 — O sistema deve emitir tokens JWT com expiração de 1 hora
- RF-004 — O sistema deve suportar refresh token com expiração de 7 dias
- RF-005 — O sistema deve enviar e-mail de confirmação de conta após o cadastro
- RF-006 — O sistema deve permitir que o usuário recupere a senha via link enviado por e-mail

**Módulo de Perfis**

- RF-007 — O sistema deve permitir que o freelancer crie perfil com foto, bio, headline e localização
- RF-008 — O sistema deve permitir que o freelancer adicione itens ao portfólio com imagem e descrição
- RF-009 — O sistema deve exibir nota média, total de serviços e badges no perfil do freelancer
- RF-010 — O sistema deve permitir que o freelancer defina sua disponibilidade (disponível/indisponível)

**Módulo de Contratações**

- RF-011 — O sistema deve permitir que o cliente envie proposta de contratação a um freelancer
- RF-012 — O sistema deve permitir que o freelancer aceite, recuse ou faça contraproposta
- RF-013 — O sistema deve rastrear o status da contratação em cada etapa do fluxo
- RF-014 — O sistema deve permitir que o freelancer registre a entrega com mensagem e arquivos
- RF-015 — O sistema deve permitir que o cliente aprove a entrega ou solicite revisão
- RF-016 — O sistema deve liberar o pagamento ao freelancer somente após a aprovação da entrega

**Módulo de Pagamentos**

- RF-017 — O sistema deve processar pagamentos via MercadoPago (PIX, cartão, boleto)
- RF-018 — O sistema deve reter o valor em escrow até a conclusão confirmada
- RF-019 — O sistema deve exibir a taxa da plataforma de forma transparente antes da confirmação
- RF-020 — O sistema deve permitir que o freelancer solicite saque via PIX ou transferência bancária

**Módulo de Gamificação**

- RF-021 — O sistema deve atribuir XP ao freelancer por serviços concluídos, avaliações recebidas e missões cumpridas
- RF-022 — O sistema deve calcular o nível do freelancer com base no XP acumulado (6 níveis: Iniciante → Lenda)
- RF-023 — O sistema deve emitir badges automaticamente ao atingir marcos definidos
- RF-024 — O sistema deve disponibilizar missões semanais com recompensas em XP
- RF-025 — O sistema deve exibir ranking local de freelancers por categoria dentro de um raio de 50km

> A lista completa com os 82 requisitos funcionais está em [`docs/requisitos-funcionais.md`](./requisitos-funcionais.md).

### 2.4 Requisitos Não Funcionais

- RNF-001 — A API deve responder em menos de 300ms para 95% das requisições em carga normal
- RNF-002 — O sistema deve ter uptime mínimo de 99,5% ao mês
- RNF-003 — Todas as senhas devem ser armazenadas com bcrypt (salt rounds ≥ 12)
- RNF-004 — Toda comunicação deve ser via HTTPS com TLS 1.2 ou superior
- RNF-005 — O sistema deve implementar rate limiting de no máximo 10 tentativas de login por IP em 5 minutos
- RNF-006 — O sistema deve validar e sanitizar 100% dos dados de entrada para prevenir injeção
- RNF-007 — CPF e dados bancários devem ser armazenados com criptografia AES-256
- RNF-008 — O sistema deve estar em conformidade com a LGPD desde o lançamento
- RNF-009 — Módulos críticos devem ter cobertura mínima de 75% de testes automatizados no backend
- RNF-010 — A API deve ter documentação OpenAPI/Swagger atualizada a cada release

> A lista completa com os 40 requisitos não funcionais está em [`docs/requisitos-nao-funcionais.md`](./requisitos-nao-funcionais.md).

### 2.5 Regras de Negócio

As principais regras que o sistema deve respeitar, independentemente da interface:

- Cada e-mail pode estar vinculado a no máximo uma conta na plataforma
- Contas não verificadas por e-mail podem visualizar serviços, mas não podem contratar nem publicar
- Perfis de freelancer sem foto, bio e categoria preenchidas não aparecem nos resultados de busca
- O pagamento deve ser retido em escrow antes do início do serviço: o freelancer não começa sem garantia
- A taxa da plataforma é de 15% sobre o valor bruto da contratação, cobrada do freelancer
- O cliente tem 5 dias úteis para aprovar ou solicitar revisão após a entrega; depois disso, a aprovação é automática
- Avaliações só podem ser feitas após uma contratação com status "Concluído", evitando avaliação falsa
- XP nunca é perdido por inatividade: o freelancer pode voltar sem perder a progressão
- O saque mínimo é de R$ 20,00, com prazo de até 1 dia útil via PIX

> A lista completa com as 75 regras de negócio está em [`docs/regras-de-negocio.md`](./regras-de-negocio.md).

### 2.6 Fora do Escopo

A entrega web (este TCC) não inclui:

- Aplicativo mobile nativo ou em React Native: planejado para a Fase 2, em 2027 (ver seção 5.6)
- Integração com outros gateways de pagamento além do MercadoPago
- Sistema de assinatura recorrente para clientes
- API pública para integrações externas
- Internacionalização: o produto é focado no Brasil
- Modo offline

---

## 3. Fluxos e Comportamento do Sistema

Esta seção apresenta os principais fluxos de uso do Escambo, considerando tanto o caminho esperado da contratação quanto os cenários alternativos que podem acontecer durante o uso da plataforma.

Os fluxos foram separados em duas partes. Primeiro, são apresentados os fluxos principais do cliente e do freelancer, que representam o funcionamento padrão do sistema. Depois, são descritos os fluxos alternativos de cancelamento, aprovação tácita e disputa, que tratam situações em que a contratação não segue o caminho ideal.

### 3.1 Fluxo Principal do Usuário

#### Fluxo do cliente — contratação

O fluxo principal do cliente representa o caminho mais comum dentro da plataforma. Ele começa quando o usuário acessa o Escambo para buscar um serviço e termina quando a contratação é concluída e avaliada.

Nesse processo, o cliente pesquisa por categoria ou palavra-chave, aplica filtros para encontrar profissionais mais adequados, acessa o perfil do freelancer, envia uma proposta e realiza o pagamento. O valor pago fica protegido pelo sistema de escrow até que o serviço seja entregue e aprovado.

Depois da entrega, o cliente pode aprovar o serviço ou solicitar uma revisão. Quando a entrega é aprovada, o pagamento é liberado ao freelancer e o cliente registra uma avaliação de 1 a 5 estrelas.

**Figura 1 — Fluxo principal do cliente na contratação de um serviço.**

<img width="264" height="747" alt="image" src="https://github.com/user-attachments/assets/303f260d-2f46-42bf-9d4f-9ab41abe69b7" />


O fluxo do cliente segue as seguintes etapas:

```text
Acessa o Escambo
    → Busca por categoria ou palavra-chave
    → Aplica filtros (localização, preço, nota)
    → Acessa o perfil do freelancer
    → Envia proposta (descrição, prazo)
    → Realiza o pagamento (PIX/cartão/boleto)
    → Acompanha o contrato via chat
    → Recebe e analisa a entrega
    → Aprova ou solicita revisão
    → Avalia o serviço (1 a 5 estrelas)
```

#### Fluxo do freelancer — execução

O fluxo principal do freelancer mostra como o profissional participa da contratação após receber uma proposta. A partir da notificação, ele analisa a solicitação do cliente e pode aceitar, recusar ou negociar os termos da proposta.

Quando aceita a contratação, o freelancer executa o serviço combinado e registra a entrega diretamente na plataforma, incluindo uma mensagem e, quando necessário, arquivos anexos. Após isso, ele aguarda a aprovação do cliente.

Com a aprovação da entrega, o valor é liberado para a carteira digital do freelancer. Em seguida, ele pode solicitar o saque via PIX, respeitando as regras de saque definidas pelo sistema.

**Figura 2 — Fluxo principal do freelancer na execução de um serviço.**

<img width="322" height="747" alt="image" src="https://github.com/user-attachments/assets/46e58d81-5b7e-41b2-8f11-a15e88a7ef4f" />

O fluxo do freelancer segue as seguintes etapas:

```text
Recebe notificação de nova proposta
    → Analisa e aceita (ou negocia)
    → Executa o serviço
    → Registra a entrega (mensagem + arquivos)
    → Aguarda aprovação do cliente
    → Recebe o valor na carteira digital
    → Solicita saque via PIX
```

### 3.2 Fluxos Alternativos

Além dos fluxos principais, o sistema precisa lidar com situações que podem ocorrer durante uma contratação, como cancelamento, ausência de resposta do cliente ou problemas na entrega do serviço.

Esses cenários são importantes porque definem como a plataforma deve agir quando a contratação foge do caminho ideal, mantendo segurança e previsibilidade para cliente e freelancer.

#### Cancelamento com reembolso

O fluxo de cancelamento define como o sistema deve se comportar quando uma contratação é interrompida antes da conclusão. A regra de reembolso varia de acordo com o momento em que o cancelamento acontece.

Se o cancelamento ocorrer antes do aceite do freelancer, o cliente recebe reembolso total. Caso o serviço já esteja em andamento, o percentual de reembolso depende do prazo já decorrido. Após a entrega, o cancelamento não gera reembolso automático e o sistema encaminha a situação para disputa.

**Figura 3 — Fluxo alternativo de cancelamento com reembolso.**

<img width="935" height="749" alt="image" src="https://github.com/user-attachments/assets/2cf5548a-c852-4865-9549-68ef74da2084" />


As regras de cancelamento são:

```text
Antes do aceite:
    → Reembolso total

Em andamento, com menos de 50% do prazo decorrido:
    → Reembolso de 50%

Em andamento, com 50% ou mais do prazo decorrido:
    → Sem reembolso

Após a entrega:
    → Sem reembolso automático
    → Abre ticket de disputa
```

#### Aprovação tácita

A aprovação tácita existe para evitar que uma contratação fique parada indefinidamente quando o freelancer já realizou a entrega e o cliente não responde dentro do prazo estabelecido.

Após o freelancer registrar a entrega, o cliente tem 5 dias úteis para aprovar o serviço ou solicitar uma revisão. Se não houver manifestação dentro desse período, o sistema entende que a entrega foi aceita e aprova automaticamente a contratação.

Com isso, o pagamento é liberado ao freelancer e o contrato é encerrado como concluído.

**Figura 4 — Fluxo alternativo de aprovação tácita após 5 dias úteis.**

<img width="382" height="751" alt="image" src="https://github.com/user-attachments/assets/71b5f315-4090-4e12-9289-f0a5147edd75" />


O comportamento da aprovação tácita é:

```text
Freelancer registra a entrega
    → Sistema inicia contagem de 5 dias úteis
    → Cliente pode aprovar ou solicitar revisão
    → Se o cliente não se manifestar no prazo
    → Sistema aprova automaticamente
    → Pagamento é liberado ao freelancer
```

#### Disputa

O fluxo de disputa ocorre quando existe algum problema na execução do serviço, especialmente quando o prazo é ultrapassado sem que o freelancer registre a entrega. Nesse caso, o sistema cria automaticamente um ticket de suporte com prioridade alta.

A abertura da disputa permite que a situação seja analisada com base no histórico da contratação, nas mensagens trocadas no chat, nos prazos combinados e nos registros da plataforma. Tanto o cliente quanto o freelancer são notificados para acompanhar o processo.

Esse fluxo é importante para garantir mais segurança e transparência para os dois lados da contratação.

**Figura 5 — Fluxo alternativo de disputa por prazo estourado sem entrega.**

<img width="463" height="749" alt="image" src="https://github.com/user-attachments/assets/6dcc2b67-05e0-4887-8ebc-b61668e2e0cb" />


O comportamento do fluxo de disputa é:

```text
Prazo do serviço é ultrapassado
    → Sistema verifica que não houve entrega registrada
    → Sistema cria ticket de suporte automaticamente
    → Ticket recebe prioridade Alta
    → Cliente e freelancer são notificados
    → Suporte analisa o histórico da contratação
```

---

## 4. Mockups e Experiência do Usuário (UX)

### 4.1 Fluxo de Navegação

```
Onboarding
    Login / Cadastro → Escolha de perfil
        ├── Cliente → Home (busca) → Perfil do freelancer
        │              → Proposta → Pagamento → Contrato → Avaliação
        │
        └── Freelancer → Dashboard → Serviços → Propostas
                          → Chat → Entrega → Carteira → Conquistas
```

Módulos compartilhados (acessíveis por ambos via menu):
Chat · Notificações · Suporte · Configurações · Perfil

### 4.2 Wireframes e Mockups das Telas

As telas foram desenvolvidas para desktop (largura base de 1280px), com design responsivo.
A identidade visual adota o verde profundo (#0D5C3A) como cor primária e o âmbar (#F59E0B) como cor de destaque para os elementos de gamificação.

**Tela 1 — Home do cliente (busca e descoberta)**

Tela principal após o login do cliente. Exibe saudação personalizada, campo de busca, categorias em pills horizontais e cards de serviços em destaque. Cards impulsionados recebem badge âmbar. Cada card exibe o nível do freelancer (Especialista, Mestre etc.), a nota e a distância. Na barra superior ficam o XP acumulado do usuário e a barra de missão ativa. O ranking local dos profissionais da categoria aparece na seção inferior.

<img width="1903" height="914" alt="image" src="https://github.com/user-attachments/assets/e5f904da-1c4a-4ced-9886-424faf3fda70" />

Ações disponíveis: buscar serviço, filtrar por categoria, acessar perfil do profissional, ver missão ativa.

---

**Tela 2 — Perfil do freelancer**

Exibida quando o cliente clica num profissional. Header em verde escuro com avatar, nome, headline, cidade, disponibilidade e nível em destaque. Barra de XP com progresso para o próximo nível e posição no ranking (#2 da cidade). Sidebar com botões de contratar e enviar mensagem, força do perfil (checklist do que falta preencher), badges com XP ganho em cada conquista e feed dos últimos XP recebidos. Conteúdo principal com abas (Sobre / Portfólio / Avaliações / Serviços). A missão ativa do freelancer aparece em destaque no topo do conteúdo, sinalizando ao cliente que o profissional está engajado.

<img width="1905" height="913" alt="image" src="https://github.com/user-attachments/assets/495008e3-42f4-44a8-b904-da680ad58a50" />

Ações disponíveis: contratar, enviar mensagem, ver portfólio, ler avaliações.

---

**Tela 3 — Dashboard do freelancer**

Tela central do freelancer após o login. Sidebar com nível, XP, sequência de dias e navegação. Área principal com 4 métricas (ganhos do mês, contratos ativos, nota média, XP da semana). Carteira em destaque com saldo disponível, saldo em escrow e botão de saque. Cards de contratos ativos com status colorido, missões ativas com barra de progresso, ranking local e feed de XP ganho. Cada ação que gerou XP aparece no feed com valor e data.

<img width="1903" height="913" alt="image" src="https://github.com/user-attachments/assets/4deb3e3e-fc5f-4f92-b802-ff3f3b183882" />

Ações disponíveis: ver contratos, acessar missões, ver ranking, sacar, navegar pelos módulos.

---

**Tela 4 — Chat**

Layout em duas colunas: lista de conversas à esquerda com status online, badge de não lidos e preview da última mensagem. Área de chat à direita com header do interlocutor (status online), barra do contrato ativo (nome, valor, status), histórico de mensagens em bolhas e card de proposta dentro do chat com botão de aceitar e pagar. Input com ícones de anexo e foto. Dica de XP no rodapé: "Responda em menos de 1h e ganhe +30 XP — missão ativa!".

<img width="1895" height="914" alt="image" src="https://github.com/user-attachments/assets/ef9326b1-4657-48d0-a359-9ab373741ad6" />

Ações disponíveis: enviar mensagem, anexar arquivo, aceitar proposta, ver contrato.

---

**Tela 5 — Pagamento**

Steps no topo mostrando o progresso (Proposta → Pagamento → Confirmação). Preview do freelancer com nota, badges e nível. Resumo do serviço contratado. Seleção de método de pagamento (PIX, cartão, boleto). Sidebar com XP ganho pela contratação (+20 XP), resumo financeiro com taxa explícita, botão de pagamento e bloco "Por que é seguro", com checklist (escrow, avaliações verificadas, suporte em disputas, LGPD).

<img width="1914" height="904" alt="image" src="https://github.com/user-attachments/assets/77b46b66-66a2-4097-bd49-c5beb57d3524" />

Ações disponíveis: selecionar método, confirmar pagamento.

---

**Tela 6 — Conquistas e Gamificação**

Hero verde com nível, XP, barra de progresso e posição no ranking. Grid de badges conquistadas (4) e bloqueadas (2 com opacidade reduzida e meta visível). Cards de missões ativas com barra de progresso individual. Ranking local top 4 com destaque na linha do próprio usuário. Histórico de XP com cada ação que gerou pontos.

<img width="1913" height="909" alt="image" src="https://github.com/user-attachments/assets/8bbbf905-28e3-4631-86d8-c811ce79f21c" />

Ações disponíveis: ver detalhes de cada badge, acompanhar progresso das missões, ver ranking completo.

---

**Tela 7 — Landing page (visitante não logado)**

Navbar com links, botão de entrar e criar conta. Hero com título, subtítulo, dois CTAs (cliente e freelancer) e preview da plataforma mostrando cards reais de freelancers com nível e XP visíveis. Strip escuro com 6 diferenciais. Seção de como funciona em 3 passos, com XP de recompensa em cada passo. Seção de gamificação em verde escuro com os 6 níveis e missões ao vivo. Seção comparativa com tabela de critérios versus concorrentes. Depoimentos das 3 personas. CTA final em fundo escuro.

<img width="1897" height="913" alt="image" src="https://github.com/user-attachments/assets/efd4cfb4-7e0d-48d6-92f4-4266147f2caf" />

> O protótipo navegável deve ser construído no Figma a partir dos mockups acima. Os arquivos de referência estão em [`docs/wireframes.md`](./wireframes.md).

### 4.3 Fluxo de Interação do Usuário

Fluxo de contratação completo em 5 passos:

1. O cliente busca "eletricista" na home e vê cards com nota, nível e distância
2. Acessa o perfil do Marcos, lê avaliações verificadas e vê o portfólio
3. Clica em "Contratar R$ 120" e preenche a descrição do que precisa
4. Confirma o pagamento via PIX, e o valor vai para o escrow
5. Marcos executa, registra a entrega, o cliente aprova, o pagamento é liberado e ambos ganham XP

### 4.4 Feedback Inicial de Usuários

Após apresentar os mockups a 3 usuários (2 freelancers e 1 cliente):

> *"Ficou muito fácil de usar. Procurei o serviço, vi o perfil e já quis contratar."*
> — C01, durante o teste da home e do perfil

> *"O dashboard ficou bem claro. Sei exatamente quanto ganhei e quantos contratos tenho abertos."*
> — F02, durante o teste do dashboard

> *"Esse negócio de XP e missão eu não entendia no começo. Mas depois que explicam, faz sentido. É parecido com um jogo."*
> — F05, durante o teste das conquistas

Os 3 ajustes identificados foram: o botão de chat estava pouco visível no perfil, o sistema de missões precisava de um tooltip explicativo no primeiro acesso e faltava uma explicação inline sobre o que a taxa de 15% cobre.

---

## 5. Arquitetura do Sistema

### 5.1 Diagrama C4

#### Nível 1 — Diagrama de Contexto

O Escambo é o sistema central que recebe interações de três tipos de atores: clientes (pessoas físicas que contratam serviços), freelancers (profissionais que oferecem serviços) e administradores (equipe interna). O sistema se integra a três serviços externos: MercadoPago, para processamento de pagamentos; Google OAuth2, para autenticação social; e Cloudflare, para CDN, proteção DDoS e SSL.

> <img width="925" height="455" alt="Captura de tela 2026-06-09 104344" src="https://github.com/user-attachments/assets/b3d72bea-6f72-462b-b435-de9c0d4025b5" />#

" />

#### Nível 2 — Diagrama de Containers

A arquitetura-alvo é composta pelos seguintes containers. Para a entrega web (este TCC), o escopo cobre o Web App, a API Backend, o banco MySQL e o storage. O Mobile App está representado no diagrama como parte da visão completa do produto, mas pertence à Fase 2 (seção 5.6).

- Web App (React + Vite + TypeScript) — interface navegável para desktop *(escopo desta entrega)*
- Mobile App (React Native + Expo) — aplicativo iOS e Android *(Fase 2)*
- API Backend (Node.js + Express + TypeScript) — núcleo da lógica de negócio *(escopo desta entrega)*
- MySQL 8 — banco de dados relacional com 48 tabelas *(escopo desta entrega)*
- DO Spaces — storage de arquivos compatível com S3 (imagens, portfólio, entregas) *(escopo desta entrega)*

O Web App se comunica com a API via HTTPS/JSON. A API se conecta ao banco MySQL, ao storage e aos serviços externos (MercadoPago, Cloudflare). O chat usa WebSocket (Socket.IO) para comunicação em tempo real. Na Fase 2, o Mobile App consumirá exatamente a mesma API, sem necessidade de um backend separado.

> <img width="1793" height="886" alt="image" src="https://github.com/user-attachments/assets/77d11680-211b-44e4-921f-b3b5b6761249" />

#### Nível 3 — Diagrama de Componentes (API Backend)

A API é organizada em quatro camadas:

**Router + Middleware** — porta de entrada de todas as requisições. Responsável por validação de JWT, rate limiting e CORS.

**Controllers** — recebem as requisições roteadas e delegam para os services. Há um controller por módulo funcional (Auth, Profiles, Services, Contracts, Payments, Reviews, Chat, Gamification, Notifications, Support, Admin).

**Services** — concentram as regras de negócio. O AuthService cuida de JWT e bcrypt. O PaymentService implementa a lógica de escrow e a integração com o MercadoPago. O GamificationService calcula XP, verifica condições de badge e atualiza rankings.

**Repositories** — fazem o acesso ao banco MySQL. Cada entidade principal tem o seu próprio repository (UserRepository, ContractRepository, PaymentRepository etc.).

> <img width="1629" height="890" alt="image" src="https://github.com/user-attachments/assets/23bfffe5-3e24-4146-bd6f-79343d1b2434" />

### 5.2 Modelo de Dados

O banco tem 48 tabelas distribuídas entre os 14 módulos. As entidades centrais são:

- `users` — base de todos os perfis
- `profiles_freelancer`, `profiles_client`, `profiles_company` — dados específicos por tipo
- `services` e `service_categories` — catálogo de serviços
- `contracts` e `contract_status_history` — fluxo de contratação com histórico imutável
- `payments`, `wallets` e `withdrawals` — sistema financeiro
- `reviews` e `review_responses` — avaliações verificadas
- `conversations` e `messages` — chat
- `user_xp`, `user_badges`, `missions`, `user_missions` — gamificação
- `notifications`, `support_tickets`, `audit_logs`, `lgpd_consents` — infraestrutura e conformidade

> DDL completo com todas as tabelas em [`docs/modelagem-banco.md`](./modelagem-banco.md).

### 5.3 Principais Componentes

**Sistema de autenticação** — JWT stateless com refresh token, login social via OAuth2, verificação de e-mail, recuperação de senha e rate limiting por IP.

**Módulo de pagamentos** — integração com o MercadoPago via webhook, lógica de escrow com liberação condicional, carteira digital por usuário e processamento de saques via PIX.

**Engine de gamificação** — cálculo de XP por evento (serviço concluído, avaliação recebida, missão cumprida), verificação automática de condições de badge e cálculo de ranking local por geolocalização.

**Sistema de chat** — WebSocket com Socket.IO, entrega garantida, histórico persistido no MySQL e notificações push integradas.

### 5.4 Stack Tecnológica

| Tecnologia | Por que foi escolhida |
|---|---|
| React + Vite | Stack que domino bem. Todos os meus projetos anteriores usam React, e a produtividade real supera qualquer ganho teórico de trocar de ferramenta |
| Node.js + Express + TypeScript | Bom desempenho de I/O, tipagem que evita boa parte dos bugs em runtime e ecossistema npm maduro para todas as integrações necessárias |
| MySQL 8 | Os dados do Escambo são altamente relacionais (contratações, pagamentos e avaliações têm muitos relacionamentos). Um banco relacional com transações ACID é a escolha adequada aqui |
| MercadoPago | Maior cobertura no Brasil, PIX nativo, SDK bem documentado para Node.js e suporte a escrow via marketplace |
| DigitalOcean | Bom custo-benefício para um MVP, mais controle do que um PaaS como o Heroku e escalonamento horizontal quando necessário |
| Cloudflare | CDN global no plano gratuito, proteção contra DDoS e SSL automático sem configuração extra |
| React Native + Expo *(Fase 2)* | Compartilha lógica e contratos de API com o frontend web, o que acelera o desenvolvimento mobile sem exigir Swift ou Kotlin do zero |

### 5.5 Decisões Arquiteturais

Algumas escolhas merecem justificativa, já que afetam o projeto a longo prazo:

- **Camadas separadas (Controller → Service → Repository)** para isolar a regra de negócio do acesso a dados. Isso facilita os testes (os services podem ser testados com repositories mockados) e deixa o código mais fácil de manter.
- **Escrow no backend, nunca no frontend.** Toda a lógica financeira fica no servidor, validada por webhook do MercadoPago. O frontend nunca decide quando liberar dinheiro.
- **Histórico imutável de status** (`contract_status_history`, `audit_logs`) em vez de simplesmente sobrescrever o estado. Isso dá rastreabilidade para disputas e auditoria.

### 5.6 Arquitetura Mobile (Fase 2)

O aplicativo mobile não faz parte desta entrega, mas a decisão de tê-lo numa fase posterior não significa que ele foi deixado em aberto. Defini desde já a abordagem para evitar retrabalho quando chegar a hora.

O app será desenvolvido em React Native com Expo, consumindo a mesma API REST já validada na versão web. A organização do código seguirá uma arquitetura modular por features combinada com separação em camadas, no espírito da Clean Architecture: cada feature (autenticação, contratações, chat, gamificação) terá suas próprias telas, sua camada de estado e seus serviços de comunicação com a API, sem misturar responsabilidades. Concretamente:

- **Camada de apresentação** — telas e componentes em React Native, com gerenciamento de estado por feature (por exemplo, React Query para estado de servidor e Context/Zustand para estado local).
- **Camada de domínio/serviços** — hooks e serviços que encapsulam as chamadas à API e as regras específicas do cliente mobile, reaproveitando os contratos de tipos do TypeScript compartilhados com o backend.
- **Camada de dados** — cliente HTTP centralizado, com interceptação de token JWT e refresh automático, e cache local para as telas mais acessadas.

Essa organização mantém a lógica de negócio concentrada no backend (que continua sendo a fonte da verdade) e deixa o app responsável apenas pela experiência e pela apresentação. A comunicação em tempo real do chat usará o mesmo Socket.IO da web. Recursos como modo offline serão avaliados apenas depois que o app estiver estável.

---

## 6. Segurança e Privacidade

A segurança não foi tratada como uma funcionalidade opcional, e sim como parte da arquitetura desde o início. As principais proteções seguem as diretrizes do OWASP Top 10:

- Injeção de SQL prevenida por queries parametrizadas e validação de schema em todas as rotas
- Autenticação com JWT de curta duração (1h), refresh token (7 dias) e encerramento de todas as sessões ao trocar a senha
- Senhas com bcrypt e salt rounds 12, nunca armazenadas em texto plano
- Rate limiting por IP nas rotas de autenticação, com bloqueio após tentativas repetidas em curto intervalo
- CPF e dados bancários com criptografia AES-256 no banco
- HTTPS obrigatório, com TLS 1.2 ou superior, em toda a comunicação
- CORS configurado para aceitar apenas origens autorizadas
- Audit log imutável de todas as ações financeiras e críticas

### 6.1 Privacidade e LGPD

O sistema está em conformidade com a Lei nº 13.709/2018 (LGPD) desde o início:

**Dados coletados no cadastro:** apenas e-mail, senha e tipo de perfil, o mínimo necessário para criar a conta.

**Dados adicionais:** coletados somente quando necessários para funcionalidades específicas (CPF para funcionalidades financeiras, telefone para notificações por SMS, localização para busca por proximidade).

**Como são armazenados:** dados sensíveis com criptografia AES-256 e senhas com bcrypt. A localização não é armazenada em tempo real; o sistema guarda apenas a cidade e as coordenadas aproximadas informadas pelo usuário.

**Direito ao esquecimento:** o usuário pode solicitar a exclusão de todos os dados pessoais a qualquer momento, com prazo de processamento de 15 dias úteis. Dados financeiros e de auditoria são retidos pelo prazo legal mínimo exigido (5 anos) e, depois, anonimizados.

**Consentimento:** checkboxes separados e explícitos para Termos de Uso, Política de Privacidade e autorização de tratamento de dados pessoais. Não são utilizados checkboxes pré-marcados.

---

## 7. Qualidade, Testes e Engenharia

Esta seção reúne os itens de engenharia exigidos pelas Directions: estratégia de testes (TDD), integração e entrega contínuas, análise estática e observabilidade. Eles não são um anexo da implementação; fazem parte dela desde o primeiro módulo.

### 7.1 Estratégia de Testes (TDD)

Adoto desenvolvimento orientado a testes nos módulos críticos, escrevendo o teste antes da implementação sempre que a regra de negócio justificar. As metas de cobertura, alinhadas às Directions, são de pelo menos **75% no backend** e **25% no frontend**, medidas sobre os módulos críticos.

No backend, a prioridade de cobertura segue o risco: pagamentos e escrow, autenticação, contratações e gamificação vêm primeiro, porque são onde um erro custa mais caro (dinheiro liberado errado, sessão insegura, XP calculado de forma incorreta). Cada camada tem um tipo de teste:

- **Testes unitários** nos services, com os repositories mockados, validando as regras de negócio isoladamente.
- **Testes de integração** nas rotas, exercitando o caminho completo (HTTP → controller → service → repository → banco) contra um banco de testes.

No frontend, os testes cobrem os componentes e fluxos mais sensíveis (formulários de contratação, fluxo de pagamento, exibição de saldo e carteira), garantindo que a interface não quebre nesses pontos.

### 7.2 Ferramentas de Teste

| Camada | Ferramentas |
|---|---|
| Backend (unitário e integração) | Jest + Supertest |
| Frontend (componentes) | Vitest + React Testing Library |
| Cobertura | Relatório de cobertura gerado no CI e verificado contra as metas mínimas |

A cobertura é medida automaticamente no pipeline, e um build que ficar abaixo da meta nos módulos críticos não é promovido.

### 7.3 CI/CD

O pipeline de integração e entrega contínuas roda no **GitHub Actions** e é disparado a cada push e a cada pull request. A sequência é:

1. **Instalação** das dependências
2. **Lint** (ESLint) e **checagem de tipos** (`tsc`)
3. **Testes** automatizados, com geração de relatório de cobertura
4. **Build** do backend e do frontend
5. **Deploy** para o ambiente correspondente

O branch `main` é protegido: nenhum merge entra sem o pipeline verde e sem revisão. Os deploys de produção usam o servidor na DigitalOcean, com PM2 gerenciando o processo Node e Nginx como proxy reverso (detalhes na seção 8).

### 7.4 Análise Estática de Código e Segurança

A qualidade e a segurança do código são verificadas de forma automática, sem depender de inspeção manual:

- **ESLint + Prettier** para padronização e detecção de problemas de estilo e de código
- **TypeScript em modo estrito**, eliminando uma classe inteira de erros antes da execução
- **SonarCloud** para análise contínua de qualidade, code smells e pontos de manutenção difícil
- **`npm audit` + Dependabot** para identificar e atualizar dependências com vulnerabilidades conhecidas
- **Varredura de segredos** (secret scanning do GitHub) para impedir que chaves e tokens vazem no repositório

Essas verificações são integradas ao pipeline de CI, de modo que problemas aparecem no próprio pull request.

### 7.5 Monitoramento, Observabilidade e Analytics

Com a plataforma em produção, é necessário enxergar o que está acontecendo:

- **Logging estruturado** (Pino) em toda a API, com níveis e correlação por requisição
- **Rastreamento de erros** com Sentry, capturando exceções em produção com contexto suficiente para depuração
- **Health-check** (`/health`) e **monitoramento de uptime** (UptimeRobot ou o monitoramento da própria DigitalOcean), validando a meta de 99,5%
- **Métricas de latência**, acompanhando o p95 das requisições para verificar a meta de resposta abaixo de 300ms (RNF-001)
- **Analytics de produto** para acompanhar o funil de conversão (busca → proposta → pagamento → conclusão) e entender onde os usuários abandonam o fluxo
- **Audit log** das ações financeiras e críticas, já previsto na arquitetura

---

## 8. Instalação e Deploy

Esta seção descreve como rodar o projeto localmente e como ele é publicado em produção. As instruções completas e atualizadas ficam no `README.md` do repositório.

### 8.1 Pré-requisitos

- Node.js 20 ou superior
- MySQL 8 (ou MariaDB compatível)
- Conta no MercadoPago (credenciais de sandbox para desenvolvimento)
- Conta na DigitalOcean (para o ambiente de produção)

### 8.2 Ambiente Local

```bash
# 1. Clonar o repositório
git clone https://github.com/Guirenzo/Escambo.git
cd Escambo

# 2. Backend
cd backend
cp .env.example .env        # preencher variáveis (banco, JWT, MercadoPago)
npm install
npm run migrate             # cria as tabelas
npm run seed                # dados iniciais (opcional)
npm run dev                 # sobe a API

# 3. Frontend (em outro terminal)
cd ../frontend
cp .env.example .env        # URL da API
npm install
npm run dev                 # sobe o app web
```

As variáveis de ambiente sensíveis (credenciais do banco, segredos de JWT, chaves do MercadoPago) nunca vão para o repositório. Elas ficam apenas no arquivo `.env`, que está no `.gitignore`.

### 8.3 Produção

O ambiente de produção roda em um droplet Ubuntu na DigitalOcean, com a seguinte configuração:

- **PM2** gerenciando o processo Node da API (restart automático, logs centralizados)
- **Nginx** como proxy reverso, encaminhando as requisições para a API e servindo o build estático do frontend
- **Cloudflare** à frente, cuidando de CDN, SSL e proteção contra DDoS
- Deploy automatizado por script, que executa o fluxo padrão: `git pull`, instalação de dependências, build, execução de migrações e `pm2 reload`

O deploy é acionado pelo pipeline de CI/CD após o merge em `main` (seção 7.3).

---

## 9. Planejamento do Projeto

O planejamento foi reorganizado em torno da entrega web, com os itens de engenharia (CI/CD, testes, análise estática e observabilidade) distribuídos ao longo dos marcos, e não concentrados no fim. O aplicativo mobile aparece como Fase 2, em 2027.

| Marco | Descrição | Prazo |
|---|---|---|
| M1 | Documentação completa e aprovação da RFC pela banca | Mai/2026 |
| M2 | Setup do ambiente e do repositório; pipeline de CI/CD inicial (lint, testes, build); análise estática (ESLint, Prettier, SonarCloud); módulos de autenticação e perfis, já com testes (TDD) | Jun/2026 |
| M3 | Módulo de serviços, contratações e pagamentos com escrow (MercadoPago); cobertura de testes do backend ≥ 75% nos módulos críticos | Jul–Ago/2026 |
| M4 | Chat em tempo real (Socket.IO), gamificação e notificações; observabilidade (logging estruturado, Sentry, health-check, monitoramento de uptime e latência) | Set/2026 |
| M5 | Dashboard financeiro, testes de frontend (≥ 25%), testes de usabilidade com usuários reais, ajustes de UX, documentação de deploy/instalação e Wiki do repositório | Out/2026 |
| M6 | Deploy em produção (DigitalOcean + Nginx + PM2 + Cloudflare), validação com usuários reais, coleta de feedback, hardening de segurança e analytics de conversão | Nov–Dez/2026 |
| Fase 2 | Aplicativo mobile (React Native + Expo), reaproveitando a API e a lógica já validadas, com arquitetura modular por features | 2027 |

---

## 10. Referências

- IBGE. **PNAD Contínua — Características adicionais do mercado de trabalho 2024**. Rio de Janeiro: IBGE, 2025. Disponível em: https://www.ibge.gov.br. Acesso em: abr. 2026.

- BRASIL. **Lei nº 13.709, de 14 de agosto de 2018** — Lei Geral de Proteção de Dados Pessoais (LGPD). Diário Oficial da União, Brasília, 2018.

- DETERDING, S. et al. From game design elements to gamefulness: Defining gamification. In: **Proceedings of the 15th International Academic MindTrek Conference**. ACM, 2011. p. 9–15.

- HAMARI, J.; KOIVISTO, J.; SARSA, H. Does Gamification Work? A Literature Review of Empirical Studies on Gamification. In: **Proceedings of the 47th Hawaii International Conference on System Sciences**. IEEE, 2014. p. 3025–3034.

- ROCHET, J. C.; TIROLE, J. Platform Competition in Two-Sided Markets. **Journal of the European Economic Association**, v. 1, n. 4, p. 990–1029, 2003.

- OWASP. **Top Ten 2021**. Open Web Application Security Project. Disponível em: https://owasp.org/Top10. Acesso em: abr. 2026.

- GETNINJAS. **Central de Ajuda — Como funcionam as moedas**. Disponível em: https://www.getninjas.com.br/central-de-ajuda. Acesso em: jun. 2026.

- WORKANA. **Central de Ajuda — Como é calculada a comissão**. Disponível em: https://help.workana.com. Acesso em: jun. 2026.

- 99FREELAS. **Central de Ajuda e página "Como Funciona"**. Disponível em: https://www.99freelas.com.br/como-funciona. Acesso em: jun. 2026.

- MERCADOPAGO. **Documentação da API MercadoPago**. Disponível em: https://www.mercadopago.com.br/developers. Acesso em: abr. 2026.

- BANCO CENTRAL DO BRASIL. **Estatísticas do PIX 2023–2024**. Brasília: BCB, 2024. Disponível em: https://www.bcb.gov.br. Acesso em: abr. 2026.

---

## 11. Apêndices

- **Apêndice A** — Modelagem completa do banco de dados: [`docs/modelagem-banco.md`](./modelagem-banco.md)
- **Apêndice B** — Lista completa de requisitos funcionais (82 RFs): [`docs/requisitos-funcionais.md`](./requisitos-funcionais.md)
- **Apêndice C** — Lista completa de requisitos não funcionais (40 RNFs): [`docs/requisitos-nao-funcionais.md`](./requisitos-nao-funcionais.md)
- **Apêndice D** — Regras de negócio (75 RNs): [`docs/regras-de-negocio.md`](./regras-de-negocio.md)
- **Apêndice E** — Personas detalhadas: [`docs/personas.md`](./personas.md)
- **Apêndice F** — Casos de uso completos: [`docs/casos-de-uso.md`](./casos-de-uso.md)
- **Apêndice G** — Benchmarking e estado da arte: [`docs/benchmarking.md`](./benchmarking.md)
- **Apêndice H** — Evidências de validação com usuários (roteiro, síntese tabulada e registros anonimizados): [`docs/evidencias-validacao.md`](./evidencias-validacao.md)
- **Apêndice I** — Repositório público: https://github.com/Guirenzo/Escambo

---

## 12. Parecer do Comitê de Avaliação

*(A ser preenchido pelos professores avaliadores)*

---

**Avaliador 1:** ______________________________________
**Instituição / Curso:** ______________________________________
**Data:** ________ / ________ / 2026

**Status:** [ ] Aprovado &nbsp;&nbsp; [ ] Aprovado com ajustes &nbsp;&nbsp; [ ] Reapresentar

**Nota:** _______ / 10

**Observações:**

> _______________________________________________________________________________
>
> _______________________________________________________________________________
>
> _______________________________________________________________________________

---

**Avaliador 2:** ______________________________________
**Instituição / Curso:** ______________________________________
**Data:** ________ / ________ / 2026

**Status:** [ ] Aprovado &nbsp;&nbsp; [ ] Aprovado com ajustes &nbsp;&nbsp; [ ] Reapresentar

**Nota:** _______ / 10

**Observações:**

> _______________________________________________________________________________
>
> _______________________________________________________________________________
>
> _______________________________________________________________________________

---

**Avaliador 3:** ______________________________________
**Instituição / Curso:** ______________________________________
**Data:** ________ / ________ / 2026

**Status:** [ ] Aprovado &nbsp;&nbsp; [ ] Aprovado com ajustes &nbsp;&nbsp; [ ] Reapresentar

**Nota:** _______ / 10

**Observações:**

> _______________________________________________________________________________
>
> _______________________________________________________________________________
>
> _______________________________________________________________________________

---

*RFC — Escambo v2.1 — PAC Extensionista VII — Católica SC — 2026 — Guilherme Renzo*
