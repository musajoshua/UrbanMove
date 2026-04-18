import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";
import { Kafka } from "kafkajs";
import { createClient } from "redis";
import { collectDefaultMetrics, Gauge, register } from "prom-client";
import { createLogger, format, transports } from "winston";

const PORT = parseInt(process.env.PORT || "4004");
const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const logger = createLogger({ level: "info", format: format.combine(format.timestamp(), format.json()), transports: [new transports.Console()] });

collectDefaultMetrics();
const activeVehicles = new Gauge({ name: "urbanmove_active_vehicles", help: "Active vehicles", labelNames: ["type"] });
const wsConns = new Gauge({ name: "urbanmove_ws_connections", help: "WS connections" });

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL || "postgres://urbanmove:dev_password@localhost:5432/urbanmove", max: 10 });
const redis = createClient({ url: process.env.REDIS_URL || "redis://:dev_redis_pass@localhost:6379" });

async function initDB() {
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS vehicles (id VARCHAR(50) PRIMARY KEY, type VARCHAR(20), status VARCHAR(20) DEFAULT 'active', latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, speed DOUBLE PRECISION DEFAULT 0, heading INTEGER DEFAULT 0, last_seen TIMESTAMPTZ DEFAULT NOW(), metadata JSONB DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
    `);
    logger.info("Fleet DB initialized");
  } finally { c.release(); }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/fleet" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws); wsConns.inc();
  ws.on("close", () => { clients.delete(ws); wsConns.dec(); });
});

function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(data); }
}

const kafka = new Kafka({ clientId: "urbanmove-fleet", brokers: BROKERS });
const consumer = kafka.consumer({ groupId: "fleet-group" });

async function initKafka() {
  await consumer.connect();
  await consumer.subscribe({ topic: "urbanmove.mobility.vehicle_position", fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const d = JSON.parse(message.value!.toString());
        await pool.query(
          `INSERT INTO vehicles (id,type,latitude,longitude,speed,heading,last_seen,status) VALUES ($1,$2,$3,$4,$5,$6,NOW(),'active') ON CONFLICT (id) DO UPDATE SET latitude=$3,longitude=$4,speed=$5,heading=$6,last_seen=NOW(),status='active'`,
          [d.vehicle_id, d.payload?.vehicle_type || "unknown", d.latitude, d.longitude, d.payload?.speed || 0, d.payload?.heading || 0]
        );
        await redis.hSet(`vehicle:${d.vehicle_id}`, { lat: String(d.latitude), lng: String(d.longitude), speed: String(d.payload?.speed || 0) });
        await redis.expire(`vehicle:${d.vehicle_id}`, 120);
        broadcast({ type: "vehicle_update", data: { id: d.vehicle_id, lat: d.latitude, lng: d.longitude, speed: d.payload?.speed, type: d.payload?.vehicle_type } });
      } catch (err) { logger.error("Fleet event error", { error: err }); }
    },
  });
  logger.info("Fleet Kafka consumer started");
}

app.use(cors()); app.use(helmet()); app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok", service: "fleet-service" }));
app.get("/metrics", async (_req, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });

app.get("/api/v1/fleet/vehicles", async (req, res) => {
  const r = await pool.query(`SELECT * FROM vehicles WHERE last_seen > NOW() - INTERVAL '10 minutes' ORDER BY last_seen DESC LIMIT 200`);
  res.json({ vehicles: r.rows, count: r.rowCount });
});

app.get("/api/v1/fleet/vehicles/:id", async (req, res) => {
  const r = await pool.query("SELECT * FROM vehicles WHERE id = $1", [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(r.rows[0]);
});

app.get("/api/v1/fleet/stats", async (_req, res) => {
  const r = await pool.query(`SELECT type, status, COUNT(*)::int as count, AVG(speed) as avg_speed FROM vehicles WHERE last_seen > NOW() - INTERVAL '10 minutes' GROUP BY type, status`);
  const total = await pool.query("SELECT COUNT(*)::int FROM vehicles WHERE last_seen > NOW() - INTERVAL '10 minutes'");
  res.json({ breakdown: r.rows, total: total.rows[0].count });
});

async function start() {
  await initDB(); await redis.connect(); await initKafka();
  server.listen(PORT, () => logger.info(`Fleet service on port ${PORT}`));
}
process.on("SIGTERM", async () => { await consumer.disconnect(); await redis.quit(); wss.close(); process.exit(0); });
start().catch(e => { logger.error("Startup failed", { error: e }); process.exit(1); });
