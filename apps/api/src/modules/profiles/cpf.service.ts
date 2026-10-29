import type { AdminCpfSummary, CpfStatus } from '@escambo/types';
import { clock } from '../../utils/clock';
import { ageOn, maskCpf } from '../../utils/documents';
import {
  blindIndex,
  blindIndexCandidates,
  FIELD_UNAVAILABLE,
  fieldEncryptionEnabled,
  isSealedField,
  openField,
  sealField,
} from '../../utils/field-crypto';
import { HttpError } from '../../utils/http-error';
import { dayIn, timezoneOf } from '../../utils/timezone';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import { authFacade } from '../auth/auth.facade';
import type { RequestContext } from '../auth/auth.service';
import { profilesRepository, type CpfRow } from './profiles.repository';
import type { VerifyCpfInput } from './profiles.schema';

/**
 * CPF do freelancer (RF-020, RN-009, RN-075, ADR da 1.53.0). O freelancer informa o CPF e a data de
 * nascimento no Perfil; a validação confere os dígitos verificadores, a unicidade entre contas (pelo
 * índice cego) e a maioridade no dia de hoje do fuso da conta. Não é consulta à Receita: um CPF
 * válido aqui pode não ser de quem o digitou. O CPF é gravado só cifrado (sem a FIELD_ENCRYPTION_KEY,
 * nada é gravado e o recurso fica indisponível), sai das telas só mascarado e nunca vai para log nem
 * para a auditoria. Validado, não se edita pela tela: a correção é pelo atendimento.
 */

/** Contexto do índice cego do CPF: a chave dele não serve para nenhum outro campo. */
export const CPF_INDEX_CONTEXT = 'cpf';

/** RN-009: funcionalidades financeiras só para maiores de 18. */
export const MIN_AGE = 18;

const unavailable = (): HttpError =>
  new HttpError(
    503,
    'A validação de CPF ainda não está disponível neste servidor. Fale com o suporte.',
    'cpf_unavailable',
  );

/** O CPF mascarado de uma linha; "[indisponível]" se o cifrado não abriu (chave errada, dado ruim). */
function maskedOf(row: CpfRow): string | null {
  if (!row.cpf_encrypted) return null;
  const opened = openField(row.cpf_encrypted);
  return opened.ok && /^\d{11}$/.test(opened.value) ? maskCpf(opened.value) : FIELD_UNAVAILABLE;
}

const iso = (at: Date | null): string | null => (at ? new Date(at).toISOString() : null);

export const cpfService = {
  async status(userId: number): Promise<CpfStatus> {
    const [row, payout] = await Promise.all([
      profilesRepository.findCpf(userId),
      profilesRepository.payoutState(userId),
    ]);
    const verified = Number(row?.cpf_verified ?? 0) === 1;
    return {
      available: fieldEncryptionEnabled(),
      required: Number(payout?.delivers_work ?? 0) === 1,
      hasFreelancerProfile: row !== undefined,
      verified,
      maskedCpf: verified && row ? maskedOf(row) : null,
      birthDate: verified ? (row?.birth_date ?? null) : null,
      verifiedAt: verified ? iso(row?.cpf_verified_at ?? null) : null,
    };
  },

  /**
   * Valida e grava (RF-020). A ordem das recusas é a do formulário: servidor sem a chave, sem perfil
   * de freelancer, já validado, menor de idade, CPF de outra conta. Duas abas validando ao mesmo
   * tempo: o UPDATE condicionado deixa passar uma; o mesmo CPF em duas contas ao mesmo tempo: a
   * chave única deixa passar uma.
   */
  async verify(userId: number, input: VerifyCpfInput, ctx: RequestContext): Promise<CpfStatus> {
    if (!fieldEncryptionEnabled()) throw unavailable();
    const row = await profilesRepository.findCpf(userId);
    if (!row) {
      throw new HttpError(
        409,
        'Salve primeiro os seus dados de freelancer: o CPF fica no perfil de freelancer.',
        'no_freelancer_profile',
      );
    }
    if (Number(row.cpf_verified) === 1) throw locked();

    const user = await authFacade.findById(userId);
    const now = clock.now();
    const today = dayIn(timezoneOf(user?.timezone), now);
    if (input.birthDate > today) {
      throw new HttpError(
        422,
        'A data de nascimento não pode ser no futuro.',
        'invalid_birth_date',
      );
    }
    if ((ageOn(input.birthDate, today) ?? 0) < MIN_AGE) {
      throw new HttpError(
        422,
        'Para receber pelo Escambo é preciso ter 18 anos ou mais (RN-009).',
        'underage',
      );
    }

    const candidates = blindIndexCandidates(CPF_INDEX_CONTEXT, input.cpf);
    if (await profilesRepository.cpfIndexTaken(candidates, userId)) throw taken();
    const sealedCpf = sealField(input.cpf);
    const index = blindIndex(CPF_INDEX_CONTEXT, input.cpf);
    // A chave foi conferida acima; isto segura uma regressão no field-crypto: texto puro não grava.
    if (!isSealedField(sealedCpf) || !index) throw unavailable();

    let saved: boolean;
    try {
      saved = await profilesRepository.saveVerifiedCpf(userId, {
        sealedCpf,
        index,
        birthDate: input.birthDate,
        verifiedAt: now,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw taken();
      throw err;
    }
    if (!saved) throw locked();
    // Sem o CPF, nem mascarado: a auditoria registra o fato, não o documento.
    void auditService.log({
      userId,
      action: 'cpf_verified',
      entityType: 'user',
      entityId: userId,
      ip: ctx.ip,
      userAgent: userAgentOf(ctx.userAgent),
    });
    return this.status(userId);
  },

  /** Para o atendimento (RF-020): validado ou não e o CPF mascarado; null sem perfil de freelancer. */
  async adminSummary(userId: number): Promise<AdminCpfSummary | null> {
    const row = await profilesRepository.findCpf(userId);
    if (!row) return null;
    const verified = Number(row.cpf_verified) === 1;
    return {
      verified,
      maskedCpf: maskedOf(row),
      verifiedAt: verified ? iso(row.cpf_verified_at) : null,
    };
  },

  /** Apaga o CPF para o titular informar de novo (o atendimento corrige). false: não havia CPF. */
  clear(userId: number): Promise<boolean> {
    return profilesRepository.clearCpf(userId);
  },
};

function locked(): HttpError {
  return new HttpError(
    409,
    'O CPF desta conta já foi validado e não se altera pela tela. Para corrigir, fale com o suporte.',
    'cpf_locked',
  );
}

function taken(): HttpError {
  return new HttpError(
    409,
    'Este CPF já está em outra conta do Escambo. Se ele é seu, fale com o suporte.',
    'cpf_taken',
  );
}
