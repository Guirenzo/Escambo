import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CpfStatus } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dt } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { CpfCard } from './CpfCard';

/**
 * Dados para receber (RF-020): o CPF e a data de nascimento do freelancer. A tela confere os dígitos
 * antes de enviar, diz que não é consulta à Receita e, validado, só mostra o CPF mascarado.
 */

const api = vi.hoisted(() => ({ cpfStatus: vi.fn(), verifyCpf: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const status = (o: Partial<CpfStatus> = {}): CpfStatus => ({
  available: true,
  required: true,
  hasFreelancerProfile: true,
  verified: false,
  maskedCpf: null,
  birthDate: null,
  verifiedAt: null,
  ...o,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <CpfCard />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.cpfStatus.mockReset();
  api.verifyCpf.mockReset();
});

describe('CpfCard', () => {
  it('é a seção "Dados para receber", com a âncora que a Carteira usa', async () => {
    api.cpfStatus.mockResolvedValue(status());
    renderCard();
    const card = screen.getByTestId('cpf-card');
    expect(card).toHaveAttribute('id', 'dados-recebimento');
    expect(within(card).getByRole('heading', { name: 'Dados para receber' })).toBeInTheDocument();
    expect(await within(card).findByLabelText('CPF')).toBeInTheDocument();
  });

  it('o formulário diz o que é conferido, que não é consulta à Receita e por que o saque pede', async () => {
    api.cpfStatus.mockResolvedValue(status());
    renderCard();
    const cpf = await screen.findByLabelText('CPF');
    expect(cpf).toHaveAccessibleDescription(
      'O saque do que você recebe por trabalhos pede o CPF validado. Conferimos os dígitos do CPF, se ele já não está em outra conta e se você tem 18 anos ou mais. Não é uma consulta à Receita Federal. O CPF é guardado cifrado, aparece só mascarado e, depois de validado, só o suporte corrige.',
    );
    expect(cpf).toHaveAttribute('inputmode', 'numeric');
    expect(cpf).toHaveAttribute('autocomplete', 'off');
    const birth = screen.getByLabelText('Data de nascimento');
    expect(birth).toHaveAttribute('type', 'date');
    expect(birth).toHaveAttribute('autocomplete', 'bday');
  });

  it('quem não precisa do CPF para sacar não lê a frase do saque', async () => {
    api.cpfStatus.mockResolvedValue(status({ required: false }));
    renderCard();
    expect((await screen.findByText(/Conferimos os dígitos/)).textContent).not.toContain('saque');
  });

  it('a máscara acompanha a digitação; CPF com dígito errado avisa no campo e não vai à API', async () => {
    const user = userEvent.setup();
    api.cpfStatus.mockResolvedValue(status());
    renderCard();
    const cpf = await screen.findByLabelText('CPF');
    await user.type(cpf, '52998224724');
    expect(cpf).toHaveValue('529.982.247-24');
    await user.type(screen.getByLabelText('Data de nascimento'), '1990-05-17');
    await user.click(screen.getByRole('button', { name: 'Validar CPF' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('CPF inválido: confira os 11 dígitos.');
    expect(cpf).toHaveAttribute('aria-invalid', 'true');
    expect(cpf.getAttribute('aria-describedby')).toContain('cpf-erro');
    expect(cpf).toHaveFocus();
    expect(api.verifyCpf).not.toHaveBeenCalled();
  });

  it('valida: manda o CPF e a data, e o cartão passa a mostrar o CPF só mascarado', async () => {
    const user = userEvent.setup();
    api.cpfStatus.mockResolvedValue(status());
    api.verifyCpf.mockResolvedValue(
      status({
        verified: true,
        maskedCpf: '***.982.247-**',
        birthDate: '1990-05-17',
        verifiedAt: '2026-10-26T15:00:00.000Z',
      }),
    );
    renderCard();
    await user.type(await screen.findByLabelText('CPF'), '52998224725');
    await user.type(screen.getByLabelText('Data de nascimento'), '1990-05-17');
    await user.click(screen.getByRole('button', { name: 'Validar CPF' }));

    expect(api.verifyCpf).toHaveBeenCalledWith({ cpf: '529.982.247-25', birthDate: '1990-05-17' });
    const done = await screen.findByTestId('cpf-validado');
    expect(done).toHaveTextContent('CPF validado: ***.982.247-**');
    expect(done).toHaveTextContent('Nascimento17/05/1990');
    expect(done).toHaveTextContent(`Validado em${dt('2026-10-26T15:00:00.000Z')}`);
    expect(done).not.toHaveTextContent('52998224725');
    expect(screen.getByText('CPF validado.')).toBeInTheDocument();
  });

  it('a recusa da API (CPF de outra conta, menor de idade) aparece no campo, com o foco', async () => {
    const user = userEvent.setup();
    api.cpfStatus.mockResolvedValue(status());
    api.verifyCpf.mockRejectedValue(
      Object.assign(new Error('Este CPF já está em outra conta do Escambo.'), {
        name: 'ApiRequestError',
        code: 'cpf_taken',
      }),
    );
    renderCard();
    const cpf = await screen.findByLabelText('CPF');
    await user.type(cpf, '52998224725');
    await user.type(screen.getByLabelText('Data de nascimento'), '1990-05-17');
    await user.click(screen.getByRole('button', { name: 'Validar CPF' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este CPF já está em outra conta do Escambo.',
    );
    expect(cpf).toHaveFocus();
  });

  it('validado: sem formulário, com o caminho do suporte para corrigir', async () => {
    api.cpfStatus.mockResolvedValue(
      status({ verified: true, maskedCpf: '***.982.247-**', birthDate: null, verifiedAt: null }),
    );
    renderCard();
    await screen.findByTestId('cpf-validado');
    expect(screen.queryByLabelText('CPF')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'fale com o suporte' })).toHaveAttribute(
      'href',
      '/suporte',
    );
  });

  it('servidor sem a chave: diz que não está disponível e, se o saque pede, que ele fica bloqueado', async () => {
    api.cpfStatus.mockResolvedValue(status({ available: false }));
    renderCard();
    const note = await screen.findByTestId('cpf-indisponivel');
    expect(note).toHaveTextContent('A validação de CPF ainda não está disponível');
    expect(note).toHaveTextContent('o saque do que você recebe por trabalhos fica bloqueado');
    expect(screen.queryByLabelText('CPF')).not.toBeInTheDocument();
  });

  it('sem perfil de freelancer: pede para salvar os dados de freelancer antes', async () => {
    api.cpfStatus.mockResolvedValue(status({ hasFreelancerProfile: false }));
    renderCard();
    expect(await screen.findByTestId('cpf-sem-perfil')).toHaveTextContent(
      'salve primeiro os seus dados de freelancer',
    );
    expect(screen.queryByLabelText('CPF')).not.toBeInTheDocument();
  });
});
