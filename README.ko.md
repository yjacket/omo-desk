# omo-desk

> **지원 종료 - 설치하거나 사용하지 마세요.** 이 확장은 더 이상 유지되지 않으며 설치하거나 사용하면 안 됩니다. 대체품은 없습니다. [omo-inbox](https://github.com/yjacket/omo-inbox)가 omo/senpi 세션의 휴대폰 접근을 맡고 있지만 시각 기획안 보드는 제공하지 않습니다.

[English](README.md) | 한국어

시각 기획안을 위한 로컬 검토함입니다. omo 에이전트 세션이 보드(그림, 다이어그램, 질문)를 올리면 PC나 휴대폰 브라우저에서 검토하고, 의견은 그 기획안을 올린 세션으로 돌아갑니다. Node 24, 순수 ESM, npm 의존성 없음, 빌드 없음.

## 하는 일

- `desk submit <boardDir>` 는 보드 폴더를 검사하고, 참조한 파일을 모두 영구 기록으로 복사한 뒤 URL을 출력합니다.
- 검토함(`검토함`)은 열린 기획안을 제품(git remote)과 기능(브랜치 + 워크트리)별로 보여 줍니다.
- 기획안 페이지에서 보드를 보고, 그림에 영역을 표시하고, 질문에 답하고, 의견을 쓰고, 수정안을 요청(`재요청`)하거나 승인(`승인`)합니다.
- 의견은 소유 세션의 우편함에 쓰입니다. senpi 확장이 그 세션에 후속 턴으로 전달합니다.
- 세션은 `desk reply`, `desk revise`, `desk close` 로 답합니다. 모든 단계는 이벤트이며 덮어쓰지 않습니다.
- Tailscale에서는 같은 페이지가 `https://<machine>.<tailnet>.ts.net:4378` 로 제공되어 휴대폰으로도 검토할 수 있습니다.

## 설치

주된 설치 방법은 omo 패키지입니다. 저장소가 비공개라 git이 접근할 수 있어야 합니다:

```powershell
omo install git:github.com/yjacket/omo-desk
```

첫 omo 세션이 1분쯤 안에 스스로 설치합니다. 확장이 잠금(`<home>/setup.lock`) 아래 백그라운드에서 `desk install --from-package` 를 실행합니다. 설치는 clone을 `<home>/app` 으로 복사하고, `<home>/app/source.json`(channel `package`, source, sha, version), 실행기, Run 자동 시작 값, 스킬 사본, 규칙, tailscale 4378 serve 핸들러(443 보호 장치 포함)를 쓴 뒤 서버를 시작합니다. 세션이 몇 개 시작하든 설치는 하나만 돕니다. 실패한 설치는 10분 뒤 다시 시도합니다. 상태는 `<home>/setup-state.json` 에 있고, 실행마다 `<home>/logs/install.log` 에 한 줄을 남깁니다.

업데이트는 `omo update --extensions` 입니다. 1분쯤 안에 다음 세션 주기가 앱을 바꾸고 서버를 다시 시작하며, 쉬고 있는 세션은 새 확장으로 reload 합니다.

제거는 두 단계입니다. 먼저 `/desk uninstall`: 서버, 자동 시작, 실행기, 앱, 스킬, 규칙, 4378 핸들러를 지우고, `<home>/data` 는 남기며, 패키지가 움직이지 않도록 `<home>/disabled` 를 씁니다. 이 파일이 있는 동안 세션은 상태줄을 띄우지 않고, 설치나 서버 시작도 하지 않습니다. 그다음 `omo remove git:github.com/yjacket/omo-desk`. `/desk install` 은 꺼진 패키지를 다시 켭니다. `/desk uninstall` 없이 패키지를 지우면 서버가 clone이 사라진 것을 알아채고 20분 뒤 스스로 제거합니다(`DESK_ORPHAN_GRACE_MS`).

이전. 예전에 `install.ps1` 이나 `desk install` 로 한 설치는 패키지가 넘겨받습니다. 예전 `<agentDir>/extensions/omo-desk.ts` 사본이 있는 동안 패키지 확장은 설치만 실행합니다. 설치가 예전 사본을 지우면 세션이 reload 합니다.

개발자 설치. checkout 에서 `desk install`(또는 `install.ps1`)도 그대로 되며 `source.json` 에 channel `checkout` 을 기록합니다. 패키지는 이것을 덮어쓰지 않습니다. 패키지로 넘기려면 `desk uninstall` 을 실행합니다.

Windows PowerShell 한 줄로 checkout 없이 GitHub `main` 에서 개발자 설치를 합니다. `gh` 로그인(`gh auth login`)이 필요하고, Node 24 이상이어야 합니다:

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-desk/main/install.ps1 -Headers @{ Authorization = "token $(gh auth token)" } | iex
```

이렇게 파이프로 실행하면 `install.ps1` 은 `main` 을 임시 폴더에 받아 아래와 같은 `desk install` 을 실행한 뒤 폴더를 지웁니다. Node가 24보다 낮거나 GitHub 토큰이 없으면 한 줄로 알리고 멈춥니다. 아래 옵션은 checkout 에서 실행할 때만 쓸 수 있습니다.

checkout 에서:

```powershell
.\install.ps1                 # = node bin\desk.mjs install
.\install.ps1 --no-tailscale  # tailscale serve 생략
.\install.ps1 --no-autostart  # HKCU Run 값 생략
```

설치는 현재 폴더가 아니라 CLI가 들어 있는 체크아웃에서 복사합니다. 설치 사본(`<home>/app`)에서 실행하면 아무것도 멈추기 전에 거부합니다.

단계는 순서대로 실행되며 각각 `written | unchanged | skipped | failed:<reason>` 를 보고합니다.

| # | 단계 | 동작 |
| --- | --- | --- |
| 0 | `stop` | `/api/health` 가 응답하면 `/api/shutdown` 을 보내고 health가 실패할 때까지 기다림(최대 5초). |
| 1 | `app` | `<home>/app` 을 지우고 `bin src web extension skill rules package.json` 을 복사. |
| 2 | `launcher` | `<home>/launch-hidden.vbs` 작성. node를 `--max-semi-space-size=1 --max-old-space-size=128` 로 `<home>\app\src\server.mjs` 에 대해 숨김 실행. |
| 3 | `autostart` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 값 `omo-desk` = `wscript.exe "<home>\launch-hidden.vbs"`. |
| 4 | `extension` | `<agentDir>/extensions/omo-desk.ts` 로 복사. 패키지 설치는 대신 그 예전 사본을 지움(`legacy removed\|absent`). |
| 5 | `skill` | `~/.agents/skills/visual-board/` 와 `~/.claude/skills/visual-board/` 를 `<app>/skill/` 로 교체. |
| 6 | `rule` | `rules/visual-board.md` 를 `~/.claude/rules/visual-board.md` 로 복사. |
| 7 | `config` | `tailscale status --json` 에서 `publicBase`, `pcTailnetIps`, `owner` 를 읽음. tailscale이 없거나 Running이 아니면 `null`, `[]`, `null`. |
| 8 | `tailscale` | 443 보호 장치와 함께 4378 serve 핸들러 추가(Tailnet 참고). |
| 9 | `server` | `launchServer()` 로 시작하고 `/api/health` 를 기다림(최대 10초). |

패키지 설치가 `<home>/app` 에 같은 sha가 이미 있으면 아무것도 하지 않고 `app: current` 를 출력합니다. 서버가 꺼져 있으면 확장이 시작합니다.

마지막 줄은 `열린 omo 세션에서 /reload 하면 확장이 반영됩니다.` 입니다.

`<home>` 은 `OMO_DESK_HOME` 또는 `~/.omo-desk`. `<agentDir>` 은 `DESK_AGENT_DIR`, `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` 또는 `~/.omo/agent`.

`desk uninstall` 은 서버를 끄고, Run 값을 지우고, 확장, 스킬 폴더 두 개, 규칙을 지우고, 같은 보호 장치로 4378 핸들러를 끄고, `<home>/app`, 실행기, `config.json`, `server.json` 을 지웁니다. `<home>/data` 는 남기고 `data kept: <path>` 를 출력합니다. 지운 앱이 패키지 설치였으면 `<home>/disabled` 도 씁니다.

테스트와 격리 환경용 덮어쓰기: `DESK_USER_HOME`(사용자 home, 기본 `os.homedir()`), `DESK_RUN_VALUE`(Run 값 이름, 기본 `omo-desk`), `DESK_NO_TAILSCALE=1`(install, uninstall, doctor가 tailscale 호출을 모두 건너뜀), `DESK_AGENT_DIR`(`<agentDir>` 로 가장 먼저 확인), `DESK_ORPHAN_GRACE_MS`(주인 없는 서버의 자동 제거 지연, 기본 20분).

`desk doctor` 는 health, Run 값, 실행기, 앱 사본과 같은 확장(패키지 설치면 clone의 `extension/omo-desk.ts` 가 앱 사본과 같고 예전 `<agentDir>/extensions/omo-desk.ts` 가 없어야 함), 스킬과 규칙 존재, 4378 핸들러 존재, AllowFunnel에 4378 키 없음, 현재 443 Web 항목과 AllowFunnel이 `config.baseline443` 과 같은지 확인합니다. `<check>: ok|fail <detail>` 을 출력하고 모두 ok일 때만 0으로 끝납니다.

## 사용법 (CLI 표)

`desk` 는 PATH에 없습니다. 에이전트는 `node "<home>/app/bin/desk.mjs" <command>` 로 실행하며, 서버와 CLI는 안내문에 이 접두어를 그대로 넣습니다. `--json` 은 사람용 줄 대신 응답 JSON을 그대로 출력합니다.

| 명령 | 출력 | 종료 코드 |
| --- | --- | --- |
| `submit <boardDir> [--title t] [--note n] [--new] [--session id] [--session-file path]` | `id: <id>`, `url: <url>`, `owner: <id>` 또는 `owner: none` (서버가 `existing` 을 주면 `note: already submitted` 추가) | 0; 1 사용법 오류; 2 잘못된 보드(오류는 stderr); 3 서버 연결 불가; 8 내용이 다른 열린 기획안 중복 |
| `revise <id> <boardDir> [--note n] [--session id] [--session-file path]` | `id: <id>` `rev: <n>` `url: <url>` `owner: <id>` 또는 `owner: none` | 0; 1; 2; 3; 4 없음; 5 닫힘 |
| `reply <id> <text...>` (또는 `--file <path>`, `-` = stdin) `[--session id] [--session-file path]` | `ok <id> <status>` | 0; 1; 3; 4; 5 |
| `close <id> <summary...> [--session id] [--session-file path]` | `ok <id> closed`, 이어서 마지막 의견이 승인이면 `record: VISUAL-APPROVED <YYYY-MM-DD> <id> <url>`, 아니면 `record: VISUAL-CLOSED <YYYY-MM-DD> <id> <url>` | 0; 1; 3; 4; 5 |
| `show <id>` | `<title> (<id>) <status> <rev>안`, `url: <url>`, 이벤트마다 한 블록 (보고 보드는 `<status> 갱신 <n> report` 로 읽고, `feedback` 블록은 `ack` 로 읽습니다) | 0; 3; 4 |
| `list [--product p] [--feature f] [--status s]` | 항목마다 `<id>\t<status>\t<product.name>\t<branch>\t<title>` | 0; 3 |
| `pending [--session id] [--session-file path]` | 대기 알림 문구 또는 `none` | 0; 1; 3 |
| `wait <id> [--timeout sec]` | `WAITING <id>`, 이어서 `FEEDBACK <id> <seq>` + 의견 메시지, 또는 `CLOSED <id>` | 0; 4; 6 시간 초과 |
| `server status\|start\|stop\|restart` | `running pid=<pid> port=<port> version=<v>` 또는 `stopped` | 0; 7 꺼짐(status) |
| `install [--no-tailscale] [--no-autostart]`, `uninstall`, `doctor` | `<step>: <result>` 줄 | 0 성공; 1 하나라도 실패 |

종료 코드 8은 stderr에 `open proposal exists: <id> <url> - use: desk revise <id> <boardDir>, or desk submit --new` 를 출력합니다.

`submit` 과 `revise` 는 보드 폴더의 절대 경로와 현재 폴더의 identity를 보내고, 검사는 서버가 합니다. CLI는 서버와 통신하기 전에 `ensure` 를 실행합니다. `/api/health` 를 1500ms 제한으로 확인하고, 다른 프로그램이 응답하면 3으로 끝나고, 버전이 다르면 설치된 앱 버전이 CLI 버전과 같을 때만 `/api/shutdown` 후 다시 띄우고, 아니면 `server version <x> differs from cli <y>; run install to update` 경고를 내고 실행 중인 서버를 그대로 쓰고, 응답이 없으면 서버를 띄운 뒤 health를 최대 20번 확인합니다. `DESK_URL` 은 기본 URL을 바꾸고, `DESK_NO_ENSURE=1` 은 서버 실행을 건너뛰고, `DESK_WAIT_POLL_MS`(기본 2000)와 `DESK_ENSURE_POLL_MS`(기본 500)는 확인 간격입니다.

호출자 신원. `--session <id>` 와 `--session-file <path>` 는 호출한 세션을 명시합니다. 세션 ID는 명시한 `--session` > `DESK_SESSION` > `PI_SESSION_ID` > null 순으로 정합니다. 두 옵션이 없으면 env 동작은 그대로입니다. `--session` 만 주면 파일은 null로 기록하고, `--session-file` 은 준 값 그대로 기록하며, 그것만 주면 ID는 위 순서대로 정합니다. 경로를 읽거나 추측하지 않습니다. 값이 없거나 비었거나 `--` 로 시작하면(다음 옵션을 먹게 되면) 사용법 오류입니다. 종료 코드 1이며 `ensure` 와 모든 네트워크 호출보다 먼저 검사합니다. 다른 옵션 해석, 모르는 옵션 처리, 받아들이는 ID 형식은 바뀌지 않습니다. `sessionOf` 가 CLI의 유일한 소유 결정 지점입니다. `submit` 은 `identity.session` 으로, `revise`, `reply`, `close` 는 `session` 으로 보내고, `pending` 은 그것으로 조회합니다. `submit` 과 `revise` 는 서버의 `summary.owner` 로 `owner:` 줄을 출력하고, `--json` 출력은 그대로입니다.

소유. 바뀌지 않은 재제출(같은 hash, `existing`)은 소유자 없는 보드라도 기존 소유자, 안, 이벤트 수를 그대로 둡니다. 다른 세션이 명시적으로 `revise` 하면 소유가 옮겨질 수 있고, 자동으로 가져가는 일은 없습니다. 세션 없이 손으로 쓰는 것도 허용되며 보드는 소유자 없이 남습니다. env가 프로세스 경계를 늘 넘는 것은 아니므로(monitor 레인이나 env가 지워진 셸은 `DESK_SESSION` 을 잃을 수 있음) 그런 레인의 에이전트는 `--session` 을 직접 넘깁니다. `pending --session <id>` 는 그 id로 `/api/here` 를 부르므로 그 세션을 살아 있는 것으로 세기도 합니다(90초 안에 `/api/here` 를 부른 세션이 살아 있는 세션). cwd 신원은 지금의 제품 키(remote 없으면 `dir/<name>`) 그대로입니다. 소스 변경은 설치 사본을 갱신한 뒤에야(`desk install`, 이어서 `/reload` 나 재시작) 실제 세션에 반영됩니다.

Windows에서는 서버를 `Win32_Process.Create`(PowerShell, 숨김)로 만들어 호출한 터미널이 닫혀도 살아남게 합니다. WMI가 실패하거나 env 키 중 `OMO_DESK_` 또는 `DESK_` 로 시작하는 것이 있으면 분리된 `spawn` 으로 대신합니다.

## 보드 형식

보드는 `board.json`(스키마 `visual-board/1`)과 그것이 참조하는 파일이 담긴 폴더입니다.

```
{ title: string (필수, 비어 있으면 안 됨),
  lead?: string,
  sections?: [{ title: string, desc?: string,
    cards: [{ badge?, title?, layout?: 'one'|'two'|'', diagram?: boolean, gray?: boolean, note?, say?,
              frames: [[label, path], ...] (>= 1) }] }],
  questions?: [{ id: /^[A-Za-z0-9_-]{1,40}$/ 고유, text, help?,
    options: [{ value: /^[A-Za-z0-9_.-]{1,60}$/ 질문 안에서 고유, label, rec?: boolean, why? }] (>= 2) }],
  commentPlaceholder?: string,
  kind?: 'decision'|'report' }
```

- `kind` 가 없으면 `decision` 입니다. 다른 값은 `kind` 를 가리키는 오류입니다. `report` 보드는 질문 없는 완료 보고이므로 `questions` 항목이 하나라도 있으면 `questions` 를 가리키는 오류입니다.

- 엄격합니다. 다른 키는 오류입니다. 프로토타입의 최상위 `id` 는 무시하고, `sideSession`(문자열)은 `정할 것` 위에 회색 메모로 보입니다.
- 그림 라벨은 보드 전체에서 고유합니다. 표시는 라벨로 그림을 가리킵니다.
- `say`(카드)는 `듣기` 가 그 카드의 제목 다음에 메모 대신 읽는 말입니다. 그림을 귀로 듣고 알 수 있게 한국어로 씁니다.
- 그림 최대 60개, 질문 최대 30개. 그림이나 질문이 하나 이상 있어야 합니다.
- 그림 경로는 로컬 파일만 됩니다. URL과 절대 경로는 오류(`download the image into the board dir`)이므로 기록은 보여 준 그림을 모두 간직합니다. 상대 경로, 슬래시만, `:` 없음, 빈 / `.` / `..` 조각 없음, 200자 이하, 확장자 `.png .jpg .jpeg .gif .webp .svg .mmd`, 보드 폴더 안의 일반 파일.
- 모으는 파일: `board.json`, 참조된 그림 전부, 각 `x.svg` 옆에 `x.mmd` 가 있으면 그것도. 폴더를 훑지 않습니다. 파일 하나 20 MiB 이하, 합계 100 MiB 이하.
- 오류는 영어로 한 줄에 하나씩, JSON 경로를 앞에 붙입니다. 예: `questions[1].options: must have at least 2 options`.

동작하는 예시는 `skill/example/` 에 있습니다.

## 기획안 페이지

- 페이지 안의 그림: 마우스나 펜으로 그림 위를 끌면 그 자리에서 번호 붙은 네모가 그려집니다. 터치는 페이지 안에서 그리지 않으므로 그림 위에서 손가락을 움직이면 페이지가 스크롤됩니다.
- 끌지 않고 그림을 탭하거나 클릭하면(움직임 8 px 미만) 그 그림이 뷰어에서 전체 화면으로 열립니다. 그림 파일과 렌더된 `.mmd` 도식 모두 됩니다.
- 뷰어는 페이지 위에 뜨는 대화 상자이고, 위 막대에 그림 라벨, `표시하기`, `닫기` 가 있습니다. 그림은 처음에 화면에 맞춰 보입니다. 두 손가락 핀치로 두 손가락 가운데를 중심으로 확대·축소(1배~8배)하고, 한 손가락이나 마우스 드래그로 이동하고, 마우스 휠은 커서를 중심으로 확대·축소합니다. 그림을 화면 밖으로 끌어낼 수는 없습니다.
- `표시하기` 는 네모 하나를 그릴 준비를 합니다. 한 손가락이나 마우스로 그리면(두 손가락은 여전히 핀치) 버튼은 다시 꺼집니다. 여기서 만든 네모는 페이지 안에서 만든 것과 같습니다. 그림 기준으로 정규화되고, 번호가 붙고, `표시한 곳` 에 나열되고, 크롭과 함께 의견으로 전송됩니다.
- 이 그림의 네모는 뷰어에도 그려집니다. 네모를 탭하면 선택되고, 새로 그린 네모는 선택된 채로 시작합니다. 그러면 뷰어 아래쪽에 번호, 의견 칸, `지우기` 가 나타납니다. 의견은 `표시한 곳` 목록에 보이는 것과 같고, `지우기` 는 모든 곳에서 네모를 지웁니다. 네모 밖을 탭하면 아래쪽 칸이 들어갑니다. 화면 키보드가 올라오면 칸은 키보드 위로 옮겨집니다.
- 지난 안이나 끝난 기획안에서도 뷰어는 확대·이동용으로 열리지만 `표시하기` 와 아래쪽 칸은 없습니다.
- 2안부터 제목과 요약 사이에 `이 안이 나온 이유` 카드(보고 보드는 `이 갱신이 나온 이유`)가 나옵니다. 보고 있는 안이 나오게 된 과정을 차례대로 보여 줍니다: 앞 안에 보낸 내 의견, 세션 답, 그리고 고친 안의 메모. 줄 모양은 `대화` 와 같고, `대화` 는 아래에서 모든 이벤트를 그대로 보여 줍니다. 1안에는 카드가 없고, 앞에 의견, 답, 메모가 하나도 없는 안에도 없습니다.
- `대화` 와 `이 안이 나온 이유` 카드는 하늘색 바탕의 대화처럼 보입니다: 내 의견(답, 의견, 네모)은 이름 없이 오른쪽 노란 말풍선, 세션 답은 `🤖 세션 답` 이름을 단 왼쪽 흰 말풍선, 제출·고친 안·끝남은 가운데 작은 줄과 회색 띠의 메모로 나옵니다.
- `재요청` 은 답, 의견, 네모를 보내고 세션에 수정안을 요청합니다. 셋 중 하나는 있어야 합니다. `승인` 은 같은 내용을 보내면서 기획안을 승인합니다. 세션은 다시 보여 주지 않고 작업한 뒤 기획안을 닫습니다. 대화 기록에는 승인만 표시됩니다. 두 버튼은 처음 누를 때 잠기므로 한 번 누르면 한 번만 보냅니다. 보내지면 검토함으로 돌아가고, 실패하면 이유를 보이며 페이지에 남습니다. 닫기 버튼은 없습니다. 작업이 끝나면 세션이 `desk close` 로 기획안을 닫습니다.
- 보고 보드(`kind: report`)는 `재요청` 과 `승인` 대신 `확인` 버튼 하나를 보입니다. 의견과 네모를 담아 verdict `ack` 를 보냅니다. 머리글에 `보고` 칩이 붙고, 안 탭, 이벤트 표시, 새 안 배너는 `n안` 대신 `갱신 n` 으로 읽으며, `정할 것` 카드는 질문 없이 `확인` 으로 보입니다. `kind` 가 없는 요약은 결정 보드로 그립니다.
- 검토함은 보고 보드에 `보고` 칩과 `갱신 n` 을 보이고, `보고 N` 개수를 보이며, 열린 보고 보드를 결정 보드 다음에 따로 제목을 달아 묶습니다.
- `닫기`, Esc, 휴대폰의 뒤로 가기 동작으로 닫습니다. 뷰어는 히스토리 항목 하나이므로 뒤로 가기는 뷰어만 닫고 페이지는 그 자리에 남습니다.
- 제목 옆 `듣기` 는 보고 있는 안을 기기 자체 목소리(Web Speech `speechSynthesis`, 한국어)로 읽습니다. 순서: 가장 최근 일이 세션 답이면 그 답, 2안부터는 `이 안이 나온 이유` 카드(그 안의 의견과 답, 그다음 고친 안의 메모), 제목, 요약, 구획마다 구획 제목과 카드별 제목과 `say`(없으면 메모), 질문마다 선택지(추천인 것은 추천이라고 말하고 `why` 도 읽음), 마지막으로 `여기까지입니다`. 읽는 동안 버튼은 `멈추기` 가 되고, 화면이 넘어가도 왼쪽 아래에 떠 있는 `멈추기` 가 남아 있으며, 읽고 있는 카드에 테두리가 생기며 화면 가운데로 옵니다. 중간에 멈추면(`멈추기`, 음성 엔진 오류, 페이지가 뒤로 가 있는 사이 엔진이 말을 끊은 경우) 버튼은 `이어 듣기` 가 되어 읽던 조각부터 이어 읽고, 옆의 `처음부터` 는 처음부터 읽습니다. 끝까지 읽으면 다시 `듣기` 가 됩니다. 다른 안으로 바꾸면 멈추고 읽던 자리도 잊습니다.
- 말로 답하려면 `전체 의견` 에서 폰 키보드의 마이크를 씁니다. 의견 하나로 모든 질문에 답해도 됩니다.

## 데이터 구조

```
<home>/
  app/                 저장소의 설치 사본
  data/proposals/<id>/ 기록 (서버만 씀)
    proposal.json      { v: 1, id, title, created, product, feature, session, kind }, 한 번만, 마지막에 씀
    revs/<n>/...       안마다 복사한 보드 파일
    events/<seq6>-<type>.json
    crops/<seq6>-<n>.png
  inbox/<session>/<id>-<seq6>.json   기록 밖의 우편함. 전달 후 확장이 지움
  push/vapid.json      서버의 VAPID 키 쌍. 한 번만 만듦
  push/subscriptions.json   알림을 켠 브라우저들
  logs/  config.json  server.json  launch-hidden.vbs
```

- id는 `YYMMDD-xxxx`. JSON은 모두 임시 파일에 쓴 뒤 이름을 바꿉니다. 안은 `revs/<n>.tmp-<rand>` 에 복사한 뒤 다 되면 이름을 바꾸고, 색인 재구성은 `proposal.json` 이 없는 폴더와 `*.tmp-*` 폴더를 무시합니다.
- 이벤트: `submitted`, `feedback`, `reply`, `revised`, `closed`. 1부터 번호를 매기고 재사용하지 않습니다. `submitted` 와 `revised` 는 내용 `hash` 를 가집니다.
- 상태: `closed` 가 있으면 `closed`, 아니면 세션 답장을 건너뛰고 마지막이 `feedback` 일 때 `theirs`(내 의견이 세션을 기다리는 중, 승인이면 `approved`), 그 외는 `mine`(내 답을 기다리는 중). 답장은 상태를 바꾸지 않습니다. 의견 뒤에는 세션이 수정안을 올리거나 닫을 때까지 `theirs` 로 남습니다. 화면에는 `끝남`, `🤖 처리 중`, `🙋 답 필요` 로 나옵니다.
- 소유자는 세션 id가 있는 마지막 이벤트의 세션입니다.
- `kind` 는 제출 때 `proposal.json` 에 쓰고 모든 요약에 `kind` 로 보입니다. 없는 기록은 `decision` 으로 읽습니다. revise는 kind를 유지하고, 보드의 kind가 다른 revise는 400 `bad_input` 입니다.
- verdict: 결정 보드는 `change` 와 `approve`, 보고 보드는 `ack` 만(의견과 표시는 선택, 답 없음). 다른 조합은 400 `bad_input` 입니다. 의견도 표시도 없는 `ack` 은 의견 이벤트를 쓰고 같은 호출에서 `closed` 이벤트 `{ by: "user", summary: null }` 를 쓰며 우편함 파일은 쓰지 않습니다. 전달할 것이 없으므로 그 의견의 `delivery` 는 `none` 입니다. 의견이나 표시가 있는 `ack` 은 의견 이벤트만 씁니다. 상태는 `theirs` 가 되고, 평소의 우편함과 대기 알림 경로로 라우팅·전달되며, 소유 세션이나 다음 세션이 `desk close` 로 닫습니다.
- 열린 상태에서 같은 기능 + 제목으로 다시 올리면, 내용 hash가 같을 때 기존 기획안을 돌려주고 다르면 종료 코드 8입니다. `--new` 는 항상 새로 만듭니다.
- 의견의 `delivery` 는 계산값입니다: `none`(소유자 없음, 전달할 것 없음(의견도 표시도 없는 `ack`), 또는 우편함 쓰기 실패. 이벤트는 저장되고 서버가 한 번 재시도한 뒤 로그를 남김), `pending`(우편함 파일 있음), `delivered`.
- 전달 문구(우편함 파일의 `text`, `desk wait` 도 같은 문구를 출력)는 `처리:` 줄로 끝납니다. `재요청` 이면 세션에 `desk revise` 로 수정안을 올리라고 하고, 재요청은 승인이 아니니 확정하거나 작업을 시작하지 말라고 적습니다. `승인` 이나 `확인` 이면 `reply / revise / close` 를 나열합니다.
- 제품 키는 정규화한 `origin` remote(소문자 `host/path`), 기능 키는 `<제품 키>#<브랜치>`, 개수와 알림의 범위는 워크트리 경로입니다.

`config.json`: `{ "v": 1, "port": 4377, "publicBase": "https://<machine>.<tailnet>.ts.net:4378" | null, "pcTailnetIps": [...], "owner": "<tailscale login>" | null, "baseline443": {...} }`. `server.json` 은 서버만 씁니다: `{ "v", "name", "port", "pid", "started", "version" }`. 설치는 쓰지 않습니다.

## HTTP API

서버는 `127.0.0.1:4377`. 모든 POST는 `content-type: application/json` 과 `x-desk: 1` 이 필요합니다(없으면 403). 본문 제한 30 MiB(넘으면 413). `/api/*` 응답은 `cache-control: no-store`, 안 파일은 `public, max-age=31536000, immutable`.

| 메서드 | 경로 | 권한 | 응답 |
| --- | --- | --- | --- |
| GET | `/` | read | 검토함 페이지 |
| GET | `/p/<id>` | read | 기획안 페이지 |
| GET | `/web/<file>` | read | 정적 파일 |
| GET | `/sw.js` | read | 서비스 워커(`Service-Worker-Allowed: /`, `cache-control: no-cache`) |
| GET | `/files/<id>/revs/<n>/<path>`, `/files/<id>/crops/<file>` | read | 파일. 경로 탈출은 403 |
| GET | `/api/health` | read | `{ ok, name: 'omo-desk', version, pid, port }` |
| GET | `/api/caps` | read | `{ access, open, targets }` |
| GET | `/api/proposals?product=&feature=&status=` | read | `{ items, facets, counts }` (counts는 거르지 않은 전체 `{ mine, theirs, closed, reports }`, `reports` = 열린 보고 보드) |
| GET | `/api/p/<id>?since=<seq>` | read | `{ proposal, summary, url, revs, events }` |
| POST | `/api/p/<id>/feedback` | feedback | `{ ok, seq, status, routed, delivery }`. verdict는 `change`, `approve`, `ack`(데이터 구조 참고) |
| GET | `/api/push/key` | read | `{ publicKey }` (VAPID, base64url) |
| POST | `/api/push/subscribe` | feedback | `{ ok }`, 이어서 그 브라우저에 환영 푸시 |
| POST | `/api/push/unsubscribe` | feedback | `{ ok }` |
| POST | `/api/open` | open | `{ ok, cmd }` |
| POST | `/api/proposals` | session | `{ summary, url, existing }` |
| POST | `/api/p/<id>/revise` | session | `{ summary, url }` |
| POST | `/api/p/<id>/reply` | session | `{ summary }` |
| POST | `/api/p/<id>/close` | session | `{ summary }` |
| GET | `/api/here?cwd=&session=[&start=1]` | session | `{ product, feature, mine, theirs, pending, waiting, notice, noticeKeys, footer }` |
| POST | `/api/bye` | session | `{ ok }` |
| POST | `/api/shutdown` | session | `{ ok }`, 이후 종료 |

`waiting` 은 부른 세션의 열린 결정 보드 중 소유자 답을 기다리는 것을 나열합니다. 상태가 `mine` 이거나, `theirs` 인데 마지막 의견이 아직 전달되지 않은(delivery `pending`) 보드입니다. 항목은 `{ id, title, url, status, since, seq }` 이고, `since` 는 보드의 마지막 제출, 수정, 의견 이벤트 시각입니다(세션 답장은 바꾸지 않습니다). `seq` 는 `theirs` 일 때 마지막 의견의 seq, 아니면 `null` 입니다. 보고 보드, 소유자 없는 보드, 다른 세션의 보드는 나오지 않고, `session` 이 없으면 `[]` 입니다.

오류: `not_found` 404, `closed` 409, `duplicate` 409 `{ error, id, url }`, `bad_rev` / `bad_input` 400, `invalid_board` 400(`details` 포함), 권한 없음 403 `{ error: 'forbidden' }`, `/api/open` URL이 30000자를 넘으면 413 `{ error: 'too_long' }`, Aside 실행 파일이 없으면 `/api/open` 은 404 `{ error: "not_installed" }`.

`/api/open` 대상은 `web/targets.json`(ChatGPT, Claude, Claude 앱, Aside, 복사)에서 옵니다. PC 전용 대상은 `open` 권한이 필요합니다. Aside는 `--single-argument` 로 보드 URL을 받고, 나머지는 `rundll32 url.dll,FileProtocolHandler` 로 엽니다.

포트를 이미 omo-desk 서버가 쓰고 있으면 `node src/server.mjs` 는 조용히 0으로 끝나고, 다른 프로그램이면 로그를 남기고 3으로 끝납니다.

## 접근 권한

요청마다 `local`, `pc`, `tailnet`, `reject` 중 하나로 분류합니다.

1. 원격 주소가 루프백이 아니면 reject.
2. `tailscale-funnel-request` 헤더가 있으면 reject.
3. `x-forwarded-for` 가 없을 때 Host가 `127.0.0.1` 또는 `localhost` 면 local, 아니면 reject.
4. 첫 XFF 항목이 `pcTailnetIps` 에 있으면 pc (tailscaled가 자기 PC 트래픽에는 신원 헤더를 빼먹을 수 있어 신원보다 먼저 확인).
5. `tailscale-user-login` 이 없거나 `owner` 와 다르면 reject, 아니면 tailnet.

| 권한 | 허용 |
| --- | --- |
| read, feedback | local, pc, tailnet |
| open | local, pc |
| session | local |

그래서 tailnet의 휴대폰은 읽고 의견을 보낼 수 있지만, 세션처럼 제출하거나 닫거나 PC에서 프로그램을 띄울 수는 없습니다.

## 세션 깨우기

senpi 확장(`extension/omo-desk.ts`)은 하위 세션이나 task member 세션에서는 아무것도 하지 않습니다. 일반 세션에서는:

- 3초마다 `<home>/inbox/<session>/*.json` 을 읽습니다. 기획안이 아직 `theirs` 이거나 서버에 닿지 않으면 문구를 턴을 시작하는 후속 메시지로 전달하고 파일을 지웁니다. 메모리의 집합이 중복 전달을 막습니다.
- 30초마다, 세션 시작 때, 전달 직후에 `/api/here` 를 부릅니다. 하단 표시줄에 `🙋 {mine} 🤖 {theirs}` 가 나오고, 0인 쪽은 뺍니다. 서버가 꺼져 있으면 `보드 서버 꺼짐` 을 보이고 120초에 한 번까지 `desk server start` 를 실행합니다.
- 알림: 이 워크트리에서 기다리는 의견 중 소유 세션이 살아 있지 않은 것(90초 동안 `/api/here` 호출 없음, 종료, 하위 세션, id 없음)은 세션마다 한 번 알립니다. 재개된 세션은 시작할 때 자기에게 온 답 안 한 의견을 다시 안내받습니다.
- 종료 때 `/api/bye` 를 불러 소유자가 바로 떠난 것으로 셉니다.
- 기다리는 보드: `/api/here` 갱신이 성공할 때마다 답 시간 안의 `waiting` 보드를 senpi에 깨우기 출처 `omo-desk` 로 알리고(`wake_source_state` `{ source: "omo-desk", activeCount }`, 보류보다 먼저 보냄) goal 이어가기를 보류합니다(`continuation_hold_state` `{ source: "omo-desk", active }`). 이게 없으면 goal이 바로 다시 재촉하고, 에이전트는 보드를 질문 도구로 한 번 더 묻는데 보드 답으로는 그 질문이 풀리지 않습니다. senpi는 `source`/`activeCount` 와 `active` 만 읽습니다.
- 해제(보류 false, 그다음 개수 0)는 남은 보드가 없을 때와 종료 때 일어납니다. 서버에 닿지 않는 동안에는 마지막으로 받은 waiting 목록을 매 주기 로컬 시계로 다시 따집니다. 답 시간 안의 보드는 계속 세고, 지난 보드는 해제합니다.
- 답 시간은 senpi의 `askUser.timeoutMinutes`(기본 30)이고 1-120분으로 제한합니다. `since`, 곧 보드의 마지막 제출, 수정, 의견 이벤트부터 재며 세션 답장은 치지 않습니다. 질문 도구의 유휴 타이머와 달리 페이지를 봐도 다시 시작하지 않습니다. 읽을 수 없는 `since` 는 지난 것으로 칩니다. 상태가 `theirs` 인 보드는 항상 셉니다.
- 도구 실행이 끝날 때마다 갱신도 합니다(한 번에 하나, 진행 중에 요청이 오면 한 번 더). 그래서 턴 중에 제출한 보드도 턴이 끝나기 전에 셉니다.
- 무응답: `mine` 보드가 답 시간을 넘기면 세지 않고, 세션은 턴을 시작하는 후속 메시지 `[omo-desk] 답이 없습니다: <title> (<id>), <n>분` 을 보드와 마지막 이벤트 시각마다 한 번 받습니다. 세션 시작이나 reload 때 이미 답 시간이 지난 보드는 알리지 않습니다.
- 보드를 세는 동안 senpi는 이를 백그라운드 작업으로 보므로 그 턴의 Stop hook은 답 턴까지 미뤄집니다(소유자에게는 omo-desk 푸시 알림이 알립니다). 보류 중에는 senpi가 goal 카운트다운을 보이지 않고, 하단 `🙋 N` 이 표시입니다. 하위 세션과 senpi가 아닌 세션은 보류도 알림도 받지 않습니다.
- `/reload` 뒤에는 교체된 예전 확장 사본이 senpi가 자기 세대를 stale로 처음 알릴 때 타이머를 멈추므로, 지금 사본만 폴링하고 세션을 깨웁니다.

세션 id는 `DESK_SESSION` 또는 `PI_SESSION_ID` 에서 옵니다. 보드 종류 때문에 확장이 바뀌지는 않습니다. 의견을 단 보고 확인을 포함해 `theirs` 보드는 이미 전달합니다.

두 경로는 다릅니다. 우편함 후속 메시지는 자동이라 소유 세션에서 턴을 시작합니다. 대기 알림(`desk pending`, `/api/here`)은 수동이라 의견이 기다린다고 알리기만 하므로, 소유자 없는 보드는 보이지만 턴으로 전달되지는 않습니다.

## 알림

나에게 뭔가 오면 검토함이 닫혀 있어도 브라우저에 알림이 뜹니다. 알림을 누르면 그 기획안(`/p/<id>`)이 열립니다.

| 계기 | 제목 | 본문 |
| --- | --- | --- |
| 새 기획안(`existing` 재제출은 제외) | `새 기획안 · <title>` | `<제품> · <브랜치>` |
| `desk revise` | `수정본 <rev> · <title>` | 수정 메모, 없으면 `<제품> · <브랜치>` |
| `desk reply` | `답이 왔습니다 · <title>` | 답 문구를 120자까지 |

내가 보낸 의견과 `desk close` 는 알리지 않습니다. 푸시는 HTTP 응답을 보낸 뒤에 보내므로 응답을 늦추지 않고, 보내기에 실패하면 `logs/server.log` 에 남깁니다.

검토함 머리글에서 브라우저마다 한 번 켭니다. `알림 받기` 는 권한을 묻고, `/sw.js` 를 등록하고, 브라우저의 푸시 서비스로 구독한 뒤 구독 정보를 `/api/push/subscribe` 로 보냅니다(PC 페이지와 tailnet 페이지 모두 가능. Funnel은 다른 곳과 마찬가지로 거부). 서버는 환영 푸시로 답합니다. `알림 켜짐` 을 누르면 다시 꺼지고, `알림 막힘` 은 브라우저가 권한을 막았다는 뜻입니다. 페이지가 보안 컨텍스트가 아니거나(tailnet `https` 페이지와 `127.0.0.1` 은 맞고, 평범한 `http://<ip>` 페이지는 아님) 브라우저가 푸시를 지원하지 않으면 버튼이 숨겨집니다.

`<home>/push/` 에 저장합니다: `vapid.json`(서버의 P-256 키 쌍. 처음 쓸 때 만들고 임시 파일에 쓴 뒤 이름을 바꿈)과 `subscriptions.json`(endpoint당 한 항목: `endpoint`, `keys`, `created`, `ua`, `via`). 둘 다 비밀이며 이 PC에만 있습니다. 보내기는 구독의 endpoint로 `TTL: 86400`, `Urgency: high`, VAPID `Authorization` 헤더(ES256 JWT, 12시간), RFC 8291 `aes128gcm` 본문을 담아 POST하는 것입니다. 201/202면 전달, 404/410이면 구독을 지우고, 그 밖은 로그를 남기고 구독을 둡니다.

한계:

- 내용(제목, 본문, `/p/<id>`)은 브라우저까지 종단 간 암호화되어, 푸시 서비스(Google, Mozilla, Apple)는 무언가 보냈다는 사실만 봅니다.
- PC가 켜져 있고 서버가 돌고 있어야 합니다. 서버가 꺼져 있으면 쌓아 두지 않습니다.
- Android(삼성 인터넷): 탭과 브라우저를 닫아도 옵니다. 단 브라우저 앱을 강제 종료했거나 배터리 제한을 걸었다면 오지 않습니다.
- PC: 브라우저 프로그램이 실행 중이어야 합니다(백그라운드 프로세스면 충분하고 탭은 닫아도 됩니다).
- 브라우저마다, origin마다(PC의 `http://127.0.0.1:4377`, 휴대폰의 tailnet `https` origin) 따로 구독합니다.

## Tailnet

- 포트 4378만 씁니다: `tailscale serve --bg --https=4378 http://127.0.0.1:4377`.
- Funnel은 절대 쓰지 않습니다. 서버도 Funnel 요청을 거부합니다.
- 443은 건드리지 않습니다. 설치는 먼저 `serve status --json` 을 저장하고, 4378을 추가한 뒤 443 Web 항목, AllowFunnel, TCP 443이 그대로인지 확인합니다. 하나라도 다르면 4378을 다시 끄고 `failed:443-guard` 를 보고합니다. 기준값은 `doctor` 용으로 `baseline443` 에 저장합니다.
- 외부 URL은 `https://<machine>.<tailnet>.ts.net:4378/p/<id>` 꼴입니다.
- Orca 모바일 앱은 누른 화면 줄의 글자만 링크로 읽어서, 줄바꿈된 URL은 뒷부분(`:4378/...`)이 잘립니다. 터미널 하이퍼링크로 나가야 통째로 열립니다. `~/.omo/agent/settings.json` 에 `"terminal": { "hyperlinks": true }` 를 넣고(senpi는 Windows의 Orca에서 하이퍼링크를 꺼 둡니다), URL은 백틱 없이 그대로 출력합니다.

## 테스트

```
node --test "test/**/*.test.mjs"
```

테스트는 임시 home, 포트 0, `reg`·`tailscale`·`wscript` 가짜 실행기, 짧은 확인 간격을 씁니다. 실제 시간을 기다리지 않고, 실제 home, agent 폴더, tailscale도 건드리지 않습니다.

기획안 페이지 브라우저 QA(Bun 1.4 이상과 Chrome 필요, `node --test` 에는 들어가지 않음): `bun qa/send-qa.mjs`, `bun qa/viewer-qa.mjs`, `bun qa/read-aloud-qa.mjs`. 각각 임시 home에서 `src/server.mjs` 를 띄우고(포트 4399, 4395, 4398) 휴대폰·데스크톱 너비로 헤드리스 Chrome을 움직인 뒤 `N/N checks passed` 로 끝나고, 스크린샷은 출력한 임시 폴더에 남깁니다.

## 한계

- 설치, 자동 시작, 서버 실행은 Windows 전용입니다.
- 저장소에 remote가 생기기 전에 제출한 기획안은 `local/<name>` 제품 키를 그대로 가집니다.
- Orca 모바일 앱 안에서 휴대폰으로 누르는 동작은 기계로 검증하지 않았습니다.
- 뷰어의 핀치와 이동은 Chromium의 터치 에뮬레이션으로 확인했고 실제 휴대폰으로는 확인하지 않았습니다. 의견 칸이 화면 키보드 위에 머무는 것은 기계로 확인하지 않았습니다.
- `듣기` 는 브라우저의 음성 합성을 쓰므로, 브라우저가 뒤로 가거나 화면이 꺼지면 멈출 수 있습니다.
- 한 사람용입니다. tailnet 소유자 확인은 로그인 하나를 가정합니다.
- `/api/open` URL은 30000자로 제한됩니다(Windows 명령줄 한도). 더 긴 내용은 복사로 대신합니다.
