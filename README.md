# ZNL Hub

Central de acesso às ferramentas do Filipe, publicada no Cloudflare Pages.

| Arquivo | O que é |
|---|---|
| `index.html` | Hub (lista de módulos + terminal) |
| `medicao-dro.html` | Medição → DRO PR-990: lê a medição do DER (PDF/xlsx), a NFS-e e a medição de equipamentos (CEQ) e gera o roteiro do mês para colar no DRO da obra 515 |
| `_worker.js` | Porteiro do site: tela de senha e API `/api/tools` que guarda a lista de módulos no Cloudflare KV (igual em todos os aparelhos) |
| `pdf-studio.html` | PDF Studio: junta PDFs, organiza páginas (mover, trocar, remover, duplicar, girar), extrai páginas e divide um PDF em vários (ZIP). Processa tudo no navegador (PDF.js + pdf-lib + JSZip via cdnjs) |

Site estático, sem build. No Cloudflare Pages: framework **None**, comando de build vazio, diretório de saída **/**.

## Senha e dados na nuvem

O `_worker.js` protege todas as páginas com senha e guarda a lista de módulos no KV.
No projeto `znl-hub` do Cloudflare Pages são necessários (em Production e Preview):

- **Binding KV** `HUB_KV` → namespace `znl-hub-data`
- **Secret** `HUB_PASSWORD` → a senha de acesso (definida só no painel do Cloudflare, nunca no código)

Depois de mudar a senha, faça um novo deploy. Sair: `/logout` ou comando `logout` no terminal.
