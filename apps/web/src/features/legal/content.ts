/**
 * Documentos legais exibidos em /termos e /privacidade e aceitos no cadastro. A versão é por
 * documento e é gravada no consentimento (LGPD): mudou o texto de um, sobe a versão E a data
 * dele, acrescenta a linha no histórico, e repete a versão em
 * apps/api/src/modules/lgpd/legal-versions.ts (a API grava o consentimento do cadastro e recusa
 * versão que não existe). Mudança que traz dado, finalidade ou compartilhamento novo é comunicada
 * na plataforma pela faixa de atualização (ADR 54).
 */
export type LegalKind = 'termos' | 'privacidade';

export const LEGAL_VERSIONS: Record<LegalKind, string> = { termos: '1.6', privacidade: '1.6' };
export const LEGAL_UPDATED: Record<LegalKind, string> = {
  termos: '2026-10-15',
  privacidade: '2026-10-15',
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
    version: '1.6',
    date: '2026-10-15',
    summary:
      'Suporte privado na plataforma: guardamos a categoria, o assunto, as mensagens, o vínculo opcional com uma contratação e as datas do atendimento. A equipe pode registrar notas internas, acessíveis apenas aos administradores. A cópia dos seus dados inclui os chamados próprios e as mensagens públicas de suporte, sem notas internas (formato 1.9). Ao anonimizar a conta, removemos o assunto e os textos dos seus chamados, inclusive notas internas, e as suas mensagens em outros chamados, preservando protocolos, estados e datas.',
  },
  {
    doc: 'termos',
    version: '1.6',
    date: '2026-10-15',
    summary:
      'Atendimento pelo menu Suporte, inclusive durante a suspensão: até três chamados não encerrados por conta. O chamado resolvido pode receber nova resposta durante cinco dias; depois é encerrado automaticamente. O titular também pode encerrar antes. O atendimento não altera valores ou prazos da contratação; disputas financeiras continuam na Sala da contratação.',
  },
  {
    doc: 'privacidade',
    version: '1.5',
    date: '2026-10-09',
    summary:
      'Se você trabalha como freelancer, o seu perfil público passa a mostrar quantas desistências de contratação depois do aceite você teve nos últimos 60 dias — só o número, sem dizer qual contratação, com quem nem quando —, contando a partir da implantação desta versão; com 3 ou mais, aparece um alerta e a equipe revisa a conta, sem suspensão automática. A base é o legítimo interesse de quem contrata, e não depende do seu aceite: você pode contestar cada desistência uma vez pelo Perfil, enquanto ela conta e antes de uma decisão, e uma pessoa da equipe decide. As propostas e contrapropostas de uma negociação entram nos dados da contratação, e a cópia dos seus dados passa a trazer as desistências e as ofertas (formato 1.8).',
  },
  {
    doc: 'privacidade',
    version: '1.4',
    date: '2026-09-25',
    summary:
      'No "não perturbe" dos avisos no navegador, você pode escolher o que sai mesmo durante o silêncio. Hoje há uma escolha só: o prazo vencido num trabalho que você entrega, enquanto ainda dá tempo de evitar a mediação automática. Quem entrega trabalho e liga o silêncio a partir de agora encontra a opção já marcada; quem já estava com o silêncio ligado continua sem nada saindo até marcá-la no Perfil. Os avisos que saem durante o silêncio vão ao serviço de push com prioridade alta, e a política passa a dizer também o prazo de guarda de cada aviso. A cópia dos seus dados passa a trazer a sua escolha.',
  },
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
    version: '1.5',
    date: '2026-10-09',
    summary:
      'Negociação: até 5 ofertas em 3 rodadas, com hora para responder a cada contraproposta (hoje, 48 horas) e a reserva em dinheiro acompanhando a última oferta do cliente. Revisões: até 2 sem custo por entrega (por marcos, em cada marco); mais uma, se o freelancer liberar, sem alterar o prazo da disputa ou da aprovação automática. Disputa manual: abre 48 horas depois da primeira entrega (ou do aceite, antes da entrega), sempre pelo menos 24 horas antes da aprovação automática; a disputa automática por prazo não espera. Desistência do freelancer depois do aceite: conta no perfil público por 60 dias, só como número; com 3 ou mais, o perfil mostra um alerta e a equipe revisa a conta. O cliente pode confirmar que foi combinada em até 7 dias, e o freelancer pode contestar pelo Perfil.',
  },
  {
    doc: 'termos',
    version: '1.4',
    date: '2026-10-03',
    summary:
      'Prazos: o prazo de entrega é uma data e vale até 23:59 no horário de quem entrega (nas contratações anteriores, vale o dia e a hora que o app mostra). O Escambo passa a lembrar, a partir das 9h e em geral na véspera, o que vence com você: entregar, responder a uma proposta, aprovar uma entrega ou um marco, responder a um pedido de extensão. O lembrete é um aviso a mais e não muda nenhuma hora. A aprovação automática passa a avisar as duas partes, e a revisão parada há 7 dias também.',
  },
  {
    doc: 'termos',
    version: '1.3',
    date: '2026-09-28',
    summary:
      'Prazos: nada automático acontece de madrugada (o aviso de prazo vencido e a disputa automática saem a partir das 9h, na hora dita no aviso), a disputa automática só vale enquanto há trabalho nunca entregue, e o freelancer pode pedir extensão até duas vezes, com hora para o cliente responder. Cancelamento com o valor na tela antes de confirmar: a desistência do freelancer e o prazo vencido sem entrega devolvem tudo ao cliente.',
  },
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
          'A carteira é pré-paga: o cliente deposita via PIX e, ao enviar uma proposta em dinheiro, o valor é reservado do saldo na hora. Se o freelancer recusar ou o cliente cancelar antes do aceite, a reserva volta integralmente. No aceite, o valor líquido fica retido (escrow) e é liberado ao freelancer quando o cliente aprova a entrega. A plataforma cobra uma taxa sobre o valor da contratação em dinheiro (hoje, 15%); contratações em créditos Escambo não têm taxa.',
          'Antes do aceite, a proposta pode ser negociada. São até 5 ofertas em 3 rodadas: cliente, freelancer, cliente, freelancer, cliente. O freelancer aceita, recusa ou responde com uma contraproposta de valor e prazo (por marcos, o valor e a data de cada marco), dizendo o que muda; diante dela, o cliente aceita, faz outra contraproposta ou encerra. Na quinta oferta, o freelancer só aceita ou recusa. Cada contraproposta tem hora para a resposta, informada no aviso e na Sala (hoje, 48 horas). A hora de resposta fica na faixa das 9h às 20h30, sem incluir as 20h30, no horário de quem responde. Se a hora calculada cair fora dessa faixa, passa para as 9h seguintes; quando isso ultrapassaria o prazo da oferta, vale o último instante permitido na faixa antes desse prazo. Sem resposta, a negociação se encerra e a reserva volta inteira ao cliente, que pode enviar uma nova proposta. Em dinheiro, a reserva acompanha a última oferta do cliente: subir o valor reserva a diferença do saldo na hora, baixar devolve a diferença, e aceitar uma contraproposta do freelancer ajusta a reserva no aceite. A taxa é a gravada quando a proposta foi enviada. Qualquer parte pode encerrar a negociação a qualquer momento. Título, descrição, forma de pagamento e forma da proposta não mudam numa contraproposta, e a troca de serviços não tem contraproposta.',
          'Cancelamentos: antes do aceite, a reserva volta inteira. Depois do aceite, se o freelancer desistir, tudo o que está em garantia volta ao cliente; a desistência conta no perfil público dele (seção 6). Se o cliente cancelar antes do prazo, recebe metade do valor quando menos da metade do tempo entre o aceite e o prazo passou, e nada quando passou mais da metade; sem prazo definido, recebe metade. Com o prazo vencido sem nenhuma entrega, a partir do aviso do Escambo, o cliente recebe tudo de volta. O app mostra os valores antes de confirmar. Entrega registrada não se cancela: vai para aprovação, revisão ou, a partir da hora que o app mostra, disputa (seção 5). Nas contratações por marcos, o cancelamento espera a resposta a um marco entregue e só devolve o que ainda não foi liberado. Em créditos Escambo, os créditos em garantia voltam inteiros. Decisões de disputa devolvem ao cliente a fração definida pela mediação e liberam ao freelancer a fração correspondente do líquido. Saques são solicitados na carteira, processados pela equipe e, se não puderem ser pagos, estornados ao saldo; o titular pode cancelar um saque ainda não processado.',
          'Se o cliente não responder a uma entrega até a hora informada no aviso da entrega (hoje, 5 dias corridos depois), ela é aprovada automaticamente (aprovação tácita), e as duas partes são avisadas quando isso acontece. Antes disso, o cliente pode pedir até 2 revisões sem custo por unidade de entrega: na entrega única, 2 na contratação; por marcos, 2 em cada marco. Outras se combinam pelo chat, e o freelancer pode liberar mais uma pela Sala quando as incluídas acabam; trabalho adicional pago é uma nova contratação. Liberar mais uma revisão não muda o prazo da aprovação automática nem a hora de abertura da disputa (seção 5). O limite regula a garantia e a mediação do Escambo e não tira do cliente o direito de contestar uma entrega que não corresponde ao combinado. Nas contratações já registradas antes da implantação desta versão, as revisões continuam sem limite. A entrega aprovada não volta para revisão. Uma revisão pedida não termina sozinha: se ficar 7 dias sem nova entrega, as duas partes são avisadas, e o desfecho continua com elas (nova entrega, acordo pelo chat ou disputa, a partir da hora da seção 5).',
          'O prazo de entrega é uma data e vale até 23:59 dela no horário de quem entrega; quando a outra parte está em outro fuso, o app diz de qual horário se trata. Nas contratações criadas antes da implantação da versão 1.4 destes Termos, vale o dia e a hora que o app mostra. Se ele vencer sem nenhuma entrega, as duas partes são avisadas a partir das 9h do dia seguinte, no horário de quem entrega. Sem entrega nem extensão aceita até a hora informada nesse aviso (hoje, 24 horas depois), a disputa abre sozinha em nome do cliente e a mediação do Escambo decide sobre o valor. O prazo só abre disputa sozinho enquanto há trabalho nunca entregue: na entrega única, até a primeira entrega; por marcos, enquanto algum marco não foi entregue. O freelancer pode pedir extensão até duas vezes, e só uma pode ser aceita; o cliente responde até a hora informada no pedido (hoje, 48 horas), e sem resposta o pedido expira. Nenhuma ação automática por prazo acontece entre 21h e 9h no horário de quem é afetado: ela passa para as 9h seguintes.',
          'O Escambo envia lembretes a partir das 9h, no horário de quem recebe, em geral na véspera: a quem entrega, do prazo de entrega; a quem tem a vez, do fim da validade da proposta ou contraproposta; ao cliente, da aprovação automática e de um pedido de extensão esperando resposta. O lembrete é um aviso a mais: sai no máximo uma vez por contagem, pode não sair quando a contagem começa perto do vencimento, e não suspende, não adia nem condiciona nenhuma hora. Vale sempre a hora informada no aviso que abriu a contagem e na contratação.',
        ],
      },
      {
        title: '4. Trocas de serviço (escambo)',
        paragraphs: [
          'Uma troca gera dois contratos recíprocos, cada um com o fluxo normal de entrega e aprovação. Quando os valores não batem, a diferença (torna) é paga em dinheiro por quem recebe o serviço mais valioso: o valor é reservado da carteira ao propor ou ao aceitar, fica retido enquanto os dois lados entregam e é liberado ao outro lado, descontada a taxa da plataforma (hoje, 15%) sobre a torna, quando ambos aprovam. Recusa, cancelamento ou disputa devolvem a reserva.',
        ],
      },
      {
        title: '5. Disputas e mediação',
        paragraphs: [
          'Qualquer parte pode abrir uma disputa numa contratação em andamento, entregue ou em revisão depois de tentar resolver pelo chat da Sala: 48 horas depois da primeira entrega registrada (por marcos, do primeiro marco entregue) ou, antes de qualquer entrega, 48 horas depois do aceite. Se a primeira entrega vier depois da abertura dessa janela inicial, ela inicia uma nova espera, uma vez. Com uma entrega esperando o cliente, a janela abre sempre pelo menos 24 horas antes da aprovação automática: esse teto pode antecipar a espera de 48 horas. A reentrega da mesma unidade não fecha uma janela já aberta, e liberar mais uma revisão também não a adia. O app mostra a partir de quando. A contratação fica congelada e a equipe de mediação decide, com base no histórico da sala, se o valor em escrow é liberado ao freelancer, devolvido ao cliente ou dividido. A decisão é registrada e comunicada às partes. A plataforma também abre a disputa em nome do cliente quando o prazo vence sem nenhuma entrega (seção 3), sem esperar essa janela manual.',
        ],
      },
      {
        title: '6. Reputação, avaliações e moderação',
        paragraphs: [
          'Só o cliente de uma contratação concluída pode avaliá-la, uma única vez, em até 7 dias. O freelancer pode responder publicamente uma vez. O Escambo Score é calculado a partir de avaliações, contratos concluídos e tempo de resposta, e é explicado no perfil.',
          'A desistência do freelancer depois do aceite conta no perfil público dele por 60 dias, só como número, sem dizer qual contratação, com quem nem quando; com 3 ou mais nos últimos 60 dias, o perfil mostra um alerta e a equipe do Escambo revisa a conta, sem suspensão automática. A regra vale para contratações em dinheiro, créditos e troca de serviços. Recusar uma proposta, sair de uma negociação ou deixá-la expirar não conta. Não conta a desistência que o cliente confirmar como combinada, em até 7 dias, nem a que a equipe decidir não contar. A confirmação pode ser feita até o instante em que se completam os 7 dias, inclusive. O freelancer vê no Perfil quais contam e até quando, e pode contestar cada uma, uma vez, enquanto ela conta e antes de uma decisão da equipe; a decisão é de uma pessoa da equipe e vem com justificativa. Manter a desistência numa decisão não impede o cliente de confirmar o acordo dentro dos 7 dias. Contam só as desistências registradas a partir da implantação desta versão; o histórico anterior não é reconstruído.',
          'Contas que violem estes termos podem ser suspensas ou banidas. Durante a suspensão, o acesso permanece para consulta; ações de contratação, alteração e movimentação ficam bloqueadas. Suporte, contestações próprias e direitos sobre seus dados continuam disponíveis. No banimento, a conta perde o acesso à plataforma. Denúncias podem ser feitas pelo perfil do usuário.',
          'O menu Suporte permite abrir atendimento privado com a equipe, com até três chamados não encerrados por conta, incluindo os resolvidos. Após a resolução, você tem cinco dias corridos para responder e retomar o atendimento; ao completar esse prazo, o chamado é encerrado automaticamente. Você pode encerrar antes e liberar uma vaga. A equipe acompanha o prazo da primeira resposta por prioridade: baixa, 72 horas; média, 24 horas; alta, 8 horas; crítica, 2 horas corridas desde a abertura. Essas referências de atendimento não alteram valores ou prazos da contratação. Disputas financeiras continuam na Sala da contratação, sujeitas às regras de abertura.',
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
          'Suporte: categoria, assunto, descrição, mensagens, contratação vinculada quando informada, prioridade, situação, responsável e datas do atendimento. Os administradores podem registrar notas internas para conduzir o atendimento; elas não são visíveis ao titular nem integram a cópia de dados.',
          'Conta: e-mail, senha (guardada como hash) e o fuso horário da conta — no cadastro, o fuso que o seu navegador informa, quando é um dos fusos do Brasil; você pode trocá-lo no Perfil a qualquer momento. Perfil: nome, cidade, estado, foto, apresentação e, se você autorizar, localização aproximada para a busca "perto de mim". Uso: contratações (com as propostas e contrapropostas de cada negociação e a mensagem de quem propôs), mensagens do chat, avaliações, disputas, movimentações de carteira e créditos e, se você trabalha como freelancer, as desistências de contratações depois do aceite (a data, se o cliente confirmou que foi combinada, a sua contestação e a decisão da equipe).',
          'Técnicos: endereço IP e navegador em eventos de segurança (login, consentimento, moderação e a escolha do que sai durante o silêncio), para auditoria.',
          'Preferências de aviso: como você quer os e-mails (a cada evento, resumo diário ou só o essencial), a hora do resumo do dia e, se você ligar o "não perturbe", o horário de silêncio dos avisos no navegador dos seus aparelhos e o que você escolher deixar sair mesmo durante ele (hoje há uma escolha só: o prazo vencido num trabalho que você entrega; ela já vem marcada quando quem entrega trabalho liga o silêncio, e pode ser desmarcada a qualquer momento; quem ligou o silêncio antes da versão 1.4 desta política só a tem se marcar). Durante o silêncio, cada aviso que ficou por entregar recebe uma marca com a hora, usada só para o aviso único que chega ao fim do silêncio.',
          'Avisos no navegador: quando você liga os avisos em um aparelho, guardamos a assinatura que o navegador dele cria: o endereço do aparelho no serviço de push do navegador, as duas chaves que cifram cada aviso para aquele aparelho, a data em que foi ligado, a data do último aviso aceito pelo serviço de push e, se a última tentativa de envio falhou, uma marca disso. Junto da assinatura não guardamos o nome nem a versão do navegador; o endereço do serviço de push indica qual navegador é. Nada disso é coletado se você não ligar os avisos.',
        ],
      },
      {
        title: '2. Para que usamos',
        paragraphs: [
          'Para operar a plataforma (contratar, pagar, conversar, mediar), calcular a reputação, avisar você sobre o que acontece nas suas contratações — aqui dentro, por e-mail e, nos aparelhos em que você ligou, por aviso no navegador, respeitando o horário de silêncio e o que você deixar sair durante ele —, mostrar horas e datas no seu fuso, e manter a segurança e a conformidade legal.',
          'Se você trabalha como freelancer, contamos as suas desistências depois do aceite para mostrar no seu perfil público o número dos últimos 60 dias e, com 3 ou mais, um alerta, e para a equipe revisar a conta. A base é o legítimo interesse de quem contrata em saber da confiabilidade de quem vai receber o dinheiro em garantia, e da plataforma em contratações seguras (LGPD, art. 7º, IX). O alerta é calculado automaticamente; a revisão da conta e a decisão sobre uma contestação são sempre de uma pessoa da equipe. Esse alerta não suspende a conta automaticamente.',
          'Não vendemos dados pessoais nem usamos seus dados para publicidade de terceiros.',
          'A assinatura de push serve só para entregar avisos no aparelho que você ligou. O fuso e as preferências de aviso servem para mandar o resumo do dia na sua hora, escrever as datas no seu horário e, durante o silêncio, só bater no aparelho com o que você deixou sair, com o aviso de teste que você mesmo pedir ou, se o aparelho estava sem conexão, com avisos que saíram antes de o silêncio começar, de você ligá-lo ou de mudar o horário.',
        ],
      },
      {
        title: '3. Compartilhamento',
        paragraphs: [
          'Seu nome, foto, cidade, avaliações e Score ficam visíveis para outros usuários no seu perfil público e nos seus serviços; se você trabalha como freelancer, o perfil público mostra também quantas desistências depois do aceite você teve nos últimos 60 dias e, com 3 ou mais, um alerta — sem dizer qual contratação, com quem nem quando. O texto da sua contestação e a justificativa da decisão ficam disponíveis para você e para a equipe; não são mostrados ao cliente nem no perfil público. Seus dados de contato não são exibidos. Compartilhamos dados apenas com provedores necessários para operar (hospedagem, envio de e-mail e, se você ligar os avisos, o serviço de push do seu navegador) e quando exigido por lei.',
          'Os avisos no navegador passam pelo serviço de push que o seu navegador usa (o do Google, da Mozilla, da Microsoft ou da Apple; navegadores como Brave, Opera e Samsung Internet usam o do Google). Esses serviços ficam fora do Brasil: ao ligar os avisos em um aparelho você autoriza essa transferência, que se limita ao endereço da assinatura daquele aparelho; ao horário, ao tamanho, ao prazo de guarda e à prioridade de entrega de cada aviso; e ao aviso cifrado, guardado por eles até a entrega ou até o fim do prazo de guarda, de no máximo 12 horas. A prioridade é a normal, menos nos avisos que saem durante o seu silêncio porque você escolheu deixá-los sair: esses vão com prioridade alta, para o serviço de push não esperar o aparelho sair da economia de bateria. O serviço de push não recebe seu nome, seu e-mail nem o conteúdo do aviso, que só o seu aparelho consegue ler. Esse compartilhamento só existe nos aparelhos em que você ligou os avisos e termina quando você os desliga.',
        ],
      },
      {
        title: '4. Seus direitos (LGPD)',
        paragraphs: [
          'Você pode, a qualquer momento no seu Perfil: ver os consentimentos que deu e as versões desta política que aceitou ou recusou, baixar uma cópia de todos os seus dados (arquivo JSON gerado na hora, disponível por 7 dias, que inclui as suas preferências de aviso, as assinaturas de aviso dos seus aparelhos — sem o segredo de cifra, que sai como impressão —, os avisos que ficaram para o resumo, as suas sessões, os registros de segurança, os e-mails que a plataforma mandou para você, as suas desistências como freelancer, as ofertas das negociações de que você participou, os seus chamados de suporte e as mensagens públicas de suporte vinculadas a você, sem notas internas — formato 1.9) e solicitar a exclusão da conta.',
          'Você pode contestar cada desistência que conta no seu perfil, uma vez, pelo Perfil, enquanto ela conta e antes de uma decisão da equipe; uma pessoa da equipe decide, informa a justificativa e você é avisado (LGPD, art. 20). A equipe pode deixar de contar uma desistência também por iniciativa própria, e o cliente pode confirmar que foi combinada em até 7 dias, inclusive.',
          'Os avisos no navegador dependem de um consentimento seu, dado aparelho por aparelho ao ligar, e revogável a qualquer momento: desligar no Perfil apaga a assinatura daquele aparelho na hora; sair de todos os dispositivos, redefinir a senha e encerrar a conta apagam as de todos. Revogar a permissão só nas configurações do navegador impede a entrega, mas a assinatura fica registrada até a próxima tentativa de envio ser recusada ou até o expurgo descrito na seção 5.',
          'A exclusão é analisada pela equipe e, quando concluída, anonimiza a conta: e-mail, telefone, senha, perfil, serviços, favoritos, buscas salvas, notificações, preferências de aviso, as assinaturas de aviso dos seus aparelhos, o texto das suas contestações de desistência e a justificativa dessas decisões são removidos e o acesso é encerrado. O assunto e todos os textos dos seus chamados de suporte, inclusive notas internas, e as suas mensagens em outros chamados também são substituídos, mantendo protocolos, estados e datas. Contratações, mensagens, avaliações e extratos são mantidos sem identificação, para obrigações fiscais e segurança das outras partes. Contratações em andamento ou saldo na carteira precisam ser encerrados antes do pedido; uma recusa vem sempre com justificativa.',
        ],
      },
      {
        title: '5. Segurança e retenção',
        paragraphs: [
          'Chamados e mensagens de suporte são privados, disponíveis ao titular e aos administradores; as notas internas ficam restritas à equipe administrativa. O conteúdo serve para responder pedidos e manter a continuidade do atendimento. Na anonimização, o assunto e os textos dos chamados próprios, incluindo notas internas, e as mensagens de autoria do titular em outros chamados são substituídos; protocolos, estados e datas ficam como registro do atendimento, sem novos alertas ou alterações pela rotina de suporte.',
          'Senhas com hash forte, sessões com tokens rotativos e revogáveis, comunicação cifrada, limites de tentativas de login e trilha de auditoria. Dados são mantidos enquanto a conta existir ou pelo prazo exigido por lei.',
          'Uma desistência entra na contagem pública até o instante em que completa 60 dias, inclusive; depois disso deixa de ser contada. Confirmada como combinada pelo cliente ou excluída pela equipe, deixa de contar antes. O registro interno fica com a contratação, como o resto da linha do tempo; na exclusão da conta, o texto da contestação e a justificativa da decisão são removidos.',
          'A assinatura de um aparelho é apagada quando você desliga os avisos nele, sai de todos os dispositivos, redefine a senha ou encerra a conta; quando o serviço de push recusa uma entrega dizendo que o aparelho não existe mais; e, em qualquer caso, depois de 180 dias sem nenhum aviso aceito pelo serviço de push. As chaves da assinatura são as que o seu navegador gerou: permitem cifrar avisos para aquele aparelho e nada mais. A marca de aviso retido pelo silêncio vive na própria notificação e some com ela.',
        ],
      },
      {
        title: '6. Alterações desta política',
        paragraphs: [
          'Podemos atualizar esta política quando a plataforma passar a tratar dados novos, a usá-los para outra finalidade ou a compartilhá-los com alguém novo. A versão vigente e a data aparecem no topo, e o histórico no fim desta página resume o que mudou em cada versão.',
          'Quem já tem conta é avisado dentro da plataforma, com destaque, ao entrar: uma faixa no topo resume a mudança, leva ao texto completo e oferece aceitar ou não aceitar a versão nova. A resposta fica registrada nos seus consentimentos, no Perfil, com a versão, a data, o endereço IP e o navegador usados. Não aceitar não encerra a conta: os recursos que dependem de uma escolha sua, como os avisos no navegador, só tratam dados depois que você os liga e podem ser desligados a qualquer momento; se ainda assim não concordar, você pode pedir a exclusão da conta.',
          'Não aceitar a versão 1.5 não esconde as desistências do perfil: elas são regra de uso (Termos 1.5) e servem à segurança de quem contrata, com base no legítimo interesse, não no seu consentimento. Você pode contestar cada uma conforme a seção 4 ou pedir a exclusão da conta. A resposta à política não altera a contagem nem limita essas opções.',
          'As versões anteriores à 1.3 descreviam a plataforma antes dos avisos no navegador e do fuso detectado no cadastro, que entraram no ar em 22/09/2026; a 1.3 passou a cobri-los, e a informação sobre o navegador do aparelho, guardada nesse intervalo, foi apagada.',
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
