import pg from "pg";

let pool;

// Vercel's Neon integration sets DATABASE_URL (and POSTGRES_URL); either works.
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 3 });
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}
