cd /tls/certs

# All keys are password protected by "SLY!"

export FQDN=rdcb.ad.slice-global.com

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout $FQDN.key -out $FQDN.crt -subj "/C=US/ST=VA/L=MANASSAS/O=ad-slice-global/CN=$FQDN"

# to check the key, use the following command
# openssl x509 -in $FQDN.crt -text -noout

cat $FQDN.crt $FQDN.key > $FQDN.pem

openssl pkcs12 -export -out $FQDN.pfx -inkey $FQDN.key -in $FQDN.pem

# to check the pfx, use the following command
# certutil.exe $FQDN.pfx

cp *.pfx /mnt/c/temp

certutil -encode .\rdlic.ad.slice-global.com.pfx .\rdlic.ad.slice-global.com.base64