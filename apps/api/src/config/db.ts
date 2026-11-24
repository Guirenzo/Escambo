/**
 * Conexão com o MySQL (config, base da camada de dados). Os repositories importam o pool daqui
 * para rodar o SQL; o server.ts e o /api/health usam o pingDb. Dentro: pool, a função de
 * transação e pingDb. Os dados de acesso (host, usuário, senha) vêm do env.ts.
 *
 * Pool de conexões: abrir uma conexão nova a cada consulta é lento, então a API deixa até
 * DB_CONNECTION_LIMIT (10) conexões abertas e reaproveita. Quem precisa pega uma livre e devolve
 * no fim (release); com as 10 ocupadas, o pedido espera na fila.
 *
 * Transação: um grupo de comandos que vale inteiro ou não vale nada. O commit grava tudo junto; o
 * rollback desfaz tudo se um passo falhar (ex.: criar a contratação e reservar o dinheiro).
 */
import mysql, { type PoolConnection } from 'mysql2/promise';
import { env } from './env';

/**
 * Pool de conexões MySQL (mysql2). namedPlaceholders permite usar :param nas queries.
 */
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  // Sem conexão livre, o pedido espera na fila (queueLimit 0 = fila sem limite) em vez de falhar.
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  // Com :userId no SQL, o mysql2 troca pelo valor já escapado: o valor nunca é colado no texto da
  // consulta, e é isso que protege de SQL injection.
  namedPlaceholders: true,
  // Datas sempre em UTC nos dois sentidos: o MySQL (Docker/CI) roda em UTC e compara com NOW();
  // sem isto, um Date do Node em fuso local (ex.: -03:00) vira 'vencido' ou 'no futuro' à toa.
  timezone: 'Z',
  // Mantém vivas as conexões paradas no pool, para a rede não derrubá-las por inatividade.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

// Uso: o repository passa uma função que recebe a conexão (conn) e roda os comandos nela. Todos
// usam a mesma conexão, porque a transação vive dentro de uma conexão só. Devolve o que a função
// devolver; com erro, desfaz tudo e repassa o erro para quem chamou.
/** Executa `work` numa transação: commit no fim, rollback se algo falhar. */
export async function inTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  // Pega uma conexão do pool só para esta transação.
  const conn = await pool.getConnection();
  try {
    // Abre a transação; daqui até o commit, nada fica valendo para as outras conexões.
    await conn.beginTransaction();
    const out = await work(conn);
    await conn.commit();
    return out;
  } catch (err) {
    // Algo falhou: desfaz tudo. O catch vazio impede que um erro no rollback esconda o original.
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    // Devolve a conexão ao pool com sucesso ou com erro; sem isso o pool se esgotaria.
    conn.release();
  }
}

// Roda a consulta mais simples possível, que não lê tabela nenhuma: só prova que o banco responde.
// Se o banco estiver fora, lança erro (o waitForDb tenta de novo; o /api/health responde 500).
/** Verifica conectividade com o banco (usado no /health e no boot). */
export async function pingDb(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}
