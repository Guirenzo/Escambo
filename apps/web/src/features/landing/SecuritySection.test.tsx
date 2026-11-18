import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SecuritySection } from './SecuritySection';

/**
 * A segurança da conta na página inicial (#78, pedida na validação do PAC VIII). Cada linha diz só
 * o que o sistema faz; a do cartão muda com o gateway dos depósitos (Mercado Pago ou PIX simulado).
 */

function renderSection(mercadoPago = false) {
  return render(
    <MemoryRouter>
      <SecuritySection mercadoPago={mercadoPago} />
    </MemoryRouter>,
  );
}

const rows = (): HTMLElement[] =>
  within(screen.getByRole('list')).getAllByRole('listitem') as HTMLElement[];

describe('SecuritySection', () => {
  it('é uma região com o título h2 como nome e a âncora #seguranca', () => {
    renderSection();
    const region = screen.getByRole('region', { name: 'Sua conta e o seu dinheiro, trancados' });
    expect(region).toHaveAttribute('id', 'seguranca');
    expect(
      within(region).getByRole('heading', {
        level: 2,
        name: 'Sua conta e o seu dinheiro, trancados',
      }),
    ).toBeInTheDocument();
  });

  it('quatro linhas, cada uma com título h3 e carimbo; só a verificação em duas etapas é opcional', () => {
    renderSection();
    const items = rows();
    expect(items.map((li) => within(li).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Cartão fora do Escambo',
      'Aviso a cada mudança na conta',
      'CPF e dados de saque cifrados',
      'Verificação em duas etapas',
    ]);
    const stamps = items.map((li) => li.querySelector('.lp-sec-stamp')?.textContent);
    expect(stamps).toEqual(['Sempre', 'Sempre', 'Sempre', 'Opcional']);
  });

  it('com o Mercado Pago, o cartão é digitado na página dele', () => {
    renderSection(true);
    expect(rows()[0]).toHaveTextContent(/página do Mercado Pago/);
    expect(rows()[0]).not.toHaveTextContent(/por PIX/);
  });

  it('com o gateway simulado, o depósito é por PIX e o Mercado Pago não aparece', () => {
    renderSection(false);
    expect(rows()[0]).toHaveTextContent(/por PIX/);
    expect(screen.queryByText(/Mercado Pago/)).not.toBeInTheDocument();
  });

  it('leva à Política de Privacidade e aos Termos de Uso', () => {
    renderSection();
    expect(screen.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade',
    );
    expect(screen.getByRole('link', { name: 'Termos de Uso' })).toHaveAttribute('href', '/termos');
  });

  it('o título da ficha é decorativo: a lista já é lida pelos títulos das linhas', () => {
    renderSection();
    expect(screen.getByText('Ficha de segurança da conta')).toHaveAttribute('aria-hidden', 'true');
  });
});
