[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$PFXCertificateSecretName,

    [Parameter(Mandatory=$false)]
    [string]$PFXCertificatePassword = ""
)

try {
    Start-Transcript -Path c:\cfn\log\Install-RDSCertificate.log -Append

    $ErrorActionPreference = "Stop"

    Write-Host "Starting RDS Certificate installation"

    Write-Host "Extracting PXF Cert file from Secret Name $PFXCertificateSecretName..."
    Get-SECSecretValue -SecretId $PFXCertificateSecretName -Select SecretString > C:\cfn\rds-cert.pfx.base64
    certutil -decode C:\cfn\rds-cert.pfx.base64 C:\cfn\rds-cert.pfx

    Write-Host "Importing PXF Cert file to local machine..."
    if ($PFXCertificatePassword -ne "") {
        $securePassword = ConvertTo-SecureString $PFXCertificatePassword -AsPlainText -Force
	   Import-PfxCertificate -Password $securePassword -FilePath C:\cfn\rds-cert.pfx -CertStoreLocation Cert:\LocalMachine\My
    } else {
        Import-PfxCertificate -FilePath C:\cfn\rds-cert.pfx -CertStoreLocation Cert:\LocalMachine\My
    }

}
catch {
    $error[0]
    $_ | Write-Host
}

