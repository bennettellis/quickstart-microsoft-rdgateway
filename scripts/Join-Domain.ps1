[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$DomainName,

    [Parameter(Mandatory=$true)]
    [string]$OUPath,

    [Parameter(Mandatory=$true)]
    [string]$UserNameSecretName,

    [Parameter(Mandatory=$true)]
    [string]$PwdSecretName
)

try {
    Start-Transcript -Path c:\cfn\log\Join-Domain.log -Append

    $ErrorActionPreference = "Stop"

	Write-Host "Starting Join to Domain -- params: -DomainName '$DomainName' -OUPath '$OUPath'"

	# Get the Secrets from AWS Secrets Manager
    $UserName = Get-SECSecretValue -SecretId $UserNameSecretName -Select SecretString
    Write-Host $UserName
    $Password = Get-SECSecretValue -SecretId $PwdSecretName -Select SecretString
    Write-Host $Password
    $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
    Write-Host (ConvertTo-Json -InputObject $securePassword)
    $creds = New-Object System.Management.Automation.PSCredential -ArgumentList $UserName,$securePassword
    Write-Host (ConvertTo-Json -InputObject $creds)

    $addComputerParams = @{
        DomainName = $DomainName
        Credential = $creds
		OUPath = $OUPath
		PassThru = $true
        Force = $true
        ErrorAction = [System.Management.Automation.ActionPreference]::Stop
    }
    Write-Host (ConvertTo-Json -InputObject $addComputerParams)

	# Add this computer to domain
    Add-Computer @addComputerParams

    Write-Host "Joined to domain $DomainName"
}
catch {
    $error[0]
    $_ | Write-Host
}
