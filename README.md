# omo-desk

English | [한국어](README.ko.md)

A local review inbox for visual proposals. An omo agent session submits a board (pictures, diagrams, questions), you review it in the browser on your PC or phone, and your feedback goes back to the session that asked. Node 24, plain ESM, zero npm dependencies, no build step.

## What it does

- `desk submit <boardDir>` validates a board folder, copies every referenced file into a permanent record and prints a URL.
- The inbox (`검토함`) lists open proposals by product (git remote) and feature (branch + worktree).
- The proposal page shows the board, lets you mark regions on frames, answer questions, comment, then ask for a revision (`재요청`) or approve (`승인`).
- Feedback is written to the owning session's mailbox. The senpi extension delivers it into that session as a follow-up turn.
- Sessions answer with `desk reply`, `desk revise` or `desk close`. Every step is an event; nothing is overwritten.
- Over Tailscale the same pages are served on `https://<machine>.<tailnet>.ts.net:4378`, so you can review from your phone.

## Install

One line in Windows PowerShell installs or updates from GitHub `main` without a checkout. The repository is private, so `gh` must be logged in (`gh auth login`), and Node 24+ is required:

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-desk/main/install.ps1 -Headers @{ Authorization = "token $(gh auth token)" } | iex
```

Piped like this, `install.ps1` downloads `main` into a temp folder, runs the same `desk install` as below and deletes the folder. It stops with one line when Node is older than 24 or no GitHub token is found. The options below need the checkout form.

From a checkout:

```powershell
.\install.ps1                 # = node bin\desk.mjs install
.\install.ps1 --no-tailscale  # skip tailscale serve
.\install.ps1 --no-autostart  # skip the HKCU Run value
```

Install copies from the checkout the CLI lives in, not the current directory. Run from the installed copy (`<home>/app`), it refuses before stopping anything.

Steps, in order, each reporting `written | unchanged | skipped | failed:<reason>`:

| # | Step | What happens |
| --- | --- | --- |
| 0 | `stop` | If `/api/health` answers, POST `/api/shutdown` and wait until health fails (up to 5 s). |
| 1 | `app` | Delete `<home>/app`, copy `bin src web extension skill rules package.json` into it. |
| 2 | `launcher` | Write `<home>/launch-hidden.vbs`, which runs node with `--max-semi-space-size=1 --max-old-space-size=128` on `<home>\app\src\server.mjs`, hidden. |
| 3 | `autostart` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `omo-desk` = `wscript.exe "<home>\launch-hidden.vbs"`. |
| 4 | `extension` | Copy to `<agentDir>/extensions/omo-desk.ts`. |
| 5 | `skill` | Replace `~/.agents/skills/visual-board/` and `~/.claude/skills/visual-board/` with `<app>/skill/`. |
| 6 | `rule` | Copy `rules/visual-board.md` to `~/.claude/rules/visual-board.md`. |
| 7 | `config` | Read `tailscale status --json` into `publicBase`, `pcTailnetIps`, `owner`. Tailscale missing or not Running gives `null`, `[]`, `null`. |
| 8 | `tailscale` | Add the 4378 serve handler with the 443 guard (see Tailnet). |
| 9 | `server` | Start with `launchServer()` and wait for `/api/health` (up to 10 s). |

The last line is `열린 omo 세션에서 /reload 하면 확장이 반영됩니다.` Run `/reload` in open omo sessions.

`<home>` is `OMO_DESK_HOME` or `~/.omo-desk`. `<agentDir>` is `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` or `~/.omo/agent`.

`desk uninstall` shuts the server down, deletes the Run value, removes the extension, both skill dirs and the rule, turns the 4378 handler off with the same guard, removes `<home>/app`, the launcher, `config.json` and `server.json`. It keeps `<home>/data` and prints `data kept: <path>`.

`desk doctor` checks health, the Run value, the launcher, the extension matching the app copy, skill and rule present, the 4378 handler present, no 4378 key in AllowFunnel, and the current 443 Web entry and AllowFunnel deep-equal `config.baseline443`. It prints `<check>: ok|fail <detail>` and exits 0 only when every check is ok.

## Use (CLI table)

`desk` isn't on PATH. Agents run `node "<home>/app/bin/desk.mjs" <command>`; the server and CLI print that exact prefix in their hints. `--json` prints the raw response JSON instead of the human lines.

| Command | Human stdout | Exit |
| --- | --- | --- |
| `submit <boardDir> [--title t] [--note n] [--new]` | `id: <id>`, `url: <url>` (plus `note: already submitted` when the server returned `existing`) | 0; 2 invalid board (each error on stderr); 3 server unreachable; 8 duplicate open proposal with different content |
| `revise <id> <boardDir> [--note n]` | `id: <id>` `rev: <n>` `url: <url>` | 0; 2; 3; 4 not found; 5 closed |
| `reply <id> <text...>` (or `--file <path>`, or `-` = stdin) | `ok <id> <status>` | 0; 3; 4; 5 |
| `close <id> <summary...>` | `ok <id> closed`, then `record: VISUAL-APPROVED <YYYY-MM-DD> <id> <url>` when the latest feedback verdict is approve, else `record: VISUAL-CLOSED <YYYY-MM-DD> <id> <url>` | 0; 3; 4; 5 |
| `show <id>` | `<title> (<id>) <status> <rev>안`, `url: <url>`, then one block per event | 0; 3; 4 |
| `list [--product p] [--feature f] [--status s]` | `<id>\t<status>\t<product.name>\t<branch>\t<title>` per item | 0; 3 |
| `pending` | the pending notice text, or `none` | 0; 3 |
| `wait <id> [--timeout sec]` | `WAITING <id>`; then `FEEDBACK <id> <seq>` + the feedback message, or `CLOSED <id>` | 0; 4; 6 timeout |
| `server status\|start\|stop\|restart` | `running pid=<pid> port=<port> version=<v>` or `stopped` | 0; 7 stopped (status) |
| `install [--no-tailscale] [--no-autostart]`, `uninstall`, `doctor` | `<step>: <result>` lines | 0 ok; 1 any failed |

Exit 8 prints `open proposal exists: <id> <url> - use: desk revise <id> <boardDir>, or desk submit --new` on stderr.

`submit` and `revise` send the absolute board dir and the identity of the current directory; the server validates. Before talking to the server the CLI runs `ensure`: GET `/api/health` (1500 ms timeout). A foreign answer exits 3. On a version mismatch the CLI restarts the server (`/api/shutdown`, then a relaunch) only when the installed app's version equals the CLI's. Otherwise it warns `server version <x> differs from cli <y>; run install to update` and keeps using the running server. No answer launches the server, then up to 20 health checks. `DESK_URL` overrides the base URL, `DESK_NO_ENSURE=1` skips launching, `DESK_WAIT_POLL_MS` (default 2000) and `DESK_ENSURE_POLL_MS` (default 500) set poll intervals.

On Windows the server is created through `Win32_Process.Create` (PowerShell, hidden) so it outlives the caller's terminal. If WMI fails, or any env key starts with `OMO_DESK_` or `DESK_`, it falls back to a detached `spawn`.

## Board format

A board is a folder with `board.json` (schema `visual-board/1`) and the files it references.

```
{ title: string (required, non-empty),
  lead?: string,
  sections?: [{ title: string, desc?: string,
    cards: [{ badge?, title?, layout?: 'one'|'two'|'', diagram?: boolean, gray?: boolean, note?, say?,
              frames: [[label, path], ...] (>= 1) }] }],
  questions?: [{ id: /^[A-Za-z0-9_-]{1,40}$/ unique, text, help?,
    options: [{ value: /^[A-Za-z0-9_.-]{1,60}$/ unique in the question, label, rec?: boolean, why? }] (>= 2) }],
  commentPlaceholder?: string }
```

- Strict: any other key is an error. The prototype's top-level `id` is ignored and `sideSession` (string) shows as a gray note above `정할 것`.
- Frame labels are unique across the whole board; marks reference frames by label.
- `say` (card) is what `듣기` says for the card after its title, instead of its note: the pictures explained for the ear, in Korean.
- Up to 60 frames and 30 questions. A board needs at least one frame or one question.
- Frame paths are local files only. URLs and absolute paths are errors (`download the image into the board dir`), so the record keeps every picture it showed. Relative, forward slashes, no `:`, no empty / `.` / `..` segment, at most 200 chars, extension `.png .jpg .jpeg .gif .webp .svg .mmd`, a regular file inside the board dir.
- Collected files: `board.json`, every referenced frame, and for each `x.svg` its sibling `x.mmd` if it exists. The folder is never walked. Each file at most 20 MiB, total at most 100 MiB.
- Errors are English, one per line, prefixed with the JSON path, e.g. `questions[1].options: must have at least 2 options`.

See `skill/example/` for a working board.

## Proposal page

- Inline frames: a mouse or pen drag on a frame draws a numbered box right there. Touch never draws inline, so a finger over a frame scrolls the page.
- Tap or click a frame without dragging (under 8 px of movement) and the frame opens full screen in the viewer. It works for pictures and for rendered `.mmd` diagrams.
- The viewer is a dialog over the page with a top bar: the frame label, `표시하기` and `닫기`. The picture starts fitted to the screen. Two fingers pinch-zoom (1x to 8x) around the midpoint, one finger or a mouse drag pans, the mouse wheel zooms around the cursor. The picture can't be dragged off the screen.
- `표시하기` arms one box: one finger or the mouse draws it (two fingers still pinch), then the button turns off again. A box made here is the same as an inline one: normalized to the picture, numbered, listed under `표시한 곳`, sent with the feedback with its crop.
- Boxes of this frame are drawn in the viewer. Tap one to select it; a new box starts selected. The bottom of the viewer then shows its number, a comment field and `지우기`. The comment is the same one the `표시한 곳` list shows, and `지우기` removes the box everywhere. Tap outside the box to put the sheet away. When the on-screen keyboard opens, the sheet moves above it.
- On a past revision or a closed proposal the viewer still opens for zoom and pan, but has no `표시하기` and no sheet.
- `재요청` sends your answers, comment and boxes and asks the session for a revised board; it needs at least one of them. `승인` sends the same and approves the proposal: the session does the work without showing it again and closes it. Only an approval is tagged in the conversation. Both buttons lock on the first press, so one press sends once; a successful send goes back to the inbox, a failed one stays on the page with the reason. There is no close button: the session closes the proposal with `desk close` when the work is done.
- Close with `닫기`, Esc or the phone's back gesture. The viewer is one history entry, so back closes it and the page stays where it was.
- `듣기` next to the title reads the open revision aloud with the device's own voice (Web Speech `speechSynthesis`, Korean). Order: the session's reply when it is the newest event; on a revised proposal, what changed (the revise note); the title; the lead; each section title, then each card's title and its `say` (else its note); each question with its options, saying which one is recommended and its `why`; then `여기까지입니다`. While it reads, the button says `멈추기` and a floating `멈추기` at the bottom left stays on screen as the page scrolls; the card being read is outlined and scrolled into view. Switching revision stops it.
- To answer by voice, use the phone keyboard's microphone in `전체 의견`. One comment can answer every question.

## Data layout

```
<home>/
  app/                 installed copy of the repo
  data/proposals/<id>/ the record (the server is its only writer)
    proposal.json      { v: 1, id, title, created, product, feature, session }, written once and last
    revs/<n>/...       copied board files per revision
    events/<seq6>-<type>.json
    crops/<seq6>-<n>.png
  inbox/<session>/<id>-<seq6>.json   mailbox outside the record; the extension deletes after delivery
  push/vapid.json      the server's VAPID key pair, created once
  push/subscriptions.json   browsers that turned notifications on
  logs/  config.json  server.json  launch-hidden.vbs
```

- Ids are `YYMMDD-xxxx`. Every JSON write goes through a temp file and a rename. A revision is copied into `revs/<n>.tmp-<rand>` and renamed when complete; index rebuild ignores dirs without `proposal.json` and `*.tmp-*` dirs.
- Events: `submitted`, `feedback`, `reply`, `revised`, `closed`, numbered from 1 and never reused. `submitted` and `revised` carry a content `hash`.
- Status: any `closed` gives `closed`; otherwise a last `feedback` gives `theirs` (your feedback is waiting on the session, `approved` if the verdict was approve); otherwise `mine` (waiting on you).
- Owner is the session id of the latest event that has one.
- Submitting the same feature + title again while open returns the existing proposal when the content hash matches, otherwise exit 8. `--new` always creates.
- Feedback `delivery` is computed: `none` (no owner, or the inbox write failed: the event is stored, the server retried once and logged it), `pending` (inbox file present), `delivered`.
- Product key comes from the normalized `origin` remote (lowercased `host/path`), feature key is `<product key>#<branch>`, and the worktree path scopes counts and notices.

`config.json`: `{ "v": 1, "port": 4377, "publicBase": "https://<machine>.<tailnet>.ts.net:4378" | null, "pcTailnetIps": [...], "owner": "<tailscale login>" | null, "baseline443": {...} }`. `server.json` is written only by the server: `{ "v", "name", "port", "pid", "started", "version" }`. Install doesn't write it.

## HTTP API

Server on `127.0.0.1:4377`. All POSTs need `content-type: application/json` and `x-desk: 1` (else 403). Body limit 30 MiB (else 413). `/api/*` responses are `cache-control: no-store`; revision files are `public, max-age=31536000, immutable`.

| Method | Path | Access | Response |
| --- | --- | --- | --- |
| GET | `/` | read | inbox page |
| GET | `/p/<id>` | read | proposal page |
| GET | `/web/<file>` | read | static file |
| GET | `/sw.js` | read | the service worker (`Service-Worker-Allowed: /`, `cache-control: no-cache`) |
| GET | `/files/<id>/revs/<n>/<path>`, `/files/<id>/crops/<file>` | read | file; traversal -> 403 |
| GET | `/api/health` | read | `{ ok, name: 'omo-desk', version, pid, port }` |
| GET | `/api/caps` | read | `{ access, open, targets }` |
| GET | `/api/proposals?product=&feature=&status=` | read | `{ items, facets, counts }` (counts = unfiltered `{ mine, theirs, closed }`) |
| GET | `/api/p/<id>?since=<seq>` | read | `{ proposal, summary, url, revs, events }` |
| POST | `/api/p/<id>/feedback` | feedback | `{ ok, seq, status, routed, delivery }` |
| GET | `/api/push/key` | read | `{ publicKey }` (VAPID, base64url) |
| POST | `/api/push/subscribe` | feedback | `{ ok }`, then a welcome push to that browser |
| POST | `/api/push/unsubscribe` | feedback | `{ ok }` |
| POST | `/api/open` | open | `{ ok, cmd }` |
| POST | `/api/proposals` | session | `{ summary, url, existing }` |
| POST | `/api/p/<id>/revise` | session | `{ summary, url }` |
| POST | `/api/p/<id>/reply` | session | `{ summary }` |
| POST | `/api/p/<id>/close` | session | `{ summary }` |
| GET | `/api/here?cwd=&session=[&start=1]` | session | `{ product, feature, mine, theirs, pending, notice, noticeKeys, footer }` |
| POST | `/api/bye` | session | `{ ok }` |
| POST | `/api/shutdown` | session | `{ ok }`, then exit |

Errors: `not_found` 404, `closed` 409, `duplicate` 409 `{ error, id, url }`, `bad_rev` / `bad_input` 400, `invalid_board` 400 with `details`, access denied 403 `{ error: 'forbidden' }`, `/api/open` URL over 30000 chars 413 `{ error: 'too_long' }`, `/api/open` with the Aside exe missing 404 `{ error: "not_installed" }`.

`/api/open` targets come from `web/targets.json` (ChatGPT, Claude, Claude app, Aside, copy). PC-only targets need `open` access. Aside gets the board URL with `--single-argument`; others go through `rundll32 url.dll,FileProtocolHandler`.

If the port is already held by an omo-desk server, `node src/server.mjs` exits 0 quietly; anything else is logged and exits 3.

## Access

Each request is classified as `local`, `pc`, `tailnet` or `reject`:

1. Remote address not loopback -> reject.
2. `tailscale-funnel-request` header present -> reject.
3. No `x-forwarded-for`: Host `127.0.0.1` or `localhost` -> local, else reject.
4. First XFF entry in `pcTailnetIps` -> pc (checked before identity, since tailscaled may omit identity headers for the machine's own traffic).
5. No `tailscale-user-login`, or a login other than `owner` -> reject; else tailnet.

| Access | Allowed |
| --- | --- |
| read, feedback | local, pc, tailnet |
| open | local, pc |
| session | local |

So a phone on your tailnet can read and send feedback, but can't submit, close as a session, or launch programs on the PC.

## Session wake

The senpi extension (`extension/omo-desk.ts`) does nothing in child or task-member sessions. In a normal session:

- Every 3 s it reads `<home>/inbox/<session>/*.json`. When the proposal is still `theirs` (or the server is unreachable) it delivers the text as a follow-up message that starts a turn, then deletes the file. An in-memory set prevents double delivery.
- Every 30 s, at session start and after each delivery it calls `/api/here`. The footer shows `보드 내 차례 {mine} · 세션 차례 {theirs}`. If the server is down it shows `보드 서버 꺼짐` and runs `desk server start` at most once per 120 s.
- Notices: feedback waiting in this worktree whose owner isn't live (no `/api/here` call in 90 s, ended, child, or no id) is announced once per session. A resumed session is reminded of its own unanswered feedback at start.
- On shutdown it calls `/api/bye` so the owner counts as gone at once.
- After `/reload` the replaced copy of the extension stops its timers the first time senpi reports its generation as stale, so only the current copy polls and wakes the session.

Session ids come from `DESK_SESSION` or `PI_SESSION_ID`.

## Notifications

The browser gets a notification when something arrives for you, even with the inbox closed. Tapping it opens that proposal (`/p/<id>`).

| Trigger | Title | Body |
| --- | --- | --- |
| New proposal (not an `existing` resubmit) | `새 기획안 · <title>` | `<product> · <branch>` |
| `desk revise` | `수정본 <rev> · <title>` | the revise note, else `<product> · <branch>` |
| `desk reply` | `답이 왔습니다 · <title>` | the reply text, cut to 120 chars |

Your own feedback and `desk close` never notify. The push is sent after the HTTP response and never delays it; a failed send is logged to `logs/server.log`.

Turn it on from the inbox header, once per browser: `알림 받기` asks for permission, registers `/sw.js`, subscribes through the browser's push service and POSTs the subscription to `/api/push/subscribe` (so it works from the PC page and from the tailnet page; Funnel is rejected as everywhere else). The server answers with a welcome push. `알림 켜짐` turns it off again; `알림 막힘` means the browser blocked the permission. The button is hidden where the page is not a secure context (the tailnet `https` page and `127.0.0.1` are; a plain `http://<ip>` page is not) or the browser has no push support.

Stored in `<home>/push/`: `vapid.json` (the server's P-256 key pair, created on first use, written through a temp file and a rename) and `subscriptions.json` (one entry per endpoint: `endpoint`, `keys`, `created`, `ua`, `via`). Both are secrets; they stay on this PC. A send is a POST to the subscription's endpoint with `TTL: 86400`, `Urgency: high`, a VAPID `Authorization` header (ES256 JWT, 12 h) and an RFC 8291 `aes128gcm` body. 201/202 is delivered; 404/410 removes the subscription; anything else is logged and the subscription is kept.

Limits:

- The payload (title, body, `/p/<id>`) is end-to-end encrypted to the browser, so the push service (Google, Mozilla, Apple) only sees that something was sent.
- The PC must be on and the server running; nothing is queued for a server that is down.
- Android (Samsung Internet): it arrives with the tab and the browser closed, unless the browser app was force-stopped or is battery-restricted.
- PC: the browser program must be running (a background process is enough; the tab can be closed).
- Each browser and each origin (`http://127.0.0.1:4377` on the PC, the tailnet `https` origin on the phone) subscribes separately.

## Tailnet

- Port 4378 only: `tailscale serve --bg --https=4378 http://127.0.0.1:4377`.
- Never Funnel. Funnel requests are rejected by the server too.
- 443 is untouched. Install snapshots `serve status --json` first, and after adding 4378 it checks that the 443 Web entry, AllowFunnel and TCP 443 are unchanged. Any difference turns 4378 off again and reports `failed:443-guard`. The baseline is saved as `baseline443` for `doctor`.
- Public URLs look like `https://<machine>.<tailnet>.ts.net:4378/p/<id>`.
- The Orca mobile app reads a tapped link from the tapped screen row only, so a wrapped URL loses its tail (`:4378/...`). It opens whole only as a terminal hyperlink: set `"terminal": { "hyperlinks": true }` in `~/.omo/agent/settings.json` (senpi leaves hyperlinks off for Orca on Windows), and print the URL bare, not in backticks.

## Tests

```
node --test "test/**/*.test.mjs"
```

Tests use temp homes, port 0, fake runners for `reg`, `tailscale` and `wscript`, and short poll intervals. None of them wait on wall-clock time or touch the real home, agent dir or tailscale.

## Limits

- Windows only for install, autostart and launching.
- Proposals submitted before a repo gets a remote keep the `local/<name>` product key.
- The phone tap inside the Orca mobile app is not machine-verified.
- Viewer pinch and pan are checked with emulated touch in Chromium, not on a real phone. The comment sheet staying above the on-screen keyboard is not machine-checked.
- `듣기` uses the browser's speech synthesis, so it can stop when the browser goes to the background or the screen turns off.
- Single user: the tailnet owner check assumes one login.
- `/api/open` URLs are capped at 30000 chars (Windows command-line limit); longer content is copied instead.
