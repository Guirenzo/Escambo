import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LEGAL, LEGAL_CHANGES, LEGAL_UPDATED, LEGAL_VERSIONS, type LegalKind } from './content';
import { LegalView } from './LegalView';

/**
 * /termos e /privacidade (ADR 54): cada página mostra o próprio documento, a versão gravada no
 * consentimento com a data sem voltar um dia pelo fuso, e só o histórico do próprio documento.
 */

const show = (kind: LegalKind) =>
  render(
    <MemoryRouter>
      <LegalView kind={kind} />
    </MemoryRouter>,
  );

/** "2026-09-25" → "25/09/2026", escrito à mão para o teste não depender do formatador da tela. */
const br = (iso: string): string => iso.split('-').reverse().join('/');

describe('LegalView', () => {
  it('termos: título na página e na aba, versão com a data e o link para a privacidade', () => {
    show('termos');
    expect(screen.getByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeInTheDocument();
    expect(document.title).toBe('Termos de Uso · Escambo');
    expect(
      screen.getByText(
        `Versão ${LEGAL_VERSIONS.termos} · atualizada em ${br(LEGAL_UPDATED.termos)} ·`,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade',
    );
    expect(screen.queryByRole('link', { name: 'Termos de Uso' })).not.toBeInTheDocument();
  });

  it('privacidade: o documento é o outro e o link aponta para os termos', () => {
    show('privacidade');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Política de Privacidade' }),
    ).toBeInTheDocument();
    expect(document.title).toBe('Política de Privacidade · Escambo');
    expect(screen.getByRole('link', { name: 'Termos de Uso' })).toHaveAttribute('href', '/termos');
    expect(screen.getByText(LEGAL.privacidade.intro)).toBeInTheDocument();
    expect(screen.queryByText(LEGAL.termos.intro)).not.toBeInTheDocument();
  });

  it('a data da versão é a do documento, sem voltar um dia pelo fuso', () => {
    // Regra fixada no texto: a versão vigente dos termos (1.4, ADR 58) saiu em 03/10/2026.
    show('termos');
    expect(screen.getByText(/Versão 1\.4 · atualizada em 03\/10\/2026/)).toBeInTheDocument();
  });

  it('mostra a introdução e uma seção por título, com todos os parágrafos', () => {
    show('termos');
    expect(screen.getByText(LEGAL.termos.intro)).toBeInTheDocument();
    const titles = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => t !== 'Histórico de versões');
    expect(titles).toEqual(LEGAL.termos.sections.map((s) => s.title));
    for (const s of LEGAL.termos.sections) {
      const section = screen.getByRole('heading', { level: 2, name: s.title }).parentElement!;
      expect(
        within(section)
          .getAllByText(/./, { selector: 'p' })
          .map((p) => p.textContent),
        s.title,
      ).toEqual(s.paragraphs);
    }
  });

  it('avisa que é o documento da versão de demonstração', () => {
    show('termos');
    expect(
      screen.getByText(/Documento da versão de demonstração do Escambo \(projeto acadêmico\)/),
    ).toBeInTheDocument();
  });

  it('o histórico traz só as versões do próprio documento, da mais nova para a mais antiga', () => {
    show('privacidade');
    const history = screen.getByRole('region', { name: 'Histórico de versões' });
    // A faixa de "termos atualizados" leva para /privacidade#historico (ADR 54).
    expect(history).toHaveAttribute('id', 'historico');
    const mine = LEGAL_CHANGES.filter((c) => c.doc === 'privacidade');
    const items = within(history).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual(
      mine.map((c) => `${c.version} · ${br(c.date)}`),
    );
    expect(items[0]).toHaveTextContent(mine[0]!.summary);
    // Nenhuma linha dos termos vaza para a privacidade.
    const termsOnly = LEGAL_CHANGES.find((c) => c.doc === 'termos')!;
    expect(within(history).queryByText(termsOnly.summary)).not.toBeInTheDocument();
    expect(items[items.length - 1]).toHaveTextContent('1.0 · 09/09/2026 Primeira versão.');
  });

  it('a marca e o "Voltar ao início" levam para o login', () => {
    show('termos');
    expect(screen.getByRole('link', { name: 'Escambo' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Voltar ao início' })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
