$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $PSScriptRoot "Cargo.toml"
$builtLauncherPath = Join-Path $PSScriptRoot "target\release\workbench-tray.exe"
$artifactDirectoryPath = Join-Path $PSScriptRoot "bin\windows-x64"
$artifactPath = Join-Path $artifactDirectoryPath "workbench-tray.exe"

& cargo build --release --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) {
    throw "Cargo release build failed with status $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $builtLauncherPath -PathType Leaf)) {
    throw "Cargo release build did not produce $builtLauncherPath."
}

$stream = [System.IO.File]::OpenRead($builtLauncherPath)
$reader = [System.IO.BinaryReader]::new($stream)
try {
    if ($reader.ReadUInt16() -ne 0x5A4D) {
        throw "Built launcher is not a Windows PE executable."
    }
    $stream.Position = 0x3C
    $peHeaderOffset = $reader.ReadInt32()
    $stream.Position = $peHeaderOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
        throw "Built launcher has an invalid Windows PE header."
    }
    $machine = $reader.ReadUInt16()
    if ($machine -ne 0x8664) {
        throw "Built launcher targets machine 0x$($machine.ToString('X4')); expected Windows x64 machine 0x8664."
    }
}
finally {
    $reader.Dispose()
    $stream.Dispose()
}

[System.IO.Directory]::CreateDirectory($artifactDirectoryPath) | Out-Null
[System.IO.File]::Copy($builtLauncherPath, $artifactPath, $true)

$artifact = Get-Item -LiteralPath $artifactPath
Write-Output "Updated tray\bin\windows-x64\workbench-tray.exe ($($artifact.Length) bytes)."
