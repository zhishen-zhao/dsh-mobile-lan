[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$SkipAutoStart,
    [switch]$DoNotStartHarness
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'The guided installer currently supports Windows only. The plugin and LAN proxy remain cross-platform components.'
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginPath = Join-Path $root 'plugin'
$startScript = Join-Path $PSScriptRoot 'start-mobile-lan.ps1'
$dsh = Get-Command dsh -ErrorAction Stop
[void](Get-Command node -ErrorAction Stop)
$pwsh = (Get-Process -Id $PID).Path

function Assert-NativeSuccess {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function New-PairingToken {
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$token = [Environment]::GetEnvironmentVariable('DSH_MOBILE_PAIRING_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token) -or [Text.Encoding]::UTF8.GetByteCount($token) -lt 32) {
    $token = New-PairingToken
    [Environment]::SetEnvironmentVariable('DSH_MOBILE_PAIRING_TOKEN', $token, 'User')
    Write-Host 'Created a per-user DSH Mobile pairing secret.' -ForegroundColor Green
} else {
    Write-Host 'Reused the existing per-user DSH Mobile pairing secret.' -ForegroundColor Green
}
$env:DSH_MOBILE_PAIRING_TOKEN = $token

Write-Host "Installing the local plugin into the '$Profile' Harness profile ..." -ForegroundColor Cyan
& $dsh.Source plugin --profile $Profile add $pluginPath
Assert-NativeSuccess 'Harness plugin installation'

if (-not $SkipAutoStart) {
    $taskName = 'DSH Mobile LAN'
    $arguments = "-NoProfile -WindowStyle Hidden -File `"$startScript`""
    if ($DoNotStartHarness) { $arguments += ' -DoNotStartHarness' }
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the loopback-only DeepSeek Harness mobile TLS proxy attached to the current physical LAN address.' -Force | Out-Null
    Write-Host "Registered the per-user '$taskName' logon task." -ForegroundColor Green
}

$escapedStart = [Regex]::Escape($startScript)
$monitor = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $escapedStart } | Select-Object -First 1
if ($null -eq $monitor) {
    $arguments = @('-NoProfile', '-File', $startScript)
    if ($DoNotStartHarness) { $arguments += '-DoNotStartHarness' }
    Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    Write-Host 'Started the DSH Mobile LAN monitor.' -ForegroundColor Green
} else {
    Write-Host "The DSH Mobile LAN monitor is already running (PID $($monitor.ProcessId))." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Installation prepared.' -ForegroundColor Green
Write-Host '1. Restart the running Harness once so it receives the new environment secret and browser plugin.'
Write-Host '2. Open http://127.0.0.1:3080 and choose Settings -> 手机端.'
Write-Host '3. Install the release APK and scan the one-time QR code.'
Write-Host ''
Write-Warning 'The pairing secret, CA private key, and TLS private key stay on this computer and must never be committed or shared.'
