import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Add it to your environment before running db:migrate.");
}

const schema = await readFile(path.join(__dirname, "schema.sql"), "utf8");
const connection = await mysql.createConnection({
  uri: databaseUrl,
  multipleStatements: true,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function hasColumn(tableName: string, columnName: string) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tableName, columnName],
  );
  return Number((rows as Array<{ count: number }>)[0]?.count || 0) > 0;
}

async function addColumn(tableName: string, columnName: string, definition: string) {
  if (!(await hasColumn(tableName, columnName))) {
    await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  }
}

try {
  await connection.query(schema);

  await addColumn("teams", "status", "ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'APPROVED'");
  await addColumn("teams", "created_by_email", "VARCHAR(320) NULL");
  await addColumn("teams", "approved_by_email", "VARCHAR(320) NULL");
  await addColumn("teams", "approved_at", "BIGINT NULL");
  await connection.query("ALTER TABLE teams MODIFY COLUMN status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'APPROVED'");

  await addColumn("matches", "original_kickoff_at", "BIGINT NULL");
  await addColumn("matches", "rescheduled_at", "BIGINT NULL");
  await addColumn("matches", "reschedule_reason", "VARCHAR(255) NULL");
  await addColumn("matches", "rescheduled_by_email", "VARCHAR(320) NULL");
  await connection.query("ALTER TABLE matches MODIFY COLUMN status ENUM('SCHEDULED', 'PENDING', 'CONFIRMED', 'POSTPONED', 'CANCELLED') NOT NULL DEFAULT 'SCHEDULED'");

  console.log("Database schema and compatibility migrations applied successfully.");
} finally {
  await connection.end();
}
