# Synthetic TLS fixture

This self-signed certificate and key are public, test-only data for a local
HTTPS server. They are never used for Cloudflare, Mynda deployments or real
credentials. Tests first verify that the normal client rejects the certificate,
then explicitly trust it in the test's HTTPS agent. It covers `localhost` and
`127.0.0.1` and expires in October 2036.
