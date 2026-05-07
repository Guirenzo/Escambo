# Requisitos Não Funcionais — Escambo

> **Versão:** 1.0.0  
> **Total de Requisitos:** 40  
> **Atualizado em:** Abril de 2026  
> **Autor:** [Seu Nome]

---

## Legenda

| Campo | Descrição |
|---|---|
| **ID** | Identificador único do requisito |
| **Categoria** | Classificação do atributo de qualidade |
| **Descrição** | O que o sistema deve garantir |
| **Métrica** | Como será medido / verificado |
| **Prioridade** | `Alta` / `Média` / `Baixa` |

---

## Categorias Cobertas

```
Performance       → tempo de resposta, throughput, carga
Disponibilidade   → uptime, recuperação de falhas
Segurança         → autenticação, criptografia, proteção de dados
Escalabilidade    → crescimento horizontal e vertical
Usabilidade       → fluidez, acessibilidade, experiência
Manutenibilidade  → testabilidade, legibilidade, documentação
Conformidade      → LGPD, normas, rastreabilidade
Confiabilidade    → integridade de dados, tratamento de erros
```

---

## Performance

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-001 | A API deve responder requisições em tempo adequado sob carga normal | P95 ≤ 300ms para endpoints de leitura | Alta |
| RNF-002 | A API deve responder requisições de escrita (contratação, pagamento) em tempo adequado | P95 ≤ 500ms para endpoints de escrita | Alta |
| RNF-003 | O app mobile deve atingir boa pontuação de performance no Lighthouse | Score ≥ 85 no Lighthouse Mobile | Alta |
| RNF-004 | A busca de serviços deve retornar resultados rapidamente mesmo com grande volume de dados | Resultados em ≤ 400ms com 100k registros | Alta |
| RNF-005 | O sistema de chat deve entregar mensagens em tempo real | Latência de entrega ≤ 500ms via WebSocket | Alta |
| RNF-006 | Imagens e assets estáticos devem ser servidos com cache e compressão | Cache-Control configurado + imagens em WebP | Média |

---

## Disponibilidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-007 | A plataforma deve ter alta disponibilidade em produção | Uptime ≥ 99,5% ao mês (≤ 3,6h de downtime/mês) | Alta |
| RNF-008 | O sistema deve se recuperar automaticamente de falhas transitórias | Health checks com restart automático via processo supervisor | Alta |
| RNF-009 | O banco de dados deve ter backup automático diário | Backups diários com retenção mínima de 7 dias | Alta |
| RNF-010 | O sistema deve exibir página de manutenção clara quando estiver indisponível | Página estática de status com previsão de retorno | Média |

---

## Segurança

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-011 | Todas as senhas devem ser armazenadas com hashing seguro | bcrypt com salt rounds ≥ 12 | Alta |
| RNF-012 | Toda comunicação entre cliente e servidor deve ser criptografada | HTTPS obrigatório com TLS 1.2+ (preferencial TLS 1.3) | Alta |
| RNF-013 | Tokens de acesso devem ter tempo de vida curto | JWT com expiração de 1h; refresh token com 7 dias | Alta |
| RNF-014 | O sistema deve implementar rate limiting para prevenir abuso e ataques de força bruta | Máximo de 10 tentativas de login por IP em 5 minutos | Alta |
| RNF-015 | O sistema deve validar e sanitizar todos os dados de entrada para prevenir injeção | Validação via schema (Zod/Joi) em 100% das rotas | Alta |
| RNF-016 | O sistema deve implementar proteção contra CSRF nas rotas autenticadas | Tokens CSRF ou uso exclusivo de JWT no header Authorization | Alta |
| RNF-017 | Dados sensíveis (CPF, dados bancários) devem ser armazenados com criptografia adicional | AES-256 para campos sensíveis no banco | Alta |
| RNF-018 | O sistema deve registrar tentativas de acesso não autorizado | Log de erros 401/403 com IP e timestamp | Alta |
| RNF-019 | A plataforma deve utilizar CDN com proteção contra DDoS | Cloudflare com WAF ativado | Alta |
| RNF-020 | Segredos e variáveis de ambiente nunca devem estar no repositório | Uso de `.env` + secrets manager; `.gitignore` validado | Alta |

---

## Escalabilidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-021 | A arquitetura do backend deve ser modular e permitir extração futura de microsserviços | Módulos isolados com responsabilidade única | Alta |
| RNF-022 | O banco de dados deve suportar crescimento sem degradação significativa de performance | Índices em todas as FKs e colunas de busca; explain plan validado | Alta |
| RNF-023 | O sistema deve suportar múltiplas conexões simultâneas de WebSocket sem degradação | Pool de conexões configurado; teste com ≥ 500 conexões simultâneas | Média |
| RNF-024 | A infraestrutura deve permitir escalonamento horizontal da API | Deploy stateless; sessões em Redis ou JWT (sem server-side session) | Média |

---

## Usabilidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-025 | O fluxo de contratação deve ser concluído com poucas interações | Máximo de 5 telas/interações do início ao envio da proposta | Alta |
| RNF-026 | A interface web deve ser responsiva para diferentes tamanhos de tela | Compatível com desktop, tablet e mobile (≥ 320px de largura) | Alta |
| RNF-027 | O app mobile deve funcionar nos sistemas operacionais mais utilizados | iOS 14+ e Android 10+ | Alta |
| RNF-028 | Mensagens de erro devem ser claras, contextuais e orientadas à ação do usuário | Nenhuma mensagem técnica exposta ao usuário final | Alta |
| RNF-029 | A interface web deve respeitar diretrizes mínimas de acessibilidade | Nível AA do WCAG 2.1 (contraste, navegação por teclado, ARIA) | Média |

---

## Manutenibilidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-030 | Os módulos críticos do sistema devem ter cobertura mínima de testes automatizados | ≥ 70% de cobertura nos módulos de autenticação, pagamentos e contratações | Alta |
| RNF-031 | A API deve ter documentação atualizada e acessível | OpenAPI/Swagger publicado e atualizado a cada release | Alta |
| RNF-032 | O código deve seguir padrões de estilo definidos e verificados automaticamente | ESLint + Prettier configurados com CI bloqueando PRs com erros | Alta |
| RNF-033 | O projeto deve ter pipeline de CI/CD automatizado | GitHub Actions com build, lint e testes em cada Pull Request | Média |
| RNF-034 | Variáveis de configuração devem ser externalizadas do código | 100% das configs via variáveis de ambiente | Alta |

---

## Conformidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-035 | O sistema deve estar em conformidade com a Lei Geral de Proteção de Dados | Consentimento explícito, direito ao esquecimento e política de privacidade publicada | Alta |
| RNF-036 | Todas as ações financeiras devem ser auditáveis | Log imutável de cada transação com valor, partes, timestamp e status | Alta |
| RNF-037 | O sistema deve manter logs de auditoria de ações críticas por período mínimo | Logs retidos por no mínimo 90 dias | Média |
| RNF-038 | O sistema deve garantir integridade transacional em operações financeiras | Uso de transações MySQL (BEGIN/COMMIT/ROLLBACK) em pagamentos e saques | Alta |

---

## Confiabilidade

| ID | Descrição | Métrica | Prioridade |
|---|---|---|---|
| RNF-039 | O sistema deve tratar erros inesperados sem expor stack traces ao usuário | Try/catch global com resposta padronizada em formato JSON | Alta |
| RNF-040 | O sistema deve ter monitoramento de erros em produção | Integração com ferramenta de APM/error tracking (ex: Sentry) | Média |

---

## Resumo por Categoria

| Categoria | Total | Alta | Média | Baixa |
|---|---|---|---|---|
| Performance | 6 | 5 | 1 | 0 |
| Disponibilidade | 4 | 3 | 1 | 0 |
| Segurança | 10 | 10 | 0 | 0 |
| Escalabilidade | 4 | 2 | 2 | 0 |
| Usabilidade | 5 | 4 | 1 | 0 |
| Manutenibilidade | 5 | 4 | 1 | 0 |
| Conformidade | 4 | 3 | 1 | 0 |
| Confiabilidade | 2 | 1 | 1 | 0 |
| **Total** | **40** | **32** | **8** | **0** |

> ℹ️ O total final ficou em **40 requisitos não funcionais**, superando os 36 planejados inicialmente — resultado do detalhamento das categorias de segurança e confiabilidade durante a especificação.

---

## Rastreabilidade com Requisitos Funcionais

Os RNFs se aplicam de forma transversal a todos os módulos, mas os mais críticos se relacionam diretamente com os seguintes RFs:

| RNF | RFs Relacionados | Justificativa |
|---|---|---|
| RNF-011, RNF-012, RNF-013 | RF-001 a RF-010 | Segurança da autenticação |
| RNF-001, RNF-002 | RF-031 a RF-040 | Performance no fluxo de contratação |
| RNF-036, RNF-038 | RF-041 a RF-050 | Integridade e auditoria de pagamentos |
| RNF-035, RNF-037 | RF-079, RF-080 | Conformidade com LGPD |
| RNF-005 | RF-057 a RF-062 | Performance do chat em tempo real |
| RNF-025, RNF-026 | RF-031, RF-041 | Usabilidade no fluxo crítico |

---

<div align="center">

*requisitos-nao-funcionais.md — Escambo v1.0.0 — PAC Extensionista VII — Católica SC — 2026*

</div>
