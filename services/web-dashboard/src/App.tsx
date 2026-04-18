import { useState, useEffect, useRef } from "react";

const WS_URL = (import.meta as any).env?.VITE_WS_URL || "ws://localhost:4004";
const PARIS = { lat: 48.8566, lng: 2.3522 };
const G = 0.04;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b));
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const M = { fontFamily: "'JetBrains Mono', monospace" } as const;
const TC: Record<string, string> = { bus: "#22d3ee", taxi: "#facc15", scooter: "#a78bfa", bike: "#34d399" };
const SC: Record<string, string> = { Low: "#34d399", Medium: "#facc15", High: "#fb923c", Critical: "#f87171" };

interface V { id: string; type: string; lat: number; lng: number; speed: number; status: string; color: string }
interface Inc { id: string; type: string; severity: string; location: string; time: string }

function genVehicles(n: number): V[] {
  const t = ["bus", "taxi", "scooter", "bike"];
  return Array.from({ length: n }, (_, i) => { const tp = pick(t); return { id: `V-${String(i).padStart(4, "0")}`, type: tp, lat: PARIS.lat + (Math.random() - .5) * G * 2, lng: PARIS.lng + (Math.random() - .5) * G * 2, speed: rand(5, 60), status: Math.random() > .1 ? "active" : "idle", color: TC[tp] }; });
}

function genIncidents(): Inc[] {
  const k = ["Accident", "Road closure", "Construction", "Signal failure", "Weather hazard"];
  const s = ["Low", "Medium", "High", "Critical"];
  const st = ["Rue de Rivoli", "Bd Haussmann", "Av Champs-Élysées", "Bd Saint-Germain", "Rue de la Paix"];
  return Array.from({ length: 6 }, (_, i) => ({ id: `INC-${1000 + i}`, type: pick(k), severity: pick(s), location: pick(st), time: `${randInt(0, 23).toString().padStart(2, "0")}:${randInt(0, 59).toString().padStart(2, "0")}` }));
}

function Stat({ label, value, unit, accent }: { label: string; value: string | number; unit?: string; accent?: string }) {
  return (<div style={{ padding: "14px 16px", background: "rgba(255,255,255,.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,.06)" }}>
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "rgba(255,255,255,.4)", marginBottom: 6, ...M }}>{label}</div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 28, fontWeight: 600, color: accent || "#fff", ...M }}>{value}</span>
      {unit && <span style={{ fontSize: 12, color: "rgba(255,255,255,.35)", ...M }}>{unit}</span>}
    </div>
  </div>);
}

function FleetMap({ vehicles, sel, onSel }: { vehicles: V[]; sel: string | null; onSel: (id: string | null) => void }) {
  const W = 380, H = 300;
  const toX = (lng: number) => ((lng - (PARIS.lng - G)) / (G * 2)) * W;
  const toY = (lat: number) => H - ((lat - (PARIS.lat - G)) / (G * 2)) * H;
  return (<svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 8, background: "rgba(0,0,0,.4)", border: "1px solid rgba(255,255,255,.06)" }}>
    {Array.from({ length: 9 }, (_, i) => <line key={`x${i}`} x1={W * i / 8} y1={0} x2={W * i / 8} y2={H} stroke="rgba(255,255,255,.04)" strokeWidth={.5} />)}
    {Array.from({ length: 7 }, (_, i) => <line key={`y${i}`} x1={0} y1={H * i / 6} x2={W} y2={H * i / 6} stroke="rgba(255,255,255,.04)" strokeWidth={.5} />)}
    {vehicles.map(v => (<g key={v.id} onClick={() => onSel(v.id === sel ? null : v.id)} style={{ cursor: "pointer" }}>
      <circle cx={toX(v.lng)} cy={toY(v.lat)} r={v.id === sel ? 5 : 3} fill={v.color} opacity={v.status === "active" ? .9 : .3} stroke={v.id === sel ? "#fff" : "none"} strokeWidth={1} />
      {v.id === sel && <text x={toX(v.lng) + 14} y={toY(v.lat) + 4} fill="#fff" fontSize={9} style={M}>{v.id}</text>}
    </g>))}
  </svg>);
}

export default function App() {
  const [vehicles, setVehicles] = useState(() => genVehicles(80));
  const [incidents] = useState(() => genIncidents());
  const [sel, setSel] = useState<string | null>(null);
  const [events, setEvents] = useState(124832);
  const [tick, setTick] = useState(0);
  const [ws, setWs] = useState(false);

  useEffect(() => { try { const s = new WebSocket(`${WS_URL}/ws/fleet`); s.onopen = () => setWs(true); s.onclose = () => setWs(false); return () => s.close(); } catch {} }, []);

  useEffect(() => {
    if (ws) return;
    const i = setInterval(() => {
      setVehicles(p => p.map(v => ({ ...v, lat: v.lat + (Math.random() - .5) * .001, lng: v.lng + (Math.random() - .5) * .001, speed: Math.max(0, Math.min(80, v.speed + (Math.random() - .5) * 5)), status: Math.random() > .05 ? "active" : "idle" })));
      setEvents(p => p + randInt(5, 30)); setTick(t => t + 1);
    }, 2000);
    return () => clearInterval(i);
  }, [ws]);

  const active = vehicles.filter(v => v.status === "active").length;
  const avg = (vehicles.reduce((s, v) => s + v.speed, 0) / vehicles.length).toFixed(1);
  const crit = incidents.filter(i => i.severity === "Critical" || i.severity === "High").length;
  const sv = sel ? vehicles.find(v => v.id === sel) : null;

  return (<div style={{ padding: "20px 24px", minHeight: "100vh" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: ws ? "#22d3ee" : "#34d399", boxShadow: `0 0 8px ${ws ? "#22d3ee" : "#34d399"}` }} />
        <h1 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>UrbanMove</h1>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,.25)", ...M }}>OPS CENTER</span>
      </div>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)", ...M }}>{ws ? "LIVE" : "DEMO"} · {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
      <Stat label="Fleet active" value={active} unit={`/ ${vehicles.length}`} accent="#22d3ee" />
      <Stat label="Avg speed" value={avg} unit="km/h" accent="#facc15" />
      <Stat label="Events" value={events.toLocaleString()} accent="#a78bfa" />
      <Stat label="Incidents" value={crit} unit={`/ ${incidents.length}`} accent="#f87171" />
      <Stat label="Uptime" value="99.97" unit="%" accent="#34d399" />
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Fleet map · Paris</div>
        <FleetMap vehicles={vehicles} sel={sel} onSel={setSel} />
        {sv && <div style={{ marginTop: 8, padding: "10px 14px", background: "rgba(255,255,255,.03)", borderRadius: 8, border: `1px solid ${sv.color}33`, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div><div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", ...M }}>ID</div><div style={{ fontSize: 13, fontWeight: 500, color: sv.color, ...M }}>{sv.id}</div></div>
          <div><div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", ...M }}>TYPE</div><div style={{ fontSize: 13, fontWeight: 500, textTransform: "capitalize" }}>{sv.type}</div></div>
          <div><div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", ...M }}>SPEED</div><div style={{ fontSize: 13, fontWeight: 500, ...M }}>{sv.speed.toFixed(1)} km/h</div></div>
        </div>}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Fleet breakdown</div>
          {Object.entries(vehicles.reduce<Record<string, number>>((a, v) => { a[v.type] = (a[v.type] || 0) + 1; return a; }, {})).map(([t, c]) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: TC[t] }} />
              <span style={{ fontSize: 12, color: "rgba(255,255,255,.6)", textTransform: "capitalize", width: 60 }}>{t}</span>
              <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,.06)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${(c / vehicles.length) * 100}%`, height: "100%", background: TC[t], borderRadius: 3, opacity: .7 }} /></div>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,.4)", width: 30, textAlign: "right", ...M }}>{c}</span>
            </div>))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Active incidents</div>
        {incidents.map(inc => (<div key={inc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,.02)", borderRadius: 6, borderLeft: `3px solid ${SC[inc.severity]}`, marginBottom: 6 }}>
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 500 }}>{inc.type}</div><div style={{ fontSize: 11, color: "rgba(255,255,255,.35)", ...M }}>{inc.location}</div></div>
          <div style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: `${SC[inc.severity]}15`, color: SC[inc.severity], ...M }}>{inc.severity}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", ...M }}>{inc.time}</div>
        </div>))}
      </div>
    </div>
    <div style={{ marginTop: 20, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.04)", display: "flex", justifyContent: "space-between" }}>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,.15)", ...M }}>UrbanMove v1.0 · EPITA S25</span>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,.15)", ...M }}>{ws ? "WebSocket connected" : `Simulated · Tick #${tick}`}</span>
    </div>
  </div>);
}
