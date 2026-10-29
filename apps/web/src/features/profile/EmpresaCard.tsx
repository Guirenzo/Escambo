import type { CompanyProfile } from '@escambo/types';
import { Building2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { BusinessForm } from '../../components/BusinessActions';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { Button, Field, Input } from '../../components/ui';
import { formatCnpj, isValidCnpj } from '../../lib/documents';
import { errorMessage } from '../../lib/errors';
import { usePutCompanyProfile } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { CNPJ_HINT, CNPJ_INVALID } from '../auth/LoginForm';

/** Limite da descrição curta, o mesmo da API. */
export const COMPANY_BIO_MAX = 280;

/**
 * Dados da empresa (RF-018), no lugar dos dados de cliente na conta de empresa: razão social, nome
 * fantasia (o nome que os freelancers veem) e CNPJ, que vieram do cadastro, e o logo (pelo mesmo
 * envio com recorte da foto de perfil), o site, a descrição curta e a cidade. O CNPJ é dado público
 * e aparece com máscara; trocá-lo fica na auditoria. O caminho para a página pública fica no topo
 * do Perfil.
 */
export function EmpresaCard({ company }: { company: CompanyProfile | null }) {
  const put = usePutCompanyProfile();
  const toast = useToast();
  const [legalName, setLegalName] = useState(company?.legalName ?? '');
  const [tradeName, setTradeName] = useState(company?.tradeName ?? '');
  const [cnpj, setCnpj] = useState(company?.cnpj ? formatCnpj(company.cnpj) : '');
  const [logoUrl, setLogoUrl] = useState(company?.logoUrl ?? '');
  const [website, setWebsite] = useState(company?.website ?? '');
  const [bio, setBio] = useState(company?.bio ?? '');
  const [city, setCity] = useState(company?.city ?? '');
  const [stateUf, setStateUf] = useState(company?.state ?? '');
  const [cnpjError, setCnpjError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cnpjRef = useRef<HTMLInputElement>(null);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!isValidCnpj(cnpj)) {
      setCnpjError(CNPJ_INVALID);
      cnpjRef.current?.focus();
      return;
    }
    try {
      const saved = await put.mutateAsync({
        legalName: legalName.trim(),
        tradeName: tradeName.trim(),
        cnpj,
        logoUrl: logoUrl.trim() || null,
        website: website.trim() || null,
        bio: bio.trim() || null,
        city: city.trim() || null,
        state: stateUf.trim().toUpperCase() || null,
      });
      setCnpj(formatCnpj(saved.cnpj));
      setWebsite(saved.website ?? '');
      toast.success('Dados da empresa salvos!');
    } catch (er) {
      setError(errorMessage(er, 'Não foi possível salvar os dados da empresa.'));
    }
  }

  return (
    <BusinessForm
      className="card"
      id="dados-empresa"
      onSubmit={(e) => void save(e)}
      aria-labelledby="dados-empresa-title"
      data-testid="empresa-card"
    >
      <div className="card-head">
        <h3 id="dados-empresa-title">
          <Building2 size={16} /> Empresa
        </h3>
      </div>
      <Field label="Razão social">
        <Input
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          required
          minLength={2}
          maxLength={150}
          autoComplete="organization"
        />
      </Field>
      <Field label="Nome fantasia (o nome que os freelancers veem)">
        <Input
          value={tradeName}
          onChange={(e) => setTradeName(e.target.value)}
          required
          minLength={2}
          maxLength={150}
        />
      </Field>
      <Field label="CNPJ">
        <input
          ref={cnpjRef}
          value={cnpj}
          onChange={(e) => {
            setCnpj(e.target.value);
            setCnpjError(null);
          }}
          required
          maxLength={18}
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={cnpjError !== null}
          aria-describedby={cnpjError ? 'empresa-cnpj-erro empresa-cnpj-dica' : 'empresa-cnpj-dica'}
        />
      </Field>
      <p className="muted tiny" id="empresa-cnpj-dica">
        {CNPJ_HINT} O CNPJ é público: aparece na página da empresa.
      </p>
      {cnpjError && (
        <p className="error" id="empresa-cnpj-erro" role="alert">
          {cnpjError}
        </p>
      )}
      <Field label="Logo (URL da imagem)">
        <div className="loc-row">
          <Avatar url={logoUrl.trim() || null} name={tradeName || '?'} size="sm" />
          <Input
            type="text"
            inputMode="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png ou envie do aparelho"
            maxLength={512}
          />
          <ImageUploadButton
            purpose="avatar"
            label="Enviar logo"
            testId="logo-upload"
            onUploaded={(url) => {
              setLogoUrl(url);
              toast.success('Logo enviado. Salve os dados da empresa para aplicar.');
            }}
          />
        </div>
      </Field>
      <Field label="Site">
        <Input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://suaempresa.com.br"
          maxLength={255}
          autoComplete="url"
        />
      </Field>
      <Field label={`Descrição curta (até ${COMPANY_BIO_MAX} caracteres)`}>
        <textarea
          className="textarea"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={COMPANY_BIO_MAX}
          rows={3}
        />
      </Field>
      <Field label="Cidade">
        <Input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          autoComplete="address-level2"
          maxLength={100}
        />
      </Field>
      <Field label="Estado (UF)">
        <Input
          value={stateUf}
          onChange={(e) => setStateUf(e.target.value)}
          autoComplete="address-level1"
          minLength={2}
          maxLength={2}
          placeholder="SC"
        />
      </Field>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={put.isPending}>
        {put.isPending ? 'Salvando…' : 'Salvar empresa'}
      </Button>
    </BusinessForm>
  );
}
