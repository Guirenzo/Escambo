# Modelagem do Banco de Dados — Escambo

> **Versão:** 1.0.0  
> **SGBD:** MySQL 8.0+  
> **Encoding:** utf8mb4 / utf8mb4_unicode_ci  
> **Total de tabelas:** 48  
> **Atualizado em:** Abril de 2026

---

## Índice

1. [Convenções e Padrões](#1-convenções-e-padrões)
2. [Diagrama de Entidades (ERD Textual)](#2-diagrama-de-entidades-erd-textual)
3. [Módulo 01 — Autenticação](#3-módulo-01--autenticação)
4. [Módulo 02 — Perfis](#4-módulo-02--perfis)
5. [Módulo 03 — Categorias e Serviços](#5-módulo-03--categorias-e-serviços)
6. [Módulo 04 — Contratações](#6-módulo-04--contratações)
7. [Módulo 05 — Pagamentos](#7-módulo-05--pagamentos)
8. [Módulo 06 — Avaliações](#8-módulo-06--avaliações)
9. [Módulo 07 — Chat](#9-módulo-07--chat)
10. [Módulo 08 — Gamificação](#10-módulo-08--gamificação)
11. [Módulo 09 — Notificações](#11-módulo-09--notificações)
12. [Módulo 10 — Suporte e Mediação](#12-módulo-10--suporte-e-mediação)
13. [Módulo 11 — Impulsionamento](#13-módulo-11--impulsionamento)
14. [Módulo 12 — Administração](#14-módulo-12--administração)
15. [Módulo 13 — Compliance / LGPD](#15-módulo-13--compliance--lgpd)
16. [Módulo 14 — Relatórios](#16-módulo-14--relatórios)

---

## 1. Convenções e Padrões

| Convenção | Padrão adotado |
|---|---|
| Nomenclatura de tabelas | `snake_case`, plural (ex: `users`, `service_categories`) |
| Chave primária | `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY` |
| Chaves estrangeiras | `{tabela_referenciada_singular}_id` (ex: `user_id`, `service_id`) |
| Timestamps | Todas as tabelas possuem `created_at` e `updated_at` |
| Soft delete | Tabelas críticas possuem `deleted_at` (nullable) |
| Enums | Definidos diretamente no MySQL via `ENUM(...)` |
| Valores monetários | `DECIMAL(10, 2)` — nunca `FLOAT` |
| UUIDs externos | `VARCHAR(36)` para IDs de gateways externos |
| Índices | Criados em todas as FK e colunas de busca frequente |

---

## 2. Diagrama de Entidades (ERD Textual)

```
users (base)
 ├── user_social_logins      (OAuth2 providers)
 ├── user_sessions           (tokens ativos)
 ├── profiles_client         (1:1)
 ├── profiles_freelancer     (1:1)
 │    └── freelancer_portfolio_items
 ├── profiles_company        (1:1)
 │
 ├── contracts               (cliente contrata freelancer)
 │    ├── contract_status_history
 │    └── deliveries
 │
 ├── payments                (transações)
 │    ├── wallets            (1:1 por user)
 │    └── withdrawals
 │
 ├── reviews                 (avaliação pós-serviço)
 │    └── review_responses
 │
 ├── conversations           (chat)
 │    └── messages
 │
 ├── user_xp                 (gamificação)
 ├── user_badges
 ├── user_missions
 │
 ├── notifications
 ├── support_tickets
 │    └── support_ticket_messages
 │
 ├── boosts                  (impulsionamento)
 ├── lgpd_consents
 └── audit_logs

services
 ├── service_categories      (taxonomia)
 ├── service_tags
 └── service_tag_pivot

badges                        (catálogo)
missions                      (catálogo)
boost_plans                   (planos disponíveis)
platform_settings             (admin)
report_snapshots              (relatórios)
```

---

## 3. Módulo 01 — Autenticação

### `users`
Tabela central de todos os usuários da plataforma.

```sql
CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ulid          VARCHAR(26)     NOT NULL UNIQUE,           -- ID público (ULID)
  email         VARCHAR(255)    NOT NULL UNIQUE,
  phone         VARCHAR(20)     NULL,
  password_hash VARCHAR(255)    NULL,                      -- NULL se login social
  role          ENUM('client', 'freelancer', 'company', 'admin') NOT NULL DEFAULT 'client',
  status        ENUM('active', 'suspended', 'banned', 'pending_verification') NOT NULL DEFAULT 'pending_verification',
  email_verified_at DATETIME    NULL,
  phone_verified_at DATETIME    NULL,
  last_login_at     DATETIME    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME        NULL,

  PRIMARY KEY (id),
  INDEX idx_users_email   (email),
  INDEX idx_users_role    (role),
  INDEX idx_users_status  (status),
  INDEX idx_users_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `user_social_logins`
Vínculos de login social (Google, Facebook etc).

```sql
CREATE TABLE user_social_logins (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  provider    ENUM('google', 'facebook', 'apple') NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  token       TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_social_provider (provider, provider_id),
  INDEX idx_social_user (user_id),
  CONSTRAINT fk_social_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `user_sessions`
Sessões ativas com refresh tokens.

```sql
CREATE TABLE user_sessions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  refresh_token VARCHAR(512)    NOT NULL UNIQUE,
  ip_address    VARCHAR(45)     NULL,
  user_agent    VARCHAR(512)    NULL,
  expires_at    DATETIME        NOT NULL,
  revoked_at    DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_sessions_user    (user_id),
  INDEX idx_sessions_token   (refresh_token),
  INDEX idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `password_reset_tokens`

```sql
CREATE TABLE password_reset_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token      VARCHAR(255)    NOT NULL UNIQUE,
  expires_at DATETIME        NOT NULL,
  used_at    DATETIME        NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_prt_user    (user_id),
  INDEX idx_prt_token   (token),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 4. Módulo 02 — Perfis

### `profiles_client`

```sql
CREATE TABLE profiles_client (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL UNIQUE,
  full_name    VARCHAR(150)    NOT NULL,
  avatar_url   VARCHAR(512)    NULL,
  bio          TEXT            NULL,
  city         VARCHAR(100)    NULL,
  state        CHAR(2)         NULL,
  latitude     DECIMAL(10, 8)  NULL,
  longitude    DECIMAL(11, 8)  NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pc_user     (user_id),
  INDEX idx_pc_location (latitude, longitude),
  CONSTRAINT fk_pc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `profiles_freelancer`

```sql
CREATE TABLE profiles_freelancer (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             BIGINT UNSIGNED NOT NULL UNIQUE,
  full_name           VARCHAR(150)    NOT NULL,
  avatar_url          VARCHAR(512)    NULL,
  bio                 TEXT            NULL,
  headline            VARCHAR(255)    NULL,             -- ex: "Dev Full Stack | 5 anos de exp."
  city                VARCHAR(100)    NULL,
  state               CHAR(2)         NULL,
  latitude            DECIMAL(10, 8)  NULL,
  longitude           DECIMAL(11, 8)  NULL,
  avg_rating          DECIMAL(3, 2)   NOT NULL DEFAULT 0.00,
  total_reviews       INT UNSIGNED    NOT NULL DEFAULT 0,
  total_contracts     INT UNSIGNED    NOT NULL DEFAULT 0,
  response_time_hours INT UNSIGNED    NULL,             -- tempo médio de resposta
  is_available        TINYINT(1)      NOT NULL DEFAULT 1,
  cpf_verified        TINYINT(1)      NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pf_user      (user_id),
  INDEX idx_pf_rating    (avg_rating),
  INDEX idx_pf_location  (latitude, longitude),
  INDEX idx_pf_available (is_available),
  CONSTRAINT fk_pf_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `freelancer_portfolio_items`

```sql
CREATE TABLE freelancer_portfolio_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  freelancer_id BIGINT UNSIGNED NOT NULL,              -- FK para profiles_freelancer.id
  title         VARCHAR(150)    NOT NULL,
  description   TEXT            NULL,
  image_url     VARCHAR(512)    NULL,
  external_url  VARCHAR(512)    NULL,
  sort_order    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_portfolio_freelancer (freelancer_id),
  CONSTRAINT fk_portfolio_freelancer FOREIGN KEY (freelancer_id) REFERENCES profiles_freelancer(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `profiles_company`

```sql
CREATE TABLE profiles_company (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL UNIQUE,
  company_name VARCHAR(150)    NOT NULL,
  cnpj         VARCHAR(18)     NULL UNIQUE,
  logo_url     VARCHAR(512)    NULL,
  bio          TEXT            NULL,
  website      VARCHAR(255)    NULL,
  city         VARCHAR(100)    NULL,
  state        CHAR(2)         NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pco_user (user_id),
  CONSTRAINT fk_pco_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 5. Módulo 03 — Categorias e Serviços

### `service_categories`

```sql
CREATE TABLE service_categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id   BIGINT UNSIGNED NULL,                    -- NULL = categoria raiz
  name        VARCHAR(100)    NOT NULL,
  slug        VARCHAR(120)    NOT NULL UNIQUE,
  icon_url    VARCHAR(512)    NULL,
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_cat_parent (parent_id),
  INDEX idx_cat_slug   (slug),
  CONSTRAINT fk_cat_parent FOREIGN KEY (parent_id) REFERENCES service_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `services`

```sql
CREATE TABLE services (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,              -- dono do serviço (freelancer)
  category_id   BIGINT UNSIGNED NOT NULL,
  title         VARCHAR(150)    NOT NULL,
  description   TEXT            NOT NULL,
  price_type    ENUM('fixed', 'hourly', 'negotiable') NOT NULL DEFAULT 'fixed',
  price         DECIMAL(10, 2)  NULL,                  -- NULL se negotiable
  delivery_days INT UNSIGNED    NULL,
  is_remote     TINYINT(1)      NOT NULL DEFAULT 0,
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  views_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME        NULL,

  PRIMARY KEY (id),
  INDEX idx_svc_user     (user_id),
  INDEX idx_svc_category (category_id),
  INDEX idx_svc_active   (is_active),
  INDEX idx_svc_price    (price),
  FULLTEXT INDEX ft_svc_search (title, description),
  CONSTRAINT fk_svc_user     FOREIGN KEY (user_id)     REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_svc_category FOREIGN KEY (category_id) REFERENCES service_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `service_tags`

```sql
CREATE TABLE service_tags (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(60)     NOT NULL UNIQUE,
  slug       VARCHAR(70)     NOT NULL UNIQUE,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `service_tag_pivot`
Tabela de junção many-to-many entre serviços e tags.

```sql
CREATE TABLE service_tag_pivot (
  service_id BIGINT UNSIGNED NOT NULL,
  tag_id     BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (service_id, tag_id),
  CONSTRAINT fk_stp_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_stp_tag     FOREIGN KEY (tag_id)     REFERENCES service_tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 6. Módulo 04 — Contratações

### `contracts`

```sql
CREATE TABLE contracts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ulid           VARCHAR(26)     NOT NULL UNIQUE,
  client_id      BIGINT UNSIGNED NOT NULL,
  freelancer_id  BIGINT UNSIGNED NOT NULL,
  service_id     BIGINT UNSIGNED NULL,                 -- NULL se serviço personalizado
  title          VARCHAR(150)    NOT NULL,
  description    TEXT            NOT NULL,
  price          DECIMAL(10, 2)  NOT NULL,
  platform_fee   DECIMAL(10, 2)  NOT NULL,             -- taxa da plataforma
  freelancer_net DECIMAL(10, 2)  NOT NULL,             -- valor líquido ao freelancer
  status         ENUM('pending', 'accepted', 'rejected', 'in_progress', 'delivered', 'revision_requested', 'completed', 'cancelled', 'disputed') NOT NULL DEFAULT 'pending',
  deadline_at    DATETIME        NULL,
  accepted_at    DATETIME        NULL,
  completed_at   DATETIME        NULL,
  cancelled_at   DATETIME        NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_contract_client     (client_id),
  INDEX idx_contract_freelancer (freelancer_id),
  INDEX idx_contract_service    (service_id),
  INDEX idx_contract_status     (status),
  CONSTRAINT fk_contract_client     FOREIGN KEY (client_id)     REFERENCES users(id),
  CONSTRAINT fk_contract_freelancer FOREIGN KEY (freelancer_id) REFERENCES users(id),
  CONSTRAINT fk_contract_service    FOREIGN KEY (service_id)    REFERENCES services(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `contract_status_history`
Rastreabilidade completa de mudanças de status.

```sql
CREATE TABLE contract_status_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id BIGINT UNSIGNED NOT NULL,
  changed_by  BIGINT UNSIGNED NOT NULL,
  old_status  VARCHAR(30)     NULL,
  new_status  VARCHAR(30)     NOT NULL,
  note        TEXT            NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_csh_contract (contract_id),
  CONSTRAINT fk_csh_contract  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_csh_changed_by FOREIGN KEY (changed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `deliveries`

```sql
CREATE TABLE deliveries (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id BIGINT UNSIGNED NOT NULL,
  message     TEXT            NOT NULL,
  files       JSON            NULL,                    -- array de URLs dos arquivos entregues
  delivered_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_deliveries_contract (contract_id),
  CONSTRAINT fk_deliveries_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 7. Módulo 05 — Pagamentos

### `wallets`
Uma carteira digital por usuário.

```sql
CREATE TABLE wallets (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL UNIQUE,
  balance          DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
  balance_pending  DECIMAL(10, 2)  NOT NULL DEFAULT 0.00, -- valor retido em escrow
  currency         CHAR(3)         NOT NULL DEFAULT 'BRL',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_wallet_user (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `payments`

```sql
CREATE TABLE payments (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id          BIGINT UNSIGNED NOT NULL,
  payer_id             BIGINT UNSIGNED NOT NULL,
  payee_id             BIGINT UNSIGNED NOT NULL,
  amount               DECIMAL(10, 2)  NOT NULL,
  platform_fee         DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
  net_amount           DECIMAL(10, 2)  NOT NULL,
  currency             CHAR(3)         NOT NULL DEFAULT 'BRL',
  method               ENUM('pix', 'credit_card', 'debit_card', 'boleto', 'wallet') NOT NULL,
  status               ENUM('pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled') NOT NULL DEFAULT 'pending',
  gateway              VARCHAR(50)     NOT NULL DEFAULT 'mercadopago',
  gateway_payment_id   VARCHAR(100)    NULL UNIQUE,    -- ID retornado pelo gateway
  gateway_response     JSON            NULL,
  paid_at              DATETIME        NULL,
  refunded_at          DATETIME        NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pay_contract (contract_id),
  INDEX idx_pay_payer    (payer_id),
  INDEX idx_pay_payee    (payee_id),
  INDEX idx_pay_status   (status),
  INDEX idx_pay_gateway  (gateway_payment_id),
  CONSTRAINT fk_pay_contract FOREIGN KEY (contract_id) REFERENCES contracts(id),
  CONSTRAINT fk_pay_payer    FOREIGN KEY (payer_id)    REFERENCES users(id),
  CONSTRAINT fk_pay_payee    FOREIGN KEY (payee_id)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `withdrawals`

```sql
CREATE TABLE withdrawals (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  wallet_id       BIGINT UNSIGNED NOT NULL,
  amount          DECIMAL(10, 2)  NOT NULL,
  bank_name       VARCHAR(100)    NULL,
  bank_agency     VARCHAR(10)     NULL,
  bank_account    VARCHAR(20)     NULL,
  pix_key         VARCHAR(255)    NULL,
  status          ENUM('requested', 'processing', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'requested',
  gateway_ref     VARCHAR(100)    NULL,
  processed_at    DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_wd_user   (user_id),
  INDEX idx_wd_wallet (wallet_id),
  INDEX idx_wd_status (status),
  CONSTRAINT fk_wd_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_wd_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 8. Módulo 06 — Avaliações

### `reviews`

```sql
CREATE TABLE reviews (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id   BIGINT UNSIGNED NOT NULL UNIQUE,       -- 1 avaliação por contrato
  reviewer_id   BIGINT UNSIGNED NOT NULL,              -- quem avaliou (cliente)
  reviewee_id   BIGINT UNSIGNED NOT NULL,              -- quem foi avaliado (freelancer)
  rating        TINYINT UNSIGNED NOT NULL,             -- 1 a 5
  comment       TEXT            NULL,
  is_public     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_review_reviewee (reviewee_id),
  INDEX idx_review_reviewer (reviewer_id),
  CONSTRAINT chk_review_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_review_contract  FOREIGN KEY (contract_id)  REFERENCES contracts(id),
  CONSTRAINT fk_review_reviewer  FOREIGN KEY (reviewer_id)  REFERENCES users(id),
  CONSTRAINT fk_review_reviewee  FOREIGN KEY (reviewee_id)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `review_responses`

```sql
CREATE TABLE review_responses (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_id  BIGINT UNSIGNED NOT NULL UNIQUE,
  user_id    BIGINT UNSIGNED NOT NULL,                 -- freelancer respondendo
  response   TEXT            NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT fk_rr_review FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
  CONSTRAINT fk_rr_user   FOREIGN KEY (user_id)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 9. Módulo 07 — Chat

### `conversations`

```sql
CREATE TABLE conversations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id   BIGINT UNSIGNED NULL,                  -- NULL = conversa pré-contrato
  participant_a BIGINT UNSIGNED NOT NULL,
  participant_b BIGINT UNSIGNED NOT NULL,
  last_message_at DATETIME      NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation (participant_a, participant_b),
  INDEX idx_conv_contract (contract_id),
  INDEX idx_conv_last_msg (last_message_at),
  CONSTRAINT fk_conv_contract FOREIGN KEY (contract_id)   REFERENCES contracts(id) ON DELETE SET NULL,
  CONSTRAINT fk_conv_part_a   FOREIGN KEY (participant_a) REFERENCES users(id),
  CONSTRAINT fk_conv_part_b   FOREIGN KEY (participant_b) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `messages`

```sql
CREATE TABLE messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NOT NULL,
  type            ENUM('text', 'image', 'file', 'system') NOT NULL DEFAULT 'text',
  content         TEXT            NULL,                -- NULL se type = file/image
  file_url        VARCHAR(512)    NULL,
  file_name       VARCHAR(255)    NULL,
  file_size_bytes INT UNSIGNED    NULL,
  is_read         TINYINT(1)      NOT NULL DEFAULT 0,
  read_at         DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_msg_conversation (conversation_id),
  INDEX idx_msg_sender       (sender_id),
  INDEX idx_msg_read         (is_read),
  CONSTRAINT fk_msg_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_sender       FOREIGN KEY (sender_id)       REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 10. Módulo 08 — Gamificação

### `badges`
Catálogo de badges disponíveis na plataforma.

```sql
CREATE TABLE badges (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL UNIQUE,
  slug        VARCHAR(90)     NOT NULL UNIQUE,
  description TEXT            NULL,
  icon_url    VARCHAR(512)    NULL,
  xp_reward   INT UNSIGNED    NOT NULL DEFAULT 0,
  condition   JSON            NULL,                    -- regra de concessão (ex: {"contracts_completed": 10})
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `user_badges`

```sql
CREATE TABLE user_badges (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  badge_id   BIGINT UNSIGNED NOT NULL,
  awarded_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_user_badge (user_id, badge_id),
  INDEX idx_ub_user  (user_id),
  INDEX idx_ub_badge (badge_id),
  CONSTRAINT fk_ub_user  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ub_badge FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `user_xp`

```sql
CREATE TABLE user_xp (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL UNIQUE,
  total_xp   INT UNSIGNED    NOT NULL DEFAULT 0,
  level      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  level_name VARCHAR(50)     NOT NULL DEFAULT 'Iniciante',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_uxp_user  (user_id),
  INDEX idx_uxp_level (level),
  CONSTRAINT fk_uxp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `xp_transactions`
Histórico de ganhos e perdas de XP.

```sql
CREATE TABLE xp_transactions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  amount      INT             NOT NULL,                -- positivo = ganho, negativo = perda
  reason      VARCHAR(100)    NOT NULL,                -- ex: "contract_completed", "badge_earned"
  reference_id BIGINT UNSIGNED NULL,                  -- ID do objeto relacionado
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_xpt_user (user_id),
  CONSTRAINT fk_xpt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `missions`
Catálogo de missões disponíveis.

```sql
CREATE TABLE missions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(100)    NOT NULL,
  description TEXT            NULL,
  xp_reward   INT UNSIGNED    NOT NULL DEFAULT 0,
  type        ENUM('daily', 'weekly', 'achievement') NOT NULL DEFAULT 'weekly',
  condition   JSON            NOT NULL,                -- ex: {"action": "complete_contracts", "count": 3}
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `user_missions`

```sql
CREATE TABLE user_missions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  mission_id  BIGINT UNSIGNED NOT NULL,
  progress    INT UNSIGNED    NOT NULL DEFAULT 0,
  is_completed TINYINT(1)     NOT NULL DEFAULT 0,
  completed_at DATETIME       NULL,
  expires_at  DATETIME        NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_user_mission_active (user_id, mission_id, expires_at),
  INDEX idx_um_user    (user_id),
  INDEX idx_um_mission (mission_id),
  CONSTRAINT fk_um_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_um_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 11. Módulo 09 — Notificações

### `notifications`

```sql
CREATE TABLE notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        VARCHAR(80)     NOT NULL,                -- ex: "new_proposal", "payment_received"
  title       VARCHAR(150)    NOT NULL,
  body        TEXT            NULL,
  data        JSON            NULL,                    -- payload extra (ex: contract_id, amount)
  channel     SET('push', 'email', 'sms', 'in_app') NOT NULL DEFAULT 'in_app',
  is_read     TINYINT(1)      NOT NULL DEFAULT 0,
  read_at     DATETIME        NULL,
  sent_at     DATETIME        NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_notif_user   (user_id),
  INDEX idx_notif_read   (is_read),
  INDEX idx_notif_type   (type),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `push_tokens`
Tokens de dispositivos para push notification.

```sql
CREATE TABLE push_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token      VARCHAR(512)    NOT NULL UNIQUE,
  platform   ENUM('ios', 'android', 'web') NOT NULL,
  is_active  TINYINT(1)      NOT NULL DEFAULT 1,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_pt_user (user_id),
  CONSTRAINT fk_pt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 12. Módulo 10 — Suporte e Mediação

### `support_tickets`

```sql
CREATE TABLE support_tickets (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ulid         VARCHAR(26)     NOT NULL UNIQUE,
  user_id      BIGINT UNSIGNED NOT NULL,
  contract_id  BIGINT UNSIGNED NULL,
  category     ENUM('payment', 'dispute', 'account', 'fraud', 'other') NOT NULL DEFAULT 'other',
  subject      VARCHAR(150)    NOT NULL,
  status       ENUM('open', 'in_progress', 'waiting_user', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  priority     ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  assigned_to  BIGINT UNSIGNED NULL,                   -- admin responsável
  resolved_at  DATETIME        NULL,
  closed_at    DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_st_user     (user_id),
  INDEX idx_st_contract (contract_id),
  INDEX idx_st_status   (status),
  INDEX idx_st_priority (priority),
  CONSTRAINT fk_st_user     FOREIGN KEY (user_id)     REFERENCES users(id),
  CONSTRAINT fk_st_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL,
  CONSTRAINT fk_st_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `support_ticket_messages`

```sql
CREATE TABLE support_ticket_messages (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  message   TEXT            NOT NULL,
  is_internal TINYINT(1)    NOT NULL DEFAULT 0,        -- nota interna (só admins veem)
  created_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_stm_ticket (ticket_id),
  CONSTRAINT fk_stm_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_stm_sender FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 13. Módulo 11 — Impulsionamento

### `boost_plans`
Planos de impulsionamento disponíveis para compra.

```sql
CREATE TABLE boost_plans (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(80)     NOT NULL,
  description  TEXT            NULL,
  duration_days INT UNSIGNED   NOT NULL,
  price        DECIMAL(10, 2)  NOT NULL,
  features     JSON            NULL,                   -- ex: {"top_search": true, "badge": "Destaque"}
  is_active    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `boosts`
Impulsionamentos ativos por usuário/serviço.

```sql
CREATE TABLE boosts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  service_id  BIGINT UNSIGNED NULL,
  plan_id     BIGINT UNSIGNED NOT NULL,
  payment_id  BIGINT UNSIGNED NULL,
  status      ENUM('active', 'expired', 'cancelled') NOT NULL DEFAULT 'active',
  starts_at   DATETIME        NOT NULL,
  expires_at  DATETIME        NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_boost_user    (user_id),
  INDEX idx_boost_service (service_id),
  INDEX idx_boost_expires (expires_at),
  INDEX idx_boost_status  (status),
  CONSTRAINT fk_boost_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_boost_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
  CONSTRAINT fk_boost_plan    FOREIGN KEY (plan_id)    REFERENCES boost_plans(id),
  CONSTRAINT fk_boost_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 14. Módulo 12 — Administração

### `admin_actions`
Log de ações administrativas para auditoria.

```sql
CREATE TABLE admin_actions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id     BIGINT UNSIGNED NOT NULL,
  action       VARCHAR(100)    NOT NULL,               -- ex: "user_suspended", "contract_resolved"
  target_type  VARCHAR(50)     NULL,                   -- ex: "user", "contract"
  target_id    BIGINT UNSIGNED NULL,
  description  TEXT            NULL,
  ip_address   VARCHAR(45)     NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_aa_admin  (admin_id),
  INDEX idx_aa_target (target_type, target_id),
  CONSTRAINT fk_aa_admin FOREIGN KEY (admin_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `platform_settings`
Configurações globais da plataforma gerenciadas pelo admin.

```sql
CREATE TABLE platform_settings (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_name    VARCHAR(100)    NOT NULL UNIQUE,
  value       TEXT            NOT NULL,
  type        ENUM('string', 'integer', 'decimal', 'boolean', 'json') NOT NULL DEFAULT 'string',
  description VARCHAR(255)    NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT fk_ps_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> **Exemplos de settings:** `platform_fee_percentage`, `min_withdrawal_amount`, `max_boost_days`, `maintenance_mode`

---

## 15. Módulo 13 — Compliance / LGPD

### `lgpd_consents`

```sql
CREATE TABLE lgpd_consents (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        ENUM('terms_of_use', 'privacy_policy', 'marketing', 'data_processing') NOT NULL,
  version     VARCHAR(20)     NOT NULL,                -- ex: "1.2.0"
  accepted    TINYINT(1)      NOT NULL DEFAULT 1,
  ip_address  VARCHAR(45)     NULL,
  user_agent  VARCHAR(512)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_lgpd_user (user_id),
  INDEX idx_lgpd_type (type),
  CONSTRAINT fk_lgpd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `data_deletion_requests`

```sql
CREATE TABLE data_deletion_requests (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  reason       TEXT            NULL,
  status       ENUM('pending', 'processing', 'completed', 'rejected') NOT NULL DEFAULT 'pending',
  processed_by BIGINT UNSIGNED NULL,
  processed_at DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ddr_user   (user_id),
  INDEX idx_ddr_status (status),
  CONSTRAINT fk_ddr_user      FOREIGN KEY (user_id)      REFERENCES users(id),
  CONSTRAINT fk_ddr_processed FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### `audit_logs`
Rastreabilidade geral de ações críticas no sistema.

```sql
CREATE TABLE audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NULL,
  action       VARCHAR(100)    NOT NULL,
  entity_type  VARCHAR(60)     NULL,
  entity_id    BIGINT UNSIGNED NULL,
  old_value    JSON            NULL,
  new_value    JSON            NULL,
  ip_address   VARCHAR(45)     NULL,
  user_agent   VARCHAR(512)    NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_al_user   (user_id),
  INDEX idx_al_entity (entity_type, entity_id),
  INDEX idx_al_action (action),
  INDEX idx_al_date   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 16. Módulo 14 — Relatórios

### `report_snapshots`
Snapshots periódicos de métricas da plataforma.

```sql
CREATE TABLE report_snapshots (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_type     ENUM('daily', 'weekly', 'monthly') NOT NULL,
  period_start    DATE            NOT NULL,
  period_end      DATE            NOT NULL,
  new_users       INT UNSIGNED    NOT NULL DEFAULT 0,
  new_contracts   INT UNSIGNED    NOT NULL DEFAULT 0,
  completed_contracts INT UNSIGNED NOT NULL DEFAULT 0,
  cancelled_contracts INT UNSIGNED NOT NULL DEFAULT 0,
  total_revenue   DECIMAL(12, 2)  NOT NULL DEFAULT 0.00,
  platform_fees   DECIMAL(12, 2)  NOT NULL DEFAULT 0.00,
  avg_rating      DECIMAL(3, 2)   NOT NULL DEFAULT 0.00,
  active_users    INT UNSIGNED    NOT NULL DEFAULT 0,
  payload         JSON            NULL,                -- métricas adicionais
  generated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_report_period (period_type, period_start),
  INDEX idx_report_type  (period_type),
  INDEX idx_report_start (period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## Resumo Geral

| Módulo | Tabelas |
|---|---|
| 01 — Autenticação | `users`, `user_social_logins`, `user_sessions`, `password_reset_tokens` |
| 02 — Perfis | `profiles_client`, `profiles_freelancer`, `freelancer_portfolio_items`, `profiles_company` |
| 03 — Categorias e Serviços | `service_categories`, `services`, `service_tags`, `service_tag_pivot` |
| 04 — Contratações | `contracts`, `contract_status_history`, `deliveries` |
| 05 — Pagamentos | `wallets`, `payments`, `withdrawals` |
| 06 — Avaliações | `reviews`, `review_responses` |
| 07 — Chat | `conversations`, `messages` |
| 08 — Gamificação | `badges`, `user_badges`, `user_xp`, `xp_transactions`, `missions`, `user_missions` |
| 09 — Notificações | `notifications`, `push_tokens` |
| 10 — Suporte | `support_tickets`, `support_ticket_messages` |
| 11 — Impulsionamento | `boost_plans`, `boosts` |
| 12 — Administração | `admin_actions`, `platform_settings` |
| 13 — LGPD | `lgpd_consents`, `data_deletion_requests`, `audit_logs` |
| 14 — Relatórios | `report_snapshots` |
| **Total** | **48 tabelas** |

---

<div align="center">

*modelagem-banco.md — Escambo v1.0.0 — PAC Extensionista VII — Católica SC — 2026*

</div>
