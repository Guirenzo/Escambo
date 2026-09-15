import { Coins, CreditCard, Flag, Plus, QrCode, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { addDays, brl, dateInputValue, endOfDayIso, spreadDates } from '../../lib/format';
import { useCreateContract, usePublicSettings, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { DepositModal } from '../wallet/DepositModal';

interface MilestoneDraft {
  title: string;
  amount: string;
  /** Prazo do marco (valor de <input type="date">); vazio = sem prazo próprio. */
  dueAt: string;
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
  const settings = usePublicSettings();
  const feePct = settings.data?.platformFeePercentage ?? 15;
  const create = useCreateContract();

  const [title, setTitle] = useState(service.title);
  const [description, setDescription] = useState(`Contratação do serviço "${service.title}".`);
  const [price, setPrice] = useState(String(service.price ?? ''));
  const [mode, setMode] = useState<'cash' | 'credits'>('cash');
  // Prazo de entrega: sugerido pelo prazo do serviço (RN-028/029 cobram a partir dele).
  const suggestedDays = service.deliveryDays ?? 7;
  const [deadline, setDeadline] = useState(dateInputValue(addDays(new Date(), suggestedDays)));
  const minDeadline = dateInputValue(addDays(new Date(), 1));
  const [depositing, setDepositing] = useState(false);
  const [useMilestones, setUseMilestones] = useState(false);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { title: 'Etapa 1', amount: '', dueAt: '' },
    { title: 'Etapa 2', amount: '', dueAt: '' },
  ]);

  const credits = wallet.data?.credits ?? 0;
  const balance = wallet.data?.balance ?? 0;
  const priceNum = Number(price) || 0;
  const creditsNeeded = Math.round(priceNum);
  const canCredits = priceNum > 0 && credits >= creditsNeeded;
  const missing = Math.max(0, round2(priceNum - balance));
  const needsDeposit = mode === 'cash' && priceNum > 0 && missing > 0;

  const withMilestones = useMilestones;
  // Em créditos os marcos são inteiros e somam os créditos da contratação (sem taxa).
  const isCredits = mode === 'credits';
  const msTarget = isCredits ? creditsNeeded : priceNum;
  const fmtAmount = (v: number): string => (isCredits ? `${Math.round(v)} cr` : brl(v));
  const msSum = round2(milestones.reduce((acc, m) => acc + (Number(m.amount) || 0), 0));
  // Prazos dos marcos (opcionais): em ordem e nunca depois do prazo da contratação
  // (AAAA-MM-DD compara bem como texto).
  const msDatesValid = milestones.every(
    (m, i) =>
      !m.dueAt ||
      (m.dueAt <= deadline &&
        m.dueAt >= minDeadline &&
        (i === 0 || !milestones[i - 1]!.dueAt || m.dueAt >= milestones[i - 1]!.dueAt)),
  );
  const msValid =
    !withMilestones ||
    (milestones.length >= 2 &&
      milestones.every((m) => m.title.trim().length >= 3 && Number(m.amount) > 0) &&
      (!isCredits || milestones.every((m) => Number.isInteger(Number(m.amount)))) &&
      Math.abs(msSum - msTarget) < 0.005 &&
      msDatesValid);

  function setMilestone(i: number, patch: Partial<MilestoneDraft>): void {
    setMilestones((ms) => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  }

  /** Divide o valor em partes iguais (o último absorve os centavos). */
  function splitEvenly(): void {
    if (msTarget <= 0 || milestones.length === 0) return;
    // Créditos são inteiros; em R$ vale o centavo. O último marco absorve a sobra.
    const part = isCredits
      ? Math.floor(msTarget / milestones.length)
      : Math.floor((msTarget / milestones.length) * 100) / 100;
    const last = round2(msTarget - part * (milestones.length - 1));
    setMilestones((ms) =>
      ms.map((m, i) => ({ ...m, amount: String(i === ms.length - 1 ? last : part) })),
    );
  }

  /** Espalha os prazos dos marcos por igual até o prazo da contratação (o último cai nele). */
  function spreadDeadlines(): void {
    const dates = spreadDates(new Date(), new Date(endOfDayIso(deadline)), milestones.length);
    setMilestones((ms) => ms.map((m, i) => ({ ...m, dueAt: dates[i] ?? '' })));
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
        deadlineAt: endOfDayIso(deadline),
        milestones: withMilestones
          ? milestones.map((m) => ({
              title: m.title.trim(),
              amount: Number(m.amount),
              dueAt: m.dueAt ? endOfDayIso(m.dueAt) : null,
            }))
          : undefined,
      });
      toast.success(
        mode === 'credits'
          ? withMilestones
            ? `Proposta enviada em ${milestones.length} marcos — créditos retidos no aceite`
            : 'Proposta enviada — créditos retidos no aceite'
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

        <Field label="Prazo de entrega">
          <Input
            type="date"
            min={minDeadline}
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            required
          />
        </Field>
        <span className="muted tiny">
          Sugerido pelo serviço: {suggestedDays} dia{suggestedDays === 1 ? '' : 's'}. O freelancer
          pode pedir uma extensão, que só vale com o seu aceite.
        </span>

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
            <small>
              Saldo {wallet.data ? brl(balance) : '…'} · escrow em R$ · taxa {feePct}%
            </small>
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
                  min={isCredits ? 1 : 0.01}
                  step={isCredits ? 1 : '0.01'}
                  value={m.amount}
                  onChange={(e) => setMilestone(i, { amount: e.target.value })}
                  placeholder="R$"
                  aria-label={`Valor do marco ${i + 1}`}
                  required
                />
                <Input
                  type="date"
                  min={minDeadline}
                  max={deadline}
                  value={m.dueAt}
                  onChange={(e) => setMilestone(i, { dueAt: e.target.value })}
                  aria-label={`Prazo do marco ${i + 1}`}
                  title="Prazo do marco (opcional)"
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
                  setMilestones((ms) => [
                    ...ms,
                    { title: `Etapa ${ms.length + 1}`, amount: '', dueAt: '' },
                  ])
                }
              >
                <Plus size={14} /> Marco
              </Button>
              <Button type="button" variant="mini" onClick={splitEvenly}>
                Dividir igualmente
              </Button>
              <Button type="button" variant="mini" onClick={spreadDeadlines}>
                Distribuir prazos
              </Button>
            </div>
            <div className={`ms-sum ${Math.abs(msSum - msTarget) < 0.005 ? '' : 'bad'}`}>
              <span>Soma dos marcos</span>
              <strong>
                {fmtAmount(msSum)} de {fmtAmount(msTarget)}
              </strong>
            </div>
          </div>
        )}

        <div className="summary">
          <strong>{mode === 'credits' ? `${creditsNeeded} créditos` : brl(priceNum)}</strong>
          <span className="muted tiny">
            {mode === 'credits'
              ? withMilestones
                ? 'retidos no aceite · liberados marco a marco'
                : 'retidos no aceite · liberados na aprovação'
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
