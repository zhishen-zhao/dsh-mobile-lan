[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,

    [ValidateRange(1, 825)]
    [int]$ValidityDays = 825,

    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\certs')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-Pem {
    param([string]$Label, [byte[]]$Bytes)
    $base64 = [Convert]::ToBase64String($Bytes, [Base64FormattingOptions]::InsertLineBreaks)
    return "-----BEGIN $Label-----`n$base64`n-----END $Label-----`n"
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
$androidRaw = Join-Path $repoRoot 'android\app\src\main\res\raw'
New-Item -ItemType Directory -Path $output, $androidRaw -Force | Out-Null

$now = [DateTimeOffset]::UtcNow
$caKey = [Security.Cryptography.RSA]::Create(3072)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=DSH Mobile Local CA',
    $caKey,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
$caRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage, $true)
)
$caRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)
$ca = $caRequest.CreateSelfSigned($now.AddMinutes(-5), $now.AddYears(10))

$serverKey = [Security.Cryptography.RSA]::Create(3072)
$serverRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=DSH Mobile LAN',
    $serverKey,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$serverUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$serverRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($serverUsage, $true)
)
$eku = [Security.Cryptography.OidCollection]::new()
[void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1', 'TLS Web Server Authentication'))
$serverRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false)
)
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$ip = $null
if ([Net.IPAddress]::TryParse($HostName, [ref]$ip)) {
    $san.AddIpAddress($ip)
} else {
    $san.AddDnsName($HostName)
}
$serverRequest.CertificateExtensions.Add($san.Build())
$serverRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($serverRequest.PublicKey, $false)
)

$serial = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Fill($serial)
$serial[0] = $serial[0] -band 0x7f
if (($serial | Measure-Object -Sum).Sum -eq 0) { $serial[15] = 1 }
$serverNotAfter = $now.AddDays($ValidityDays)
if ($serverNotAfter -ge $ca.NotAfter) { $serverNotAfter = $ca.NotAfter.AddDays(-1) }
$issued = $serverRequest.Create($ca, $now.AddMinutes(-5), $serverNotAfter, $serial)
$server = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issued, $serverKey)

$caCertPath = Join-Path $output 'ca-cert.pem'
$caKeyPath = Join-Path $output 'ca-key.pem'
$serverCertPath = Join-Path $output 'server-cert.pem'
$serverKeyPath = Join-Path $output 'server-key.pem'
$androidCaPath = Join-Path $androidRaw 'dsh_mobile_local_ca.pem'

[IO.File]::WriteAllText($caCertPath, (ConvertTo-Pem 'CERTIFICATE' $ca.RawData))
[IO.File]::WriteAllText($caKeyPath, (ConvertTo-Pem 'PRIVATE KEY' $caKey.ExportPkcs8PrivateKey()))
[IO.File]::WriteAllText($serverCertPath, (ConvertTo-Pem 'CERTIFICATE' $server.RawData))
[IO.File]::WriteAllText($serverKeyPath, (ConvertTo-Pem 'PRIVATE KEY' $serverKey.ExportPkcs8PrivateKey()))
Copy-Item -LiteralPath $caCertPath -Destination $androidCaPath -Force

Write-Host ''
Write-Host 'Generated installation-specific TLS material:' -ForegroundColor Green
Write-Host "  Server origin: https://${HostName}:3080"
Write-Host "  Server cert:   $serverCertPath"
Write-Host "  Server key:    $serverKeyPath"
Write-Host "  Android CA:    $androidCaPath"
Write-Host ''
Write-Warning 'Keep certs/ private. The Android CA and all private keys are intentionally ignored by Git.'
