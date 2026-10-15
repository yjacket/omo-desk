---
name: visual-board
description: Put up a visual board whenever a change would otherwise be asked in chat - a decision board before plan confirmation for the larger choices, a report board when finished work shows a screen the user has not seen, or whenever the user asks for a board or 그림.
---

# visual-board

A board shows the user pictures of a change (screenshots, diagrams) plus a few questions, and collects their answer in a browser. Every board is kept as a record, so it has to carry its own files. During execution, ask nothing in chat: only boards notify the user.

## When

A board goes up at the moment you would otherwise ask the user a question. Pictures, diagrams and `듣기` explain the question better than prose.

- Before confirming a plan: a decision board for the larger choices.
- Work the user asked for in chat gets no start board and no report points in the first reply. When it ends, post a report board (no questions) if a screen or display changed; otherwise end in chat. A chat request that arrives after a board was closed is chat work too.
- Board work is work under an approved plan (with or without a board) or work that went through a decision or blocker board you posted for it.
- When board work is done, check for something to see: a screen or display the user has not seen on the board. If there is one, post a report board (no questions) and close the earlier board if there is one. If not, `desk reply` a summary on the earlier board and then `desk close` it (a reply notifies the user; a close alone does not); with no earlier board (a plan approved in chat), end in chat. Put any request changed after approval, decision the board never showed, or recommended option taken because nobody answered into that report or reply.
- A change inside the given task and its constraints is not a question. Decide it, and record the decision in the report board's `달라진 점` card, or in the reply or chat answer when there is no report board.
- A change outside your authority is a question: cost, deletion, scope, taste, and credentials, permissions, spend or any irreversible action. Put it on a decision board with the context, and if the user does not answer, follow the question tool's rule: take the recommended option when it is reversible, otherwise stop.
- The user asks for a board or 그림: always.
- The user says "보드 생략": skip that board.
- Only the root session puts up boards. A child task reports its grounds to the root session instead.
- At session start an omo-desk notice means the user left feedback. Read and dispose of it before anything else.

## Author

Make a folder `.omo/boards/<slug>/` with `board.json` and the files it points to.

```json
{
	"kind": "decision",
	"title": "수강권 확인 흐름",
	"lead": "강의 목록 전에 수강권을 확인합니다.",
	"sections": [{
		"title": "바뀌는 것",
		"cards": [{ "badge": "흐름", "title": "로그인 후 확인", "layout": "one", "diagram": true, "frames": [["흐름도", "flow.mmd"]] }]
	}],
	"questions": [{
		"id": "expired",
		"text": "만료되면 어떻게 할까요?",
		"help": "지금은 만료된 회원에게 목록과 재생을 모두 보여 줍니다. 이 답에 따라 만료 회원이 보는 화면이 정해집니다.",
		"options": [
			{ "value": "block", "label": "목록 막기", "rec": true, "why": "수강권 안내 화면으로 갑니다." },
			{ "value": "readonly", "label": "목록만 보기", "why": "재생만 막힙니다." }
		]
	}]
}
```

A report board has no questions and carries the before and after side by side in a `달라진 점` card:

```json
{
	"kind": "report",
	"title": "설치 완료 보고",
	"lead": "설치가 끝났습니다. 달라진 점만 봅니다.",
	"sections": [{
		"title": "달라진 점",
		"cards": [{ "badge": "설치", "title": "앱과 스킬 교체", "layout": "two", "frames": [["이전", "before.png"], ["이후", "after.png"]] }]
	}]
}
```

Rules the server checks (schema `visual-board/1`, unknown keys are errors):

- `title` is required. Optional: `kind`, `lead`, `sections`, `questions`, `commentPlaceholder`, `sideSession`.
- `kind` is `"decision"` (the default when absent) or `"report"`. Any other value is an error. A `report` board has no `questions`: any question makes it invalid. Everything else is unchanged.
- Card keys: `badge`, `title`, `layout` (`one`, `two` or empty), `diagram`, `gray`, `note`, `say`, `frames`.
- `frames` is a list of `[label, path]`, at least one per card. Labels are unique across the whole board. At most 60 frames.
- Paths are local, relative, forward slashes, inside the board folder. No URLs, no absolute paths: download images into the folder. Extensions: `.png .jpg .jpeg .gif .webp .svg .mmd`. Max 20 MiB per file, 100 MiB total.
- The board needs at least one frame or one question.
- Question `id` matches `[A-Za-z0-9_-]{1,40}`, option `value` matches `[A-Za-z0-9_.-]{1,60}`. Each question has 2 or more options. At most 30 questions.

Content:

- Ask only about the outcome the user lives with, never about how the work is done. Do not ask about commit granularity, restarting an installed copy, whether to show a test board, or which tool to use: decide those and record the decision instead.
- Every question gets `help` that states the situation which produced the question and what changes with the answer, written for a first-time reader - not a definition of terms.
- Screenshots go in as PNG.
- Diagrams are mermaid `.mmd` files used directly as frames: `flowchart`, `erDiagram`, `sequenceDiagram`, `stateDiagram-v2`.
- Every option gets `why` (what happens if chosen). Mark exactly one option `rec: true`.
- Every card gets `say`: one to three Korean sentences that explain its pictures to someone listening without the screen, for example while driving. Say what the picture shows and what it means for the decision. Name things instead of pointing (no 위 그림, 왼쪽), and leave out paths, code and symbols. `듣기` reads the title, `lead`, each card's title and `say`, then every question with its options and `why`, so write those to be heard as well.
- Write user-facing text in Korean, short and label-level.

See `example/` for a working board.

## Submit

```sh
node "$HOME/.omo-desk/app/bin/desk.mjs" submit .omo/boards/<slug>
```

In the rest of this skill, `desk` means `node "$HOME/.omo-desk/app/bin/desk.mjs"` (the messages the extension delivers already print the full command).

It prints `id: <id>` and `url: <url>`. Put the url in your reply to the user as a bare URL on its own line, not in backticks or a code block: only a bare URL becomes a terminal hyperlink, which stays whole when a phone screen wraps it. Exit 2 means the board is invalid (errors on stderr). Exit 8 means an open proposal already exists: use `desk revise <id> <dir>` instead, or `submit --new`. First check the owner with `desk show <id> --json`. Revise only a board you own (or an ownerless one under the one-time binding rule in Identity). If another session owns it, use `submit --new` or leave it to that session.

### Identity

Read your own identity from the environment programmatically and pass it as a literal argument:

- `env("PI_SESSION_ID")` is the session id, required under Senpi.
- `env("PI_SESSION_FILE")` is the transcript path, optional.

Pass both in the space form, with the actual values you read:

```sh
desk submit .omo/boards/<slug> --session 01a10d2e-f678-79d6-9625-27892d1759db --session-file /path/to/session.jsonl
```

Never shell-expand a possibly-absent variable and never use `--session=...`. The shell process often does not inherit `PI_SESSION_ID` (a monitor lane or a stripped shell loses it), so `$PI_SESSION_ID` silently becomes an empty or missing argument; the space form takes the value you read, and `--session=<value>` is silently ignored as an unknown option, so the board falls back to env identity - always use the space form. This applies to `submit`, `revise`, `reply`, `close` and `pending`. Run every command from the intended worktree: the board directory's location does not choose identity.

When you run desk under a monitor, include `owner:` in the filter (for example `^(id|url|owner):`) so the owner line reaches you.

The command prints `owner: <id>`. Before you tell the user feedback is connected, confirm that id equals your own session id. `owner: none` means an ownerless board that nothing will wake you about; if the board came up ownerless before any feedback, you may bind it to yourself once with a deliberate `desk revise` carrying a `--note` that says why. It creates a new revision and notifies the user's browser, so do it only once.

Not running under Senpi: keep using `desk wait <id>` in the background. `desk show <id> --json` supplies an owner check; `wait` itself does not.

## After submitting

- An open decision board is your pending question. Never ask the same thing with `ask_user_question` or in chat: a board answer cannot settle a question-tool request, so a mirrored question stays pending after the user answers the board. End the turn.
- While a decision board you own waits inside the question tool's answer window (`askUser.timeoutMinutes`, default 30 minutes), the extension reports it to senpi as the live resumption channel `omo-desk` and holds goal continuation, so a goal does not re-prompt you; if a continuation still arrives, run `desk show <id>`, and while the board is open end the turn with the same one-line status naming the board id, without asking again.
- If the window passes with no answer, the extension sends `[omo-desk] 답이 없습니다: ...` once. Apply the no-answer rule: take the recommended option when it is reversible and say so with `desk reply <id> <text>`, otherwise stop: do not ask again, end each turn with one sentence naming the blocker and the board URL, and set the goal blocked when senpi accepts it. A later answer is still delivered.
- While a board is open, the goal prompt's and stall notice's advice to use the question tool does not apply: the board is the question.

- The extension delivers the user's feedback to you as a message. Read it in full with `desk show <id>`.
- Answer a comment: `desk reply <id> <text>`.
- Never `desk reply` to adopt a board while its feedback is pending: reply sets the status to mine and the extension can drop the waiting payload.
- The user may answer every question in one comment, often dictated by voice. Match each answer to its question. When they ask for more explanation, revise the board with a fuller `say` (and `lead`) rather than only replying.
- Change the board: edit the folder, then `desk revise <id> .omo/boards/<slug> --note "<what changed>"`.
- Revise only when the board's content changes. Never revise on a timer to show progress.
- Once the user chose 승인 and the work is done: end it as the something-to-see check in When says (a report board, or a `desk reply` summary), then `desk close <id> <summary>`. Copy the printed `record:` line into your report.
- For a report board, put the URL in your final message and never `desk wait` on it. A 확인 without a comment closes it by itself. A 확인 with a comment arrives as feedback like today (or as the pending notice in the next conversation): read it, reply if needed, then `desk close <id> <summary>`.
- When the user answers a board question in chat instead, run `desk close <id> "<the answer as given>"` at once.
- When feedback arrives for a board whose decision is already settled, or whose work has moved on: run `desk show <id>`, compare it with the current state, `desk reply` that it was settled, and `desk close` without acting.
- A blocker board's `lead` states what was being done, why it is blocked, the options with one recommendation, and what happens without an answer.
- Not running under senpi? Start `desk wait <id>` in the background. It prints `FEEDBACK <id> <seq>` with the message when the user answers, or `CLOSED <id>`.
