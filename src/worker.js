import Anthropic from "@anthropic-ai/sdk";

const MODELE = "claude-opus-5-5";
const MAX_REPRISES = 6;

const SYSTEME = `Tu es l'assistant personnel d'Oussama Diallo. Tu réponds en français, simplement et directement.
Tu peux chercher sur internet, lire des pages web, analyser des données, faire des calculs et écrire du code, des textes, des plans, des messages ou des tableaux.
Quand une information peut avoir changé (prix, actualités, taux de change, lois), cherche sur le web avant de répondre et cite tes sources.
Si l'utilisateur joint son carnet de dettes, utilise-le pour répondre : les montants sont en francs guinéens (GNF) ou en dollars (USD), à ne jamais additionner sans conversion explicite.
Tu n'as pas d'autre accès que la recherche web et la lecture de pages : ne prétends jamais avoir envoyé un message, fait un paiement ou modifié un fichier. Pour ces actions, explique comment les faire.`;

const OUTILS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function egaux(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

function messagesValides(liste) {
  if (!Array.isArray(liste) || liste.length === 0 || liste.length > 60) return null;
  const out = [];
  for (const m of liste) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) return null;
    out.push({ role: m.role, content: m.content.slice(0, 100000) });
  }
  return out[out.length - 1].role === "user" ? out : null;
}

async function discussion(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ erreur: "ANTHROPIC_API_KEY n'est pas configurée sur le serveur." }, 500);
  if (!env.MOT_DE_PASSE) return json({ erreur: "MOT_DE_PASSE n'est pas configuré sur le serveur." }, 500);
  if (!egaux(request.headers.get("x-mot-de-passe") || "", env.MOT_DE_PASSE)) return json({ erreur: "Mot de passe incorrect." }, 401);

  let corps;
  try { corps = await request.json(); } catch { return json({ erreur: "Requête invalide." }, 400); }
  const messages = messagesValides(corps.messages);
  if (!messages) return json({ erreur: "Messages invalides." }, 400);

  let systeme = SYSTEME;
  if (typeof corps.carnet === "string" && corps.carnet) {
    systeme += `\n\nCarnet de dettes actuel d'Oussama (JSON) :\n${corps.carnet.slice(0, 200000)}`;
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const envoyer = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

  (async () => {
    try {
      const historique = [...messages];
      for (let tour = 0; tour < MAX_REPRISES; tour++) {
        const flux = client.beta.messages.stream({
          model: MODELE,
          max_tokens: 32000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          system: systeme,
          tools: OUTILS,
          messages: historique,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
        for await (const ev of flux) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            await envoyer({ texte: ev.delta.text });
          } else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
            await envoyer({ outil: ev.content_block.name });
          }
        }
        const final = await flux.finalMessage();
        if (final.stop_reason === "refusal") {
          await envoyer({ texte: "\n\n(Cette demande a été refusée par les protections de sécurité.)" });
          break;
        }
        if (final.stop_reason === "pause_turn") {
          historique.push({ role: "assistant", content: final.content });
          continue;
        }
        if (final.stop_reason === "max_tokens") await envoyer({ texte: "\n\n(Réponse coupée : demandez-moi de continuer.)" });
        break;
      }
      await envoyer({ fin: true });
    } catch (err) {
      await envoyer({ erreur: err?.message || "Erreur inattendue." });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/chat") {
      if (request.method !== "POST") return json({ erreur: "Méthode non autorisée." }, 405);
      return discussion(request, env);
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Introuvable", { status: 404 });
  },
};
