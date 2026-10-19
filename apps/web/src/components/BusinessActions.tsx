import { useEffect, type ButtonHTMLAttributes, type FormHTMLAttributes } from 'react';
import { useReadOnlyAccount } from '../lib/account-access';
import { Button, Modal } from './ui';

export const READ_ONLY_MESSAGE = 'Conta suspensa: esta ação está indisponível durante a suspensão.';

/** Um modal de negócio aberto deixa de aceitar interação assim que a suspensão chega. */
export function BusinessModal(props: Parameters<typeof Modal>[0]) {
  const readOnly = useReadOnlyAccount();
  const close = props.onClose;
  useEffect(() => {
    if (readOnly) close();
  }, [readOnly, close]);
  return readOnly ? null : <Modal {...props} />;
}

/** Comando de negócio; navegação, consultas e direitos do titular usam os controles comuns. */
export function BusinessButton(props: Parameters<typeof Button>[0]) {
  const readOnly = useReadOnlyAccount();
  return (
    <Button
      {...props}
      disabled={readOnly || props.disabled}
      title={readOnly ? READ_ONLY_MESSAGE : props.title}
    />
  );
}

/** Variante para botões cujo estilo não vem do kit visual. */
export function BusinessIconButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const readOnly = useReadOnlyAccount();
  return (
    <button
      {...props}
      disabled={readOnly || props.disabled}
      title={readOnly ? READ_ONLY_MESSAGE : props.title}
    />
  );
}

/** Desativa também campos e envio por Enter se a conta for suspensa com o formulário aberto. */
export function BusinessForm({
  children,
  onSubmit,
  ...props
}: FormHTMLAttributes<HTMLFormElement>) {
  const readOnly = useReadOnlyAccount();
  return (
    <form
      {...props}
      onSubmit={(event) => {
        if (readOnly) event.preventDefault();
        else onSubmit?.(event);
      }}
    >
      <fieldset disabled={readOnly} className="business-fields">
        {children}
      </fieldset>
    </form>
  );
}
