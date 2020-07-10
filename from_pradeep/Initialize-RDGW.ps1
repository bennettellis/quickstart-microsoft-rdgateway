[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$DomainNetBiosName,

    [Parameter(Mandatory=$true)]
    [string]$CertCN,

    [Parameter(Mandatory=$true)]
    [string]$GroupName,

    [Parameter(Mandatory=$false)]
    [string]$KeyLength='2048'
)

try {
    $ErrorActionPreference = "Stop"

    Start-Transcript -Path c:\cfn\log\Initialize-RDGW.ps1.txt -Append
    $hostname=[System.Net.Dns]::GetHostByName($env:computerName).HostName
    #$hostFQDN
    Import-Module RemoteDesktopServices

    Import-Module RemoteDesktop
    New-RDSessionDeployment -ConnectionBroker $hostname -WebAccessServer $hostname -SessionHost $hostname -verbose -ErrorAction Stop
    $error[0]
    #Join Gateway to Broker
    Add-RDServer -Server $hostname -Role "RDS-GATEWAY" -ConnectionBroker $hostname -GatewayExternalFqdn $CertCN -verbose -ErrorAction Stop
    Write-Verbose "Joined RDS Gateway to Broker"  -Verbose

    dir cert:\localmachine\my | ? { $_.Subject -eq "CN=$ServerFQDN" } | % { [system.IO.file]::WriteAllBytes("c:\$env:COMPUTERNAME.cer", ($_.Export('CERT', 'secret')) ) }

    new-item -path RDS:\GatewayServer\CAP -Name Default-CAP -UserGroups "$GroupName@$DomainNetBiosName" -AuthMethod 1 -verbose -ErrorAction Stop

    new-item -Path RDS:\GatewayServer\RAP -Name Default-RAP -UserGroups "$GroupName@$DomainNetBiosName" -ComputerGroupType 2 -verbose -ErrorAction Stop

    dir cert:\localmachine\my | where-object { $_.Subject -like '*CN=$CertCN*' } | ForEach-Object { Set-Item -Path RDS:\GatewayServer\SSLCertificate\Thumbprint -Value $_.Thumbprint }

    Restart-Service TSGateway
    [Security.Principal.WindowsIdentity]::GetCurrent()
}
catch {
    $error[0]
    Write-Verbose "$($_.exception.message)@ $(Get-Date)"
    $_ | Write-AWSQuickStartException
}
