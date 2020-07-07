[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$InstanceId,

    [Parameter(Mandatory=$true)]
    [string]$SecretName
)
try {
    Start-Transcript -Path c:\cfn\log\rd-configure.log -Append
    # Get Secret for this Deployment
   	Write-Host "Getting RDS Deployment Information from Secret -- params: -SecretName '$SecretName'"
   	# Get the Secrets from AWS Secrets Manager
    $CurrentConfig = Get-SECSecretValue -SecretId $SecretName -Select SecretString
    # Convert config to Object


    # Check if Secret has valid parameter for Who is KING
    # If NO KING, mark this instance as KING
    # Set Semaphore



    $ConnectionBrokerFQDN = (Get-RDConnectionBrokerHighAvailability).ActiveManagementServer


$SQLServer = "rdcbha.cfylsopa0yyy.us-east-1.rds.amazonaws.com"
$SQLDBName = "master"
$uid ="DBAdmin"
$pwd = "Passw0rd1234"
$SQLServer = ""
$SQLDBName = "master"
$uid =""
$pwd = ""
$SqlQuery = "SELECT 1;"
$SqlConnection = New-Object System.Data.SqlClient.SqlConnection
$SqlConnection.ConnectionString = "Server = $SQLServer; Database = $SQLDBName; User ID = $uid; Password = $pwd;"
$SqlCmd = New-Object System.Data.SqlClient.SqlCommand
$SqlCmd.CommandText = $SqlQuery
$SqlCmd.Connection = $SqlConnection
$SqlAdapter = New-Object System.Data.SqlClient.SqlDataAdapter
$SqlAdapter.SelectCommand = $SqlCmd
$DataSet = New-Object System.Data.DataSet
$SqlAdapter.Fill($DataSet)

$DataSet.Tables[0] | out-file "C:\cfn\log\sqlout.csv"




create database [remote-desktop-services];
GO
USE [master]
GO
CREATE LOGIN [remotedesktopadmin] WITH PASSWORD=N'Passw0rd1234', DEFAULT_DATABASE=[remote-desktop-services], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF
GO
use [remote-desktop-services]
GO
CREATE USER remotedesktopadmin FOR LOGIN remotedesktopadmin;
GO
exec sp_addrolemember 'db_owner', [remotedesktopadmin]
GO


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


$action = New-ScheduledTaskAction -Execute 'Execute-Sample.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (get-date).AddMinutes(1)  # -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserID "benne" -RunLevel Highest -LogonType ServiceAccount
$description = "This is a test task. Its job is to start notepad every 3 minutes."
Unregister-ScheduledTask -TaskName "TestTask4" -Confirm:$False
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "TestTask4" -Description $description


