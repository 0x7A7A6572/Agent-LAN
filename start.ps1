# Agent-LAN hub 一键启动
# 用法：右键"使用 PowerShell 运行"，或 .\start.ps1
$env:MAC_AGENT_NAME = "hub"
$env:MAC_PORT = "9600"
$env:MAC_ADAPTER = "claude"
Set-Location $PSScriptRoot
node packages\app\dist\main.js
