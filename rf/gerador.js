/* Relatório Fotográfico PR-990 — gerador do PPTX.
   Roda no navegador (módulo do hub) e no Node (testes). Não acessa rede nem disco:
   recebe tudo pronto do chamador.

   gerar({ PptxGenJS, cfg, fotos, av, logo, mapa, crop, destaques, proximos, anterior }) → instância pptx
     cfg       : { num: "001", mesLongo: "Outubro de 2026", mesCurto: "out/2026" }
     fotos     : [{ data, w, h, disc, desc, est, lado, dataFoto, capa }] na ordem final
     av        : retigráfico (formato data/avanco.json do app PR990)
     logo,mapa : data URLs
     crop      : async (foto, aspecto, larguraPol) → data URL recortada no aspecto (centro); larguraPol = largura do quadro em polegadas, para o chamador escolher a resolução
     destaques : texto livre, uma linha por destaque (opcional; sem ele os destaques saem do retigráfico)
     proximos  : texto livre, uma linha por item (opcional; entra no resumo executivo)
     anterior  : { num, data, pc: { [nome da frente]: % } } do relatório anterior (opcional; mostra o avanço no mês)

   Sistema visual (decisões):
   - Grade de 12 colunas em 13,333" × 7,5", margem 0,6", calha 0,3". Título sempre no mesmo lugar.
   - Neutros esverdeados (nada de preto puro); um acento: verde TCE. Cores de disciplina só em chips e fios.
   - Títulos afirmam o achado ("CBUQ executado em 66%…"), não o tipo de gráfico.
   - Fotos nunca esticadas: recortadas no quadro. Foto sozinha ocupa o slide inteiro.
*/
(function (root) {
  "use strict";

  const DISC = {
    "Terraplenagem": "9A5B25", "Pavimentação": "3D4247", "Drenagem": "D9731A", "OAE": "2F5597",
    "Sinalização": "B08900", "Obras complementares": "4F7F3A", "Contenções": "6B4F8A", "Geral": "6A7672",
  };
  const ORDEM = Object.keys(DISC);
  // frente do retigráfico que resume cada disciplina (para o selo de avanço nos slides de fotos)
  const FRENTE_DA_DISC = { "Terraplenagem": /corte|aterro/i, "Pavimentação": /CBUQ/i };

  const C = {
    verde: "266131", verdeEsc: "1C4A25", verdeClaro: "A9CFA4", verdeFundo: "EEF4EF",
    tinta: "17211B", texto2: "5B6B63", linha: "E1E7E3", fundo: "F5F7F6", branco: "FFFFFF",
    azul: "2F5597", laranja: "D9731A", resto: "E6EBE8",
  };
  const W = 13.333, H = 7.5, M = 0.6, CW = W - 2 * M, TOP = 2.05, BOT = 6.75;
  const EXEC = 624;  // estacas executáveis

  const estStr = e => {
    if (e === null || e === undefined || !isFinite(e)) return "";
    let i = Math.floor(e + 1e-9), m = Math.round((e - i) * 20 * 100) / 100;
    if (m >= 20) { i += 1; m = 0; }
    return m ? `${i}+${String(m).replace(".", ",")}` : String(i);
  };
  const temEst = f => f.est !== null && f.est !== undefined && isFinite(f.est);
  const dataBR = d => (d && /^\d{4}-\d{2}-\d{2}/.test(d)) ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "";
  const strip = d => String(d).replace(/^data:/, "");
  const nf1 = v => (Math.round(v * 10) / 10).toFixed(1).replace(".", ",");
  const linhas = t => String(t || "").split(/\r?\n/).map(s => s.replace(/^[-•*\s]+/, "").trim()).filter(Boolean);

  // ---------- leitura do retigráfico
  const conta = (f, ch) => { let n = 0; for (let i = 0; i < EXEC; i++) if (f.c[i] === ch) n++; return n; };
  const pcFrente = f => conta(f, "2") / EXEC * 100;
  const paFrente = f => conta(f, "1") / EXEC * 100;
  const kmFalta = f => (EXEC - conta(f, "2")) * 20 / 1000;
  const curto = n => n.replace("Corte – aterro", "Terraplenagem").replace("1ª camada de reforço", "1ª cam. reforço").replace("2ª camada de reforço", "2ª cam. reforço");

  // ---------- agrupamento das fotos em slides
  function planejar(fotos) {
    const slides = [];
    const retrato = x => x.h > x.w * 1.05;
    let i = 0;
    while (i < fotos.length) {
      const f = fotos[i], disc = f.disc;
      if (retrato(f)) {
        const g = [i];
        while (g.length < 3 && i + g.length < fotos.length && fotos[i + g.length].disc === disc && retrato(fotos[i + g.length])) g.push(i + g.length);
        slides.push({ tipo: g.length === 1 ? "retrato" : "retratos", idx: g, disc });
        i += g.length;
      } else {
        const n = fotos[i + 1];
        if (n && n.disc === disc && !retrato(n)) { slides.push({ tipo: "dois", idx: [i, i + 1], disc }); i += 2; }
        else { slides.push({ tipo: "inteira", idx: [i], disc }); i += 1; }
      }
    }
    return slides;
  }

  async function gerar({ PptxGenJS, cfg, fotos, av, logo, mapa, crop, destaques, proximos, anterior }) {
    const pres = new PptxGenJS();
    pres.layout = "LAYOUT_WIDE";
    pres.theme = { headFontFace: "Calibri", bodyFontFace: "Calibri" };
    pres.title = `Relatório Fotográfico nº ${cfg.num} – PR-990`;
    pres.author = "TCE Engenharia";
    pres.company = "TCE Engenharia";

    const rodape = { text: { text: "TCE ENGENHARIA  ·  Contrato CO 050/2024 DER/DT · DER-PR", options: { x: M, y: 7.0, w: 7, h: 0.28, fontSize: 9, color: C.texto2, margin: 0, charSpacing: 0.5 } } };
    pres.defineSlideMaster({ title: "CAPA", background: { color: C.verdeEsc }, objects: [] });
    pres.defineSlideMaster({
      title: "CONTEUDO", background: { color: C.branco }, margin: [0.5, M, 0.6, M],
      objects: [
        { image: { data: strip(logo), x: M, y: 0.24, w: 0.36, h: 0.56 } },
        { text: { text: "PR-990 · Obra 515", options: { x: M + 0.5, y: 0.37, w: 5, h: 0.3, fontSize: 11, bold: true, color: C.verde, margin: 0 } } },
        { text: { text: `Relatório Fotográfico nº ${cfg.num} · ${cfg.mesCurto}`, options: { x: W - M - 5, y: 0.37, w: 5, h: 0.3, fontSize: 10, color: C.texto2, align: "right", margin: 0 } } },
        rodape,
        { placeholder: { options: { name: "title", type: "title", x: M, y: 1.28, w: CW, h: 0.64, fontSize: 28, bold: true, color: C.tinta, margin: 0, valign: "middle", align: "left" }, text: "" } },
      ],
      slideNumber: { x: W - M - 0.6, y: 7.0, w: 0.6, h: 0.28, fontSize: 9, color: C.texto2, align: "right" },
    });
    pres.defineSlideMaster({ title: "FOTO", background: { color: C.tinta }, objects: [], slideNumber: { x: W - M - 0.6, y: 7.02, w: 0.6, h: 0.28, fontSize: 9, color: C.branco, align: "right" } });

    const chip = (s, t, cor, x = M, y = 0.93) => s.addText(t.toUpperCase(), {
      shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.05, x, y, w: 0.24 + t.length * 0.1, h: 0.3,
      fill: { color: cor }, color: C.branco, fontSize: 9.5, bold: true, charSpacing: 1.5, align: "center", valign: "middle", margin: 0, isTextBox: true,
    });
    const conteudo = (secao, titulo, chipT, chipC, extra = {}) => {
      const s = pres.addSlide({ masterName: "CONTEUDO", sectionTitle: secao });
      chip(s, chipT, chipC);
      s.addText(titulo, { placeholder: "title" });
      if (extra.loc) s.addText(extra.loc, { x: W - M - 4, y: 0.93, w: 4, h: 0.3, fontSize: 11, color: C.texto2, align: "right", valign: "middle", margin: 0, isTextBox: true });
      if (extra.selo) selo(s, extra.selo, W - M, 1.42);
      return s;
    };
    // selo de avanço (ex.: "CBUQ 66% concluído  +4 pp")
    function selo(s, { rotulo, valor, delta }, xDir, y) {
      const runs = [{ text: rotulo + "  ", options: { color: C.texto2 } }, { text: valor, options: { bold: true, color: C.verde } }];
      if (delta) runs.push({ text: "   " + delta, options: { bold: true, color: C.verde } });
      const w = 0.5 + (rotulo.length + valor.length + (delta ? delta.length + 3 : 0)) * 0.085;
      s.addText(runs, { shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.15, x: xDir - w, y, w, h: 0.38, fill: { color: C.verdeFundo }, fontSize: 12, align: "center", valign: "middle", margin: 0, isTextBox: true });
    }

    const frentes = (av && av.frentes) || [];
    const dataAv = av && av.data ? av.data.split("-").reverse().join("/") : "";
    const fr = re => frentes.find(f => re.test(f.n));
    const cbuq = fr(/CBUQ/i), terr = fr(/corte|aterro/i) || frentes[0], bgs = fr(/BGS/i);
    const oac = ((av && av.oac) || []).filter(o => o.e <= EXEC), oacOk = oac.filter(o => o.st === "c").length;
    const delta = f => {
      if (!anterior || !anterior.pc || anterior.pc[f.n] === undefined) return "";
      const d = pcFrente(f) - anterior.pc[f.n];
      return Math.abs(d) < 0.05 ? "" : (d > 0 ? "+" : "−") + nf1(Math.abs(d)) + " pp";
    };

    const plano = planejar(fotos);
    const temProx = linhas(proximos).length > 0;
    const PRIMEIRA_FOTO = 6; // capa, localização, resumo, avanço, linear
    const slideDe = [];
    plano.forEach((p, k) => p.idx.forEach(i => { slideDe[i] = PRIMEIRA_FOTO + k; }));

    // ================= 1 CAPA: foto inteira, painel verde à esquerda
    pres.addSection({ title: "Capa" });
    {
      const s = pres.addSlide({ masterName: "CAPA", sectionTitle: "Capa" });
      const ci = Math.max(0, fotos.findIndex(f => f.capa));
      if (fotos.length) s.addImage({ data: strip(await crop(fotos[ci], W / H, W)), x: 0, y: 0, w: W, h: H, altText: "Foto de destaque do mês" });
      s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 5.9, h: H, fill: { color: C.verdeEsc, transparency: 6 }, line: { type: "none" } });
      const L = 0.75, TW = 4.6;
      s.addShape(pres.shapes.RECTANGLE, { x: L, y: 0.7, w: 0.86, h: 1.22, fill: { color: C.branco }, line: { type: "none" } });
      s.addImage({ data: strip(logo), x: L + 0.06, y: 0.76, w: 0.74, h: 1.1, altText: "Logo TCE Engenharia" });
      s.addText("RELATÓRIO FOTOGRÁFICO\nDE ACOMPANHAMENTO DE OBRA", { x: L, y: 2.55, w: TW, h: 0.6, fontSize: 12, bold: true, charSpacing: 2, color: C.verdeClaro, margin: 0, isTextBox: true, valign: "top", paraSpaceAfter: 0 });
      s.addText("PR-990", { x: L, y: 3.2, w: TW, h: 1.15, fontSize: 72, bold: true, color: C.branco, margin: 0, isTextBox: true });
      s.addText("Implantação entre a PR-364 e a Cidade de Rebouças", { x: L, y: 4.35, w: TW, h: 0.75, fontSize: 18, color: C.branco, margin: 0, isTextBox: true, valign: "top" });
      s.addText([{ text: `Nº ${cfg.num}`, options: { bold: true, color: C.branco } }, { text: `   ${cfg.mesLongo}`, options: { color: C.branco } }],
        { x: L, y: 5.3, w: TW, h: 0.45, fontSize: 18, margin: 0, isTextBox: true });
      s.addShape(pres.shapes.LINE, { x: L, y: 6.2, w: TW, h: 0, line: { color: C.verdeClaro, width: 0.75, transparency: 40 } });
      s.addText("TCE Engenharia · Obra 515 · Contrato CO 050/2024 DER/DT · DER-PR", { x: L, y: 6.35, w: TW, h: 0.5, fontSize: 10.5, color: C.verdeClaro, margin: 0, isTextBox: true, valign: "top" });
    }

    // ================= 2 LOCALIZAÇÃO
    pres.addSection({ title: "Obra" });
    {
      const s = conteudo("Obra", "12,9 km de rodovia nova entre a PR-364 e Rebouças", "Localização", C.verde);
      const mh = CW * 858 / 3153;
      s.addImage({ data: strip(mapa), x: M, y: TOP - 0.05, w: CW, h: mh, altText: "Localização: Brasil, Paraná, município de Rebouças e trecho da PR-990" });
      const rows = [["Rodovia", "PR-990 – implantação"], ["Trecho", "PR-364 – Cidade de Rebouças"], ["Segmento", "km 0+000 a 12+883,96"],
        ["Contrato", "CO 050/2024 DER/DT"], ["Contratada", "TCE Engenharia Ltda."], ["OAE", "Ponte s/ Rio do Salto (235+6 a 237+1)"]];
      const fy = TOP + mh + 0.2, c3 = (CW - 0.6) / 3, rh = 0.62;
      rows.forEach(([k, v], i) => s.addText([
        { text: k.toUpperCase(), options: { fontSize: 9.5, color: C.texto2, bold: true, charSpacing: 1, breakLine: true } },
        { text: v, options: { fontSize: 14, color: C.tinta } },
      ], { x: M + (i % 3) * (c3 + 0.3), y: fy + Math.floor(i / 3) * rh, w: c3, h: rh, margin: 0, valign: "top", isTextBox: true }));
    }

    // ================= 3 RESUMO EXECUTIVO
    pres.addSection({ title: "Situação" });
    {
      const titulo = cbuq ? `CBUQ em ${Math.round(pcFrente(cbuq))}% do trecho; faltam ${nf1(kmFalta(cbuq))} km` : "Resumo do mês";
      const s = conteudo("Situação", titulo, "Resumo executivo", C.verde);
      const kpis = [];
      if (cbuq) kpis.push([`${Math.round(pcFrente(cbuq))}%`, "CBUQ executado", delta(cbuq) || `faltam ${nf1(kmFalta(cbuq))} km`]);
      if (bgs) kpis.push([`${Math.round(pcFrente(bgs))}%`, "Base BGS executada", delta(bgs) || `faltam ${nf1(kmFalta(bgs))} km`]);
      if (terr) kpis.push([`${Math.round(pcFrente(terr))}%`, "Terraplenagem concluída", delta(terr) || `+ ${Math.round(paFrente(terr))}% em andamento`]);
      if (oac.length) kpis.push([`${oacOk}/${oac.length}`, "Bueiros e galerias", "concluídos"]);
      kpis.push([String(fotos.length), "Fotos no relatório", `${new Set(fotos.map(f => f.disc)).size} frentes de serviço`]);
      const n = kpis.length, g = 0.3, kw = (CW - g * (n - 1)) / n, kh = 1.55;
      kpis.forEach(([big, lab, sub], i) => {
        const x = M + i * (kw + g);
        s.addShape(pres.shapes.RECTANGLE, { x, y: TOP, w: kw, h: kh, fill: { color: i === 0 ? C.verde : C.fundo }, line: { type: "none" } });
        const cor = i === 0 ? C.branco : C.tinta, cor2 = i === 0 ? C.verdeClaro : C.texto2;
        s.addText(big, { x: x + 0.25, y: TOP + 0.18, w: kw - 0.5, h: 0.7, fontSize: 36, bold: true, color: i === 0 ? C.branco : C.verde, margin: 0, isTextBox: true, valign: "middle" });
        s.addText([{ text: lab, options: { bold: true, color: cor, breakLine: true } }, { text: sub, options: { color: cor2 } }],
          { x: x + 0.25, y: TOP + 0.9, w: kw - 0.4, h: 0.58, fontSize: 12, margin: 0, isTextBox: true, valign: "top" });
      });
      // destaques
      let dest = linhas(destaques);
      if (!dest.length) {
        if (cbuq) dest.push(`CBUQ executado em ${nf1(pcFrente(cbuq))}% das estacas do trecho executável; faltam ${nf1(kmFalta(cbuq))} km.`);
        if (bgs && cbuq) dest.push(`BGS à frente do CBUQ: ${nf1(pcFrente(bgs))}% executada, liberando ${nf1(Math.max(0, (pcFrente(bgs) - pcFrente(cbuq)) * EXEC * 20 / 100 / 1000))} km para CBUQ.`);
        if (terr) dest.push(`Terraplenagem ${nf1(pcFrente(terr))}% concluída e ${nf1(paFrente(terr))}% em andamento.`);
        if (oac.length) dest.push(`${oacOk} de ${oac.length} bueiros e galerias concluídos.`);
      }
      const y2 = TOP + kh + 0.45, colL = temProx ? 7.0 : CW;
      s.addText("DESTAQUES DO MÊS", { x: M, y: y2, w: colL, h: 0.3, fontSize: 10, bold: true, charSpacing: 1.5, color: C.texto2, margin: 0, isTextBox: true });
      s.addText(dest.slice(0, 5).map((t, i, a) => ({ text: t, options: { bullet: { indent: 16 }, breakLine: i < a.length - 1 } })),
        { x: M, y: y2 + 0.38, w: colL, h: BOT - y2 - 0.38, fontSize: 15, color: C.tinta, margin: 0, valign: "top", paraSpaceAfter: 8, isTextBox: true });
      if (temProx) {
        const px = M + colL + 0.5, pw = CW - colL - 0.5;
        s.addShape(pres.shapes.RECTANGLE, { x: px, y: y2 - 0.1, w: pw, h: BOT - y2 + 0.1, fill: { color: C.verdeFundo }, line: { type: "none" } });
        s.addText("PRÓXIMOS PASSOS", { x: px + 0.3, y: y2 + 0.08, w: pw - 0.6, h: 0.3, fontSize: 10, bold: true, charSpacing: 1.5, color: C.verde, margin: 0, isTextBox: true });
        const it = linhas(proximos).slice(0, 5);
        s.addText(it.map((t, i) => ({ text: t, options: { bullet: { type: "number" }, breakLine: i < it.length - 1 } })),
          { x: px + 0.3, y: y2 + 0.46, w: pw - 0.6, h: BOT - y2 - 0.6, fontSize: 14, color: C.tinta, margin: 0, valign: "top", paraSpaceAfter: 6, isTextBox: true });
      }
    }

    // ================= 4 AVANÇO POR FRENTE (barras desenhadas: concluído | em andamento | a executar)
    if (frentes.length) {
      const titulo = cbuq && bgs ? `BGS pronta em ${Math.round(pcFrente(bgs))}% e CBUQ em ${Math.round(pcFrente(cbuq))}% do trecho` : `Avanço físico até ${dataAv}`;
      const s = conteudo("Situação", titulo, "Avanço físico", C.verde, { loc: `retigráfico de ${dataAv}` });
      const LX = M + 1.75, BW = 6.0, rh = (BOT - TOP - 0.55) / frentes.length, bh = Math.min(0.34, rh * 0.62);
      frentes.forEach((f, i) => {
        const y = TOP + 0.1 + i * rh, pc = pcFrente(f), pa = paFrente(f), dest = /CBUQ/i.test(f.n);
        s.addText(curto(f.n), { x: M, y, w: 1.6, h: rh, fontSize: 13, bold: dest, color: C.tinta, align: "right", valign: "middle", margin: 0, isTextBox: true });
        const by = y + (rh - bh) / 2;
        s.addShape(pres.shapes.RECTANGLE, { x: LX, y: by, w: BW, h: bh, fill: { color: C.resto }, line: { type: "none" } });
        if (pa > 0) s.addShape(pres.shapes.RECTANGLE, { x: LX + BW * pc / 100, y: by, w: BW * pa / 100, h: bh, fill: { color: C.verdeClaro }, line: { type: "none" } });
        s.addShape(pres.shapes.RECTANGLE, { x: LX, y: by, w: BW * pc / 100, h: bh, fill: { color: dest ? C.verde : "4E7F57" }, line: { type: "none" } });
        const d = delta(f);
        s.addText([{ text: `${Math.round(pc)}%`, options: { bold: true, color: C.tinta } }].concat(d ? [{ text: `  ${d}`, options: { color: C.verde, bold: true, fontSize: 11 } }] : []),
          { x: LX + BW + 0.15, y, w: 1.3, h: rh, fontSize: 14, valign: "middle", margin: 0, isTextBox: true });
      });
      // legenda
      const ly = BOT - 0.3;
      [["4E7F57", "concluído"], [C.verdeClaro, "em andamento"], [C.resto, "a executar"]].forEach(([cor, t], k) => {
        s.addShape(pres.shapes.RECTANGLE, { x: LX + k * 1.7, y: ly + 0.08, w: 0.16, h: 0.16, fill: { color: cor }, line: { type: "none" } });
        s.addText(t, { x: LX + k * 1.7 + 0.24, y: ly, w: 1.4, h: 0.32, fontSize: 10.5, color: C.texto2, margin: 0, valign: "middle", isTextBox: true });
      });
      // painel lateral: quanto falta, em km
      const px = 9.95, pw = W - M - px;
      s.addShape(pres.shapes.RECTANGLE, { x: px, y: TOP, w: pw, h: BOT - TOP, fill: { color: C.fundo }, line: { type: "none" } });
      s.addText("A EXECUTAR", { x: px + 0.3, y: TOP + 0.25, w: pw - 0.6, h: 0.3, fontSize: 10, bold: true, charSpacing: 1.5, color: C.texto2, margin: 0, isTextBox: true });
      const falta = [cbuq, bgs, terr].filter(Boolean);
      falta.forEach((f, k) => {
        const y = TOP + 0.7 + k * 1.3;
        s.addText([{ text: nf1(kmFalta(f)), options: { fontSize: 34, bold: true, color: C.verde } }, { text: " km", options: { fontSize: 16, color: C.verde } }],
          { x: px + 0.3, y, w: pw - 0.6, h: 0.6, margin: 0, valign: "bottom", isTextBox: true });
        s.addText(curto(f.n), { x: px + 0.3, y: y + 0.62, w: pw - 0.6, h: 0.3, fontSize: 12, color: C.tinta, margin: 0, isTextBox: true });
      });
      s.addText(`Trecho executável: est. 0 a ${EXEC} (${nf1(EXEC * 20 / 1000)} km).`, { x: px + 0.3, y: BOT - 0.6, w: pw - 0.6, h: 0.45, fontSize: 9.5, color: C.texto2, margin: 0, valign: "bottom", isTextBox: true });
    }

    // ================= 5 LINEAR com as fotos
    if (frentes.length) {
      const s = conteudo("Situação", "Onde estamos na obra e onde foram tiradas as fotos", "Diagrama linear", C.verde, { loc: `retigráfico de ${dataAv}` });
      const END = EXEC, LX = 2.25, RX = W - M, LW = RX - LX, X = e => LX + (Math.min(e, END) / END) * LW;
      const y0 = 3.2, rh = 0.34, bh = 0.25;
      (av.oae || []).forEach(o => {
        s.addShape(pres.shapes.RECTANGLE, { x: X(o.e0) - 0.03, y: 2.77, w: X(o.e1) - X(o.e0) + 0.06, h: 0.14, fill: { color: C.azul }, line: { type: "none" } });
        s.addText(o.n.replace("Ponte sobre o", "Ponte s/"), { x: X(o.e0) - 2.6, y: 2.7, w: 2.5, h: 0.28, fontSize: 10.5, bold: true, color: C.azul, align: "right", margin: 0, isTextBox: true });
      });
      s.addText("OAC", { x: M, y: 2.88, w: LX - M - 0.15, h: 0.28, fontSize: 10.5, color: C.texto2, align: "right", margin: 0, isTextBox: true });
      oac.forEach(o => s.addShape(pres.shapes.RECTANGLE, { x: X(o.e) - 0.05, y: 2.97, w: 0.1, h: 0.11, fill: { color: o.st === "c" ? C.laranja : C.branco }, line: { color: C.laranja, width: 1 } }));
      const pinos = fotos.map((f, i) => ({ n: i + 1, e: f.est })).filter(p => temEst(p) && p.e <= END).sort((a, b) => a.e - b.e);
      const yb = y0 + frentes.length * rh;
      if (pinos.length) {
        s.addText("Fotos", { x: M, y: 2.08, w: LX - M - 0.15, h: 0.3, fontSize: 10.5, bold: true, color: C.verde, align: "right", margin: 0, isTextBox: true });
        const ult = [-9, -9];
        pinos.forEach(p => {
          const x = X(p.e), lane = x - ult[0] >= 0.32 ? 0 : (x - ult[1] >= 0.32 ? 1 : 0); ult[lane] = x;
          const cy = 2.08 + lane * 0.34;
          s.addShape(pres.shapes.LINE, { x, y: cy + 0.3, w: 0, h: yb - cy - 0.3, line: { color: C.verde, width: 0.75, dashType: "dash", transparency: 30 } });
          s.addText(String(p.n), { shape: pres.shapes.OVAL, x: x - 0.15, y: cy, w: 0.3, h: 0.3, fill: { color: C.verde }, color: C.branco, fontSize: 9, bold: true, align: "center", valign: "middle", margin: 0, isTextBox: true });
        });
      }
      frentes.forEach((f, i) => {
        const y = y0 + i * rh;
        s.addText(curto(f.n), { x: M, y, w: LX - M - 0.15, h: rh, fontSize: 11.5, color: C.tinta, align: "right", valign: "middle", margin: 0, isTextBox: true });
        s.addShape(pres.shapes.RECTANGLE, { x: LX, y: y + (rh - bh) / 2, w: LW, h: bh, fill: { color: "F1F3F2" }, line: { type: "none" } });
        let a = 0;
        while (a < END) {
          const ch = f.c[a]; let b = a; while (b < END && f.c[b] === ch) b++;
          if (ch === "1" || ch === "2") s.addShape(pres.shapes.RECTANGLE, { x: X(a), y: y + (rh - bh) / 2, w: Math.max(0.02, X(b) - X(a)), h: bh, fill: { color: (ch === "2" ? f.cc : f.ca).replace("#", "") }, line: { type: "none" } });
          a = b;
        }
      });
      // escala dupla: estaca em cima da régua, km embaixo
      for (let e = 0; e <= 600; e += 50) {
        s.addShape(pres.shapes.LINE, { x: X(e), y: yb + 0.02, w: 0, h: 0.08, line: { color: C.texto2, width: 0.75 } });
        s.addText(String(e), { x: X(e) - 0.3, y: yb + 0.1, w: 0.6, h: 0.22, fontSize: 9.5, color: C.texto2, align: "center", margin: 0, isTextBox: true });
      }
      for (let km = 2; km <= 12; km += 2) s.addText(`km ${km}`, { x: X(km * 50) - 0.35, y: yb + 0.32, w: 0.7, h: 0.22, fontSize: 9.5, bold: true, color: C.tinta, align: "center", margin: 0, isTextBox: true });
      s.addText([{ text: "estaca", options: { breakLine: true } }, { text: "km", options: { bold: true, color: C.tinta } }], { x: M, y: yb + 0.1, w: LX - M - 0.15, h: 0.45, fontSize: 9.5, color: C.texto2, align: "right", margin: 0, isTextBox: true, paraSpaceAfter: 0 });
      s.addText(`Cor forte: concluído · cor clara: em andamento · OAC preenchido: concluído${pinos.length ? " · círculos verdes: fotos deste relatório" : ""}.`,
        { x: LX, y: BOT - 0.15, w: LW, h: 0.26, fontSize: 9.5, color: C.texto2, margin: 0, isTextBox: true });
    }

    // ================= FOTOS
    pres.addSection({ title: "Fotos" });
    const meta = f => [temEst(f) ? `est. ${estStr(f.est)}` : "", f.lado || "", dataBR(f.dataFoto)].filter(Boolean).join("  ·  ");
    const legenda = (s, i, x, y, w, escuro) => {
      const f = fotos[i], m = meta(f);
      const runs = [{ text: `Foto ${i + 1}`, options: { bold: true, color: escuro ? C.verdeClaro : C.verde } }];
      if (f.desc) runs.push({ text: `  ${f.desc}`, options: { color: escuro ? C.branco : C.tinta } });
      if (m) { runs[runs.length - 1].options.breakLine = true; runs.push({ text: m, options: { color: escuro ? "C9D6CE" : C.texto2, fontSize: 10.5 } }); }
      s.addText(runs, { x, y, w, h: 0.62, fontSize: 13, margin: 0, valign: "top", isTextBox: true });
    };
    const faixa = idx => {
      const es = idx.map(i => fotos[i]).filter(temEst).map(f => f.est);
      if (!es.length) return "";
      const a = Math.min(...es), b = Math.max(...es);
      return a === b ? `est. ${estStr(a)}` : `est. ${estStr(a)} a ${estStr(b)}`;
    };
    const seloDisc = disc => {
      if (disc === "Drenagem" && oac.length) return { rotulo: "OAC", valor: `${oacOk}/${oac.length} concluídos` };
      const re = FRENTE_DA_DISC[disc]; const f = re && fr(re);
      return f ? { rotulo: curto(f.n), valor: `${Math.round(pcFrente(f))}% concluído`, delta: delta(f) } : null;
    };
    for (const p of plano) {
      const cor = DISC[p.disc] || DISC.Geral;
      if (p.tipo === "inteira") {
        // foto sozinha: ocupa o slide inteiro; legenda num cartão branco
        const i = p.idx[0], f = fotos[i];
        const s = pres.addSlide({ masterName: "FOTO", sectionTitle: "Fotos" });
        s.addImage({ data: strip(await crop(f, W / H, W)), x: 0, y: 0, w: W, h: H, altText: `Foto ${i + 1}` });
        chip(s, p.disc, cor, M, 0.5);
        const m = meta(f), cw = (f.desc || m) ? 5.9 : 1.5, chh = m ? 1.05 : 0.8;
        s.addShape(pres.shapes.RECTANGLE, { x: M, y: H - M - chh, w: cw, h: chh, fill: { color: C.branco }, line: { type: "none" }, shadow: { type: "outer", color: "000000", opacity: 0.25, blur: 8, offset: 2, angle: 90 } });
        legenda(s, i, M + 0.25, H - M - chh + 0.2, cw - 0.5, false);
        s.addShape(pres.shapes.RECTANGLE, { x: W - M - 0.62, y: H - M - 0.86, w: 0.62, h: 0.86, fill: { color: C.branco }, line: { type: "none" } });
        s.addImage({ data: strip(logo), x: W - M - 0.57, y: H - M - 0.81, w: 0.52, h: 0.76 });
        continue;
      }
      const s = conteudo("Fotos", p.disc, p.disc, cor, { loc: faixa(p.idx), selo: seloDisc(p.disc) });
      if (p.tipo === "dois") {
        const g = 0.3, w = (CW - g) / 2, h = w / 1.5;
        for (const [k, i] of p.idx.entries()) {
          const x = M + k * (w + g);
          s.addImage({ data: strip(await crop(fotos[i], w / h, w)), x, y: TOP, w, h, altText: `Foto ${i + 1}` });
          legenda(s, i, x, TOP + h + 0.12, w);
        }
      } else {
        const g = 0.3, n = p.idx.length, h = BOT - TOP - 0.7, w = Math.min((CW - g * (n - 1)) / n, h * 0.75), x0 = M + (CW - (w * n + g * (n - 1))) / 2;
        for (const [k, i] of p.idx.entries()) {
          const x = x0 + k * (w + g);
          s.addImage({ data: strip(await crop(fotos[i], w / h, w)), x, y: TOP, w, h, altText: `Foto ${i + 1}` });
          legenda(s, i, x, TOP + h + 0.12, Math.max(w, 3));
        }
      }
    }

    // ================= ANEXO: índice das fotos
    pres.addSection({ title: "Anexo" });
    const POR = 9;
    for (let k = 0; k < Math.max(1, Math.ceil(fotos.length / POR)); k++) {
      const s = conteudo("Anexo", k ? "Registro das fotos (continuação)" : "Registro das fotos", "Anexo", C.texto2);
      const hdr = ["Foto", "Disciplina", "Descrição", "Estaca", "Lado", "Data", "Slide"].map(t => ({ text: t.toUpperCase(), options: { bold: true, color: C.texto2, fontSize: 9.5, charSpacing: 1 } }));
      const body = fotos.slice(k * POR, (k + 1) * POR).map((f, j) => {
        const i = k * POR + j;
        return [String(i + 1), f.disc, f.desc || "—", estStr(f.est) || "—", f.lado || "—", dataBR(f.dataFoto) || "—", String(slideDe[i])]
          .map((t, c) => ({ text: t, options: { color: t === "—" ? "A3B0A9" : C.tinta, fontSize: 12, bold: c === 0 } }));
      });
      s.addTable([hdr, ...body], {
        x: M, y: TOP, w: CW, colW: [0.7, 1.9, 5.73, 1.2, 0.8, 1.1, 0.7], rowH: 0.44,
        border: [{ type: "none" }, { type: "none" }, { type: "solid", pt: 0.75, color: C.linha }, { type: "none" }], valign: "middle", margin: [0, 0.08, 0, 0.08],
      });
    }
    return pres;
  }

  // percentuais por frente, para guardar no histórico e comparar no mês seguinte
  const resumoAvanco = av => ({ data: av && av.data, pc: Object.fromEntries(((av && av.frentes) || []).map(f => [f.n, Math.round(pcFrente(f) * 10) / 10])) });

  const api = { gerar, planejar, resumoAvanco, DISC, ORDEM, estStr, EXEC };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RFGerador = api;
})(typeof window !== "undefined" ? window : globalThis);
