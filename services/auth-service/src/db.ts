import pg from "pg";
import { createLogger, format, transports } from "winston";

export const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

export const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || "postgres://urbanmove:dev_password@localhost:5432/urbanmove",
  max: 20,
});

export type UserRole = "admin" | "operator" | "analyst" | "viewer";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
}

export async function initDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    `);
    logger.info("Database tables initialized");
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return r.rows[0] || null;
}

export async function findUserById(id: string): Promise<User | null> {
  const r = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return r.rows[0] || null;
}

export async function createUser(email: string, hash: string, name: string, role: UserRole = "viewer"): Promise<User> {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, hash, name, role]
  );
  return r.rows[0];
}

export async function storeRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await pool.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [userId, tokenHash, expiresAt]);
}

export async function findRefreshToken(tokenHash: string) {
  const r = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()`, [tokenHash]);
  return r.rows[0] || null;
}

export async function revokeRefreshTokens(userId: string): Promise<void> {
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}
