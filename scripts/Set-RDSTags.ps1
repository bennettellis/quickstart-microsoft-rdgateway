[CmdletBinding()]
param (
    [Parameter(Mandatory=$true)]
    [string]$DeploymentName
)

try {
    Start-Transcript -Path c:\cfn\log\add-rds-fqdn-tag.log
    $ErrorActionPreference = "Stop"
    $instanceId = (Invoke-RestMethod -Method Get -Uri http://169.254.169.254/latest/meta-data/instance-id)
    Write-Host "InstanceId: $instanceId"
    $RDSFQDNTagValue = [System.Net.Dns]::GetHostByName($env:computerName).HostName
    Write-Host "Hostname: $RDSFQDNTagValue"
    New-EC2Tag -Resource $instanceId -Tag @{ Key="RDS-FQDN"; Value=$RDSFQDNTagValue }
    Write-Host "RDS-FQDN tag set to $RDSFQDNTagValue"
    Write-Host "DeploymentName: $DeploymentName"
    New-EC2Tag -Resource $instanceId -Tag @{ Key="RDS-Deployment-Name"; Value=$DeploymentName }
    Write-Host "RDS-Deployment-Name tag set to $DeploymentName"
}
catch {
    $error[0]
    $_ | Write-Host
}
