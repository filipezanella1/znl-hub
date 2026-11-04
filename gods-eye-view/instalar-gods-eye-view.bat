<# : -- parte em lote: abre este mesmo arquivo no PowerShell
@echo off
title Instalador God's Eye View (znl-hub)
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0', [Text.Encoding]::UTF8))"
echo.
pause
exit /b
#>

# ===== Instalador do God's Eye View para abrir pelo celular (via Tailscale) =====
# 1. Instala Git, Node.js e Tailscale (se faltarem)
# 2. Baixa o God's Eye View em %USERPROFILE%\gods-eye-view
# 3. Publica o app so na sua rede Tailscale, com HTTPS (tailscale serve)
# 4. Faz o app iniciar sozinho quando o Windows liga

$ErrorActionPreference = 'Stop'
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Green }
function Info($t) { Write-Host "    $t" -ForegroundColor Gray }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Find-Cmd($cmd, $fallback) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  if ($fallback -and (Test-Path $fallback)) { return $fallback }
  return $null
}
function Ensure($cmd, $id, $name, $fallback) {
  Refresh-Path
  $p = Find-Cmd $cmd $fallback
  if ($p) { Info "$name ja instalado."; return $p }
  Step "Instalando $name (se o Windows pedir permissao, clique em Sim)"
  winget install --id $id -e --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
  if (-not (Find-Cmd $cmd $fallback)) {
    Info "Tentando de novo pelo nome..."
    winget install $name --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
  }
  $p = Find-Cmd $cmd $fallback
  if (-not $p) { throw "Nao consegui instalar $name. Feche esta janela e rode o instalador de novo." }
  return $p
}

try {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "O winget nao foi encontrado. Abra a Microsoft Store, atualize o 'Instalador de Aplicativo' e rode este arquivo de novo."
  }

  Step "Conferindo os programas necessarios"
  $git  = Ensure 'git' 'Git.Git' 'Git' "$env:ProgramFiles\Git\cmd\git.exe"
  $node = Ensure 'node' 'OpenJS.NodeJS.LTS' 'Node.js' "$env:ProgramFiles\nodejs\node.exe"
  $npm  = Find-Cmd 'npm.cmd' "$env:ProgramFiles\nodejs\npm.cmd"
  $ts   = Ensure 'tailscale' 'Tailscale.Tailscale' 'Tailscale' "$env:ProgramFiles\Tailscale\tailscale.exe"

  $v = [version]((& $node -v).TrimStart('v'))
  $okNode = ($v.Major -eq 24 -and $v -ge [version]'24.14.0') -or ($v.Major -eq 26)
  if (-not $okNode) {
    Step "Atualizando o Node.js ($v e antigo para este app)"
    winget upgrade --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    $v = [version]((& $node -v).TrimStart('v'))
    $okNode = ($v.Major -eq 24 -and $v -ge [version]'24.14.0') -or ($v.Major -eq 26)
    if (-not $okNode) { throw "O app precisa do Node.js 24.14 ou 26; este computador tem o $v." }
  }
  Info "Node.js $v ok."

  Step "Entrando no Tailscale"
  $st = $null
  try { $st = & $ts status --json 2>$null | ConvertFrom-Json } catch {}
  if (-not $st -or $st.BackendState -ne 'Running') {
    Info "Vai aparecer um link (ou abrir o navegador). Entre com a conta que voce vai usar tambem no celular."
    Info "Depois de entrar, volte para esta janela."
    & $ts up
    if ($LASTEXITCODE -ne 0) { throw "O login no Tailscale nao terminou." }
    $st = & $ts status --json | ConvertFrom-Json
  }
  $dns = ($st.Self.DNSName).TrimEnd('.')
  if (-not $dns) { throw "Nao consegui ler o nome deste computador no Tailscale." }
  Info "Este computador no Tailscale: $dns"

  $dir = Join-Path $env:USERPROFILE 'gods-eye-view'
  Step "Baixando o God's Eye View em $dir"
  if (Test-Path (Join-Path $dir '.git')) {
    & $git -C $dir pull --ff-only
  } else {
    & $git clone --depth 1 https://github.com/bilawalsidhu/gods-eye-view.git $dir
  }
  if ($LASTEXITCODE -ne 0) { throw "Falhou ao baixar o app do GitHub." }

  Step "Instalando as dependencias do app (pode levar alguns minutos)"
  Push-Location $dir
  & $npm ci
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "Falhou ao instalar as dependencias (npm ci)." }

  Step "Criando o iniciador automatico"
  $starter = Join-Path $dir 'iniciar-znl.cmd'
  $cmd = @"
@echo off
title God's Eye View (servidor - deixe aberto)
cd /d "$dir"
set "PATH=$env:ProgramFiles\nodejs;%PATH%"
set GEV_ALLOWED_HOSTS=$dns
:loop
call npm run dev -- --port 4173 --strictPort
timeout /t 15 >nul
goto loop
"@
  Set-Content -Path $starter -Value $cmd -Encoding ASCII
  $vbs = Join-Path $dir 'iniciar-znl.vbs'
  Set-Content -Path $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run """' + $starter + '""", 7, False')
  $startup = [Environment]::GetFolderPath('Startup')
  Copy-Item $vbs (Join-Path $startup 'GodsEyeView-znl.vbs') -Force
  Info "O app vai iniciar sozinho (minimizado) sempre que o Windows ligar."

  Step "Ligando o app agora"
  $up = $false
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:4173/ | Out-Null; $up = $true } catch {}
  if (-not $up) {
    Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
      Start-Sleep -Seconds 3
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:4173/ | Out-Null; $up = $true } catch {}
    }
  }
  if (-not $up) { throw "O app nao respondeu em localhost:4173. Veja a janela minimizada 'God's Eye View' na barra de tarefas." }
  Info "App respondendo em http://localhost:4173"

  Step "Publicando o app so na sua rede Tailscale (HTTPS)"
  Info "Se aparecer um link pedindo para ativar HTTPS/Serve, abra, confirme e volte aqui."
  & $ts serve --bg 4173
  if ($LASTEXITCODE -ne 0) { throw "O 'tailscale serve' nao foi ativado." }

  $url = "https://$dns/"
  $desk = [Environment]::GetFolderPath('Desktop')
  Set-Content -Path (Join-Path $desk 'endereco-gods-eye-view.txt') -Encoding UTF8 -Value @"
Endereco do God's Eye View para o celular:
$url

No celular: instale o app Tailscale, entre com a mesma conta e deixe-o ligado.
Depois abra o endereco acima (ou cole no card God's Eye View do znl-hub).
"@
  try { Set-Clipboard -Value $url } catch {}

  Write-Host ""
  Write-Host "================================================================" -ForegroundColor Green
  Write-Host " PRONTO. Endereco para o celular (ja copiado):" -ForegroundColor Green
  Write-Host "   $url" -ForegroundColor Yellow
  Write-Host " Tambem salvei em endereco-gods-eye-view.txt na Area de Trabalho." -ForegroundColor Green
  Write-Host "================================================================" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Mande um print desta janela para o Claude." -ForegroundColor Red
}
