#!/usr/bin/env python3
"""Coletor da aba ABNT do módulo Normas (ZNL Hub).

1. Lê normas/catalogo.json (normas do DNIT, DER-PR, DER-SP, DER-MG, SINFRA-MT).
2. Baixa cada documento (PDF ou ZIP com PDFs), extrai o texto com pdftotext e
   procura as citações "ABNT NBR ..." (NBR, NBR NM, NBR ISO, partes e anos citados).
   O resultado por documento fica em normas/abnt-cache.json; só documentos novos são baixados.
3. Para cada NBR citada consulta o catálogo da Target (revenda autorizada da ABNT):
   título, edição vigente, situação e resumo. Renovado a cada 30 dias.
4. Junta os PDFs abertos oficiais (LIVRES, abaixo) e as substituições conhecidas (SUBST)
   e grava normas/abnt.json, lido pela aba ABNT de normas.html.

Uso:  python3 normas/coletor/abnt.py
Dependências: requests, beautifulsoup4, lxml e o programa pdftotext (poppler-utils).
"""
import io, json, re, sys, time, zipfile, subprocess, tempfile, datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

RAIZ = Path(__file__).resolve().parents[1]
CATALOGO = RAIZ / "catalogo.json"
CACHE = RAIZ / "abnt-cache.json"
SAIDA = RAIZ / "abnt.json"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
MAX = 250 * 1024 * 1024
HOJE = datetime.date.today().isoformat()

# PDFs integrais publicados por órgãos públicos com autorização (normas de acessibilidade
# liberadas pela ABNT em acordo com o Ministério Público; lista mantida pela Câmara dos Deputados).
# Só entram aqui documentos de fonte oficial — nada de cópias em sites de terceiros.
CAMARA = "https://www2.camara.leg.br/a-camara/estruturaadm/gestao-na-camara-dos-deputados/responsabilidade-social-e-ambiental/acessibilidade/normas-da-abnt-1"
LIVRES = {
    "NBR 9050": "https://www.caurn.gov.br/wp-content/uploads/2020/08/ABNT-NBR-9050-15-Acessibilidade-emenda-1_-03-08-2020.pdf",
    "NBR 16537": "https://ampid.org.br/site2020/wp-content/uploads/2024/01/NBR-16537-2024.pdf",
    "NBR 15250": "https://www.cnmp.mp.br/portal/images/Comissoes/DireitosFundamentais/Acessibilidade/NBR_15250-2005_Caixa_Auto_Atendimento.pdf",
    "NBR 15599": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR15599.pdf",
    "NBR 17225": "https://www2.camara.leg.br/a-camara/estruturaadm/gestao-na-camara-dos-deputados/responsabilidade-social-e-ambiental/acessibilidade/pdfs/ABNTNBR17225AcessibilidadeDigitalparaWeb.pdf",
    "NBR NM 313": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBRNM313.pdf",
    "NBR 14273": "https://www.cnmp.mp.br/portal/images/Comissoes/DireitosFundamentais/Acessibilidade/NBR_14273-99_Transporte_Aereo.pdf",
    "NBR 15450": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR15450.pdf",
    "NBR 14022": "https://www.cnmp.mp.br/portal/images/Comissoes/DireitosFundamentais/Acessibilidade/NBR_14022-2011_Onibus_Ed4.pdf",
    "NBR 14021": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR14021.pdf",
    "NBR 15208": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR15208.pdf",
    "NBR 15570": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/ABNT%2015570%20-%2030%207%202021%281%29.pdf",
    "NBR 15646": "https://docs.uberlandia.mg.gov.br/wp-content/uploads/2022/06/ABNT-NBR-156462016-%E2%80%93-Acessibilidade.pdf",
    "NBR 14970-1": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR14970-1.pdf",
    "NBR 14970-2": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/pessoa_com_deficiencia/NBR14970-2.pdf",
    "NBR 16452": "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/ABNT%20-%20Acessibilidade.pdf",
}

# Normas canceladas muito citadas nas especificações antigas, com a norma que as substituiu.
SUBST = {
    "NBR 5732": "NBR 16697", "NBR 5733": "NBR 16697", "NBR 5735": "NBR 16697", "NBR 5736": "NBR 16697",
    "NBR 5737": "NBR 16697", "NBR 11578": "NBR 16697", "NBR 12989": "NBR 16697", "NBR 13116": "NBR 16697",
    "NBR NM 67": "NBR 16889", "NBR 7223": "NBR 16889",
    "NBR 5734": "NBR ISO 3310-1",             # peneiras para ensaio
    "NBR 7217": "NBR 17054",                  # granulometria de agregados
    "NBR 7251": "NBR 16972",                  # massa unitária de agregados
    "NBR 9937": "NBR 16917",                  # densidade e absorção do agregado graúdo
    "NBR 6465": "NBR 16974",                  # abrasão Los Angeles
    "NBR NM 248": "NBR 17054", "NBR NM 51": "NBR 16974", "NBR NM 45": "NBR 16972",
    "NBR NM 53": "NBR 16917", "NBR NM 52": "NBR 16916",
}

D = r"[-–‑]"
RX = re.compile(
    r"\bNBR\s*" + D + r"?\s*"
    r"(?P<pre>(?:NM\s*" + D + r"?\s*(?:ISO\s*" + D + r"?\s*)?|ISO\s*(?:/\s*IEC\s*)?" + D + r"?\s*|IEC\s*" + D + r"?\s*)?)"
    r"(?P<num>\d{1,2}\.\d{3}|\d{1,5})"
    r"(?:\s*" + D + r"\s*(?P<parte>\d{1,2})(?!\d))?"
    r"(?:\s*[:/]\s*(?P<ano>(?:19|20)\d{2}|\d{2})(?!\d))?",
    re.I)


def chave(m):
    pre = re.sub(r"[\s\-–‑]", "", m.group("pre") or "").upper()
    pre = {"NMISO": "NM ISO"}.get(pre, pre)
    num = m.group("num").replace(".", "")
    if int(num) < 10 and not pre:
        return None, None
    k = "NBR " + (pre + " " if pre else "") + num + ("-" + m.group("parte") if m.group("parte") else "")
    ano = m.group("ano")
    if ano:
        a = int(ano)
        ano = a if a > 1900 else (1900 + a if a > 40 else 2000 + a)
        if not 1940 <= ano <= datetime.date.today().year:
            ano = None
    return k, ano


def refs_do_texto(t):
    r = {}
    for m in RX.finditer(t):
        k, ano = chave(m)
        if not k:
            continue
        anos = r.setdefault(k, [])
        if ano and ano not in anos:
            anos.append(ano)
    return {k: sorted(v) for k, v in r.items()}


def pdf_txt(b):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(b)
        f.flush()
        p = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", f.name, "-"], capture_output=True, timeout=180)
        return p.stdout.decode("utf-8", "replace")


def texto(url):
    r = requests.get(url, headers=UA, timeout=90, stream=True)
    r.raise_for_status()
    b = b""
    for ch in r.iter_content(1 << 16):
        b += ch
        if len(b) > MAX:
            raise RuntimeError("arquivo acima de 250 MB")
    if b[:4] == b"%PDF":
        return pdf_txt(b)
    if b[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(b))
        return "\n".join(pdf_txt(z.read(n)) for n in z.namelist()
                         if n.lower().endswith(".pdf") and z.getinfo(n).file_size < MAX)
    raise RuntimeError("não é PDF nem ZIP (" + r.headers.get("content-type", "?") + ")")


# ---------- catálogo da Target (revenda autorizada da ABNT) ----------
def cartoes(q):
    for i in range(3):
        try:
            r = requests.get("https://www.target.com.br/pesquisa/normas-tecnicas/" + quote(q) + "/1", headers=UA, timeout=40)
            r.raise_for_status()
            break
        except Exception:  # noqa: BLE001
            if i == 2:
                raise
            time.sleep(4 * (i + 1))
    s = BeautifulSoup(r.text, "lxml")
    out = []
    for c in s.select(".card-resultado"):
        a = c.select_one("h5 a")
        if not a:
            continue
        m = re.match(r"(\S+) de (\d{2})/(\d{4}) - (.+)", a.get_text(" ", strip=True))
        if not m:
            continue
        b, p = c.select_one(".badge"), c.select_one("p")
        out.append({"cod": m.group(1).upper(), "d": f"{m.group(3)}-{m.group(2)}", "t": m.group(4).strip(),
                    "s": b.get_text(strip=True).lower() if b else "", "res": p.get_text(" ", strip=True) if p else "",
                    "u": a["href"]})
    return out


def cod(c):
    """'NM-ISO3310-1' -> 'NMISO3310-1' (a Target às vezes separa as siglas com hífen)."""
    return re.sub(r"(?<=[A-Z])-(?=[A-Z])", "", c.upper().replace(" ", ""))


def consulta(k):
    alvo = k.replace(" ", "").upper()                    # NBR7181, NBRNM67, NBRISO6892
    curto = k.startswith(("NBR NM ", "NBR ISO ", "NBR IEC "))
    cs = cartoes(k)
    if curto:
        cs += cartoes(k[4:])                             # a Target acha "ISO 6892-1" / "NM 67" sem o "NBR"
    for c in cs:
        if cod(c["cod"]) == alvo:
            return c
    if curto and alvo.startswith("NBRNM"):
        for c in cs:
            if cod(c["cod"]) == alvo[3:]:                # só a versão Mercosul (NM) está no catálogo
                return c | {"mercosul": True}
    # revisada e dividida em partes (ex.: NBR 7190 -> NBR 7190-1 ... -7)
    partes = sorted((c for c in {cod(c["cod"]): c for c in cs}.values() if re.fullmatch(re.escape(alvo) + r"-\d{1,2}", cod(c["cod"]))),
                    key=lambda c: int(c["cod"].rsplit("-", 1)[1]))
    if partes:
        p1 = partes[0]
        base = re.split(r"\s+[-—–]\s+Parte\s+\d", p1["t"])[0].strip()
        return {"cod": alvo, "t": base, "d": max(p["d"] for p in partes), "s": "vigente",
                "res": p1["res"], "u": p1["u"],
                "partes": [{"k": k + "-" + p["cod"].rsplit("-", 1)[1], "t": p["t"], "d": p["d"], "u": p["u"]} for p in partes]}
    # parte que foi unificada na norma principal (ex.: NBR 14725-4 -> NBR 14725)
    m = re.fullmatch(r"(NBR (?:ISO )?\d+)-\d{1,2}", k)
    if m:
        alvo2 = m.group(1).replace(" ", "").upper()
        for c in cartoes(m.group(1)):
            if cod(c["cod"]) == alvo2:
                return c | {"unif": m.group(1)}
    return None


def main():
    cat = json.load(open(CATALOGO))
    itens = cat["itens"]
    try:
        cache = json.load(open(CACHE))
    except Exception:  # noqa: BLE001
        cache = {"docs": {}, "target": {}}

    # 1-2. citações por documento (só baixa o que ainda não foi lido ou falhou há mais de 7 dias)
    docs = cache["docs"]
    def precisa(u):
        d = docs.get(u)
        return not d or ("erro" in d and d.get("em", "") < (datetime.date.today() - datetime.timedelta(days=7)).isoformat())
    novos = [it["u"] for it in itens if precisa(it["u"])]
    print(f"documentos no catálogo: {len(itens)} · a ler agora: {len(novos)}", flush=True)

    def le(u):
        try:
            t = texto(u)
            return u, {"refs": refs_do_texto(t), "chars": len(t.strip()), "em": HOJE}
        except Exception as e:  # noqa: BLE001
            return u, {"erro": str(e)[:160], "em": HOJE}

    with ThreadPoolExecutor(8) as ex:
        for n, (u, d) in enumerate(ex.map(le, novos), 1):
            docs[u] = d
            if n % 100 == 0:
                print(f"  {n}/{len(novos)}", flush=True)
                json.dump(cache, open(CACHE, "w"), ensure_ascii=False, separators=(",", ":"))
    urls = {it["u"] for it in itens}
    for u in list(docs):
        if u not in urls:
            del docs[u]

    # junta por NBR
    por = {}
    for i, it in enumerate(itens):
        d = docs.get(it["u"]) or {}
        for k, anos in (d.get("refs") or {}).items():
            e = por.setdefault(k, {"cit": [], "anos": {}})
            e["cit"].append(i)
            for a in anos:
                e["anos"][a] = e["anos"].get(a, 0) + 1
    for k in list(LIVRES) + list(SUBST.values()):
        por.setdefault(k, {"cit": [], "anos": {}})

    # 3. Target
    tg = cache["target"]
    lim = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    falta = [k for k in por if k not in tg or tg[k].get("em", "") < lim]
    print(f"NBR citadas: {len(por)} · a consultar na Target: {len(falta)}", flush=True)

    def tq(k):
        try:
            r = consulta(k)
            return k, (r or {"nf": 1}) | {"em": HOJE}
        except Exception as e:  # noqa: BLE001
            return k, {"erro": str(e)[:160]}
    with ThreadPoolExecutor(4) as ex:
        for n, (k, v) in enumerate(ex.map(tq, falta), 1):
            if "erro" not in v or k not in tg:
                tg[k] = v
            if n % 100 == 0:
                print(f"  {n}/{len(falta)}", flush=True)
    json.dump(cache, open(CACHE, "w"), ensure_ascii=False, separators=(",", ":"))

    # 4. saída: um item por NBR; os documentos citantes vão como índice na lista "docs"
    def ordem(k):
        m = re.match(r"NBR (?:(NM ISO|NM|ISO/IEC|ISO|IEC) )?(\d+)(?:-(\d+))?", k)
        return (m.group(1) or "", int(m.group(2)), int(m.group(3) or 0)) if m else ("~", 0, 0)
    lista_docs, idx = [], {}
    saida = []
    for k in sorted(por, key=ordem):
        e, t = por[k], tg.get(k) or {}
        # sem citação real e sem dado no catálogo = descarta (ex.: entrada só da lista de livres)
        if not e["cit"] and k not in SUBST.values():
            continue
        # ruído: não está no catálogo e só aparece em um documento
        if t.get("nf") and len(e["cit"]) < 2 and k not in SUBST:
            continue
        cit = []
        for i in e["cit"]:
            u = itens[i]["u"]
            if u not in idx:
                idx[u] = len(lista_docs)
                it = itens[i]
                lista_docs.append({"o": it["o"], "f": it["f"], "c": it.get("c", ""), "t": it.get("t", ""), "u": u, "s": it["s"]})
            cit.append(idx[u])
        x = {"k": k, "cit": cit}
        if e["anos"]:
            x["anos"] = {str(a): n for a, n in sorted(e["anos"].items())}
        if t and not t.get("nf") and "erro" not in t:
            x.update({"t": t["t"], "d": t["d"], "s": t["s"] or "vigente", "res": t.get("res", ""), "u": t["u"]})
            if t.get("mercosul"):
                x["nm"] = 1
            if t.get("partes"):
                x["partes"] = t["partes"]
            if t.get("unif"):
                x["unif"] = t["unif"]
        else:
            x["s"] = "nf"
        if k in SUBST:
            x["sub"] = SUBST[k]
            x["s"] = "cancelada"
        if k in LIVRES:
            x["pdf"] = LIVRES[k]
        saida.append(x)

    lidos = sum(1 for u in urls if docs.get(u, {}).get("chars", 0) > 200)
    out = {
        "gerado_em": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "catalogo_de": cat.get("gerado_em"),
        "docs_lidos": lidos, "docs_total": len(itens),
        "docs_sem_texto": [{"o": it["o"], "c": it.get("c", ""), "u": it["u"]} for it in itens
                           if docs.get(it["u"], {}).get("chars", 0) <= 200],
        "fonte_livres": CAMARA,
        "total": len(saida), "docs": lista_docs, "itens": saida,
    }
    try:  # sem mudança de conteúdo, mantém a data anterior (evita commit semanal à toa)
        velho = json.load(open(SAIDA))
        if {k: v for k, v in velho.items() if k not in ("gerado_em", "catalogo_de")} == \
           {k: v for k, v in out.items() if k not in ("gerado_em", "catalogo_de")}:
            out["gerado_em"], out["catalogo_de"] = velho["gerado_em"], velho.get("catalogo_de")
    except Exception:  # noqa: BLE001
        pass
    json.dump(out, open(SAIDA, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"abnt.json: {len(saida)} NBR, {lidos}/{len(itens)} documentos com texto")


if __name__ == "__main__":
    main()
