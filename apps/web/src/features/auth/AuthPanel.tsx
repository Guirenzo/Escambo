import { ArrowLeftRight, Scale, ShieldCheck, UserRound } from 'lucide-react';
import { AlbumWall } from '../../components/AlbumWall';
import { HOLO } from '../landing/album';
import './auth.css';
import './album-auth.css';

/**
 * A cena atrás do formulário de entrar e criar conta: a parede do álbum, com os quadros numerados
 * e as figurinhas de serviço sendo coladas (umas chegam depois, como quem vai completando). É
 * ilustração (`aria-hidden`); a frase e as garantias, embaixo, são texto e somem no celular.
 */
export function AuthPanel() {
  return (
    <div className="au-panel">
      <AlbumWall />
      <div className="au-pitch">
        <p className="au-quote">
          Contrate com o pagamento guardado. Ou pague com o <span>seu trabalho</span>.
        </p>
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
    </div>
  );
}

/**
 * A figurinha de quem está entrando, impressa enquanto a pessoa digita: vazia, é o quadro que
 * falta no álbum; com o e-mail, ganha a inicial e o nome antes do @. Decorativa (`aria-hidden`):
 * repete o que está no campo e não guarda nada.
 */
export function MintSticker({ email, label }: { email: string; label: string }) {
  const local = email.trim().split('@')[0] ?? '';
  const initial = local[0]?.toUpperCase();
  return (
    <div className="au-mint" aria-hidden="true">
      {initial ? (
        <span className="al-sticker al-g-amber al-foil au-mint-sticker" {...HOLO}>
          <span className="al-sticker-photo">
            {/* A chave troca com a letra: a inicial "carimba" de novo. */}
            <span className="me-sticker-initial" key={initial}>
              {initial}
            </span>
          </span>
          <span className="al-sticker-band">
            <span className="al-sticker-title">{local}</span>
            <span className="al-sticker-who">{label}</span>
          </span>
        </span>
      ) : (
        <span className="au-slot">
          <UserRound size={30} strokeWidth={1.75} />
          <span>Falta a sua</span>
        </span>
      )}
    </div>
  );
}
