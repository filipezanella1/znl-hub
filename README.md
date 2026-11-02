# ZNL Hub

Central de acesso às ferramentas do Filipe, publicada no Cloudflare Pages.

| Arquivo | O que é |
|---|---|
| `index.html` | Hub (lista de módulos + terminal) |
| `medicao-dro.html` | Medição → DRO PR-990: lê a medição do DER (PDF/xlsx), a NFS-e e a medição de equipamentos (CEQ) e gera o roteiro do mês para colar no DRO da obra 515 |
| `pdf-studio.html` | PDF Studio: une, organiza e reordena PDFs (ordem dos documentos, páginas de cada um: mover, excluir, duplicar, girar) e baixa um PDF único. Processa tudo no navegador (PDF.js + pdf-lib via cdnjs) |

Site estático, sem build. No Cloudflare Pages: framework **None**, comando de build vazio, diretório de saída **/**.
