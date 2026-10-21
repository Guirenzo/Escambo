import { ArrowLeftRight, Check, Scale, ShieldCheck, Wallet } from 'lucide-react';
import { money, TRADE_EXAMPLE } from '../landing/facts';
import { PAIR_PHOTO } from '../landing/photos';

const TORNA = TRADE_EXAMPLE.requested - TRADE_EXAMPLE.offered;

/**
 * O painel escuro ao lado do formulário de entrar e criar conta: uma frase curta, a foto de dois
 * profissionais trabalhando juntos e dois recortes do app (uma proposta de troca e o aviso de
 * pagamento). A foto e os recortes são ilustração (`aria-hidden`); a frase e as garantias são
 * texto. No celular o painel sai e fica só o formulário
 * (a foto, preguiçosa, nem chega a ser baixada).
 */
export function AuthPanel() {
  return (
    <div className="au-panel">
      <div className="au-panel-glow" aria-hidden="true" />
      <p className="au-quote">
        Contrate com o pagamento guardado. Ou pague com o <span>seu trabalho</span>.
      </p>
      <div className="au-collage" aria-hidden="true">
        <img
          src={PAIR_PHOTO.src}
          srcSet={PAIR_PHOTO.srcSet}
          sizes="32rem"
          width={PAIR_PHOTO.width}
          height={PAIR_PHOTO.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <div className="au-mock au-mock-trade">
          <p className="au-mock-title">
            <ArrowLeftRight size={14} />
            Proposta de troca
            <span>Nova</span>
          </p>
          <p className="au-mock-row">
            <span>Você oferece</span>
            <strong>Identidade visual</strong>
            <b>{money(TRADE_EXAMPLE.offered)}</b>
          </p>
          <p className="au-mock-row">
            <span>Você recebe</span>
            <strong>Landing page</strong>
            <b>{money(TRADE_EXAMPLE.requested)}</b>
          </p>
          <p className="au-mock-torna">
            <Wallet size={14} />
            Torna: você completa {money(TORNA)}
          </p>
        </div>
        <div className="au-mock au-mock-toast">
          <span className="au-mock-ico">
            <Check size={16} />
          </span>
          <p>
            <strong>Pagamento liberado</strong>
            {money(TRADE_EXAMPLE.requested)} na sua carteira
          </p>
        </div>
      </div>
      <ul className="au-assure">
        <li>
          <ShieldCheck size={18} aria-hidden="true" />
          Pagamento guardado até você aprovar
        </li>
        <li>
          <ArrowLeftRight size={18} aria-hidden="true" />
          Torna calculada pelo app
        </li>
        <li>
          <Scale size={18} aria-hidden="true" />
          Disputa com mediação da equipe
        </li>
      </ul>
    </div>
  );
}
