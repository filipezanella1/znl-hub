// ZNL Hub — porteiro com senha + armazenamento dos módulos no Cloudflare KV.
// Requer no projeto Pages:
//   - binding KV com o nome HUB_KV
//   - secret HUB_PASSWORD (a senha de acesso)

const COOKIE = "znl_session";
const SESSION_DAYS = 30;
const MAX_FAILS = 10;           // tentativas erradas por IP
const LOCK_SECONDS = 15 * 60;   // bloqueio após exceder

const DEFAULT_TOOLS = [
  { id: "painel-tce", name: "Painel TCE", url: "https://painel-tce.pages.dev",
    desc: "Painel de acompanhamento publicado no Cloudflare Pages.", tag: "dashboard", status: "on" },
  { id: "pr990", name: "Obra completa PR990", url: "https://filipezanella1.github.io/PR990-Obra-completa/",
    desc: "Acompanhamento da obra completa da PR-990.", tag: "dashboard", status: "on" },
  { id: "medicao-dro", name: "Medição → DRO", url: "medicao-dro.html",
    desc: "Roteiro mensal do DRO da obra 515: lê medição do DER, NF e CEQ e gera tudo pronto para colar.", tag: "app", status: "on" },
  { id: "pdf-studio", name: "PDF Studio", url: "pdf-studio.html",
    desc: "Juntar, organizar, dividir, remover e extrair páginas de PDFs, tudo no navegador.", tag: "utilitário", status: "on" },
  { id: "validacao-terceiros", name: "Validação de Terceiros", url: "validacao-terceiros.html",
    desc: "Confere a parte diária dos basculantes terceiros (21 a 20) contra o Painel TCE e aponta alertas: grave, médio e avaliar.", tag: "app", status: "on" },
  { id: "relatorio-fotografico", name: "Relatório Fotográfico", url: "relatorio-fotografico.html",
    desc: "Relatório fotográfico mensal da PR-990: fotos + descrições viram PPTX no padrão TCE, com avanço, linear e índice.", tag: "app", status: "on" },
  { id: "claude", name: "Claude", url: "https://claude.ai/new",
    desc: "Abre uma conversa com o Claude. No terminal: claude <seu pedido>.", tag: "assistente", status: "on" }
];

// Módulos padrão que já existiam antes deste controle (não são re-adicionados se você os removeu)
const LEGACY_DEFAULT_IDS = ["painel-tce", "pr990", "medicao-dro", "pdf-studio", "claude"];
const ALL_DEFAULT_IDS = () => DEFAULT_TOOLS.map(t => t.id);
const normUrl = u => String(u || "").replace(/\/+$/, "").toLowerCase();

const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function readCookie(req, name) {
  const all = req.headers.get("cookie") || "";
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function isAuthed(req, env) {
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return safeEqual(sig, await hmac(env.HUB_PASSWORD, "session." + exp));
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function clean(list) {
  if (!Array.isArray(list) || list.length > 200) return null;
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== "object") return null;
    const url = str(t.url, 600);
    // link externo (https://…) ou página do próprio hub (ex.: pdf-studio.html); nada de javascript:
    if (!/^(https?:\/\/[^\s]+|[^\s:]+)$/i.test(url)) return null;
    const name = str(t.name, 60);
    if (!name) return null;
    out.push({
      id: str(t.id, 40) || "m" + Date.now() + out.length,
      name, url,
      desc: str(t.desc, 200),
      tag: str(t.tag, 30) || "app",
      status: t.status === "dev" ? "dev" : "on"
    });
  }
  return out;
}

function page(title, body, status = 200, headers = {}) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#050806;--panel:#08110b;--line:#163a22;--fg:#b8f5c8;--dim:#5f9a72;--phos:#3dff7a;--amber:#ffb347;--red:#ff5f5f;color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
  display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-left,0px)) 24px max(16px,env(safe-area-inset-right,0px))}
body::after{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,transparent 0 2px,rgba(0,0,0,.22) 2px 3px)}
.box{width:100%;max-width:420px;border:1px solid var(--line);background:var(--panel);padding:22px 20px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font:400 clamp(44px,12vw,64px)/.9 "VT323",monospace;color:var(--phos);text-shadow:0 0 12px rgba(61,255,122,.5)}
h1 span{color:var(--amber)}
p{margin:0;color:var(--dim);font-size:13px}
label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.row{display:flex;gap:8px}
input[type=password]{flex:1;min-width:0;background:#030604;border:1px solid var(--line);color:var(--fg);font:16px "IBM Plex Mono",monospace;padding:10px;caret-color:var(--phos)}
input[type=password]:focus{outline:none;border-color:var(--phos)}
button{background:none;border:1px solid var(--phos);color:var(--phos);font:14px "IBM Plex Mono",monospace;padding:0 16px;cursor:pointer}
button:hover,button:focus-visible{background:var(--phos);color:var(--bg);outline:none}
.err{color:var(--red)} .warn{color:var(--amber)}
.cur::after{content:"_";animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.cur::after{animation:none}}
</style></head><body><main class="box">${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function loginPage(msg = "", cls = "err", status = 200) {
  return page("ZNL Hub · acesso", `
<h1>ZNL<span>://</span>HUB</h1>
<p class="cur">&gt; acesso restrito. informe a senha</p>
<form method="post" action="/login" class="row" style="flex-direction:column;gap:6px">
  <input type="text" name="username" value="filipe" autocomplete="username" hidden>
  <label for="pw">senha</label>
  <div class="row">
    <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
    <button type="submit">entrar</button>
  </div>
</form>
${msg ? `<p class="${cls}">${msg}</p>` : `<p>A sessão fica salva por ${SESSION_DAYS} dias neste aparelho.</p>`}`, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!env.HUB_PASSWORD) {
      return page("ZNL Hub · configurar", `
<h1>ZNL<span>://</span>HUB</h1>
<p class="warn">&gt; senha ainda não configurada.</p>
<p>No Cloudflare, abra o projeto <b>znl-hub</b> → Settings → Variables and Secrets, crie o secret <b>HUB_PASSWORD</b> com a senha desejada e faça um novo deploy.</p>`, 503);
    }

    if (path === "/logout") {
      return new Response(null, { status: 303, headers: {
        location: "/login", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }

    if (path === "/login") {
      if (request.method === "GET") {
        if (await isAuthed(request, env)) return Response.redirect(url.origin + "/", 303);
        return loginPage();
      }
      if (request.method !== "POST") return new Response("Método não permitido", { status: 405 });

      const ip = request.headers.get("cf-connecting-ip") || "anon";
      const failKey = "fail:" + ip;
      const fails = env.HUB_KV ? Number(await env.HUB_KV.get(failKey)) || 0 : 0;
      if (fails >= MAX_FAILS) {
        return loginPage("Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.", "err", 429);
      }

      const form = await request.formData();
      const given = String(form.get("password") || "");
      const ok = safeEqual(await hmac(env.HUB_PASSWORD, "pw." + given),
                           await hmac(env.HUB_PASSWORD, "pw." + env.HUB_PASSWORD));
      if (!ok) {
        if (env.HUB_KV) await env.HUB_KV.put(failKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
        await new Promise(r => setTimeout(r, 700));
        const left = MAX_FAILS - fails - 1;
        return loginPage(`Senha incorreta.${left <= 3 ? ` Restam ${left} tentativa(s).` : ""}`, "err", 401);
      }
      if (env.HUB_KV && fails) await env.HUB_KV.delete(failKey);

      const exp = Date.now() + SESSION_DAYS * 864e5;
      const token = exp + "." + await hmac(env.HUB_PASSWORD, "session." + exp);
      return new Response(null, { status: 303, headers: {
        location: "/",
        "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
    }

    const authed = await isAuthed(request, env);

    if (path === "/api/tools") {
      if (!authed) return json({ error: "Faça login." }, 401);
      if (!env.HUB_KV) return json({ error: "Armazenamento HUB_KV não configurado." }, 500);
      if (request.method === "GET") {
        let saved = await env.HUB_KV.get("tools", "json");
        if (!Array.isArray(saved)) return json({ tools: DEFAULT_TOOLS });
        // acrescenta, uma única vez, módulos padrão novos que ainda não estão na lista salva
        const seen = (await env.HUB_KV.get("seen_defaults", "json")) || LEGACY_DEFAULT_IDS;
        const fresh = DEFAULT_TOOLS.filter(d => !seen.includes(d.id) &&
          !saved.some(t => t.id === d.id || normUrl(t.url) === normUrl(d.url)));
        if (fresh.length || seen.length !== ALL_DEFAULT_IDS().length) {
          if (fresh.length) {
            saved = saved.concat(fresh);
            await env.HUB_KV.put("tools", JSON.stringify(saved));
          }
          await env.HUB_KV.put("seen_defaults", JSON.stringify(ALL_DEFAULT_IDS()));
        }
        return json({ tools: saved });
      }
      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400); }
        const list = clean(body && body.tools);
        if (!list) return json({ error: "Lista de módulos inválida." }, 400);
        await env.HUB_KV.put("tools", JSON.stringify(list));
        await env.HUB_KV.put("seen_defaults", JSON.stringify(ALL_DEFAULT_IDS()));
        return json({ ok: true, count: list.length });
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (path === "/api/rf") {
      // histórico do Relatório Fotográfico: número e índice das fotos de cada relatório (sem imagens)
      if (!authed) return json({ error: "Faça login." }, 401);
      if (!env.HUB_KV) return json({ error: "Armazenamento HUB_KV não configurado." }, 500);
      const KEY = "rf:pr990";
      const hist = (await env.HUB_KV.get(KEY, "json")) || { relatorios: [] };
      if (request.method === "GET") return json(hist);
      if (request.method === "POST") {
        let r;
        try { r = await request.json(); } catch { return json({ error: "JSON inválido." }, 400); }
        const num = Number(r && r.num);
        if (!Number.isInteger(num) || num < 1 || num > 9999 || !Array.isArray(r.fotos) || r.fotos.length > 500) return json({ error: "Relatório inválido." }, 400);
        const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
        const rel = {
          num, mes: s(r.mes, 40), ym: s(r.ym, 7), em: new Date().toISOString(),
          fotos: r.fotos.map((f, i) => ({ n: i + 1, disc: s(f.disc, 40), desc: s(f.desc, 300),
            est: Number.isFinite(f.est) ? f.est : null, lado: s(f.lado, 4), data: s(f.data, 10) }))
        };
        hist.relatorios = hist.relatorios.filter(x => x.num !== num).concat(rel).sort((a, b) => a.num - b.num).slice(-60);
        await env.HUB_KV.put(KEY, JSON.stringify(hist));
        return json(hist);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (!authed) return Response.redirect(url.origin + "/login", 302);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "no-store");
    out.headers.set("x-robots-tag", "noindex");
    return out;
  }
};
