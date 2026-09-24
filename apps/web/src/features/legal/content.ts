/**
 * Documentos legais exibidos em /termos e /privacidade e aceitos no cadastro. A versão é por
 * documento e é gravada no consentimento (LGPD): mudou o texto de um, sobe a versão E a data
 * dele, acrescenta a linha no histórico, e repete a versão em
 * apps/api/src/modules/lgpd/legal-versions.ts (a API grava o consentimento do cadastro e recusa
 * versão que não existe). Mudança que traz dado, finalidade ou compartilhamento novo é comunicada
 * na plataforma pela faixa de atualização (ADR 54).
 */
export type LegalKind = 'termos' | 'privacidade';

export const LEGAL_VERSIONS: Record<LegalKind, string> = { termos: '1.2', privacidade: '1.3' };
export const LEGAL_UPDATED: Record<LegalKind, string> = {
  termos: '2026-09-09',
  privacidade: '2026-09-24',
};

export interface LegalChange {
  doc: LegalKind;
  version: string;
  date: string;
  summary: string;
}

/** Histórico de versões, da mais nova para a mais antiga, por documento. */
export const LEGAL_CHANGES: LegalChange[] = [
  {
    doc: 'privacidade',
    version: '1.3',
    date: '2026-09-24',
    summary:
      'Passa a descrever os avisos no navegador (a assinatura de cada aparelho e o serviço de push, fora do Brasil, que a entrega), o fuso horário detectado no cadastro, as preferências de aviso e o horário de silêncio. A cópia dos seus dados passa a incluir tudo isso, mais as sessões, os registros de segurança e os e-mails enviados. O navegador do aparelho, guardado até agora junto da assinatura, foi apagado. Seção nova sobre alterações desta política.',
  },
  {
    doc: 'privacidade',
    version: '1.2',
    date: '2026-09-09',
    summary: 'Cópia de dados baixável e exclusão da conta por anonimização, pelo Perfil.',
  },
  {
    doc: 'privacidade',
    version: '1.1',
    date: '2026-09-09',
    summary:
      'Acompanhou a carteira pré-paga: movimentações de carteira e créditos nos dados de uso.',
  },
  { doc: 'privacidade', version: '1.0', date: '2026-09-09', summary: 'Primeira versão.' },
  {
    doc: 'termos',
    version: '1.2',
    date: '2026-09-09',
    summary: 'Acompanhou a Política 1.2 (cópia de dados e exclusão da conta pelo Perfil).',
  },
  {
    doc: 'termos',
    version: '1.1',
    date: '2026-09-09',
    summary:
      'Carteira pré-paga: depósito por PIX, reserva do saldo ao propor e devoluções em cancelamento e disputa.',
  },
  { doc: 'termos', version: '1.0', date: '2026-09-09', summary: 'Primeira versão.' },
];

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
}

export const LEGAL: Record<LegalKind, LegalDoc> = {
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
          'Uma troca gera dois contratos recíprocos, cada um com o fluxo normal de entrega e aprovação. Quando os valores não batem, a diferença (torna) é paga em dinheiro por quem recebe o serviço mais valioso: o valor é reservado da carteira ao propor ou ao aceitar, fica retido enquanto os dois lados entregam e é liberado ao outro lado, descontada a taxa de 15% sobre a torna, quando ambos aprovam. Recusa, cancelamento ou disputa devolvem a reserva.',
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
          'Conta: e-mail, senha (guardada como hash) e o fuso horário da conta — no cadastro, o fuso que o seu navegador informa, quando é um dos fusos do Brasil; você pode trocá-lo no Perfil a qualquer momento. Perfil: nome, cidade, estado, foto, apresentação e, se você autorizar, localização aproximada para a busca "perto de mim". Uso: contratações, mensagens do chat, avaliações, disputas, movimentações de carteira e créditos.',
          'Técnicos: endereço IP e navegador em eventos de segurança (login, consentimento, moderação), para auditoria.',
          'Preferências de aviso: como você quer os e-mails (a cada evento, resumo diário ou só o essencial), a hora do resumo do dia e, se você ligar o "não perturbe", o horário em que nenhum aviso bate no navegador dos seus aparelhos. Durante o silêncio, cada aviso que ficou por entregar recebe uma marca com a hora, usada só para o aviso único que chega ao fim do silêncio.',
          'Avisos no navegador: quando você liga os avisos em um aparelho, guardamos a assinatura que o navegador dele cria: o endereço do aparelho no serviço de push do navegador, as duas chaves que cifram cada aviso para aquele aparelho, a data em que foi ligado, a data do último aviso aceito pelo serviço de push e, se a última tentativa de envio falhou, uma marca disso. Junto da assinatura não guardamos o nome nem a versão do navegador; o endereço do serviço de push indica qual navegador é. Nada disso é coletado se você não ligar os avisos.',
        ],
      },
      {
        title: '2. Para que usamos',
        paragraphs: [
          'Para operar a plataforma (contratar, pagar, conversar, mediar), calcular a reputação, avisar você sobre o que acontece nas suas contratações — aqui dentro, por e-mail e, nos aparelhos em que você ligou, por aviso no navegador, respeitando o horário de silêncio que escolher —, mostrar horas e datas no seu fuso, e manter a segurança e a conformidade legal.',
          'Não vendemos dados pessoais nem usamos seus dados para publicidade de terceiros.',
          'A assinatura de push serve só para entregar avisos no aparelho que você ligou. O fuso e as preferências de aviso servem para mandar o resumo do dia na sua hora, escrever as datas no seu horário e não bater no aparelho durante o silêncio.',
        ],
      },
      {
        title: '3. Compartilhamento',
        paragraphs: [
          'Seu nome, foto, cidade, avaliações e Score ficam visíveis para outros usuários no seu perfil público e nos seus serviços. Seus dados de contato não são exibidos. Compartilhamos dados apenas com provedores necessários para operar (hospedagem, envio de e-mail e, se você ligar os avisos, o serviço de push do seu navegador) e quando exigido por lei.',
          'Os avisos no navegador passam pelo serviço de push que o seu navegador usa (o do Google, da Mozilla, da Microsoft ou da Apple; navegadores como Brave, Opera e Samsung Internet usam o do Google). Esses serviços ficam fora do Brasil: ao ligar os avisos em um aparelho você autoriza essa transferência, que se limita ao endereço da assinatura daquele aparelho, ao horário e ao tamanho de cada aviso e ao aviso cifrado, guardado por eles até a entrega ou por no máximo 12 horas. O serviço de push não recebe seu nome, seu e-mail nem o conteúdo do aviso, que só o seu aparelho consegue ler. Esse compartilhamento só existe nos aparelhos em que você ligou os avisos e termina quando você os desliga.',
        ],
      },
      {
        title: '4. Seus direitos (LGPD)',
        paragraphs: [
          'Você pode, a qualquer momento no seu Perfil: ver os consentimentos que deu e as versões desta política que aceitou, baixar uma cópia de todos os seus dados (arquivo JSON gerado na hora, disponível por 7 dias, que inclui as suas preferências de aviso, as assinaturas de aviso dos seus aparelhos — sem o segredo de cifra, que sai como impressão —, os avisos que ficaram para o resumo, as suas sessões, os registros de segurança e os e-mails que a plataforma mandou para você) e solicitar a exclusão da conta.',
          'Os avisos no navegador dependem de um consentimento seu, dado aparelho por aparelho ao ligar, e revogável a qualquer momento: desligar no Perfil apaga a assinatura daquele aparelho na hora; sair de todos os dispositivos, redefinir a senha e encerrar a conta apagam as de todos. Revogar a permissão só nas configurações do navegador impede a entrega, mas a assinatura fica registrada até a próxima tentativa de envio ser recusada ou até o expurgo descrito na seção 5.',
          'A exclusão é analisada pela equipe e, quando concluída, anonimiza a conta: e-mail, telefone, senha, perfil, serviços, favoritos, buscas salvas, notificações, preferências de aviso e as assinaturas de aviso dos seus aparelhos são removidos e o acesso é encerrado. Contratações, mensagens, avaliações e extratos são mantidos sem identificação, para obrigações fiscais e segurança das outras partes. Contratações em andamento ou saldo na carteira precisam ser encerrados antes do pedido; uma recusa vem sempre com justificativa.',
        ],
      },
      {
        title: '5. Segurança e retenção',
        paragraphs: [
          'Senhas com hash forte, sessões com tokens rotativos e revogáveis, comunicação cifrada, limites de tentativas de login e trilha de auditoria. Dados são mantidos enquanto a conta existir ou pelo prazo exigido por lei.',
          'A assinatura de um aparelho é apagada quando você desliga os avisos nele, sai de todos os dispositivos, redefine a senha ou encerra a conta; quando o serviço de push recusa uma entrega dizendo que o aparelho não existe mais; e, em qualquer caso, depois de 180 dias sem nenhum aviso aceito pelo serviço de push. As chaves da assinatura são as que o seu navegador gerou: permitem cifrar avisos para aquele aparelho e nada mais. A marca de aviso retido pelo silêncio vive na própria notificação e some com ela.',
        ],
      },
      {
        title: '6. Alterações desta política',
        paragraphs: [
          'Podemos atualizar esta política quando a plataforma passar a tratar dados novos, a usá-los para outra finalidade ou a compartilhá-los com alguém novo. A versão vigente e a data aparecem no topo, e o histórico no fim desta página resume o que mudou em cada versão.',
          'Quem já tem conta é avisado dentro da plataforma, com destaque, ao entrar: uma faixa no topo resume a mudança, leva ao texto completo e oferece aceitar ou não aceitar a versão nova. A resposta fica registrada nos seus consentimentos, no Perfil, com a versão, a data, o endereço IP e o navegador usados. Não aceitar não encerra a conta: os recursos que dependem de uma escolha sua, como os avisos no navegador, só tratam dados depois que você os liga e podem ser desligados a qualquer momento; se ainda assim não concordar, você pode pedir a exclusão da conta.',
          'As versões anteriores a esta descreviam a plataforma antes dos avisos no navegador e do fuso detectado no cadastro, que entraram no ar em 22/09/2026; esta versão passa a cobri-los, e a informação sobre o navegador do aparelho, guardada nesse intervalo, foi apagada.',
        ],
      },
      {
        title: '7. Contato',
        paragraphs: [
          'Dúvidas e pedidos sobre privacidade: use as opções do seu Perfil ou o canal de suporte indicado na plataforma. A versão vigente desta política, a data de atualização e o histórico de versões aparecem nesta página.',
        ],
      },
    ],
  },
};
