#!/usr/bin/env node
/**
 * Gate de dependências do CI (ADR 74): reprova vulnerabilidade alta ou crítica do `npm audit`,
 * menos as listadas em scripts/audit-excecoes.json, cada uma com o motivo e uma data-limite.
 *
 *   npm run audit:deps
 *
 * Roda pelo npm (`npm run`), que informa onde está o próprio CLI (`npm_execpath`): o script chama
 * esse arquivo com o mesmo Node, por caminho absoluto, sem procurar `npm` no PATH nem abrir shell.
 *
 * Uma exceção só vale para alerta que não aparece nas dependências de produção (`--omit=dev`): o
 * que vai para o servidor nunca passa com vulnerabilidade alta. Exceção vencida reprova (é hora de
 * rever se já saiu a correção), e a que não casa com mais nenhum alerta é avisada para sair da lista.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOQUEIA = new Set(['high', 'critical']);

const npmCli = process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli)) {
  console.error('Rode pelo npm: npm run audit:deps');
  process.exit(2);
}

function audit(extra) {
  const r = spawnSync(process.execPath, [npmCli, 'audit', '--json', ...extra], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let json;
  try {
    // trim() também tira um BOM no começo, se algum shell puser.
    json = JSON.parse(r.stdout.trim());
  } catch {
    console.error('O npm audit não devolveu JSON:', (r.stderr || r.stdout || '').slice(0, 500));
    process.exit(2);
  }
  if (json.error) {
    console.error('O npm audit falhou:', json.error.summary ?? JSON.stringify(json.error));
    process.exit(2);
  }
  return json;
}

/** Os alertas de severidade alta ou crítica, pelo id (GHSA), com o pacote em que aparecem. */
function alertas(json) {
  const porId = new Map();
  for (const v of Object.values(json.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via === 'string' || !BLOQUEIA.has(via.severity)) continue;
      const id =
        String(via.url ?? '')
          .split('/')
          .pop() || String(via.source);
      if (!porId.has(id)) {
        porId.set(id, {
          id,
          titulo: via.title,
          severidade: via.severity,
          pacote: via.name,
          url: via.url,
        });
      }
    }
  }
  return porId;
}

const excecoes = JSON.parse(readFileSync(join(root, 'scripts', 'audit-excecoes.json'), 'utf8'));
const hoje = new Date().toISOString().slice(0, 10);
const todos = alertas(audit([]));
const producao = alertas(audit(['--omit=dev']));
const problemas = [];

for (const a of todos.values()) {
  const ex = excecoes.find((e) => e.id === a.id);
  if (!ex) {
    problemas.push(`${a.id} (${a.severidade}) em ${a.pacote}: ${a.titulo} ${a.url}`);
  } else if (producao.has(a.id)) {
    problemas.push(
      `${a.id} em ${a.pacote} chegou às dependências de produção: a exceção não vale para elas.`,
    );
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ex.ate)) || ex.ate < hoje) {
    problemas.push(
      `${a.id} em ${a.pacote}: a exceção venceu (${ex.ate}). Veja se já há correção; renove ou tire.`,
    );
  } else {
    console.log(
      `Exceção até ${ex.ate}: ${a.id} (${a.severidade}) em ${a.pacote}, só em desenvolvimento. ${ex.motivo}`,
    );
  }
}
for (const e of excecoes) {
  if (!todos.has(e.id)) {
    console.log(
      `A exceção ${e.id} (${e.pacote}) não casa com mais nenhum alerta: pode sair de scripts/audit-excecoes.json.`,
    );
  }
}

if (problemas.length > 0) {
  console.error(`Dependências com vulnerabilidade alta ou crítica (${problemas.length}):`);
  for (const p of problemas) console.error(`- ${p}`);
  console.error(
    'Atualize a dependência (npm audit fix) ou, sem correção publicada e só em desenvolvimento, registre a exceção com motivo e data.',
  );
  process.exit(1);
}
console.log('Nenhuma vulnerabilidade alta ou crítica fora das exceções registradas.');
