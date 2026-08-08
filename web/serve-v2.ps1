# punch-console v2 预览常驻(:3000,生产模式;M2 交接后将接管 :8787)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listening = netstat -ano | Select-String ':3000\s.*LISTENING'
if ($listening) { exit 0 }
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm exec next start -H 0.0.0.0 -p 3000 >> v2-server.log 2>&1' `
  -WorkingDirectory $root -WindowStyle Hidden
