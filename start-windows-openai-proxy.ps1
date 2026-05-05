param(
  [string]$Upstream = "http://127.0.0.1:8788",
  [string]$Token = $env:AGENT_BUS_TOKEN,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8789
)

if (-not $Token) {
  Write-Error "Token is required. Pass -Token or set AGENT_BUS_TOKEN."
  exit 1
}

$env:AGENT_BUS_UPSTREAM = $Upstream
$env:AGENT_BUS_TOKEN = $Token
$env:AGENT_BUS_WINDOWS_HOST = $HostName
$env:AGENT_BUS_WINDOWS_PORT = [string]$Port

node "$PSScriptRoot\windows-openai-proxy.mjs"
