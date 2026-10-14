// API del historial (Netlify Blobs).
//   GET    /api/data?months=2          -> { entries: [...] }
//   GET    /api/data?what=settings     -> { settings: {...} | null }
//   GET    /api/data?what=version      -> { version }
//   POST   /api/data  { entry }        -> { entry }   (añade; si el id ya existe no duplica)
//   POST   /api/data  { update }       -> { entry }   (edita)
//   POST   /api/data  { settings }     -> { ok: true }
//   DELETE /api/data?id=...&ts=...     -> { ok: true }
import { randomUUID } from "node:crypto";
import { checkAuth, loadEntries, monthKey, preflight, reply, store } from "../lib/shared.mjs";

const TYPES = ["meal", "reading", "chart", "day", "basal"];
const CONTEXTS = ["ayunas", "pre_comida", "post2h", "pre_gym", "post_gym", "noche", "otro"];
const KINDS = ["comida", "cafe", "correccion"];
const ABSORB = ["rapida", "mixta", "lenta"];

const num = (v, min, max) => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : Math.min(max, Math.max(min, x));
};
const txt = (v, len) => String(v ?? "").slice(0, len);

function cleanEntry(e, id) {
  if (!e || !TYPES.includes(e.type)) return null;
  const out = {
    id: id ? txt(id, 64) : randomUUID(),
    ts: num(e.ts, 0, 4e12) ?? Date.now(),
    type: e.type,
    gym: !!e.gym,
    highCarb: !!e.highCarb,
    note: txt(e.note, 300),
  };
  if (e.type === "meal") {
    out.carbs = num(e.carbs, 0, 500) ?? 0; // sin comida = 0 g
    out.bg = num(e.bg, 20, 600);
    out.dose = num(e.dose, 0, 100); // dosis REAL que se pinchó la persona
    out.suggested = num(e.suggested, 0, 100); // dosis que propuso la app
    out.kind = KINDS.includes(e.kind) ? e.kind : "comida";
    out.absorb = ABSORB.includes(e.absorb) ? e.absorb : "mixta"; // velocidad de absorción de los hidratos
    if (out.dose === null) return null;
  }
  if (e.type === "basal") {
    out.units = num(e.units, 0, 200);
    if (out.units === null) return null;
  }
  if (e.type === "reading") {
    out.mgdl = num(e.mgdl, 20, 600);
    out.context = CONTEXTS.includes(e.context) ? e.context : "otro";
    // Insulina opcional en la misma lectura (un solo registro)
    const dose = num(e.dose, 0, 100);
    out.dose = dose > 0 ? dose : null;
    out.kind = out.dose ? (KINDS.includes(e.kind) ? e.kind : "correccion") : null;
    if (out.mgdl === null) return null;
  }
  if (e.type === "chart") {
    const s = e.summary || {};
    out.summary = {
      periodo: txt(s.periodo, 60),
      media_mgdl: num(s.media_mgdl, 20, 600),
      tir_pct: num(s.tir_pct, 0, 100),
      bajo_pct: num(s.bajo_pct, 0, 100),
      alto_pct: num(s.alto_pct, 0, 100),
      hipos: num(s.hipos, 0, 200),
      min_mgdl: num(s.min_mgdl, 20, 600),
      max_mgdl: num(s.max_mgdl, 20, 600),
      patrones: (Array.isArray(s.patrones) ? s.patrones : []).slice(0, 3).map((p) => txt(p, 160)),
    };
  }
  return out;
}

const detail = (r) =>
  `datos no válidos (tipo ${r?.type}, hidratos ${r?.carbs}, dosis ${r?.dose}, glucosa ${r?.mgdl}, unidades ${r?.units})`;

const SETTING_KEYS = ["icr", "isf", "target", "step", "maxDose", "gymAdj", "basal", "adaptOn", "adaptFrom"];

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (new URL(req.url).searchParams.get("what") === "version") return reply(200, { version: "v4-absorcion" });
  const bad = checkAuth(req);
  if (bad) return bad;

  const s = store();
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("what") === "settings") {
        const settings = await s.get("settings", { type: "json" });
        return reply(200, { settings: settings || null });
      }
      const months = Math.min(12, Math.max(1, parseInt(url.searchParams.get("months") || "2", 10) || 2));
      return reply(200, { entries: await loadEntries(months) });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      if (body.settings) {
        const clean = {};
        for (const k of SETTING_KEYS) clean[k] = txt(body.settings[k], 20);
        await s.setJSON("settings", clean);
        return reply(200, { ok: true });
      }

      if (body.update) {
        const { id, oldTs, entry: raw } = body.update;
        const old = Number(oldTs);
        if (!id || !Number.isFinite(old)) return reply(400, { error: "Edición: falta el id o la fecha original" });
        const entry = cleanEntry(raw, id);
        if (!entry) return reply(400, { error: "Edición: " + detail(raw) });
        const oldKey = `entries/${monthKey(old)}`, newKey = `entries/${monthKey(entry.ts)}`;
        const oldList = (await s.get(oldKey, { type: "json" })) || [];
        if (!oldList.some((x) => x.id === entry.id)) return reply(404, { error: "No se encontró el registro" });
        if (oldKey === newKey) {
          await s.setJSON(oldKey, oldList.map((x) => (x.id === entry.id ? entry : x)));
        } else {
          await s.setJSON(oldKey, oldList.filter((x) => x.id !== entry.id));
          const newList = (await s.get(newKey, { type: "json" })) || [];
          newList.push(entry);
          await s.setJSON(newKey, newList);
        }
        return reply(200, { entry });
      }

      const entry = cleanEntry(body.entry, body.entry?.id);
      if (!entry) return reply(400, { error: "Registro no válido: " + detail(body.entry) });
      const key = `entries/${monthKey(entry.ts)}`;
      const list = (await s.get(key, { type: "json" })) || [];
      if (list.some((x) => x.id === entry.id)) return reply(200, { entry }); // ya existía: no duplicar
      list.push(entry);
      await s.setJSON(key, list);
      return reply(200, { entry });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const ts = Number(url.searchParams.get("ts"));
      if (!id || !Number.isFinite(ts)) return reply(400, { error: "Faltan datos" });
      const key = `entries/${monthKey(ts)}`;
      const list = (await s.get(key, { type: "json" })) || [];
      await s.setJSON(key, list.filter((e) => e.id !== id));
      return reply(200, { ok: true });
    }

    return reply(405, { error: "Método no permitido" });
  } catch (err) {
    console.error(err);
    return reply(500, { error: "Error al acceder a la base de datos" });
  }
};

export const config = { path: "/api/data" };