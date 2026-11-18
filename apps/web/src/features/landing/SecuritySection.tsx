import { CreditCard, KeyRound, LockKeyhole, MailCheck, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * A segurança da conta e do dinheiro (#78), pedida na validação com a comunidade (PAC VIII): quem
 * chega quer saber por que pode confiar antes de criar a conta. Uma ficha de papel sobre a mesa,
 * com um carimbo por linha. Só o que o sistema faz de verdade: cada linha tem o código que a prova
 * (pagamento no Checkout Pro do Mercado Pago, ADR 73; verificação em duas etapas, ADR 66; os avisos
 * de senha, e-mail e Google; o CPF e o destino do saque cifrados, RNF-017).
 */

interface Row {
  Icon: LucideIcon;
  title: string;
  text: string;
  /** Sempre ligado, ou a pessoa escolhe ligar. */
  stamp: 'Sempre' | 'Opcional';
}

function rows(mercadoPago: boolean): Row[] {
  return [
    {
      Icon: CreditCard,
      title: 'Cartão fora do Escambo',
      text: mercadoPago
        ? 'Pix, cartão ou boleto na página do Mercado Pago: o número do cartão nunca passa por aqui.'
        : 'O depósito na carteira é por PIX: o Escambo não pede nem guarda número de cartão.',
      stamp: 'Sempre',
    },
    {
      Icon: MailCheck,
      title: 'Aviso a cada mudança na conta',
      text: 'Trocou a senha, o e-mail ou entrou com o Google pela primeira vez? Chega um e-mail na hora, para você agir se não foi você.',
      stamp: 'Sempre',
    },
    {
      Icon: LockKeyhole,
      title: 'CPF e dados de saque cifrados',
      text: 'Ficam guardados cifrados no banco de dados, e não aparecem para os outros usuários.',
      stamp: 'Sempre',
    },
    {
      Icon: KeyRound,
      title: 'Verificação em duas etapas',
      text: 'Além da senha, um código de 6 dígitos do seu aplicativo autenticador. Você liga no Perfil.',
      stamp: 'Opcional',
    },
  ];
}

export function SecuritySection({ mercadoPago }: { mercadoPago: boolean }) {
  return (
    <section className="lp-band lp-sec" id="seguranca" aria-labelledby="lp-sec-title">
      <div className="lp-wrap lp-sec-grid">
        <div className="lp-head lp-sec-copy">
          <h2 id="lp-sec-title">Sua conta e o seu dinheiro, trancados</h2>
          <p className="lp-sub">
            Antes de criar a conta, veja o que protege o que é seu, do login ao saque.
          </p>
          <p className="lp-sec-links">
            Os detalhes estão na <Link to="/privacidade">Política de Privacidade</Link> e nos{' '}
            <Link to="/termos">Termos de Uso</Link>.
          </p>
        </div>
        <div className="lp-sec-sheet">
          <p className="lp-sec-sheet-title" aria-hidden="true">
            Ficha de segurança da conta
          </p>
          <ul className="lp-sec-rows">
            {rows(mercadoPago).map(({ Icon, title, text, stamp }) => (
              <li key={title}>
                <span className="lp-sec-ico">
                  <Icon size={22} aria-hidden="true" />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                <span className={`lp-sec-stamp${stamp === 'Opcional' ? ' is-opt' : ''}`}>
                  {stamp}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
