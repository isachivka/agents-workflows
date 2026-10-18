# Telegram login: OpenID Connect instead of the legacy widget

Amends [2026-10-18-login-design.md](2026-10-18-login-design.md).

## Problem

The legacy Login Widget (`/setdomain`, a hash signed with the bot token) never delivered its phone
confirmation to the person: Telegram has moved site logins to OpenID Connect, and the widget's
phone path is reported broken. Separately, the first design marked outside requests by `Host`; a
Keenetic proxy rewrites `Host` and drops `Origin`, so outside requests are also marked by the
proxy's address (`FLOWD_PUBLIC_FROM`), shipped in its own fix.

## Decisions

- Telegram's OIDC code flow with PKCE (S256): the login page links to `oauth.telegram.org/auth`
  with the bot's id as `client_id`, the callback as `redirect_uri`, `scope=openid profile`, a random
  `state`; the state's verifier is kept in memory for 10 minutes, used once.
- The callback trades the code at `/token` with Basic auth (`client_id:client_secret`, the secret in
  `plugins.yaml`), then checks the ID token: RS256 by a key from Telegram's JWKS (fetched again on an
  unknown `kid`), `iss` Telegram, `aud` the bot, `exp` ahead; `id` (else `sub`) in `users`.
- `LoginProvider.verify` may be async and gets the callback URL.
- The legacy widget and its hash check are removed.

## Testing

A fake OAuth server in `test/telegram.test.ts` (its own RSA key, JWKS, `/token`): the page's URL and
challenge; the exchange's Basic auth and verifier; a used state, a refusal from Telegram, a user not
in `users`; ID tokens signed by another key, for another bot, from another issuer, expired.
