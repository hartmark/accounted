# Sharing a registered Skatteverket callback

Two installations with separate databases can share the callback registered for
their own direct Skatteverket client. Configure the secondary installation with:

```dotenv
NEXT_PUBLIC_SKV_OAUTH_BASE_URL=https://accounted.vhost2.hartmark.se
SKATTEVERKET_OAUTH_STATE_NAMESPACE=accounted-dev
```

Keep its own NEXT_PUBLIC_APP_URL, database, session secrets and token storage.
The namespace is public and must match the fixed proxy route. It contains 1-32
lowercase letters, digits or hyphens, starting with a letter. No namespace keeps
the existing random state unchanged. Restart the secondary app after configuration.

Add this handler to the registered hostname's Caddy site before its default
application handler:

```caddyfile
@accounted_dev_skv {
    path /api/extensions/ext/skatteverket/callback
    expression `query({'state': '*'}) && {query.state}.startsWith('instance.accounted-dev.')`
}
handle @accounted_dev_skv {
    header Cache-Control "no-store"
    header Referrer-Policy "no-referrer"
    redir https://accounted-dev.vhost2.hartmark.se{uri} 302
}
```

Validate and reload Caddy before starting new consent flows. The fixed redirect
preserves the provider's code and state without an arbitrary return URL. Existing
primary flows lack dots in their base64url state and keep their original route.

The secondary app receives its own session cookie, finds and consumes its own
flow, checks the initiating user and exchanges the code using the original
registered redirect URI and server-held PKCE verifier. The namespace only
selects a route; it grants no authority. Tokens and databases stay separate.
Keep callback access logs private and avoid recording codes or state in diagnostics.

This setup applies to installations using their own direct SKV credentials.
Connector installations use the connector's registered callback and routing.
