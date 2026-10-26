import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ServicePackage } from '@escambo/types';
import { describe, expect, it, vi } from 'vitest';
import { PackageCompare, PackagePicker } from './PackagePicker';

/**
 * Os pacotes no detalhe do serviço (RF-086): abas com o padrão do ARIA (setas, Home e End), o
 * painel do nível e "Continuar" com o nível; e a tabela "Comparar pacotes", com os itens de todos.
 */

vi.mock('../../lib/account-access', () => ({ useReadOnlyAccount: () => false }));

const pkg = (
  tier: ServicePackage['tier'],
  price: number,
  deliveryDays: number,
  features: string[],
  revisions = 2,
): ServicePackage => ({
  tier,
  name: { basic: 'Logo essencial', standard: 'Logo + paleta', premium: 'Identidade completa' }[
    tier
  ],
  description: tier === 'basic' ? 'Um conceito de logo.' : null,
  price,
  deliveryDays,
  revisions,
  features,
});
const THREE = [
  pkg('basic', 150, 3, ['1 conceito de logo', 'Arquivo PNG']),
  pkg('standard', 320, 5, ['2 conceitos de logo', 'Arquivo PNG', 'Paleta de cores'], 3),
  pkg('premium', 649.9, 1, ['Arquivo PNG', 'Paleta de cores', 'Manual da marca'], 5),
];

const tab = (name: string) => screen.getByRole('tab', { name });

describe('PackagePicker', () => {
  it('uma aba por nível, ligada ao seu painel; o Básico abre selecionado e só ele entra no Tab', () => {
    render(<PackagePicker packages={THREE} onContinue={vi.fn()} />);
    const list = screen.getByRole('tablist', { name: 'Pacotes' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Básico', 'Padrão', 'Premium']);
    expect(tab('Básico')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Básico')).toHaveAttribute('tabindex', '0');
    expect(tab('Padrão')).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel', { name: 'Básico' });
    expect(tab('Básico')).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByRole('heading', { level: 3 })).toHaveTextContent(
      'BásicoLogo essencial',
    );
    expect(within(panel).getByText('R$ 150,00')).toBeVisible();
    expect(within(panel).getByText('Um conceito de logo.')).toBeVisible();
    expect(within(panel).getByText(/Entrega em 3 dias/)).toBeVisible();
    expect(within(panel).getByText(/2 revisões sem custo/)).toBeVisible();
    expect(
      within(within(panel).getByRole('list', { name: 'O que o Básico inclui' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toEqual(['1 conceito de logo', 'Arquivo PNG']);
  });

  it('setas, Home e End trocam de aba e mostram o painel dela (ativação automática)', () => {
    render(<PackagePicker packages={THREE} onContinue={vi.fn()} />);
    const list = screen.getByRole('tablist');
    tab('Básico').focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tab('Padrão')).toHaveFocus();
    expect(tab('Padrão')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Padrão' })).toHaveTextContent('R$ 320,00');
    fireEvent.keyDown(list, { key: 'End' });
    expect(tab('Premium')).toHaveFocus();
    // Prazo de 1 dia no singular; 5 revisões no plural.
    expect(screen.getByRole('tabpanel', { name: 'Premium' })).toHaveTextContent('Entrega em 1 dia');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tab('Básico')).toHaveFocus();
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(tab('Premium')).toHaveFocus();
    fireEvent.keyDown(list, { key: 'Home' });
    expect(tab('Básico')).toHaveAttribute('aria-selected', 'true');
    // Só um painel à vista.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('"Continuar" leva o nível da aba, com o valor no botão e o nível para o leitor de tela', async () => {
    const user = userEvent.setup({ delay: null });
    const onContinue = vi.fn();
    render(
      <PackagePicker packages={THREE} onContinue={onContinue} extra={<a href="#t">Troca</a>} />,
    );
    await user.click(tab('Premium'));
    const go = screen.getByRole('button', {
      name: /^Continuar \(R\$\s649,90\) com o pacote Premium$/,
    });
    await user.click(go);
    expect(onContinue).toHaveBeenCalledWith('premium');
    expect(screen.getByRole('link', { name: 'Troca' })).toBeVisible();
  });

  it('sem poder contratar (dono, pausado), o aviso fica no lugar do botão', () => {
    render(<PackagePicker packages={THREE} notice={<p>Este serviço é seu.</p>} />);
    expect(screen.queryByRole('button', { name: /Continuar/ })).toBeNull();
    expect(screen.getByText('Este serviço é seu.')).toBeVisible();
  });

  it('um pacote só: sem abas nem link de comparação', () => {
    render(<PackagePicker packages={THREE.slice(0, 1)} onContinue={vi.fn()} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Pacote' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Comparar pacotes' })).toBeNull();
    expect(screen.getByRole('button', { name: /Continuar \(R\$\s150,00\)/ })).toBeVisible();
  });

  it('"Comparar pacotes" leva o foco à tabela sem mudar a URL', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <>
        <PackagePicker packages={THREE} onContinue={vi.fn()} />
        <PackageCompare packages={THREE} />
      </>,
    );
    await user.click(screen.getByRole('link', { name: 'Comparar pacotes' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Comparar pacotes' })).toHaveFocus();
    expect(window.location.hash).toBe('');
  });

  it('lista vazia não desenha nada', () => {
    const { container } = render(<PackagePicker packages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PackageCompare', () => {
  it('uma coluna por nível; preço, entrega, revisões e cada item de todos, com ✓ ou traço legível', () => {
    render(<PackageCompare packages={THREE} />);
    const table = within(
      screen.getByRole('region', { name: 'Tabela de comparação dos pacotes' }),
    ).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'Item',
      'BásicoLogo essencial',
      'PadrãoLogo + paleta',
      'PremiumIdentidade completa',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (i: number) =>
      within(rows[i]!)
        .getAllByRole('cell')
        // O R$ do Intl vem com espaço inseparável.
        .map((c) => c.textContent?.replace(/\s/g, ' '));
    expect(within(rows[0]!).getByRole('rowheader')).toHaveTextContent('Preço');
    expect(cells(0)).toEqual(['R$ 150,00', 'R$ 320,00', 'R$ 649,90']);
    expect(cells(1)).toEqual(['3 dias', '5 dias', '1 dia']);
    expect(cells(2)).toEqual(['2', '3', '5']);
    // Os itens na ordem em que aparecem, sem repetir.
    expect(rows.slice(3).map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      '1 conceito de logo',
      'Arquivo PNG',
      '2 conceitos de logo',
      'Paleta de cores',
      'Manual da marca',
    ]);
    expect(cells(3)).toEqual(['Incluso', 'Não incluso', 'Não incluso']);
    expect(cells(4)).toEqual(['Incluso', 'Incluso', 'Incluso']);
    expect(screen.queryByRole('button', { name: /Escolher/ })).toBeNull();
  });

  it('com quem pode contratar, "Escolher" em cada coluna leva o nível', async () => {
    const user = userEvent.setup({ delay: null });
    const onChoose = vi.fn();
    render(<PackageCompare packages={THREE} onChoose={onChoose} />);
    await user.click(screen.getByRole('button', { name: 'Escolher o pacote Padrão' }));
    expect(onChoose).toHaveBeenCalledWith('standard');
  });

  it('com menos de dois pacotes não há o que comparar', () => {
    const { container } = render(<PackageCompare packages={THREE.slice(0, 1)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
