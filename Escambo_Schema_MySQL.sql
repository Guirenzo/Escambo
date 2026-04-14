-- ============================================================
--  ESCAMBO — Modelagem Completa do Banco de Dados MySQL
--  Versão: 1.0  |  Data: 2025
-- ============================================================
--  Módulos cobertos:
--   1. Usuários e Autenticação
--   2. Perfis (Freelancer / Cliente / Empresa)
--   3. Categorias e Serviços
--   4. Contratações e Contratos
--   5. Pagamentos e Transações
--   6. Avaliações e Reputação
--   7. Chat e Mensagens
--   8. Gamificação (XP, Níveis, Badges, Rankings)
--   9. Notificações
--  10. Suporte e Mediação (Tickets)
--  11. Impulsionamento e Planos
--  12. Notas Fiscais
--  13. Auditoria e Logs
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

CREATE DATABASE IF NOT EXISTS escambo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE escambo;

-- ============================================================
-- MÓDULO 1 — USUÁRIOS E AUTENTICAÇÃO
-- ============================================================

CREATE TABLE users (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    email           VARCHAR(191) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255),              -- NULL se login social
    role            ENUM('freelancer','client','company','admin') NOT NULL DEFAULT 'client',
    status          ENUM('pending','active','suspended','banned') NOT NULL DEFAULT 'pending',
    email_verified  TINYINT(1) NOT NULL DEFAULT 0,
    phone_verified  TINYINT(1) NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    INDEX idx_email   (email),
    INDEX idx_role    (role),
    INDEX idx_status  (status)
) ENGINE=InnoDB;

CREATE TABLE user_social_logins (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    provider    ENUM('google','facebook','apple') NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    token       TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_provider (provider, provider_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_sessions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    device      VARCHAR(255),
    ip_address  VARCHAR(45),
    user_agent  TEXT,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_resets (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 2 — PERFIS
-- ============================================================

CREATE TABLE addresses (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    cep             VARCHAR(10) NOT NULL,
    street          VARCHAR(255),
    number          VARCHAR(20),
    complement      VARCHAR(100),
    neighborhood    VARCHAR(100),
    city            VARCHAR(100) NOT NULL,
    state           CHAR(2) NOT NULL,
    latitude        DECIMAL(10,7),
    longitude       DECIMAL(10,7),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_city  (city),
    INDEX idx_cep   (cep),
    INDEX idx_geo   (latitude, longitude)
) ENGINE=InnoDB;

CREATE TABLE client_profiles (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL UNIQUE,
    full_name       VARCHAR(191) NOT NULL,
    avatar_url      VARCHAR(500),
    bio             TEXT,
    address_id      BIGINT UNSIGNED,
    cpf             VARCHAR(14),
    birth_date      DATE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE freelancer_profiles (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id             BIGINT UNSIGNED NOT NULL UNIQUE,
    full_name           VARCHAR(191) NOT NULL,
    avatar_url          VARCHAR(500),
    bio                 TEXT,
    address_id          BIGINT UNSIGNED,
    cpf                 VARCHAR(14),
    birth_date          DATE,
    -- KYC / Validação
    kyc_status          ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none',
    kyc_document_url    VARCHAR(500),
    kyc_reviewed_at     DATETIME,
    -- Financeiro
    pix_key             VARCHAR(191),
    bank_code           VARCHAR(10),
    bank_agency         VARCHAR(20),
    bank_account        VARCHAR(30),
    -- Métricas calculadas (desnormalizadas para performance)
    avg_rating          DECIMAL(3,2) NOT NULL DEFAULT 0.00,
    total_reviews       INT UNSIGNED NOT NULL DEFAULT 0,
    total_completed     INT UNSIGNED NOT NULL DEFAULT 0,
    total_earned        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    -- Onboarding progressivo
    profile_completion  TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 0-100%
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL,
    INDEX idx_kyc    (kyc_status),
    INDEX idx_rating (avg_rating DESC)
) ENGINE=InnoDB;

CREATE TABLE company_profiles (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL UNIQUE,
    trade_name      VARCHAR(191) NOT NULL,
    legal_name      VARCHAR(191),
    cnpj            VARCHAR(18),
    logo_url        VARCHAR(500),
    description     TEXT,
    address_id      BIGINT UNSIGNED,
    website         VARCHAR(255),
    plan            ENUM('free','basic','pro','enterprise') NOT NULL DEFAULT 'free',
    plan_expires_at DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE company_members (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id      BIGINT UNSIGNED NOT NULL,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    role            VARCHAR(100),
    status          ENUM('invited','active','removed') NOT NULL DEFAULT 'invited',
    joined_at       DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_member (company_id, freelancer_id),
    FOREIGN KEY (company_id)    REFERENCES company_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE freelancer_portfolio (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    image_url       VARCHAR(500),
    project_url     VARCHAR(500),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 3 — CATEGORIAS E SERVIÇOS
-- ============================================================

CREATE TABLE categories (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parent_id   BIGINT UNSIGNED,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    icon_url    VARCHAR(500),
    sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_parent (parent_id),
    INDEX idx_active (active)
) ENGINE=InnoDB;

CREATE TABLE services (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    category_id     BIGINT UNSIGNED NOT NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    price_type      ENUM('fixed','hourly','negotiable') NOT NULL DEFAULT 'negotiable',
    price_min       DECIMAL(10,2),
    price_max       DECIMAL(10,2),
    delivery_days   SMALLINT UNSIGNED,
    location_type   ENUM('remote','onsite','both') NOT NULL DEFAULT 'both',
    status          ENUM('active','paused','deleted') NOT NULL DEFAULT 'active',
    views           INT UNSIGNED NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id)   REFERENCES categories(id),
    INDEX idx_category (category_id),
    INDEX idx_status   (status),
    INDEX idx_price    (price_min, price_max)
) ENGINE=InnoDB;

CREATE TABLE service_images (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    service_id  BIGINT UNSIGNED NOT NULL,
    url         VARCHAR(500) NOT NULL,
    sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE service_tags (
    service_id  BIGINT UNSIGNED NOT NULL,
    tag         VARCHAR(50) NOT NULL,
    PRIMARY KEY (service_id, tag),
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE freelancer_categories (
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    category_id     BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (freelancer_id, category_id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id)   REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 4 — CONTRATAÇÕES E CONTRATOS
-- ============================================================

CREATE TABLE hirings (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    client_id       BIGINT UNSIGNED NOT NULL,    -- client_profiles.id
    freelancer_id   BIGINT UNSIGNED NOT NULL,    -- freelancer_profiles.id
    service_id      BIGINT UNSIGNED,             -- pode ser oferta direta sem serviço
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    price           DECIMAL(10,2) NOT NULL,
    platform_fee    DECIMAL(10,2) NOT NULL,      -- comissão Escambo
    freelancer_net  DECIMAL(10,2) NOT NULL,      -- valor líquido para freela
    status          ENUM(
                        'pending',      -- aguardando aceite do freela
                        'accepted',     -- freela aceitou
                        'in_progress',  -- em andamento
                        'delivered',    -- freela marcou como entregue
                        'completed',    -- cliente confirmou conclusão
                        'cancelled',    -- cancelado por qualquer parte
                        'disputed'      -- em mediação
                    ) NOT NULL DEFAULT 'pending',
    location_type   ENUM('remote','onsite') NOT NULL DEFAULT 'remote',
    address_id      BIGINT UNSIGNED,             -- endereço para presencial
    scheduled_at    DATETIME,
    deadline_at     DATETIME,
    completed_at    DATETIME,
    cancelled_at    DATETIME,
    cancel_reason   TEXT,
    cancelled_by    BIGINT UNSIGNED,             -- users.id
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id)     REFERENCES client_profiles(id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id),
    FOREIGN KEY (service_id)    REFERENCES services(id) ON DELETE SET NULL,
    FOREIGN KEY (address_id)    REFERENCES addresses(id) ON DELETE SET NULL,
    FOREIGN KEY (cancelled_by)  REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_client     (client_id),
    INDEX idx_freelancer (freelancer_id),
    INDEX idx_status     (status),
    INDEX idx_created    (created_at)
) ENGINE=InnoDB;

CREATE TABLE hiring_status_history (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hiring_id   BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(30),
    to_status   VARCHAR(30) NOT NULL,
    changed_by  BIGINT UNSIGNED,
    note        TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hiring_id)  REFERENCES hirings(id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE proposals (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hiring_id       BIGINT UNSIGNED,             -- vínculo a hiring se existir
    service_id      BIGINT UNSIGNED,
    client_id       BIGINT UNSIGNED NOT NULL,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    message         TEXT,
    proposed_price  DECIMAL(10,2) NOT NULL,
    proposed_days   SMALLINT UNSIGNED,
    status          ENUM('pending','accepted','rejected','expired') NOT NULL DEFAULT 'pending',
    expires_at      DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hiring_id)     REFERENCES hirings(id) ON DELETE CASCADE,
    FOREIGN KEY (service_id)    REFERENCES services(id) ON DELETE SET NULL,
    FOREIGN KEY (client_id)     REFERENCES client_profiles(id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 5 — PAGAMENTOS E TRANSAÇÕES
-- ============================================================

CREATE TABLE payment_methods (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    type            ENUM('credit_card','debit_card','pix','boleto','wallet') NOT NULL,
    provider        ENUM('stripe','mercadopago','pagseguro') NOT NULL,
    provider_ref    VARCHAR(255),               -- token do gateway
    last4           CHAR(4),
    brand           VARCHAR(30),
    is_default      TINYINT(1) NOT NULL DEFAULT 0,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE transactions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    hiring_id       BIGINT UNSIGNED NOT NULL,
    payer_id        BIGINT UNSIGNED NOT NULL,    -- users.id
    payee_id        BIGINT UNSIGNED NOT NULL,    -- users.id (freela ou Escambo)
    type            ENUM('payment','fee','refund','withdrawal','bonus') NOT NULL,
    amount          DECIMAL(12,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'BRL',
    status          ENUM('pending','processing','completed','failed','refunded') NOT NULL DEFAULT 'pending',
    payment_method  ENUM('credit_card','debit_card','pix','boleto','wallet') NOT NULL,
    provider        ENUM('stripe','mercadopago','pagseguro') NOT NULL,
    provider_txn_id VARCHAR(255),
    provider_fee    DECIMAL(10,2),
    description     TEXT,
    processed_at    DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (hiring_id) REFERENCES hirings(id),
    FOREIGN KEY (payer_id)  REFERENCES users(id),
    FOREIGN KEY (payee_id)  REFERENCES users(id),
    INDEX idx_hiring (hiring_id),
    INDEX idx_status (status),
    INDEX idx_payer  (payer_id),
    INDEX idx_payee  (payee_id)
) ENGINE=InnoDB;

CREATE TABLE wallets (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL UNIQUE,
    balance         DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    pending_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,  -- aguardando liberação
    total_received  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total_withdrawn DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE withdrawals (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    amount          DECIMAL(12,2) NOT NULL,
    status          ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
    pix_key         VARCHAR(191),
    bank_code       VARCHAR(10),
    bank_agency     VARCHAR(20),
    bank_account    VARCHAR(30),
    processed_at    DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 6 — AVALIAÇÕES E REPUTAÇÃO
-- ============================================================

CREATE TABLE reviews (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hiring_id       BIGINT UNSIGNED NOT NULL UNIQUE,
    reviewer_id     BIGINT UNSIGNED NOT NULL,   -- users.id (quem avalia)
    reviewed_id     BIGINT UNSIGNED NOT NULL,   -- users.id (quem é avaliado)
    direction       ENUM('client_to_freelancer','freelancer_to_client') NOT NULL,
    rating          TINYINT UNSIGNED NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    -- Subcritérios (freelancer)
    rating_quality      TINYINT UNSIGNED CHECK (rating_quality BETWEEN 1 AND 5),
    rating_punctuality  TINYINT UNSIGNED CHECK (rating_punctuality BETWEEN 1 AND 5),
    rating_communication TINYINT UNSIGNED CHECK (rating_communication BETWEEN 1 AND 5),
    -- Moderação
    is_hidden       TINYINT(1) NOT NULL DEFAULT 0,
    hidden_reason   TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hiring_id)   REFERENCES hirings(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES users(id),
    FOREIGN KEY (reviewed_id) REFERENCES users(id),
    INDEX idx_reviewed (reviewed_id),
    INDEX idx_rating   (rating)
) ENGINE=InnoDB;

CREATE TABLE review_flags (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    review_id   BIGINT UNSIGNED NOT NULL,
    flagged_by  BIGINT UNSIGNED NOT NULL,
    reason      VARCHAR(255) NOT NULL,
    status      ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (review_id)  REFERENCES reviews(id) ON DELETE CASCADE,
    FOREIGN KEY (flagged_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 7 — CHAT E MENSAGENS
-- ============================================================

CREATE TABLE conversations (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    hiring_id       BIGINT UNSIGNED,
    participant_a   BIGINT UNSIGNED NOT NULL,  -- users.id
    participant_b   BIGINT UNSIGNED NOT NULL,  -- users.id
    last_message_at DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_conversation (participant_a, participant_b, hiring_id),
    FOREIGN KEY (hiring_id)     REFERENCES hirings(id) ON DELETE SET NULL,
    FOREIGN KEY (participant_a) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (participant_b) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE messages (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    sender_id       BIGINT UNSIGNED NOT NULL,
    type            ENUM('text','image','file','audio','system') NOT NULL DEFAULT 'text',
    content         TEXT,
    file_url        VARCHAR(500),
    file_name       VARCHAR(255),
    file_size       INT UNSIGNED,
    is_read         TINYINT(1) NOT NULL DEFAULT 0,
    read_at         DATETIME,
    deleted_at      DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id)       REFERENCES users(id),
    INDEX idx_conversation (conversation_id, created_at),
    INDEX idx_unread       (conversation_id, is_read)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 8 — GAMIFICAÇÃO
-- ============================================================

CREATE TABLE xp_levels (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    level_number    SMALLINT UNSIGNED NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,       -- "Iniciante", "Profissional", "Expert"...
    xp_required     INT UNSIGNED NOT NULL,
    badge_url       VARCHAR(500),
    perks           JSON,                        -- benefícios do nível em JSON
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE freelancer_xp (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL UNIQUE,
    total_xp        INT UNSIGNED NOT NULL DEFAULT 0,
    current_level   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE xp_transactions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    xp_amount       INT NOT NULL,                -- pode ser negativo (penalidade)
    reason          ENUM(
                        'service_completed',
                        'review_5_stars',
                        'profile_completed',
                        'first_hire',
                        'streak_bonus',
                        'mission_completed',
                        'penalty_cancellation',
                        'penalty_dispute_lost',
                        'admin_adjustment'
                    ) NOT NULL,
    reference_id    BIGINT UNSIGNED,             -- id do hiring, review, etc.
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    INDEX idx_freelancer (freelancer_id)
) ENGINE=InnoDB;

CREATE TABLE badges (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code        VARCHAR(50) NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url    VARCHAR(500),
    condition   JSON,                            -- critérios de desbloqueio
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE freelancer_badges (
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    badge_id        BIGINT UNSIGNED NOT NULL,
    earned_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (freelancer_id, badge_id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (badge_id)      REFERENCES badges(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE missions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    type            ENUM('daily','weekly','monthly','one_time') NOT NULL,
    xp_reward       INT UNSIGNED NOT NULL DEFAULT 0,
    bonus_reward    DECIMAL(10,2),               -- bônus em reais
    target_metric   VARCHAR(100) NOT NULL,       -- ex: "services_completed"
    target_value    INT UNSIGNED NOT NULL,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    starts_at       DATETIME,
    ends_at         DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE freelancer_missions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    mission_id      BIGINT UNSIGNED NOT NULL,
    progress        INT UNSIGNED NOT NULL DEFAULT 0,
    completed_at    DATETIME,
    reward_claimed  TINYINT(1) NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mission (freelancer_id, mission_id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (mission_id)    REFERENCES missions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE rankings (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    category_id     BIGINT UNSIGNED,            -- NULL = ranking geral
    city            VARCHAR(100),
    state           CHAR(2),
    rank_position   INT UNSIGNED NOT NULL,
    score           DECIMAL(10,4) NOT NULL,
    period          ENUM('weekly','monthly','alltime') NOT NULL DEFAULT 'monthly',
    calculated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id)   REFERENCES categories(id) ON DELETE SET NULL,
    INDEX idx_rank   (period, city, state, category_id, rank_position),
    INDEX idx_freela (freelancer_id, period)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 9 — NOTIFICAÇÕES
-- ============================================================

CREATE TABLE notification_templates (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code        VARCHAR(100) NOT NULL UNIQUE,
    channel     ENUM('push','email','sms','inapp') NOT NULL,
    subject     VARCHAR(255),
    body        TEXT NOT NULL,
    variables   JSON,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE notifications (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    template_code   VARCHAR(100),
    channel         ENUM('push','email','sms','inapp') NOT NULL DEFAULT 'inapp',
    title           VARCHAR(255),
    body            TEXT NOT NULL,
    data            JSON,                        -- payload extra
    is_read         TINYINT(1) NOT NULL DEFAULT 0,
    read_at         DATETIME,
    sent_at         DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_unread (user_id, is_read),
    INDEX idx_created     (created_at)
) ENGINE=InnoDB;

CREATE TABLE push_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token       VARCHAR(500) NOT NULL,
    platform    ENUM('ios','android','web') NOT NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_token (token),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 10 — SUPORTE E MEDIAÇÃO
-- ============================================================

CREATE TABLE support_categories (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE tickets (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    user_id         BIGINT UNSIGNED NOT NULL,
    hiring_id       BIGINT UNSIGNED,
    category_id     BIGINT UNSIGNED,
    subject         VARCHAR(255) NOT NULL,
    type            ENUM('support','dispute','report','financial','other') NOT NULL DEFAULT 'support',
    priority        ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
    status          ENUM('open','in_progress','pending_user','resolved','closed') NOT NULL DEFAULT 'open',
    assigned_to     BIGINT UNSIGNED,             -- users.id do agente
    resolved_at     DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)     REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (hiring_id)   REFERENCES hirings(id) ON DELETE SET NULL,
    FOREIGN KEY (category_id) REFERENCES support_categories(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status   (status),
    INDEX idx_priority (priority),
    INDEX idx_user     (user_id)
) ENGINE=InnoDB;

CREATE TABLE ticket_messages (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_id   BIGINT UNSIGNED NOT NULL,
    sender_id   BIGINT UNSIGNED NOT NULL,
    body        TEXT NOT NULL,
    is_internal TINYINT(1) NOT NULL DEFAULT 0,   -- nota interna da equipe
    file_url    VARCHAR(500),
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE disputes (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_id       BIGINT UNSIGNED NOT NULL UNIQUE,
    hiring_id       BIGINT UNSIGNED NOT NULL UNIQUE,
    opened_by       BIGINT UNSIGNED NOT NULL,   -- users.id
    against_id      BIGINT UNSIGNED NOT NULL,   -- users.id
    reason          TEXT NOT NULL,
    evidence        JSON,                        -- URLs de evidências
    status          ENUM('open','under_review','resolved_client','resolved_freelancer','resolved_split') NOT NULL DEFAULT 'open',
    resolution_note TEXT,
    resolved_by     BIGINT UNSIGNED,
    resolved_at     DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id)   REFERENCES tickets(id),
    FOREIGN KEY (hiring_id)   REFERENCES hirings(id),
    FOREIGN KEY (opened_by)   REFERENCES users(id),
    FOREIGN KEY (against_id)  REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 11 — IMPULSIONAMENTO E PLANOS
-- ============================================================

CREATE TABLE boost_plans (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    price           DECIMAL(10,2) NOT NULL,
    duration_days   SMALLINT UNSIGNED NOT NULL,
    multiplier      DECIMAL(4,2) NOT NULL DEFAULT 1.00,  -- multiplicador de visibilidade
    max_impressions INT UNSIGNED,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE boosts (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    plan_id         BIGINT UNSIGNED NOT NULL,
    service_id      BIGINT UNSIGNED,             -- NULL = perfil inteiro
    transaction_id  BIGINT UNSIGNED NOT NULL,
    starts_at       DATETIME NOT NULL,
    ends_at         DATETIME NOT NULL,
    impressions     INT UNSIGNED NOT NULL DEFAULT 0,
    clicks          INT UNSIGNED NOT NULL DEFAULT 0,
    status          ENUM('active','expired','cancelled') NOT NULL DEFAULT 'active',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (freelancer_id)  REFERENCES freelancer_profiles(id),
    FOREIGN KEY (plan_id)        REFERENCES boost_plans(id),
    FOREIGN KEY (service_id)     REFERENCES services(id) ON DELETE SET NULL,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id),
    INDEX idx_active (status, ends_at)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 12 — NOTAS FISCAIS
-- ============================================================

CREATE TABLE invoices (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    hiring_id       BIGINT UNSIGNED NOT NULL,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    client_id       BIGINT UNSIGNED NOT NULL,
    gross_amount    DECIMAL(12,2) NOT NULL,
    tax_amount      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    net_amount      DECIMAL(12,2) NOT NULL,
    nfse_number     VARCHAR(100),
    nfse_url        VARCHAR(500),
    nfse_xml_url    VARCHAR(500),
    status          ENUM('pending','issued','error','cancelled') NOT NULL DEFAULT 'pending',
    issued_at       DATETIME,
    provider        VARCHAR(100),               -- "eNotas", "nfse.io", etc.
    provider_ref    VARCHAR(255),
    error_message   TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (hiring_id)     REFERENCES hirings(id),
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id),
    FOREIGN KEY (client_id)     REFERENCES client_profiles(id)
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 13 — FAVORITOS E DENÚNCIAS
-- ============================================================

CREATE TABLE favorites (
    user_id         BIGINT UNSIGNED NOT NULL,
    freelancer_id   BIGINT UNSIGNED NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, freelancer_id),
    FOREIGN KEY (user_id)       REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (freelancer_id) REFERENCES freelancer_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_reports (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reporter_id     BIGINT UNSIGNED NOT NULL,
    reported_id     BIGINT UNSIGNED NOT NULL,
    entity_type     ENUM('user','service','review','message') NOT NULL,
    entity_id       BIGINT UNSIGNED NOT NULL,
    reason          ENUM('fraud','fake_profile','inappropriate','spam','harassment','other') NOT NULL,
    description     TEXT,
    status          ENUM('pending','reviewed','dismissed') NOT NULL DEFAULT 'pending',
    reviewed_by     BIGINT UNSIGNED,
    reviewed_at     DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reporter_id)  REFERENCES users(id),
    FOREIGN KEY (reported_id)  REFERENCES users(id),
    FOREIGN KEY (reviewed_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- MÓDULO 14 — AUDITORIA E LOGS
-- ============================================================

CREATE TABLE audit_logs (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED,
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id   BIGINT UNSIGNED,
    old_values  JSON,
    new_values  JSON,
    ip_address  VARCHAR(45),
    user_agent  TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_entity  (entity_type, entity_id),
    INDEX idx_user    (user_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE search_logs (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED,
    query           VARCHAR(500),
    category_id     BIGINT UNSIGNED,
    city            VARCHAR(100),
    state           CHAR(2),
    results_count   INT UNSIGNED,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- DADOS INICIAIS (SEED)
-- ============================================================

-- Categorias principais
INSERT INTO categories (name, slug, sort_order) VALUES
('Tecnologia',           'tecnologia',           1),
('Design e Criatividade','design',                2),
('Marketing Digital',    'marketing',             3),
('Serviços Domésticos',  'servicos-domesticos',   4),
('Reparos e Manutenção', 'reparos',               5),
('Beleza e Estética',    'beleza',                6),
('Aulas e Tutoria',      'aulas',                 7),
('Saúde e Bem-estar',    'saude',                 8),
('Eventos',              'eventos',               9),
('Escrita e Tradução',   'escrita',              10),
('Finanças',             'financas',             11),
('Jurídico',             'juridico',             12);

-- Subcategorias de Tecnologia
INSERT INTO categories (parent_id, name, slug, sort_order) VALUES
(1, 'Desenvolvimento Web',    'dev-web',      1),
(1, 'Apps Mobile',            'dev-mobile',   2),
(1, 'Banco de Dados',         'banco-dados',  3),
(1, 'DevOps / Cloud',         'devops',       4),
(1, 'Segurança da Informação','seguranca',    5),
(1, 'Suporte Técnico',        'suporte-ti',   6);

-- Subcategorias de Design
INSERT INTO categories (parent_id, name, slug, sort_order) VALUES
(2, 'Design Gráfico',   'design-grafico',  1),
(2, 'UI/UX',            'ui-ux',           2),
(2, 'Edição de Vídeo',  'edicao-video',    3),
(2, 'Fotografia',       'fotografia',      4),
(2, 'Ilustração',       'ilustracao',      5);

-- Subcategorias de Serviços Domésticos
INSERT INTO categories (parent_id, name, slug, sort_order) VALUES
(4, 'Limpeza',          'limpeza',         1),
(4, 'Jardinagem',       'jardinagem',      2),
(4, 'Cuidados com Pets','cuidados-pets',   3),
(4, 'Baby-sitter',      'babysitter',      4),
(4, 'Culinária',        'culinaria',       5);

-- XP Levels
INSERT INTO xp_levels (level_number, name, xp_required) VALUES
(1,  'Iniciante',       0),
(2,  'Aprendiz',        100),
(3,  'Competente',      300),
(4,  'Experiente',      700),
(5,  'Profissional',    1500),
(6,  'Especialista',    3000),
(7,  'Expert',          6000),
(8,  'Mestre',          12000),
(9,  'Lenda',           25000),
(10, 'Elite Escambo',   50000);

-- Badges iniciais
INSERT INTO badges (code, name, description) VALUES
('first_hire',        'Primeira Contratação',      'Concluiu seu primeiro serviço na plataforma'),
('speed_king',        'Velocidade Relâmpago',       'Respondeu 10 propostas em menos de 5 minutos'),
('five_stars',        'Cinco Estrelas',             'Recebeu 10 avaliações com nota máxima'),
('consistent',        'Consistência é Tudo',        'Concluiu 30 serviços consecutivos sem cancelamento'),
('trusted',           'Profissional Confiável',     'KYC aprovado e sem disputas em 6 meses'),
('local_hero',        'Herói Local',                'Top 1 da cidade por 30 dias consecutivos'),
('early_adopter',     'Pioneiro Escambo',           'Um dos primeiros 1000 cadastrados'),
('company_partner',   'Parceiro Empresarial',       'Trabalhou com 5 empresas diferentes'),
('top_earner',        'Top Ganhos',                 'Acumulou R$ 10.000 em serviços'),
('diversity',         'Múltiplos Talentos',         'Tem serviços ativos em 3 categorias diferentes');

-- Planos de impulsionamento
INSERT INTO boost_plans (name, description, price, duration_days, multiplier) VALUES
('Impulso 3 Dias',    'Destaque seu perfil por 3 dias',   29.90,  3,  1.5),
('Impulso 7 Dias',    'Destaque seu perfil por 7 dias',   59.90,  7,  2.0),
('Impulso 15 Dias',   'Destaque seu perfil por 15 dias',  99.90, 15,  2.5),
('Impulso 30 Dias',   'Destaque máximo por 30 dias',     169.90, 30,  3.0);

-- Missões iniciais
INSERT INTO missions (title, description, type, xp_reward, target_metric, target_value) VALUES
('Primeiro Escambo',     'Conclua seu primeiro serviço',                    'one_time', 200, 'services_completed',  1),
('Explorador',           'Conclua 5 serviços',                              'one_time', 500, 'services_completed',  5),
('Cinco Estrelas Hoje',  'Receba uma avaliação 5 estrelas esta semana',     'weekly',    50, 'five_star_reviews',   1),
('Mestre das Entregas',  'Conclua 3 serviços esta semana',                  'weekly',   150, 'services_completed',  3),
('Perfil Completo',      'Complete 100% do seu perfil',                     'one_time', 100, 'profile_completion', 100),
('Resposta Rápida',      'Responda 5 propostas em menos de 10 minutos',     'weekly',    75, 'fast_responses',      5);

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- VIEWS ÚTEIS
-- ============================================================

CREATE OR REPLACE VIEW v_freelancer_stats AS
SELECT
    fp.id                       AS freelancer_id,
    fp.full_name,
    u.email,
    fp.avg_rating,
    fp.total_reviews,
    fp.total_completed,
    fp.total_earned,
    fx.total_xp,
    fx.current_level,
    xl.name                     AS level_name,
    fp.kyc_status,
    fp.profile_completion,
    a.city,
    a.state
FROM freelancer_profiles fp
JOIN users               u  ON fp.user_id = u.id
LEFT JOIN freelancer_xp  fx ON fp.id = fx.freelancer_id
LEFT JOIN xp_levels      xl ON fx.current_level = xl.level_number
LEFT JOIN addresses      a  ON fp.address_id = a.id
WHERE u.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_hiring_summary AS
SELECT
    h.id,
    h.uuid,
    h.title,
    h.price,
    h.platform_fee,
    h.freelancer_net,
    h.status,
    h.created_at,
    h.completed_at,
    cp.full_name        AS client_name,
    fp.full_name        AS freelancer_name,
    c.name              AS category_name
FROM hirings h
JOIN client_profiles     cp ON h.client_id = cp.id
JOIN freelancer_profiles fp ON h.freelancer_id = fp.id
LEFT JOIN services        s ON h.service_id = s.id
LEFT JOIN categories      c ON s.category_id = c.id;

-- ============================================================
-- FIM DO SCRIPT
-- ============================================================
