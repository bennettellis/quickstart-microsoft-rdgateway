#IIS Authentication for PIV
$certAuth="/system.webServer/security/authentication/clientCertificateMappingAuthentication"
$windowsAuth="/system.webServer/security/authentication/windowsAuthentication"
$anonyAuth="/system.webServer/security/authentication/anonymousAuthentication"

Set-WebConfigurationProperty -filter $certAuth -name enabled -value true -PSPath IIS:\
Set-WebConfigurationProperty -filter $windowsAuth -name enabled -value true -PSPath IIS:\
Set-WebConfigurationProperty -filter $anonyAuth -name enabled -value false -PSPath IIS:\

$RDWebPath='IIS:\Sites\Default Web Site\RDWeb'
$config.mode = "Windows"
Set-WebConfigurationProperty -filter $anonyAuth -name enabled -value false -PSPath $RDWebPath
$config = (Get-WebConfiguration system.web/authentication $RDWebPath)
$config | Set-WebConfiguration system.web/authentication
Set-WebConfigurationProperty -filter $windowsAuth -name enabled -value true -PSPath $RDWebPath

$RDWebPagesPath='IIS:\Sites\Default Web Site\RDWeb\Pages'
Set-WebConfigurationProperty -filter $anonyAuth -name enabled -value false -PSPath $RDWebPagesPath
$config = (Get-WebConfiguration system.web/authentication $RDWebPagesPath)
$config | Set-WebConfiguration system.web/authentication
Set-WebConfigurationProperty -filter $windowsAuth -name enabled -value true -PSPath $RDWebPagesPath



# SSL Settings for PIV
$SslFilter='system.webserver/security/access'

$SslValue='Ssl,SslRequireCert'
$Location='IIS:\Sites\Default Web Site'
Set-WebConfiguration -Filter $SslFilter -Metadata overrideMode -Value Allow -PSPath 'MACHINE/WEBROOT/APPHOST'
Set-WebConfigurationProperty -filter $SslFilter -Name sslFlags -Value $SslValue -Location $Location


$SslValue="Ssl,SslNegotiateCert"
$Location="IIS:\Sites\Default Web Site\RDWeb"
Set-WebConfigurationProperty -filter $SslFilter -Name sslFlags -Value $SslValue -pspath $Location

$Location="IIS:\Sites\Default Web Site\RDWeb\Pages"
Set-WebConfigurationProperty -filter $SslFilter -Name sslFlags -Value $SslValue -pspath $Location
