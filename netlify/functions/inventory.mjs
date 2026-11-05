// Trindco Tool Crib — shared live inventory + user logins, stored in Netlify Blobs.
//
//   POST /api/setup      first admin account (only works while there are no users)
//   POST /api/login      {username, password} -> {token, user}
//   GET  /api/me         who am I / does the shop still need setup
//   GET/POST/DELETE /api/users   manage users (admins only)
//   GET/POST /api/inventory      read / merge the shared inventory (signed-in users)
//
// Roles: admin = everything. operator = allocate, return, move, receive, scrap, add tools;
// the server ignores operator changes to cabinets/machines, existing products and settings.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const KEY = "state";
const COLS = ["locations", "products", "units", "orders"];
const MAX_LOG = 3000;
const TOKEN_DAYS = 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const store = () => getStore({ name: "tool-crib", consistency: "strong" });

/* ---------- inventory merge: newest edit (_t) wins per record, deletions are tombstones, history is appended ---------- */
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
  const cutoff = Date.now() - 60 * 864e5;
  for (const k of Object.keys(del)) if (del[k] < cutoff) delete del[k];
  out.deleted = del;
  return out;
}

// Operators can't change setup: drop their edits to cabinets/machines, existing products and settings
export function restrictOperator(incoming, base) {
  const out = { ...incoming };
  delete out.settings;
  out.locations = [];
  const baseProducts = new Set(((base && base.products) || []).map(p => p.id));
  out.products = (incoming.products || []).filter(p => !baseProducts.has(p.id));
  const protectedIds = new Set([...((base && base.locations) || []).map(l => l.id), ...baseProducts]);
  out.deleted = Object.fromEntries(Object.entries(incoming.deleted || {}).filter(([id]) => !protectedIds.has(id)));
  return out;
}

/* ---------- users, passwords, tokens ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false });
const norm = s => String(s || "").trim().toLowerCase();

async function getSecret(st) {
  let s = await st.get("secret");
  if (!s) {
    const fresh = crypto.randomBytes(32).toString("hex");
    const r = await st.set("secret", fresh, { onlyIfNew: true });
    s = r && r.modified === false ? await st.get("secret") : fresh;
  }
  return s;
}
const loadUsers = async st => (await st.get("users", { type: "json" })) || { list: [] };
const saveUsers = (st, u) => st.setJSON("users", u);

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + crypto.createHmac("sha256", secret).update(body).digest("base64url");
}
function readToken(tok, secret) {
  const [body, sig] = String(tok || "").split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
async function issue(st, u) {
  return signToken({ uid: u.id, v: u.ver || 0, exp: Date.now() + TOKEN_DAYS * 864e5 }, await getSecret(st));
}
async function currentUser(req, st) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const p = readToken(tok, await getSecret(st));
  if (!p) return null;
  const u = (await loadUsers(st)).list.find(x => x.id === p.uid);
  return u && u.active !== false && (u.ver || 0) === p.v ? u : null;
}
function newUser({ name, username, password, role }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { id: crypto.randomUUID(), name: String(name).trim(), username: norm(username), role: role === "admin" ? "admin" : "operator",
    salt, hash: hashPw(password, salt), active: true, ver: 0, created: new Date().toISOString() };
}
const checkNew = (b, needPw = true) =>
  !String(b.name || "").trim() ? "Name is required" :
  !/^[a-z0-9._-]{2,30}$/.test(norm(b.username)) ? "Username: 2–30 letters, numbers, . _ -" :
  needPw && String(b.password || "").length < 4 ? "Password must be at least 4 characters" : "";

/* ---------- routes ---------- */
export default async (req) => {
  const st = store();
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  if (path === "/api/me") {
    const users = await loadUsers(st);
    if (!users.list.length) return json({ needsSetup: true });
    const u = await currentUser(req, st);
    return u ? json({ user: publicUser(u) }) : json({ error: "login" }, 401);
  }

  if (path === "/api/setup" && req.method === "POST") {
    const users = await loadUsers(st);
    if (users.list.length) return json({ error: "Already set up — please sign in" }, 403);
    const b = await body(); const err = checkNew(b); if (err) return json({ error: err }, 400);
    const u = newUser({ ...b, role: "admin" });
    users.list.push(u); await saveUsers(st, users);
    return json({ token: await issue(st, u), user: publicUser(u) });
  }

  if (path === "/api/login" && req.method === "POST") {
    const b = await body();
    const u = (await loadUsers(st)).list.find(x => x.username === norm(b.username) && x.active !== false);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(b.password || "", u.salt), "hex"), Buffer.from(u.hash, "hex"));
    if (!ok) { await new Promise(r => setTimeout(r, 500)); return json({ error: "Wrong username or password" }, 401); }
    return json({ token: await issue(st, u), user: publicUser(u) });
  }

  // everything below needs a signed-in user
  const me = await currentUser(req, st);
  if (!me) return json({ error: "login" }, 401);

  if (path === "/api/users") {
    if (me.role !== "admin") return json({ error: "Admins only" }, 403);
    const users = await loadUsers(st);
    if (req.method === "GET") return json({ users: users.list.map(publicUser) });
    if (req.method === "POST") {
      const b = await body();
      const existing = b.id && users.list.find(x => x.id === b.id);
      const err = checkNew(b, !existing || !!b.password); if (err) return json({ error: err }, 400);
      if (users.list.some(x => x.username === norm(b.username) && x.id !== b.id)) return json({ error: "That username is taken" }, 400);
      if (!existing) { const u = newUser(b); users.list.push(u); await saveUsers(st, users); return json({ user: publicUser(u) }); }
      const admins = users.list.filter(x => x.role === "admin" && x.active !== false);
      const demoting = existing.role === "admin" && (b.role !== "admin" || b.active === false);
      if (demoting && admins.length <= 1) return json({ error: "You need at least one active admin" }, 400);
      existing.name = String(b.name).trim(); existing.username = norm(b.username);
      existing.role = b.role === "admin" ? "admin" : "operator";
      const wasActive = existing.active !== false; existing.active = b.active !== false;
      if (b.password) { existing.salt = crypto.randomBytes(16).toString("hex"); existing.hash = hashPw(b.password, existing.salt); }
      if (b.password || (wasActive && !existing.active) || demoting) existing.ver = (existing.ver || 0) + 1; // signs them out everywhere
      await saveUsers(st, users);
      return json({ user: publicUser(existing) });
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url).searchParams.get("id");
      if (id === me.id) return json({ error: "You can't delete yourself" }, 400);
      const u = users.list.find(x => x.id === id); if (!u) return json({ error: "Not found" }, 404);
      if (u.role === "admin" && users.list.filter(x => x.role === "admin" && x.active !== false).length <= 1) return json({ error: "You need at least one active admin" }, 400);
      users.list = users.list.filter(x => x.id !== id); await saveUsers(st, users);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (path === "/api/inventory") {
    if (req.method === "GET") {
      const since = Number(new URL(req.url).searchParams.get("rev") || -1);
      const meta = await st.getMetadata(KEY);
      if (meta && Number(meta.metadata?.rev) === since) return json({ same: true, rev: since });
      return json((await st.get(KEY, { type: "json" })) || null);
    }
    if (req.method === "POST") {
      const raw = await body();
      for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await st.getWithMetadata(KEY, { type: "json" });
        const base = cur ? cur.data : null;
        let incoming = me.role === "admin" ? raw : restrictOperator(raw, base);
        // history entries are signed with the logged-in user's name
        const known = new Set(((base && base.log) || []).map(l => l.id));
        incoming = { ...incoming, log: (incoming.log || []).map(l => known.has(l.id) ? l : { ...l, user: me.name }) };
        const merged = mergeState(base, incoming);
        merged.rev = ((base && base.rev) || 0) + 1;
        const opts = { metadata: { rev: merged.rev }, ...(cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }) };
        const res = await st.setJSON(KEY, merged, opts);
        if (!res || res.modified !== false) return json(merged);
        await new Promise(r => setTimeout(r, 60 + Math.random() * 120));
      }
      return json({ error: "busy, try again" }, 503);
    }
  }
  return json({ error: "not found" }, 404);
};

export const config = { path: ["/api/inventory", "/api/login", "/api/setup", "/api/me", "/api/users"] };
