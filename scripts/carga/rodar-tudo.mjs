#!/usr/bin/env node
/**
 * Teste de carga do Escambo — um comando para tudo (RNF-001, RNF-002, RNF-005, RNF-023).
 *
 *   node scripts/carga/rodar-tudo.mjs
 *
 * 1. Recria o banco `escambo_carga` (só bancos com "carga" no nome) e aplica schema + migrations.
 * 2. Sobe a API de apps/api numa porta própria (3340), sem watch, jobs desligados.
 * 3. Semeia pela API: 250 freelancers, 250 clientes, 10.000 serviços, carteiras e Salas.
 * 4. Escrita (proposta, depósito PIX, pagamento simulado, saque) e leitura (busca, detalhe,
 *    categorias, perfil, ranking, carteira, extrato), cada uma em dois modelos:
 *    - laço fechado com 10, 50 e 100 usuários virtuais (sem tempo de pensar);
 *    - taxa fixa de chegada (escrita 25/50/100 req/s, leitura 50/100/200 req/s);
 *    10 s de aquecimento descartados + 30 s medidos por nível. Depois, o teto sem banco.
 * 5. WebSocket: 500 e 1000 conexões autenticadas; latência da mensagem da Sala e do aviso sem
 *    carga e com carga de leitura de fundo (100 req/s e 50 VUs).
 * 6. Derruba a API e grava scripts/carga/resultados/carga-<data>.json e .md.
 *
 * Opções: --niveis 10,50,100  --taxas-escrita 25,50,100  --taxas-leitura 50,100,200
 *         --duracao 30  --aquecimento 10  --conexoes 500,1000  --latencia 30  --fundos 100/s,50vu
 *         --pular escrita,escrita-taxa,leitura,leitura-taxa,teto,ws
 *         --reaproveitar (usa o banco e o seed da última execução, sem recriar)
 *         --rapido (fumaça: tudo pequeno, para conferir que funciona)
 * Ambiente: CARGA_API_DIR (padrão: apps/api deste repositório), CARGA_PORTA (3340),
 *           CARGA_DB_HOST/PORT/USER/PASSWORD/NAME (127.0.0.1:3306 root, escambo_carga),
 *           CARGA_DB_POOL (10), CARGA_FREELANCERS, CARGA_CLIENTES, CARGA_SERVICOS, CARGA_PARES_WS.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import {
  abrirMonitorBanco,
  configAmbiente,
  derrubarApi,
  infoMaquina,
  prepararBanco,
  subirApi,
} from './ambiente.mjs';
import { executarCenario } from './carga-http.mjs';
import { executarWs, lerFundos } from './carga-ws.mjs';
import { fmt, lerEstado, log, PASTA_TRABALHO, tabelaMarkdown } from './lib.mjs';
import { semear } from './semear.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const META = { leitura: 300, escrita: 500, ws: 500 };

async function volumeDoBanco(cfg) {
  const c = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
  });
  try {
    const tabelas = [
      'users',
      'services',
      'contracts',
      'payments',
      'withdrawals',
      'wallet_transactions',
      'messages',
      'notifications',
      'email_outbox',
    ];
    const saida = {};
    for (const t of tabelas) {
      const [rows] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      saida[t] = Number(rows[0].n);
    }
    return saida;
  } catch (err) {
    return { erro: err.message };
  } finally {
    await c.end();
  }
}

/** Plano de execução do MySQL para a busca (com e sem texto): mostra se usa índice ou varre. */
async function diagnosticoBusca(cfg) {
  const c = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
  });
  // A mesma forma da consulta de services.repository.ts (list, sem lat/lng), com o destaque
  // (EXISTS em boosts) calculado por linha e usado na ordenação.
  const colunas = `s.*, EXISTS(SELECT 1 FROM boosts bo WHERE bo.service_id = s.id
      AND bo.status = 'active' AND bo.expires_at > NOW()) AS boosted, u.ulid AS owner_ulid,
      pf.full_name AS owner_name, pf.avg_rating AS owner_avg_rating,
      pf.available_days AS owner_available_days`;
  const de = `FROM services s JOIN users u ON u.id = s.user_id
     LEFT JOIN profiles_freelancer pf ON pf.user_id = s.user_id
     WHERE s.deleted_at IS NULL AND s.is_active = 1`;
  const ordem = 'ORDER BY boosted DESC, s.created_at DESC, s.id DESC LIMIT 20';
  const like = (t) => `AND (s.title LIKE '%${t}%' OR s.description LIKE '%${t}%')`;
  const consultas = {
    'busca sem texto (como a API)': `SELECT ${colunas} ${de} ${ordem}`,
    'busca com texto, LIKE (como a API)': `SELECT ${colunas} ${de} ${like('react')} ${ordem}`,
    'termo inexistente, LIKE (como a API)': `SELECT ${colunas} ${de} ${like('termo-que-nao-existe')} ${ordem}`,
    'comparação: texto via FULLTEXT': `SELECT ${colunas} ${de}
      AND MATCH(s.title, s.description) AGAINST ('react' IN NATURAL LANGUAGE MODE) ${ordem}`,
    'comparação: sem texto e sem destaque na ordem': `SELECT ${colunas} ${de}
      ORDER BY s.created_at DESC, s.id DESC LIMIT 20`,
  };
  const saida = {};
  try {
    for (const [nome, sql] of Object.entries(consultas)) {
      const [plano] = await c.query(`EXPLAIN ${sql}`);
      const s = plano.find((p) => p.table === 's') ?? plano[0];
      const tempos = [];
      for (let i = 0; i < 20; i++) {
        const t0 = process.hrtime.bigint();
        await c.query(sql);
        tempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      tempos.sort((a, b) => a - b);
      saida[nome] = {
        tipoAcesso: s.type,
        indice: s.key,
        linhasEstimadas: Number(s.rows),
        extra: s.Extra,
        msMediana: Math.round(tempos[10] * 10) / 10,
      };
    }
  } finally {
    await c.end();
  }
  return saida;
}

const rotuloNivel = (n) => (n.modo === 'taxa' ? `${n.taxaAlvo} req/s` : `${n.vus} VUs`);

function tabelaHttp(resultados, meta) {
  const linhas = [];
  for (const nivel of resultados) {
    for (const [rota, s] of Object.entries(nivel.rotas)) {
      linhas.push([
        rota,
        rotuloNivel(nivel),
        fmt(s.p50),
        fmt(s.p95),
        fmt(s.p99),
        fmt(s.max),
        s.requisicoes,
        s.erros
          ? `${s.erros} (${Object.entries(s.codigosErro)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')})`
          : '0',
        fmt(s.vazao),
        s.p95 == null ? '—' : s.p95 <= meta ? 'sim' : 'não',
      ]);
    }
    const interf = nivel.interferencia?.amostrasComOutrosBancos
      ? `; outros bancos ativos em ${nivel.interferencia.amostrasComOutrosBancos}/${nivel.interferencia.amostras} amostras (${Object.keys(nivel.interferencia.bancos).join(', ')})`
      : '';
    linhas.push([
      '**Total do nível**',
      rotuloNivel(nivel),
      '',
      '',
      '',
      '',
      nivel.requisicoes,
      nivel.erros,
      `**${fmt(nivel.vazao)}**`,
      `CPU API ${fmt(nivel.api.cpuNucleos)} núcleo; MySQL ${nivel.mysql?.cpu ?? '?'}; ` +
        `${fmt(nivel.banco?.comandosPorRequisicao)} comandos SQL/req${interf}`,
    ]);
  }
  return tabelaMarkdown(
    [
      'Rota',
      'Nível',
      'p50 ms',
      'p95 ms',
      'p99 ms',
      'máx ms',
      'req',
      'erros',
      'req/s',
      `p95 ≤ ${meta}`,
    ],
    linhas,
  );
}

function tabelaBanco(titulo, resultados) {
  const linhas = [];
  for (const nivel of resultados) {
    for (const q of nivel.banco?.maisCaras.slice(0, 3) ?? []) {
      linhas.push([
        titulo,
        rotuloNivel(nivel),
        `\`${q.sql.replace(/`/g, '').slice(0, 90).replace(/\|/g, '/')}\``,
        q.execucoes,
        fmt(q.msMedio),
        fmt(q.segundosTotal),
        q.linhasExaminadasPorExec,
      ]);
    }
  }
  return linhas;
}

function tabelasWs(rodadas) {
  const conexoes = tabelaMarkdown(
    [
      'Conexões',
      'Conectadas',
      'Falhas',
      'Abrir todas (s)',
      'Conexão p50/p95 ms',
      'De pé por (s)',
      'Vivas no fim',
      'Com ping do servidor',
      'Quedas',
      'RAM API antes→depois (MB)',
    ],
    rodadas.map((r) => [
      r.conexoesPedidas,
      r.conectadas,
      r.falhas,
      fmt(r.segundosParaAbrir),
      `${fmt(r.tempoConexao.p50)} / ${fmt(r.tempoConexao.p95)}`,
      r.segundosDePe,
      r.vivasNoFim,
      r.comPingDoServidor,
      Object.keys(r.quedas).length ? JSON.stringify(r.quedas) : '0',
      `${r.api.memoriaAntesMB ?? '?'} → ${r.api.memoriaConectadasMB ?? '?'}`,
    ]),
  );
  const linhas = [];
  for (const r of rodadas) {
    for (const l of r.latencias) {
      linhas.push([
        r.conexoesPedidas,
        l.fundo ?? 'sem carga',
        l.modo,
        l.enviadas,
        Object.values(l.falhasEnvio ?? {}).reduce((a, b) => a + b, 0),
        `${fmt(l.mensagem.p50)} / ${fmt(l.mensagem.p95)} / ${fmt(l.mensagem.p99)} / ${fmt(l.mensagem.max)}`,
        l.mensagem.naoEntregues,
        fmt(l.mensagem.pctAte500ms),
        `${fmt(l.aviso.p50)} / ${fmt(l.aviso.p95)} / ${fmt(l.aviso.p99)}`,
        l.aviso.naoEntregues,
        `${fmt(l.respostaEnvio.p50)} / ${fmt(l.respostaEnvio.p95)}`,
      ]);
    }
  }
  const latencia = tabelaMarkdown(
    [
      'Conexões',
      'Carga de fundo',
      'Envio por',
      'Enviadas',
      'Falhas no envio',
      'Mensagem p50/p95/p99/máx ms',
      'Não entregues',
      '% ≤ 500 ms',
      'Aviso p50/p95/p99 ms',
      'Avisos não entregues',
      'Resposta do envio p50/p95 ms',
    ],
    linhas,
  );
  const fundos = tabelaMarkdown(
    [
      'Conexões',
      'Carga de fundo',
      'Vazão real (req/s)',
      'Erros',
      'CPU API',
      'Outros bancos ativos',
    ],
    rodadas.flatMap((r) =>
      r.cargasDeFundo.map((f) => [
        r.conexoesPedidas,
        f.rotulo,
        fmt(f.resultado?.vazao),
        f.resultado?.erros ?? '?',
        fmt(f.cpuNucleosApi),
        f.outrosBancosAtivos.join(', ') || '—',
      ]),
    ),
  );
  return `${conexoes}\n\n${latencia}\n\n${fundos}`;
}

function markdown(r) {
  const m = r.maquina;
  const partes = [
    `# Teste de carga — ${r.iniciadoEm}`,
    '',
    `Máquina: ${m.cpu} (${m.nucleosFisicos ?? '?'} núcleos / ${m.nucleosLogicos} threads), ${m.memoriaGB} GB, ${m.so}. Node ${m.node}. ` +
      `MySQL ${m.mysql?.versao ?? '?'} no Docker ${m.docker?.versao ?? '?'} (${m.docker?.cpus ?? '?'} CPUs, ${m.docker?.memoriaGB ?? '?'} GB para a VM; buffer pool ${m.mysql?.bufferPoolMB ?? '?'} MB). ` +
      `API ${m.versaoApi} (commit ${r.api?.commit ?? '?'}), pool do banco ${r.config.dbPool}. ${r.config.env}.`,
    '',
    `Volume no início das medições: ${JSON.stringify(r.volumeAntes)}. No fim: ${JSON.stringify(r.volumeDepois)}.`,
    '',
  ];
  const secoes = [
    ['escrita', 'Escrita, laço fechado (RNF-002, meta p95 ≤ 500 ms)', META.escrita],
    ['escritaTaxa', 'Escrita, taxa fixa de chegada (RNF-002)', META.escrita],
    ['leitura', 'Leitura, laço fechado (RNF-001, meta p95 ≤ 300 ms)', META.leitura],
    ['leituraTaxa', 'Leitura, taxa fixa de chegada (RNF-001)', META.leitura],
    ['teto', 'Teto de referência sem banco (GET /health/live)', META.leitura],
  ];
  const banco = [];
  for (const [chave, titulo, meta] of secoes) {
    if (!r[chave]) continue;
    partes.push(`## ${titulo}`, '', tabelaHttp(r[chave], meta), '');
    banco.push(...tabelaBanco(chave, r[chave]));
  }
  if (banco.length) {
    partes.push(
      '## Consultas mais caras no MySQL por nível (performance_schema, janela medida)',
      '',
      tabelaMarkdown(
        ['Cenário', 'Nível', 'Consulta', 'Execuções', 'ms médio', 's total', 'Linhas lidas/exec'],
        banco,
      ),
      '',
    );
  }
  if (r.ws) partes.push('## WebSocket (RNF-023 e RNF-005)', '', tabelasWs(r.ws), '');
  if (r.diagnosticoBusca) {
    partes.push(
      '## Plano da busca no MySQL (uma conexão, sem carga)',
      '',
      tabelaMarkdown(
        ['Consulta', 'Acesso', 'Índice', 'Linhas estimadas', 'Mediana (ms)'],
        Object.entries(r.diagnosticoBusca).map(([k, v]) => [
          k,
          v.tipoAcesso,
          v.indice ?? '—',
          v.linhasEstimadas,
          fmt(v.msMediana),
        ]),
      ),
      '',
    );
  }
  return partes.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      niveis: { type: 'string', default: '10,50,100' },
      'taxas-escrita': { type: 'string', default: '25,50,100' },
      'taxas-leitura': { type: 'string', default: '50,100,200' },
      duracao: { type: 'string', default: '30' },
      aquecimento: { type: 'string', default: '10' },
      conexoes: { type: 'string', default: '500,1000' },
      latencia: { type: 'string', default: '30' },
      fundos: { type: 'string', default: '100/s,50vu' },
      pular: { type: 'string', default: '' },
      reaproveitar: { type: 'boolean', default: false },
      rapido: { type: 'boolean', default: false },
    },
  });
  if (values.rapido) {
    Object.assign(values, {
      niveis: '5,10',
      'taxas-escrita': '10,20',
      'taxas-leitura': '20,40',
      duracao: '5',
      aquecimento: '2',
      conexoes: '50',
      latencia: '5',
      fundos: '20/s,5vu',
    });
  }
  const lista = (s) => s.split(',').filter(Boolean).map(Number);
  const pular = new Set(values.pular.split(',').filter(Boolean));
  const cfg = configAmbiente();
  const n = (nome, padrao) => Number(process.env[nome] ?? (values.rapido ? padrao[1] : padrao[0]));
  const volume = {
    freelancers: n('CARGA_FREELANCERS', [250, 30]),
    clientes: n('CARGA_CLIENTES', [250, 30]),
    servicos: n('CARGA_SERVICOS', [10_000, 500]),
    paresWs: n('CARGA_PARES_WS', [30, 10]),
  };

  const iniciadoEm = new Date().toISOString();
  log(`API sob teste: ${cfg.apiDir} → ${cfg.apiUrl}; banco ${cfg.db.database}`);
  const maquina = await infoMaquina(cfg);

  let estado = null;
  let jwtSecret;
  if (values.reaproveitar) {
    estado = lerEstado();
    jwtSecret = estado.jwtSecret;
  } else {
    jwtSecret = randomBytes(32).toString('hex');
    log('banco: recriando e aplicando migrations');
    mkdirSync(PASTA_TRABALHO, { recursive: true });
    await prepararBanco(cfg, join(PASTA_TRABALHO, 'migrate.log'));
  }

  let api = null;
  const derrubar = async () => {
    const a = api;
    api = null;
    if (a) await derrubarApi(cfg, a);
  };
  process.on('SIGINT', () => {
    log('interrompido: derrubando a API');
    void derrubar().finally(() => process.exit(130));
  });
  process.on('exit', () => {
    if (api?.filho?.exitCode === null) api.filho.kill();
  });

  const resultado = {
    iniciadoEm,
    maquina,
    config: {
      dbPool: cfg.db.pool,
      niveis: values.niveis,
      taxasEscrita: values['taxas-escrita'],
      taxasLeitura: values['taxas-leitura'],
      duracaoS: Number(values.duracao),
      aquecimentoS: Number(values.aquecimento),
      conexoes: values.conexoes,
      latenciaS: Number(values.latencia),
      fundos: values.fundos,
      volume,
      reaproveitado: values.reaproveitar,
      env: 'NODE_ENV=production, LOG_LEVEL=info, JOBS_ENABLED=false, MAIL_PROVIDER=simulated, PUSH_PROVIDER=simulated, RATE_LIMIT_MAX alto',
    },
  };
  let monitor = null;
  let apiDerrubada = false;
  try {
    api = await subirApi(cfg, jwtSecret);
    resultado.api = { commit: api.sha, health: api.health };
    if (!estado) {
      estado = await semear({ ...cfg, ...volume, apiUrl: cfg.apiUrl, jwtSecret });
      resultado.segundosSeed = estado.segundosSeed;
    }
    monitor = await abrirMonitorBanco(cfg);
    resultado.volumeAntes = await volumeDoBanco(cfg);
    const comum = {
      apiUrl: cfg.apiUrl,
      estado,
      aquecimentoS: Number(values.aquecimento),
      duracaoS: Number(values.duracao),
      pidApi: api.pid,
      monitor,
    };
    const rodar = async (chave, cenario, modo, niveis) => {
      if (pular.has(chave) || niveis.length === 0) return;
      resultado[chave.replace(/-taxa$/, 'Taxa')] = await executarCenario({
        ...comum,
        cenario,
        modo,
        niveis,
      });
    };
    await rodar('escrita', 'escrita', 'vus', lista(values.niveis));
    await rodar('escrita-taxa', 'escrita', 'taxa', lista(values['taxas-escrita']));
    await rodar('leitura', 'leitura', 'vus', lista(values.niveis));
    await rodar('leitura-taxa', 'leitura', 'taxa', lista(values['taxas-leitura']));
    await rodar('teto', 'teto', 'vus', [50]);
    if (!pular.has('ws')) {
      resultado.ws = await executarWs({
        apiUrl: cfg.apiUrl,
        estado,
        conexoes: lista(values.conexoes),
        latenciaS: Number(values.latencia),
        baseS: values.rapido ? 5 : 15,
        fundos: lerFundos(values.fundos),
        pidApi: api.pid,
        monitor,
      });
    }
    resultado.volumeDepois = await volumeDoBanco(cfg);
    resultado.diagnosticoBusca = await diagnosticoBusca(cfg);
  } finally {
    await monitor?.fechar().catch(() => undefined);
    const a = api;
    await derrubar();
    apiDerrubada = Boolean(a);
  }
  resultado.apiDerrubada = apiDerrubada;

  const pasta = join(AQUI, 'resultados');
  mkdirSync(pasta, { recursive: true });
  const nome = `carga-${iniciadoEm.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}${values.rapido ? '-rapido' : ''}`;
  writeFileSync(join(pasta, `${nome}.json`), `${JSON.stringify(resultado, null, 2)}\n`);
  writeFileSync(join(pasta, `${nome}.md`), `${markdown(resultado)}\n`);
  log(`resultados em scripts/carga/resultados/${nome}.json e .md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
