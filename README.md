# ZNL Hub

Central de acesso às ferramentas do Filipe, publicada no Cloudflare Pages.

| Arquivo | O que é |
|---|---|
| `index.html` | Hub (lista de módulos + terminal) |
| `medicao-dro.html` | Medição → DRO PR-990: lê a medição do DER (PDF/xlsx), a NFS-e e a medição de equipamentos (CEQ) e gera o roteiro do mês para colar no DRO da obra 515 |
| `_worker.js` | Porteiro do site: tela de senha e API `/api/tools` que guarda a lista de módulos no Cloudflare KV (igual em todos os aparelhos) |
| `validacao-terceiros.html` | Validação de Terceiros: confere a parte diária dos terceiros contra o Painel TCE (chuva, greve/portaria, falta de diesel), com alertas grave, médio e avaliar. Lança a planilha .xlsx e escolhe o ciclo (21 a 20 ou 1 a 31) e o período |
| `relatorio-fotografico.html` | Relatório Fotográfico PR-990: fotos + descrições → PPTX no padrão TCE (capa, localização, avanço e linear pelo retigráfico do app PR990, fotos por disciplina, índice). Gera no navegador com PptxGenJS (`rf/vendor`), lê GPS/data das fotos e acha a estaca pelo eixo (`rf/eixo.json`). Histórico em `/api/rf` (KV) |
| `rf/` | Arquivos do relatório: `gerador.js` (monta o PPTX; roda também no Node), logo, mapa de localização, eixo e cópia do retigráfico |
| `pdf-studio.html` | PDF Studio: junta PDFs, organiza páginas (mover, trocar, remover, duplicar, girar, recortar), extrai e divide (ZIP), exporta páginas como JPG/PNG, insere assinaturas e imagens, converte páginas e imagens JPG/PNG para SVG (vetorização com imagetracerjs), edita os textos do PDF na própria fonte e insere números de página e marca d'água. Processa tudo no navegador (PDF.js + pdf-lib + JSZip via cdnjs) |
| `normas.html` | Normas Rodoviárias: busca única nas normas do DNIT, DER-PR, DER-SP, DER-MG e SINFRA-MT (siglas como CBUQ/BGS/TSD acham o nome por extenso), filtros por órgão e tipo, "similares" em outros órgãos, referência para copiar e favoritas sincronizadas em `/api/normas` (KV) |
| `dwg-viewer.html` | DWG Viewer: abre DWG (R14 a 2026) e DXF no navegador, com camadas, layouts, seleção com handle/camada/coordenadas/comprimento/área, busca por handle, medidas de distância, área e coordenada com snap (extremidade, meio, centro, quadrante, nó, inserção, próximo) e conversão de versão DWG/DXF (2010, 2013, 2018, 2007, 2004), um arquivo ou vários (ZIP). Cada conversão é relida por um segundo leitor e a contagem de entidades é conferida |
| `dwg/` | Arquivos do DWG Viewer: `worker.js` (lê e monta o desenho fora da tela) e `lib/` com o leitor LibreDWG (`libredwg/`, GPL, via @mlightcad/libredwg-web) e o conversor `dwgconv` (acadrust compilado para WebAssembly, MPL-2.0). Fonte do conversor: crate Rust com `acadrust` + `wasm-bindgen`, função `convert(bytes, versão, formato)` |
| `normas/` | `catalogo.json` (gerado pelo coletor) e `coletor/coletar.py`, que lê as páginas oficiais de cada órgão. O workflow `.github/workflows/normas.yml` roda o coletor toda segunda e publica o catálogo se algo mudou; para rodar à mão: aba Actions → "Atualizar catálogo de normas" → Run workflow |

Site estático, sem build. No Cloudflare Pages: framework **None**, comando de build vazio, diretório de saída **/**.

## Senha e dados na nuvem

O `_worker.js` protege todas as páginas com senha e guarda a lista de módulos no KV.
Exceções: o **PDF Studio** (`/pdf-studio`) e o **DWG Viewer** (`/dwg-viewer`, com os arquivos de `/dwg/`) abrem sem senha, para ter link próprio; eles não leem nada do hub e processam os arquivos no navegador de quem usa. A lista fica em `PUBLIC_PAGES` no `_worker.js`.
No projeto `znl-hub` do Cloudflare Pages são necessários (em Production e Preview):

- **Binding KV** `HUB_KV` → namespace `znl-hub-data`
- **Secret** `HUB_PASSWORD` → a senha de acesso (definida só no painel do Cloudflare, nunca no código)

Depois de mudar a senha, faça um novo deploy.

### ProShot da capa (Relatório Fotográfico)

Recria a foto da capa com IA (OpenAI Images). Opcional; sem a chave o resto do módulo funciona.

- **Secret** `OPENAI_API_KEY` → chave da OpenAI (só no painel do Cloudflare)
- Opcionais: `OPENAI_IMAGE_MODEL` (padrão `gpt-image-1`), `OPENAI_IMAGE_QUALITY` (padrão `high`), `PROSHOT_LIMITE_DIA` (padrão 20) Sair: `/logout` ou comando `logout` no terminal.
