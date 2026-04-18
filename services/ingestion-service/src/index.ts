import express from "express";
import cors from "cors";
import helmet from "helmet";
import { Kafka } from "kafkajs";
import { z } from "zod";
import { collectDefaultMetrics, Counter, Histogram, register } from "prom-client";
import { createLogger, format, transports } from "winston";

const PORT = parseInt(process.env.PORT || "4002");
const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const logger = createLogger({ level: "info", format: format.combine(format.timestamp(), format.json()), transports: [new transports.Console()] });

collectDefaultMetrics();
const eventsIngested = new Counter({ name: "urbanmove_events_ingested_total", help: "Events ingested", labelNames: ["event_type"] });
const ingestLatency = new Histogram({ name: "urbanmove_ingest_latency_seconds", help: "Ingest latency", buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1] });

const EventSchema = z.object({
  event_type: z.enum(["vehicle_position", "traffic_flow", "transit_arrival", "incident", "sensor_reading"]),
  vehicle_id: z.string().optional(),
  sensor_id: z.string().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()).optional(),
});

const BatchSchema = z.object({ events: z.array(EventSchema).min(1).max(1000) });

const kafka = new Kafka({ clientId: "urbanmove-ingestion", brokers: BROKERS, retry: { retries: 8 } });
const producer = kafka.producer({ allowAutoTopicCreation: true });

const app = express();
app.use(cors()); app.use(helmet()); app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "ingestion-service" }));
app.get("/metrics", async (_req, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });

app.post("/api/v1/events", async (req, res) => {
  const timer = ingestLatency.startTimer();
  try {
    const event = EventSchema.parse(req.body);
    await producer.send({ topic: `urbanmove.mobility.${event.event_type}`, messages: [{ key: event.vehicle_id || event.sensor_id || "unknown", value: JSON.stringify(event) }] });
    eventsIngested.inc({ event_type: event.event_type }); timer();
    res.status(202).json({ accepted: true });
  } catch (err) {
    timer();
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", details: err.issues });
    logger.error("Ingest error", { error: err }); res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/v1/events/batch", async (req, res) => {
  const timer = ingestLatency.startTimer();
  try {
    const { events } = BatchSchema.parse(req.body);
    await Promise.all(events.map(async e => {
      await producer.send({ topic: `urbanmove.mobility.${e.event_type}`, messages: [{ key: e.vehicle_id || e.sensor_id || "unknown", value: JSON.stringify(e) }] });
      eventsIngested.inc({ event_type: e.event_type });
    }));
    timer(); res.status(202).json({ accepted: true, count: events.length });
  } catch (err) {
    timer();
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", details: err.issues });
    logger.error("Batch error", { error: err }); res.status(500).json({ error: "Internal error" });
  }
});

async function start() {
  await producer.connect(); logger.info("Kafka producer connected");
  app.listen(PORT, () => logger.info(`Ingestion service on port ${PORT}`));
}
process.on("SIGTERM", async () => { await producer.disconnect(); process.exit(0); });
start().catch(e => { logger.error("Startup failed", { error: e }); process.exit(1); });
