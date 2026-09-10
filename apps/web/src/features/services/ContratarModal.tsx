import { Coins, CreditCard, Flag, Plus, QrCode, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { brl } from '../../lib/format';
import { useCreateContract, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';

interface MilestoneDraft {
  title: string;
  amount: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Cliente contrata um serviço — em dinheiro (carteira pré-paga: o valor é reservado já na
 * proposta e vai para o escrow no aceite) ou em créditos Escambo (retidos no aceite).
 * Em dinheiro, pode dividir em marcos (RN-069): cada marco aprovado libera só o próprio valor.
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
  const [useMilestones, setUseMilestones] = useState(false);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { title: 'Etapa 1', amount: '' },
    { title: 'Etapa 2', amount: '' },
  ]);

  const credits = wallet.data?.credits ?? 0;
  const balance = wallet.data?.balance ?? 0;
  const priceNum = Number(price) || 0;
  const creditsNeeded = Math.round(priceNum);
  const canCredits = priceNum > 0 && credits >= creditsNeeded;
  const missing = Math.max(0, round2(priceNum - balance));
  const needsDeposit = mode === 'cash' && priceNum > 0 && missing > 0;

  const withMilestones = mode === 'cash' && useMilestones;
  const msSum = round2(milestones.reduce((acc, m) => acc + (Number(m.amount) || 0), 0));
  const msValid =
    !withMilestones ||
    (milestones.length >= 2 &&
      milestones.every((m) => m.title.trim().length >= 3 && Number(m.amount) > 0) &&
      Math.abs(msSum - priceNum) < 0.005);

  function setMilestone(i: number, patch: Partial<MilestoneDraft>): void {
    setMilestones((ms) => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  }

  /** Divide o valor em partes iguais (o último absorve os centavos). */
  function splitEvenly(): void {
    if (priceNum <= 0 || milestones.length === 0) return;
    const part = Math.floor((priceNum / milestones.length) * 100) / 100;
    const last = round2(priceNum - part * (milestones.length - 1));
    setMilestones((ms) =>
      ms.map((m, i) => ({ ...m, amount: String(i === ms.length - 1 ? last : part) })),
    );
  }

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
        milestones: withMilestones
          ? milestones.map((m) => ({ title: m.title.trim(), amount: Number(m.amount) }))
          : undefined,
      });
      toast.success(
        mode === 'credits'
          ? 'Proposta enviada — créditos retidos no aceite'
          : withMilestones
            ? `Proposta enviada em ${milestones.length} marcos — valor reservado na sua carteira`
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

        {mode === 'cash' && (
          <label className="consent" data-testid="milestones-toggle">
            <input
              type="checkbox"
              checked={useMilestones}
              onChange={(e) => setUseMilestones(e.target.checked)}
            />
            <span>
              <Flag size={13} /> Dividir em <b>marcos</b>: cada etapa aprovada libera só o próprio
              valor (bom para projetos longos).
            </span>
          </label>
        )}

        {withMilestones && (
          <div className="ms-editor" data-testid="milestones-editor">
            {milestones.map((m, i) => (
              <div className="ms-row" key={i}>
                <Input
                  value={m.title}
                  onChange={(e) => setMilestone(i, { title: e.target.value })}
                  placeholder={`Marco ${i + 1}`}
                  aria-label={`Título do marco ${i + 1}`}
                  required
                  minLength={3}
                />
                <Input
                  type="number"
                  min={0.01}
                  step="0.01"
                  value={m.amount}
                  onChange={(e) => setMilestone(i, { amount: e.target.value })}
                  placeholder="R$"
                  aria-label={`Valor do marco ${i + 1}`}
                  required
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remover marco ${i + 1}`}
                  disabled={milestones.length <= 2}
                  onClick={() => setMilestones((ms) => ms.filter((_, k) => k !== i))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <div className="svc-actions">
              <Button
                type="button"
                variant="mini"
                disabled={milestones.length >= 10}
                onClick={() =>
                  setMilestones((ms) => [...ms, { title: `Etapa ${ms.length + 1}`, amount: '' }])
                }
              >
                <Plus size={14} /> Marco
              </Button>
              <Button type="button" variant="mini" onClick={splitEvenly}>
                Dividir igualmente
              </Button>
            </div>
            <div className={`ms-sum ${Math.abs(msSum - priceNum) < 0.005 ? '' : 'bad'}`}>
              <span>Soma dos marcos</span>
              <strong>
                {brl(msSum)} de {brl(priceNum)}
              </strong>
            </div>
          </div>
        )}

        <div className="summary">
          <strong>{mode === 'credits' ? `${creditsNeeded} créditos` : brl(priceNum)}</strong>
          <span className="muted tiny">
            {mode === 'credits'
              ? 'retidos no aceite · liberados na aprovação'
              : withMilestones
                ? 'reservado agora · liberado marco a marco (85% ao freelancer)'
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

        <Button
          type="submit"
          disabled={create.isPending || priceNum < 10 || needsDeposit || !msValid}
        >
          {create.isPending ? 'Enviando…' : 'Enviar proposta'}
        </Button>
      </form>
    </Modal>
  );
}
