import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CompanyProfile } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { EmpresaCard } from './EmpresaCard';

/**
 * Dados da empresa no Perfil (RF-018): os do cadastro (razão social, nome fantasia, CNPJ) e o logo,
 * o site, a descrição curta e a cidade. O CNPJ aparece com máscara e é conferido antes de enviar.
 */

const api = vi.hoisted(() => ({ putCompanyProfile: vi.fn(), uploadMedia: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const company = (o: Partial<CompanyProfile> = {}): CompanyProfile => ({
  legalName: 'Padaria Pão Bom Ltda',
  tradeName: 'Pão Bom',
  cnpj: '12ABC34501DE35',
  logoUrl: null,
  bio: null,
  website: null,
  city: 'Joinville',
  state: 'SC',
  ...o,
});

function renderCard(c: CompanyProfile | null = company()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <EmpresaCard company={c} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.putCompanyProfile.mockReset();
  api.uploadMedia.mockReset();
});

describe('EmpresaCard', () => {
  it('vem preenchido, com o CNPJ mascarado e o envio de logo', () => {
    renderCard();
    expect(screen.getByRole('form', { name: 'Empresa' })).toHaveAttribute('id', 'dados-empresa');
    expect(screen.getByLabelText('Razão social')).toHaveValue('Padaria Pão Bom Ltda');
    expect(screen.getByLabelText('Nome fantasia (o nome que os freelancers veem)')).toHaveValue(
      'Pão Bom',
    );
    expect(screen.getByLabelText('CNPJ')).toHaveValue('12.ABC.345/01DE-35');
    expect(screen.getByLabelText('CNPJ')).toHaveAccessibleDescription(
      'Com ou sem pontos, barra e hífen. Vale também o CNPJ com letras (alfanumérico). O CNPJ é público: aparece na página da empresa.',
    );
    expect(screen.getByRole('button', { name: /Enviar logo/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição curta (até 280 caracteres)')).toHaveAttribute(
      'maxlength',
      '280',
    );
  });

  it('salva tudo; vazio vira null e a UF vai em maiúsculas; o CNPJ volta com máscara', async () => {
    const user = userEvent.setup();
    api.putCompanyProfile.mockResolvedValue(
      company({ website: 'https://paobom.com.br/', bio: 'Pães naturais.' }),
    );
    renderCard();
    await user.type(screen.getByLabelText('Site'), 'https://paobom.com.br');
    await user.type(
      screen.getByLabelText('Descrição curta (até 280 caracteres)'),
      '  Pães naturais.  ',
    );
    await user.clear(screen.getByLabelText('Cidade'));
    await user.clear(screen.getByLabelText('Estado (UF)'));
    await user.type(screen.getByLabelText('Estado (UF)'), 'sc');
    await user.click(screen.getByRole('button', { name: 'Salvar empresa' }));

    expect(api.putCompanyProfile).toHaveBeenCalledWith({
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj: '12.ABC.345/01DE-35',
      logoUrl: null,
      website: 'https://paobom.com.br',
      bio: 'Pães naturais.',
      city: null,
      state: 'SC',
    });
    expect(await screen.findByText('Dados da empresa salvos!')).toBeInTheDocument();
    expect(screen.getByLabelText('Site')).toHaveValue('https://paobom.com.br/');
  });

  it('CNPJ com dígito errado avisa no campo e não vai à API', async () => {
    const user = userEvent.setup();
    renderCard();
    const cnpj = screen.getByLabelText('CNPJ');
    await user.clear(cnpj);
    await user.type(cnpj, '12.ABC.345/01DE-36');
    await user.click(screen.getByRole('button', { name: 'Salvar empresa' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CNPJ inválido: confira os 14 caracteres e os dois dígitos verificadores.',
    );
    expect(cnpj).toHaveAttribute('aria-invalid', 'true');
    expect(cnpj).toHaveFocus();
    expect(api.putCompanyProfile).not.toHaveBeenCalled();
  });

  it('a recusa da API (CNPJ de outra conta) aparece no cartão', async () => {
    const user = userEvent.setup();
    api.putCompanyProfile.mockRejectedValue(
      Object.assign(new Error('Este CNPJ já está em outra conta do Escambo.'), {
        name: 'ApiRequestError',
      }),
    );
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Salvar empresa' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este CNPJ já está em outra conta do Escambo.',
    );
  });

  it('conta de empresa sem os dados (aberta antes da 1.53.0): o cartão vem vazio', () => {
    renderCard(null);
    expect(screen.getByLabelText('Razão social')).toHaveValue('');
    expect(screen.getByLabelText('CNPJ')).toHaveValue('');
  });
});
