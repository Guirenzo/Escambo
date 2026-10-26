import { describe, expect, it } from 'vitest';
import {
  derivePackageListing,
  packageFromRow,
  packageFromSnapshot,
  packagesSchema,
  parseFeatures,
} from './service-packages';

/** Pacotes do serviço (RF-086, RN-068): a validação da API, a ordem e o que o anúncio guarda. */

const basic = { tier: 'basic', name: 'Essencial', price: 100, deliveryDays: 5 };
const standard = { tier: 'standard', name: 'Completo', price: 200, deliveryDays: 7 };
const premium = { tier: 'premium', name: 'Sob medida', price: 350, deliveryDays: 10 };

const messages = (input: unknown): string[] => {
  const parsed = packagesSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe('pacotes do serviço: o schema', () => {
  it('completa revisões (2) e itens ([]), tira espaço do nome e deixa a descrição vazia como null', () => {
    expect(packagesSchema.parse([{ ...basic, name: '  Essencial  ', description: '   ' }])).toEqual(
      [
        {
          tier: 'basic',
          name: 'Essencial',
          description: null,
          price: 100,
          deliveryDays: 5,
          revisions: 2,
          features: [],
        },
      ],
    );
  });

  it('sai do Básico ao Premium, seja qual for a ordem enviada', () => {
    expect(packagesSchema.parse([premium, basic, standard]).map((p) => p.tier)).toEqual([
      'basic',
      'standard',
      'premium',
    ]);
  });

  it('lista vazia vale (tira os pacotes); mais de 3 é recusado (RN-068)', () => {
    expect(packagesSchema.parse([])).toEqual([]);
    expect(messages([basic, standard, premium, { ...premium, name: 'Outro' }])).toContain(
      'No máximo 3 pacotes por serviço (RN-068)',
    );
  });

  it('o Básico é obrigatório, o Premium exige o Padrão e cada nível vem uma vez só', () => {
    expect(messages([standard])).toEqual(['O pacote Básico é obrigatório (RN-068)']);
    expect(messages([basic, premium])).toEqual([
      'O pacote Premium exige o Padrão: os níveis não pulam (RN-068)',
    ]);
    expect(messages([basic, { ...basic, name: 'Outro básico' }])).toEqual([
      'Pacote Básico repetido: um pacote por nível',
    ]);
  });

  it('nome de 3 a 60, descrição até 600, prazo de 1 a 365 dias inteiros e revisões de 1 a 10', () => {
    expect(messages([{ ...basic, name: 'ab' }])).toEqual([
      'O nome do pacote tem de 3 a 60 caracteres',
    ]);
    expect(messages([{ ...basic, name: 'a'.repeat(61) }])).toHaveLength(1);
    expect(messages([{ ...basic, description: 'x'.repeat(601) }])).toEqual([
      'A descrição do pacote vai até 600 caracteres',
    ]);
    expect(messages([{ ...basic, deliveryDays: 0 }])).toEqual([
      'O prazo do pacote é de pelo menos 1 dia',
    ]);
    expect(messages([{ ...basic, deliveryDays: 366 }])).toEqual([
      'O prazo do pacote vai até 365 dias',
    ]);
    expect(messages([{ ...basic, deliveryDays: 2.5 }])).toEqual([
      'O prazo do pacote é um número inteiro de dias',
    ]);
    expect(messages([{ ...basic, revisions: 0 }])).toEqual([
      'Cada pacote inclui de 1 a 10 revisões (RN-023)',
    ]);
    expect(messages([{ ...basic, revisions: 11 }])).toEqual([
      'Cada pacote inclui de 1 a 10 revisões (RN-023)',
    ]);
    expect(packagesSchema.parse([{ ...basic, revisions: 10 }])[0]!.revisions).toBe(10);
  });

  it('preço positivo, ao centavo e até o teto de DECIMAL(10,2)', () => {
    expect(messages([{ ...basic, price: 0 }])).toEqual([
      'O preço do pacote precisa ser maior que zero',
    ]);
    expect(messages([{ ...basic, price: 10.005 }])).toEqual([
      'O preço vai até os centavos: no máximo duas casas decimais',
    ]);
    expect(messages([{ ...basic, price: 100_000_000 }])).toEqual([
      'O valor máximo é R$ 99.999.999,99',
    ]);
    expect(packagesSchema.parse([{ ...basic, price: 99.9 }])[0]!.price).toBe(99.9);
  });

  it('itens: até 10, de 2 a 80 caracteres, espaços reduzidos e sem repetir ignorando a caixa', () => {
    expect(
      packagesSchema.parse([{ ...basic, features: ['  Logo   vetorial ', 'Arquivo PNG'] }])[0]!
        .features,
    ).toEqual(['Logo vetorial', 'Arquivo PNG']);
    expect(messages([{ ...basic, features: ['Logo', 'LOGO'] }])).toEqual(['Item repetido: "LOGO"']);
    expect(messages([{ ...basic, features: ['x'] }])).toEqual([
      'Cada item incluso tem de 2 a 80 caracteres',
    ]);
    expect(messages([{ ...basic, features: ['y'.repeat(81)] }])).toHaveLength(1);
    expect(
      messages([{ ...basic, features: Array.from({ length: 11 }, (_, i) => `Item ${i}`) }]),
    ).toEqual(['No máximo 10 itens inclusos por pacote']);
  });

  it('chave desconhecida e nível fora da lista são 422 (o corpo não grava o que não conhece)', () => {
    expect(packagesSchema.safeParse([{ ...basic, isActive: false }]).success).toBe(false);
    expect(messages([{ ...basic, tier: 'gold' }])).toContain(
      'Nível do pacote: basic, standard ou premium',
    );
  });
});

describe('pacotes do serviço: o que o anúncio guarda e o que volta do banco', () => {
  it('o preço e o prazo do anúncio são os do Básico, mesmo fora de ordem', () => {
    const pkgs = packagesSchema.parse([basic, standard]);
    expect(derivePackageListing([...pkgs].reverse())).toEqual({ price: 100, deliveryDays: 5 });
    expect(() => derivePackageListing([])).toThrow();
  });

  it('a linha do banco vira o pacote da API: DECIMAL em número e o JSON dos itens lido ou em texto', () => {
    const row = {
      tier: 'standard',
      name: 'Completo',
      description: null,
      price: '200.50',
      delivery_days: 7,
      revisions: 3,
      features: '["Logo","Manual"]',
    };
    expect(packageFromRow(row)).toEqual({
      tier: 'standard',
      name: 'Completo',
      description: null,
      price: 200.5,
      deliveryDays: 7,
      revisions: 3,
      features: ['Logo', 'Manual'],
    });
    expect(packageFromRow({ ...row, features: ['Logo'] }).features).toEqual(['Logo']);
    expect(packageFromRow({ ...row, features: null }).features).toEqual([]);
  });

  it('itens ilegíveis viram lista vazia, nunca erro na leitura', () => {
    expect(parseFeatures('{quebrado')).toEqual([]);
    expect(parseFeatures('{"a":1}')).toEqual([]);
    expect(parseFeatures(['ok', 3, null])).toEqual(['ok']);
  });

  it('a cópia guardada na contratação volta como pacote; o que não é pacote vale como sem pacote', () => {
    const snapshot = {
      tier: 'premium',
      name: 'Sob medida',
      description: 'Tudo',
      price: 350,
      deliveryDays: 10,
      revisions: 5,
      features: ['Logo'],
    };
    expect(packageFromSnapshot(snapshot)).toEqual(snapshot);
    expect(packageFromSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(packageFromSnapshot({ ...snapshot, description: 3 })).toEqual({
      ...snapshot,
      description: null,
    });
    expect(packageFromSnapshot(null)).toBeNull();
    expect(packageFromSnapshot('{quebrado')).toBeNull();
    expect(packageFromSnapshot({ ...snapshot, tier: 'gold' })).toBeNull();
    expect(packageFromSnapshot({ ...snapshot, price: 'caro' })).toBeNull();
    expect(packageFromSnapshot(7)).toBeNull();
  });
});
