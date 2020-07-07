try {
    # Set file and folder path for SSMS installer .exe
    $folderpath = "c:\windows\temp"
    # $filepath = "$folderpath\SSMS-Setup-ENU.exe"
    $filepath = "$folderpath\sqlncli.msi"

    #If SSMS not present, download
    if (!(Test-Path $filepath)) {
        write-host "Downloading SQL Server 2016 SSMS..."
        $URL = "https://download.microsoft.com/download/B/E/D/BED73AAC-3C8A-43F5-AF4F-EB4FEA6C8F3A/ENU/x64/sqlncli.msi"
        # $URL = "https://download.microsoft.com/download/3/1/D/31D734E0-BFE8-4C33-A9DE-2392808ADEE6/SSMS-Setup-ENU.exe"
        $clnt = New-Object System.Net.WebClient
        $clnt.DownloadFile($url,$filepath)
        Write-Host "SSMS installer download complete" -ForegroundColor Green

    }
    else {

        write-host "Located the SQL SSMS Installer binaries, moving on to install..."
    }

    # start the SSMS installer
    write-host "Beginning SQLServer Native Client (v11) install..." -nonewline
    Start-Process -FilePath $filepath -ArgumentList "/qn","/liv c:/cfn/log/sqlserver-client-install.log" -Wait
    # | Out-Null
    Write-Host "SQLServer Native Client installation complete" -ForegroundColor Green
}
catch {
    $error[0]
    $_ | Write-Host
}
