/**
 * Documentos legais exibidos em /termos e /privacidade e aceitos no cadastro.
 * A versão é gravada no consentimento (LGPD): mudou o texto, suba a versão.
 */
export const LEGAL_VERSION = '1.1';
export const LEGAL_UPDATED = '2026-09-09';

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
}

export const LEGAL: Record<'termos' | 'privacidade', LegalDoc> = {
  termos: {
    title: 'Termos de Uso',
    intro:
      'Estes termos regulam o uso da plataforma Escambo, que conecta clientes e freelancers para contratação, troca e pagamento de serviços.',
    sections: [
      {
        title: '1. O que o Escambo é',
        paragraphs: [
          'O Escambo é uma plataforma de intermediação: quem presta o serviço é o freelancer, quem contrata é o cliente. A plataforma organiza a proposta, retém o valor combinado em escrow até a aprovação da entrega, oferece chat, troca de serviços (com torna), créditos internos e um índice de reputação.',
          'A plataforma não é parte do contrato de prestação de serviço entre cliente e freelancer, mas atua como mediadora em disputas conforme a seção 5.',
        ],
      },
      {
        title: '2. Conta e responsabilidades',
        paragraphs: [
          'Você precisa ter ao menos 18 anos e fornecer informações verdadeiras. Você é responsável pela guarda da sua senha e por tudo que acontece na sua conta; use "sair de todos os dispositivos" se suspeitar de acesso indevido.',
          'É proibido: negociar fora da plataforma para evitar a taxa, publicar conteúdo ilegal ou ofensivo, criar múltiplas contas para burlar reputação, e usar bots ou automações não autorizadas.',
        ],
      },
      {
        title: '3. Contratações, carteira, escrow e taxa',
        paragraphs: [
          'A carteira é pré-paga: o cliente deposita via PIX e, ao enviar uma proposta em dinheiro, o valor é reservado do saldo na hora. Se o freelancer recusar ou o cliente cancelar antes do aceite, a reserva volta integralmente. No aceite, o valor líquido fica retido (escrow) e é liberado ao freelancer quando o cliente aprova a entrega. A plataforma cobra 15% sobre o valor da contratação em dinheiro; contratações em créditos Escambo não têm taxa.',
          'Cancelamentos após o aceite e decisões de disputa devolvem ao cliente a fração do valor definida pela política ou pela mediação, e liberam ao freelancer a fração correspondente do líquido. Saques são solicitados na carteira, processados pela equipe e, se não puderem ser pagos, estornados ao saldo; o titular pode cancelar um saque ainda não processado.',
          'Se o cliente não responder a uma entrega em 5 dias, ela é aprovada automaticamente (aprovação tácita). O cliente pode, antes disso, pedir revisão ou abrir uma disputa.',
        ],
      },
      {
        title: '4. Trocas de serviço (escambo)',
        paragraphs: [
          'Uma troca gera dois contratos recíprocos, cada um com o fluxo normal de entrega e aprovação. Quando os valores não batem, a diferença (torna) é paga em dinheiro, com taxa apenas sobre a torna.',
        ],
      },
      {
        title: '5. Disputas e mediação',
        paragraphs: [
          'Qualquer parte pode abrir uma disputa numa contratação em andamento ou entregue. A contratação fica congelada e a equipe de mediação decide, com base no histórico da sala, se o valor em escrow é liberado ao freelancer, devolvido ao cliente ou dividido. A decisão é registrada e comunicada às partes.',
        ],
      },
      {
        title: '6. Reputação, avaliações e moderação',
        paragraphs: [
          'Só o cliente de uma contratação concluída pode avaliá-la, uma única vez, em até 7 dias. O freelancer pode responder publicamente uma vez. O Escambo Score é calculado a partir de avaliações, contratos concluídos e tempo de resposta, e é explicado no perfil.',
          'Contas que violem estes termos podem ser suspensas ou banidas, com perda imediata de acesso. Denúncias podem ser feitas pelo perfil do usuário.',
        ],
      },
      {
        title: '7. Alterações',
        paragraphs: [
          'Podemos atualizar estes termos; a versão vigente e a data aparecem no topo desta página. Mudanças relevantes serão comunicadas na plataforma e o uso continuado significa aceite.',
        ],
      },
    ],
  },
  privacidade: {
    title: 'Política de Privacidade',
    intro:
      'Esta política explica quais dados o Escambo coleta, para que usa, com quem compartilha e quais são os seus direitos, em conformidade com a Lei Geral de Proteção de Dados (LGPD).',
    sections: [
      {
        title: '1. Dados que coletamos',
        paragraphs: [
          'Conta: e-mail e senha (guardada como hash). Perfil: nome, cidade, estado, foto, apresentação e, se você autorizar, localização aproximada para a busca "perto de mim". Uso: contratações, mensagens do chat, avaliações, disputas, movimentações de carteira e créditos.',
          'Técnicos: endereço IP e navegador em eventos de segurança (login, consentimento, moderação), para auditoria.',
        ],
      },
      {
        title: '2. Para que usamos',
        paragraphs: [
          'Para operar a plataforma (contratar, pagar, conversar, mediar), calcular a reputação, notificar você sobre o que acontece nas suas contratações e manter a segurança e a conformidade legal.',
          'Não vendemos dados pessoais nem usamos seus dados para publicidade de terceiros.',
        ],
      },
      {
        title: '3. Compartilhamento',
        paragraphs: [
          'Seu nome, foto, cidade, avaliações e Score ficam visíveis para outros usuários no seu perfil público e nos seus serviços. Seus dados de contato não são exibidos. Compartilhamos dados apenas com provedores necessários para operar (hospedagem, e-mail) e quando exigido por lei.',
        ],
      },
      {
        title: '4. Seus direitos (LGPD)',
        paragraphs: [
          'Você pode, a qualquer momento no seu Perfil: ver os consentimentos que deu, solicitar uma cópia de todos os seus dados e solicitar a exclusão da conta. Solicitações são registradas com status e atendidas no prazo legal. Dados de contratações concluídas podem ser mantidos anonimizados para fins fiscais e de segurança.',
        ],
      },
      {
        title: '5. Segurança e retenção',
        paragraphs: [
          'Senhas com hash forte, sessões com tokens rotativos e revogáveis, comunicação cifrada, limites de tentativas de login e trilha de auditoria. Dados são mantidos enquanto a conta existir ou pelo prazo exigido por lei.',
        ],
      },
      {
        title: '6. Contato',
        paragraphs: [
          'Dúvidas e pedidos sobre privacidade: use as opções do seu Perfil ou o canal de suporte indicado na plataforma. A versão vigente desta política e a data de atualização aparecem no topo.',
        ],
      },
    ],
  },
};
