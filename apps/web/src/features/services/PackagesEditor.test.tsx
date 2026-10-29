import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { Service, ServicePackage } from '@escambo/types';
import { describe, expect, it, vi } from 'vitest';
import { ServiceForm, type ServiceFormBody } from './ServiceForm';

/**
 * Pacotes no formulário do serviço (RF-086, RN-068): ligar, acrescentar e tirar níveis sem pular,
 * o preço que não desce do Básico ao Premium, os itens inclusos e o corpo que vai para a API.
 */

vi.mock('../../lib/account-access', () => ({ useReadOnlyAccount: () => false }));

const CATEGORIES = [{ id: 3, label: 'Design' }];

function renderForm(initial?: Service) {
  const onSubmit = vi.fn<(body: ServiceFormBody) => void>();
  render(
    <ServiceForm
      initial={initial}
      categories={CATEGORIES}
      minPrice={20}
      submitLabel="Publicar"
      pending={false}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
}

const toggle = () => screen.getByRole('checkbox', { name: /Oferecer pacotes/ });
const group = (name: string) => screen.getByRole('group', { name });
const inGroup = (name: string, label: RegExp | string) => within(group(name)).getByLabelText(label);

async function fillBasics(user: UserEvent): Promise<void> {
  await user.type(screen.getByLabelText('Título'), 'Identidade visual');
  await user.type(screen.getByLabelText('Descrição'), 'Logo, cores e manual da marca');
}

async function retype(user: UserEvent, field: HTMLElement, value: string): Promise<void> {
  await user.clear(field);
  await user.type(field, value);
}

const pkg = (tier: ServicePackage['tier'], price: number): ServicePackage => ({
  tier,
  name: `Nível ${tier}`,
  description: tier === 'basic' ? 'Só o logo' : null,
  price,
  deliveryDays: 3,
  revisions: 2,
  features: ['Logo'],
});

const service = (o: Partial<Service> = {}): Service => ({
  id: 9,
  categoryId: 3,
  ownerId: 1,
  title: 'Identidade visual',
  description: 'Logo, cores e manual da marca',
  priceType: 'fixed',
  price: 100,
  deliveryDays: 3,
  isRemote: true,
  modality: 'remote',
  tags: [],
  isActive: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  ...o,
});

describe('ServiceForm: pacotes', () => {
  it('só no preço fixo; ligar troca preço e prazo pelo Básico, que começa com os valores do formulário', async () => {
    const user = userEvent.setup({ delay: null });
    renderForm();
    await user.type(screen.getByLabelText(/^Preço \(R\$\)/), '120');
    await user.type(screen.getByLabelText('Prazo de entrega em dias (opcional)'), '4');
    await user.click(toggle());

    expect(screen.queryByLabelText('Prazo de entrega em dias (opcional)')).toBeNull();
    expect(screen.getByTestId('price-from-packages')).toBeVisible();
    expect(inGroup('Básico', 'Nome do pacote')).toHaveValue('Básico');
    expect(inGroup('Básico', /^Preço/)).toHaveValue(120);
    expect(inGroup('Básico', 'Prazo (dias)')).toHaveValue(4);
    expect(inGroup('Básico', 'Revisões incluídas')).toHaveValue('2');
    // O mínimo é o maior entre o do painel (20) e o da contratação (10).
    expect(inGroup('Básico', /^Preço/)).toHaveAccessibleName(/^Preço \(R\$\) · mínimo R\$\s20,00$/);

    await user.selectOptions(screen.getByLabelText('Tipo de preço'), 'hourly');
    expect(screen.queryByRole('checkbox', { name: /Oferecer pacotes/ })).toBeNull();
    expect(screen.queryByTestId('packages-editor')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Tipo de preço'), 'fixed');
    // Voltar ao fixo devolve os pacotes como estavam.
    expect(inGroup('Básico', /^Preço/)).toHaveValue(120);
  });

  it('acrescenta o nível seguinte, sem pular; só o último sai', async () => {
    const user = userEvent.setup({ delay: null });
    renderForm();
    await user.click(toggle());
    expect(screen.queryByRole('button', { name: /Remover o pacote/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Adicionar o pacote Padrão' }));
    expect(group('Padrão')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Adicionar o pacote Premium' }));
    expect(screen.queryByRole('button', { name: /^Adicionar o pacote/ })).toBeNull();
    expect(
      screen.getAllByRole('button', { name: /Remover o pacote/ }).map((b) => b.textContent),
    ).toEqual([' Remover o pacote Premium']);
    await user.click(screen.getByRole('button', { name: 'Remover o pacote Premium' }));
    expect(screen.queryByRole('group', { name: 'Premium' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remover o pacote Padrão' })).toBeVisible();
  });

  it('preço abaixo do nível de baixo: aviso ligado ao campo, e o mínimo do campo sobe para ele', async () => {
    const user = userEvent.setup({ delay: null });
    renderForm();
    await user.click(toggle());
    await retype(user, inGroup('Básico', /^Preço/), '100');
    await user.click(screen.getByRole('button', { name: 'Adicionar o pacote Padrão' }));
    const price = inGroup('Padrão', /^Preço/);
    expect(price).toHaveAttribute('min', '100');
    await user.type(price, '90');
    expect(price).toHaveAttribute('aria-invalid', 'true');
    expect(price).toHaveAccessibleDescription(
      /^O Padrão não pode custar menos que o Básico \(R\$\s100,00\)\.$/,
    );
    expect(within(group('Padrão')).getByRole('alert')).toBeVisible();
    await retype(user, price, '100');
    expect(price).not.toHaveAttribute('aria-invalid');
  });

  it('itens inclusos: Enter acrescenta, repetido (sem caixa) é recusado com o motivo, e o × tira', async () => {
    const user = userEvent.setup({ delay: null });
    renderForm();
    await user.click(toggle());
    const field = inGroup('Básico', 'Itens inclusos (opcional)');
    await user.type(field, '  Logo   vetorial {Enter}');
    const list = within(group('Básico')).getByRole('list', { name: 'Itens inclusos no Básico' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Logo vetorial']);
    expect(within(group('Básico')).getByRole('status')).toHaveTextContent(
      'Item adicionado ao Básico: Logo vetorial',
    );

    await user.type(field, 'LOGO VETORIAL{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(within(group('Básico')).getByRole('alert')).toHaveTextContent(
      '"LOGO VETORIAL" já está na lista.',
    );
    await user.clear(field);
    await user.type(field, 'x');
    await user.click(
      within(group('Básico')).getByRole('button', { name: 'Adicionar item ao Básico' }),
    );
    expect(within(group('Básico')).getByRole('alert')).toHaveTextContent(
      'Cada item tem de 2 a 80 caracteres.',
    );

    await user.click(screen.getByRole('button', { name: 'Remover o item Logo vetorial' }));
    expect(within(group('Básico')).queryByRole('list')).toBeNull();
    expect(field).toHaveFocus();
  });

  it('o cadastro manda os pacotes, sem preço nem prazo do anúncio (saem do Básico)', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = renderForm();
    await fillBasics(user);
    await user.click(toggle());
    await retype(user, inGroup('Básico', 'Nome do pacote'), 'Essencial');
    await user.type(inGroup('Básico', 'O que entrega (opcional)'), '  Um conceito  ');
    await user.type(inGroup('Básico', /^Preço/), '100');
    await user.type(inGroup('Básico', 'Prazo (dias)'), '3');
    await user.click(screen.getByRole('button', { name: 'Adicionar o pacote Padrão' }));
    await user.type(inGroup('Padrão', /^Preço/), '200.5');
    await user.clear(inGroup('Padrão', 'Prazo (dias)'));
    await user.type(inGroup('Padrão', 'Prazo (dias)'), '5');
    await user.selectOptions(inGroup('Padrão', 'Revisões incluídas'), '4');
    await user.type(inGroup('Padrão', 'Itens inclusos (opcional)'), 'Manual{Enter}');
    await user.click(screen.getByRole('button', { name: 'Publicar' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      priceType: 'fixed',
      price: null,
      deliveryDays: null,
      packages: [
        {
          tier: 'basic',
          name: 'Essencial',
          description: 'Um conceito',
          price: 100,
          deliveryDays: 3,
          revisions: 2,
          features: [],
        },
        {
          tier: 'standard',
          name: 'Padrão',
          description: null,
          price: 200.5,
          deliveryDays: 5,
          revisions: 4,
          features: ['Manual'],
        },
      ],
    });
  });

  it('sem pacotes, o cadastro nem manda a chave', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = renderForm();
    await fillBasics(user);
    await user.type(screen.getByLabelText(/^Preço \(R\$\)/), '120');
    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('packages');
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ price: 120 });
  });

  it('na edição, os pacotes do serviço abrem ligados; desligar manda [] e o preço do campo', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = renderForm(
      service({ packages: [pkg('standard', 200), pkg('basic', 100)], price: 100 }),
    );
    expect(toggle()).toBeChecked();
    // Em ordem, do Básico ao Padrão, com o que estava gravado.
    expect(inGroup('Básico', 'O que entrega (opcional)')).toHaveValue('Só o logo');
    expect(inGroup('Padrão', /^Preço/)).toHaveValue(200);
    expect(
      within(group('Padrão')).getByRole('list', { name: 'Itens inclusos no Padrão' }),
    ).toHaveTextContent('Logo');

    await user.click(toggle());
    expect(screen.getByLabelText(/^Preço \(R\$\)/)).toHaveValue(100);
    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ price: 100, packages: [] });
  });

  it('na edição, mudar só o título de um serviço com pacotes manda os pacotes de novo, sem preço', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = renderForm(service({ packages: [pkg('basic', 100)] }));
    await user.type(screen.getByLabelText('Título'), ' completa');
    await user.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      title: 'Identidade visual completa',
      price: null,
      deliveryDays: null,
      packages: [{ tier: 'basic', price: 100, features: ['Logo'] }],
    });
  });
});
