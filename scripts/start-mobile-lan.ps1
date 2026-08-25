[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$TargetPort = 3080,

    [ValidateRange(1, 65535)]
    [int]$ListenPort = 3080,

    [ValidateRange(2, 300)]
    [int]$PollSeconds = 5,

    [string]$EndpointFile = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\mobile-endpoint.json'),

    [switch]$StartHarness,

    # Deprecated compatibility switch. Harness is no longer started by default.
    [switch]$DoNotStartHarness
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($StartHarness -and $DoNotStartHarness) {
    throw 'StartHarness and DoNotStartHarness cannot be used together.'
}
$manageHarness = $StartHarness -and -not $DoNotStartHarness

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tlsScript = Join-Path $PSScriptRoot 'setup-local-tls.ps1'
$proxyScript = Join-Path $repoRoot 'plugin\scripts\lan-proxy.mjs'
$certDirectory = Join-Path $repoRoot 'certs'
$serverCertificate = Join-Path $certDirectory 'server-cert.pem'
$serverKey = Join-Path $certDirectory 'server-key.pem'
$endpointFullPath = [IO.Path]::GetFullPath($EndpointFile)
$endpointDirectory = Split-Path -Parent $endpointFullPath
$logDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\logs'

New-Item -ItemType Directory -Path $endpointDirectory, $logDirectory -Force | Out-Null

function Test-TcpPort {
    param([string]$Address, [int]$Port, [int]$TimeoutMs = 700)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($Address, $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-PrimaryLanIPv4 {
    $excluded = '(?i)(vpn|wireguard|wintun|tap|tun|tunnel|virtual|hyper-v|vmware|virtualbox|loopback)'
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object @{ Expression = { $_.RouteMetric + $_.InterfaceMetric } })

    foreach ($route in $routes) {
        $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
        if ($null -eq $adapter -or $adapter.Status -ne 'Up' -or -not $adapter.HardwareInterface) { continue }
        if ($adapter.Name -match $excluded -or $adapter.InterfaceDescription -match $excluded) { continue }

        $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -AddressState Preferred -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Sort-Object SkipAsSource |
            Select-Object -First 1
        if ($null -ne $address) { return $address.IPAddress }
    }
    return $null
}

function Write-EndpointState {
    param([string]$Address)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem([IO.File]::ReadAllText($serverCertificate))
    $certificateSha256 = [Convert]::ToHexString($certificate.GetCertHash([Security.Cryptography.HashAlgorithmName]::SHA256)).ToLowerInvariant()
    $temporaryPath = Join-Path $endpointDirectory ('.mobile-endpoint-{0}-{1}.tmp' -f $PID, [guid]::NewGuid().ToString('N'))
    $state = [ordered]@{
        schemaVersion = 1
        pairingServerUrl = "https://${Address}:$ListenPort"
        address = $Address
        port = $ListenPort
        certificateSha256 = $certificateSha256
        certificateExpiresAt = [DateTimeOffset]::new($certificate.NotAfter.ToUniversalTime()).ToString('o')
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json
    [IO.File]::WriteAllText($temporaryPath, $state, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $endpointFullPath -Force
}

function Test-ReusableServerCertificate {
    param([string]$Address)
    if (-not (Test-Path -LiteralPath $serverCertificate -PathType Leaf) -or
        -not (Test-Path -LiteralPath $serverKey -PathType Leaf) -or
        -not (Test-Path -LiteralPath $endpointFullPath -PathType Leaf)) { return $false }
    try {
        $state = Get-Content -LiteralPath $endpointFullPath -Raw | ConvertFrom-Json
        if ($state.address -ne $Address -or [int]$state.port -ne $ListenPort) { return $false }
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($serverCertificate, $serverKey)
        return $certificate.HasPrivateKey -and $certificate.NotAfter.ToUniversalTime() -gt [DateTime]::UtcNow.AddDays(7)
    } catch {
        return $false
    }
}

function Start-HarnessProcess {
    if (Test-TcpPort -Address '127.0.0.1' -Port $TargetPort) { return $null }
    if (-not $manageHarness) { return $null }

    $dshCommand = Get-Command dsh -ErrorAction Stop
    $dshExecutable = $dshCommand.Source
    $dshArguments = @('web')
    if ([IO.Path]::GetExtension($dshExecutable) -ieq '.ps1') {
        $cmdShim = [IO.Path]::ChangeExtension($dshExecutable, '.cmd')
        if (Test-Path -LiteralPath $cmdShim -PathType Leaf) {
            $dshExecutable = $cmdShim
        } else {
            $dshArguments = @('-NoProfile', '-File', ('"{0}"' -f $dshExecutable), 'web')
            $dshExecutable = (Get-Process -Id $PID).Path
        }
    }
    $userToken = [Environment]::GetEnvironmentVariable('DSH_MOBILE_PAIRING_TOKEN', 'User')
    if ([string]::IsNullOrWhiteSpace($env:DSH_MOBILE_PAIRING_TOKEN) -and -not [string]::IsNullOrWhiteSpace($userToken)) {
        $env:DSH_MOBILE_PAIRING_TOKEN = $userToken
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $logDirectory "harness-$stamp.out.log"
    $stderr = Join-Path $logDirectory "harness-$stamp.err.log"
    Write-Host "Starting Harness on 127.0.0.1:$TargetPort ..." -ForegroundColor Cyan
    $process = Start-Process -FilePath $dshExecutable -ArgumentList $dshArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw "Harness exited during startup. See $stderr" }
        if (Test-TcpPort -Address '127.0.0.1' -Port $TargetPort) { return $process }
        Start-Sleep -Milliseconds 500
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Harness did not open 127.0.0.1:$TargetPort within 30 seconds. See $stderr"
}

function Start-ProxyProcess {
    param([string]$Address)
    $nodeCommand = Get-Command node -ErrorAction Stop
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $logDirectory "mobile-proxy-$stamp.out.log"
    $stderr = Join-Path $logDirectory "mobile-proxy-$stamp.err.log"
    $arguments = @(
        ('"{0}"' -f $proxyScript),
        $TargetPort,
        $Address,
        $ListenPort,
        '--tls-cert',
        ('"{0}"' -f $serverCertificate),
        '--tls-key',
        ('"{0}"' -f $serverKey)
    )
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($process.HasExited) { throw "TLS proxy exited during startup. See $stderr" }
        if (Test-TcpPort -Address $Address -Port $ListenPort) { return $process }
        Start-Sleep -Milliseconds 250
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "TLS proxy did not open ${Address}:$ListenPort. See $stderr"
}

$harnessProcess = $null
$proxyProcess = $null
$activeAddress = $null
$harnessUnavailableNotified = $false

try {
    $harnessProcess = Start-HarnessProcess
    Write-Host 'Watching the primary physical LAN adapter. Press Ctrl+C to stop.' -ForegroundColor Green
    while ($true) {
        if (-not (Test-TcpPort -Address '127.0.0.1' -Port $TargetPort)) {
            if (-not $manageHarness) {
                if (-not $harnessUnavailableNotified) {
                    Write-Warning "Harness is not listening on 127.0.0.1:$TargetPort; the LAN monitor will wait without starting or restarting dsh web."
                    $harnessUnavailableNotified = $true
                }
                Start-Sleep -Seconds $PollSeconds
                continue
            }
            if ($null -ne $harnessProcess -and -not $harnessProcess.HasExited) {
                Stop-Process -Id $harnessProcess.Id -Force -ErrorAction SilentlyContinue
            }
            $harnessProcess = Start-HarnessProcess
        } elseif ($harnessUnavailableNotified) {
            Write-Host "Harness is listening again on 127.0.0.1:$TargetPort; LAN proxy monitoring resumed." -ForegroundColor Green
            $harnessUnavailableNotified = $false
        }

        $detectedAddress = Get-PrimaryLanIPv4
        $proxyStopped = $null -ne $proxyProcess -and $proxyProcess.HasExited
        if (-not [string]::IsNullOrWhiteSpace($detectedAddress) -and ($detectedAddress -ne $activeAddress -or $null -eq $proxyProcess -or $proxyStopped)) {
            if (Test-ReusableServerCertificate -Address $detectedAddress) {
                Write-Host "LAN endpoint is still $detectedAddress; reusing its pinned server certificate." -ForegroundColor Cyan
            } else {
                Write-Host "LAN endpoint changed to $detectedAddress; refreshing the leaf certificate and proxy ..." -ForegroundColor Cyan
                & $tlsScript -HostName $detectedAddress -OutputDirectory $certDirectory -SkipAndroidCaSync
            }
            if ($null -ne $proxyProcess -and -not $proxyProcess.HasExited) {
                Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
                $proxyProcess.WaitForExit(5000)
            }
            $proxyProcess = Start-ProxyProcess -Address $detectedAddress
            Write-EndpointState -Address $detectedAddress
            $activeAddress = $detectedAddress
            Write-Host "Ready: https://${activeAddress}:$ListenPort/mobile/" -ForegroundColor Green
            Write-Host 'Refresh http://127.0.0.1:3080/mobile-pair before scanning.'
        } elseif ([string]::IsNullOrWhiteSpace($detectedAddress)) {
            Write-Warning 'No suitable physical LAN IPv4 address is currently available; waiting for the network.'
        }
        Start-Sleep -Seconds $PollSeconds
    }
} finally {
    if ($null -ne $proxyProcess -and -not $proxyProcess.HasExited) {
        Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $harnessProcess -and -not $harnessProcess.HasExited) {
        Stop-Process -Id $harnessProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
