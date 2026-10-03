import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlatformSetting } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { SettingsSection } from './SettingsSection';

const adminSettings = vi.fn();
const adminUpdateSetting = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminSettings: () => adminSettings(),
    adminUpdateSetting: (key: string, value: number | boolean) => adminUpdateSetting(key, value),
  },
}));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

const fee = (over: Partial<PlatformSetting> = {}): PlatformSetting => ({
  key: 'platform_fee_percentage',
  type: 'decimal',
  label: 'Taxa da plataforma',
  description: 'Percentual retido de cada contratação em dinheiro.',
  unit: '%',
  value: 15,
  min: 0,
  max: 30,
  defaultValue: 15,
  updatedAt: null,
  updatedBy: null,
  ...over,
});
const tacit = (over: Partial<PlatformSetting> = {}): PlatformSetting => ({
  key: 'tacit_approval_days',
  type: 'integer',
  label: 'Aprovação tácita',
  description: 'Dias até a entrega ser aprovada sozinha.',
  unit: 'dias',
  value: 7,
  min: 1,
  max: 30,
  defaultValue: 7,
  updatedAt: null,
  updatedBy: null,
  ...over,
});
const barter = (over: Partial<PlatformSetting> = {}): PlatformSetting => ({
  key: 'barter_enabled',
  type: 'boolean',
  label: 'Trocas por créditos',
  description: 'Liga ou desliga as trocas na plataforma.',
  unit: '',
  value: true,
  min: 0,
  max: 1,
  defaultValue: true,
  updatedAt: null,
  updatedBy: null,
  ...over,
});

const row = (key: string) => within(screen.getByTestId(`setting-${key}`));

beforeEach(() => {
  adminSettings.mockReset();
  adminUpdateSetting.mockReset();
  adminSettings.mockResolvedValue([fee(), tacit(), barter()]);
});

/** Parâmetros da plataforma (ADR 32/33): cada linha edita um valor dentro dos limites dele. */
describe('SettingsSection', () => {
  it('enquanto carrega mostra o esqueleto; as linhas entram no lugar dele', async () => {
    let release!: (list: PlatformSetting[]) => void;
    adminSettings.mockReturnValue(new Promise<PlatformSetting[]>((r) => (release = r)));
    render(wrap(<SettingsSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();

    release([fee()]);
    expect(await screen.findByRole('spinbutton', { name: 'Taxa da plataforma' })).toHaveValue(15);
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    adminSettings.mockRejectedValueOnce(new Error('Erro 500 nos parâmetros'));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 nos parâmetros');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('spinbutton', { name: 'Taxa da plataforma' })).toHaveValue(15);
    expect(adminSettings).toHaveBeenCalledTimes(2);
  });

  it('cada linha diz o valor atual, o padrão com a unidade e os limites', async () => {
    render(wrap(<SettingsSection />));

    const percent = await screen.findByRole('spinbutton', { name: 'Taxa da plataforma' });
    expect(percent).toHaveValue(15);
    const feeRow = row('platform_fee_percentage');
    expect(feeRow.getByText('Percentual retido de cada contratação em dinheiro.')).toBeVisible();
    expect(feeRow.getByText('Padrão 15 % · entre 0 e 30')).toBeInTheDocument();
    expect(feeRow.getByText('%')).toBeInTheDocument();
    // O próprio campo trava nos limites; decimal anda de centésimo em centésimo.
    expect(percent).toHaveAttribute('min', '0');
    expect(percent).toHaveAttribute('max', '30');
    expect(percent).toHaveAttribute('step', '0.01');

    const days = screen.getByRole('spinbutton', { name: 'Aprovação tácita' });
    expect(days).toHaveValue(7);
    expect(row('tacit_approval_days').getByText('Padrão 7 dias · entre 1 e 30')).toBeVisible();
    expect(days).toHaveAttribute('min', '1');
    expect(days).toHaveAttribute('max', '30');
    expect(days).toHaveAttribute('step', '1');
  });

  it('depois de salvar, as outras linhas acompanham os valores recarregados da API', async () => {
    adminUpdateSetting.mockResolvedValue(tacit({ value: 9 }));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const days = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    const percent = screen.getByRole('spinbutton', { name: 'Taxa da plataforma' });
    const toggle = screen.getByRole('switch', { name: 'Trocas por créditos' });
    expect(toggle).toBeChecked();
    await user.clear(days);
    await user.type(days, '9');

    // Nesse meio-tempo outro admin mudou a taxa e desligou as trocas: a lista recarregada traz isso.
    adminSettings.mockResolvedValue([
      fee({ value: 18 }),
      tacit({ value: 9 }),
      barter({ value: false }),
    ]);
    await user.click(row('tacit_approval_days').getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(percent).toHaveValue(18));
    expect(toggle).not.toBeChecked();
    expect(row('barter_enabled').getByText('desligado')).toBeInTheDocument();
    // O que veio da API é o valor atual: nada fica pendente para salvar.
    expect(row('platform_fee_percentage').getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(row('barter_enabled').getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(row('tacit_approval_days').getByRole('button', { name: 'Salvar' })).toBeDisabled();
  });

  it('chave liga/desliga aparece como interruptor, com o padrão por extenso e sem limites', async () => {
    adminSettings.mockResolvedValue([barter({ value: false })]);
    render(wrap(<SettingsSection />));

    const toggle = await screen.findByRole('switch', { name: 'Trocas por créditos' });
    expect(toggle).not.toBeChecked();
    const barterRow = row('barter_enabled');
    expect(barterRow.getByText('desligado')).toBeInTheDocument();
    expect(barterRow.getByText('Padrão ligado')).toBeInTheDocument();
    expect(barterRow.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('diz quando e quem mudou por último; sem autor, só quando', async () => {
    const at = '2026-09-20T14:30:00.000Z';
    adminSettings.mockResolvedValue([
      fee({ value: 12, updatedAt: at, updatedBy: 'admin@escambo.test' }),
      tacit({ updatedAt: at }),
    ]);
    render(wrap(<SettingsSection />));

    await screen.findByRole('spinbutton', { name: 'Taxa da plataforma' });
    expect(
      row('platform_fee_percentage').getByText(
        `Padrão 15 % · entre 0 e 30 · alterado ${dtm(at)} por admin@escambo.test`,
      ),
    ).toBeInTheDocument();
    expect(
      row('tacit_approval_days').getByText(`Padrão 7 dias · entre 1 e 30 · alterado ${dtm(at)}`),
    ).toBeInTheDocument();
  });

  it('Salvar só habilita com valor diferente do atual, e manda a chave com o número', async () => {
    adminUpdateSetting.mockResolvedValue(fee({ value: 12.5 }));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Taxa da plataforma' });
    const save = row('platform_fee_percentage').getByRole('button', { name: 'Salvar' });
    expect(save).toBeDisabled();

    await user.clear(input);
    expect(save).toBeDisabled(); // vazio não é zero
    await user.type(input, '15');
    expect(save).toBeDisabled(); // igual ao que já vale
    await user.clear(input);
    await user.type(input, '12.5');
    expect(save).toBeEnabled();

    adminSettings.mockResolvedValue([fee({ value: 12.5 }), tacit(), barter()]);
    await user.click(save);

    expect(adminUpdateSetting).toHaveBeenCalledTimes(1);
    expect(adminUpdateSetting).toHaveBeenCalledWith('platform_fee_percentage', 12.5);
    expect(
      await screen.findByText('Taxa da plataforma: 12.5 %. Vale a partir de agora.'),
    ).toBeInTheDocument();
    // A lista é recarregada e a linha passa a mostrar o valor gravado, sem nada por salvar.
    await waitFor(() => expect(adminSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(save).toBeDisabled());
    expect(input).toHaveValue(12.5);
  });

  it('fora dos limites não salva: abaixo do mínimo e acima do máximo', async () => {
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    const save = row('tacit_approval_days').getByRole('button', { name: 'Salvar' });

    await user.clear(input);
    await user.type(input, '0');
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, '31');
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, '30');
    expect(save).toBeEnabled();
    await user.clear(input);
    await user.type(input, '1');
    expect(save).toBeEnabled();
    expect(adminUpdateSetting).not.toHaveBeenCalled();
  });

  it('parâmetro inteiro recusa fração; decimal aceita até dois dígitos depois da vírgula', async () => {
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const days = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    const saveDays = row('tacit_approval_days').getByRole('button', { name: 'Salvar' });
    await user.clear(days);
    await user.type(days, '2.5');
    expect(saveDays).toBeDisabled();

    const percent = screen.getByRole('spinbutton', { name: 'Taxa da plataforma' });
    const savePercent = row('platform_fee_percentage').getByRole('button', { name: 'Salvar' });
    await user.clear(percent);
    await user.type(percent, '9.999');
    expect(savePercent).toBeDisabled();
    await user.clear(percent);
    await user.type(percent, '9.99');
    expect(savePercent).toBeEnabled();
  });

  it('Enter no campo salva o valor válido', async () => {
    adminUpdateSetting.mockResolvedValue(tacit({ value: 10 }));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });

    await user.clear(input);
    await user.type(input, '10{Enter}');

    expect(adminUpdateSetting).toHaveBeenCalledWith('tacit_approval_days', 10);
    expect(
      await screen.findByText('Aprovação tácita: 10 dias. Vale a partir de agora.'),
    ).toBeInTheDocument();
  });

  it('enviar o formulário com valor inválido ou sem mudança não chama a API', async () => {
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    const form = input.closest('form')!;

    // Sem mudança: o envio direto do formulário (sem passar pelo botão) também é barrado.
    fireEvent.submit(form);
    await user.clear(input);
    await user.type(input, '31{Enter}');
    fireEvent.submit(form);

    expect(adminUpdateSetting).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('virar o interruptor habilita Salvar e manda o booleano; voltar atrás desabilita', async () => {
    adminUpdateSetting.mockResolvedValue(barter({ value: false }));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const toggle = await screen.findByRole('switch', { name: 'Trocas por créditos' });
    const barterRow = row('barter_enabled');
    const save = barterRow.getByRole('button', { name: 'Salvar' });
    expect(toggle).toBeChecked();
    expect(barterRow.getByText('ligado')).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.click(toggle);
    expect(barterRow.getByText('desligado')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.click(toggle);
    expect(save).toBeDisabled();

    await user.click(toggle);
    await user.click(save);

    expect(adminUpdateSetting).toHaveBeenCalledWith('barter_enabled', false);
    expect(
      await screen.findByText('Trocas por créditos: desligado. Vale a partir de agora.'),
    ).toBeInTheDocument();
  });

  it('ligar uma chave avisa "ligado"', async () => {
    adminSettings.mockResolvedValue([barter({ value: false })]);
    adminUpdateSetting.mockResolvedValue(barter({ value: true }));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));

    await user.click(await screen.findByRole('switch', { name: 'Trocas por créditos' }));
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(adminUpdateSetting).toHaveBeenCalledWith('barter_enabled', true);
    expect(
      await screen.findByText('Trocas por créditos: ligado. Vale a partir de agora.'),
    ).toBeInTheDocument();
  });

  it('enquanto grava, o botão da linha diz "Salvando…" e fica desabilitado', async () => {
    let release!: (s: PlatformSetting) => void;
    adminUpdateSetting.mockImplementation(() => new Promise<PlatformSetting>((r) => (release = r)));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    await user.clear(input);
    await user.type(input, '9');

    await user.click(row('tacit_approval_days').getByRole('button', { name: 'Salvar' }));

    expect(
      await row('tacit_approval_days').findByRole('button', { name: 'Salvando…' }),
    ).toBeDisabled();
    // As outras linhas não entram em "salvando".
    expect(row('platform_fee_percentage').getByRole('button', { name: 'Salvar' })).toBeVisible();

    release(tacit({ value: 9 }));
    expect(
      await screen.findByText('Aprovação tácita: 9 dias. Vale a partir de agora.'),
    ).toBeInTheDocument();
  });

  it('recusa da API vira aviso com a mensagem dela e o rascunho continua no campo', async () => {
    adminUpdateSetting.mockRejectedValue(new Error('Valor fora dos limites.'));
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    await user.clear(input);
    await user.type(input, '9');

    await user.click(row('tacit_approval_days').getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Valor fora dos limites.')).toBeInTheDocument();
    expect(input).toHaveValue(9);
    expect(row('tacit_approval_days').getByRole('button', { name: 'Salvar' })).toBeEnabled();
    expect(adminSettings).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem cai no aviso genérico', async () => {
    adminUpdateSetting.mockRejectedValue({ status: 500 });
    const user = userEvent.setup();
    render(wrap(<SettingsSection />));
    const input = await screen.findByRole('spinbutton', { name: 'Aprovação tácita' });
    await user.clear(input);
    await user.type(input, '9');

    await user.click(row('tacit_approval_days').getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Não foi possível salvar')).toBeInTheDocument();
  });
});
