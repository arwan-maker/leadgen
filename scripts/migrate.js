import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const pool = getPool();
await pool.query(sql);
await pool.end();
console.log("Database schema is up to date.");
