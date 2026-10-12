// Utilidades compartidas por las funciones de Netlify.
// Variables de entorno: APP_PASSWORD, GEMINI_API_KEY (obligatorias); GEMINI_MODEL, ALLOWED_ORIGIN (opcionales).
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

// ---------- Respuestas y CORS ----------
function corsHeaders() {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Content-Type, x-app-key";
    h["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  return h;
}

export const reply = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders() });

// Responde a las peticiones OPTIONS; si no es OPTIONS devuelve null.
export const preflight = (req) =>
  req.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders() }) : null;

// ---------- Acceso con clave ----------
// Devuelve una respuesta de error si la clave no es correcta; si lo es, devuelve null.
export function checkAuth(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return reply(500, { error: "Falta APP_PASSWORD en Netlify" });
  const given = req.headers.get("x-app-key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? null : reply(401, { error: "Clave incorrecta" });
}

// ---------- Base de datos (Netlify Blobs) ----------
export const store = () => getStore("glucoplan");

// Clave de mes en formato AAAA-MM (UTC).
export const monthKey = (ts) => {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Registros de los últimos N meses, del más reciente al más antiguo.
export async function loadEntries(months = 2) {
  const s = store();
  const now = new Date();
  const keys = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`entries/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const lists = await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)));
  return lists
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .sort((a, b) => b.ts - a.ts);
}

// ---------- Gemini con reintentos y modelos de respaldo ----------
// Se prueba primero GEMINI_MODEL (si existe) y después estos modelos.
// Si un modelo da 404 (retirado o mal escrito), se pasa al siguiente.
const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEADLINE_MS = 9000; // Netlify corta las funciones a los ~10 s por defecto
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// askGemini({ system, parts })  o  askGemini({ system, text })  ->  objeto JSON
export async function askGemini({ system, parts, text }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Falta GEMINI_API_KEY en Netlify"), { status: 500 });

  const userParts = parts || [{ text: String(text ?? "") }];
  const models = [...new Set([process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: userParts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });

  const t0 = Date.now();
  let lastStatus = 0;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = DEADLINE_MS - (Date.now() - t0);
      if (left < 1500) break;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(left, 6500));
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body,
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
          const clean = out.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
          try {
            return JSON.parse(clean);
          } catch {
            lastStatus = 502; // respuesta que no es JSON: se trata como fallo temporal
          }
        } else {
          lastStatus = res.status;
          if (res.status === 404) break; // modelo retirado o mal escrito: probar el siguiente
          if (!RETRYABLE.has(res.status)) {
            const raw = await res.text().catch(() => "");
            let msg = raw.slice(0, 200);
            try { msg = JSON.parse(raw).error?.message || msg; } catch {}
            console.error("Gemini", model, res.status, raw.slice(0, 500));
            throw Object.assign(new Error(`Gemini devolvió un error (${res.status}): ${msg.slice(0, 160)}`), { status: 502 });
           }
        }
      } catch (err) {
        clearTimeout(timer);
        if (err.status) throw err;
        lastStatus = lastStatus || 504; // tiempo agotado o fallo de red
      }
      await sleep(500 * (attempt + 1));
    }
  }
  throw Object.assign(
    new Error(`Gemini no está disponible ahora mismo (${lastStatus || 503}). Inténtalo de nuevo en un minuto`),
    { status: 503 }
  );
}