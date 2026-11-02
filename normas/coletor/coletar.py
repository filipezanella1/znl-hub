#!/usr/bin/env python3
"""Coletor do catálogo de normas rodoviárias (módulo Normas do ZNL Hub).

Lê as páginas oficiais de índice (DNIT/IPR, DER-PR, DER-SP, DER-MG, SINFRA-MT)
e gera normas/catalogo.json com código, título, órgão, tipo e link de cada documento.

Uso:  python3 normas/coletor/coletar.py            (grava normas/catalogo.json)
      python3 normas/coletor/coletar.py --so dnit  (só uma fonte, mantém as outras)

Robustez: se uma fonte falhar ou vier muito menor que na coleta anterior,
os itens anteriores dessa fonte são mantidos e o problema fica registrado em "avisos".
Dependências: requests, beautifulsoup4, lxml; playwright (opcional, só para o DER-SP).
"""
import json, re, sys, time, unicodedata, argparse, datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote

import requests
from bs4 import BeautifulSoup

RAIZ = Path(__file__).resolve().parents[1]
SAIDA = RAIZ / "catalogo.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
DOC_EXT = re.compile(r"\.(pdf|zip|rar|docx?|xlsx?|dwg)(\?|$)", re.I)
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"})


def get(url, tentativas=3):
    for i in range(tentativas):
        try:
            r = S.get(url, timeout=45)
            r.raise_for_status()
            r.encoding = r.apparent_encoding if not r.encoding or r.encoding.lower() == "iso-8859-1" else r.encoding
            return r.text
        except Exception as e:  # noqa: BLE001
            if i == tentativas - 1:
                raise
            time.sleep(3 * (i + 1))


def sopa(url):
    return BeautifulSoup(get(url), "lxml")


def limpa(t):
    return re.sub(r"\s+", " ", (t or "").replace("\xa0", " ")).strip(" -–—|:")


def url_limpa(u):
    p = urlsplit(u)
    q = "&".join(x for x in p.query.split("&") if x and not x.startswith("preview"))
    return urlunsplit(("https" if p.netloc.endswith("gov.br") else p.scheme, p.netloc, p.path, q, ""))


def frase(t):
    """TÍTULO EM CAIXA ALTA -> Título em caixa alta (mantém siglas curtas)."""
    if not t or sum(c.isupper() for c in t) < 0.7 * sum(c.isalpha() for c in t):
        return t
    palavras = []
    for i, w in enumerate(t.lower().split()):
        palavras.append(w.capitalize() if i == 0 else w)
    out = " ".join(palavras)
    for sig in ["DER", "DNIT", "DNER", "OAE", "CBUQ", "PMF", "PMQ", "TSD", "TSS", "TST", "CAUQ", "BGS", "BGTC", "SAMI", "PVC", "PEAD", "ABNT", "NBR", "SP", "CCR", "CA", "ME", "ES"]:
        out = re.sub(rf"\b{sig.lower()}\b", sig, out) if len(sig) > 2 else out
    return out


def item(orgao, uf, codigo, titulo, url, tipo, cat, situacao="vigente", ano=None, extra=None):
    titulo = limpa(titulo)
    codigo = limpa(codigo)
    if not ano:
        m = re.search(r"/((?:19|20)\d{2}|\d{2})\b", codigo) or re.search(r"-(\d{2})$", codigo)
        if m:
            a = int(m.group(1))
            ano = a if a > 1900 else (1900 + a if a > 40 else 2000 + a)
    d = {"o": orgao, "uf": uf, "c": codigo, "t": titulo, "tp": tipo, "cat": cat, "s": situacao, "u": url_limpa(url)}
    if ano:
        d["a"] = ano
    if extra:
        d.update(extra)
    return d


# ---------------------------------------------------------------- DNIT
DNIT_IPR = "https://www.gov.br/dnit/pt-br/assuntos/planejamento-e-pesquisa/ipr"
DNIT_CATS = {
    "especificacao-de-servico-es": ("ES", "Especificação de Serviço"),
    "especificacao-de-material-em": ("EM", "Especificação de Material"),
    "metodo-de-ensaio-me": ("ME", "Método de Ensaio"),
    "procedimento-pro": ("PRO", "Procedimento"),
    "instrucao-de-ensaio-ie": ("IE", "Instrução de Ensaio"),
    "padronizacao-pad": ("PAD", "Padronização"),
    "terminologia-ter": ("TER", "Terminologia"),
    "classificacao-cla": ("CLA", "Classificação"),
}
RX_DNIT = re.compile(r"^((?:DNER|DNIT)\s*[–-]?\s*(?:[A-Z]{2,3}\s*)?\d{2,3}\s*/\s*\d{2,4}(?:\s*[–-]\s*[A-Z]{2,3}\b)?)\s*[–-]?\s*(.*)$")


def cod_dnit(c):
    c = re.sub(r"\s*[–-]\s*", "-", c)
    c = re.sub(r"^(DNER|DNIT)-(?=\d)", r"\1 ", c)
    c = re.sub(r"^(DNER|DNIT)-([A-Z]{2,3})-?(\d)", r"\1-\2 \3", c)
    return re.sub(r"\s*/\s*", "/", c)


def links_conteudo(sp, base):
    core = sp.select_one("#content-core") or sp.select_one("#content") or sp
    for a in core.find_all("a", href=True):
        yield urljoin(base, a["href"]), limpa(a.get_text(" "))


def resolver_pdf_dnit(itens):
    """Alguns links do DNIT abrem uma página intermediária; troca pelo PDF que ela contém."""
    from concurrent.futures import ThreadPoolExecutor

    def um(it):
        if DOC_EXT.search(it["u"]):
            return
        try:
            for h, _ in links_conteudo(sopa(it["u"]), it["u"]):
                if h.lower().endswith(".pdf") and "coletanea" in h:
                    it["pag"], it["u"] = it["u"], url_limpa(h)
                    return
        except Exception:  # noqa: BLE001
            pass

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(um, itens))


def dnit():
    out = []
    base = DNIT_IPR + "/coletanea-de-normas/coletanea-de-normas/"
    for slug, (tp, cat) in DNIT_CATS.items():
        url = base + slug
        for h, t in links_conteudo(sopa(url), url):
            if slug not in h or not t or len(t) < 8:
                continue
            m = RX_DNIT.match(t)
            cod, tit = (m.group(1), m.group(2)) if m else ("", t)
            tit = re.sub(r"\s*[–-]\s*(Especificação de (serviço|material)|Método de ensaio|Procedimento|Instrução de ensaio|Terminologia|Classificação|Padronização)\s*$", "", tit, flags=re.I)
            out.append(item("DNIT", "BR", cod_dnit(cod), tit or t, h, tp, cat))
    resolver_pdf_dnit(out)
    # canceladas
    url = DNIT_IPR + "/coletanea-de-normas/normas-canceladas-ipr"
    for h, t in links_conteudo(sopa(url), url):
        if "cancel" not in h or not t:
            continue
        m = RX_DNIT.match(t)
        cod, tit = (m.group(1), m.group(2)) if m else ("", t)
        tm = re.search(r"\b(ES|EM|ME|PRO|IE|PAD|TER|CLA)\b", cod)
        tp = tm.group(1) if tm else "NORMA"
        cat = next((c for s, (x, c) in DNIT_CATS.items() if x == tp), "Norma")
        out.append(item("DNIT", "BR", cod_dnit(cod), tit or t, h, tp, cat, situacao="cancelada"))
    # manuais (publicações IPR)
    for pag in ["coletanea-de-manuais/vigentes"]:
        url = f"{DNIT_IPR}/{pag}"
        for h, t in links_conteudo(sopa(url), url):
            if not DOC_EXT.search(h) or not t:
                continue
            m = re.search(r"/(\d{3})[_-]", h)
            cod = f"IPR {m.group(1)}" if m else ""
            out.append(item("DNIT", "BR", cod, t, h, "MAN", "Manual (Publicação IPR)"))
    return out


# ---------------------------------------------------------------- DER-PR
DERPR = "https://www.der.pr.gov.br/Pagina/"
DERPR_PAGS = {
    "Especificacoes-de-Servicos-Rodoviarios": ("ES", "Especificação de Serviço"),
    "Especificacoes-de-Materiais-para-Servicos-Rodoviarios": ("EM", "Especificação de Material / Ensaio"),
    "Manual-de-Execucao-de-Servicos-Rodoviarios": ("MAN", "Manual de Execução"),
    "Padronizacao-de-Projetos": ("PAD", "Padronização de Projetos"),
    "Manual-de-Seguranca-Rodoviaria": ("MAN", "Manual de Segurança Rodoviária"),
    "Manual-de-Gerenciamento-de-Obras-Rodoviarias": ("MAN", "Manual de Gerenciamento de Obras"),
    "Manuais": ("MAN", "Manual"),
}
RX_DERPR = re.compile(r"^(DER[-/ ]?(?:PR)?[-/ ]?(?:ES|EM|ME|IG|IE)[-/ ][A-Z]{0,3}[-/ ]?\d{1,3}[-/]\d{2,4})\s*[-–]?\s*(.*)$", re.I)


def contexto(a):
    """Texto do bloco (linha de tabela, item de lista, parágrafo) que contém o link."""
    for pai in a.parents:
        if pai.name in ("tr", "li", "p", "h3", "h4"):
            return limpa(pai.get_text(" "))
    return ""


def titulo_generico(t):
    return not t or t.upper() in {"PDF", "DWG", "ZIP", "DOWNLOAD", "ABRIR", "BAIXAR", "AQUI", "CLIQUE AQUI", "XLS", "DOC"}


def derpr():
    out, vistos = [], set()
    for pag, (tp, cat) in DERPR_PAGS.items():
        url = DERPR + pag
        sp = sopa(url)
        core = sp.select_one("main") or sp
        for a in core.find_all("a", href=True):
            h = urljoin(url, a["href"])
            if "/arquivos_restritos/files/documento/" not in h or "CARTA_SERVICOS" in h.upper():
                continue
            t = limpa(a.get_text(" "))
            if titulo_generico(t):
                ctx = contexto(a)
                ctx = re.sub(r"\b(PDF|DWG|ZIP)\b", "", ctx).strip(" -–|")
                t = ctx or t
            key = url_limpa(h)
            if key in vistos:
                continue
            vistos.add(key)
            m = RX_DERPR.match(t)
            cod, tit = (m.group(1).upper(), m.group(2)) if m else ("", t)
            if not cod:
                fm = re.search(r"/(DER-[A-Z]{2}-[A-Z]{0,3}-?\d{2}-\d{2})", h, re.I)
                cod = fm.group(1).upper() if fm else ""
            s = "vigente"
            if re.search(r"/20(0\d|1\d)-", h) and tp == "ES" and not re.search(r"-23|-2[4-9]", cod):
                s = "anterior"  # especificações antigas (2005) ainda publicadas para consulta
            ext = "dwg" if h.lower().endswith(".zip") and "DWG" in a.get_text().upper() else None
            out.append(item("DER-PR", "PR", cod, frase(tit), h, tp, cat, situacao=s, extra={"fmt": "DWG"} if ext else None))
    return out


# ---------------------------------------------------------------- DER-SP
def dersp():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError("playwright não instalado")
    url = "https://dersp.der.sp.gov.br/WebSite/Documentos/Tecnicas.aspx"
    exe = "/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe, args=["--no-sandbox"]) if exe else p.chromium.launch()
        pg = b.new_page(user_agent=UA)
        pg.goto(url, wait_until="networkidle", timeout=90000)
        pg.wait_for_timeout(2000)
        linhas = pg.eval_on_selector_all(
            "a[href]",
            """els => els.map(e => {
                const tr = e.closest('tr');
                let sec = '';
                let el = e.closest('table');
                while (el && !sec) { el = el.previousElementSibling; if (el && /^H[1-6]$/.test(el.tagName)) sec = el.innerText; }
                return [e.href, (tr ? tr.innerText : e.innerText).replace(/\\s+/g,' ').trim(), sec.trim()];
            })""")
        b.close()
    out, por_cod = [], {}
    rx = re.compile(r"^((?:ET|IP|IE|IT|EP|DE|IC|MT|ME|PP)-?[A-Z]{0,3}-?[A-Z0-9]{2,4}\s*/\s*\d{3}(?:_[A-Z])?)\s*(.*)$")
    for h, txt, sec in linhas:
        if "/Arquivos/" not in h or not DOC_EXT.search(h):
            continue
        txt = re.sub(r"\b(PDF|ZIP|DWG)\b", "", txt).strip()
        m = rx.match(txt)
        cod, tit = (m.group(1).replace(" ", ""), m.group(2)) if m else ("", txt)
        if not cod:
            fm = re.search(r"/([A-Z]{2}-[A-Z]{2}-[A-Z0-9]{3}-\d{3})", h)
            cod = fm.group(1) if fm else ""
        k = cod or h
        e = por_cod.get(k)
        if e:  # mesmo documento em PDF e ZIP: fica o PDF, o ZIP vira alternativo
            if h.lower().endswith(".pdf") and not e["u"].lower().endswith(".pdf"):
                e["alt"], e["u"] = e["u"], url_limpa(h)
            else:
                e.setdefault("alt", url_limpa(h))
            continue
        tp = "ES" if cod.startswith("ET") else ("PRO" if cod.startswith(("IP", "IE", "IT")) else ("PAD" if cod.startswith("PP") else "NORMA"))
        cat = {"ES": "Especificação Técnica", "PRO": "Instrução de Projeto", "PAD": "Projeto Padrão"}.get(tp, "Norma técnica")
        extra = {}
        rm = re.search(r"_([A-Z])$", cod)
        if rm:
            extra["rev"], cod = rm.group(1), cod[:-2]
        else:
            rm = re.search(r"[-_]([A-Z])\.(?:pdf|zip)$", h, re.I)
            if rm:
                extra["rev"] = rm.group(1).upper()
        tit = re.sub(r"\s+[A-Z]$", "", tit) if extra.get("rev") else tit
        e = item("DER-SP", "SP", cod, frase(tit), h, tp, cat, extra=extra or None)
        por_cod[k] = e
        out.append(e)
    # manuais técnicos (página estática)
    url = "https://www.der.sp.gov.br/der/biblioteca/manuais_e_normas/manuais-tecnicos"
    try:
        sp = sopa(url)
        vistos = set()
        for a in sp.find_all("a", href=True):
            h = urljoin(url, a["href"])
            if "/Arquivos/" not in h or not DOC_EXT.search(h):
                continue
            t = limpa(a.get_text(" "))
            if titulo_generico(t):
                t = re.sub(r"\b(PDF|ZIP)\b", "", contexto(a)).strip()
            fn = urlsplit(h).path.rsplit("/", 1)[-1].lower()
            if not t or fn in vistos:
                continue
            vistos.add(fn)
            out.append(item("DER-SP", "SP", "", t, h, "MAN", "Manual técnico"))
    except Exception:  # noqa: BLE001
        pass
    return out


# ---------------------------------------------------------------- DER-MG
def dermg():
    url = "https://www.der.mg.gov.br/institucional/legislacao/normas-tecnicas-deer"
    sp = sopa(url)
    out, vistos = [], set()
    for a in sp.find_all("a", href=True):
        h = urljoin(url, a["href"])
        if "/files/" not in h or not DOC_EXT.search(urlsplit(h).path):
            continue
        key = url_limpa(h)
        t = limpa(a.get_text(" "))
        if key in vistos or titulo_generico(t):
            continue
        vistos.add(key)
        if not t:
            t = unquote(urlsplit(h).path.rsplit("/", 1)[-1]).rsplit(".", 1)[0].replace("-", " ")
        m = re.match(r"^(RT[-\s]?\d{2}\.\d{2}[a-z]?)\s*[-–]+\s*(.*)$", t)
        if m:
            out.append(item("DER-MG", "MG", m.group(1).replace(" ", "-"), m.group(2), h, "ES", "Recomendação Técnica"))
        else:
            tp = "MAN" if re.search(r"manual|caderno", t, re.I) else "NORMA"
            out.append(item("DER-MG", "MG", "", t, h, tp, "Manual" if tp == "MAN" else "Norma / documento técnico"))
    return out


# ---------------------------------------------------------------- SINFRA-MT
def sinfra_mt():
    url = "https://www.sinfra.mt.gov.br/instrucoes-tecnicas"
    sp = sopa(url)
    out, vistos = [], set()
    core = sp.select_one("main") or sp
    for a in core.find_all("a", href=True):
        h = urljoin(url, a["href"])
        if "/documents/" not in h:
            continue
        t = limpa(a.get_text(" "))
        if len(t) < 6 or t.startswith("- "):
            continue
        key = url_limpa(h)
        if key in vistos:
            continue
        vistos.add(key)
        t = re.sub(r"^\d+(\.\d+)*\s*[.)-]?\s+", "", t)
        m = re.match(r"^((?:Portaria|Instru[cç][aã]o Normativa|IN)[^-–]{0,40}?\d+[./]\d{2,4}[^-–]*?)\s*[-–]\s*(.*)$", t, re.I)
        cod, tit = (m.group(1), m.group(2)) if m else ("", t)
        out.append(item("SINFRA-MT", "MT", cod, tit, h, "IT", "Instrução técnica / normativa"))
    return out


FONTES = {
    "dnit": ("DNIT", "Departamento Nacional de Infraestrutura de Transportes (IPR)", DNIT_IPR + "/coletanea-de-normas", dnit),
    "derpr": ("DER-PR", "Departamento de Estradas de Rodagem do Paraná", DERPR + "Normas-e-Custos-Rodoviarios", derpr),
    "dersp": ("DER-SP", "Departamento de Estradas de Rodagem de São Paulo", "https://www.der.sp.gov.br/der/biblioteca/manuais_e_normas/normas", dersp),
    "dermg": ("DER-MG", "Departamento de Edificações e Estradas de Rodagem de Minas Gerais", "https://www.der.mg.gov.br/institucional/legislacao/normas-tecnicas-deer", dermg),
    "sinfra_mt": ("SINFRA-MT", "Secretaria de Infraestrutura e Logística de Mato Grosso", "https://www.sinfra.mt.gov.br/instrucoes-tecnicas", sinfra_mt),
}


def chave(t):
    t = unicodedata.normalize("NFD", t.lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--so", nargs="*", help="coletar só estas fontes")
    args = ap.parse_args()
    anterior = json.loads(SAIDA.read_text("utf-8")) if SAIDA.exists() else {"itens": [], "fontes": []}
    ant_por_fonte = {}
    for it in anterior.get("itens", []):
        ant_por_fonte.setdefault(it["f"], []).append(it)

    itens, fontes, avisos = [], [], []
    for fid, (sigla, nome, url, fn) in FONTES.items():
        velhos = ant_por_fonte.get(fid, [])
        novos, erro = None, None
        if args.so is None or fid in args.so:
            try:
                novos = fn()
            except Exception as e:  # noqa: BLE001
                erro = f"{type(e).__name__}: {e}"[:200]
            if novos is not None and velhos and len(novos) < 0.6 * len(velhos):
                erro = f"coleta trouxe {len(novos)} itens, a anterior tinha {len(velhos)}; mantida a anterior"
                novos = None
        if novos is None:
            if erro:
                avisos.append(f"{sigla}: {erro}")
                print(f"[aviso] {sigla}: {erro}", file=sys.stderr)
            novos = velhos
            data = next((f.get("em") for f in anterior.get("fontes", []) if f["id"] == fid), None)
        else:
            data = datetime.date.today().isoformat()
        vistos = set()
        for it in novos:
            it["f"] = fid
            if it["u"] in vistos:
                continue
            vistos.add(it["u"])
            itens.append(it)
        fontes.append({"id": fid, "sigla": sigla, "nome": nome, "url": url, "n": len(vistos), "em": data})
        print(f"{sigla:10s} {len(vistos):5d} itens", file=sys.stderr)

    # mesma norma publicada em várias revisões (ex.: DER-SP _A e _B): só a mais nova fica vigente
    grupos = {}
    for it in itens:
        if it["c"] and it.get("rev") and it["s"] == "vigente":
            grupos.setdefault((it["f"], it["c"]), []).append(it)
    for g in grupos.values():
        if len(g) > 1:
            g.sort(key=lambda x: x["rev"])
            for velho in g[:-1]:
                velho["s"] = "anterior"

    ordem_s = {"vigente": 0, "anterior": 1, "cancelada": 2}
    itens.sort(key=lambda x: (list(FONTES).index(x["f"]), ordem_s.get(x["s"], 3), x["tp"], chave(x["c"] or "~"), chave(x["t"])))
    doc = {
        "gerado_em": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": len(itens),
        "fontes": fontes,
        "avisos": avisos,
        "itens": itens,
    }
    SAIDA.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"total {len(itens)} -> {SAIDA}", file=sys.stderr)


if __name__ == "__main__":
    main()
