# Phase 3 kickoff gate: re-run Phase 2 exit suites on the locked Node.
# Writes a machine-readable summary and full logs under .audit\phase3-rerun\.
$ErrorActionPreference = 'Stop'
$repo = 'D:\AegisPi\aegis-pi'
$nodeDir = 'D:\AegisPi\tools\node-v22.23.5'
$node = Join-Path $nodeDir 'node.exe'
$logDir = Join-Path $repo '.audit\phase3-rerun'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Any PATH-resolved `node` child process must also hit the locked binary.
$env:Path = "$nodeDir;$env:Path"

$suites = @(
  @{ name = 'durability'; script = 'evals/phase2/durability/run.mjs' },
  @{ name = 'budget';    script = 'evals/phase2/budget/run.mjs' },
  @{ name = 'acl';       script = 'evals/phase2/acl/run.mjs' },
  @{ name = 'contracts'; script = 'evals/contracts/run-contracts.mjs' },
  @{ name = 'hono-pair'; script = 'evals/contracts/tools/verify-hono-oracle-pair.mjs' }
)

$summary = @()
foreach ($s in $suites) {
  $log = Join-Path $logDir ($s.name + '.log')
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $node $s.script *> $log
  $code = $LASTEXITCODE
  $sw.Stop()
  $tail = (Get-Content $log -Tail 3) -join ' | '
  $summaryLine = "{0}`texit={1}`tseconds={2}`ttail={3}" -f $s.name, $code, [int]$sw.Elapsed.TotalSeconds, $tail
  $summary += $summaryLine
  Add-Content -Path (Join-Path $logDir 'summary.txt') -Value $summaryLine -Encoding utf8
}
$summary | ForEach-Object { Write-Output $_ }
Write-Output "NODE_VERSION=$(& $node --version)"
Write-Output "DONE"
