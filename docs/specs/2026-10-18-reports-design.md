# Serving agents' HTML reports

## Problem

Agents write HTML reports for the person (a plan to agree, an investigation). Since
[2026-10-18-run-chat-design.md](2026-10-18-run-chat-design.md) they reach the person's messenger as
a file attachment: on a phone that is a download, then "open with", and a file cannot be updated
in place or handed to anything but the messenger. A report should be a link that opens in the
phone's browser from anywhere.

## Goals

- `flow publish FILE` stores a copy of the file and prints a link to it.
- `flow say --file report.html` sends that link instead of the file when reports are served.
- The link opens from outside the home network, through the router's HTTPS reverse proxy.
- Nothing of flowd but the reports is reachable from outside.

## Non-goals

- A login in front of the reports: the link itself is the secret (decided: an unguessable link,
  no login).
- Folders (a report with images next to it): reports are self-contained HTML.
- A list of reports in the UI; uploading from anywhere but flowd's own disk.
- Configuring the router: a person adds the reverse-proxy entry by hand (it is in the docs).

## Decisions

### Storage and links

- `flow publish FILE` (HTTP `POST /api/publish {file}`): flowd copies the file to
  `<state dir>/reports/<token>/<name>`, where `<token>` is 128 random bits in hex and `<name>` is
  the file's base name with anything but letters, digits, `.`, `-`, `_` replaced by `-`. It answers
  `{url: "<FLOWS_REPORTS_URL>/r/<token>/<name>"}`; the CLI prints the URL. Each publish is a new
  token: a report updated while the person argues is published again, and the old link still shows
  the old version until it expires.
- Reports older than 30 days (by the folder's time) are deleted at start and once a day.
- Refused: no such file, not a regular file, over 20 MB, or reports not served
  (`reports are not served: set FLOWS_REPORTS_URL (docs/cli.md#flow-publish)`).

### The reports server

- A second HTTP listener, separate from the UI and API: `FLOWS_REPORTS_PORT` (default 7430) on
  `FLOWS_REPORTS_HOST` (default `0.0.0.0`: the router connects over the LAN). It starts only when
  `FLOWS_REPORTS_URL` is set (the public base, e.g. `https://reports.<name>.keenetic.link`).
- It answers `GET`/`HEAD /r/<32 hex>/<name>` with the file and nothing else: every other path,
  method or a name that does not match is 404. No directory listing, no `/api`, no UI. The path is
  checked by pattern, never joined from raw input.
- Headers: `content-type` from the extension (`.html` → `text/html; charset=utf-8`, unknown →
  `application/octet-stream`), `x-content-type-options: nosniff`, `referrer-policy: no-referrer`
  (a link in the report does not leak the report's URL), `x-robots-tag: noindex, nofollow`,
  `cache-control: private, max-age=300`.
- A report's own JavaScript runs (Mermaid from a CDN): it is on its own origin, the reports host,
  with nothing of flowd's there to reach.

### In the conversation

- `flow say --file F` when reports are served and `F` ends in `.html`/`.htm`: flowd publishes `F`
  and posts the text followed by the link, without a file. Other files, or reports not served:
  sent as a file, as before.
- The Telegram adapter sends every message with link previews off: a preview makes Telegram's
  servers fetch the link.

### Exposure

The router's reverse proxy (KeenDNS on a Keenetic: `ip http proxy reports`, upstream this machine
on `FLOWS_REPORTS_PORT`, `security-level public`) gives the public HTTPS name. When flowd moves to
another host, only the proxy's upstream changes. `docs/cli.md` describes the setup in general
terms; the router change itself is the person's.

## Testing

- `flow publish`: the copy lands under a 32-hex token with the cleaned name, the URL is
  `FLOWS_REPORTS_URL` + path; refusals (missing file, a directory, too big, not served).
- The server: the file with its headers for GET and HEAD; 404 for `/`, `/api/runs`, a wrong token
  shape, `..` in the name, another method; it does not start without `FLOWS_REPORTS_URL`.
- Expiry: a folder older than 30 days is deleted at start, a newer one kept.
- `flow say --file x.html` with reports served posts text + link and no file; a `.pdf` still goes
  as a file; without reports served the `.html` goes as a file.
- Telegram: `sendMessage` carries `link_preview_options: {is_disabled: true}`.
