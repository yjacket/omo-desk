# omo-visual-board

English | [한국어](README.ko.md)

A local review inbox for visual proposals. An omo agent session submits a board (pictures, diagrams, questions), you review it in the browser on your PC or phone, and your feedback goes back to the session that asked. Node 24, plain ESM, zero npm dependencies, no build step.

## What it does

- `vb submit <boardDir>` validates a board folder, copies every referenced file into a permanent record and prints a URL.
- The inbox (`검토함`) lists open proposals by product (git remote) and feature (branch + worktree).
- The proposal page shows the board, lets you mark regions on frames, answer questions, comment, approve (`이대로 진행`) or close.
- Feedback is written to the owning session's mailbox. The senpi extension delivers it into that session as a follow-up turn.
- Sessions answer with `vb reply`, `vb revise` or `vb close`. Every step is an event; nothing is overwritten.
- Over Tailscale the same pages are served on `https://<machine>.<tailnet>.ts.net:4378`, so you can review from your phone.

## Install

```powershell
.\install.ps1                 # = node bin\vb.mjs install
.\install.ps1 --no-tailscale  # skip tailscale serve
.\install.ps1 --no-autostart  # skip the HKCU Run value
```

Steps, in order, each reporting `written | unchanged | skipped | failed:<reason>`:

| # | Step | What happens |
| --- | --- | --- |
| 0 | `stop` | If `/api/health` answers, POST `/api/shutdown` and wait until health fails (up to 5 s). |
| 1 | `app` | Delete `<home>/app`, copy `bin src web extension skill rules package.json` into it. |
| 2 | `launcher` | Write `<home>/launch-hidden.vbs`, which runs node with `--max-semi-space-size=1 --max-old-space-size=128` on `<home>\app\src\server.mjs`, hidden. |
| 3 | `autostart` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `omo-visual-board` = `wscript.exe "<home>\launch-hidden.vbs"`. |
| 4 | `extension` | Copy to `<agentDir>/extensions/visual-board.ts`. |
| 5 | `skill` | Replace `~/.agents/skills/visual-board/` and `~/.claude/skills/visual-board/` with `<app>/skill/`. |
| 6 | `rule` | Copy `rules/visual-board.md` to `~/.claude/rules/visual-board.md`. |
| 7 | `config` | Read `tailscale status --json` into `publicBase`, `pcTailnetIps`, `owner`. Tailscale missing or not Running gives `null`, `[]`, `null`. |
| 8 | `tailscale` | Add the 4378 serve handler with the 443 guard (see Tailnet). |
| 9 | `server` | Start with `launchServer()` and wait for `/api/health` (up to 10 s). |

The last line is `열린 omo 세션에서 /reload 하면 확장이 반영됩니다.` Run `/reload` in open omo sessions.

`<home>` is `OMO_VISUAL_BOARD_HOME` or `~/.omo-visual-board`. `<agentDir>` is `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` or `~/.omo/agent`.

`vb uninstall` shuts the server down, deletes the Run value, removes the extension, both skill dirs and the rule, turns the 4378 handler off with the same guard, removes `<home>/app`, the launcher, `config.json` and `server.json`. It keeps `<home>/data` and prints `data kept: <path>`.

`vb doctor` checks health, the Run value, the launcher, the extension matching the app copy, skill and rule present, the 4378 handler present, no 4378 key in AllowFunnel, and the current 443 Web entry and AllowFunnel deep-equal `config.baseline443`. It prints `<check>: ok|fail <detail>` and exits 0 only when every check is ok.

## Use (CLI table)

`vb` isn't on PATH. Agents run `node "<home>/app/bin/vb.mjs" <command>`; the server and CLI print that exact prefix in their hints. `--json` prints the raw response JSON instead of the human lines.

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

Exit 8 prints `open proposal exists: <id> <url> - use: vb revise <id> <boardDir>, or vb submit --new` on stderr.

`submit` and `revise` send the absolute board dir and the identity of the current directory; the server validates. Before talking to the server the CLI runs `ensure`: GET `/api/health` (1500 ms timeout). A foreign answer exits 3. A different version gets `/api/shutdown` and a relaunch. No answer launches the server, then up to 20 health checks. `VB_URL` overrides the base URL, `VB_NO_ENSURE=1` skips launching, `VB_WAIT_POLL_MS` (default 2000) and `VB_ENSURE_POLL_MS` (default 500) set poll intervals.

On Windows the server is created through `Win32_Process.Create` (PowerShell, hidden) so it outlives the caller's terminal. If WMI fails, or any env key starts with `OMO_VISUAL_BOARD_` or `VB_`, it falls back to a detached `spawn`.

## Board format

A board is a folder with `board.json` (schema `visual-board/1`) and the files it references.

```
{ title: string (required, non-empty),
  lead?: string,
  sections?: [{ title: string, desc?: string,
    cards: [{ badge?, title?, layout?: 'one'|'two'|'', diagram?: boolean, gray?: boolean, note?,
              frames: [[label, path], ...] (>= 1) }] }],
  questions?: [{ id: /^[A-Za-z0-9_-]{1,40}$/ unique, text, help?,
    options: [{ value: /^[A-Za-z0-9_.-]{1,60}$/ unique in the question, label, rec?: boolean, why? }] (>= 2) }],
  commentPlaceholder?: string }
```

- Strict: any other key is an error. The prototype's top-level `id` is ignored and `sideSession` (string) shows as a gray note above `정할 것`.
- Frame labels are unique across the whole board; marks reference frames by label.
- Up to 60 frames and 30 questions. A board needs at least one frame or one question.
- Frame paths are local files only. URLs and absolute paths are errors (`download the image into the board dir`), so the record keeps every picture it showed. Relative, forward slashes, no `:`, no empty / `.` / `..` segment, at most 200 chars, extension `.png .jpg .jpeg .gif .webp .svg .mmd`, a regular file inside the board dir.
- Collected files: `board.json`, every referenced frame, and for each `x.svg` its sibling `x.mmd` if it exists. The folder is never walked. Each file at most 20 MiB, total at most 100 MiB.
- Errors are English, one per line, prefixed with the JSON path, e.g. `questions[1].options: must have at least 2 options`.

See `skill/example/` for a working board.

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
  logs/  config.json  server.json  launch-hidden.vbs
```

- Ids are `YYMMDD-xxxx`. Every JSON write goes through a temp file and a rename. A revision is copied into `revs/<n>.tmp-<rand>` and renamed when complete; index rebuild ignores dirs without `proposal.json` and `*.tmp-*` dirs.
- Events: `submitted`, `feedback`, `reply`, `revised`, `closed`, numbered from 1 and never reused. `submitted` and `revised` carry a content `hash`.
- Status: any `closed` gives `closed`; otherwise a last `feedback` gives `theirs` (your feedback is waiting on the session, `approved` if the verdict was approve); otherwise `mine` (waiting on you).
- Owner is the session id of the latest event that has one.
- Submitting the same feature + title again while open returns the existing proposal when the content hash matches, otherwise exit 8. `--new` always creates.
- Feedback `delivery` is computed: `none` (no owner), `pending` (inbox file present), `delivered`.
- Product key comes from the normalized `origin` remote (lowercased `host/path`), feature key is `<product key>#<branch>`, and the worktree path scopes counts and notices.

`config.json`: `{ "v": 1, "port": 4377, "publicBase": "https://<machine>.<tailnet>.ts.net:4378" | null, "pcTailnetIps": [...], "owner": "<tailscale login>" | null, "baseline443": {...} }`. `server.json`: `{ "pid", "port", "started", "version" }`.

## HTTP API

Server on `127.0.0.1:4377`. All POSTs need `content-type: application/json` and `x-vb: 1` (else 403). Body limit 30 MiB (else 413). `/api/*` responses are `cache-control: no-store`; revision files are `public, max-age=31536000, immutable`.

| Method | Path | Access | Response |
| --- | --- | --- | --- |
| GET | `/` | read | inbox page |
| GET | `/p/<id>` | read | proposal page |
| GET | `/web/<file>` | read | static file |
| GET | `/files/<id>/revs/<n>/<path>`, `/files/<id>/crops/<file>` | read | file; traversal -> 403 |
| GET | `/api/health` | read | `{ ok, name: 'omo-visual-board', version, pid, port }` |
| GET | `/api/caps` | read | `{ access, open, targets }` |
| GET | `/api/proposals?product=&feature=&status=` | read | `{ items, facets, counts }` (counts = unfiltered `{ mine, theirs, closed }`) |
| GET | `/api/p/<id>?since=<seq>` | read | `{ proposal, summary, url, revs, events }` |
| POST | `/api/p/<id>/feedback` | feedback | `{ ok, seq, status, routed, delivery }` |
| POST | `/api/p/<id>/dismiss` | feedback | `{ ok, status: 'closed' }` |
| POST | `/api/open` | open | `{ ok, cmd }` |
| POST | `/api/proposals` | session | `{ summary, url, existing }` |
| POST | `/api/p/<id>/revise` | session | `{ summary, url }` |
| POST | `/api/p/<id>/reply` | session | `{ summary }` |
| POST | `/api/p/<id>/close` | session | `{ summary }` |
| GET | `/api/here?cwd=&session=[&start=1]` | session | `{ product, feature, mine, theirs, pending, notice, noticeKeys, footer }` |
| POST | `/api/bye` | session | `{ ok }` |
| POST | `/api/shutdown` | session | `{ ok }`, then exit |

Errors: `not_found` 404, `closed` 409, `duplicate` 409 `{ error, id, url }`, `bad_rev` / `bad_input` 400, `invalid_board` 400 with `details`, access denied 403 `{ error: 'forbidden' }`, `/api/open` URL over 30000 chars 413 `{ error: 'too_long' }`.

`/api/open` targets come from `web/targets.json` (ChatGPT, Claude, Claude app, Aside, copy). PC-only targets need `open` access. Aside gets the board URL with `--single-argument`; others go through `rundll32 url.dll,FileProtocolHandler`.

If the port is already held by an omo-visual-board server, `node src/server.mjs` exits 0 quietly; anything else is logged and exits 3.

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

The senpi extension (`extension/visual-board.ts`) does nothing in child or task-member sessions. In a normal session:

- Every 3 s it reads `<home>/inbox/<session>/*.json`. When the proposal is still `theirs` (or the server is unreachable) it delivers the text as a follow-up message that starts a turn, then deletes the file. An in-memory set prevents double delivery.
- Every 30 s, at session start and after each delivery it calls `/api/here`. The footer shows `보드 내 차례 {mine} · 세션 차례 {theirs}`. If the server is down it shows `보드 서버 꺼짐` and runs `vb server start` at most once per 120 s.
- Notices: feedback waiting in this worktree whose owner isn't live (no `/api/here` call in 90 s, ended, child, or no id) is announced once per session. A resumed session is reminded of its own unanswered feedback at start.
- On shutdown it calls `/api/bye` so the owner counts as gone at once.

Session ids come from `VB_SESSION` or `PI_SESSION_ID`.

## Tailnet

- Port 4378 only: `tailscale serve --bg --https=4378 http://127.0.0.1:4377`.
- Never Funnel. Funnel requests are rejected by the server too.
- 443 is untouched. Install snapshots `serve status --json` first, and after adding 4378 it checks that the 443 Web entry, AllowFunnel and TCP 443 are unchanged. Any difference turns 4378 off again and reports `failed:443-guard`. The baseline is saved as `baseline443` for `doctor`.
- Public URLs look like `https://<machine>.<tailnet>.ts.net:4378/p/<id>`.

## Tests

```
node --test "test/**/*.test.mjs"
```

Tests use temp homes, port 0, fake runners for `reg`, `tailscale` and `wscript`, and short poll intervals. None of them wait on wall-clock time or touch the real home, agent dir or tailscale.

## Limits

- Windows only for install, autostart and launching.
- Proposals submitted before a repo gets a remote keep the `local/<name>` product key.
- The phone tap inside the Orca mobile app is not machine-verified.
- Single user: the tailnet owner check assumes one login.
- `/api/open` URLs are capped at 30000 chars (Windows command-line limit); longer content is copied instead.
