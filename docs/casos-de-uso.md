# Casos de Uso — Escambo

> **Versão:** 1.0.0  
> **Disciplina:** PAC Extensionista VII — Católica SC  
> **Autor:** Guilherme Renzo 
> **Data:** 2026

---

## Índice

1. [Atores do Sistema](#1-atores-do-sistema)
2. [Diagrama de Casos de Uso](#2-diagrama-de-casos-de-uso)
3. [UC-01 — Cadastrar e Autenticar](#3-uc-01--cadastrar-e-autenticar)
4. [UC-02 — Gerenciar Perfil](#4-uc-02--gerenciar-perfil)
5. [UC-03 — Publicar e Gerenciar Serviço](#5-uc-03--publicar-e-gerenciar-serviço)
6. [UC-04 — Buscar e Contratar Serviço](#6-uc-04--buscar-e-contratar-serviço)
7. [UC-05 — Gerenciar Contratação](#7-uc-05--gerenciar-contratação)
8. [UC-06 — Realizar Pagamento](#8-uc-06--realizar-pagamento)
9. [UC-07 — Avaliar Serviço](#9-uc-07--avaliar-serviço)
10. [UC-08 — Usar o Chat](#10-uc-08--usar-o-chat)
11. [UC-09 — Acompanhar Gamificação](#11-uc-09--acompanhar-gamificação)
12. [UC-10 — Abrir Ticket de Suporte](#12-uc-10--abrir-ticket-de-suporte)
13. [UC-11 — Administrar a Plataforma](#13-uc-11--administrar-a-plataforma)
14. [Matriz de Rastreabilidade](#14-matriz-de-rastreabilidade)

---

## 1. Atores do Sistema

| Ator | Descrição |
|---|---|
| **Cliente** | Usuário que busca e contrata serviços na plataforma |
| **Freelancer** | Usuário que oferece e executa serviços |
| **Administrador** | Equipe interna que gerencia a plataforma |
| **MercadoPago** | Sistema externo de processamento de pagamentos |
| **Sistema de Notificações** | Serviço interno que dispara push, e-mail e SMS |

---

## 2. Diagrama de Casos de Uso

```
┌─────────────────────────────────────────────────────────────────┐
│                        ESCAMBO — Sistema                         │
│                                                                   │
│  ┌─────────────────┐      ┌──────────────────────────────────┐  │
│  │   UC-01         │      │   UC-03                          │  │
│  │   Cadastrar /   │      │   Publicar Serviço               │  │
│  │   Autenticar    │      │                                  │  │
│  └────────┬────────┘      │   UC-09                          │  │
│           │               │   Acompanhar Gamificação         │  │
│           │         ┌─────┤                                  │  │
│  ┌────────▼────────┐│     └──────────────────────────────────┘  │
│  │   UC-02         ││ Freelancer                                 │
│  │   Gerenciar     ││                                            │
│  │   Perfil        ││     ┌──────────────────────────────────┐  │
│  └─────────────────┘│     │   UC-04  Buscar Serviço          │  │
│                     │     │   UC-05  Gerenciar Contratação   │  │
│           ┌─────────┘     │   UC-06  Realizar Pagamento      │  │
│     Cliente│              │   UC-07  Avaliar Serviço         │  │
│           │               │   UC-08  Usar o Chat             │  │
│           └───────────────┤   UC-10  Abrir Ticket Suporte    │  │
│                           └──────────────────────────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  UC-11  Administrar Plataforma          [Administrador]  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [MercadoPago] ──── UC-06                                        │
│  [Notificações] ─── UC-05, UC-06, UC-07, UC-08                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. UC-01 — Cadastrar e Autenticar

| Campo | Detalhe |
|---|---|
| **ID** | UC-01 |
| **Nome** | Cadastrar e Autenticar |
| **Atores** | Cliente, Freelancer |
| **Pré-condição** | Usuário possui e-mail válido ou conta Google |
| **Pós-condição** | Usuário autenticado com sessão ativa |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Usuário acessa a plataforma
2. Seleciona "Criar conta"
3. Escolhe o tipo de perfil (Cliente / Freelancer / Empresa)
4. Preenche e-mail e senha  
   └── [Alternativa] Clica em "Entrar com Google"
5. Sistema envia e-mail de confirmação
6. Usuário confirma o e-mail
7. Sistema redireciona para completar o perfil
8. Usuário está autenticado
```

### Fluxos Alternativos
```
[FA-01] Login com Google
  1. Usuário clica em "Entrar com Google"
  2. Sistema redireciona para OAuth2 Google
  3. Google retorna token de autenticação
  4. Sistema cria ou recupera a conta vinculada
  5. Usuário é redirecionado ao dashboard

[FA-02] Recuperação de senha
  1. Usuário clica em "Esqueci minha senha"
  2. Informa o e-mail cadastrado
  3. Sistema envia link de redefinição
  4. Usuário acessa o link e define nova senha
  5. Sistema invalida o token após uso
```

### Fluxos de Exceção
```
[FE-01] E-mail já cadastrado
  → Sistema exibe mensagem: "Este e-mail já possui uma conta. Deseja entrar?"

[FE-02] Credenciais inválidas
  → Sistema exibe mensagem de erro genérica (sem revelar qual campo está errado)
  → Após 5 tentativas: bloqueia por 5 minutos (rate limiting)

[FE-03] Token de e-mail expirado
  → Sistema oferece reenvio do e-mail de confirmação
```

---

## 4. UC-02 — Gerenciar Perfil

| Campo | Detalhe |
|---|---|
| **ID** | UC-02 |
| **Nome** | Gerenciar Perfil |
| **Atores** | Cliente, Freelancer |
| **Pré-condição** | Usuário autenticado |
| **Pós-condição** | Perfil atualizado e visível na plataforma |
| **Prioridade** | Alta |

### Fluxo Principal — Freelancer
```
1. Freelancer acessa "Meu Perfil"
2. Preenche: nome, foto, bio, headline, cidade
3. Define disponibilidade (disponível / indisponível)
4. Adiciona itens ao portfólio (título, imagem, descrição)
5. Sistema salva e publica o perfil
6. Perfil aparece nos resultados de busca
```

### Fluxo Principal — Cliente
```
1. Cliente acessa "Meu Perfil"
2. Preenche: nome, foto, cidade
3. Sistema salva os dados
```

### Fluxos de Exceção
```
[FE-01] Foto com formato ou tamanho inválido
  → Sistema exibe orientação: "Use imagens JPG ou PNG com até 5MB"

[FE-02] Campos obrigatórios não preenchidos
  → Sistema bloqueia o salvamento e destaca os campos em vermelho
```

---

## 5. UC-03 — Publicar e Gerenciar Serviço

| Campo | Detalhe |
|---|---|
| **ID** | UC-03 |
| **Nome** | Publicar e Gerenciar Serviço |
| **Atores** | Freelancer |
| **Pré-condição** | Freelancer autenticado com perfil completo |
| **Pós-condição** | Serviço publicado e visível na busca |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Freelancer acessa "Meus Serviços" → "Novo Serviço"
2. Preenche: título, categoria, descrição
3. Define tipo de preço (fixo / por hora / negociável)
4. Informa prazo de entrega e modalidade (remoto / presencial)
5. Adiciona tags para melhorar a busca
6. Publica o serviço
7. Sistema exibe o serviço nos resultados de busca
```

### Fluxos Alternativos
```
[FA-01] Pausar serviço temporariamente
  1. Freelancer acessa o serviço ativo
  2. Clica em "Pausar"
  3. Serviço some dos resultados mas não é excluído

[FA-02] Editar serviço existente
  1. Freelancer acessa "Meus Serviços"
  2. Seleciona o serviço e clica em "Editar"
  3. Atualiza os campos desejados
  4. Sistema salva e republica
```

### Fluxos de Exceção
```
[FE-01] Título ou descrição muito curtos
  → Sistema exibe: "Descreva melhor o serviço para aumentar suas chances de contratação"

[FE-02] Categoria não selecionada
  → Sistema bloqueia publicação
```

---

## 6. UC-04 — Buscar e Contratar Serviço

| Campo | Detalhe |
|---|---|
| **ID** | UC-04 |
| **Nome** | Buscar e Contratar Serviço |
| **Atores** | Cliente |
| **Pré-condição** | Cliente autenticado |
| **Pós-condição** | Proposta de contratação enviada ao freelancer |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Cliente acessa a tela de busca
2. Seleciona categoria ou digita palavras-chave
3. Aplica filtros: localização, faixa de preço, nota mínima
4. Sistema exibe lista de serviços ranqueados por relevância e proximidade
   └── Serviços impulsionados aparecem em destaque no topo
5. Cliente acessa o perfil do freelancer
6. Visualiza: nota média, portfólio, avaliações, tempo de resposta
7. Clica em "Contratar"
8. Preenche: descrição do que precisa, prazo desejado
9. Sistema exibe o valor + taxa da plataforma de forma transparente
10. Cliente confirma e envia a proposta
11. Sistema notifica o freelancer
```

### Fluxos Alternativos
```
[FA-01] Nenhum resultado encontrado
  → Sistema sugere categorias próximas ou ampliar o raio de busca

[FA-02] Freelancer indisponível
  → Sistema exibe badge "Indisponível" no perfil
  → Cliente pode enviar mensagem mesmo assim
```

### Fluxos de Exceção
```
[FE-01] Cliente sem dados de pagamento cadastrados
  → Sistema redireciona para cadastrar método de pagamento antes de confirmar

[FE-02] Proposta duplicada
  → Sistema alerta: "Você já enviou uma proposta para este profissional recentemente"
```

---

## 7. UC-05 — Gerenciar Contratação

| Campo | Detalhe |
|---|---|
| **ID** | UC-05 |
| **Nome** | Gerenciar Contratação |
| **Atores** | Cliente, Freelancer, Sistema de Notificações |
| **Pré-condição** | Proposta de contratação enviada (UC-04) |
| **Pós-condição** | Contratação concluída ou cancelada com histórico registrado |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Freelancer recebe notificação de nova proposta
2. Analisa a proposta (descrição, prazo, valor)
3. Aceita a proposta
   └── [Alternativa] Recusa ou faz contra-proposta
4. Sistema muda status para "Em andamento"
5. Freelancer executa o serviço
6. Freelancer registra a entrega (mensagem + arquivos)
7. Sistema notifica o cliente
8. Cliente analisa a entrega
   ├── Aprova → status "Concluído" → pagamento liberado
   └── Solicita revisão → freelancer refaz e entrega novamente
9. Sistema registra o histórico completo
```

### Fluxos Alternativos
```
[FA-01] Freelancer faz contra-proposta
  1. Freelancer ajusta valor ou prazo e envia
  2. Cliente recebe notificação
  3. Cliente aceita, recusa ou negocia novamente

[FA-02] Cancelamento pelo cliente
  1. Cliente solicita cancelamento com motivo
  2. Sistema aplica política de reembolso conforme status
     ├── Antes do aceite → reembolso total
     ├── Em andamento → reembolso parcial (conforme regra configurada)
     └── Após entrega → sem reembolso (abre ticket de disputa)

[FA-03] Cancelamento pelo freelancer
  1. Freelancer cancela com justificativa
  2. Sistema reembolsa cliente integralmente
  3. Cancela impacta negativamente a reputação do freelancer
```

### Fluxos de Exceção
```
[FE-01] Prazo estourado sem entrega
  → Sistema notifica ambas as partes
  → Freelancer pode solicitar extensão de prazo com justificativa
  → Cliente pode aceitar ou abrir disputa

[FE-02] Disputa aberta
  → Ticket de suporte criado automaticamente (UC-10)
  → Administrador intervém e emite resolução vinculante
```

---

## 8. UC-06 — Realizar Pagamento

| Campo | Detalhe |
|---|---|
| **ID** | UC-06 |
| **Nome** | Realizar Pagamento |
| **Atores** | Cliente, MercadoPago, Sistema de Notificações |
| **Pré-condição** | Proposta aceita pelo freelancer (UC-05) |
| **Pós-condição** | Pagamento retido em escrow ou liberado ao freelancer |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Cliente confirma a contratação
2. Sistema exibe resumo: valor do serviço + taxa da plataforma
3. Cliente escolhe método de pagamento (PIX / cartão / boleto)
4. Sistema redireciona para MercadoPago
5. MercadoPago processa e confirma o pagamento
6. Sistema retém o valor em escrow (carteira da plataforma)
7. Sistema notifica cliente (pagamento confirmado) e freelancer (serviço pode começar)
8. Freelancer conclui e entrega o serviço
9. Cliente aprova a entrega
10. Sistema libera o valor líquido para a carteira do freelancer
11. Plataforma retém a taxa de comissão
```

### Fluxos Alternativos
```
[FA-01] Saque do freelancer
  1. Freelancer acessa "Carteira" → "Sacar"
  2. Informa chave PIX ou dados bancários
  3. Sistema valida saldo disponível
  4. Processa o saque no prazo configurado (ex: D+1)
  5. Freelancer recebe o valor na conta

[FA-02] Reembolso ao cliente
  1. Contratação cancelada antes da conclusão
  2. Sistema inicia processo de reembolso via MercadoPago
  3. Cliente recebe o valor de volta no método original de pagamento
```

### Fluxos de Exceção
```
[FE-01] Falha no processamento pelo gateway
  → Sistema tenta automaticamente até 3 vezes
  → Se persistir, notifica o cliente para tentar outro método

[FE-02] Saldo insuficiente na carteira para saque
  → Sistema exibe saldo disponível e valor mínimo de saque
```

---

## 9. UC-07 — Avaliar Serviço

| Campo | Detalhe |
|---|---|
| **ID** | UC-07 |
| **Nome** | Avaliar Serviço |
| **Atores** | Cliente, Freelancer |
| **Pré-condição** | Contratação com status "Concluído" |
| **Pós-condição** | Avaliação publicada e nota média do freelancer atualizada |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Sistema notifica cliente após conclusão: "Como foi seu serviço com [Nome]?"
2. Cliente acessa a avaliação
3. Seleciona nota de 1 a 5 estrelas
4. Escreve comentário (opcional)
5. Confirma e publica a avaliação
6. Sistema recalcula a nota média do freelancer em tempo real
7. Avaliação aparece no perfil público do freelancer
8. Sistema atribui XP ao freelancer (módulo de gamificação)
```

### Fluxos Alternativos
```
[FA-01] Freelancer responde à avaliação
  1. Freelancer acessa a avaliação recebida
  2. Escreve resposta pública
  3. Sistema publica a resposta abaixo do comentário do cliente

[FA-02] Cliente não avalia em 7 dias
  → Sistema encerra o prazo de avaliação automaticamente
  → Contratação permanece como "Concluída" sem avaliação
```

### Fluxos de Exceção
```
[FE-01] Tentativa de avaliar sem contratação concluída
  → Sistema bloqueia: avaliações só são permitidas após conclusão confirmada

[FE-02] Avaliação com conteúdo inapropriado
  → Sistema detecta via filtro de conteúdo
  → Avaliação vai para moderação antes de ser publicada
```

---

## 10. UC-08 — Usar o Chat

| Campo | Detalhe |
|---|---|
| **ID** | UC-08 |
| **Nome** | Usar o Chat |
| **Atores** | Cliente, Freelancer, Sistema de Notificações |
| **Pré-condição** | Usuários autenticados com contato iniciado |
| **Pós-condição** | Mensagens entregues e histórico registrado |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Cliente acessa o perfil do freelancer
2. Clica em "Enviar mensagem"
3. Sistema cria ou recupera a conversa entre os dois
4. Cliente digita e envia mensagem de texto
5. Sistema entrega a mensagem em tempo real via WebSocket
6. Freelancer recebe push notification
7. Freelancer responde
8. Histórico fica salvo e acessível a qualquer momento
```

### Fluxos Alternativos
```
[FA-01] Envio de arquivo ou imagem
  1. Usuário clica no ícone de anexo
  2. Seleciona o arquivo (imagem, PDF, etc.)
  3. Sistema faz upload e exibe na conversa

[FA-02] Usuário offline
  → Mensagem é entregue assim que o usuário reconectar
  → Push notification é enviado imediatamente
```

### Fluxos de Exceção
```
[FE-01] Arquivo muito grande
  → Sistema exibe: "Arquivo deve ter no máximo 10MB"

[FE-02] Tentativa de mensagem em contrato cancelado
  → Sistema exibe: "Esta conversa está encerrada"
```

---

## 11. UC-09 — Acompanhar Gamificação

| Campo | Detalhe |
|---|---|
| **ID** | UC-09 |
| **Nome** | Acompanhar Gamificação |
| **Atores** | Freelancer |
| **Pré-condição** | Freelancer autenticado |
| **Pós-condição** | Freelancer visualiza progresso e conquistas |
| **Prioridade** | Média |

### Fluxo Principal
```
1. Freelancer acessa "Conquistas" no dashboard
2. Sistema exibe:
   ├── XP total acumulado e barra de progresso para o próximo nível
   ├── Nível atual (ex: "Nível 3 — Profissional")
   ├── Badges conquistadas e bloqueadas (com dica para desbloquear)
   └── Missões ativas com progresso e recompensa
3. Freelancer seleciona uma missão
4. Sistema exibe detalhes: o que fazer, quanto falta, prazo
5. Freelancer conclui a missão ao atingir o objetivo
6. Sistema atribui XP e exibe animação de conquista
7. Sistema verifica se novo nível foi atingido
   └── Se sim: notifica e atualiza o badge de nível no perfil
```

### Fluxos de Exceção
```
[FE-01] Missão expirada
  → Sistema remove a missão e oferece novas para o próximo ciclo

[FE-02] XP insuficiente para subir de nível
  → Barra de progresso mostra quanto falta
```

---

## 12. UC-10 — Abrir Ticket de Suporte

| Campo | Detalhe |
|---|---|
| **ID** | UC-10 |
| **Nome** | Abrir Ticket de Suporte |
| **Atores** | Cliente, Freelancer, Administrador |
| **Pré-condição** | Usuário autenticado |
| **Pós-condição** | Ticket registrado e em atendimento |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Usuário acessa "Suporte" no menu
2. Clica em "Abrir chamado"
3. Seleciona categoria (pagamento, disputa, conta, fraude, outro)
4. Preenche assunto e descrição detalhada
5. Vincula a uma contratação (opcional)
6. Envia o ticket
7. Sistema confirma recebimento e atribui número de protocolo
8. Administrador recebe e atende o ticket
9. Troca de mensagens dentro do ticket até resolução
10. Administrador marca como "Resolvido"
11. Sistema notifica o usuário
```

### Fluxos de Exceção
```
[FE-01] Disputa financeira sem contratação vinculada
  → Sistema solicita que o usuário vincule o ticket a uma contratação

[FE-02] Ticket duplicado detectado
  → Sistema alerta: "Você já tem um chamado aberto sobre este assunto"
```

---

## 13. UC-11 — Administrar a Plataforma

| Campo | Detalhe |
|---|---|
| **ID** | UC-11 |
| **Nome** | Administrar a Plataforma |
| **Atores** | Administrador |
| **Pré-condição** | Administrador autenticado com perfil admin |
| **Pós-condição** | Ações administrativas registradas em audit log |
| **Prioridade** | Alta |

### Fluxo Principal
```
1. Administrador acessa o painel admin
2. Visualiza dashboard com métricas em tempo real:
   ├── Novos usuários do dia
   ├── Contratações ativas
   ├── Receita da plataforma
   └── Tickets abertos por prioridade
3. Seleciona a ação desejada:
   ├── Gerenciar usuários (suspender, banir, reativar)
   ├── Resolver disputas (acessar tickets e emitir resolução)
   ├── Gerenciar configurações (taxa, prazo de saque, manutenção)
   └── Visualizar relatórios e exportar dados
4. Realiza a ação
5. Sistema registra em audit_log: admin, ação, alvo, timestamp, IP
```

---

## 14. Matriz de Rastreabilidade

Relaciona cada Caso de Uso com os Requisitos Funcionais e as Personas correspondentes.

| Caso de Uso | Requisitos Funcionais | Persona Principal |
|---|---|---|
| UC-01 — Autenticar | RF-001 a RF-010 | Rafael, Camila, Marcos |
| UC-02 — Gerenciar Perfil | RF-011 a RF-020 | Rafael, Marcos |
| UC-03 — Publicar Serviço | RF-021 a RF-030 | Rafael, Marcos |
| UC-04 — Buscar e Contratar | RF-025 a RF-031 | Camila |
| UC-05 — Gerenciar Contratação | RF-031 a RF-040 | Rafael, Camila, Marcos |
| UC-06 — Realizar Pagamento | RF-041 a RF-050 | Camila (paga), Rafael e Marcos (recebem) |
| UC-07 — Avaliar Serviço | RF-051 a RF-056 | Camila (avalia), Rafael e Marcos (são avaliados) |
| UC-08 — Usar o Chat | RF-057 a RF-062 | Rafael, Camila, Marcos |
| UC-09 — Gamificação | RF-063 a RF-068 | Rafael, Marcos |
| UC-10 — Suporte | RF-071 a RF-073 | Rafael, Camila, Marcos |
| UC-11 — Admin | RF-076 a RF-078 | Administrador |

---

<div align="center">

*casos-de-uso.md — Escambo v1.0.0 — NP2 — PAC Extensionista VII — Católica SC — 2026*

</div>
