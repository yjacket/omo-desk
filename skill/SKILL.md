---
name: visual-board
description: Put up a visual board for the user when a change touches screens, DB schema or flows, before calling plan-reviewer, at the completion report, or whenever the user asks for a board or 그림.
---

# visual-board

A board shows the user pictures of a change (screenshots, diagrams) plus a few questions, and collects their answer in a browser. Every board is kept as a record, so it has to carry its own files.

## When

- During ulw runs: when a screen, DB schema or flow changes. Put one up before plan-reviewer and one at the completion report.
- Any time the user asks for a board or 그림.
- Skip it when the user says "보드 생략".
- At session start, a visual-board notice means the user left feedback. Handle that first.

## Author

Make a folder `.omo/boards/<slug>/` with `board.json` and the files it points to.

```json
{
	"title": "수강권 확인 흐름",
	"lead": "강의 목록 전에 수강권을 확인합니다.",
	"sections": [{
		"title": "바뀌는 것",
		"cards": [{ "badge": "흐름", "title": "로그인 후 확인", "layout": "one", "diagram": true, "frames": [["흐름도", "flow.mmd"]] }]
	}],
	"questions": [{
		"id": "expired",
		"text": "만료되면 어떻게 할까요?",
		"help": "만료 회원이 목록을 볼 수 있는지가 정해집니다.",
		"options": [
			{ "value": "block", "label": "목록 막기", "rec": true, "why": "수강권 안내 화면으로 갑니다." },
			{ "value": "readonly", "label": "목록만 보기", "why": "재생만 막힙니다." }
		]
	}]
}
```

Rules the server checks (schema `visual-board/1`, unknown keys are errors):

- `title` is required. Optional: `lead`, `sections`, `questions`, `commentPlaceholder`, `sideSession`.
- Card keys: `badge`, `title`, `layout` (`one`, `two` or empty), `diagram`, `gray`, `note`, `frames`.
- `frames` is a list of `[label, path]`, at least one per card. Labels are unique across the whole board. At most 60 frames.
- Paths are local, relative, forward slashes, inside the board folder. No URLs, no absolute paths: download images into the folder. Extensions: `.png .jpg .jpeg .gif .webp .svg .mmd`. Max 20 MiB per file, 100 MiB total.
- The board needs at least one frame or one question.
- Question `id` matches `[A-Za-z0-9_-]{1,40}`, option `value` matches `[A-Za-z0-9_.-]{1,60}`. Each question has 2 or more options. At most 30 questions.

Content:

- Screenshots go in as PNG.
- Diagrams are mermaid `.mmd` files used directly as frames: `flowchart`, `erDiagram`, `sequenceDiagram`, `stateDiagram-v2`.
- Every question gets `help` (why it matters). Every option gets `why` (what happens if chosen). Mark exactly one option `rec: true`.
- Write user-facing text in Korean, short and label-level.

See `example/` for a working board.

## Submit

```sh
node "$HOME/.omo-visual-board/app/bin/vb.mjs" submit .omo/boards/<slug>
```

In the rest of this skill, `vb` means `node "$HOME/.omo-visual-board/app/bin/vb.mjs"` (the messages the extension delivers already print the full command).

It prints `id: <id>` and `url: <url>`. Put the url line in your reply to the user. Exit 2 means the board is invalid (errors on stderr). Exit 8 means an open proposal already exists: use `vb revise <id> <dir>` instead, or `submit --new`.

## After submitting

- The extension delivers the user's feedback to you as a message. Read it in full with `vb show <id>`.
- Answer a comment: `vb reply <id> <text>`.
- Change the board: edit the folder, then `vb revise <id> .omo/boards/<slug> --note "<what changed>"`.
- Once the user chose 이대로 진행 and the work is done: `vb close <id> <summary>`. Copy the printed `record:` line into your report.
- Not running under senpi? Start `vb wait <id>` in the background. It prints `FEEDBACK <id> <seq>` with the message when the user answers, or `CLOSED <id>`.
