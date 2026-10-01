// LA FAMILLE BEST — API de la caisse (Cloudflare Workers + base D1).
// Règles : aucune opération n'est jamais supprimée (annulation motivée + journal d'audit),
// les exercices passés sont clôturés automatiquement et deviennent immuables.

export const FEE = 10000;
export const START = "2026-10";
export const START_DATE = "2026-10-01";
const ROLES = ["admin", "tresorier", "consultation"];
const METHODS = ["Espèces", "Orange Money", "Virement", "Chèque", "Autre"];
const SESSION_H = 12;
const PBKDF2_ITER = 100000; // maximum autorisé par Workers

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, last_name TEXT NOT NULL, first_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', joined TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, left_month TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('cotisation','recette','depense')), member_id INTEGER, month TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL CHECK (amount > 0), method TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', person TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL, user_name TEXT NOT NULL, void_ts TEXT, void_by TEXT, void_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_op_date ON operations(date)`,
  `CREATE INDEX IF NOT EXISTS ix_op_member ON operations(member_id, month)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_name TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS closings (year INTEGER PRIMARY KEY, closed_at TEXT NOT NULL, opening INTEGER NOT NULL, contrib INTEGER NOT NULL, income INTEGER NOT NULL, expense INTEGER NOT NULL, closing INTEGER NOT NULL, snapshot TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, data TEXT NOT NULL)`,
];
let schemaReady = null;
const ensureSchema = (db) => (schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { schemaReady = null; throw e; }));

/* ---------- utilitaires ---------- */
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const enc = new TextEncoder();
const b64 = (u) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const nowIso = () => new Date().toISOString();
const todayStr = () => nowIso().slice(0, 10);
const ymOf = (d) => d.slice(0, 7);
const yearOf = (d) => +d.slice(0, 4);
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const monthsRange = (a, b) => { const out = []; let [y, m] = a.split("-").map(Number); const [y2, m2] = b.split("-").map(Number); while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } } return out; };

async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, k, 256)));
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

async function secret(db) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='secret'`).first();
  if (r) return r.value;
  const v = b64(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('secret',?)`).bind(v).run();
  return (await db.prepare(`SELECT value FROM settings WHERE key='secret'`).first()).value;
}
const hmacKey = async (s) => crypto.subtle.importKey("raw", enc.encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
async function makeToken(db, user) {
  const p = b64(enc.encode(JSON.stringify({ u: user.id, pv: user.hash.slice(0, 8), exp: Date.now() + SESSION_H * 3600e3 })));
  const sig = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(await secret(db)), enc.encode(p))));
  return `${p}.${sig}`;
}
async function authUser(db, request) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [p, sig] = t.split(".");
  if (!p || !sig) bad("Connexion requise.", 401);
  const good = b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(await secret(db)), enc.encode(p))));
  if (!safeEq(sig, good)) bad("Session invalide.", 401);
  let d; try { d = JSON.parse(new TextDecoder().decode(unb64(p))); } catch { bad("Session invalide.", 401); }
  if (d.exp < Date.now()) bad("Session expirée, reconnectez-vous.", 401);
  const u = await db.prepare(`SELECT * FROM users WHERE id=? AND active=1`).bind(d.u).first();
  if (!u || u.hash.slice(0, 8) !== d.pv) bad("Session invalide.", 401);
  return u;
}
const need = (u, ...roles) => { if (!roles.includes(u.role)) bad("Action non autorisée pour votre profil.", 403); };
const pubUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active });
const audit = (db, u, action, ref = "", detail = "") => db.prepare(`INSERT INTO audit(ts,user_name,role,action,ref,detail) VALUES(?,?,?,?,?,?)`).bind(nowIso(), u.name, u.role, action, ref, detail.slice(0, 1000));
async function nextN(db, key) {
  const r = await db.prepare(`INSERT INTO counters(key,n) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET n=n+1 RETURNING n`).bind(key).first();
  return r.n;
}

/* ---------- calculs métier (utilisés pour la clôture annuelle) ---------- */
function dueMonths(m, upTo) {
  const a = m.joined > START ? m.joined : START;
  const end = m.left_month && m.left_month < upTo ? m.left_month : upTo;
  return a <= end ? monthsRange(a, end) : [];
}
function yearTotals(ops, y) {
  const live = ops.filter((o) => !o.void_ts);
  let opening = 0, contrib = 0, income = 0, expense = 0;
  for (const o of live) {
    const oy = yearOf(o.date), s = o.kind === "depense" ? -o.amount : o.amount;
    if (oy < y) opening += s;
    else if (oy === y) { if (o.kind === "cotisation") contrib += o.amount; else if (o.kind === "recette") income += o.amount; else expense += o.amount; }
  }
  return { opening, contrib, income, expense, closing: opening + contrib + income - expense };
}
// Clôture automatique : tout exercice terminé est figé. Le solde de clôture est le solde d'ouverture suivant
// (il est calculé comme cumul antérieur, jamais recompté comme recette).
async function ensureClosings(db) {
  const cy = yearOf(todayStr());
  const have = new Set((await db.prepare(`SELECT year FROM closings`).all()).results.map((r) => r.year));
  let ops = null, members = null;
  for (let y = 2026; y < cy; y++) {
    if (have.has(y)) continue;
    ops ??= (await db.prepare(`SELECT * FROM operations`).all()).results;
    members ??= (await db.prepare(`SELECT * FROM members`).all()).results;
    const t = yearTotals(ops, y), cut = `${y}-12`;
    const live = ops.filter((o) => !o.void_ts && o.kind === "cotisation");
    const byMember = members.map((m) => {
      let debt = 0;
      for (const mo of dueMonths(m, cut)) debt += Math.max(0, FEE - live.filter((o) => o.member_id === m.id && o.month === mo && yearOf(o.date) <= y).reduce((s, o) => s + o.amount, 0));
      return { number: m.number, name: `${m.first_name} ${m.last_name}`, paid: live.filter((o) => o.member_id === m.id && yearOf(o.date) === y).reduce((s, o) => s + o.amount, 0), debt };
    });
    const snap = JSON.stringify({ members: members.length, byMember, debts: byMember.reduce((s, x) => s + x.debt, 0), ops: ops.filter((o) => yearOf(o.date) === y).length });
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO closings(year,closed_at,opening,contrib,income,expense,closing,snapshot) VALUES(?,?,?,?,?,?,?,?)`).bind(y, nowIso(), t.opening, t.contrib, t.income, t.expense, t.closing, snap),
      db.prepare(`INSERT INTO audit(ts,user_name,role,action,ref,detail) VALUES(?,?,?,?,?,?)`).bind(nowIso(), "Système", "système", "CLÔTURE", String(y), `Exercice ${y} clôturé automatiquement. Solde de clôture ${t.closing} GNF reporté comme solde d'ouverture ${y + 1}.`),
    ]);
  }
}
const lastClosed = async (db) => (await db.prepare(`SELECT MAX(year) y FROM closings`).first())?.y || 0;
async function assertOpenYear(db, date) {
  if (yearOf(date) <= (await lastClosed(db))) bad(`L'exercice ${yearOf(date)} est clôturé : il ne peut plus être modifié. Passez l'écriture de correction dans l'année en cours.`, 409);
}
function checkDate(date) {
  if (!isDate(date)) bad("Date invalide.");
  if (date < START_DATE) bad("Aucune opération avant le 1er octobre 2026.");
  if (date > todayStr()) bad("La date ne peut pas être dans le futur.");
}
async function memberBalanceFor(db, memberId, month) {
  const r = await db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM operations WHERE kind='cotisation' AND member_id=? AND month=? AND void_ts IS NULL`).bind(memberId, month).first();
  return r.s;
}

/* ---------- sauvegarde ---------- */
const TABLES = ["settings", "counters", "users", "members", "operations", "audit", "closings"];
async function dump(db) {
  const out = { app: "LA FAMILLE BEST", version: 1, ts: nowIso() };
  for (const t of TABLES) out[t] = (await db.prepare(t === "settings" ? `SELECT * FROM settings WHERE key<>'secret'` : `SELECT * FROM ${t}`).all()).results;
  return out;
}
export async function scheduledBackup(env) {
  await ensureSchema(env.DB);
  const d = await dump(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO backups(ts,data) VALUES(?,?)`).bind(nowIso(), JSON.stringify(d)),
    env.DB.prepare(`DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 20)`),
  ]);
}

/* ---------- routes ---------- */
export async function handle(request, env) {
  if (!env.DB) return json({ error: "La base de données D1 (binding « DB ») n'est pas configurée." }, 500);
  const db = env.DB, url = new URL(request.url), path = url.pathname.replace(/^\/api\/c\/?/, "").replace(/\/$/, ""), method = request.method;
  try {
    await ensureSchema(db);
    const body = method === "GET" ? {} : await request.json().catch(() => bad("Requête invalide."));

    if (path === "status" && method === "GET") return json({ setup: !(await db.prepare(`SELECT 1 FROM users LIMIT 1`).first()) });

    if (path === "setup" && method === "POST") {
      const username = str(body.username, 40).toLowerCase(), name = str(body.name, 80), pw = str(body.password, 200);
      if (!username || !name || pw.length < 8) bad("Nom, identifiant et mot de passe (8 caractères minimum) requis.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const r = await db.prepare(`INSERT INTO users(username,name,role,salt,hash,created_at) SELECT ?,?,'admin',?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)`).bind(username, name, b64(salt), await hashPw(pw, salt), nowIso()).run();
      if (!r.meta.changes) bad("La caisse est déjà initialisée.", 409);
      await audit(db, { name, role: "admin" }, "CRÉATION CAISSE", "", "Premier administrateur créé").run();
      return json({ ok: true });
    }

    if (path === "login" && method === "POST") {
      const u = await db.prepare(`SELECT * FROM users WHERE username=? AND active=1`).bind(str(body.username, 40).toLowerCase()).first();
      if (u && u.locked_until > Date.now()) bad(`Compte verrouillé temporairement. Réessayez dans ${Math.ceil((u.locked_until - Date.now()) / 60000)} min.`, 429);
      const ok = u && safeEq(await hashPw(str(body.password, 200), unb64(u.salt)), u.hash);
      if (!ok) {
        if (u) { const f = u.fails + 1; await db.prepare(`UPDATE users SET fails=?, locked_until=? WHERE id=?`).bind(f >= 5 ? 0 : f, f >= 5 ? Date.now() + 10 * 60000 : 0, u.id).run(); await audit(db, u, "ÉCHEC CONNEXION", "", `Tentative ${f}`).run(); }
        bad("Identifiant ou mot de passe incorrect.", 401);
      }
      await db.prepare(`UPDATE users SET fails=0, locked_until=0 WHERE id=?`).bind(u.id).run();
      await audit(db, u, "CONNEXION").run();
      await ensureClosings(db);
      return json({ token: await makeToken(db, u), user: pubUser(u) });
    }

    // Consultation publique : sans connexion, lecture seule (sans téléphones). Toute écriture exige une connexion.
    if (path === "state" && method === "GET") {
      const me = request.headers.get("authorization") ? await authUser(db, request) : { id: 0, username: "", name: "Visiteur", role: "public", active: 1 };
      await ensureClosings(db);
      const members = (await db.prepare(`SELECT * FROM members ORDER BY number`).all()).results;
      const ops = (await db.prepare(`SELECT * FROM operations ORDER BY id`).all()).results;
      const closings = (await db.prepare(`SELECT * FROM closings ORDER BY year`).all()).results.map((c) => ({ ...c, snapshot: JSON.parse(c.snapshot) }));
      if (me.role !== "admin" && me.role !== "tresorier") members.forEach((m) => (m.phone = ""));
      return json({ user: pubUser(me), fee: FEE, start: START, today: todayStr(), methods: METHODS, members, ops, closings });
    }

    const me = await authUser(db, request);

    if (path === "password" && method === "POST") {
      if (!safeEq(await hashPw(str(body.current, 200), unb64(me.salt)), me.hash)) bad("Mot de passe actuel incorrect.", 403);
      const pw = str(body.password, 200); if (pw.length < 8) bad("8 caractères minimum.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await db.batch([db.prepare(`UPDATE users SET salt=?, hash=? WHERE id=?`).bind(b64(salt), await hashPw(pw, salt), me.id), audit(db, me, "MOT DE PASSE", "", "Mot de passe modifié")]);
      const nu = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(me.id).first();
      return json({ token: await makeToken(db, nu) });
    }

    /* membres */
    if (path === "members" && method === "POST") {
      need(me, "admin", "tresorier");
      const last = str(body.last_name, 60), first = str(body.first_name, 60), joined = str(body.joined, 7);
      if (!last || !first || !isMonth(joined)) bad("Nom, prénom et mois d'adhésion requis.");
      const number = "FB-" + String(await nextN(db, "member")).padStart(4, "0");
      await db.batch([
        db.prepare(`INSERT INTO members(number,last_name,first_name,phone,joined,created_at) VALUES(?,?,?,?,?,?)`).bind(number, last, first, str(body.phone, 30), joined < START ? START : joined, nowIso()),
        audit(db, me, "MEMBRE AJOUTÉ", number, `${first} ${last}`),
      ]);
      return json({ ok: true, number });
    }
    let m = path.match(/^members\/(\d+)$/);
    if (m && method === "PUT") {
      need(me, "admin", "tresorier");
      const old = await db.prepare(`SELECT * FROM members WHERE id=?`).bind(+m[1]).first(); if (!old) bad("Membre introuvable.", 404);
      const last = str(body.last_name, 60), first = str(body.first_name, 60), joined = str(body.joined, 7);
      if (!last || !first || !isMonth(joined)) bad("Nom, prénom et mois d'adhésion requis.");
      const active = body.active ? 1 : 0, left = active ? "" : (isMonth(str(body.left_month, 7)) ? body.left_month : todayStr().slice(0, 7));
      await db.batch([
        db.prepare(`UPDATE members SET last_name=?, first_name=?, phone=?, joined=?, active=?, left_month=? WHERE id=?`).bind(last, first, str(body.phone, 30), joined < START ? START : joined, active, left, old.id),
        audit(db, me, active ? "MEMBRE MODIFIÉ" : "MEMBRE DÉSACTIVÉ", old.number, `${old.first_name} ${old.last_name} → ${first} ${last}, tél ${str(body.phone, 30)}, adhésion ${joined}${active ? "" : ", sorti " + left}`),
      ]);
      return json({ ok: true });
    }

    /* cotisations : plusieurs mois possibles en une fois (mois futurs = « en avance ») */
    if (path === "cotisations" && method === "POST") {
      need(me, "admin", "tresorier");
      const mem = await db.prepare(`SELECT * FROM members WHERE id=?`).bind(+body.member_id).first(); if (!mem) bad("Membre introuvable.");
      const date = str(body.date, 10), method_ = METHODS.includes(body.method) ? body.method : "Espèces";
      checkDate(date); await assertOpenYear(db, date);
      if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 60) bad("Aucun mois à enregistrer.");
      const limit = `${yearOf(todayStr()) + 5}-12`, stmts = [], refs = [], seen = new Set();
      for (const l of body.lines) {
        const month = str(l.month, 7), a = Math.round(+l.amount);
        if (!isMonth(month) || month < START || month < mem.joined || month > limit) bad(`Mois invalide : ${month}.`);
        if (seen.has(month)) bad("Mois en double."); seen.add(month);
        if (!(a > 0)) bad("Montant invalide.");
        const already = await memberBalanceFor(db, mem.id, month);
        if (already + a > FEE) bad(`${month} : le total dépasserait ${FEE} GNF (déjà versé : ${already}).`);
        const ref = `COT-${yearOf(date)}-${String(await nextN(db, "ref" + yearOf(date))).padStart(6, "0")}`; refs.push(ref);
        stmts.push(db.prepare(`INSERT INTO operations(ref,ts,date,kind,member_id,month,amount,method,note,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(ref, nowIso(), date, "cotisation", mem.id, month, a, method_, str(body.note, 300), me.id, me.name));
        stmts.push(audit(db, me, "COTISATION", ref, `${mem.number} ${mem.first_name} ${mem.last_name} · ${month} · ${a} GNF · ${method_}`));
      }
      await db.batch(stmts);
      return json({ ok: true, refs });
    }

    /* recettes et dépenses */
    if (path === "ops" && method === "POST") {
      need(me, "admin", "tresorier");
      const kind = body.kind === "recette" ? "recette" : body.kind === "depense" ? "depense" : bad("Type invalide.");
      const date = str(body.date, 10), a = Math.round(+body.amount), label = str(body.label, 200);
      checkDate(date); await assertOpenYear(db, date);
      if (!(a > 0) || !label) bad("Motif et montant requis.");
      if (kind === "depense" && !str(body.person, 100)) bad("Indiquez la personne ayant effectué la dépense.");
      const ref = `${kind === "depense" ? "DEP" : "REC"}-${yearOf(date)}-${String(await nextN(db, "ref" + yearOf(date))).padStart(6, "0")}`;
      await db.batch([
        db.prepare(`INSERT INTO operations(ref,ts,date,kind,amount,method,label,person,receipt,note,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ref, nowIso(), date, kind, a, METHODS.includes(body.method) ? body.method : "Espèces", label, str(body.person, 100), str(body.receipt, 300), str(body.note, 500), me.id, me.name),
        audit(db, me, kind === "depense" ? "DÉPENSE" : "RECETTE", ref, `${label} · ${a} GNF`),
      ]);
      return json({ ok: true, ref });
    }
    m = path.match(/^ops\/(\d+)\/void$/);
    if (m && method === "POST") {
      need(me, "admin", "tresorier");
      const o = await db.prepare(`SELECT * FROM operations WHERE id=?`).bind(+m[1]).first(); if (!o) bad("Opération introuvable.", 404);
      if (o.void_ts) bad("Opération déjà annulée.", 409);
      const reason = str(body.reason, 300); if (reason.length < 5) bad("Un motif d'annulation (5 caractères minimum) est obligatoire.");
      await assertOpenYear(db, o.date);
      await db.batch([
        db.prepare(`UPDATE operations SET void_ts=?, void_by=?, void_reason=? WHERE id=? AND void_ts IS NULL`).bind(nowIso(), me.name, reason, o.id),
        audit(db, me, "ANNULATION", o.ref, `${o.kind} ${o.amount} GNF du ${o.date} annulée. Motif : ${reason}`),
      ]);
      return json({ ok: true });
    }

    /* administration */
    if (path === "audit" && method === "GET") { need(me, "admin", "tresorier"); return json({ audit: (await db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT 500`).all()).results }); }
    if (path === "users" && method === "GET") { need(me, "admin"); return json({ users: (await db.prepare(`SELECT * FROM users ORDER BY id`).all()).results.map(pubUser) }); }
    if (path === "users" && method === "POST") {
      need(me, "admin");
      const username = str(body.username, 40).toLowerCase(), name = str(body.name, 80), pw = str(body.password, 200);
      if (!username || !name || pw.length < 8 || !ROLES.includes(body.role)) bad("Identifiant, nom, rôle et mot de passe (8 caractères minimum) requis.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      try { await db.batch([db.prepare(`INSERT INTO users(username,name,role,salt,hash,created_at) VALUES(?,?,?,?,?,?)`).bind(username, name, body.role, b64(salt), await hashPw(pw, salt), nowIso()), audit(db, me, "UTILISATEUR AJOUTÉ", username, `${name} (${body.role})`)]); }
      catch { bad("Cet identifiant existe déjà.", 409); }
      return json({ ok: true });
    }
    m = path.match(/^users\/(\d+)$/);
    if (m && method === "PUT") {
      need(me, "admin");
      const u = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(+m[1]).first(); if (!u) bad("Utilisateur introuvable.", 404);
      const role = ROLES.includes(body.role) ? body.role : u.role, active = body.active ? 1 : 0;
      if (u.id === me.id && (role !== "admin" || !active)) bad("Vous ne pouvez pas retirer vos propres droits d'administrateur.");
      const stmts = [db.prepare(`UPDATE users SET role=?, active=?, name=? WHERE id=?`).bind(role, active, str(body.name, 80) || u.name, u.id)];
      if (str(body.password, 200)) { if (body.password.length < 8) bad("8 caractères minimum."); const salt = crypto.getRandomValues(new Uint8Array(16)); stmts.push(db.prepare(`UPDATE users SET salt=?, hash=?, fails=0, locked_until=0 WHERE id=?`).bind(b64(salt), await hashPw(body.password, salt), u.id)); }
      stmts.push(audit(db, me, "UTILISATEUR MODIFIÉ", u.username, `rôle ${role}, ${active ? "actif" : "désactivé"}${body.password ? ", mot de passe réinitialisé" : ""}`));
      await db.batch(stmts);
      return json({ ok: true });
    }

    if (path === "backup" && method === "GET") { need(me, "admin"); await audit(db, me, "SAUVEGARDE", "", "Téléchargement").run(); return json(await dump(db)); }
    if (path === "snapshot" && method === "POST") { need(me, "admin"); await scheduledBackup(env); await audit(db, me, "SAUVEGARDE", "", "Instantané interne").run(); return json({ ok: true }); }
    if (path === "restore" && method === "POST") {
      need(me, "admin");
      if (body.app !== "LA FAMILLE BEST" || !Array.isArray(body.operations) || !Array.isArray(body.members) || !Array.isArray(body.users) || !body.users.some((u) => u.role === "admin" && u.active)) bad("Fichier de sauvegarde invalide.");
      await scheduledBackup(env); // filet de sécurité avant remplacement
      const stmts = TABLES.map((t) => db.prepare(t === "settings" ? `DELETE FROM settings WHERE key<>'secret'` : `DELETE FROM ${t}`));
      for (const t of TABLES) for (const row of body[t] || []) {
        if (t === "settings" && row.key === "secret") continue;
        const cols = Object.keys(row); if (!cols.every((c) => /^\w+$/.test(c))) bad("Fichier de sauvegarde invalide.");
        stmts.push(db.prepare(`INSERT INTO ${t}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])));
      }
      stmts.push(audit(db, me, "RESTAURATION", "", `Données restaurées depuis une sauvegarde du ${body.ts}`));
      await db.batch(stmts);
      return json({ ok: true });
    }
    return json({ error: "Introuvable." }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Erreur serveur : " + (e?.message || e) }, 500);
  }
}
