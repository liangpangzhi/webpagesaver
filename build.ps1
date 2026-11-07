$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$node = (Get-Command node).Source
Write-Host "node: $node"

# 1) bundle with esbuild
npx esbuild src/index.js --bundle --platform=node --target=node22 --format=cjs --outfile=build/bundle.cjs --log-level=warning

# 2) SEA config (single line JSON, must be BOM-free)
$sea = '{"main":"build/bundle.cjs","output":"build/sea-prep.blob","disableExperimentalSEAWarning":true,"useSnapshot":false,"useCodeCache":false}'
[System.IO.File]::WriteAllText((Join-Path $root 'build\sea-config.json'), $sea, (New-Object System.Text.UTF8Encoding($false)))
& $node --experimental-sea-config build/sea-config.json
Write-Host ("sea-prep.blob: " + (Get-Item build/sea-prep.blob).Length)

# 3) copy host node and inject SEA blob
if (-not (Test-Path dist)) { New-Item -ItemType Directory dist | Out-Null }
Copy-Item $node dist\WebPageSaver.exe -Force
npx postject dist\WebPageSaver.exe NODE_SEA_BLOB build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
Write-Host ("exe: " + (Get-Item dist\WebPageSaver.exe).Length + " bytes")

# 4) switch PE subsystem to GUI(2) so double-click opens no console window
$exePath = Join-Path $root 'dist\WebPageSaver.exe'
$bytes = [System.IO.File]::ReadAllBytes($exePath)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45) { throw 'not a PE file' }
$subOffset = $peOffset + 24 + 68
$oldSub = [BitConverter]::ToUInt16($bytes, $subOffset)
$bytes[$subOffset] = 2
$bytes[$subOffset + 1] = 0
[System.IO.File]::WriteAllBytes($exePath, $bytes)
Write-Host ("subsystem: " + $oldSub + " -> 2 (GUI)")

# 5) deliver to output dir
$outDir = 'C:\Users\54743\AppData\Roaming\Tencent\Marvis\User\oAN1i2cZzjy2ZyWjiWPN9s_1FRPY\workspace\conv_b1afa0aaad614299af8a02a27f9f0634\output'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir | Out-Null }
Copy-Item $exePath (Join-Path $outDir 'WebPageSaver.exe') -Force
Write-Host ("output: " + (Get-Item (Join-Path $outDir 'WebPageSaver.exe')).Length + " bytes")
