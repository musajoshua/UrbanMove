import express from "express";
import cors from "cors";
import helmet from "helmet";
import { Kafka } from "kafkajs";
import pg from "pg";
import { createClient } from "redis";
import { collectDefaultMetrics, Counter, Histogram, Gauge, register } from "prom-client";
import { createLogger, format, transports } from "winston";

const PORT = parseInt(process.env.PORT || "4003");
const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const logger = createLogger({ level: "info", format: format.combine(format.timestamp(), format.json()), transports: [new transports.Console()] });

collectDefaultMetrics();
const processed = new Counter({ name: "urbanmove_analytics_processed_total", help: "Events processed", labelNames: ["type"] });
const latency = new Histogram({ name: "urbanmove_analytics_latency_seconds", help: "Processing latency", buckets: [0.01, 0.05, 0.1, 0.5, 1, 5] });
const congestionGauge = new Gauge({ name: "urbanmove_congestion_level", help: "Congestion by zone", labelNames: ["zone"] });

const tsPool = new pg.Pool({ connectionString: process.env.TIMESCALEDB_URL || "postgres://urbanmove:dev_password@localhost:5433/urbanmove_ts", max: 10 });
const redis = createClient({ url: process.env.REDIS_URL || "redis://:dev_redis_pass@localhost:6379" });

async function initDB() {
  const c = await tsPool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS vehicle_positions (time TIMESTAMPTZ NOT NULL, vehicle_id TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, speed DOUBLE PRECISION, heading INTEGER, vehicle_type TEXT);
      SELECT create_hypertable('vehicle_positions', 'time', if_not_exists => TRUE);
      CREATE TABLE IF NOT EXISTS traffic_aggregates (time TIMESTAMPTZ NOT NULL, zone TEXT, avg_speed DOUBLE PRECISION, vehicle_count INTEGER, congestion_score DOUBLE PRECISION);
      SELECT create_hypertable('traffic_aggregates', 'time', if_not_exists => TRUE);
      CREATE TABLE IF NOT EXISTS incidents (time TIMESTAMPTZ NOT NULL, incident_type TEXT, severity INTEGER, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, estimated_duration_min INTEGER, resolved BOOLEAN DEFAULT FALSE);
      SELECT create_hypertable('incidents', 'time', if_not_exists => TRUE);
    `);
    logger.info("TimescaleDB initialized");
  } finally { c.release(); }
}

function getZone(lat: number, lng: number): string {
  return `zone_${Math.floor((lng - 2.25) / 0.02)}_${Math.floor((lat - 48.80) / 0.02)}`;
}

const kafka = new Kafka({ clientId: "urbanmove-analytics", brokers: BROKERS });
const consumer = kafka.consumer({ groupId: "analytics-group" });

async function initKafka() {
  await consumer.connect();
  await consumer.subscribe({ topics: [/^urbanmove\.mobility\..*/], fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const timer = latency.startTimer();
      try {
        const data = JSON.parse(message.value!.toString());
        const type = topic.split(".").pop()!;
        if (type === "vehicle_position") {
          await tsPool.query(`INSERT INTO vehicle_positions (time,vehicle_id,latitude,longitude,speed,heading,vehicle_type) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [data.timestamp, data.vehicle_id, data.latitude, data.longitude, data.payload?.speed, data.payload?.heading, data.payload?.vehicle_type]);
          const zone = getZone(data.latitude, data.longitude);
          await redis.sAdd(`zone:${zone}:vehicles`, data.vehicle_id || "unknown");
          await redis.expire(`zone:${zone}:vehicles`, 60);
          const count = await redis.sCard(`zone:${zone}:vehicles`);
          const cong = Math.min(100, (count / 15) * 100);
          await redis.set(`zone:${zone}:congestion`, cong.toFixed(1), { EX: 60 });
          congestionGauge.set({ zone }, cong);
        } else if (type === "traffic_flow") {
          const zone = getZone(data.latitude, data.longitude);
          await tsPool.query(`INSERT INTO traffic_aggregates (time,zone,avg_speed,vehicle_count,congestion_score) VALUES ($1,$2,$3,$4,$5)`,
            [data.timestamp, zone, data.payload?.avg_speed, data.payload?.vehicles_per_minute, data.payload?.congestion_level === "high" ? 80 : 30]);
        } else if (type === "incident") {
          await tsPool.query(`INSERT INTO incidents (time,incident_type,severity,latitude,longitude,estimated_duration_min) VALUES ($1,$2,$3,$4,$5,$6)`,
            [data.timestamp, data.payload?.incident_type, data.payload?.severity, data.latitude, data.longitude, data.payload?.estimated_duration_min]);
        }
        processed.inc({ type });
      } catch (err) { logger.error("Process error", { error: err }); }
      finally { timer(); }
    },
  });
  logger.info("Kafka consumer started");
}

const app = express();
app.use(cors()); app.use(helmet()); app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", service: "analytics-service" }));
app.get("/metrics", async (_req, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });

app.get("/api/v1/analytics/positions", async (_req, res) => {
  const r = await tsPool.query(`SELECT * FROM vehicle_positions WHERE time > NOW() - INTERVAL '5 minutes' ORDER BY time DESC LIMIT 500`);
  res.json({ positions: r.rows, count: r.rowCount });
});

app.get("/api/v1/analytics/congestion", async (_req, res) => {
  const keys = await redis.keys("zone:*:congestion");
  const zones: Record<string, number> = {};
  for (const k of keys) { const v = await redis.get(k); if (v) zones[k.split(":")[1]] = parseFloat(v); }
  res.json({ zones, timestamp: new Date().toISOString() });
});

app.get("/api/v1/analytics/trends", async (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const r = await tsPool.query(`SELECT time_bucket('1 hour', time) AS bucket, AVG(avg_speed) AS avg_speed, SUM(vehicle_count) AS total_vehicles FROM traffic_aggregates WHERE time > NOW() - make_interval(hours => $1) GROUP BY bucket ORDER BY bucket`, [hours]);
  res.json({ trends: r.rows });
});

app.get("/api/v1/analytics/incidents", async (_req, res) => {
  const r = await tsPool.query(`SELECT * FROM incidents WHERE time > NOW() - INTERVAL '24 hours' AND resolved = FALSE ORDER BY severity DESC LIMIT 50`);
  res.json({ incidents: r.rows, count: r.rowCount });
});

app.post("/api/v1/analytics/route", async (req, res) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.body;
  const oZ = getZone(origin_lat, origin_lng); const dZ = getZone(dest_lat, dest_lng);
  const oC = parseFloat((await redis.get(`zone:${oZ}:congestion`)) || "0");
  const dC = parseFloat((await redis.get(`zone:${dZ}:congestion`)) || "0");
  const dist = Math.sqrt(Math.pow((dest_lat - origin_lat) * 111, 2) + Math.pow((dest_lng - origin_lng) * 111, 2));
  const mins = (dist / 0.5) * (1 + (oC + dC) / 200);
  res.json({ estimated_minutes: Math.round(mins), congestion_factor: ((oC + dC) / 2).toFixed(1), recommendation: oC > 70 || dC > 70 ? "Consider alternate routes" : "Route clear" });
});

async function start() {
  await initDB(); await redis.connect(); await initKafka();
  app.listen(PORT, () => logger.info(`Analytics on port ${PORT}`));
}
process.on("SIGTERM", async () => { await consumer.disconnect(); await redis.quit(); process.exit(0); });
start().catch(e => { logger.error("Startup failed", { error: e }); process.exit(1); });
