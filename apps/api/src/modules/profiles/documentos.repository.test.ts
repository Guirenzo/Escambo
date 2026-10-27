import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { profilesRepository } from './profiles.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const COMPANY = {
  legalName: 'Padaria Pão Bom Ltda',
  tradeName: 'Pão Bom',
  cnpj: '12ABC34501DE35',
};
const DETAILS = {
  ...COMPANY,
  logoUrl: null,
  bio: 'Pães de fermentação natural.',
  website: 'https://paobom.com.br/',
  city: 'Joinville',
  state: 'SC',
};

/**
 * Documentos no repository dos perfis (RF-018, RF-020), sem banco: o SQL de cada método e o que faz
 * com a resposta. Se a chave única recusa de verdade é assunto da integração (documentos.int).
 */
describe('profilesRepository: documentos', () => {
  beforeEach(() => fakeDb.reset());

  describe('CPF (RF-020)', () => {
    it('findCpf lê o CPF cifrado, a data como texto (sem o Date do driver) e a validação, do perfil de freelancer', async () => {
      const row = { cpf_verified: 1, cpf_encrypted: 'enc:v1:...', birth_date: '1990-05-17' };
      fakeDb.reply([row], []);

      expect(await profilesRepository.findCpf(7)).toBe(row);
      expect(await profilesRepository.findCpf(8)).toBeUndefined();
      expect(fakeDb.calls[0]!.sql).toBe(
        "SELECT cpf_verified, cpf_encrypted, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date, cpf_verified_at FROM profiles_freelancer WHERE user_id = :userId LIMIT 1",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('cpfIndexTaken procura os índices em outra conta, e sem índice nem consulta', async () => {
      fakeDb.reply([{ 1: 1 }], []);

      expect(await profilesRepository.cpfIndexTaken(['a', 'b'], 7)).toBe(true);
      expect(await profilesRepository.cpfIndexTaken(['a'], 7)).toBe(false);
      expect(await profilesRepository.cpfIndexTaken([], 7)).toBe(false);
      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT 1 FROM profiles_freelancer WHERE cpf_index IN (:indexes) AND user_id <> :userId LIMIT 1',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ indexes: ['a', 'b'], userId: 7 });
    });

    it('saveVerifiedCpf grava tudo num UPDATE só, e só se o perfil ainda não tem CPF validado', async () => {
      const at = new Date('2026-10-26T12:00:00.000Z');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });
      const data = {
        sealedCpf: 'enc:v1:x',
        index: 'f'.repeat(64),
        birthDate: '1990-05-17',
        verifiedAt: at,
      };

      expect(await profilesRepository.saveVerifiedCpf(7, data)).toBe(true);
      expect(await profilesRepository.saveVerifiedCpf(7, data)).toBe(false);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE profiles_freelancer SET cpf_encrypted = :sealedCpf, cpf_index = :index, birth_date = :birthDate, cpf_verified = 1, cpf_verified_at = :verifiedAt WHERE user_id = :userId AND cpf_verified = 0',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, ...data });
    });

    it('clearCpf apaga o CPF, o índice e a data; false quando não havia CPF', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await profilesRepository.clearCpf(7)).toBe(true);
      expect(await profilesRepository.clearCpf(7)).toBe(false);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE profiles_freelancer SET cpf_encrypted = NULL, cpf_index = NULL, birth_date = NULL, cpf_verified = 0, cpf_verified_at = NULL WHERE user_id = :userId AND (cpf_verified = 1 OR cpf_encrypted IS NOT NULL)',
      );
    });

    it('payoutState: quem entrega trabalho pela definição do ADR 56, e o CPF validado do perfil (0 sem perfil)', async () => {
      const row = { delivers_work: 1, cpf_verified: 0 };
      fakeDb.reply([row]);

      expect(await profilesRepository.payoutState(7)).toBe(row);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        "SELECT (u.role = 'freelancer' OR EXISTS (SELECT 1 FROM services s WHERE s.user_id = u.id) OR EXISTS (SELECT 1 FROM contracts c WHERE c.freelancer_id = u.id)) AS delivers_work",
      );
      expect(sql).toContain('COALESCE(pf.cpf_verified, 0) AS cpf_verified');
      expect(sql).toContain(
        'LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id WHERE u.id = :userId',
      );
      expect(params).toEqual({ userId: 7 });
    });
  });

  describe('empresa (RF-018)', () => {
    it('findCompanyByUserId: a razão social, o nome fantasia, o CNPJ e o resto do perfil', async () => {
      fakeDb.reply([{ company_name: 'X' }]);
      await profilesRepository.findCompanyByUserId(7);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT pco.company_name, pco.trade_name, pco.cnpj, pco.logo_url, pco.bio, pco.website, pco.city, pco.state FROM profiles_company pco WHERE pco.user_id = :userId LIMIT 1',
      );
    });

    it('findPublicCompanyByUlid: só conta de empresa que não foi apagada', async () => {
      fakeDb.reply([]);
      expect(await profilesRepository.findPublicCompanyByUlid('01X')).toBeUndefined();
      expect(fakeDb.calls[0]!.sql).toContain(
        "WHERE u.ulid = :ulid AND u.role = 'company' AND u.deleted_at IS NULL LIMIT 1",
      );
      expect(fakeDb.calls[0]!.sql).toContain('pco.state, u.ulid, u.created_at FROM users u');
    });

    it('cnpjTaken: de outra conta (ou de qualquer uma, no cadastro)', async () => {
      fakeDb.reply([{ 1: 1 }], []);

      expect(await profilesRepository.cnpjTaken('12ABC34501DE35', 7)).toBe(true);
      expect(await profilesRepository.cnpjTaken('12ABC34501DE35')).toBe(false);
      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT 1 FROM profiles_company WHERE cnpj = :cnpj AND user_id <> :userId LIMIT 1',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ cnpj: '12ABC34501DE35', userId: 0 });
    });

    it('createCompany: a razão social em company_name e o nome fantasia em trade_name', async () => {
      fakeDb.reply({ affectedRows: 1 });
      await profilesRepository.createCompany(7, COMPANY);
      expect(fakeDb.calls[0]!.sql).toBe(
        'INSERT INTO profiles_company (user_id, company_name, trade_name, cnpj) VALUES (:userId, :legalName, :tradeName, :cnpj)',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, ...COMPANY });
    });

    it('upsertCompany: atualiza a linha da conta; sem ON DUPLICATE KEY (o CNPJ de outra empresa não pode virar UPDATE dela)', async () => {
      fakeDb.reply({ affectedRows: 1 });

      await profilesRepository.upsertCompany(7, DETAILS);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE profiles_company SET company_name = :legalName, trade_name = :tradeName, cnpj = :cnpj, logo_url = :logoUrl, bio = :bio, website = :website, city = :city, state = :state WHERE user_id = :userId',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, ...DETAILS });
      expect(fakeDb.calls[0]!.sql).not.toContain('ON DUPLICATE KEY');
    });

    it('upsertCompany: conta de empresa sem a linha (anterior à 1.53.0) ganha a linha', async () => {
      fakeDb.reply({ affectedRows: 0 }, { affectedRows: 1 });

      await profilesRepository.upsertCompany(7, DETAILS);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[1]!.sql).toBe(
        'INSERT INTO profiles_company (user_id, company_name, trade_name, cnpj, logo_url, bio, website, city, state) VALUES (:userId, :legalName, :tradeName, :cnpj, :logoUrl, :bio, :website, :city, :state)',
      );
      expect(fakeDb.calls[1]!.sql).not.toContain('ON DUPLICATE KEY');
    });
  });
});
