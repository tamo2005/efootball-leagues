import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";

let pool: mysql.Pool | undefined;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured. Add a MySQL or TiDB connection string before using the API.");
  }

  if (!pool) {
    const connectionUrl = new URL(process.env.DATABASE_URL);
    pool = mysql.createPool({
      host: connectionUrl.hostname,
      port: Number(connectionUrl.port || 3306),
      user: decodeURIComponent(connectionUrl.username),
      password: decodeURIComponent(connectionUrl.password),
      database: connectionUrl.pathname.replace(/^\//, "") || undefined,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
      waitForConnections: true,
      enableKeepAlive: true,
      connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 7000),
      namedPlaceholders: true,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false, minVersion: "TLSv1.2" } : undefined,
    });
  }

  return pool;
}

export async function query<T = RowDataPacket[]>(sql: string, params: Record<string, unknown> = {}) {
  const [rows] = await getPool().query({ sql, namedPlaceholders: true }, params as any);
  return rows as T;
}

export async function withTransaction<T>(callback: (connection: PoolConnection) => Promise<T>) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function databaseHealth() {
  if (!isDatabaseConfigured()) {
    return { configured: false, connected: false };
  }
  try {
    await query<RowDataPacket[]>("SELECT 1 AS ok");
    return { configured: true, connected: true };
  } catch {
    return { configured: true, connected: false };
  }
}
