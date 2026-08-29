# Owner: create or repair Windows Desktop and Start Menu shortcuts to the stable Workbench tray launcher.
param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,
  [Parameter(Mandatory = $true)]
  [string]$WorkbenchRoot
)

$ErrorActionPreference = "Stop"

function Set-WorkbenchShortcut {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ShortcutPath
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $LauncherPath
  $shortcut.Arguments = "--workbench-root `"$WorkbenchRoot`""
  $shortcut.WorkingDirectory = $WorkbenchRoot
  $shortcut.Description = "Launch Workbench"
  $shortcut.IconLocation = "$LauncherPath,0"
  $shortcut.Save()
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
$startMenuProgramsPath = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
[System.IO.Directory]::CreateDirectory($startMenuProgramsPath) | Out-Null

$shortcutPaths = @(
  (Join-Path $desktopPath "Workbench.lnk"),
  (Join-Path $startMenuProgramsPath "Workbench.lnk")
)

foreach ($shortcutPath in $shortcutPaths) {
  Set-WorkbenchShortcut -ShortcutPath $shortcutPath
  Write-Output "Workbench shortcut: $shortcutPath"
}
