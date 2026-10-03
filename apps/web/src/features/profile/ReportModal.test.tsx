import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportModal, type ReportSubject } from './ReportModal';
import { ToastProvider } from '../../lib/toast';

/**
 * Denúncia para a fila de moderação (ADR 39): o que vai para a API (alvo, motivo e detalhes), o
 * motivo que vem escolhido para imagem e a escolha do alvo quando há mais de um.
 */

const createReport = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { createReport: (body: unknown) => createReport(body) },
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

/** Imagem enviada ao Escambo: a denúncia mostra a miniatura pequena dela (ADR 38). */
const MEDIA = '/api/media/2026/09/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp';

const profile: ReportSubject = {
  targetType: 'user',
  targetId: 9,
  label: 'O perfil de Bruno',
  hint: 'Nome, bio ou comportamento',
};
const avatar: ReportSubject = {
  targetType: 'avatar',
  targetId: 9,
  label: 'A foto de perfil',
  hint: 'A imagem vai para a moderação',
  imageUrl: MEDIA,
};
const work: ReportSubject = {
  targetType: 'portfolio_item',
  targetId: 31,
  label: 'Trabalho “Logo da padaria”',
  imageUrl: 'https://exemplo.test/logo.png',
};

const reasonField = (): HTMLElement => screen.getByLabelText('Motivo');
const details = (): HTMLElement => screen.getByRole('textbox', { name: 'Detalhes da denúncia' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Enviar denúncia' });

type User = ReturnType<typeof userEvent.setup>;

/** Cola o texto no campo de uma vez: tecla a tecla, cada letra redesenha a tela e o teste arrasta. */
async function fill(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

beforeEach(() => {
  createReport.mockReset();
  createReport.mockResolvedValue({ id: 1 });
});

describe('denúncia de um alvo só', () => {
  it('perfil: começa em Spam, sem escolha de alvo nem imagem, e envia sem detalhes como null', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<ReportModal subjects={[profile]} onClose={onClose} />));

    expect(screen.getByRole('dialog', { name: 'Denunciar' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(reasonField()).toHaveValue('spam');

    await user.click(send());

    expect(createReport).toHaveBeenCalledTimes(1);
    expect(createReport).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: 9,
      reason: 'spam',
      description: null,
    });
    expect(
      await screen.findByText(
        'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      ),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('os motivos aparecem todos, na ordem da moderação', () => {
    render(wrap(<ReportModal subjects={[profile]} onClose={vi.fn()} />));

    expect(
      within(reasonField())
        .getAllByRole('option')
        .map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    ).toEqual([
      ['spam', 'Spam'],
      ['fraud', 'Fraude ou golpe'],
      ['offensive', 'Conteúdo ofensivo'],
      ['off_platform', 'Tenta negociar fora da plataforma'],
      ['illegal', 'Atividade ilegal'],
      ['other', 'Outro'],
    ]);
  });

  it('o motivo escolhido e os detalhes vão para a API, sem os espaços das pontas', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportModal subjects={[profile]} onClose={vi.fn()} />));

    await user.selectOptions(reasonField(), 'off_platform');
    await fill(user, details(), '  Pediu para pagar por fora  ');
    await user.click(send());

    expect(createReport).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: 9,
      reason: 'off_platform',
      description: 'Pediu para pagar por fora',
    });
    expect(
      await screen.findByText(
        'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      ),
    ).toBeInTheDocument();
  });

  it('detalhes só com espaços contam como vazios (null)', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportModal subjects={[profile]} onClose={vi.fn()} />));

    await fill(user, details(), '   ');
    await user.click(send());

    expect(createReport).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: 9,
      reason: 'spam',
      description: null,
    });
    expect(await screen.findByText(/^Denúncia registrada\./)).toBeInTheDocument();
  });

  it('os detalhes são opcionais e limitados a 2000 caracteres', () => {
    render(wrap(<ReportModal subjects={[profile]} onClose={vi.fn()} />));

    expect(details()).toHaveAttribute('maxlength', '2000');
    expect(details()).toHaveAttribute('placeholder', 'Detalhes (opcional)');
    expect(details()).not.toBeRequired();
  });

  it('imagem: o título diz que é imagem, o motivo começa em Conteúdo ofensivo e a miniatura aparece', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<ReportModal subjects={[avatar]} onClose={onClose} />));

    expect(screen.getByRole('dialog', { name: 'Denunciar imagem' })).toBeInTheDocument();
    expect(reasonField()).toHaveValue('offensive');
    const figura = screen.getByRole('figure');
    expect(figura).toHaveTextContent('A foto de perfil');
    expect(figura).toHaveTextContent(
      'A moderação analisa esta imagem como ela está agora, mesmo que seja trocada depois.',
    );
    // Imagem do Escambo vai na miniatura pequena, não no arquivo inteiro.
    expect(figura.querySelector('img')).toHaveAttribute('src', `${MEDIA}?w=128`);

    await user.click(send());

    expect(createReport).toHaveBeenCalledWith({
      targetType: 'avatar',
      targetId: 9,
      reason: 'offensive',
      description: null,
    });
    expect(
      await screen.findByText('Denúncia registrada. A moderação vai analisar a imagem.'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('imagem de fora do Escambo aparece no endereço original', () => {
    render(wrap(<ReportModal subjects={[work]} onClose={vi.fn()} />));

    expect(screen.getByRole('dialog', { name: 'Denunciar imagem' })).toBeInTheDocument();
    expect(screen.getByRole('figure').querySelector('img')).toHaveAttribute(
      'src',
      'https://exemplo.test/logo.png',
    );
  });

  it('alvo de imagem sem imagem (foto já trocada) não mostra a figura, mas segue como imagem', () => {
    render(wrap(<ReportModal subjects={[{ ...avatar, imageUrl: null }]} onClose={vi.fn()} />));

    expect(screen.getByRole('dialog', { name: 'Denunciar imagem' })).toBeInTheDocument();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(reasonField()).toHaveValue('offensive');
  });
});

describe('denúncia com mais de um alvo', () => {
  it('pergunta o que denunciar, com o primeiro marcado e a dica de cada um', () => {
    render(wrap(<ReportModal subjects={[profile, avatar]} onClose={vi.fn()} />));

    // Com escolha de alvo, o título não afirma que é imagem.
    expect(screen.getByRole('dialog', { name: 'Denunciar' })).toBeInTheDocument();
    const grupo = screen.getByRole('group', { name: 'O que você quer denunciar?' });
    const perfil = within(grupo).getByRole('radio', { name: /^O perfil de Bruno/ });
    const foto = within(grupo).getByRole('radio', { name: /^A foto de perfil/ });
    expect(perfil).toBeChecked();
    expect(foto).not.toBeChecked();
    expect(grupo).toHaveTextContent('Nome, bio ou comportamento');
    expect(grupo).toHaveTextContent('A imagem vai para a moderação');
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(reasonField()).toHaveValue('spam');
  });

  it('escolher a foto troca Spam por Conteúdo ofensivo, mostra a imagem e denuncia a foto', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportModal subjects={[profile, avatar]} onClose={vi.fn()} />));

    await user.click(screen.getByRole('radio', { name: /^A foto de perfil/ }));

    expect(screen.getByRole('radio', { name: /^A foto de perfil/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^O perfil de Bruno/ })).not.toBeChecked();
    expect(reasonField()).toHaveValue('offensive');
    expect(screen.getByRole('figure')).toHaveTextContent('A foto de perfil');

    await user.click(send());

    expect(createReport).toHaveBeenCalledWith({
      targetType: 'avatar',
      targetId: 9,
      reason: 'offensive',
      description: null,
    });
    expect(
      await screen.findByText('Denúncia registrada. A moderação vai analisar a imagem.'),
    ).toBeInTheDocument();
  });

  it('motivo já escolhido à mão não é trocado ao mudar o alvo para a foto', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportModal subjects={[profile, avatar]} onClose={vi.fn()} />));

    await user.selectOptions(reasonField(), 'fraud');
    await user.click(screen.getByRole('radio', { name: /^A foto de perfil/ }));

    expect(reasonField()).toHaveValue('fraud');
  });

  it('voltar para o perfil esconde a imagem e denuncia o perfil, com o motivo que ficou', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportModal subjects={[profile, avatar]} onClose={vi.fn()} />));

    await user.click(screen.getByRole('radio', { name: /^A foto de perfil/ }));
    await user.click(screen.getByRole('radio', { name: /^O perfil de Bruno/ }));

    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(reasonField()).toHaveValue('offensive');

    await user.click(send());

    expect(createReport).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: 9,
      reason: 'offensive',
      description: null,
    });
    expect(
      await screen.findByText(
        'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      ),
    ).toBeInTheDocument();
  });
});

describe('denúncia: envio em andamento, recusa e fechar', () => {
  it('enquanto envia, o botão diz Enviando… e não aceita outro clique', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let solta!: (v: unknown) => void;
    createReport.mockImplementation(() => new Promise((r) => (solta = r)));
    render(wrap(<ReportModal subjects={[profile]} onClose={onClose} />));

    await user.click(send());

    const enviando = await screen.findByRole('button', { name: 'Enviando…' });
    expect(enviando).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(enviando);
    expect(createReport).toHaveBeenCalledTimes(1);
    // Nada é confirmado antes de a API responder.
    expect(screen.queryByText(/^Denúncia registrada/)).not.toBeInTheDocument();

    solta({ id: 1 });
    expect(
      await screen.findByText(
        'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      ),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('recusa da API: mostra a mensagem dela e o modal continua aberto com o que foi escrito', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    createReport.mockRejectedValue(new Error('Você já denunciou este perfil.'));
    render(wrap(<ReportModal subjects={[profile]} onClose={onClose} />));

    await fill(user, details(), 'Perfil falso');
    await user.click(send());

    expect(await screen.findByText('Você já denunciou este perfil.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Denúncia registrada/)).not.toBeInTheDocument();
    expect(details()).toHaveValue('Perfil falso');
    await waitFor(() => expect(send()).not.toBeDisabled());
  });

  it('falha sem mensagem cai no texto padrão', async () => {
    const user = userEvent.setup();
    createReport.mockRejectedValue('sem rede');
    render(wrap(<ReportModal subjects={[profile]} onClose={vi.fn()} />));

    await user.click(send());

    expect(await screen.findByText('Erro ao denunciar')).toBeInTheDocument();
  });

  it('fechar pelo ✕ não denuncia nada', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<ReportModal subjects={[profile, avatar]} onClose={onClose} />));

    await user.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createReport).not.toHaveBeenCalled();
  });
});
