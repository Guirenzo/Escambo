/**
 * Carga HTTP, em dois modelos:
 * - laço fechado (--modo vus): N usuários virtuais, cada um manda a próxima requisição assim que a
 *   anterior responde (sem tempo de pensar);
 * - taxa fixa (--modo taxa): N requisições por segundo, sem esperar as anteriores.
 * Por nível: aquecimento descartado + janela fixa de medição; p50/p95/p99, erros e vazão por rota.
 *
 *   node scripts/carga/carga-http.mjs --cenario leitura --niveis 10,50,100 --duracao 30 --aquecimento 10
 *   node scripts/carga/carga-http.mjs --cenario escrita --modo taxa --niveis 25,50,100
 *
 * Precisa da API no ar e do estado do seed (rodar-tudo.mjs faz as duas coisas).
 * Com --fundo (e --vus ou --taxa), roda até o processo pai mandar parar (fundo do teste de WS).
 */

import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { amostraMysql, amostraProcesso, deltaDigests, usoCpu } from './ambiente.mjs';
import { CIDADES } from './semear.mjs';
import {
  Coletor,
  criarCliente,
  esperar,
  geradorAleatorio,
  gravarEstado,
  lerEstado,
  log,
  sortearPonderado,
} from './lib.mjs';

const TERMOS = [
  'react',
  'logo',
  'tradução',
  'violão',
  'fotografia',
  'planilha',
  'marketing',
  'reparos',
  'personal',
  'termo-que-nao-existe',
];

/** Rotas de leitura (RNF-001) e o peso de cada uma na mistura. */
const LEITURA = [
  {
    rota: 'GET /services (busca sem texto)',
    peso: 15,
    exec: (c) => c.api.req('GET', `/services?page=${c.g.int(1, 5)}`),
  },
  {
    rota: 'GET /services?q= (busca com texto)',
    peso: 15,
    exec: (c) => c.api.req('GET', `/services?q=${encodeURIComponent(c.g.pick(TERMOS))}`),
  },
  {
    rota: 'GET /services (categoria + preço + ordem)',
    peso: 10,
    exec: (c) =>
      c.api.req(
        'GET',
        `/services?categoryId=${c.g.pick(c.estado.categorias)}&maxPrice=${c.g.pick([200, 500, 1000, 3000])}&sort=price_asc`,
      ),
  },
  {
    rota: 'GET /services (proximidade lat/lng)',
    peso: 5,
    exec: (c) => {
      const cidade = c.g.pick(CIDADES);
      return c.api.req('GET', `/services?lat=${cidade.lat}&lng=${cidade.lng}&radiusKm=50`);
    },
  },
  {
    rota: 'GET /services/:id (detalhe)',
    peso: 15,
    exec: (c) => c.api.req('GET', `/services/${c.g.pick(c.estado.servicos).id}`),
  },
  {
    rota: 'GET /categories',
    peso: 5,
    exec: (c) => c.api.req('GET', '/categories'),
  },
  {
    rota: 'GET /profiles/freelancer/:ulid (perfil público)',
    peso: 10,
    exec: (c) => c.api.req('GET', `/profiles/freelancer/${c.g.pick(c.estado.freelancers).ulid}`),
  },
  {
    rota: 'GET /gamification/leaderboard (ranking)',
    peso: 5,
    exec: (c) =>
      c.api.req('GET', '/gamification/leaderboard', { token: c.g.pick(c.estado.clientes).token }),
  },
  {
    rota: 'GET /wallet (carteira)',
    peso: 10,
    exec: (c) => c.api.req('GET', '/wallet', { token: c.g.pick(c.estado.clientes).token }),
  },
  {
    rota: 'GET /wallet/transactions (extrato)',
    peso: 10,
    exec: (c) =>
      c.api.req('GET', '/wallet/transactions', { token: c.g.pick(c.estado.clientes).token }),
  },
];

/** Rotas de escrita/pagamento (RNF-002). Cada operação pode gravar mais de uma rota. */
const ESCRITA = [
  {
    rota: 'POST /contracts (proposta/contratação)',
    peso: 40,
    exec: async (c) => {
      const par = c.pares.proximo();
      if (!par) return { status: 0, ms: 0, t0: performance.now(), erro: 'pares_esgotados' };
      const cliente = c.estado.clientes[par.ci];
      const freelancer = c.estado.freelancers[par.fi];
      return c.api.req('POST', '/contracts', {
        token: cliente.token,
        body: {
          freelancerId: freelancer.uid,
          serviceId: c.g.pick(c.servicosPorDono.get(freelancer.uid)),
          title: 'Proposta do teste de carga',
          description: 'Proposta criada pelo teste de carga para medir a escrita.',
          price: c.g.int(10, 60),
          paymentMode: 'cash',
        },
      });
    },
  },
  {
    rota: 'POST /wallet/deposits (cobrança PIX)',
    peso: 30,
    exec: async (c) => {
      const cliente = c.g.pick(c.estado.clientes);
      const r = await c.api.req('POST', '/wallet/deposits', {
        token: cliente.token,
        body: { amount: c.g.int(10, 500) },
        json: true,
      });
      // Metade das cobranças é "paga" no gateway simulado (ADR 15): crédito na carteira.
      if (r.status === 201 && c.g.rnd() < 0.5) {
        c.coletor.registrar('POST /wallet/deposits (cobrança PIX)', r);
        return {
          rota: 'POST /wallet/deposits/:id/simulate (pagamento simulado)',
          r: await c.api.req('POST', `/wallet/deposits/${r.data.id}/simulate`, {
            token: cliente.token,
          }),
        };
      }
      return r;
    },
  },
  {
    rota: 'POST /withdrawals (pedido de saque)',
    peso: 30,
    exec: (c) => {
      const cliente = c.g.pick(c.estado.clientes);
      return c.api.req('POST', '/withdrawals', {
        token: cliente.token,
        body: { amount: c.g.int(20, 40), method: 'pix', pixKey: `chave-${cliente.uid}@carga.test` },
      });
    },
  },
];

/**
 * Teto de referência: a rota de liveness não consulta o banco, mas passa pelos mesmos middlewares
 * (helmet, compression, log por requisição, métricas, rate limit). Mostra quanto do custo por
 * requisição é do caminho comum do Express e não das consultas.
 */
const TETO = [
  {
    rota: 'GET /health/live (sem banco)',
    peso: 1,
    exec: (c) => c.api.req('GET', '/health/live'),
  },
];

export const CENARIOS = { leitura: LEITURA, escrita: ESCRITA, teto: TETO };

/**
 * Pares cliente→freelancer ainda sem proposta aberta (RN-020). O índice k percorre todos os
 * pares sem repetir: cliente = k mod C, freelancer = (k div C + cliente) mod F.
 */
export function criarPares(estado) {
  const C = estado.clientes.length;
  const F = estado.freelancers.length;
  const reservados = new Set(estado.paresWs.map((p) => `${p.cliente}:${p.freelancer}`));
  let k = estado.cursorPares ?? 0;
  return {
    proximo() {
      while (k < C * F) {
        const ci = k % C;
        const fi = (Math.floor(k / C) + ci) % F;
        k++;
        if (!reservados.has(`${ci}:${fi}`)) return { ci, fi };
      }
      return null;
    },
    get cursor() {
      return k;
    },
  };
}

function servicosPorDono(estado) {
  const mapa = new Map();
  for (const s of estado.servicos) {
    if (!mapa.has(s.donoUid)) mapa.set(s.donoUid, []);
    mapa.get(s.donoUid).push(s.id);
  }
  return mapa;
}

function registrar(coletor, rotaPadrao, out) {
  if (out && out.rota) coletor.registrar(out.rota, out.r);
  else coletor.registrar(rotaPadrao, out);
}

function contexto({ api, estado, coletor, pares, semente }) {
  return {
    api,
    estado,
    coletor,
    pares,
    g: geradorAleatorio(semente),
    servicosPorDono: servicosPorDono(estado),
  };
}

/**
 * Laço fechado: `vus` usuários virtuais, cada um manda a próxima requisição assim que a anterior
 * responde. Devolve a função que os para e espera terminarem.
 */
function iniciarVus({ api, estado, cenario, vus, coletor, pares, semente }) {
  const ops = CENARIOS[cenario];
  let parar = false;
  const execucoes = Array.from({ length: vus }, async (_, i) => {
    const ctx = contexto({ api, estado, coletor, pares, semente: semente + i });
    while (!parar) {
      const op = sortearPonderado(ops, ctx.g.rnd);
      registrar(coletor, op.rota, await op.exec(ctx));
    }
  });
  return async () => {
    parar = true;
    await Promise.all(execucoes);
  };
}

/**
 * Laço aberto: `taxa` operações por segundo em intervalos fixos, sem esperar a resposta da
 * anterior (como usuários independentes chegando). Atraso do servidor não reduz a taxa de chegada,
 * então a latência medida inclui a fila. Teto de 2000 em voo para não estourar o cliente.
 */
function iniciarTaxa({ api, estado, cenario, taxa, coletor, pares, semente }) {
  const ops = CENARIOS[cenario];
  const ctx = contexto({ api, estado, coletor, pares, semente });
  const intervalo = 1000 / taxa;
  const emVoo = new Set();
  let parar = false;
  let descartadas = 0;
  const laco = (async () => {
    let proxima = performance.now();
    while (!parar) {
      const agora = performance.now();
      while (proxima <= agora && !parar) {
        proxima += intervalo;
        if (emVoo.size >= 2000) {
          descartadas++;
          continue;
        }
        const op = sortearPonderado(ops, ctx.g.rnd);
        const p = Promise.resolve(op.exec(ctx)).then((out) => registrar(coletor, op.rota, out));
        emVoo.add(p);
        p.finally(() => emVoo.delete(p));
      }
      await esperar(Math.max(1, Math.min(20, proxima - performance.now())));
    }
  })();
  return async () => {
    parar = true;
    await laco;
    await Promise.all([...emVoo]);
    return { descartadas };
  };
}

/**
 * Um nível: `vus` (laço fechado) ou `taxa` (laço aberto, req/s). Aquecimento descartado + janela de
 * medição; amostra CPU/RAM da API, CPU do MySQL, consultas mais caras e interferência externa.
 */
export async function executarNivel({
  apiUrl,
  estado,
  cenario,
  vus,
  taxa,
  aquecimentoS,
  duracaoS,
  pidApi,
  pares,
  monitor,
}) {
  const api = criarCliente(apiUrl, { maxSockets: taxa ? 1024 : vus + 16 });
  const coletor = new Coletor();
  const inicio = performance.now();
  const iniMed = inicio + aquecimentoS * 1000;
  const fimMed = iniMed + duracaoS * 1000;
  coletor.abrirJanela(iniMed, fimMed);
  const semente = (vus ?? taxa) * 1000 + (taxa ? 7 : 0);
  const parar = taxa
    ? iniciarTaxa({ api, estado, cenario, taxa, coletor, pares, semente })
    : iniciarVus({ api, estado, cenario, vus, coletor, pares, semente });

  await esperar(Math.max(0, iniMed - performance.now()));
  const [cpuIni, digIni] = await Promise.all([
    pidApi ? amostraProcesso(pidApi) : null,
    monitor ? monitor.digests() : null,
  ]);
  // Durante a janela: quem mais usa o mesmo MySQL (a cada 2 s) e um retrato do container.
  const outros = new Map();
  let amostrasOutros = 0;
  let comOutros = 0;
  let mysqlMeio = null;
  while (performance.now() < fimMed - 2500) {
    if (monitor) {
      const ativos = await monitor.outrosBancosAtivos();
      amostrasOutros++;
      if (ativos.length) comOutros++;
      for (const db of ativos) outros.set(db, (outros.get(db) ?? 0) + 1);
    }
    if (!mysqlMeio && performance.now() > iniMed + (duracaoS * 1000) / 2) {
      mysqlMeio = await amostraMysql();
    }
    await esperar(2000);
  }
  await esperar(Math.max(0, fimMed - performance.now()));
  const [cpuFim, digFim] = await Promise.all([
    pidApi ? amostraProcesso(pidApi) : null,
    monitor ? monitor.digests() : null,
  ]);
  const extra = await parar();
  api.fechar();
  const resultado = coletor.resultado();

  return {
    cenario,
    modo: taxa ? 'taxa' : 'vus',
    vus: vus ?? null,
    taxaAlvo: taxa ?? null,
    aquecimentoS,
    duracaoS,
    ...resultado,
    descartadasPeloCliente: extra?.descartadas ?? 0,
    api: { cpuNucleos: usoCpu(cpuIni, cpuFim), memoriaMB: cpuFim?.memMB ?? null },
    mysql: mysqlMeio,
    banco: digIni && digFim ? deltaDigests(digIni, digFim, resultado.requisicoes) : null,
    interferencia: monitor
      ? {
          amostras: amostrasOutros,
          amostrasComOutrosBancos: comOutros,
          bancos: Object.fromEntries(outros),
        }
      : null,
  };
}

/**
 * Todos os níveis de um cenário, em sequência, com pausa entre eles (os avisos e e-mails
 * assíncronos de um nível terminam antes do próximo). `modo`: 'vus' ou 'taxa'.
 */
export async function executarCenario({
  apiUrl,
  estado,
  cenario,
  niveis,
  modo = 'vus',
  aquecimentoS,
  duracaoS,
  pidApi,
  monitor,
}) {
  const pares = criarPares(estado);
  const resultados = [];
  for (const n of niveis) {
    const rotulo = modo === 'taxa' ? `${n} req/s` : `${n} VUs`;
    log(`${cenario}: ${rotulo} (${aquecimentoS} s de aquecimento + ${duracaoS} s medidos)`);
    const r = await executarNivel({
      apiUrl,
      estado,
      cenario,
      vus: modo === 'taxa' ? undefined : n,
      taxa: modo === 'taxa' ? n : undefined,
      aquecimentoS,
      duracaoS,
      pidApi,
      pares,
      monitor,
    });
    const interf = r.interferencia?.amostrasComOutrosBancos
      ? `; outros bancos ativos em ${r.interferencia.amostrasComOutrosBancos}/${r.interferencia.amostras} amostras`
      : '';
    log(
      `${cenario}: ${rotulo} → ${r.vazao} req/s, ${r.erros} erros, CPU da API ${r.api.cpuNucleos ?? '?'} núcleo(s)${interf}`,
    );
    resultados.push(r);
    await esperar(5000);
  }
  if (cenario === 'escrita') {
    estado.cursorPares = pares.cursor;
    gravarEstado(estado);
  }
  return resultados;
}

/** Modo --fundo: carga contínua até o pai pedir para parar (IPC); responde com o resumo. */
async function modoFundo({ apiUrl, estado, cenario, vus, taxa, aquecimentoS }) {
  const api = criarCliente(apiUrl, { maxSockets: taxa ? 1024 : vus + 16 });
  const coletor = new Coletor();
  const iniMed = performance.now() + aquecimentoS * 1000;
  coletor.abrirJanela(iniMed, Infinity);
  const args = { api, estado, cenario, coletor, pares: criarPares(estado), semente: 777 };
  const parar = taxa ? iniciarTaxa({ ...args, taxa }) : iniciarVus({ ...args, vus });
  process.send?.({ tipo: 'pronto' });
  process.on('message', async (msg) => {
    if (msg?.tipo !== 'parar') return;
    coletor.fim = performance.now();
    await parar();
    api.fechar();
    process.send?.({
      tipo: 'resultado',
      resultado: { cenario, vus: vus ?? null, taxaAlvo: taxa ?? null, ...coletor.resultado() },
    });
    process.exit(0);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      cenario: { type: 'string', default: 'leitura' },
      niveis: { type: 'string', default: '10,50,100' },
      modo: { type: 'string', default: 'vus' },
      vus: { type: 'string' },
      taxa: { type: 'string' },
      duracao: { type: 'string', default: '30' },
      aquecimento: { type: 'string', default: '10' },
      fundo: { type: 'boolean', default: false },
    },
  });
  const estado = lerEstado();
  const apiUrl = process.env.CARGA_API_URL ?? estado.apiUrl;
  if (values.fundo) {
    await modoFundo({
      apiUrl,
      estado,
      cenario: values.cenario,
      vus: values.vus ? Number(values.vus) : undefined,
      taxa: values.taxa ? Number(values.taxa) : undefined,
      aquecimentoS: Number(values.aquecimento),
    });
    return;
  }
  const r = await executarCenario({
    apiUrl,
    estado,
    cenario: values.cenario,
    niveis: values.niveis.split(',').map(Number),
    modo: values.modo,
    aquecimentoS: Number(values.aquecimento),
    duracaoS: Number(values.duracao),
  });
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
