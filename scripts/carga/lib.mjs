/**
 * Utilitários do teste de carga (RNF-001, RNF-002, RNF-005, RNF-023).
 *
 * Só módulos do Node 22: cliente HTTP com keep-alive (node:http), estatística de latência,
 * estado compartilhado entre as etapas e formatação das tabelas. Ponto de entrada: rodar-tudo.mjs.
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as esperar } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

export { esperar };

/** Pasta de trabalho fora do repositório: estado com tokens, logs da API, DATA_DIR. */
export const PASTA_TRABALHO = process.env.CARGA_TMP ?? join(os.tmpdir(), 'escambo-carga');

/** O estado guarda tokens de contas de teste: fica no temporário, nunca no git. */
export const CAMINHO_ESTADO = join(PASTA_TRABALHO, 'estado.json');

export function lerEstado(caminho = CAMINHO_ESTADO) {
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

export function gravarEstado(estado, caminho = CAMINHO_ESTADO) {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, JSON.stringify(estado));
}

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

/**
 * Cliente HTTP mínimo sobre node:http com keep-alive. Mede do envio ao último byte da resposta
 * (performance.now, monotônico). Erro de rede vira status 0, sem lançar.
 */
export function criarCliente(baseUrl, { maxSockets = 256, timeoutMs = 30_000 } = {}) {
  const base = new URL(baseUrl.replace(/\/$/, '') + '/');
  // timeout do agente vale para a conexão ociosa: fecha antes dos 5 s de keep-alive do servidor
  // Node, senão a próxima requisição pode sair num socket que o servidor acabou de fechar.
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets,
    maxFreeSockets: maxSockets,
    timeout: 4000,
  });

  function req(method, caminho, { token, body, json = false } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Como o navegador: aceita gzip (a API comprime respostas acima de 1 KB).
    const headers = { accept: 'application/json', 'accept-encoding': 'gzip' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(caminho.replace(/^\//, ''), base);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const r = http.request(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const ms = performance.now() - t0;
          let data;
          if (json || res.statusCode >= 400) {
            try {
              let corpo = Buffer.concat(partes);
              if (res.headers['content-encoding'] === 'gzip') corpo = gunzipSync(corpo);
              data = JSON.parse(corpo.toString('utf8'));
            } catch {
              data = undefined;
            }
          }
          resolve({ status: res.statusCode ?? 0, ms, t0, data });
        });
        res.on('error', (err) =>
          resolve({ status: 0, ms: performance.now() - t0, t0, erro: err.message }),
        );
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', (err) =>
        resolve({ status: 0, ms: performance.now() - t0, t0, erro: err.message }),
      );
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  }

  return { req, fechar: () => agent.destroy() };
}

/** Chamada de preparação: lança se a resposta não for a esperada (o seed não segue com erro). */
export async function exigir(promessa, esperado = [200, 201]) {
  const r = await promessa;
  if (!esperado.includes(r.status)) {
    throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data ?? r.erro ?? null)}`);
  }
  return r.data;
}

/** Executa `fn` sobre `itens` com no máximo `n` em paralelo, na ordem de chegada. */
export async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
  return saida;
}

// ---------------------------------------------------------------------------
// Estatística
// ---------------------------------------------------------------------------

/** Percentil por posição (nearest-rank) num vetor já ordenado. */
export function percentil(ordenado, q) {
  if (ordenado.length === 0) return null;
  const i = Math.min(ordenado.length - 1, Math.max(0, Math.ceil(q * ordenado.length) - 1));
  return ordenado[i];
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Resumo de latências em ms: n, p50, p95, p99, máximo e média (1 casa decimal). */
export function resumir(amostras) {
  const o = Float64Array.from(amostras).sort();
  const soma = o.reduce((a, b) => a + b, 0);
  return {
    n: o.length,
    p50: r1(percentil(o, 0.5)),
    p95: r1(percentil(o, 0.95)),
    p99: r1(percentil(o, 0.99)),
    max: r1(o.length ? o[o.length - 1] : null),
    media: r1(o.length ? soma / o.length : null),
  };
}

/**
 * Coletor por rota: só entra a requisição que começou e terminou dentro da janela de medição
 * (o aquecimento e as que ficam no meio do corte são descartados). Latência só das respostas
 * 2xx; as demais contam como erro, por código.
 */
export class Coletor {
  constructor() {
    this.inicio = Infinity;
    this.fim = Infinity;
    this.rotas = new Map();
  }

  abrirJanela(inicio, fim) {
    this.inicio = inicio;
    this.fim = fim;
  }

  registrar(rota, r) {
    const fimReq = r.t0 + r.ms;
    if (r.t0 < this.inicio || fimReq > this.fim) return;
    let s = this.rotas.get(rota);
    if (!s) {
      s = { lat: [], erros: 0, codigos: {} };
      this.rotas.set(rota, s);
    }
    if (r.status >= 200 && r.status < 300) {
      s.lat.push(r.ms);
    } else {
      s.erros++;
      const chave = r.status === 0 ? `rede:${r.erro ?? '?'}` : String(r.status);
      s.codigos[chave] = (s.codigos[chave] ?? 0) + 1;
    }
  }

  resultado() {
    const segundos = (this.fim - this.inicio) / 1000;
    const rotas = {};
    let total = 0;
    let erros = 0;
    for (const [rota, s] of [...this.rotas.entries()].sort()) {
      const n = s.lat.length + s.erros;
      total += n;
      erros += s.erros;
      rotas[rota] = {
        ...resumir(s.lat),
        requisicoes: n,
        erros: s.erros,
        codigosErro: s.codigos,
        vazao: Math.round((n / segundos) * 10) / 10,
      };
    }
    return {
      segundos,
      requisicoes: total,
      erros,
      vazao: Math.round((total / segundos) * 10) / 10,
      rotas,
    };
  }
}

// ---------------------------------------------------------------------------
// Aleatoriedade reprodutível (mesma semente = mesmos dados de seed)
// ---------------------------------------------------------------------------

export function geradorAleatorio(semente = 42) {
  let s = semente >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    rnd,
    int: (min, max) => min + Math.floor(rnd() * (max - min + 1)),
    pick: (lista) => lista[Math.floor(rnd() * lista.length)],
  };
}

/** Sorteio ponderado: [{peso, ...}] → item. */
export function sortearPonderado(itens, rnd = Math.random) {
  const total = itens.reduce((a, i) => a + i.peso, 0);
  let x = rnd() * total;
  for (const item of itens) {
    x -= item.peso;
    if (x < 0) return item;
  }
  return itens[itens.length - 1];
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

/** Tabela markdown simples a partir de linhas (arrays) e cabeçalho. */
export function tabelaMarkdown(cabecalho, linhas) {
  const sep = cabecalho.map(() => '---');
  return [cabecalho, sep, ...linhas].map((l) => `| ${l.join(' | ')} |`).join('\n');
}

export const fmt = (x) => (x == null ? '—' : String(x).replace('.', ','));

export function log(...partes) {
  const hora = new Date().toISOString().slice(11, 19);
  console.log(`[${hora}]`, ...partes);
}
