# ZNL Hub

Central de acesso às ferramentas do Filipe, publicada no Cloudflare Pages.

| Arquivo | O que é |
|---|---|
| `index.html` | Hub (lista de módulos + terminal) |
| `medicao-dro.html` | Medição → DRO PR-990: lê a medição do DER (PDF/xlsx), a NFS-e e a medição de equipamentos (CEQ) e gera o roteiro do mês para colar no DRO da obra 515 |
| `_worker.js` | Porteiro do site: tela de senha e API `/api/tools` que guarda a lista de módulos no Cloudflare KV (igual em todos os aparelhos) |
| `validacao-terceiros.html` | Validação de Terceiros: confere a parte diária dos basculantes terceiros (período 21 a 20) contra o Painel TCE, com alertas grave, médio e avaliar |
| `relatorio-fotografico.html` | Relatório Fotográfico PR-990: fotos + descrições → PPTX no padrão TCE (capa, localização, avanço e linear pelo retigráfico do app PR990, fotos por disciplina, índice). Gera no navegador com PptxGenJS (`rf/vendor`), lê GPS/data das fotos e acha a estaca pelo eixo (`rf/eixo.json`). Histórico em `/api/rf` (KV) |
| `rf/` | Arquivos do relatório: `gerador.js` (monta o PPTX; roda também no Node), logo, mapa de localização, eixo e cópia do retigráfico |
| `pdf-studio.html` | PDF Studio: junta PDFs, organiza páginas (mover, trocar, remover, duplicar, girar, recortar), extrai e divide (ZIP), edita os textos do PDF na própria fonte e insere números de página e marca d'água. Processa tudo no navegador (PDF.js + pdf-lib + JSZip via cdnjs) |
| `normas.html` | Normas Rodoviárias: busca única nas normas do DNIT, DER-PR, DER-SP, DER-MG e SINFRA-MT (siglas como CBUQ/BGS/TSD acham o nome por extenso), filtros por órgão e tipo, "similares" em outros órgãos, referência para copiar e favoritas sincronizadas em `/api/normas` (KV) |
| `normas/` | `catalogo.json` (gerado pelo coletor) e `coletor/coletar.py`, que lê as páginas oficiais de cada órgão. O workflow `.github/workflows/normas.yml` roda o coletor toda segunda e publica o catálogo se algo mudou; para rodar à mão: aba Actions → "Atualizar catálogo de normas" → Run workflow |

Site estático, sem build. No Cloudflare Pages: framework **None**, comando de build vazio, diretório de saída **/**.

## Senha e dados na nuvem

O `_worker.js` protege todas as páginas com senha e guarda a lista de módulos no KV.
No projeto `znl-hub` do Cloudflare Pages são necessários (em Production e Preview):

- **Binding KV** `HUB_KV` → namespace `znl-hub-data`
- **Secret** `HUB_PASSWORD` → a senha de acesso (definida só no painel do Cloudflare, nunca no código)

Depois de mudar a senha, faça um novo deploy. Sair: `/logout` ou comando `logout` no terminal.
