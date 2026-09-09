import { Coins, CreditCard, QrCode } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { brl } from '../../lib/format';
import { useCreateContract, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';

/**
 * Cliente contrata um serviço — em dinheiro (carteira pré-paga: o valor é reservado já na
 * proposta e vai para o escrow no aceite) ou em créditos Escambo (retidos no aceite).
 * Sem saldo, o depósito acontece aqui mesmo, sem sair do fluxo.
 */
export function ContratarModal({ service, onClose }: { service: Service; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const wallet = useWallet();
  const create = useCreateContract();

  const [title, setTitle] = useState(service.title);
  const [description, setDescription] = useState(`Contratação do serviço "${service.title}".`);
  const [price, setPrice] = useState(String(service.price ?? ''));
  const [mode, setMode] = useState<'cash' | 'credits'>('cash');
  const [depositing, setDepositing] = useState(false);

  const credits = wallet.data?.credits ?? 0;
  const balance = wallet.data?.balance ?? 0;
  const priceNum = Number(price) || 0;
  const creditsNeeded = Math.round(priceNum);
  const canCredits = priceNum > 0 && credits >= creditsNeeded;
  const missing = Math.max(0, Math.round((priceNum - balance) * 100) / 100);
  const needsDeposit = mode === 'cash' && priceNum > 0 && missing > 0;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      const c = await create.mutateAsync({
        freelancerId: service.ownerId,
        serviceId: service.id,
        title,
        description,
        price: priceNum,
        paymentMode: mode,
      });
      toast.success(
        mode === 'credits'
          ? 'Proposta enviada — créditos retidos no aceite'
          : 'Proposta enviada — valor reservado na sua carteira',
      );
      onClose();
      navigate(`/contratos/${c.id}`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao contratar');
    }
  }

  if (depositing) {
    return (
      <DepositModal
        suggestedAmount={missing}
        onClose={() => setDepositing(false)}
        onPaid={() => setDepositing(false)}
      />
    );
  }

  return (
    <Modal title={`Contratar: ${service.title}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Título">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
        </Field>
        <Field label="O que você precisa">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            minLength={10}
          />
        </Field>
        <Field label="Valor">
          <Input
            type="number"
            min={10}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>

        <div className="radio-row" role="radiogroup" aria-label="Forma de pagamento">
          <label className={`radio-card ${mode === 'cash' ? 'on' : ''}`}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'cash'}
              onChange={() => setMode('cash')}
            />
            <span className="svc-actions">
              <CreditCard size={14} /> Dinheiro
            </span>
            <small>Saldo {wallet.data ? brl(balance) : '…'} · escrow em R$ · taxa 15%</small>
          </label>
          <label
            className={`radio-card ${mode === 'credits' ? 'on' : ''} ${canCredits ? '' : 'off'}`}
          >
            <input
              type="radio"
              name="mode"
              disabled={!canCredits}
              checked={mode === 'credits'}
              onChange={() => canCredits && setMode('credits')}
            />
            <span className="svc-actions">
              <Coins size={14} /> Créditos Escambo
            </span>
            <small>
              Você tem {credits} · sem taxa
              {!canCredits && priceNum > 0 ? ` · precisa de ${creditsNeeded}` : ''}
            </small>
          </label>
        </div>

        <div className="summary">
          <strong>{mode === 'credits' ? `${creditsNeeded} créditos` : brl(priceNum)}</strong>
          <span className="muted tiny">
            {mode === 'credits'
              ? 'retidos no aceite · liberados na aprovação'
              : 'reservado agora · freelancer recebe 85% no escrow'}
          </span>
        </div>

        {needsDeposit && (
          <div className="demo-box" data-testid="needs-deposit">
            <div>
              <strong>Falta {brl(missing)} na sua carteira</strong>
              <div className="muted tiny">
                Deposite via PIX sem sair daqui; a proposta segue assim que o saldo entrar.
              </div>
            </div>
            <Button type="button" variant="secondary" onClick={() => setDepositing(true)}>
              <QrCode size={14} /> Depositar {brl(missing)}
            </Button>
          </div>
        )}

        <Button type="submit" disabled={create.isPending || priceNum < 10 || needsDeposit}>
          {create.isPending ? 'Enviando…' : 'Enviar proposta'}
        </Button>
      </form>
    </Modal>
  );
}
