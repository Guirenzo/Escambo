/**
 * Dispara o download de um blob com o nome dado (âncora temporária). A URL do blob vive 10 s:
 * tempo de sobra para o navegador começar a gravar, e o Safari não aceita revogar na hora.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
