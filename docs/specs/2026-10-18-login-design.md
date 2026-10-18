# Logging in to the UI from outside

## Problem

`FLOWD_PUBLIC_URL` lets a reverse proxy serve the UI from outside; flowd has no login, so the
proxy's own (a router's HTTP auth) guards it. That login is clumsy on a phone. The person wants to
log in with Telegram, the messenger flows already talks to them in.

## Goals

- Requests through the public name need a session; the session comes from the Telegram Login
  Widget, for the Telegram users already allowed to write to agents.
- Local requests (127.0.0.1, a LAN IP, the hooks) work as before, with no login.
- The login is a plugin capability, like a chat adapter, so another provider (GitHub) can be added
  without touching the core.

## Non-goals

- Several people with different rights: whoever is allowed can do everything.
- A login for local or LAN access.
- GitHub login now.

## Decisions

### Which requests need a session

Only requests whose `Host` is `FLOWD_PUBLIC_URL`'s. Without a valid session:

- `GET /login` — the login page; `GET /auth/<plugin>` — the provider's callback: always answered.
- other non-API `GET`s → `302 /login`.
- `/api/*` → `401 {error: "log in at /login"}`.

With `FLOWD_PUBLIC_URL` set and no login plugin active, the login page says how to set one up and
nothing else is served on the public name: never open by default.

### Sessions

- On a verified login flowd stores a session: 32 random bytes, kept as their SHA-256 (a database
  leak gives no usable cookie), with the user's id, name and an expiry of 30 days. Table
  `logins(token_hash, user, name, expires)`.
- Cookie `flows_session`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 days`. Lax, not
  Strict: the callback is a navigation from Telegram's site, and a Strict cookie set there would
  not come back on the redirect that follows. Cross-site writes stay refused by the `Origin` check.
- `POST /logout` (from the public name) deletes the session and the cookie.
- The UI reloads on a 401, which lands on the login page.

### The plugin capability

```ts
login: {
  page(ctx): string,                                      // HTML for the login page's body
  verify(query: Record<string, string>, ctx): { user: string; name: string } | { error: string },
}
```

Active like a chat adapter: a plugin with `login` whose section is in `plugins.yaml`; two is an
error (Settings → Plugins, `flow check`). The callback is `/auth/<plugin name>`.

### Telegram

- `page`: the widget, `<script src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="<bot username>" data-auth-url="<public url>/auth/telegram">`; the bot's
  username comes from `getMe` at start.
- `verify`: Telegram's rule — the `key=value` lines of every field but `hash`, sorted, joined by
  `\n`; HMAC-SHA256 with SHA-256(bot token) as the key must equal `hash` (compared in constant
  time). Refused also when `auth_date` is over a day old or `id` is not in `users`.
- Setup: `/setdomain` in BotFather to the public name (one domain per bot). Nothing else: the token
  and `users` are the chat adapter's.

## Testing

- Telegram `verify`: a correctly signed query passes; a changed field, a stale `auth_date`, a user
  not in `users` are refused.
- HTTP with a public URL and a fake login plugin: no cookie → `/api/runs` 401, `/` 302 to `/login`,
  `/login` 200; the callback with a good query sets the cookie and redirects to `/`, with a bad one
  403; the cookie then opens `/api/runs`; an expired or unknown cookie does not; `/logout` ends it;
  local requests need nothing; no login plugin → the public name serves only the setup page.
