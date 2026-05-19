# RFC — Escambo: Plataforma Digital de Serviços Freelance

**Disciplina:** PAC Extensionista VII — Engenharia de Software  
**Instituição:** Católica SC  
**Autor:** Guilherme Renzo  
**Data:** 2026  
**Versão:** 2.0  
**Repositório:** https://github.com/Guirenzo/Escambo  
**Linha de projeto:** Plataforma Web + Mobile  
**Licença:** MIT

---

## 1. Visão do Produto

O nome Escambo vem de uma palavra antiga que significa troca. Escolhi esse nome porque é exatamente isso que a plataforma faz — conecta quem precisa de um serviço com quem sabe fazer, de forma direta, sem burocracia. Mas vai além de uma simples troca: a ideia é que as duas partes saiam ganhando, o cliente encontra o profissional certo rápido, e o freelancer tem uma ferramenta real pra crescer.

Sempre acreditei muito nessa ideia. Não só como projeto de TCC, mas como algo que tem espaço real no mercado. O que me motivou foi justamente essa contradição que a gente vê no dia a dia — vivemos num mundo onde qualquer coisa se resolve pelo celular em minutos, mas contratar um eletricista ou um designer freelancer ainda é uma bagunça. Você pede no grupo do WhatsApp, recebe uns cinco contatos, tenta agendar com cada um, não sabe se é confiável, paga adiantado e torce pra dar certo. Isso não faz sentido em 2026.

A minha visão pro Escambo é que ele seja uma mistura de iFood com Uber, mas voltado pra serviços. A simplicidade do iFood — você abre, escolhe, contrata — com a lógica do Uber de conectar prestador e cliente em tempo real, com avaliações e reputação construída dentro da plataforma. O que diferencia de tudo que existe hoje é a gamificação. A ideia de que o freelancer não só trabalha, mas progride — ganha XP, sobe de nível, conquista badges, aparece no ranking local. Isso cria um engajamento diferente, a pessoa quer voltar pra plataforma não só pra ganhar dinheiro, mas pra crescer dentro dela.

No mundo em que a IA está em tudo e muita gente acha que ficou fácil ganhar dinheiro, a realidade é que um número enorme de trabalhadores autônomos ainda tem dificuldade enorme pra se divulgar e encontrar clientes fora do círculo de indicações. O Escambo resolve isso de mão beijada — e ainda entrega uma experiência que nenhuma plataforma brasileira entrega hoje.

---

## 2. O Problema

### 2.1 Contexto

O mercado de trabalho autônomo no Brasil é gigante. Segundo o IBGE, são mais de 25 milhões de trabalhadores por conta própria — e esse número não para de crescer. Só que crescer em número não significa crescer em qualidade de vida ou em ferramentas de trabalho. A maioria desses profissionais ainda depende quase 100% de indicações pra conseguir clientes novos. Não têm portfólio digital, não têm histórico de avaliações, não têm controle financeiro. Trabalham no improviso.

Do outro lado, os clientes também sofrem. Contratar um serviço fora do círculo de conhecidos é uma experiência ruim na maioria das vezes. Você não sabe quem é a pessoa, não tem como verificar se ela entrega o que promete, paga adiantado sem garantia nenhuma e ainda corre o risco de ser deixado na mão no meio do caminho.

As plataformas que existem hoje não resolvem isso de verdade. O GetNinjas cobra do freelancer por cada lead que ele tenta contatar, sem nenhuma garantia de que vai fechar o serviço. Já usei R$ 60 em créditos sem fechar nada, me contaram. A Workana tem uma fila de espera que só termina se você pagar por um upgrade, e quando entra, a concorrência com quem cobra muito barato é brutal. Nenhuma das duas tem pagamento seguro pra serviços locais, nenhuma tem gamificação, nenhuma tem um dashboard decente pra o freelancer acompanhar o próprio crescimento.

### 2.2 Problema Central

O problema tem dois lados que se reforçam. O freelancer não consegue chegar em clientes novos sem depender de indicação, e o cliente não tem como confiar num profissional que não conhece sem ter alguma garantia. Esse ciclo trava o mercado. A plataforma certa quebra esse ciclo — cria reputação verificável pro freelancer e segurança real pro cliente.

### 2.3 Evidências da Demanda

Conversei com algumas pessoas durante a fase de pesquisa — eletricistas, desenvolvedores, diaristas, designers e clientes que já tentaram usar plataformas existentes. O padrão foi sempre o mesmo: quem oferece serviço quer visibilidade sem pagar adiantado por lead, e quem contrata quer ver avaliações reais e pagar com segurança.

Também observei grupos de WhatsApp locais de serviços na região de Itajaí. A dinâmica é sempre caótica — pedidos sem resposta, orçamentos jogados sem critério, zero possibilidade de comparar profissionais de forma justa. É um problema real, que acontece todo dia, e que uma plataforma bem feita resolve.

---

## 3. A Solução

O Escambo é uma plataforma web e mobile que conecta clientes a freelancers de qualquer área — de desenvolvimento de software a serviços domésticos — com foco em três pilares: confiança, simplicidade e engajamento.

**Confiança** vem do sistema de avaliações verificadas, vinculadas a contratos reais, e do pagamento em escrow — o dinheiro fica retido na plataforma até o serviço ser concluído e aprovado. Ninguém paga adiantado à toa e ninguém trabalha sem garantia de receber.

**Simplicidade** vem da interface. A referência de UX é o iFood — você encontra o que precisa em poucos toques, sem formulário de cadastro interminável, sem processo de aprovação que demora semanas. Isso foi uma decisão consciente desde o início do projeto.

**Engajamento** é onde o Escambo se diferencia de tudo que existe. O sistema de gamificação — XP, níveis, badges e missões semanais — transforma a experiência do freelancer. Ele não só trabalha, ele progride. Aparece no ranking local, conquista badges que ficam visíveis no perfil, sobe de nível. Isso cria um motivo pra voltar além do dinheiro.

### 3.1 Público-Alvo

O Escambo tem três perfis de usuário. O primeiro é o freelancer autônomo — desde o eletricista que depende de indicação até o desenvolvedor que já tentou a Workana e não ficou satisfeito. O segundo é o cliente pessoa física, que precisa de um serviço e quer contratar com segurança e agilidade. O terceiro é a empresa ou MEI que quer contratar freelancers de forma recorrente.

Não existe um perfil de usuário mais importante que o outro — a plataforma só funciona quando os dois lados crescem juntos. Por isso a estratégia de lançamento prevê recrutar freelancers ativamente antes de abrir pro público, pra garantir que o cliente já encontre profissionais quando chegar.

---

## 4. Objetivos

O objetivo geral do Escambo é simples: tornar a contratação de serviços tão fácil quanto pedir um lanche. Mas pra isso acontecer de verdade, alguns objetivos específicos precisam estar no MVP.

O mais básico é o fluxo completo de contratação funcionando — proposta, aceite, execução, entrega e avaliação. Sem isso nada faz sentido. Junto com isso, o sistema de pagamento via MercadoPago com escrow precisa estar sólido, porque é o que garante a confiança das duas partes.

Outros objetivos que fazem parte do MVP são o chat em tempo real entre cliente e freelancer, o dashboard do freelancer com ganhos e métricas, o sistema de gamificação com XP e badges, e a conformidade com a LGPD desde o primeiro dia — não como detalhe, mas como parte da arquitetura.

### 4.1 Indicadores de Sucesso

Vou considerar o MVP validado quando um ciclo completo de contratação — do primeiro acesso até a avaliação — puder ser feito sem erro, com pagamento processado e saldo creditado na carteira do freelancer. Além disso, o banco de dados precisa estar implementado com as 45+ tabelas mapeadas, e os requisitos funcionais e não funcionais documentados precisam estar cobertos na implementação.

---

## 5. Arquitetura e Stack

### 5.1 Por que essa stack

Escolhi React com Vite no frontend e React Native com Expo no mobile porque é a stack que trabalho há mais tempo. Todos os meus projetos anteriores foram feitos com essas ferramentas, então não faria sentido mudar agora — o ganho de produtividade de usar o que você conhece bem supera qualquer vantagem teórica de tentar algo novo no meio de um TCC. No futuro, dependendo de onde o projeto for, Python pode entrar no backend pra alguns módulos específicos de análise de dados, mas por enquanto Node com Express e TypeScript resolve bem.

A escolha do MySQL foi pela natureza relacional dos dados — contratações, pagamentos, avaliações e usuários têm muitos relacionamentos entre si, e um banco relacional lida com isso melhor do que NoSQL nesse caso. A infraestrutura na DigitalOcean com Cloudflare na frente resolve CDN, DDoS e SSL sem precisar de uma estrutura complexa.

O MercadoPago foi a escolha natural de gateway de pagamentos — maior cobertura no Brasil, suporte nativo a PIX, e documentação decente pra Node.

### 5.2 Visão da Arquitetura

O sistema é dividido em três camadas principais. O frontend web em React e o app mobile em React Native consomem a mesma API REST em Node.js, que se comunica com o banco MySQL e com os serviços externos — MercadoPago para pagamentos e o serviço de notificações push. O chat usa WebSocket pra comunicação em tempo real sem depender de polling.

```
[Web — React]  [Mobile — React Native]
        │               │
        └───────┬────────┘
                │
        [API — Node.js + Express + TypeScript]
                │
     ┌──────────┼──────────┐
     │          │          │
  [MySQL]  [MercadoPago] [WebSocket]
```

---

## 6. Módulos do Sistema

O sistema foi pensado em 14 módulos funcionais. Em vez de listar todos de forma seca, vou descrever os que considero mais críticos pro MVP e como eles se relacionam.

**Autenticação e Perfis** são a base de tudo. Sem um sistema de login sólido e perfis bem estruturados, nada mais funciona. O freelancer precisa ter um perfil que transmita confiança — foto, bio, portfólio, nota média, badges — e o cliente precisa conseguir visualizar tudo isso antes de contratar.

**Contratações** é o coração da plataforma. O fluxo vai de proposta → aceite → execução → entrega → avaliação, com histórico de status imutável em cada etapa. Cada mudança de status é registrada com quem fez, quando e por quê.

**Pagamentos** é o módulo que mais exige cuidado. O escrow — valor retido até a conclusão do serviço — é o que garante segurança pra ambos os lados. A integração com MercadoPago precisa ser robusta, com tratamento correto de falhas e retentativas automáticas.

**Gamificação** é o diferencial competitivo. XP por serviço concluído, níveis com nomes (Iniciante, Aprendiz, Profissional, Especialista, Mestre, Lenda), badges por conquistas e missões semanais com recompensas. O ranking local por categoria fecha o sistema, dando ao freelancer um motivo visual pra manter a qualidade.

**Chat** precisa ser em tempo real via WebSocket. A comunicação direta entre cliente e freelancer dentro da plataforma é o que evita que a negociação migre pro WhatsApp e a contratação acabe acontecendo fora do sistema.

Os demais módulos — notificações, suporte, impulsionamento, administração, LGPD e relatórios — completam o sistema mas têm menor criticidade pra validação do MVP.

---

## 7. Banco de Dados

O modelo de dados do Escambo tem 48 tabelas distribuídas entre os 14 módulos. A tabela `users` é o centro de tudo — dela derivam os perfis de cliente, freelancer e empresa. As contratações ficam na tabela `contracts`, com histórico de status em `contract_status_history`. Pagamentos têm rastreabilidade completa em `payments` e `wallets`. A gamificação tem seu próprio conjunto de tabelas — `user_xp`, `user_badges`, `missions` e `user_missions`.

A modelagem completa com DDL está em [`docs/modelagem-banco.md`](./modelagem-banco.md).

---

## 8. Requisitos

### 8.1 Funcionais

Os requisitos funcionais cobrem os 14 módulos do sistema. Os mais críticos pro MVP são os do fluxo de contratação e pagamento. Destaco alguns:

O sistema deve permitir que o cliente busque serviços por categoria, localização e faixa de preço. O freelancer deve poder cadastrar serviços com título, descrição, tipo de preço e prazo. A proposta de contratação deve passar pelos status de pendente, aceito, em andamento, entregue e concluído. O pagamento deve ficar retido em escrow até a aprovação da entrega pelo cliente. O sistema deve atribuir XP ao freelancer por serviços concluídos e avaliações recebidas.

A lista completa com todos os 82 requisitos funcionais está em [`docs/engenharia.md`](./engenharia.md).

### 8.2 Não Funcionais

Os requisitos não funcionais mais importantes pra mim são os de segurança e performance. A API precisa responder em menos de 300ms pra 95% das requisições. Senhas armazenadas com bcrypt, comunicação só via HTTPS, rate limiting nas rotas de autenticação. Conformidade total com a LGPD desde o lançamento — consentimento explícito no cadastro, direito ao esquecimento implementado, dados sensíveis criptografados.

---

## 9. Segurança e LGPD

Segurança não foi tratada como um módulo separado — foi pensada como parte da arquitetura desde o início. Todas as rotas autenticadas usam JWT com expiração de 1 hora. Refresh tokens têm vida de 7 dias. Após 5 tentativas de login com falha, o IP é bloqueado por 5 minutos.

Em relação à LGPD, o sistema coleta só o que precisa. No cadastro, apenas e-mail, senha e tipo de perfil. CPF e dados bancários só são pedidos quando necessários para funcionalidades financeiras, e ficam armazenados com criptografia AES-256. O usuário pode solicitar a exclusão dos dados a qualquer momento, com processamento em até 15 dias úteis.

---

## 10. Planejamento

| Marco | Descrição | Prazo |
|---|---|---|
| M1 | Documentação completa e aprovação da RFC | Mai/2026 |
| M2 | Setup do ambiente, autenticação e perfis | Jun/2026 |
| M3 | Módulo de contratações e pagamentos | Jul/2026 |
| M4 | Chat, gamificação e notificações | Ago/2026 |
| M5 | MVP funcional, testes e ajustes | Set/2026 |
| M6 | Deploy, validação com usuários reais | Out/2026 |

---

## 11. Considerações Finais

O Escambo é um projeto que acredito de verdade. Não só pelo potencial técnico, mas pelo impacto que pode ter — especialmente pra trabalhadores autônomos que hoje são invisíveis digitalmente. Um eletricista bom, um designer talentoso, uma diarista confiável — essas pessoas existem em todo lugar e não têm onde aparecer de forma justa e profissional.

A plataforma que quero construir resolve isso. E faz isso de um jeito que ninguém fez ainda no Brasil — com gamificação real, pagamento seguro, interface que qualquer pessoa consegue usar, e foco tanto em serviços digitais quanto em serviços locais e presenciais.

Esse é o Escambo.

---

## 12. Referências

- IBGE. **PNAD Contínua 2024**. Rio de Janeiro: IBGE, 2025.
- BRASIL. **Lei nº 13.709/2018** — Lei Geral de Proteção de Dados (LGPD).
- DETERDING, S. et al. From game design elements to gamefulness: Defining gamification. **ACM MindTrek**, 2011.
- ROCHET, J.C.; TIROLE, J. Platform Competition in Two-Sided Markets. **Journal of the European Economic Association**, 2003.
- OWASP. **Top Ten 2021**. Disponível em: https://owasp.org/Top10.
- MERCADOPAGO. **Documentação da API**. Disponível em: https://www.mercadopago.com.br/developers.
