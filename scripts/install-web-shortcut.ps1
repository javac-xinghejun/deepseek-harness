# One-time setup: create the desktop shortcut for the DeepSeek Harness web
# surface. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\install-web-shortcut.ps1
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'DeepSeek Harness.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $repoRoot 'scripts\launch-web.cmd'
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 7 # minimized console; closing it stops the server
$shortcut.Description = 'DeepSeek Harness web UI'
$shortcut.Save()

Write-Host "Created $shortcutPath"
