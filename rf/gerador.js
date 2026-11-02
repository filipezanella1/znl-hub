/* Relatório Fotográfico PR-990 — gerador do PPTX.
   Roda no navegador (módulo do hub) e no Node (testes). Não acessa rede nem disco:
   recebe tudo pronto do chamador (fotos em data URL, logo, mapa, retigráfico).

   gerar({ PptxGenJS, cfg, fotos, av, logo, mapa, crop }) → instância pptx (chamar writeFile / write)
     cfg   : { num: "001", mesLongo: "Outubro de 2026", mesCurto: "out/2026" }
     fotos : [{ data, w, h, disc, desc, est, lado, dataFoto, capa }] já na ordem final
     av    : retigráfico (formato data/avanco.json do app PR990)
     logo, mapa : data URLs
     crop  : async (foto, aspecto) → data URL da foto recortada no aspecto (centro)
*/
(function (root) {
  "use strict";

  const DISC = {
    "Terraplenagem": "9A5B25",
    "Pavimentação": "3D4247",
    "Drenagem": "D9731A",
    "OAE": "2F5597",
    "Sinalização": "B08900",
    "Obras complementares": "4F7F3A",
    "Contenções": "6B4F8A",
    "Geral": "6A7672",
  };
  const ORDEM = Object.keys(DISC);

  const COR = { verde: "266131", tinta: "1B2A20", mudo: "6A7672", claro: "EEF3EF", branco: "FFFFFF", azul: "2F5597", laranja: "D9731A" };
  const W = 13.333, M = 0.6, CW = W - 2 * M, TOP = 2.05, BOT = 6.75;
  const EXEC = 624;  // estacas executáveis (a partir daqui o trecho não será executado)

  const estStr = e => {
    if (e === null || e === undefined || !isFinite(e)) return "";
    let i = Math.floor(e + 1e-9), m = Math.round((e - i) * 20 * 100) / 100;
    if (m >= 20) { i += 1; m = 0; }
    return m ? `${i}+${String(m).replace(".", ",")}` : String(i);
  };
  const dataBR = d => (d && /^\d{4}-\d{2}-\d{2}/.test(d)) ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "";
  const strip = d => String(d).replace(/^data:/, "");

  // agrupa as fotos em slides: por disciplina, 2 deitadas por slide, até 3 em pé, sobra vira slide de 1
  function planejar(fotos) {
    const slides = [];
    let i = 0;
    while (i < fotos.length) {
      const f = fotos[i], disc = f.disc;
      const retrato = x => x.h > x.w * 1.05;
      if (retrato(f)) {
        const g = [i];
        while (g.length < 3 && i + g.length < fotos.length && fotos[i + g.length].disc === disc && retrato(fotos[i + g.length])) g.push(i + g.length);
        slides.push({ tipo: g.length === 1 ? "um" : "retratos", idx: g, disc });
        i += g.length;
      } else {
        const n = fotos[i + 1];
        if (n && n.disc === disc && !retrato(n)) { slides.push({ tipo: "dois", idx: [i, i + 1], disc }); i += 2; }
        else { slides.push({ tipo: "um", idx: [i], disc }); i += 1; }
      }
    }
    return slides;
  }

  async function gerar({ PptxGenJS, cfg, fotos, av, logo, mapa, crop }) {
    const pres = new PptxGenJS();
    pres.layout = "LAYOUT_WIDE";
    pres.theme = { headFontFace: "Calibri", bodyFontFace: "Calibri" };
    pres.title = `Relatório Fotográfico nº ${cfg.num} – PR-990`;
    pres.author = "TCE Engenharia";
    pres.company = "TCE Engenharia";

    pres.defineSlideMaster({ title: "CAPA", background: { color: COR.branco }, objects: [{ rect: { x: 0, y: 0, w: 6.3, h: 7.5, fill: { color: COR.verde } } }] });
    pres.defineSlideMaster({
      title: "CONTEUDO", background: { color: COR.branco }, margin: [0.5, M, 0.6, M],
      objects: [
        { image: { data: strip(logo), x: M, y: 0.22, w: 0.39, h: 0.6 } },
        { text: { text: "PR-990 · Obra 515", options: { x: M + 0.55, y: 0.37, w: 5, h: 0.3, fontSize: 12, bold: true, color: COR.verde, margin: 0 } } },
        { text: { text: `Relatório Fotográfico nº ${cfg.num} · ${cfg.mesCurto}`, options: { x: W - M - 5, y: 0.37, w: 5, h: 0.3, fontSize: 11, color: COR.mudo, align: "right", margin: 0 } } },
        { text: { text: "TCE ENGENHARIA  ·  Contrato CO 050/2024 DER/DT · DER-PR", options: { x: M, y: 7.0, w: 7, h: 0.28, fontSize: 10, color: COR.mudo, margin: 0 } } },
        { placeholder: { options: { name: "title", type: "title", x: M, y: 1.28, w: CW, h: 0.64, fontSize: 30, bold: true, color: COR.tinta, margin: 0, valign: "middle", align: "left" }, text: "" } },
      ],
      slideNumber: { x: W - M - 0.6, y: 7.0, w: 0.6, h: 0.28, fontSize: 10, color: COR.tinta, align: "right" },
    });

    const chip = (s, t, c) => s.addText(t.toUpperCase(), {
      shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.05, x: M, y: 0.93, w: 0.2 + t.length * 0.105, h: 0.3,
      fill: { color: c }, color: COR.branco, fontSize: 10, bold: true, charSpacing: 1.5, align: "center", valign: "middle", margin: 0, isTextBox: true,
    });
    const conteudo = (secao, titulo, chipT, chipC, loc) => {
      const s = pres.addSlide({ masterName: "CONTEUDO", sectionTitle: secao });
      chip(s, chipT, chipC);
      s.addText(titulo, { placeholder: "title" });
      if (loc) s.addText(loc, { x: W - M - 4, y: 1.28, w: 4, h: 0.64, fontSize: 13, color: COR.mudo, align: "right", valign: "middle", margin: 0, isTextBox: true });
      return s;
    };

    const frentes = (av && av.frentes) || [];
    const dataAv = av && av.data ? av.data.split("-").reverse().join("/") : "";
    const pc = f => (f.c.slice(0, EXEC).split("").filter(x => x === "2").length / EXEC) * 100;
    const pa = f => (f.c.slice(0, EXEC).split("").filter(x => x === "1").length / EXEC) * 100;
    const curto = n => n.replace("Corte – aterro", "Terraplenagem").replace("1ª camada de reforço", "1ª cam. reforço").replace("2ª camada de reforço", "2ª cam. reforço");

    // números das fotos e slide de cada uma (capa=1, localização=2, resumo=3, linear=4, fotos a partir de 5)
    const plano = planejar(fotos);
    const slideDe = [];
    plano.forEach((p, k) => p.idx.forEach(i => { slideDe[i] = 5 + k; }));

    // ---------- 1 capa
    pres.addSection({ title: "Capa" });
    {
      const s = pres.addSlide({ masterName: "CAPA", sectionTitle: "Capa" });
      const ci = Math.max(0, fotos.findIndex(f => f.capa));
      if (fotos.length) s.addImage({ data: strip(await crop(fotos[ci], (W - 6.3) / 7.5)), x: 6.3, y: 0, w: W - 6.3, h: 7.5, altText: "Foto de destaque" });
      const L = 0.7, TW = 5.2;
      s.addShape(pres.shapes.RECTANGLE, { x: L, y: 0.6, w: 1.0, h: 1.38, fill: { color: COR.branco }, line: { type: "none" } });
      s.addImage({ data: strip(logo), x: L + 0.06, y: 0.66, w: 0.85, h: 1.26, altText: "Logo TCE Engenharia" });
      s.addText("OBRA 515", { x: L + 1.25, y: 1.62, w: 3, h: 0.35, fontSize: 13, bold: true, charSpacing: 4, color: COR.branco, margin: 0, isTextBox: true });
      s.addText("PR-990", { x: L, y: 2.3, w: TW, h: 1.1, fontSize: 66, bold: true, color: COR.branco, margin: 0, isTextBox: true });
      s.addText("Implantação · PR-364 – Cidade de Rebouças", { x: L, y: 3.4, w: TW, h: 0.45, fontSize: 20, color: COR.branco, margin: 0, isTextBox: true });
      s.addText("RELATÓRIO FOTOGRÁFICO DE ACOMPANHAMENTO DE OBRA", { x: L, y: 4.35, w: TW, h: 0.75, fontSize: 18, bold: true, charSpacing: 1, color: COR.branco, margin: 0, isTextBox: true, valign: "top" });
      s.addText(`Nº ${cfg.num} · ${cfg.mesLongo}`, { x: L, y: 5.15, w: TW, h: 0.45, fontSize: 20, color: COR.branco, margin: 0, isTextBox: true });
      s.addText([{ text: "Contrato CO 050/2024 DER/DT · DER-PR", options: { breakLine: true } }, { text: "km 0+000 a 12+883,96 · est. 0 a 642+15,817" }],
        { x: L, y: 6.35, w: TW, h: 0.6, fontSize: 12, color: COR.branco, margin: 0, isTextBox: true });
    }

    // ---------- 2 localização
    pres.addSection({ title: "Obra" });
    {
      const s = conteudo("Obra", "Localização e dados do contrato", "Obra", COR.verde);
      const mh = CW * 858 / 3153;
      s.addImage({ data: strip(mapa), x: M, y: TOP - 0.05, w: CW, h: mh, altText: "Localização: Brasil, Paraná, município de Rebouças e trecho da PR-990" });
      const rows = [["Rodovia", "PR-990 – implantação"], ["Trecho", "PR-364 – Cidade de Rebouças"], ["Segmento", "km 0+000 a 12+883,96"],
        ["Contrato", "CO 050/2024 DER/DT"], ["Contratada", "TCE Engenharia Ltda."], ["OAE", "Ponte s/ Rio do Salto (235+6 a 237+1)"]];
      const fy = TOP + mh + 0.2, c3 = (CW - 0.6) / 3, rh = 0.62;
      rows.forEach(([k, v], i) => s.addText([
        { text: k.toUpperCase(), options: { fontSize: 10, color: COR.mudo, bold: true, charSpacing: 1, breakLine: true } },
        { text: v, options: { fontSize: 14, color: COR.tinta } },
      ], { x: M + (i % 3) * (c3 + 0.3), y: fy + Math.floor(i / 3) * rh, w: c3, h: rh, margin: 0, valign: "top", isTextBox: true }));
    }

    // ---------- 3 resumo do avanço
    if (frentes.length) {
      const s = conteudo("Obra", `Avanço físico até ${dataAv}`, "Resumo", COR.verde);
      s.addChart(pres.charts.BAR, [{ name: "Concluído (%)", labels: frentes.map(f => curto(f.n)), values: frentes.map(f => Math.round(pc(f))) }], {
        x: M, y: TOP, w: 7.6, h: BOT - TOP - 0.45, barDir: "bar", catAxisOrientation: "maxMin", chartColors: [COR.verde], barGapWidthPct: 45,
        showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: '0"%"', dataLabelFontSize: 12, dataLabelColor: COR.tinta, dataLabelFontFace: "Calibri",
        valAxisHidden: true, valAxisMaxVal: 100, valAxisMinVal: 0, valGridLine: { style: "none" }, catGridLine: { style: "none" },
        catAxisLabelColor: COR.tinta, catAxisLabelFontSize: 13, catAxisLabelFontFace: "Calibri", catAxisLineShow: false, showLegend: false, showTitle: false,
      });
      s.addText(`% das estacas concluídas entre as estacas 0 e ${EXEC}. Fonte: retigráfico da obra 515 de ${dataAv}.`, { x: M, y: BOT - 0.35, w: 7.6, h: 0.35, fontSize: 10, color: COR.mudo, margin: 0, isTextBox: true });
      const cbuq = frentes.find(f => /CBUQ/i.test(f.n)) || frentes[frentes.length - 1], terr = frentes[0];
      const oac = (av.oac || []).filter(o => o.e <= EXEC), ok = oac.filter(o => o.st === "c").length;
      const stats = [
        [`${Math.round(pc(cbuq))}%`, "CBUQ concluído", "camada final de revestimento"],
        [`${Math.round(pc(terr))}%`, "Terraplenagem concluída", `mais ${Math.round(pa(terr))}% atacada`],
        [`${ok} de ${oac.length}`, "Bueiros e galerias (OAC)", "concluídos"],
      ];
      const sx = 8.9, sw = W - M - sx, sh = (BOT - TOP - 0.4) / 3;
      stats.forEach(([big, lab, sub], i) => {
        const y = TOP + i * (sh + 0.2);
        s.addShape(pres.shapes.RECTANGLE, { x: sx, y, w: sw, h: sh, fill: { color: COR.claro }, line: { type: "none" } });
        s.addText(big, { x: sx + 0.3, y: y + 0.12, w: sw - 0.6, h: 0.75, fontSize: 40, bold: true, color: COR.verde, margin: 0, isTextBox: true, valign: "middle" });
        s.addText([{ text: lab, options: { bold: true, breakLine: true } }, { text: sub, options: { color: COR.mudo } }], { x: sx + 0.3, y: y + 0.85, w: sw - 0.6, h: sh - 0.95, fontSize: 14, color: COR.tinta, margin: 0, isTextBox: true, valign: "top" });
      });
    }

    // ---------- 4 linear com as fotos
    if (frentes.length) {
      const s = conteudo("Obra", "Diagrama linear do avanço", "Linear", COR.verde);
      const END = EXEC, LX = 2.25, RX = W - M, LW = RX - LX, X = e => LX + (Math.min(e, END) / END) * LW;
      const y0 = 3.2, rh = 0.36, bh = 0.27;
      (av.oae || []).forEach(o => {
        s.addShape(pres.shapes.RECTANGLE, { x: X(o.e0) - 0.03, y: 2.77, w: X(o.e1) - X(o.e0) + 0.06, h: 0.14, fill: { color: COR.azul }, line: { type: "none" } });
        s.addText(o.n.replace("Ponte sobre o", "Ponte s/"), { x: X(o.e0) - 2.6, y: 2.55, w: 2.5, h: 0.28, fontSize: 11, bold: true, color: COR.azul, align: "right", margin: 0, isTextBox: true });
      });
      s.addText("OAC", { x: M, y: 2.88, w: LX - M - 0.15, h: 0.28, fontSize: 11, color: COR.mudo, align: "right", margin: 0, isTextBox: true });
      (av.oac || []).filter(o => o.e <= END).forEach(o => s.addShape(pres.shapes.RECTANGLE, {
        x: X(o.e) - 0.05, y: 2.97, w: 0.1, h: 0.11, fill: { color: o.st === "c" ? COR.laranja : COR.branco }, line: { color: COR.laranja, width: 1 },
      }));
      // fotos com estaca: pinos numerados
      const comEst = fotos.map((f, i) => ({ n: i + 1, e: f.est })).filter(p => p.e !== null && p.e !== undefined && isFinite(p.e) && p.e <= END);
      if (comEst.length) {
        s.addText("Fotos", { x: M, y: 2.08, w: LX - M - 0.15, h: 0.3, fontSize: 11, bold: true, color: COR.verde, align: "right", margin: 0, isTextBox: true });
        const ultimo = [-9, -9];   // duas linhas de círculos para fotos muito próximas
        comEst.sort((a, b) => a.e - b.e).forEach(p => {
          const x = X(p.e), lane = x - ultimo[0] >= 0.32 ? 0 : (x - ultimo[1] >= 0.32 ? 1 : 0); ultimo[lane] = x;
          const cy = 2.08 + lane * 0.34;
          s.addShape(pres.shapes.LINE, { x: x, y: cy + 0.3, w: 0, h: y0 + frentes.length * rh - cy - 0.3, line: { color: "5FAE3E", width: 1, dashType: "dash" } });
          s.addText(String(p.n), { shape: pres.shapes.OVAL, x: x - 0.15, y: cy, w: 0.3, h: 0.3, fill: { color: "5FAE3E" }, color: COR.branco, fontSize: 9, bold: true, align: "center", valign: "middle", margin: 0, isTextBox: true });
        });
      }
      frentes.forEach((f, i) => {
        const y = y0 + i * rh;
        s.addText(curto(f.n), { x: M, y, w: LX - M - 0.15, h: rh, fontSize: 12, color: COR.tinta, align: "right", valign: "middle", margin: 0, isTextBox: true });
        s.addShape(pres.shapes.RECTANGLE, { x: LX, y: y + (rh - bh) / 2, w: LW, h: bh, fill: { color: "F1F3F2" }, line: { type: "none" } });
        let a = 0;
        while (a < END) {
          const c = f.c[a]; let b = a; while (b < END && f.c[b] === c) b++;
          if (c === "1" || c === "2") s.addShape(pres.shapes.RECTANGLE, { x: X(a), y: y + (rh - bh) / 2, w: Math.max(0.02, X(b) - X(a)), h: bh, fill: { color: (c === "2" ? f.cc : f.ca).replace("#", "") }, line: { type: "none" } });
          a = b;
        }
      });
      const yb = y0 + frentes.length * rh;
      for (let e = 0; e <= 600; e += 50) {
        s.addShape(pres.shapes.LINE, { x: X(e), y: yb + 0.02, w: 0, h: 0.08, line: { color: COR.mudo, width: 0.75 } });
        s.addText(String(e), { x: X(e) - 0.3, y: yb + 0.1, w: 0.6, h: 0.25, fontSize: 10, color: COR.mudo, align: "center", margin: 0, isTextBox: true });
      }
      s.addText("estaca", { x: M, y: yb + 0.1, w: LX - M - 0.15, h: 0.25, fontSize: 10, color: COR.mudo, align: "right", margin: 0, isTextBox: true });
      s.addText(`Cor forte: concluído · cor clara: atacado · OAC preenchido: concluído${comEst.length ? " · círculos verdes: fotos deste relatório" : ""}. Retigráfico de ${dataAv}.`,
        { x: LX, y: BOT - 0.22, w: LW, h: 0.28, fontSize: 10, color: COR.mudo, margin: 0, isTextBox: true });
    }

    // ---------- fotos
    pres.addSection({ title: "Fotos" });
    const legenda = (s, i, x, y, w) => {
      const f = fotos[i];
      const meta = [f.est !== null && f.est !== undefined && isFinite(f.est) ? `est. ${estStr(f.est)}` : "", f.lado || "", dataBR(f.dataFoto)].filter(Boolean).join(" · ");
      const runs = [{ text: `Foto ${i + 1}`, options: { bold: true, color: COR.verde } }];
      if (f.desc) runs.push({ text: ` – ${f.desc}`, options: { color: COR.tinta } });
      if (meta) { runs[runs.length - 1].options.breakLine = true; runs.push({ text: meta, options: { color: COR.mudo, fontSize: 11 } }); }
      s.addText(runs, { x, y, w, h: 0.62, fontSize: 13, margin: 0, valign: "top", isTextBox: true });
    };
    const faixa = idx => {
      const es = idx.map(i => fotos[i].est).filter(e => e !== null && e !== undefined && isFinite(e));
      if (!es.length) return "";
      const a = Math.min(...es), b = Math.max(...es);
      return a === b ? `est. ${estStr(a)}` : `est. ${estStr(a)} a ${estStr(b)}`;
    };
    for (const p of plano) {
      const cor = DISC[p.disc] || DISC.Geral;
      const s = conteudo("Fotos", p.disc, p.disc, cor, faixa(p.idx));
      if (p.tipo === "dois") {
        const g = 0.4, w = (CW - g) / 2, h = w / 1.5;
        for (const [k, i] of p.idx.entries()) {
          const x = M + k * (w + g);
          s.addImage({ data: strip(await crop(fotos[i], w / h)), x, y: TOP, w, h, altText: `Foto ${i + 1}` });
          legenda(s, i, x, TOP + h + 0.1, w);
        }
      } else if (p.tipo === "retratos") {
        const g = 0.4, n = p.idx.length, h = BOT - TOP - 0.7, w = Math.min((CW - g * (n - 1)) / n, h * 0.75), x0 = M + (CW - (w * n + g * (n - 1))) / 2;
        for (const [k, i] of p.idx.entries()) {
          const x = x0 + k * (w + g);
          s.addImage({ data: strip(await crop(fotos[i], w / h)), x, y: TOP, w, h, altText: `Foto ${i + 1}` });
          legenda(s, i, x, TOP + h + 0.1, w);
        }
      } else {
        const i = p.idx[0], f = fotos[i], hmax = BOT - TOP - 0.7, ar = f.w / f.h;
        let h = hmax, w = h * ar; if (w > CW) { w = CW; h = w / ar; }
        const x = M + (CW - w) / 2;
        s.addImage({ data: strip(await crop(f, w / h)), x, y: TOP, w, h, altText: `Foto ${i + 1}` });
        legenda(s, i, x, TOP + h + 0.1, Math.max(w, 4));
      }
    }

    // ---------- índice
    pres.addSection({ title: "Registro" });
    const POR = 9;
    for (let k = 0; k < Math.max(1, Math.ceil(fotos.length / POR)); k++) {
      const s = conteudo("Registro", k ? "Registro das fotos (cont.)" : "Registro das fotos", "Índice", COR.verde);
      const hdr = ["Foto", "Disciplina", "Descrição", "Estaca", "Lado", "Data", "Slide"].map(t => ({ text: t, options: { bold: true, color: COR.mudo, fontSize: 11, fill: { color: COR.claro } } }));
      const body = fotos.slice(k * POR, (k + 1) * POR).map((f, j) => {
        const i = k * POR + j;
        return [`Foto ${i + 1}`, f.disc, f.desc || "", estStr(f.est), f.lado || "", dataBR(f.dataFoto), String(slideDe[i])]
          .map((t, c) => ({ text: t, options: { color: COR.tinta, fontSize: 12, bold: c === 0 } }));
      });
      s.addTable([hdr, ...body], { x: M, y: TOP, w: CW, colW: [1.0, 1.9, 5.43, 1.2, 0.8, 1.1, 0.7], rowH: 0.44, border: { type: "solid", pt: 0.75, color: "DCE3DD" }, valign: "middle", margin: [0, 0.1, 0, 0.1] });
    }
    return pres;
  }

  const api = { gerar, planejar, DISC, ORDEM, estStr, EXEC };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RFGerador = api;
})(typeof window !== "undefined" ? window : globalThis);
