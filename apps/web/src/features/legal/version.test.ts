import { describe, expect, it } from 'vitest';
import type { Consent } from '@escambo/types';
import { LEGAL, LEGAL_CHANGES, LEGAL_UPDATED, LEGAL_VERSIONS } from './content';
import { answeredVersion, changesSince, compareVersions, legalAckPending } from './version';

const consent = (type: Consent['type'], version: string, accepted = true): Consent => ({
  type,
  version,
  accepted,
  at: '2026-09-24T12:00:00.000Z',
});

/** A versão por documento e a faixa de atualização (ADR 54) dependem destas contas. */
describe('versões dos documentos legais (ADR 54)', () => {
  it('a versão e a data vigentes de cada documento são a primeira linha do histórico dele', () => {
    for (const doc of ['termos', 'privacidade'] as const) {
      const mine = LEGAL_CHANGES.filter((c) => c.doc === doc);
      expect(mine[0]?.version).toBe(LEGAL_VERSIONS[doc]);
      expect(mine[0]?.date).toBe(LEGAL_UPDATED[doc]);
      // Da mais nova para a mais antiga, sem repetir.
      for (let i = 1; i < mine.length; i += 1) {
        expect(compareVersions(mine[i - 1]!.version, mine[i]!.version)).toBeGreaterThan(0);
      }
    }
    expect(LEGAL_VERSIONS.privacidade).toBe('1.6');
    expect(LEGAL_VERSIONS.termos).toBe('1.6');
    expect(LEGAL_UPDATED).toEqual({ termos: '2026-10-15', privacidade: '2026-10-15' });
  });

  it('compareVersions é numérica por segmento', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.3', '1.3')).toBe(0);
    expect(compareVersions('1.2', '1.3')).toBeLessThan(0);
  });

  it('legalAckPending: sem registro ou em versão antiga está pendente; aceito ou recusado na vigente não', () => {
    expect(legalAckPending([], 'privacidade')).toBe(true);
    expect(legalAckPending([consent('privacy_policy', '1.3')], 'privacidade')).toBe(true);
    expect(legalAckPending([consent('privacy_policy', '1.4')], 'privacidade')).toBe(true);
    expect(legalAckPending([consent('privacy_policy', '1.4', false)], 'privacidade')).toBe(true);
    expect(legalAckPending([consent('privacy_policy', '1.5')], 'privacidade')).toBe(true);
    expect(legalAckPending([consent('privacy_policy', '1.6')], 'privacidade')).toBe(false);
    expect(legalAckPending([consent('privacy_policy', '1.6', false)], 'privacidade')).toBe(false);
    // Vale o registro mais recente (a lista vem da mais nova para a mais antiga).
    expect(
      legalAckPending(
        [consent('privacy_policy', '1.6'), consent('privacy_policy', '1.5')],
        'privacidade',
      ),
    ).toBe(false);
    // A resposta à 1.5 continua no histórico, mas a 1.6 precisa de nova ciência.
    expect(legalAckPending([consent('terms_of_use', '1.2')], 'termos')).toBe(true);
    expect(legalAckPending([consent('terms_of_use', '1.3')], 'termos')).toBe(true);
    expect(legalAckPending([consent('terms_of_use', '1.4')], 'termos')).toBe(true);
    expect(legalAckPending([consent('terms_of_use', '1.5')], 'termos')).toBe(true);
    expect(legalAckPending([consent('terms_of_use', '1.6')], 'termos')).toBe(false);
  });

  it('changesSince: só o que veio depois da versão respondida; sem resposta, só a vigente', () => {
    expect(answeredVersion([consent('privacy_policy', '1.1')], 'privacidade')).toBe('1.1');
    expect(changesSince('privacidade', '1.1').map((c) => c.version)).toEqual([
      '1.6',
      '1.5',
      '1.4',
      '1.3',
      '1.2',
    ]);
    expect(changesSince('privacidade', '1.2').map((c) => c.version)).toEqual([
      '1.6',
      '1.5',
      '1.4',
      '1.3',
    ]);
    expect(changesSince('privacidade', '1.3').map((c) => c.version)).toEqual(['1.6', '1.5', '1.4']);
    expect(changesSince('privacidade', '1.4').map((c) => c.version)).toEqual(['1.6', '1.5']);
    expect(changesSince('privacidade', '1.5').map((c) => c.version)).toEqual(['1.6']);
    expect(changesSince('privacidade', null).map((c) => c.version)).toEqual(['1.6']);
    expect(changesSince('termos', '1.2').map((c) => c.version)).toEqual([
      '1.6',
      '1.5',
      '1.4',
      '1.3',
    ]);
    expect(changesSince('termos', '1.3').map((c) => c.version)).toEqual(['1.6', '1.5', '1.4']);
    expect(changesSince('termos', '1.4').map((c) => c.version)).toEqual(['1.6', '1.5']);
    expect(changesSince('termos', '1.5').map((c) => c.version)).toEqual(['1.6']);
    expect(changesSince('termos', null).map((c) => c.version)).toEqual(['1.6']);
    expect(changesSince('termos', '1.6')).toEqual([]);
  });

  it('a política 1.4 diz o que sai no silêncio, sem prometer silêncio absoluto (ADR 56)', () => {
    const texto = LEGAL.privacidade.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain('o que você escolher deixar sair mesmo durante ele');
    expect(texto).toContain('prioridade alta');
    expect(texto).toContain('prazo de guarda');
    expect(texto).toContain('com avisos que saíram antes de o silêncio começar');
    expect(texto).not.toContain('nenhum aviso bate');
    expect(texto).not.toContain('não bater no aparelho durante o silêncio');
    expect(texto).toContain('As versões anteriores à 1.3');
  });

  it('os Termos dizem a regra do prazo e do cancelamento sem prometer números fixos (ADR 57)', () => {
    const texto = LEGAL.termos.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain(
      'se o freelancer desistir, tudo o que está em garantia volta ao cliente',
    );
    expect(texto).toContain(
      'Com o prazo vencido sem nenhuma entrega, a partir do aviso do Escambo',
    );
    expect(texto).toContain('O app mostra os valores antes de confirmar');
    expect(texto).toContain('O prazo só abre disputa sozinho enquanto há trabalho nunca entregue');
    expect(texto).toContain('por marcos, enquanto algum marco não foi entregue');
    expect(texto).toContain('(hoje, 15%)');
    expect(texto).not.toMatch(/cobra 15%|taxa de 15%/);
    expect(texto).toContain('até duas vezes, e só uma pode ser aceita');
    expect(texto).toContain('entre 21h e 9h no horário de quem é afetado');
    // Os números configuráveis aparecem como "hoje": o painel pode mudá-los.
    expect(texto).toContain('(hoje, 5 dias corridos depois)');
    expect(texto).toContain('(hoje, 48 horas)');
    expect(texto).not.toContain('responder a uma entrega em 5 dias');
  });

  it('os Termos 1.4 dizem que o prazo é um dia no horário de quem entrega e que o lembrete é um aviso a mais (ADR 58)', () => {
    const texto = LEGAL.termos.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain(
      'O prazo de entrega é uma data e vale até 23:59 dela no horário de quem entrega; quando a outra parte está em outro fuso, o app diz de qual horário se trata.',
    );
    expect(texto).toContain(
      'Nas contratações criadas antes da implantação da versão 1.4 destes Termos, vale o dia e a hora que o app mostra.',
    );
    expect(texto).toContain(
      'O lembrete é um aviso a mais: sai no máximo uma vez por contagem, pode não sair quando a contagem começa perto do vencimento, e não suspende, não adia nem condiciona nenhuma hora.',
    );
    expect(texto).toContain('as duas partes são avisadas quando isso acontece');
    expect(texto).toContain('se ficar 7 dias sem nova entrega, as duas partes são avisadas');
    expect(texto).toMatch(/a entrega aprovada não volta para revisão/i);
    expect(texto).not.toContain('O prazo de entrega vale até 23:59 do dia escolhido.');
    const mudanca = LEGAL_CHANGES.find((c) => c.doc === 'termos' && c.version === '1.4');
    expect(mudanca?.date).toBe('2026-10-03');
    expect(mudanca?.summary).toContain('O lembrete é um aviso a mais e não muda nenhuma hora.');
  });

  it('a política diz o que o push guarda, com quem compartilha e por quanto tempo', () => {
    const texto = LEGAL.privacidade.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain('fora do Brasil');
    expect(texto).toContain('horário de silêncio');
    expect(texto).toContain('180 dias');
    expect(texto).toContain('aceito pelo serviço de push');
    expect(LEGAL.privacidade.sections.map((s) => s.title)).toContain(
      '6. Alterações desta política',
    );
  });

  it('os Termos 1.5 informam os limites da contratação e preservam os direitos da janela manual', () => {
    const texto = LEGAL.termos.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain('até 5 ofertas em 3 rodadas');
    expect(texto).toContain('a reserva acompanha a última oferta do cliente');
    expect(texto).toContain('2 em cada marco');
    expect(texto).toContain('as revisões continuam sem limite');
    expect(texto).toContain('não tira do cliente o direito de contestar');
    expect(texto).toContain('48 horas depois da primeira entrega registrada');
    expect(texto).toContain('pelo menos 24 horas antes da aprovação automática');
    expect(texto).toContain('sem esperar essa janela manual');
    expect(texto).toContain('até 7 dias');
    expect(texto).toContain('sem suspensão automática');
  });

  it('a Política 1.5 separa contagem pública de detalhes privados e de consentimento', () => {
    const texto = LEGAL.privacidade.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain('sem dizer qual contratação, com quem nem quando');
    expect(texto).toContain('não são mostrados ao cliente nem no perfil público');
    expect(texto).toContain('sempre de uma pessoa da equipe');
    expect(texto).toContain('formato 1.9');
    expect(texto).toContain('o texto das suas contestações de desistência');
    expect(texto).toContain('até o instante em que completa 60 dias, inclusive');
    expect(texto).toContain('Não aceitar a versão 1.5 não esconde as desistências do perfil');
    expect(texto).toContain('A resposta à política não altera a contagem nem limita essas opções');
  });

  it('os Termos candidatos distinguem consulta na suspensão e perda de acesso no banimento', () => {
    const texto = LEGAL.termos.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(texto).toContain('Durante a suspensão, o acesso permanece para consulta');
    expect(texto).toContain('ações de contratação, alteração e movimentação ficam bloqueadas');
    expect(texto).toContain(
      'contestações próprias e direitos sobre seus dados continuam disponíveis',
    );
    expect(texto).toContain('No banimento, a conta perde o acesso à plataforma');
    expect(texto).not.toContain('suspensas ou banidas, com perda imediata de acesso');
    expect(LEGAL_VERSIONS.termos).toBe('1.6');
  });

  it('preserva a comunicação da 1.5 no histórico e inclui suporte e exportação na 1.6', () => {
    const anterior = LEGAL_CHANGES.find((c) => c.doc === 'privacidade' && c.version === '1.5');
    expect(anterior?.date).toBe('2026-10-09');
    expect(anterior?.summary).toContain('formato 1.8');
    const terms = LEGAL.termos.sections.flatMap((s) => s.paragraphs).join('\n');
    const privacy = LEGAL.privacidade.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(terms).toContain('até três chamados não encerrados por conta, incluindo os resolvidos');
    expect(terms).toContain('cinco dias corridos para responder');
    expect(terms).toContain('Suporte, contestações próprias');
    expect(terms).toContain('Disputas financeiras continuam na Sala da contratação');
    expect(privacy).toContain('elas não são visíveis ao titular nem integram a cópia de dados');
    expect(privacy).toContain('formato 1.9');
    expect(privacy).toContain('incluindo notas internas');
    expect(privacy).toContain('protocolos, estados e datas');
  });
});
