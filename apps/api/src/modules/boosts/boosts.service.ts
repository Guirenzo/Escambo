import type { Boost, BoostPlan, BoostStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { formatDateTime } from '../../utils/timezone';
import { userZone } from '../auth/user-zone';
import { servicesRepository } from '../services/services.repository';
import { boostsRepository, type BoostPlanRow, type BoostRow } from './boosts.repository';

/** Custo do boost em créditos Escambo (1 crédito ≈ R$1 do plano), nunca de graça: no mínimo 1. */
const costCreditsOf = (priceReais: number): number => Math.max(1, Math.round(priceReais));

function parseFeatures(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return raw as Record<string, unknown>;
}

function toPlan(r: BoostPlanRow): BoostPlan {
  const price = Number(r.price);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    durationDays: r.duration_days,
    price,
    costCredits: costCreditsOf(price),
    features: parseFeatures(r.features),
  };
}

function toBoost(r: BoostRow): Boost {
  return {
    id: r.id,
    serviceId: r.service_id,
    planId: r.plan_id,
    planName: r.plan_name,
    status: r.status as BoostStatus,
    startsAt: new Date(r.starts_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const boostsService = {
  async plans(): Promise<BoostPlan[]> {
    return (await boostsRepository.listPlans()).map(toPlan);
  },

  /** Compra um impulsionamento para um serviço do próprio usuário, pago em créditos. */
  async buy(userId: number, serviceId: number, planId: number): Promise<Boost> {
    const service = await servicesRepository.findById(serviceId);
    if (!service) throw new HttpError(404, 'Serviço não encontrado', 'service_not_found');
    if (service.user_id !== userId) {
      throw new HttpError(403, 'Você só pode impulsionar os seus serviços', 'forbidden');
    }
    // Pausado não aparece na busca: o destaque seria cobrado sem aparecer.
    if (!service.is_active) {
      throw new HttpError(
        409,
        'Serviço pausado não pode ser impulsionado: reative-o antes',
        'service_inactive',
      );
    }
    const plan = await boostsRepository.findPlan(planId);
    if (!plan)
      throw new HttpError(404, 'Plano de impulsionamento não encontrado', 'plan_not_found');

    const cost = costCreditsOf(Number(plan.price));
    const result = await boostsRepository.purchase({
      userId,
      serviceId,
      planId,
      cost,
      durationDays: plan.duration_days,
    });
    if ('refused' in result) {
      if (result.refused === 'boost_active') {
        const zone = await userZone(userId);
        throw new HttpError(
          409,
          `Este serviço já tem um impulsionamento ativo até ${formatDateTime(result.activeUntil, zone)}; um novo só depois que ele terminar (RN-017)`,
          'boost_active',
        );
      }
      throw new HttpError(409, 'Créditos insuficientes para impulsionar', 'insufficient_credits');
    }
    return toBoost((await boostsRepository.findById(result.boostId))!);
  },

  async listMine(userId: number): Promise<Boost[]> {
    return (await boostsRepository.listForUser(userId)).map(toBoost);
  },
};
