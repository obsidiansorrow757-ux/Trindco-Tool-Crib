// Trindco Tool Crib — shared live inventory, stored in Netlify Blobs.
// GET  /api/inventory?rev=N  -> full state, or {same:true} if nothing changed since rev N
// POST /api/inventory        -> merge the changes a device sends, return the merged state
// Optional: set SHOP_PIN in Netlify environment variables to require a PIN.
import { getStore } from "@netlify/blobs";

const KEY = "state";
const COLS = ["locations", "products", "units", "orders"];
const MAX_LOG = 3000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Same rules as the app: newest edit (_t) wins per record, deletions are tombstones, history is appended.
export function mergeState(a, b) {
  if (!a) return b; if (!b) return a;
  const out = { ...a };
  const del = { ...(a.deleted || {}) };
  for (const [k, v] of Object.entries(b.deleted || {})) if (!del[k] || v > del[k]) del[k] = v;
  for (const c of COLS) {
    const m = new Map();
    for (const r of [...(a[c] || []), ...(b[c] || [])]) { const e = m.get(r.id); if (!e || (r._t || 0) >= (e._t || 0)) m.set(r.id, r); }
    out[c] = [...m.values()].filter(r => !(del[r.id] && del[r.id] >= (r._t || 0)));
  }
  const lm = new Map(); for (const l of [...(a.log || []), ...(b.log || [])]) lm.set(l.id, l);
  out.log = [...lm.values()].sort((x, y) => (x.ts < y.ts ? 1 : -1)).slice(0, MAX_LOG);
  const sa = a.settings || {}, sb = b.settings || {};
  out.settings = (sb._t || 0) >= (sa._t || 0) && b.settings ? { ...sa, ...sb } : sa;
  // forget tombstones older than 60 days
  const cutoff = Date.now() - 60 * 864e5;
  for (const k of Object.keys(del)) if (del[k] < cutoff) delete del[k];
  out.deleted = del;
  return out;
}

export default async (req) => {
  const pin = process.env.SHOP_PIN;
  if (pin && req.headers.get("x-shop-pin") !== pin) return json({ error: "pin" }, 401);
  const store = getStore({ name: "tool-crib", consistency: "strong" });

  if (req.method === "GET") {
    const since = Number(new URL(req.url).searchParams.get("rev") || -1);
    const meta = await store.getMetadata(KEY);
    if (meta && Number(meta.metadata?.rev) === since) return json({ same: true, rev: since });
    return json((await store.get(KEY, { type: "json" })) || null);
  }

  if (req.method === "POST") {
    let incoming;
    try { incoming = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    for (let attempt = 0; attempt < 6; attempt++) {
      const cur = await store.getWithMetadata(KEY, { type: "json" });
      const base = cur ? cur.data : null;
      const merged = mergeState(base, incoming);
      merged.rev = ((base && base.rev) || 0) + 1;
      const opts = { metadata: { rev: merged.rev }, ...(cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }) };
      const res = await store.setJSON(KEY, merged, opts);
      if (!res || res.modified !== false) return json(merged);
      await new Promise(r => setTimeout(r, 60 + Math.random() * 120)); // someone else saved first: merge again
    }
    return json({ error: "busy, try again" }, 503);
  }
  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/inventory" };
