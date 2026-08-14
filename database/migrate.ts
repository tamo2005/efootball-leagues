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

try {
  await connection.query(schema);
  console.log("Database schema applied successfully.");
} finally {
  await connection.end();
}
