import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Service } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { brl } from '../../lib/format';
import { useCreateContract, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Cliente contrata um serviço — em dinheiro (escrow R$) ou em créditos Escambo. */
export function ContratarModal({ service, onClose }: { service: Service; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const wallet = useWallet();
  const create = useCreateContract();

  const [title, setTitle] = useState(service.title);
  const [description, setDescription] = useState(`Contratação do serviço "${service.title}".`);
  const [price, setPrice] = useState(String(service.price ?? ''));
  const [mode, setMode] = useState<'cash' | 'credits'>('cash');

  const credits = wallet.data?.credits ?? 0;
  const priceNum = Number(price) || 0;
  const creditsNeeded = Math.round(priceNum);
  const canCredits = priceNum > 0 && credits >= creditsNeeded;

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
      toast.success(mode === 'credits' ? 'Proposta enviada — créditos retidos no aceite' : 'Proposta enviada!');
      onClose();
      navigate(`/contratos/${c.id}`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao contratar');
    }
  }

  return (
    <Modal title={`Contratar: ${service.title}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Título">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
        </Field>
        <Field label="O que você precisa">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={10} />
        </Field>
        <Field label="Valor">
          <Input type="number" min={10} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
        </Field>

        <div className="radio-row" role="radiogroup" aria-label="Forma de pagamento">
          <label className={`radio-card ${mode === 'cash' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'cash'} onChange={() => setMode('cash')} />
            💳 Dinheiro
            <small>Escrow em R$ · taxa da plataforma 15%</small>
          </label>
          <label className={`radio-card ${mode === 'credits' ? 'on' : ''} ${canCredits ? '' : 'off'}`}>
            <input
              type="radio"
              name="mode"
              disabled={!canCredits}
              checked={mode === 'credits'}
              onChange={() => canCredits && setMode('credits')}
            />
            🪙 Créditos Escambo
            <small>
              Você tem {credits} · sem taxa
              {!canCredits && priceNum > 0 ? ` · precisa de ${creditsNeeded}` : ''}
            </small>
          </label>
        </div>

        <div className="summary">
          <strong>{mode === 'credits' ? `${creditsNeeded} créditos` : brl(priceNum)}</strong>
          <span className="muted tiny">
            {mode === 'credits' ? 'retidos no aceite · liberados na aprovação' : 'freelancer recebe 85% via escrow'}
          </span>
        </div>

        <Button type="submit" disabled={create.isPending || priceNum < 10}>
          {create.isPending ? 'Enviando…' : 'Enviar proposta'}
        </Button>
      </form>
    </Modal>
  );
}
