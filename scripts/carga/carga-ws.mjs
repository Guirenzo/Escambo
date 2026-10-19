/**
 * WebSocket (Socket.IO): conexões autenticadas simultâneas (RNF-023) e latência de entrega das
 * mensagens da Sala e do aviso em tempo real (RNF-005), com carga HTTP de fundo ligada.
 *
 *   node scripts/carga/carga-ws.mjs --conexoes 500,1000 --latencia 30 --fundos 100/s,50vu
 *
 * Para cada total de conexões: abre todas (em lotes), confere que conectaram, entra nas Salas,
 * mede a latência sem carga e com cada carga de fundo (envio pelo REST, como o web faz, e pelo
 * próprio socket), e no fim confere quantas continuam de pé e receberam o ping do servidor.
 */

import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';
import { amostraProcesso, usoCpu } from './ambiente.mjs';
import { criarCliente, esperar, lerEstado, log, resumir } from './lib.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOTE = 50;
const MARCA = /Teste de carga (\d+) na Sala/;

function conectar(origem, token) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = io(origem, {
      path: '/socket.io',
      // Só WebSocket: é o estado em que a conexão do navegador fica depois do upgrade.
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
      timeout: 30_000,
    });
    s.once('connect', () => resolve({ s, ms: performance.now() - t0 }));
    s.once('connect_error', (err) => {
      s.close();
      resolve({ s: null, ms: performance.now() - t0, erro: err.message });
    });
  });
}

function entrarNaSala(s, contratoId) {
  return new Promise((resolve) => {
    s.timeout(10_000).emit('contract:join', contratoId, (err, resp) => resolve(!err && resp?.ok));
  });
}

/** Sobe a carga HTTP de fundo num processo separado (não disputa o laço de eventos da medição). */
async function iniciarFundo({ cenario, vus, taxa }) {
  const intensidade = taxa ? ['--taxa', String(taxa)] : ['--vus', String(vus)];
  const filho = fork(
    join(AQUI, 'carga-http.mjs'),
    ['--fundo', '--cenario', cenario, ...intensidade, '--aquecimento', '5'],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
  );
  await new Promise((ok, falha) => {
    filho.once('message', (m) => (m?.tipo === 'pronto' ? ok() : falha(new Error('fundo'))));
    filho.once('exit', (c) => falha(new Error(`carga de fundo saiu (${c})`)));
  });
  await esperar(5000); // o aquecimento do fundo
  return {
    parar: () =>
      new Promise((ok) => {
        filho.once('message', (m) => ok(m?.resultado ?? null));
        filho.send({ tipo: 'parar' });
      }),
  };
}

/**
 * Mede a latência de entrega: cada par manda 1 mensagem por segundo (escalonado) durante
 * `segundos`; o relógio vai do envio até o `message:new` chegar ao socket do freelancer na Sala
 * e até o `notification:new` (aviso) chegar à sala pessoal dele. Mesmo processo, mesmo relógio.
 */
async function medirLatencia({ api, pares, segundos, modo, pendentes, seq }) {
  const amostras = { mensagem: [], aviso: [], resposta: [] };
  const enviados = [];
  const falhasEnvio = {};
  const fim = performance.now() + segundos * 1000;
  // Envio recusado ou perdido no caminho de ida não é "não entregue": conta à parte.
  const falhou = (n, motivo) => {
    falhasEnvio[motivo] = (falhasEnvio[motivo] ?? 0) + 1;
    pendentes.delete(n);
    enviados.splice(enviados.indexOf(n), 1);
  };
  await Promise.all(
    pares.map(async (p, i) => {
      await esperar((1000 / pares.length) * i);
      while (performance.now() < fim) {
        const n = seq.proximo++;
        const conteudo = `Teste de carga ${n} na Sala`;
        const t0 = performance.now();
        pendentes.set(n, { t0, amostras, msg: false, aviso: false });
        enviados.push(n);
        if (modo === 'rest') {
          const r = await api.req('POST', `/messaging/contracts/${p.contratoId}`, {
            token: p.tokenCliente,
            body: { content: conteudo },
          });
          if (r.status === 201 || r.status === 200) amostras.resposta.push(r.ms);
          else falhou(n, r.status === 0 ? `rede:${r.erro}` : String(r.status));
        } else {
          const ack = await new Promise((resolve) =>
            p.socketCliente
              .timeout(10_000)
              .emit('message:send', { contractId: p.contratoId, content: conteudo }, (err, a) =>
                resolve(err ? null : a),
              ),
          );
          if (ack?.ok) amostras.resposta.push(performance.now() - t0);
          else falhou(n, ack?.error ?? 'sem_ack');
        }
        await esperar(Math.max(0, t0 + 1000 - performance.now()));
      }
    }),
  );
  await esperar(5000); // o que não chegou em 5 s depois do fim conta como não entregue
  let semMensagem = 0;
  let semAviso = 0;
  for (const n of enviados) {
    const e = pendentes.get(n);
    if (!e?.msg) semMensagem++;
    if (!e?.aviso) semAviso++;
    pendentes.delete(n);
  }
  const ate500 = (v) =>
    v.length ? Math.round((v.filter((x) => x <= 500).length / v.length) * 1000) / 10 : null;
  return {
    modo,
    segundos,
    enviadas: enviados.length,
    falhasEnvio,
    mensagem: {
      ...resumir(amostras.mensagem),
      naoEntregues: semMensagem,
      pctAte500ms: ate500(amostras.mensagem),
    },
    aviso: {
      ...resumir(amostras.aviso),
      naoEntregues: semAviso,
      pctAte500ms: ate500(amostras.aviso),
    },
    respostaEnvio: resumir(amostras.resposta),
  };
}

/** Uma rodada completa com `total` conexões simultâneas. */
async function rodada({ apiUrl, estado, total, latenciaS, baseS, fundos, pidApi, monitor }) {
  const origem = new URL(apiUrl).origin;
  const usuarios = [...estado.clientes, ...estado.freelancers];
  const C = estado.clientes.length;
  const memAntes = pidApi ? await amostraProcesso(pidApi) : null;

  log(`ws: abrindo ${total} conexões em lotes de ${LOTE}`);
  const sockets = new Array(total).fill(null);
  const tempos = [];
  const erros = {};
  const tAbrir = performance.now();
  for (let ini = 0; ini < total; ini += LOTE) {
    const lote = [];
    for (let j = ini; j < Math.min(total, ini + LOTE); j++) {
      lote.push(
        conectar(origem, usuarios[j % usuarios.length].token).then((r) => {
          if (r.s) {
            sockets[j] = r.s;
            tempos.push(r.ms);
          } else {
            erros[r.erro] = (erros[r.erro] ?? 0) + 1;
          }
        }),
      );
    }
    await Promise.all(lote);
  }
  const segundosAbrir = Math.round((performance.now() - tAbrir) / 100) / 10;
  const conectadas = sockets.filter(Boolean).length;
  log(`ws: ${conectadas}/${total} conectadas em ${segundosAbrir} s`);

  // Vigia: quedas não pedidas e pings do servidor (prova de que a conexão segue viva).
  let encerrando = false;
  const quedas = {};
  const pings = new Array(total).fill(0);
  sockets.forEach((s, j) => {
    if (!s) return;
    s.on('disconnect', (motivo) => {
      if (!encerrando) quedas[motivo] = (quedas[motivo] ?? 0) + 1;
    });
    s.io.on('ping', () => pings[j]++);
  });
  await esperar(2000);
  const memDepois = pidApi ? await amostraProcesso(pidApi) : null;

  // Salas: o socket do cliente i manda, o do freelancer i (índice C + i) recebe.
  const pendentes = new Map();
  const pares = [];
  for (const p of estado.paresWs) {
    const jCliente = p.cliente;
    const jFreela = C + p.freelancer;
    if (jFreela >= total || !sockets[jCliente] || !sockets[jFreela]) continue;
    if (!(await entrarNaSala(sockets[jFreela], p.contratoId))) continue;
    sockets[jFreela].on('message:new', (m) => {
      const n = Number(MARCA.exec(m?.content ?? '')?.[1]);
      const e = pendentes.get(n);
      if (e && !e.msg) {
        e.msg = true;
        e.amostras.mensagem.push(performance.now() - e.t0);
      }
    });
    // O aviso vai para todas as conexões do freelancer (sala user:<id>): vale a primeira.
    for (let j = jFreela; j < total; j += usuarios.length) {
      sockets[j]?.on('notification:new', (aviso) => {
        if (aviso?.type !== 'chat_message') return;
        const n = Number(MARCA.exec(aviso.body ?? '')?.[1]);
        const e = pendentes.get(n);
        if (e && !e.aviso) {
          e.aviso = true;
          e.amostras.aviso.push(performance.now() - e.t0);
        }
      });
    }
    pares.push({
      contratoId: p.contratoId,
      tokenCliente: estado.clientes[p.cliente].token,
      socketCliente: sockets[jCliente],
    });
  }
  log(`ws: ${pares.length} Salas com os dois lados conectados`);

  const api = criarCliente(apiUrl, { maxSockets: pares.length + 8 });
  const seq = { proximo: 1 };
  const latencias = [];

  // Aquecimento do caminho (JIT, conexões do pool): 3 s descartados.
  await medirLatencia({ api, pares, segundos: 3, modo: 'rest', pendentes, seq });
  log(`ws: latência sem carga de fundo (${baseS} s, envio pelo REST)`);
  latencias.push({
    fundo: null,
    ...(await medirLatencia({ api, pares, segundos: baseS, modo: 'rest', pendentes, seq })),
  });

  const cargasDeFundo = [];
  for (const fundo of fundos) {
    const rotulo = fundo.taxa
      ? `${fundo.cenario} a ${fundo.taxa} req/s`
      : `${fundo.cenario} com ${fundo.vus} VUs`;
    log(`ws: ligando a carga de fundo (${rotulo})`);
    const bg = await iniciarFundo(fundo);
    const cpuIni = pidApi ? await amostraProcesso(pidApi) : null;
    const outrosBancos = new Set(monitor ? await monitor.outrosBancosAtivos() : []);
    for (const modo of ['rest', 'socket']) {
      log(`ws: latência com carga de fundo (${latenciaS} s, envio pelo ${modo})`);
      latencias.push({
        fundo: rotulo,
        ...(await medirLatencia({ api, pares, segundos: latenciaS, modo, pendentes, seq })),
      });
    }
    for (const db of monitor ? await monitor.outrosBancosAtivos() : []) outrosBancos.add(db);
    const cpuFim = pidApi ? await amostraProcesso(pidApi) : null;
    cargasDeFundo.push({
      rotulo,
      cpuNucleosApi: usoCpu(cpuIni, cpuFim),
      outrosBancosAtivos: [...outrosBancos],
      resultado: await bg.parar(),
    });
  }
  api.fechar();

  const vivas = sockets.filter((s) => s?.connected).length;
  const comPing = pings.filter((n, j) => sockets[j] && n > 0).length;
  const segundosDePe = Math.round((performance.now() - tAbrir) / 1000);
  encerrando = true;
  for (const s of sockets) s?.close();
  await esperar(3000);

  const r = {
    conexoesPedidas: total,
    conectadas,
    falhas: total - conectadas,
    errosConexao: erros,
    segundosParaAbrir: segundosAbrir,
    tempoConexao: resumir(tempos),
    segundosDePe,
    vivasNoFim: vivas,
    comPingDoServidor: comPing,
    quedas,
    api: {
      memoriaAntesMB: memAntes?.memMB ?? null,
      memoriaConectadasMB: memDepois?.memMB ?? null,
      kbPorConexao:
        memAntes && memDepois && conectadas
          ? Math.round(((memDepois.memMB - memAntes.memMB) * 1024) / conectadas)
          : null,
    },
    salas: pares.length,
    latencias,
    cargasDeFundo,
  };
  log(
    `ws: ${total} → ${vivas} vivas após ${segundosDePe} s; msg p95 por fase: ${latencias.map((l) => l.mensagem.p95).join(' / ')} ms`,
  );
  return r;
}

/** "100/s,50vu" → [{ cenario: 'leitura', taxa: 100 }, { cenario: 'leitura', vus: 50 }]. */
export function lerFundos(texto) {
  return texto
    .split(',')
    .filter(Boolean)
    .map((f) =>
      f.endsWith('/s')
        ? { cenario: 'leitura', taxa: Number(f.slice(0, -2)) }
        : { cenario: 'leitura', vus: Number(f.replace(/vu$/, '')) },
    );
}

export async function executarWs({
  apiUrl,
  estado,
  conexoes,
  latenciaS,
  baseS,
  fundos,
  pidApi,
  monitor,
}) {
  const rodadas = [];
  for (const total of conexoes) {
    rodadas.push(
      await rodada({ apiUrl, estado, total, latenciaS, baseS, fundos, pidApi, monitor }),
    );
  }
  return rodadas;
}

async function main() {
  const { values } = parseArgs({
    options: {
      conexoes: { type: 'string', default: '500,1000' },
      latencia: { type: 'string', default: '30' },
      base: { type: 'string', default: '15' },
      // Cargas de fundo, separadas por vírgula: "100/s" (taxa fixa) ou "50vu" (laço fechado).
      fundos: { type: 'string', default: '100/s,50vu' },
    },
  });
  const estado = lerEstado();
  const r = await executarWs({
    apiUrl: process.env.CARGA_API_URL ?? estado.apiUrl,
    estado,
    conexoes: values.conexoes.split(',').map(Number),
    latenciaS: Number(values.latencia),
    baseS: Number(values.base),
    fundos: lerFundos(values.fundos),
  });
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
