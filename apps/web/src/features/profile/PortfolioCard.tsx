import { Images, Link2, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, QueryState } from '../../components/ui';
import { usePortfolio, usePortfolioMutation } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { IMAGE_MAX_SIDE } from '../../lib/image';

const MAX_ITEMS = 12;

/** Portfólio do freelancer: trabalhos com imagem e/ou link, que aparecem no perfil público. */
export function PortfolioCard() {
  const toast = useToast();
  const portfolio = usePortfolio();
  const { add, remove } = usePortfolioMutation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const count = portfolio.data?.length ?? 0;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!imageUrl.trim() && !externalUrl.trim()) {
      toast.error('Informe a imagem ou o link do trabalho');
      return;
    }
    try {
      await add.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        imageUrl: imageUrl.trim() || null,
        externalUrl: externalUrl.trim() || null,
      });
      toast.success('Trabalho adicionado ao portfólio.');
      setTitle('');
      setDescription('');
      setImageUrl('');
      setExternalUrl('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível adicionar');
    }
  }

  async function removeItem(id: number): Promise<void> {
    try {
      await remove.mutateAsync(id);
      toast.success('Trabalho removido.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível remover');
    }
  }

  return (
    <section className="card wide" aria-labelledby="portfolio-title" data-testid="portfolio-card">
      <div className="card-head">
        <h3 id="portfolio-title">
          <Images size={16} /> Portfólio
        </h3>
        <span className="muted tiny">
          {count} de {MAX_ITEMS} · aparece no seu perfil público
        </span>
      </div>

      <QueryState
        isLoading={portfolio.isLoading}
        error={portfolio.error}
        data={portfolio.data}
        onRetry={() => void portfolio.refetch()}
      >
        {(items) =>
          items.length === 0 ? (
            <p className="muted tiny">
              Mostre o que você já fez: uma imagem ou um link por trabalho. Clientes olham isso
              antes de contratar.
            </p>
          ) : (
            <ul className="portfolio-list" data-testid="portfolio-list">
              {items.map((i) => (
                <li key={i.id}>
                  {i.imageUrl ? (
                    <img src={i.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="portfolio-thumb">
                      <Link2 size={16} />
                    </span>
                  )}
                  <div className="portfolio-text">
                    <strong>{i.title}</strong>
                    {i.description && <span className="muted tiny">{i.description}</span>}
                    {i.externalUrl && (
                      <a
                        href={i.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tiny"
                      >
                        {i.externalUrl}
                      </a>
                    )}
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remover ${i.title}`}
                    disabled={remove.isPending}
                    onClick={() => void removeItem(i.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>

      {count < MAX_ITEMS && (
        <form className="stack" onSubmit={submit} style={{ marginTop: 12 }}>
          <Field label="Título do trabalho">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
              maxLength={150}
              placeholder="Ex.: Site da padaria do bairro"
            />
          </Field>
          <Field label="Descrição (opcional)">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder="O que foi feito, em uma linha"
            />
          </Field>
          <Field label="Imagem (URL)">
            <div className="loc-row">
              <Input
                type="text"
                inputMode="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                maxLength={512}
                placeholder="https://…/foto-do-trabalho.jpg ou envie do aparelho"
              />
              <ImageUploadButton
                maxSide={IMAGE_MAX_SIDE.portfolio}
                label="Enviar imagem"
                testId="portfolio-upload"
                onUploaded={(url) => {
                  setImageUrl(url);
                  toast.success('Imagem enviada.');
                }}
              />
              {imageUrl.trim() && (
                <img className="upload-preview" src={imageUrl.trim()} alt="" loading="lazy" />
              )}
            </div>
          </Field>
          <Field label="Link do trabalho (URL)">
            <Input
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              maxLength={512}
              placeholder="https://…"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={add.isPending}>
            <Plus size={14} /> {add.isPending ? 'Adicionando…' : 'Adicionar ao portfólio'}
          </Button>
        </form>
      )}
    </section>
  );
}
