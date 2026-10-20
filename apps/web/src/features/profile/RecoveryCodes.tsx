import { Copy, Download } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { saveBlob } from '../../lib/download';
import { recoveryCodesText } from '../../lib/mfa';
import { useToast } from '../../lib/toast';

/**
 * Os códigos de recuperação, mostrados uma vez só (a API guarda apenas o hash). Copiar e baixar
 * ficam à mão, e "Concluir" só libera depois de a pessoa dizer que guardou: fechar sem guardar é
 * perder a saída de emergência para quando o celular some.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [saved, setSaved] = useState(false);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Os códigos substituem o passo anterior: o foco vai para o título deles, e o leitor de tela
  // começa a leitura daqui em vez de ficar perdido no topo da página.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast.success('Códigos copiados.');
    } catch {
      toast.info('Não deu para copiar daqui: selecione os códigos e copie, ou baixe o .txt.');
    }
  }

  function download(): void {
    const text = recoveryCodesText(codes, user?.email, new Date());
    saveBlob(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      'escambo-codigos-de-recuperacao.txt',
    );
  }

  return (
    <div className="stack" data-testid="mfa-recovery">
      <h4 className="mfa-step-title" id={titleId} ref={titleRef} tabIndex={-1}>
        Códigos de recuperação
      </h4>
      <p className="muted tiny">
        Se você perder o celular, cada código abaixo entra no lugar do código do app, uma vez só.
        Eles aparecem só agora: copie ou baixe e guarde num lugar seguro, como um gerenciador de
        senhas.
      </p>
      <ol className="mfa-codes" aria-labelledby={titleId} data-testid="mfa-recovery-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="acts">
        <Button type="button" variant="secondary" onClick={() => void copy()}>
          <Copy size={14} /> Copiar códigos
        </Button>
        <Button type="button" variant="secondary" onClick={download}>
          <Download size={14} /> Baixar .txt
        </Button>
      </div>
      <label className="consent">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>Guardei os códigos em lugar seguro</span>
      </label>
      <Button type="button" onClick={onDone} disabled={!saved}>
        Concluir
      </Button>
    </div>
  );
}
