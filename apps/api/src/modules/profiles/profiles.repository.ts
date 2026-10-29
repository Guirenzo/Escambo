import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface FreelancerRow extends RowDataPacket {
  full_name: string;
  avatar_url: string | null;
  bio: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  latitude: string | null;
  longitude: string | null;
  is_available: number;
  /** JSON (mysql2 já devolve parseado; string só em drivers antigos). */
  available_days: number[] | string | null;
  /** JSON {"1": ["morning"]} (mysql2 já entrega objeto) ou NULL. */
  available_periods: unknown;
  avg_rating: string;
  total_reviews: number;
  total_contracts: number;
  response_time_hours: number | string | null;
  /** Fuso da conta (users.timezone); NULL = Brasília (ADR 46 e 48). */
  timezone: string | null;
}

export interface PortfolioRow extends RowDataPacket {
  id: number;
  title: string;
  description: string | null;
  image_url: string | null;
  external_url: string | null;
  sort_order: number;
}

export interface ClientRow extends RowDataPacket {
  full_name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
}

export interface PublicFreelancerRow extends FreelancerRow {
  ulid: string;
  level: number;
  level_name: string;
  /** XP acumulado (RF-068); 0 para quem ainda não tem linha em user_xp. */
  total_xp: number;
}

/** Conta de empresa (RF-018): company_name é a razão social; trade_name, o nome fantasia. */
export interface CompanyRow extends RowDataPacket {
  company_name: string;
  trade_name: string | null;
  cnpj: string | null;
  logo_url: string | null;
  bio: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
}

export interface PublicCompanyRow extends CompanyRow {
  ulid: string;
  created_at: Date;
}

/** O CPF do perfil de freelancer (RF-020): o cifrado só sai daqui para ser aberto no service. */
export interface CpfRow extends RowDataPacket {
  cpf_verified: number;
  cpf_encrypted: string | null;
  /** AAAA-MM-DD (DATE_FORMAT: sem o Date do driver, que mudaria o dia pelo fuso). */
  birth_date: string | null;
  cpf_verified_at: Date | null;
}

/** O que o saque confere (RF-020): a conta entrega trabalho (ADR 56) e o CPF está validado. */
export interface PayoutStateRow extends RowDataPacket {
  delivers_work: number;
  cpf_verified: number;
}

/** O que gravar quando o CPF passa na validação (RF-020). */
export interface VerifiedCpfData {
  sealedCpf: string;
  index: string;
  birthDate: string;
  verifiedAt: Date;
}

export interface CompanyData {
  legalName: string;
  tradeName: string;
  cnpj: string;
}

export interface CompanyDetails extends CompanyData {
  logoUrl: string | null;
  bio: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
}

const COMPANY_COLS = `pco.company_name, pco.trade_name, pco.cnpj, pco.logo_url, pco.bio, pco.website,
              pco.city, pco.state`;

/** Badge conquistada, como o perfil público mostra (RF-015). */
export interface PublicBadgeRow extends RowDataPacket {
  slug: string;
  name: string;
  awarded_at: Date;
}

export const profilesRepository = {
  async upsertFreelancer(
    userId: number,
    d: {
      fullName: string;
      avatarUrl: string | null;
      bio: string | null;
      headline: string | null;
      city: string | null;
      state: string | null;
      latitude: number | null;
      longitude: number | null;
      isAvailable: boolean;
      /** JSON serializado dos dias (ou null). */
      availableDays: string | null;
      /** JSON serializado dos períodos por dia (ou null = o dia todo). */
      availablePeriods: string | null;
    },
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_freelancer
         (user_id, full_name, avatar_url, bio, headline, city, state, latitude, longitude, is_available, available_days, available_periods)
       VALUES (:userId, :fullName, :avatarUrl, :bio, :headline, :city, :state, :latitude, :longitude, :isAvailable, :availableDays, :availablePeriods)
       ON DUPLICATE KEY UPDATE
         full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, headline = :headline,
         city = :city, state = :state, latitude = :latitude, longitude = :longitude, is_available = :isAvailable,
         available_days = :availableDays, available_periods = :availablePeriods`,
      { userId, ...d },
    );
  },

  // ---------- Portfólio (freelancer_portfolio_items, FK para profiles_freelancer.id) ----------

  async listPortfolio(userId: number): Promise<PortfolioRow[]> {
    const [rows] = await pool.query<PortfolioRow[]>(
      `SELECT i.id, i.title, i.description, i.image_url, i.external_url, i.sort_order
         FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
        WHERE pf.user_id = :userId
        ORDER BY i.sort_order ASC, i.id ASC`,
      { userId },
    );
    return rows;
  },

  async countPortfolio(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id WHERE pf.user_id = :userId`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Insere pelo perfil do usuário (INSERT … SELECT); null se ele não tem perfil de freelancer. */
  async createPortfolioItem(
    userId: number,
    d: {
      title: string;
      description: string | null;
      imageUrl: string | null;
      externalUrl: string | null;
    },
  ): Promise<number | null> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO freelancer_portfolio_items (freelancer_id, title, description, image_url, external_url, sort_order)
       SELECT pf.id, :title, :description, :imageUrl, :externalUrl,
              (SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM freelancer_portfolio_items x WHERE x.freelancer_id = pf.id)
         FROM profiles_freelancer pf WHERE pf.user_id = :userId`,
      { userId, ...d },
    );
    return res.affectedRows > 0 ? res.insertId : null;
  },

  async updatePortfolioItem(
    userId: number,
    id: number,
    d: {
      title: string;
      description: string | null;
      imageUrl: string | null;
      externalUrl: string | null;
    },
  ): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
          SET i.title = :title, i.description = :description, i.image_url = :imageUrl, i.external_url = :externalUrl
        WHERE i.id = :id AND pf.user_id = :userId`,
      { userId, id, ...d },
    );
    return res.affectedRows > 0;
  },

  async deletePortfolioItem(userId: number, id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE i FROM freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
        WHERE i.id = :id AND pf.user_id = :userId`,
      { userId, id },
    );
    return res.affectedRows > 0;
  },

  /**
   * Grava a ordem do portfólio de uma vez (ADR 43): a posição de cada id na lista vira o
   * sort_order (1, 2, 3…). Só mexe nos ids da lista que são do próprio dono.
   */
  async reorderPortfolio(userId: number, ids: number[]): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE freelancer_portfolio_items i
         JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
          SET i.sort_order = FIELD(i.id, :ids)
        WHERE pf.user_id = :userId AND i.id IN (:ids)`,
      { userId, ids },
    );
    return res.affectedRows;
  },

  /**
   * Tempo médio de resposta do freelancer (horas), média móvel exponencial: uma amostra nova
   * pesa 30%. Alimenta a dimensão "responsividade" do Escambo Score.
   */
  async blendResponseTime(userId: number, hours: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE profiles_freelancer
          SET response_time_hours = CASE
            WHEN response_time_hours IS NULL THEN :hours
            ELSE ROUND(response_time_hours * 0.7 + :hours * 0.3, 2)
          END
        WHERE user_id = :userId`,
      { userId, hours },
    );
  },

  async upsertClient(
    userId: number,
    d: {
      fullName: string;
      avatarUrl: string | null;
      bio: string | null;
      city: string | null;
      state: string | null;
    },
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_client (user_id, full_name, avatar_url, bio, city, state)
       VALUES (:userId, :fullName, :avatarUrl, :bio, :city, :state)
       ON DUPLICATE KEY UPDATE
         full_name = :fullName, avatar_url = :avatarUrl, bio = :bio, city = :city, state = :state`,
      { userId, ...d },
    );
  },

  async findFreelancerByUserId(userId: number): Promise<FreelancerRow | undefined> {
    const [rows] = await pool.query<FreelancerRow[]>(
      `SELECT pf.full_name, pf.avatar_url, pf.bio, pf.headline, pf.city, pf.state, pf.latitude, pf.longitude,
              pf.is_available, pf.available_days, pf.available_periods, pf.avg_rating, pf.total_reviews,
              pf.total_contracts, pf.response_time_hours, u.timezone
         FROM profiles_freelancer pf
         JOIN users u ON u.id = pf.user_id
        WHERE pf.user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async findClientByUserId(userId: number): Promise<ClientRow | undefined> {
    const [rows] = await pool.query<ClientRow[]>(
      `SELECT full_name, avatar_url, bio, city, state FROM profiles_client WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async findPublicFreelancerByUlid(ulid: string): Promise<PublicFreelancerRow | undefined> {
    const [rows] = await pool.query<PublicFreelancerRow[]>(
      `SELECT pf.full_name, pf.avatar_url, pf.bio, pf.headline, pf.city, pf.state,
              pf.latitude, pf.longitude, pf.is_available, pf.available_days, pf.available_periods,
              pf.avg_rating, pf.total_reviews, pf.total_contracts, pf.response_time_hours, u.timezone,
              u.id AS user_id, u.ulid, COALESCE(ux.level, 1) AS level, COALESCE(ux.level_name, 'Iniciante') AS level_name,
              COALESCE(ux.total_xp, 0) AS total_xp
         FROM users u
         JOIN profiles_freelancer pf ON pf.user_id = u.id
         LEFT JOIN user_xp ux ON ux.user_id = u.id
        WHERE u.ulid = :ulid AND u.deleted_at IS NULL LIMIT 1`,
      { ulid },
    );
    return rows[0];
  },

  // ---------- CPF do freelancer (RF-020, RN-009, RN-075) ----------

  async findCpf(userId: number): Promise<CpfRow | undefined> {
    const [rows] = await pool.query<CpfRow[]>(
      `SELECT cpf_verified, cpf_encrypted, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date,
              cpf_verified_at
         FROM profiles_freelancer WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  /** Algum dos índices (o da chave atual e os das antigas) já está em outra conta? */
  async cpfIndexTaken(indexes: string[], userId: number): Promise<boolean> {
    if (indexes.length === 0) return false;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM profiles_freelancer
        WHERE cpf_index IN (:indexes) AND user_id <> :userId LIMIT 1`,
      { indexes, userId },
    );
    return rows.length > 0;
  },

  /**
   * Grava o CPF validado, só se o perfil ainda não tem um: outra aba que validou no meio ganha, e
   * esta volta false. O mesmo CPF em outra conta estoura a chave única (ER_DUP_ENTRY), para o
   * service traduzir.
   */
  async saveVerifiedCpf(userId: number, d: VerifiedCpfData): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE profiles_freelancer
          SET cpf_encrypted = :sealedCpf, cpf_index = :index, birth_date = :birthDate,
              cpf_verified = 1, cpf_verified_at = :verifiedAt
        WHERE user_id = :userId AND cpf_verified = 0`,
      { userId, ...d },
    );
    return res.affectedRows > 0;
  },

  /** Apaga o CPF (o atendimento corrige um CPF errado, RF-020). Devolve se havia o que apagar. */
  async clearCpf(userId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE profiles_freelancer
          SET cpf_encrypted = NULL, cpf_index = NULL, birth_date = NULL, cpf_verified = 0,
              cpf_verified_at = NULL
        WHERE user_id = :userId AND (cpf_verified = 1 OR cpf_encrypted IS NOT NULL)`,
      { userId },
    );
    return res.affectedRows > 0;
  },

  /**
   * Para o saque (RF-020): a conta entrega trabalho pela mesma definição dos avisos (ADR 56: papel
   * freelancer, algum serviço, ou alguma contratação como freelancer) e o CPF está validado.
   */
  async payoutState(userId: number): Promise<PayoutStateRow | undefined> {
    const [rows] = await pool.query<PayoutStateRow[]>(
      `SELECT (u.role = 'freelancer'
               OR EXISTS (SELECT 1 FROM services s WHERE s.user_id = u.id)
               OR EXISTS (SELECT 1 FROM contracts c WHERE c.freelancer_id = u.id)) AS delivers_work,
              COALESCE(pf.cpf_verified, 0) AS cpf_verified
         FROM users u
         LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id
        WHERE u.id = :userId`,
      { userId },
    );
    return rows[0];
  },

  // ---------- Empresa (RF-018) ----------

  async findCompanyByUserId(userId: number): Promise<CompanyRow | undefined> {
    const [rows] = await pool.query<CompanyRow[]>(
      `SELECT ${COMPANY_COLS} FROM profiles_company pco WHERE pco.user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  /** A página pública: só de conta de empresa viva. */
  async findPublicCompanyByUlid(ulid: string): Promise<PublicCompanyRow | undefined> {
    const [rows] = await pool.query<PublicCompanyRow[]>(
      `SELECT ${COMPANY_COLS}, u.ulid, u.created_at
         FROM users u
         JOIN profiles_company pco ON pco.user_id = u.id
        WHERE u.ulid = :ulid AND u.role = 'company' AND u.deleted_at IS NULL LIMIT 1`,
      { ulid },
    );
    return rows[0];
  },

  /** O CNPJ já é de outra conta? (sem `userId`, de qualquer conta) */
  async cnpjTaken(cnpj: string, userId = 0): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM profiles_company WHERE cnpj = :cnpj AND user_id <> :userId LIMIT 1`,
      { cnpj, userId },
    );
    return rows.length > 0;
  },

  /** O perfil da empresa no cadastro. O CNPJ repetido estoura a chave única (ER_DUP_ENTRY). */
  async createCompany(userId: number, d: CompanyData): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_company (user_id, company_name, trade_name, cnpj)
       VALUES (:userId, :legalName, :tradeName, :cnpj)`,
      { userId, ...d },
    );
  },

  /**
   * Grava os dados da empresa. Cria a linha se faltar: conta de empresa aberta pela API antes da
   * 1.53.0 nasceu sem ela. O CNPJ de outra conta estoura a chave única (ER_DUP_ENTRY). Sem ON
   * DUPLICATE KEY UPDATE de propósito: com duas chaves únicas (user_id e cnpj), o CNPJ repetido
   * atualizaria a linha da OUTRA empresa. O UPDATE conta a linha encontrada mesmo sem mudança
   * (CLIENT_FOUND_ROWS, ligado por padrão no mysql2).
   */
  async upsertCompany(userId: number, d: CompanyDetails): Promise<void> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE profiles_company
          SET company_name = :legalName, trade_name = :tradeName, cnpj = :cnpj, logo_url = :logoUrl,
              bio = :bio, website = :website, city = :city, state = :state
        WHERE user_id = :userId`,
      { userId, ...d },
    );
    if (res.affectedRows > 0) return;
    await pool.query<ResultSetHeader>(
      `INSERT INTO profiles_company
         (user_id, company_name, trade_name, cnpj, logo_url, bio, website, city, state)
       VALUES (:userId, :legalName, :tradeName, :cnpj, :logoUrl, :bio, :website, :city, :state)`,
      { userId, ...d },
    );
  },

  /**
   * Badges conquistadas, da mais recente para a mais antiga (RF-015). Duas no mesmo segundo (a do
   * primeiro contrato e a dos critérios saem juntas) desempatam pela ordem de concessão, para as
   * 3 em destaque (RN-058) não trocarem de lugar a cada visita.
   */
  async listBadges(userId: number): Promise<PublicBadgeRow[]> {
    const [rows] = await pool.query<PublicBadgeRow[]>(
      `SELECT b.slug, b.name, ub.awarded_at
         FROM user_badges ub
         JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = :userId
        ORDER BY ub.awarded_at DESC, ub.id DESC`,
      { userId },
    );
    return rows;
  },
};
