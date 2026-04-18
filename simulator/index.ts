const TARGET = process.env.TARGET_URL || "http://localhost:4002";
const RATE = parseInt(process.env.RATE || "10");
const CENTER = { lat: 48.8566, lng: 2.3522 };
const G = 0.05;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

interface V { id: string; lat: number; lng: number; speed: number; heading: number; type: string }

const fleet: V[] = Array.from({ length: 50 }, (_, i) => ({
  id: `vehicle-${String(i).padStart(4, "0")}`,
  lat: CENTER.lat + (Math.random() - .5) * G * 2,
  lng: CENTER.lng + (Math.random() - .5) * G * 2,
  speed: rand(20, 60), heading: rand(0, 360),
  type: pick(["bus", "taxi", "scooter", "bike"]),
}));

const sensors = Array.from({ length: 20 }, (_, i) => ({
  id: `sensor-${String(i).padStart(3, "0")}`,
  lat: CENTER.lat + (Math.random() - .5) * G * 2,
  lng: CENTER.lng + (Math.random() - .5) * G * 2,
}));

function moveVehicle(v: V) {
  v.heading += (Math.random() - .5) * 15;
  v.speed = Math.max(5, Math.min(80, v.speed + (Math.random() - .5) * 10));
  const dt = 1 / 3600;
  const rad = (v.heading * Math.PI) / 180;
  const d = v.speed * dt;
  v.lat += (d * Math.cos(rad)) / 111;
  v.lng += (d * Math.sin(rad)) / (111 * Math.cos((v.lat * Math.PI) / 180));
  if (Math.abs(v.lat - CENTER.lat) > G) v.heading = 180 - v.heading;
  if (Math.abs(v.lng - CENTER.lng) > G) v.heading = 360 - v.heading;
}

let sent = 0, errors = 0;

async function send(event: Record<string, unknown>) {
  try {
    const r = await fetch(`${TARGET}/api/v1/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
    if (r.ok) sent++; else errors++;
  } catch { errors++; }
}

console.log(`UrbanMove Simulator | Target: ${TARGET} | Rate: ${RATE}/s | Fleet: ${fleet.length}`);

setInterval(async () => {
  const roll = Math.random();
  if (roll < 0.6) {
    const v = fleet[Math.floor(Math.random() * fleet.length)];
    moveVehicle(v);
    await send({ event_type: "vehicle_position", vehicle_id: v.id, latitude: v.lat, longitude: v.lng, timestamp: new Date().toISOString(), payload: { speed: Math.round(v.speed * 10) / 10, heading: Math.round(v.heading), vehicle_type: v.type } });
  } else if (roll < 0.9) {
    const s = sensors[Math.floor(Math.random() * sensors.length)];
    const rush = new Date().getHours() >= 7 && new Date().getHours() <= 9;
    await send({ event_type: "traffic_flow", sensor_id: s.id, latitude: s.lat, longitude: s.lng, timestamp: new Date().toISOString(), payload: { vehicles_per_minute: Math.round(rand(rush ? 40 : 10, rush ? 80 : 30)), avg_speed: Math.round(rand(rush ? 10 : 30, rush ? 30 : 50)), congestion_level: rush ? "high" : "low" } });
  } else {
    await send({ event_type: "incident", latitude: CENTER.lat + (Math.random() - .5) * G * 2, longitude: CENTER.lng + (Math.random() - .5) * G * 2, timestamp: new Date().toISOString(), payload: { incident_type: pick(["accident", "road_closure", "construction"]), severity: Math.ceil(Math.random() * 5), estimated_duration_min: 10 + Math.floor(Math.random() * 50) } });
  }
  if ((sent + errors) % 100 === 0 && sent + errors > 0) console.log(`  sent=${sent} errors=${errors}`);
}, 1000 / RATE);
