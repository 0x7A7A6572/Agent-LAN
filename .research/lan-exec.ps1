<#
执行体包装：把任务正文交给 dsh headless 跑一轮。
模块职责：桥接 bash 循环与 dsh.cmd，绕开 Git Bash 调 .cmd 的路径/空格问题。
一条最容易踩的约束：dsh 只能用 Windows 原生路径调用，prompt 必须走文件交给它。
#>
param(
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [string]$Dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
)

$ErrorActionPreference = 'Continue'
if (-not (Test-Path $PromptFile)) { Write-Error "找不到 prompt 文件: $PromptFile"; exit 1 }
if (-not (Test-Path $Dsh)) { Write-Error "找不到 dsh: $Dsh"; exit 1 }

$prompt = Get-Content -Raw -Encoding UTF8 $PromptFile
Write-Host "[exec] dsh headless, prompt $($prompt.Length) 字符"

# dsh 的 headless 自带超时保护；这里只负责传参并透传退出码
& $Dsh headless $prompt
exit $LASTEXITCODE
