import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { PublicCompanyProfile } from '@escambo/types';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dt } from '../../lib/format';
import { EmpresaView } from './EmpresaView';

/** Página pública da empresa (RF-018): o que quem contrata mostra de si. */

const api = vi.hoisted(() => ({ publicCompany: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const page = (o: Partial<PublicCompanyProfile> = {}): PublicCompanyProfile => ({
  legalName: 'Padaria Pão Bom Ltda',
  tradeName: 'Pão Bom',
  cnpj: '12ABC34501DE35',
  logoUrl: null,
  bio: 'Pães de fermentação natural desde 1998.',
  website: 'https://paobom.com.br/',
  city: 'Joinville',
  state: 'SC',
  userUlid: '01EMPRESA',
  memberSince: '2026-09-01T10:00:00.000Z',
  ...o,
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/empresas/01EMPRESA']}>
        <Routes>
          <Route path="/empresas/:ulid" element={<EmpresaView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => api.publicCompany.mockReset());

describe('EmpresaView', () => {
  it('logo, nome fantasia, razão social, selo, cidade, desde quando, descrição, CNPJ com máscara e site', async () => {
    api.publicCompany.mockResolvedValue(page());
    renderView();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pão Bom' })).toBeInTheDocument();
    expect(api.publicCompany).toHaveBeenCalledWith('01EMPRESA');
    expect(screen.getByText('Padaria Pão Bom Ltda')).toBeInTheDocument();
    expect(screen.getByText('Empresa')).toBeInTheDocument();
    expect(screen.getByText('Joinville, SC')).toBeInTheDocument();
    expect(
      screen.getByText(`no Escambo desde ${dt('2026-09-01T10:00:00.000Z')}`),
    ).toBeInTheDocument();
    expect(screen.getByText('Pães de fermentação natural desde 1998.')).toBeInTheDocument();
    expect(screen.getByTestId('company-cnpj')).toHaveTextContent('12.ABC.345/01DE-35');
    const site = screen.getByRole('link', { name: 'paobom.com.br' });
    expect(site).toHaveAttribute('href', 'https://paobom.com.br/');
    expect(site).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    expect(site).toHaveAttribute('target', '_blank');
    expect(document.title).toContain('Pão Bom');
  });

  it('sem site, sem descrição e sem cidade: só o que existe', async () => {
    api.publicCompany.mockResolvedValue(
      page({ website: null, bio: null, city: null, state: null }),
    );
    renderView();
    await screen.findByRole('heading', { level: 1, name: 'Pão Bom' });
    expect(screen.queryByText('Site')).not.toBeInTheDocument();
    expect(screen.queryByText(/Joinville/)).not.toBeInTheDocument();
  });

  it('site que não é http(s) não vira link', async () => {
    api.publicCompany.mockResolvedValue(page({ website: 'javascript:alert(1)' }));
    renderView();
    await screen.findByRole('heading', { level: 1, name: 'Pão Bom' });
    expect(screen.queryByRole('link', { name: /alert/ })).not.toBeInTheDocument();
  });

  it('empresa que não existe: o erro da API', async () => {
    api.publicCompany.mockRejectedValueOnce(new Error('Empresa não encontrada'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Empresa não encontrada');
  });
});
