# punch-console 常驻启动脚本(开机自启任务调用;手动跑一次=立即拉起)
# 端口已被监听则不重复起;日志落 service.log / service.err
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root '.venv\Scripts\python.exe'
$listening = netstat -ano | Select-String ':8787\s.*LISTENING'
if ($listening) { exit 0 }
Start-Process -FilePath $py -ArgumentList 'app.py' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root 'service.log') `
  -RedirectStandardError  (Join-Path $root 'service.err')
