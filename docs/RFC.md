# RFC — Escambo: Plataforma Digital de Serviços Freelance

**Engenharia de Software — Católica SC**

---

## Identificação

**Título do Projeto:**
Escambo — Plataforma Digital de Serviços Freelance

**Linha de Projeto:**
Plataforma — Web + Mobile

**Autor:**
Guilherme Renzo

**Data da Proposta:**
Abril de 2026

**Versão:**
2.0

**Repositório:**
https://github.com/Guirenzo/Escambo

**Licença:**
MIT — Open Source

---

## 1. Visão do Produto e Impacto

### 1.1 Contexto e Problema

O nome Escambo vem de uma palavra antiga que significa troca. Escolhi esse nome porque é exatamente isso que a plataforma faz: conecta quem precisa de um serviço com quem sabe fazer, de forma direta e sem burocracia. Mas vai além de uma troca simples — a ideia é que os dois lados saiam ganhando sempre.

A motivação veio de uma observação do cotidiano. Vivemos num mundo onde qualquer coisa se resolve pelo celular em minutos, mas contratar um eletricista, um desenvolvedor freelancer ou uma diarista ainda é uma bagunça. A pessoa pede indicação no grupo do WhatsApp, recebe cinco contatos, passa dois dias tentando agendar, não sabe se o profissional é confiável, paga adiantado e torce pra dar certo. Isso não faz sentido em 2026.

Do outro lado, trabalhadores autônomos — e são muitos, segundo o IBGE mais de 25 milhões no Brasil — ainda dependem quase exclusivamente de indicações pra conseguir clientes novos. Não têm portfólio digital, não têm histórico de avaliações verificadas, não têm controle financeiro organizado. Trabalham bem, mas são invisíveis pra quem nunca ouviu falar deles.

As plataformas que existem hoje não resolvem isso de verdade. O GetNinjas cobra do freelancer por cada lead sem garantia nenhuma de que vai fechar o serviço — usuários relatam gastar R$ 60 em créditos sem fechar nada. A Workana tem fila de espera que só termina pagando upgrade, e quando o profissional finalmente entra, enfrenta uma concorrência brutal de quem aceita cobrar qualquer coisa. Nenhuma das duas tem pagamento seguro pra serviços locais, nenhuma tem gamificação, nenhuma entrega um dashboard decente pro freelancer acompanhar o próprio crescimento.

A lacuna é clara: falta uma plataforma que combine a simplicidade do iFood, a segurança de pagamento do Uber e um sistema de progressão que faça o profissional querer voltar — não só pelo dinheiro, mas pelo crescimento dentro da plataforma.

### 1.2 Origem da Demanda e Evidências

#### Pesquisa com Usuários

Entre março e abril de 2026, foram realizadas entrevistas semiestruturadas com 8 pessoas — 5 freelancers e 3 clientes de serviços — na região de Itajaí, Joinville e Blumenau (SC). O roteiro foi aplicado sem apresentar a solução antes, pra mapear as dores reais sem influenciar as respostas.

**Perfil dos entrevistados:**

| # | Perfil | Cidade | Usa plataforma? |
|---|---|---|---|
| F01 | Eletricista autônomo | Itajaí, SC | Não |
| F02 | Desenvolvedor front-end | Joinville, SC | Sim (Workana) |
| F03 | Diarista | Itajaí, SC | Não |
| F04 | Designer gráfico | Blumenau, SC | Sim (GetNinjas) |
| F05 | Técnico de informática | Itajaí, SC | Sim (GetNinjas) |
| C01 | Analista de RH | Blumenau, SC | Sim (GetNinjas — experiência ruim) |
| C02 | Empreendedora / MEI | Itajaí, SC | Sim (Workana) |
| C03 | Gerente de loja | Blumenau, SC | Grupos de WhatsApp |

**Principais dores identificadas nos freelancers:**

- 4 de 5 relataram depender exclusivamente de indicações pra conseguir clientes novos
- Os 3 que já usaram plataformas relataram insatisfação com o modelo de monetização
- 4 de 5 não têm nenhuma ferramenta digital de controle financeiro
- 5 de 5 não têm portfólio digital organizado e verificável

> *"Meu serviço é bom, todo mundo que me chama volta. Mas como eu faço pra chegar em quem nunca me chamou?"*
> — F01, eletricista, 42 anos, Itajaí

> *"Paguei R$ 60 em moedas no GetNinjas. Mandei proposta pra 8 clientes. Fechei zero. Nunca mais."*
> — F05, técnico de informática, 36 anos, Itajaí

**Principais dores identificadas nos clientes:**

- 3 de 3 citaram confiança como principal barreira pra contratar um profissional desconhecido
- 2 de 3 relataram insegurança no pagamento adiantado sem qualquer garantia
- 3 de 3 descreveram o processo de contratação como lento e burocrático

> *"Paguei metade adiantado pra um designer pelo GetNinjas. Ele sumiu depois de mandar uma versão ruim. Não tinha como recuperar."*
> — C01, analista de RH, 34 anos, Blumenau

#### Evidências de Comunidade

Foram observados dois grupos locais de troca de serviços durante a fase de pesquisa:

| Grupo | Plataforma | Membros | Padrão observado |
|---|---|---|---|
| Serviços Itajaí e Região | WhatsApp | ~320 | 15 a 20 pedidos por dia sem avaliação nem preço padronizado |
| Freelancers SC | Facebook | ~1.800 | Mistura de portfólio e pedidos sem intermediação de pagamento |

Em ambos os grupos, clientes pedem recomendações antes de contratar qualquer desconhecido e há relatos frequentes de calote, não comparecimento e qualidade abaixo do esperado.

### 1.3 Análise de Soluções Existentes (Benchmark)

Foram analisadas as duas principais plataformas com operação consolidada no Brasil.

**GetNinjas** — https://www.getninja.com.br
- Público: serviços locais e presenciais
- Pontos fortes: grande base de usuários, cobertura geográfica ampla, app mobile
- Limitações: modelo de compra de leads sem garantia de conversão, sem pagamento integrado (o dinheiro vai direto pra fora da plataforma), suporte inativo, sem dashboard pro freelancer, sem gamificação

**Workana** — https://www.workana.com
- Público: serviços digitais (tech, design, marketing)
- Pontos fortes: histórico de projetos, pagamento intermediado
- Limitações: fila de espera paga, interface datada, comissão de 6 a 20%, sem serviços locais, sem gamificação, suporte considerado ineficiente pelos usuários

| Critério | GetNinjas | Workana | Escambo |
|---|---|---|---|
| Pagamento escrow | Não | Sim | Sim |
| Gamificação | Não | Não | Sim |
| Cadastro gratuito | Sim | Com fila | Sim |
| Chat integrado | Não | Parcial | Sim |
| Serviços locais | Sim | Não | Sim |
| Dashboard financeiro | Não | Básico | Completo |
| Ranking local | Não | Não | Sim |
| Taxa para clientes | Não | Não | Não |

#### Diferencial do projeto

O Escambo resolve o que nenhuma plataforma brasileira resolve hoje: junta os serviços locais do GetNinjas com o pagamento seguro da Workana e adiciona o que as duas nunca tiveram — gamificação real, dashboard completo e uma experiência de uso tão simples quanto pedir um lanche.

### 1.4 Público-Alvo

O Escambo tem três perfis de usuário:

**Freelancer autônomo** — profissional que oferece serviços de qualquer área, desde eletricistas e diaristas até desenvolvedores e designers. Perfil técnico variado, usa smartphone no dia a dia, quer visibilidade sem pagar adiantado por leads que podem não converter.

**Cliente pessoa física** — pessoa que precisa contratar um serviço e quer fazer isso com agilidade e segurança. Nível técnico médio, familiarizado com apps de delivery e transporte. Principal dor: não saber se pode confiar em quem nunca viu.

**Empresa / MEI** — negócio que contrata freelancers de forma recorrente e quer centralizar isso numa única ferramenta com histórico e nota dos profissionais.

### 1.5 Objetivos do Projeto

**Objetivo Geral**

Tornar a contratação de serviços tão fácil quanto pedir um lanche — com pagamento seguro, avaliações verificadas e um sistema de progressão que premia quem trabalha bem.

**Objetivos Específicos**

- Criar o fluxo completo de contratação: proposta → aceite → execução → entrega → avaliação
- Implementar pagamento via MercadoPago com escrow — o valor fica retido até a entrega ser confirmada
- Desenvolver o sistema de gamificação com XP, níveis, badges, missões e ranking local
- Disponibilizar chat em tempo real entre cliente e freelancer dentro do app
- Construir dashboard para o freelancer acompanhar ganhos, contratos e progresso de nível
- Garantir conformidade com a LGPD desde o primeiro dia

### 1.6 Métricas de Sucesso (KPIs)

- Fluxo completo de contratação funcional do início ao fim sem erros
- Pagamento via MercadoPago processado e saldo creditado na carteira do freelancer
- API respondendo em menos de 300ms pra 95% das requisições
- Banco de dados com 48 tabelas implementado e validado
- 82 requisitos funcionais e 40 não funcionais cobertos
- Teste de usabilidade com pelo menos 3 usuários reais completando as tarefas principais sem ajuda

---

## 2. Engenharia de Requisitos

### 2.1 Personas

#### Persona 1 — Rafael Souza (Freelancer Digital)

Rafael tem 27 anos, trabalha como desenvolvedor front-end freelancer em Joinville há dois anos. Saiu do emprego CLT pra ter mais liberdade, mas a renda é irregular e a captação de clientes depende quase toda de indicação. Já tentou a Workana, ficou meses na fila de espera, e quando entrou não conseguiu fechar nada no primeiro mês por causa da concorrência com quem cobra muito abaixo do mercado.

Não tem portfólio digital organizado — manda prints por WhatsApp. Controla os ganhos numa planilha manual. Responde clientes pelo WhatsApp pessoal, misturado com conversa de família.

> *"Sei que sou bom no que faço, mas não consigo provar isso pra quem não me conhece ainda."*

#### Persona 2 — Camila Ferreira (Cliente)

Camila tem 34 anos, é analista de RH em Blumenau. Já foi lesada pagando adiantado pra um designer pelo GetNinjas — o profissional sumiu após entregar uma versão ruim do trabalho. Desde então desconfia de qualquer plataforma que não tenha garantia de pagamento.

Quer contratar serviços com a mesma facilidade que pede comida pelo iFood — sem garimpar em grupos de WhatsApp, sem negociar fora da plataforma e sem correr risco de calote.

> *"Não é que eu não queira pagar bem — é que não tenho como saber se vai valer a pena antes de contratar."*

#### Persona 3 — Marcos Oliveira (Autônomo Local)

Marcos tem 42 anos e trabalha como eletricista autônomo há 15 anos em Itajaí. Nunca teve carteira assinada, sempre viveu de indicações. Tentou o GetNinjas mas desistiu quando percebeu que precisaria comprar moedas sem garantia de fechar serviço. Não tem portfólio, não tem CNPJ, recebe tudo em dinheiro ou PIX.

Nos meses fracos fica duas ou três semanas sem trabalho. Quer aparecer pra clientes que precisam de um eletricista agora, perto dele, sem pagar adiantado por lead.

> *"Meu serviço é bom, todo mundo que me chama volta. Mas como eu faço pra chegar em quem nunca me chamou?"*

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

Os requisitos estão organizados por módulo. Abaixo os principais de cada um:

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
- RF-012 — O sistema deve permitir que o freelancer aceite, recuse ou faça contra-proposta
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

> A lista completa com todos os 82 requisitos funcionais está em [`docs/requisitos-funcionais.md`](./requisitos-funcionais.md).

### 2.4 Requisitos Não Funcionais

- RNF-001 — A API deve responder em menos de 300ms para 95% das requisições em carga normal
- RNF-002 — O sistema deve ter uptime mínimo de 99,5% ao mês
- RNF-003 — Todas as senhas devem ser armazenadas com bcrypt (salt rounds ≥ 12)
- RNF-004 — Toda comunicação deve ser via HTTPS com TLS 1.2 ou superior
- RNF-005 — O sistema deve implementar rate limiting — máximo de 10 tentativas de login por IP em 5 minutos
- RNF-006 — O sistema deve validar e sanitizar 100% dos dados de entrada para prevenir injeção
- RNF-007 — CPF e dados bancários devem ser armazenados com criptografia AES-256
- RNF-008 — O sistema deve estar em plena conformidade com a LGPD desde o lançamento
- RNF-009 — Módulos críticos devem ter cobertura mínima de 70% de testes automatizados
- RNF-010 — A API deve ter documentação OpenAPI/Swagger atualizada a cada release

> A lista completa com todos os 40 requisitos não funcionais está em [`docs/requisitos-nao-funcionais.md`](./requisitos-nao-funcionais.md).

### 2.5 Regras de Negócio

As principais regras que o sistema deve respeitar independentemente da interface:

- Cada e-mail pode estar vinculado a no máximo uma conta na plataforma
- Contas não verificadas por e-mail podem visualizar serviços mas não podem contratar nem publicar
- Perfis de freelancer sem foto, bio e categoria preenchidas não aparecem nos resultados de busca
- O pagamento deve ser retido em escrow antes do início do serviço — o freelancer não começa sem garantia
- A taxa da plataforma é de 15% sobre o valor bruto da contratação, cobrada do freelancer
- O cliente tem 5 dias úteis para aprovar ou solicitar revisão após a entrega — depois disso a aprovação é automática
- Avaliações só podem ser feitas após uma contratação com status "Concluído" — sem avaliação falsa
- XP nunca é perdido por inatividade — o freelancer pode voltar sem perder a progressão
- O saque mínimo é de R$ 20,00 e o prazo é de até 1 dia útil via PIX

> A lista completa com todas as 75 regras de negócio está em [`docs/regras-de-negocio.md`](./regras-de-negocio.md).

### 2.6 Fora do Escopo

O MVP não inclui:

- Integração com outros gateways de pagamento além do MercadoPago
- App nativo separado para iOS e Android (o MVP usa React Native com Expo)
- Sistema de assinatura recorrente para clientes
- API pública para integrações externas
- Internacionalização — o MVP é focado no Brasil
- Modo offline no app mobile

---

## 3. Fluxos e Comportamento do Sistema

### 3.1 Fluxo Principal do Usuário

**Fluxo do cliente (contratação):**

```
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

**Fluxo do freelancer (execução):**

```
Recebe notificação de nova proposta
    → Analisa e aceita (ou negocia)
    → Executa o serviço
    → Registra a entrega (mensagem + arquivos)
    → Aguarda aprovação do cliente
    → Recebe o valor na carteira digital
    → Solicita saque via PIX
```

### 3.2 Fluxos Alternativos

**Cancelamento com reembolso:**
- Antes do aceite → reembolso total
- Em andamento com menos de 50% do prazo → reembolso de 50%
- Em andamento com 50% ou mais do prazo → sem reembolso
- Após entrega → sem reembolso, abre ticket de disputa

**Aprovação tácita:**
Se o cliente não se manifestar em 5 dias úteis após a entrega, o sistema aprova automaticamente e libera o pagamento ao freelancer.

**Disputa:**
Se prazo estourar sem entrega, o sistema cria ticket de suporte automaticamente com prioridade Alta e notifica as duas partes.

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

As telas foram desenvolvidas para desktop (largura base 1280px) com design responsivo.
A identidade visual adota verde profundo (#0D5C3A) como cor primária e âmbar (#F59E0B) como cor de destaque para elementos de gamificação.

**Tela 1 — Home do cliente (busca e descoberta)**

Tela principal após o login do cliente. Exibe saudação personalizada, campo de busca, categorias em pills horizontais e cards de serviços em destaque. Cards impulsionados recebem badge âmbar. Cada card exibe o nível do freelancer (Especialista, Mestre etc), nota e distância. Na barra superior fica o XP acumulado do usuário e a barra de missão ativa. Ranking local dos profissionais da categoria aparece na seção inferior.

<img width="1903" height="914" alt="image" src="https://github.com/user-attachments/assets/e5f904da-1c4a-4ced-9886-424faf3fda70" />



Ações disponíveis: buscar serviço, filtrar por categoria, acessar perfil do profissional, ver missão ativa.

---

**Tela 2 — Perfil do freelancer**

Exibida quando o cliente clica num profissional. Header em verde escuro com avatar, nome, headline, cidade, disponibilidade e nível em destaque. Barra de XP com progresso para o próximo nível e posição no ranking (#2 da cidade). Sidebar com botões de contratar e enviar mensagem, força do perfil (checklist do que falta preencher), badges com XP ganho em cada conquista e feed de últimos XP recebidos. Conteúdo principal com tabs (Sobre / Portfólio / Avaliações / Serviços). Missão ativa do freelancer aparece em destaque no topo do conteúdo — o cliente vê que o profissional está engajado.

<img width="1905" height="913" alt="image" src="https://github.com/user-attachments/assets/495008e3-42f4-44a8-b904-da680ad58a50" />


Ações disponíveis: contratar, enviar mensagem, ver portfólio, ler avaliações.

---

**Tela 3 — Dashboard do freelancer**

Tela central do freelancer após o login. Sidebar com nível, XP, sequência de dias e navegação. Área principal com 4 métricas (ganhos do mês, contratos ativos, nota média, XP da semana). Carteira em destaque com saldo disponível, saldo em escrow e botão de saque. Cards de contratos ativos com status colorido, missões ativas com barra de progresso, ranking local e feed de XP ganho. Cada ação que gerou XP aparece no feed com valor e data.

<img width="1903" height="913" alt="image" src="https://github.com/user-attachments/assets/4deb3e3e-fc5f-4f92-b802-ff3f3b183882" />


Ações disponíveis: ver contratos, acessar missões, ver ranking, sacar, navegar pelos módulos.

---

**Tela 4 — Chat**

Layout em duas colunas: lista de conversas à esquerda com status online, badge de não lidos e preview da última mensagem. Área de chat à direita com header do interlocutor (status online), barra do contrato ativo (nome, valor, status), histórico de mensagens com bolhas, card de proposta dentro do chat com botão de aceitar e pagar. Input com ícones de anexo e foto. Dica de XP no rodapé: "Responda em menos de 1h e ganhe +30 XP — missão ativa!"

<img width="1895" height="914" alt="image" src="https://github.com/user-attachments/assets/ef9326b1-4657-48d0-a359-9ab373741ad6" />


Ações disponíveis: enviar mensagem, anexar arquivo, aceitar proposta, ver contrato.

---

**Tela 5 — Pagamento**

Steps no topo mostrando o progresso (Proposta → Pagamento → Confirmação). Preview do freelancer com nota, badges e nível. Resumo do serviço contratado. Seleção de método de pagamento (PIX, cartão, boleto). Sidebar com XP ganho pela contratação (+20 XP), resumo financeiro com taxa explícita, CTA de pagamento e bloco "Por que é seguro" com checklist (escrow, avaliações verificadas, suporte em disputas, LGPD).

<img width="1914" height="904" alt="image" src="https://github.com/user-attachments/assets/77b46b66-66a2-4097-bd49-c5beb57d3524" />


Ações disponíveis: selecionar método, confirmar pagamento.

---

**Tela 6 — Conquistas e Gamificação**

Hero verde com nível, XP, barra de progresso e posição no ranking. Grid de badges conquistadas (4) e bloqueadas (2 com opacidade reduzida e meta visível). Cards de missões ativas com barra de progresso individual. Ranking local top 4 com destaque na linha do próprio usuário. Histórico de XP com cada ação que gerou pontos.

<img width="1913" height="909" alt="image" src="https://github.com/user-attachments/assets/8bbbf905-28e3-4631-86d8-c811ce79f21c" />


Ações disponíveis: ver detalhes de cada badge, acompanhar progresso das missões, ver ranking completo.

---

**Tela 7 — Landing page (visitante não logado)**

Navbar com links, botão de entrar e criar conta. Hero com título, subtítulo, dois CTAs (cliente e freelancer) e preview da plataforma mostrando cards reais de freelancers com nível e XP visíveis. Strip escuro com 6 diferenciais. Seção de como funciona em 3 passos com XP de recompensa em cada passo. Seção de gamificação em verde escuro com os 6 níveis e missões ao vivo. Seção comparativa com tabela de 8 critérios vs concorrentes. Depoimentos das 3 personas. CTA final em fundo escuro.

<img width="1897" height="913" alt="image" src="https://github.com/user-attachments/assets/efd4cfb4-7e0d-48d6-92f4-4266147f2caf" />


> O protótipo navegável deve ser construído no Figma a partir dos mockups acima. Os arquivos de referência estão em [`docs/wireframes.md`](./wireframes.md).

### 4.3 Fluxo de Interação do Usuário

Fluxo de contratação completo em 5 passos:

1. Cliente busca "eletricista" na home — vê cards com nota, nível e distância
2. Acessa o perfil do Marcos — lê avaliações verificadas e vê portfólio
3. Clica em "Contratar R$ 120" — preenche a descrição do que precisa
4. Confirma o pagamento via PIX — valor vai pra escrow
5. Marcos executa, registra a entrega, cliente aprova — pagamento liberado e ambos ganham XP

### 4.4 Feedback Inicial de Usuários

Após apresentar os mockups a 3 usuários (2 freelancers e 1 cliente):

> *"Ficou muito fácil de usar. Parece o iFood mesmo — procurei o serviço, vi o perfil, já quis contratar."*
> — C01, durante o teste da home e do perfil

> *"O dashboard ficou bem claro. Sei exatamente quanto ganhei e quantos contratos tenho abertos."*
> — F02, durante o teste do dashboard

> *"Esse negócio de XP e missão eu não entendia no começo. Mas depois que você explica faz sentido — é tipo um jogo."*
> — F05, durante o teste das conquistas

Os 3 ajustes identificados foram: botão de chat pouco visível no perfil, sistema de missões precisa de tooltip explicativo no primeiro acesso, e explicação inline sobre o que a taxa de 15% cobre.

---

## 5. Arquitetura do Sistema

### 5.1 Diagrama C4

#### Nível 1 — Diagrama de Contexto

O Escambo é o sistema central que recebe interações de três tipos de atores: clientes (pessoas físicas que contratam serviços), freelancers (profissionais que oferecem serviços) e administradores (equipe interna). O sistema se integra com três serviços externos: MercadoPago para processamento de pagamentos, Google OAuth2 para autenticação social e Cloudflare para CDN, proteção DDoS e SSL.

> <img width="738" height="567" alt="image" src="https://github.com/user-attachments/assets/cef76c90-5255-4a08-b1e4-01c2ceb5ac86" />


#### Nível 2 — Diagrama de Containers

O sistema é composto por cinco containers principais:

- Web App (React + Vite + TypeScript) — interface navegável para desktop
- Mobile App (React Native + Expo) — aplicativo iOS e Android
- API Backend (Node.js + Express + TypeScript) — núcleo da lógica de negócio
- MySQL 8 — banco de dados relacional com 48 tabelas
- DO Spaces — storage de arquivos compatível com S3 (imagens, portfólio, entregas)

Web App e Mobile App se comunicam com a API via HTTPS/JSON. A API se conecta ao banco MySQL, ao storage e aos serviços externos (MercadoPago, Cloudflare). O chat usa WebSocket (Socket.IO) para comunicação em tempo real.

> <img width="780" height="598" alt="image" src="https://github.com/user-attachments/assets/17074a4f-e888-4086-b669-5d05aa6f274e" />

#### Nível 3 — Diagrama de Componentes (API Backend)

A API é organizada em quatro camadas:

**Router + Middleware** — entrada de todas as requisições. Responsável por validação JWT, rate limiting e CORS.

**Controllers** — recebem as requisições roteadas e delegam para os services. Há um controller por módulo funcional (Auth, Profiles, Services, Contracts, Payments, Reviews, Chat, Gamification, Notifications, Support, Admin).

**Services** — contêm as regras de negócio. O AuthService cuida de JWT e bcrypt. O PaymentService implementa a lógica de escrow e integração com MercadoPago. O GamificationService calcula XP, verifica condições de badge e atualiza rankings.

**Repositories** — fazem o acesso ao banco de dados MySQL. Cada entidade principal tem seu próprio repository (UserRepository, ContractRepository, PaymentRepository etc).

> <img width="690" height="581" alt="image" src="https://github.com/user-attachments/assets/f02dee6f-726d-4b66-8549-84652a688674" />

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

> DDL completo com todas as tabelas em [`docs/modelagem-banco.md`](./modelagem-banco.md)

### 5.3 Principais Componentes

**Sistema de autenticação** — JWT stateless com refresh token, login social via OAuth2, verificação de e-mail, recuperação de senha, rate limiting por IP.

**Módulo de pagamentos** — integração com MercadoPago via webhook, lógica de escrow com liberação condicional, carteira digital por usuário, processamento de saques via PIX.

**Engine de gamificação** — cálculo de XP por evento (serviço concluído, avaliação recebida, missão cumprida), verificação automática de condições de badge, cálculo de ranking local por geolocalização.

**Sistema de chat** — WebSocket com Socket.IO, entrega garantida, histórico persistido no MySQL, notificações push integradas.

### 5.4 Stack Tecnológica

| Tecnologia | Por que foi escolhida |
|---|---|
| React + Vite | Stack que domino bem. Todos os meus projetos anteriores usam React — produtividade real supera qualquer vantagem teórica de mudar |
| React Native + Expo | Compartilha lógica com o frontend web, acelera o desenvolvimento mobile sem precisar aprender Swift ou Kotlin do zero |
| Node.js + Express + TypeScript | Performance de I/O, tipagem que evita bugs em runtime, ecossistema npm maduro pra todas as integrações necessárias |
| MySQL 8 | Os dados do Escambo são altamente relacionais — contratações, pagamentos e avaliações têm muitos relacionamentos. Banco relacional com transações ACID é a escolha certa aqui |
| MercadoPago | Maior cobertura no Brasil, PIX nativo, SDK bem documentado pra Node.js, suporte a escrow via marketplace |
| DigitalOcean | Melhor custo-benefício pra MVP, mais controle que PaaS como Heroku, escalonamento horizontal quando precisar |
| Cloudflare | CDN global gratuita no plano básico, DDoS protection, SSL automático sem configuração |

---

## 6. Segurança e Privacidade

Segurança não foi tratada como funcionalidade opcional — foi pensada como parte da arquitetura desde o início. As principais proteções implementadas seguem as diretrizes do OWASP Top 10:

- Injeção de SQL prevenida por queries parametrizadas e validação de schema em 100% das rotas
- Autenticação com JWT de curta duração (1h) + refresh token (7 dias) + encerramento de todas as sessões ao trocar senha
- Senhas com bcrypt, salt rounds 12 — nunca armazenadas em texto plano
- Rate limiting por IP nas rotas de autenticação — bloqueio após 5 tentativas em 5 minutos
- CPF e dados bancários com criptografia AES-256 no banco
- HTTPS obrigatório com TLS 1.2+ em toda comunicação
- CORS configurado para aceitar apenas origens autorizadas
- Audit log imutável de todas as ações financeiras e críticas

### 6.1 Privacidade e LGPD

O sistema está em conformidade com a Lei nº 13.709/2018 (LGPD) desde o primeiro dia:

**Dados coletados no cadastro:** apenas e-mail, senha e tipo de perfil — o mínimo necessário para criar a conta.

**Dados adicionais:** coletados somente quando necessários para funcionalidades específicas (CPF para funcionalidades financeiras, telefone para notificações SMS, localização para busca por proximidade).

**Como são armazenados:** dados sensíveis com criptografia AES-256. Senhas com bcrypt. Localização nunca armazenada em tempo real — apenas cidade e coordenadas aproximadas informadas pelo usuário.

**Direito ao esquecimento:** o usuário pode solicitar a exclusão de todos os dados pessoais a qualquer momento. O prazo para processamento é de 15 dias úteis. Dados financeiros e de auditoria são retidos pelo prazo legal mínimo exigido (5 anos) e depois anonimizados.

**Consentimento:** checkboxes separados e explícitos para Termos de Uso, Política de Privacidade e autorização de tratamento de dados pessoais. Checkboxes pré-marcados não são utilizados.

---

## 7. Planejamento do Projeto

| Marco | Descrição | Prazo |
|---|---|---|
| M1 | Documentação completa e aprovação da RFC pela banca | Mai/2026 |
| M2 | Setup do ambiente, CI/CD, módulos de autenticação e perfis | Jun/2026 |
| M3 | Módulo de contratações e pagamentos com escrow | Jul/2026 |
| M4 | Chat em tempo real, gamificação e notificações | Ago/2026 |
| M5 | MVP funcional, testes automatizados e ajustes de UX | Set/2026 |
| M6 | Deploy em produção, validação com usuários reais, coleta de feedback | Out/2026 |

---

## 8. Referências

- IBGE. **PNAD Contínua — Características adicionais do mercado de trabalho 2024**. Rio de Janeiro: IBGE, 2025. Disponível em: https://www.ibge.gov.br. Acesso em: abr. 2026.

- BRASIL. **Lei nº 13.709, de 14 de agosto de 2018** — Lei Geral de Proteção de Dados Pessoais (LGPD). Diário Oficial da União, Brasília, 2018.

- DETERDING, S. et al. From game design elements to gamefulness: Defining gamification. In: **Proceedings of the 15th International Academic MindTrek Conference**. ACM, 2011. p. 9–15.

- HAMARI, J.; KOIVISTO, J.; SARSA, H. Does Gamification Work? A Literature Review of Empirical Studies on Gamification. In: **Proceedings of the 47th Hawaii International Conference on System Sciences**. IEEE, 2014. p. 3025–3034.

- ROCHET, J. C.; TIROLE, J. Platform Competition in Two-Sided Markets. **Journal of the European Economic Association**, v. 1, n. 4, p. 990–1029, 2003.

- OWASP. **Top Ten 2021**. Open Web Application Security Project. Disponível em: https://owasp.org/Top10. Acesso em: abr. 2026.

- MERCADOPAGO. **Documentação da API MercadoPago**. Disponível em: https://www.mercadopago.com.br/developers. Acesso em: abr. 2026.

- BANCO CENTRAL DO BRASIL. **Estatísticas do PIX 2023–2024**. Brasília: BCB, 2024. Disponível em: https://www.bcb.gov.br. Acesso em: abr. 2026.

---

## 9. Apêndices

- **Apêndice A** — Modelagem completa do banco de dados: [`docs/modelagem-banco.md`](./modelagem-banco.md)
- **Apêndice B** — Lista completa de requisitos funcionais (82 RFs): [`docs/requisitos-funcionais.md`](./requisitos-funcionais.md)
- **Apêndice C** — Lista completa de requisitos não funcionais (40 RNFs): [`docs/requisitos-nao-funcionais.md`](./requisitos-nao-funcionais.md)
- **Apêndice D** — Regras de negócio (75 RNs): [`docs/regras-de-negocio.md`](./regras-de-negocio.md)
- **Apêndice E** — Personas detalhadas: [`docs/personas.md`](./personas.md)
- **Apêndice F** — Casos de uso completos: [`docs/casos-de-uso.md`](./casos-de-uso.md)
- **Apêndice G** — Benchmarking e estado da arte: [`docs/benchmarking.md`](./benchmarking.md)
- **Apêndice H** — Evidências de validação com usuários: [`docs/evidencias-validacao.md`](./evidencias-validacao.md)
- **Apêndice I** — Repositório público: https://github.com/Guirenzo/Escambo

---

## 10. Parecer do Comitê de Avaliação

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

*RFC — Escambo v2.0 — PAC Extensionista VII — Católica SC — 2026 — Guilherme Renzo*
