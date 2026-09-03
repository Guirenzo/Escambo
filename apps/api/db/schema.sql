-- =====================================================================
-- Escambo — Schema do Banco de Dados (MySQL 8.0+)
-- Gerado a partir de docs/modelagem-banco.md (fonte única da modelagem).
-- 50 tabelas em 15 módulos. Encoding: utf8mb4 / utf8mb4_unicode_ci.
--
-- Uso:
--   mysql -u root -p < apps/api/db/schema.sql
--   (ou via docker: ver infra/docker-compose.yml)
--
-- FOREIGN_KEY_CHECKS é desativado durante a criação para permitir
-- a referência circular entre `contracts` e `barter_agreements`.
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE DATABASE IF NOT EXISTS escambo
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE escambo;

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

CREATE TABLE user_mfa (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  method         ENUM('totp', 'sms', 'email') NOT NULL DEFAULT 'totp',
  secret         VARBINARY(255)  NULL,                    -- segredo TOTP cifrado (AES-256)
  is_enabled     TINYINT(1)      NOT NULL DEFAULT 0,
  confirmed_at   DATETIME        NULL,
  recovery_codes JSON            NULL,                     -- hashes dos códigos de recuperação
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_user_mfa (user_id, method),
  INDEX idx_mfa_user (user_id),
  CONSTRAINT fk_mfa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE service_tags (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(60)     NOT NULL UNIQUE,
  slug       VARCHAR(70)     NOT NULL UNIQUE,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE service_tag_pivot (
  service_id BIGINT UNSIGNED NOT NULL,
  tag_id     BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (service_id, tag_id),
  CONSTRAINT fk_stp_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_stp_tag     FOREIGN KEY (tag_id)     REFERENCES service_tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE service_packages (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id    BIGINT UNSIGNED NOT NULL,
  tier          ENUM('basic', 'standard', 'premium') NOT NULL,
  name          VARCHAR(100)    NOT NULL,
  description   TEXT            NULL,
  price         DECIMAL(10, 2)  NOT NULL,
  delivery_days INT UNSIGNED    NOT NULL,
  revisions     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  features      JSON            NULL,                    -- itens inclusos no pacote
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_service_tier (service_id, tier),
  INDEX idx_pkg_service (service_id),
  CONSTRAINT fk_pkg_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE favorites (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  target_type ENUM('service', 'freelancer') NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_favorite (user_id, target_type, target_id),
  INDEX idx_fav_user (user_id),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE saved_searches (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(120)    NULL,
  query         VARCHAR(255)    NULL,
  filters       JSON            NULL,                    -- categoria, faixa de preço, nota mínima, raio
  alert_enabled TINYINT(1)      NOT NULL DEFAULT 0,
  last_alert_at DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_saved_user (user_id),
  CONSTRAINT fk_saved_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  payment_mode   ENUM('cash', 'barter', 'hybrid') NOT NULL DEFAULT 'cash', -- dinheiro / troca / troca+torna
  barter_agreement_id BIGINT UNSIGNED NULL,            -- preenchido quando o contrato faz parte de uma troca
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
  INDEX idx_contract_barter     (barter_agreement_id),
  CONSTRAINT fk_contract_client     FOREIGN KEY (client_id)     REFERENCES users(id),
  CONSTRAINT fk_contract_freelancer FOREIGN KEY (freelancer_id) REFERENCES users(id),
  CONSTRAINT fk_contract_service    FOREIGN KEY (service_id)    REFERENCES services(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE contract_milestones (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(150)    NOT NULL,
  description TEXT            NULL,
  amount      DECIMAL(10, 2)  NOT NULL,
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  status      ENUM('pending', 'funded', 'delivered', 'approved', 'released', 'cancelled') NOT NULL DEFAULT 'pending',
  due_at      DATETIME        NULL,
  released_at DATETIME        NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_milestone_contract (contract_id),
  INDEX idx_milestone_status   (status),
  CONSTRAINT fk_milestone_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE review_criteria_scores (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_id BIGINT UNSIGNED NOT NULL,
  criterion ENUM('quality', 'communication', 'deadline', 'professionalism') NOT NULL,
  score     TINYINT UNSIGNED NOT NULL,                 -- 1 a 5

  PRIMARY KEY (id),
  UNIQUE KEY uq_review_criterion (review_id, criterion),
  INDEX idx_rcs_review (review_id),
  CONSTRAINT chk_rcs_score CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT fk_rcs_review FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE badges (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)     NOT NULL UNIQUE,
  slug        VARCHAR(90)     NOT NULL UNIQUE,
  description TEXT            NULL,
  icon_url    VARCHAR(512)    NULL,
  xp_reward   INT UNSIGNED    NOT NULL DEFAULT 0,
  criteria    JSON            NULL,                    -- regra de concessão (ex: {"contracts_completed": 10})
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE missions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(100)    NOT NULL,
  description TEXT            NULL,
  xp_reward   INT UNSIGNED    NOT NULL DEFAULT 0,
  type        ENUM('daily', 'weekly', 'achievement') NOT NULL DEFAULT 'weekly',
  criteria    JSON            NOT NULL,                -- ex: {"action": "complete_contracts", "count": 3}
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE disputes (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ulid              VARCHAR(26)     NOT NULL UNIQUE,
  contract_id       BIGINT UNSIGNED NOT NULL,
  ticket_id         BIGINT UNSIGNED NULL,
  opened_by         BIGINT UNSIGNED NOT NULL,
  reason            ENUM('not_delivered', 'quality', 'deadline', 'scope', 'payment', 'other') NOT NULL DEFAULT 'other',
  description       TEXT            NOT NULL,
  status            ENUM('open', 'under_review', 'awaiting_parties', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  resolution        ENUM('refund_client', 'release_freelancer', 'partial_split', 'none') NULL,
  refund_percentage TINYINT UNSIGNED NULL,              -- % reembolsado ao cliente em partial_split
  resolved_by       BIGINT UNSIGNED NULL,               -- admin mediador
  resolution_note   TEXT            NULL,
  resolved_at       DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_dispute_contract (contract_id),
  INDEX idx_dispute_status   (status),
  INDEX idx_dispute_opened_by (opened_by),
  CONSTRAINT chk_dispute_refund CHECK (refund_percentage IS NULL OR refund_percentage BETWEEN 0 AND 100),
  CONSTRAINT fk_dispute_contract    FOREIGN KEY (contract_id) REFERENCES contracts(id),
  CONSTRAINT fk_dispute_ticket      FOREIGN KEY (ticket_id)   REFERENCES support_tickets(id) ON DELETE SET NULL,
  CONSTRAINT fk_dispute_opened_by   FOREIGN KEY (opened_by)   REFERENCES users(id),
  CONSTRAINT fk_dispute_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_reports (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_id BIGINT UNSIGNED NOT NULL,
  target_type ENUM('user', 'service', 'review', 'message') NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  reason      ENUM('spam', 'fraud', 'offensive', 'off_platform', 'illegal', 'other') NOT NULL,
  description TEXT            NULL,
  status      ENUM('pending', 'reviewing', 'actioned', 'dismissed') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME        NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_report_target   (target_type, target_id),
  INDEX idx_report_status   (status),
  INDEX idx_report_reporter (reporter_id),
  CONSTRAINT fk_report_reporter    FOREIGN KEY (reporter_id) REFERENCES users(id),
  CONSTRAINT fk_report_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE data_export_requests (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  status       ENUM('pending', 'processing', 'ready', 'downloaded', 'expired', 'failed') NOT NULL DEFAULT 'pending',
  file_url     VARCHAR(512)    NULL,
  expires_at   DATETIME        NULL,
  processed_at DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_der_user   (user_id),
  INDEX idx_der_status (status),
  CONSTRAINT fk_der_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE barter_agreements (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ulid                      VARCHAR(26)     NOT NULL UNIQUE,
  proposer_id               BIGINT UNSIGNED NOT NULL,     -- quem propõe a troca
  receiver_id               BIGINT UNSIGNED NOT NULL,     -- quem recebe a proposta
  offered_service_id        BIGINT UNSIGNED NULL,         -- serviço que o proponente entrega
  requested_service_id      BIGINT UNSIGNED NULL,         -- serviço que o receptor entrega
  offered_description       TEXT            NULL,          -- usado quando é serviço sob medida (sem catálogo)
  requested_description     TEXT            NULL,
  estimated_value_offered   DECIMAL(10, 2)  NOT NULL,      -- valor estimado do que é oferecido
  estimated_value_requested DECIMAL(10, 2)  NOT NULL,      -- valor estimado do que é pedido
  cash_difference           DECIMAL(10, 2)  NOT NULL DEFAULT 0.00, -- torna (diferença em dinheiro)
  cash_payer_id             BIGINT UNSIGNED NULL,          -- quem paga a torna (NULL em troca par)
  platform_fee              DECIMAL(10, 2)  NOT NULL DEFAULT 0.00, -- 15% sobre o maior valor estimado
  status                    ENUM('proposed', 'accepted', 'rejected', 'active', 'completed', 'cancelled', 'disputed') NOT NULL DEFAULT 'proposed',
  contract_offered_id       BIGINT UNSIGNED NULL,          -- contrato gerado (lado proponente)
  contract_requested_id     BIGINT UNSIGNED NULL,          -- contrato gerado (lado receptor)
  accepted_at               DATETIME        NULL,
  completed_at              DATETIME        NULL,
  created_at                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_barter_proposer (proposer_id),
  INDEX idx_barter_receiver (receiver_id),
  INDEX idx_barter_status   (status),
  CONSTRAINT fk_barter_proposer          FOREIGN KEY (proposer_id)           REFERENCES users(id),
  CONSTRAINT fk_barter_receiver          FOREIGN KEY (receiver_id)           REFERENCES users(id),
  CONSTRAINT fk_barter_offered_service   FOREIGN KEY (offered_service_id)    REFERENCES services(id)  ON DELETE SET NULL,
  CONSTRAINT fk_barter_requested_service FOREIGN KEY (requested_service_id)  REFERENCES services(id)  ON DELETE SET NULL,
  CONSTRAINT fk_barter_cash_payer        FOREIGN KEY (cash_payer_id)         REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_barter_contract_offered  FOREIGN KEY (contract_offered_id)   REFERENCES contracts(id) ON DELETE SET NULL,
  CONSTRAINT fk_barter_contract_requested FOREIGN KEY (contract_requested_id) REFERENCES contracts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- FK recíproca: contracts.barter_agreement_id -> barter_agreements(id)
-- Adicionada após a criação de barter_agreements (referência circular).
-- ---------------------------------------------------------------------
ALTER TABLE contracts
  ADD CONSTRAINT fk_contract_barter
  FOREIGN KEY (barter_agreement_id) REFERENCES barter_agreements(id) ON DELETE SET NULL;

SET FOREIGN_KEY_CHECKS = 1;
