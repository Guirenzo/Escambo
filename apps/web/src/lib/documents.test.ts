import type { MyProfiles } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import {
  formatCnpj,
  formatCpfTyping,
  isValidCnpj,
  identityName,
  isValidCpf,
  normalizeCnpj,
  profileIdentity,
} from './documents';

/** A mesma conferência de formato da API, para avisar no campo antes de enviar (RF-018, RF-020). */
describe('documentos na tela', () => {
  it('CPF: com ou sem máscara, dígitos certos; todos iguais, curto, com letra ou dígito errado não', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('123.456.789-09')).toBe(true);
    for (const bad of ['529.982.247-24', '111.111.111-11', '5299822472', '529982247a5', '']) {
      expect(isValidCpf(bad), bad).toBe(false);
    }
  });

  it('a máscara do CPF acompanha a digitação e ignora o que não é dígito', () => {
    expect(formatCpfTyping('529')).toBe('529');
    expect(formatCpfTyping('5299')).toBe('529.9');
    expect(formatCpfTyping('5299822')).toBe('529.982.2');
    expect(formatCpfTyping('529982247')).toBe('529.982.247');
    expect(formatCpfTyping('52998224725')).toBe('529.982.247-25');
    expect(formatCpfTyping('529.982.247-2599')).toBe('529.982.247-25');
    expect(formatCpfTyping('abc')).toBe('');
  });

  it('CNPJ: numérico e alfanumérico (IN RFB 2.229/2024), com ou sem máscara, em qualquer caixa', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12abc34501de35')).toBe(true);
    for (const bad of [
      '11.222.333/0001-82',
      '12ABC34501DE36',
      '00000000000000',
      '12ABC34501DE3',
      '',
    ]) {
      expect(isValidCnpj(bad), bad).toBe(false);
    }
    expect(normalizeCnpj(' 12.abc.345/01de-35 ')).toBe('12ABC34501DE35');
    expect(normalizeCnpj('12_ABC')).toBeNull();
  });

  it('a máscara do CNPJ; o que não tem 14 caracteres sai como veio', () => {
    expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(formatCnpj('')).toBe('');
    expect(formatCnpj('123')).toBe('123');
  });

  it('quem está logado: a empresa (nome fantasia e logo) vem antes; senão o freelancer, senão o cliente', () => {
    const company = {
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj: '12ABC34501DE35',
      logoUrl: '/api/media/logo.webp',
      bio: null,
      website: null,
      city: null,
      state: null,
    };
    const client = { fullName: 'Ana', avatarUrl: '/a.png', bio: null, city: null, state: null };
    expect(profileIdentity({ freelancer: null, client, company } as MyProfiles)).toEqual({
      name: 'Pão Bom',
      avatarUrl: '/api/media/logo.webp',
    });
    expect(profileIdentity({ freelancer: null, client, company: null } as MyProfiles)).toEqual({
      name: 'Ana',
      avatarUrl: '/a.png',
    });
    expect(profileIdentity(undefined)).toEqual({ name: undefined, avatarUrl: null });
    // O nome curto: o primeiro nome da pessoa, o nome fantasia inteiro da empresa.
    expect(identityName({ freelancer: null, client, company } as MyProfiles, 'x@y.test')).toBe(
      'Pão Bom',
    );
    expect(
      identityName(
        {
          freelancer: null,
          client: { ...client, fullName: 'Ana Souza' },
          company: null,
        } as MyProfiles,
        'x@y.test',
      ),
    ).toBe('Ana');
    expect(identityName(undefined, 'conta@escambo.test')).toBe('conta');
  });
});
