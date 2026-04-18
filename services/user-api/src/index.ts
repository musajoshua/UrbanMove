import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { collectDefaultMetrics, Counter, register } from "prom-client";
import { createLogger, format, transports } from "winston";

const PORT = parseInt(process.env.PORT || "4005");
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_in_prod";
const ANALYTICS = process.env.ANALYTICS_URL || "http://localhost:4003";
const FLEET = process.env.FLEET_URL || "http://localhost:4004";
const logger = createLogger({ level: "info", format: format.combine(format.timestamp(), format.json()), transports: [new transports.Console()] });

collectDefaultMetrics();
const apiReqs = new Counter({ name: "urbanmove_api_requests_total", help: "API requests", labelNames: ["method", "path", "status"] });
const redis = createClient({ url: process.env.REDIS_URL || "redis://:dev_redis_pass@localhost:6379" });

function auth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "Auth required" }); return; }
  try {
    const p = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    if (p.type !== "access") { res.status(401).json({ error: "Invalid token" }); return; }
    (req as any).user = p; next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

async function proxyGet(base: string, path: string) {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const app = express();
app.use(cors()); app.use(helmet()); app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", service: "user-api" }));
app.get("/metrics", async (_req, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });

app.get("/api/v1/dashboard/summary", auth, async (_req, res) => {
  try {
    const cached = await redis.get("dashboard:summary");
    if (cached) return res.json(JSON.parse(cached));
    const [fleet, congestion, incidents] = await Promise.all([
      proxyGet(FLEET, "/api/v1/fleet/stats"),
      proxyGet(ANALYTICS, "/api/v1/analytics/congestion"),
      proxyGet(ANALYTICS, "/api/v1/analytics/incidents"),
    ]);
    const summary = { fleet, congestion, active_incidents: incidents.count, incidents: incidents.incidents?.slice(0, 5), timestamp: new Date().toISOString() };
    await redis.set("dashboard:summary", JSON.stringify(summary), { EX: 10 });
    res.json(summary);
  } catch (err) { logger.error("Summary error", { error: err }); res.status(500).json({ error: "Failed" }); }
});

app.get("/api/v1/vehicles/positions", auth, async (_req, res) => {
  try { res.json(await proxyGet(ANALYTICS, "/api/v1/analytics/positions")); } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/v1/traffic/congestion", auth, async (_req, res) => {
  try { res.json(await proxyGet(ANALYTICS, "/api/v1/analytics/congestion")); } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/v1/traffic/trends", auth, async (req, res) => {
  try { res.json(await proxyGet(ANALYTICS, `/api/v1/analytics/trends?hours=${req.query.hours || 24}`)); } catch { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/v1/routes/recommend", auth, async (req, res) => {
  try {
    const r = await fetch(`${ANALYTICS}/api/v1/analytics/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) });
    res.json(await r.json());
  } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/v1/fleet", auth, async (req, res) => {
  try { res.json(await proxyGet(FLEET, `/api/v1/fleet/vehicles?${new URLSearchParams(req.query as Record<string, string>)}`)); } catch { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/v1/incidents", auth, async (_req, res) => {
  try { res.json(await proxyGet(ANALYTICS, "/api/v1/analytics/incidents")); } catch { res.status(500).json({ error: "Failed" }); }
});

async function start() {
  await redis.connect();
  app.listen(PORT, () => logger.info(`User API on port ${PORT}`));
}
process.on("SIGTERM", async () => { await redis.quit(); process.exit(0); });
start().catch(e => { logger.error("Startup failed", { error: e }); process.exit(1); });
