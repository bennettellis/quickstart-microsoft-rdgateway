$ConnectionBroker01="first connection broker FQDN"


$ConnectionBroker02="new connection broker FQDN"
$WebAccessServer02="new RDWEB FQDN"
$RDGatewayServer02="new Gateway Server FQDN"


$primaryBroker = (Get-RDConnectionBrokerHighAvailability -ConnectionBroker ConnectionBroker01).ActiveManagementServer
Add-RDServer -Server $ConnectionBroker02 -Role "RDS-CONNECTION-BROKER" -ConnectionBroker $primaryBroker
Add-RDServer -Server $WebAccessServer02 -Role "RDS-WEB-ACCESS" -ConnectionBroker $primaryBroker
Add-RDServer -Server $RDGatewayServer02 -Role "RDS-GATEWAY" -ConnectionBroker $primaryBroker -GatewayExternalFqdn $GatewayExternalFqdn
