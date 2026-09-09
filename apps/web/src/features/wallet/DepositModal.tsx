import { CheckCircle2, Copy, QrCode, RefreshCw, Zap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Deposit } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { brl, DEPOSIT_STATUS_LABEL } from '../../lib/format';
import { qk, useCreateDeposit, useDeposit, useSimulateDeposit } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const PRESETS = [50, 100, 200, 500];
const MIN = 10;

/**
 * Depósito na carteira via PIX: escolhe o valor → cobrança (QR + copia e cola) → aguarda a
 * confirmação do gateway (a tela consulta a API sozinha). No ambiente de demonstração o
 * gateway é simulado e o próprio usuário confirma o pagamento.
 */
export function DepositModal({
  onClose,
  onPaid,
  suggestedAmount,
  initial,
}: {
  onClose: () => void;
  /** Chamado uma vez quando a cobrança é confirmada (saldo já atualizado). */
  onPaid?: (deposit: Deposit) => void;
  /** Valor pré-preenchido (ex.: o que falta para uma contratação). */
  suggestedAmount?: number;
  /** Reabrir uma cobrança pendente já criada. */
  initial?: Deposit | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const create = useCreateDeposit();
  const simulate = useSimulateDeposit();
  const [amount, setAmount] = useState(
    String(suggestedAmount ? Math.max(MIN, Math.ceil(suggestedAmount)) : 100),
  );
  const [deposit, setDeposit] = useState<Deposit | null>(initial ?? null);
  const live = useDeposit(deposit?.id ?? null, deposit?.status === 'pending');
  const current = live.data ?? deposit;
  const paidRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // Relógio da validade (a cada 15 s basta).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Confirmação (pela simulação ou pelo webhook, via polling): avisa uma vez e atualiza a carteira.
  useEffect(() => {
    if (current?.status === 'paid' && !paidRef.current) {
      paidRef.current = true;
      for (const key of [qk.wallet, qk.walletTransactions, qk.deposits]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      onPaid?.(current);
    }
  }, [current, onPaid, qc]);

  // QR Code do "copia e cola" (canvas; ignorado em ambientes sem canvas).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current?.pixCode) return;
    try {
      void QRCode.toCanvas(canvas, current.pixCode, {
        width: 176,
        margin: 1,
        color: { dark: '#0f1a14', light: '#ffffff' },
      }).catch(() => undefined);
    } catch {
      /* sem canvas (testes) */
    }
  }, [current?.pixCode]);

  async function generate(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      const d = await create.mutateAsync({ amount: Number(amount), method: 'pix' });
      paidRef.current = false;
      setDeposit(d);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao gerar a cobrança');
    }
  }

  async function copy(): Promise<void> {
    if (!current?.pixCode) return;
    try {
      await navigator.clipboard.writeText(current.pixCode);
      toast.success('Código PIX copiado');
    } catch {
      toast.info('Selecione o código e copie manualmente');
    }
  }

  async function doSimulate(): Promise<void> {
    if (!current) return;
    try {
      const d = await simulate.mutateAsync(current.id);
      setDeposit(d);
      toast.success(`Depósito de ${brl(d.amount)} confirmado`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível confirmar');
    }
  }

  const minutesLeft = current?.expiresAt
    ? Math.max(0, Math.ceil((new Date(current.expiresAt).getTime() - now) / 60_000))
    : null;
  const value = Number(amount) || 0;

  return (
    <Modal title="Depositar na carteira" onClose={onClose}>
      {!current && (
        <form onSubmit={generate} className="stack">
          <p className="muted">
            Escolha o valor. Você recebe um PIX (QR Code e copia e cola); o saldo entra assim que o
            pagamento é confirmado.
          </p>
          <div className="presets" role="group" aria-label="Valores sugeridos">
            {PRESETS.map((v) => (
              <button
                type="button"
                key={v}
                className={`preset ${value === v ? 'on' : ''}`}
                onClick={() => setAmount(String(v))}
              >
                {brl(v)}
              </button>
            ))}
          </div>
          <Field label="Valor (R$)">
            <Input
              type="number"
              min={MIN}
              max={50000}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={create.isPending || value < MIN}>
            <QrCode size={16} />{' '}
            {create.isPending ? 'Gerando…' : `Gerar cobrança PIX de ${brl(value)}`}
          </Button>
        </form>
      )}

      {current && current.status === 'pending' && (
        <div className="stack">
          <div className="pix-box">
            <canvas
              ref={canvasRef}
              className="pix-qr"
              role="img"
              aria-label="QR Code do PIX"
              width={176}
              height={176}
            />
            <div className="pix-info">
              <strong className="pix-amount">{brl(current.amount)}</strong>
              <span className="muted tiny">
                {minutesLeft != null ? `Vence em ${minutesLeft} min` : 'Cobrança PIX'}
                {current.reference ? ` · ref. ${current.reference}` : ''}
              </span>
              <label className="tiny">
                PIX copia e cola
                <textarea
                  className="textarea pix-code"
                  readOnly
                  rows={3}
                  value={current.pixCode ?? ''}
                  data-testid="pix-code"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <Button variant="secondary" type="button" onClick={copy}>
                <Copy size={14} /> Copiar código
              </Button>
            </div>
          </div>
          <p className="muted tiny">
            Aguardando a confirmação do pagamento… esta tela atualiza sozinha.
          </p>
          {current.canSimulate && (
            <div className="demo-box">
              <div>
                <strong>Ambiente de demonstração</strong>
                <div className="muted tiny">
                  O gateway é simulado: nenhum banco é acionado. Confirme o pagamento aqui.
                </div>
              </div>
              <Button type="button" onClick={doSimulate} disabled={simulate.isPending}>
                <Zap size={16} /> {simulate.isPending ? 'Confirmando…' : 'Simular pagamento'}
              </Button>
            </div>
          )}
        </div>
      )}

      {current && current.status === 'paid' && (
        <div className="stack center">
          <span className="done-ico">
            <CheckCircle2 size={28} />
          </span>
          <h3 style={{ margin: 0 }}>Depósito de {brl(current.amount)} confirmado</h3>
          <p className="muted">O saldo já está disponível na sua carteira.</p>
          <Button type="button" onClick={onClose}>
            Concluir
          </Button>
        </div>
      )}

      {current && current.status !== 'pending' && current.status !== 'paid' && (
        <div className="stack center">
          <p className="muted">
            Cobrança {DEPOSIT_STATUS_LABEL[current.status]?.toLowerCase() ?? current.status}. Gere
            uma nova para continuar.
          </p>
          <Button type="button" variant="secondary" onClick={() => setDeposit(null)}>
            <RefreshCw size={14} /> Gerar nova cobrança
          </Button>
        </div>
      )}
    </Modal>
  );
}
