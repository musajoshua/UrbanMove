import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { collectDefaultMetrics, Counter, register } from "prom-client";
import { initDB, findUserByEmail, findUserById, createUser, storeRefreshToken, findRefreshToken, revokeRefreshTokens, logger } from "./db.js";
import type { UserRole } from "./db.js";

const PORT = parseInt(process.env.PORT || "4001");
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_in_prod";
const JWT_EXPIRY = "15m";
const REFRESH_DAYS = 7;

collectDefaultMetrics();
const authAttempts = new Counter({ name: "urbanmove_auth_attempts_total", help: "Auth attempts", labelNames: ["method", "status"] });

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  full_name: z.string().min(1).max(255),
  role: z.enum(["admin", "operator", "analyst", "viewer"]).optional(),
});

const LoginSchema = z.object({ email: z.string().email(), password: z.string() });

function makeAccessToken(userId: string, email: string, role: UserRole): string {
  const payload = { sub: userId, email, role, type: "access" };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function makeRefreshToken(userId: string, email: string, role: UserRole): string {
  const payload = { sub: userId, email, role, type: "refresh" };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${REFRESH_DAYS}d` });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  if (!token) { res.status(401).json({ error: "Missing token" }); return; }
  try {
    const p = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    if (p.type !== "access") { res.status(401).json({ error: "Invalid token type" }); return; }
    (req as any).user = p;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many attempts" } });

app.get("/health", (_req, res) => res.json({ status: "ok", service: "auth-service" }));
app.get("/metrics", async (_req, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });

app.post("/api/v1/auth/register", authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, full_name, role } = RegisterSchema.parse(req.body);
    if (await findUserByEmail(email)) { authAttempts.inc({ method: "register", status: "conflict" }); return res.status(409).json({ error: "Email exists" }); }
    const user = await createUser(email, await bcrypt.hash(password, 12), full_name, role);
    const access = makeAccessToken(user.id, user.email, user.role);
    const refresh = makeRefreshToken(user.id, user.email, user.role);
    await storeRefreshToken(user.id, hashToken(refresh), new Date(Date.now() + REFRESH_DAYS * 86400000));
    authAttempts.inc({ method: "register", status: "success" });
    res.status(201).json({ user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }, access_token: access, refresh_token: refresh });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", details: err.issues });
    logger.error("Register error", { error: err }); res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/v1/auth/login", authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      authAttempts.inc({ method: "login", status: "invalid" }); return res.status(401).json({ error: "Invalid credentials" });
    }
    const access = makeAccessToken(user.id, user.email, user.role);
    const refresh = makeRefreshToken(user.id, user.email, user.role);
    await storeRefreshToken(user.id, hashToken(refresh), new Date(Date.now() + REFRESH_DAYS * 86400000));
    authAttempts.inc({ method: "login", status: "success" });
    res.json({ user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }, access_token: access, refresh_token: refresh });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", details: err.issues });
    logger.error("Login error", { error: err }); res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/v1/auth/refresh", async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: "Token required" });
    const p = jwt.verify(refresh_token, JWT_SECRET) as Record<string, unknown>;
    if (p.type !== "refresh") return res.status(401).json({ error: "Invalid type" });
    if (!(await findRefreshToken(hashToken(refresh_token)))) return res.status(401).json({ error: "Revoked" });
    const user = await findUserById(p.sub as string);
    if (!user) return res.status(401).json({ error: "User not found" });
    await revokeRefreshTokens(user.id);
    const access = makeAccessToken(user.id, user.email, user.role);
    const refresh = makeRefreshToken(user.id, user.email, user.role);
    await storeRefreshToken(user.id, hashToken(refresh), new Date(Date.now() + REFRESH_DAYS * 86400000));
    res.json({ access_token: access, refresh_token: refresh });
  } catch { res.status(401).json({ error: "Invalid token" }); }
});

app.post("/api/v1/auth/logout", authenticateToken, async (req: Request, res: Response) => {
  await revokeRefreshTokens((req as any).user.sub);
  res.json({ message: "Logged out" });
});

app.get("/api/v1/auth/me", authenticateToken, async (req: Request, res: Response) => {
  const user = await findUserById((req as any).user.sub);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user.id, email: user.email, full_name: user.full_name, role: user.role });
});

app.get("/api/v1/auth/verify", authenticateToken, (req: Request, res: Response) => {
  const u = (req as any).user;
  res.json({ valid: true, user: { id: u.sub, email: u.email, role: u.role } });
});

async function start() {
  await initDB();
  app.listen(PORT, () => logger.info(`Auth service on port ${PORT}`));
}
process.on("SIGTERM", () => process.exit(0));
start().catch(e => { logger.error("Startup failed", { error: e }); process.exit(1); });
