import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { createDesk } from "../extension/omo-desk.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(REPO, "web");
const BIN = path.join(REPO, "bin", "desk.mjs");
const toSlash = (value) => value.replace(/\\/g, "/");
const CLI_HINT = `node "${toSlash(BIN)}"`;
const REPO_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

function board() {
	return {
		title: "테스트 보드",
		sections: [{ title: "화면", cards: [{ title: "로그인", frames: [["로그인 화면", "screen.svg"]] }] }],
		questions: [
			{
				id: "q1",
				text: "어떻게 할까요?",
				options: [
					{ value: "a", label: "A안" },
					{ value: "b", label: "B안" },
				],
			},
		],
	};
}

function makeBoard(dir) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board()));
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	return dir;
}

function makeGitRepo(home) {
	const dir = path.join(home, "repo");
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, windowsHide: true });
	return dir;
}

async function setup(t) {
	const tmp = makeTmpHome("desk-cli-");
	const server = createServer({
		home: tmp.home,
		webDir: WEB,
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: [], owner: null },
	});
	const { port } = await server.listen();
	const repo = makeGitRepo(tmp.home);
	t.after(async () => {
		await server.close();
		tmp.cleanup();
	});
	return { home: tmp.home, base: `http://127.0.0.1:${port}`, port, repo };
}

function childEnv(home, base, extra = {}) {
	const env = {
		...process.env,
		DESK_NO_ENSURE: "1",
		PI_SESSION_ID: "test-sess",
		DESK_WAIT_POLL_MS: "20",
		DESK_ENSURE_POLL_MS: "20",
		OMO_DESK_HOME: home,
	};
	if (base) env.DESK_URL = base;
	else delete env.DESK_URL;
	Object.assign(env, extra);
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	return env;
}

function spawnCli(ctx, args, { cwd, env: extra, input } = {}) {
	const child = spawn(process.execPath, [BIN, ...args], {
		cwd: cwd ?? ctx.repo,
		env: childEnv(ctx.home, ctx.base, extra),
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	if (input !== undefined) child.stdin.end(input);
	const done = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
	return { child, done, text: () => ({ stdout, stderr }) };
}

async function runCli(ctx, args, options) {
	return spawnCli(ctx, args, options).done;
}

function postJson(base, route, body) {
	return fetch(base + route, {
		method: "POST",
		headers: { "content-type": "application/json", "x-desk": "1" },
		body: JSON.stringify(body),
	});
}

function idOf(result) {
	const match = result.stdout.match(/^id: (\S+)/m);
	assert.ok(match, `no id line in stdout:\n${result.stdout}`);
	return match[1];
}

function waitForText(child, marker, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk) => {
			buffer += chunk;
			if (buffer.includes(marker)) {
				cleanup();
				resolve(buffer);
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out waiting for "${marker}"\n${buffer}`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
		};
		child.stdout.on("data", onData);
	});
}

test("submit prints the id and url lines", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "proto"));
	const result = await runCli(ctx, ["submit", dir, "--title", "로그인 개편"]);
	assert.equal(result.code, 0, result.stderr);
	const id = idOf(result);
	assert.ok(result.stdout.includes(`url: ${ctx.base}/p/${id}`), result.stdout);
});

test("submit of an invalid board exits 2 and lists the errors", async (t) => {
	const ctx = await setup(t);
	const dir = path.join(ctx.repo, "broken");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), "{ not json");
	const result = await runCli(ctx, ["submit", dir]);
	assert.equal(result.code, 2, result.stdout);
	assert.match(result.stderr, /board\.json/);
});

test("list, show and pending read the server", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "proto"));
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "목록"]));

	const list = await runCli(ctx, ["list"]);
	assert.equal(list.code, 0, list.stderr);
	assert.ok(list.stdout.includes(`${id}\tmine\t`), list.stdout);
	assert.ok(list.stdout.includes("목록"));

	const show = await runCli(ctx, ["show", id]);
	assert.equal(show.code, 0, show.stderr);
	assert.ok(show.stdout.startsWith(`목록 (${id}) mine 1안`), show.stdout);
	assert.ok(show.stdout.includes(`url: ${ctx.base}/p/${id}`));
	assert.ok(show.stdout.includes("#1 submitted"), show.stdout);

	const none = await runCli(ctx, ["pending"]);
	assert.equal(none.code, 0, none.stderr);
	assert.equal(none.stdout.trim(), "none");

	const other = makeBoard(path.join(ctx.repo, "proto2"));
	const otherId = idOf(await runCli(ctx, ["submit", other, "--title", "남의 안"], { env: { PI_SESSION_ID: "other-sess" } }));
	await postJson(ctx.base, `/api/p/${otherId}/feedback`, { rev: 1, verdict: "change", comment: "봐 주세요" });
	const pending = await runCli(ctx, ["pending"]);
	assert.equal(pending.code, 0, pending.stderr);
	assert.ok(pending.stdout.includes(otherId), pending.stdout);
	assert.ok(pending.stdout.includes("답을 기다리는"), pending.stdout);
});

test("reply and close print the status and the record line", async (t) => {
	const ctx = await setup(t);
	const approved = idOf(await runCli(ctx, ["submit", makeBoard(path.join(ctx.repo, "approve")), "--title", "승인"]));
	await postJson(ctx.base, `/api/p/${approved}/feedback`, { rev: 1, verdict: "approve" });

	const reply = await runCli(ctx, ["reply", approved, "확인했습니다"]);
	assert.equal(reply.code, 0, reply.stderr);
	assert.equal(reply.stdout.trim(), `ok ${approved} theirs`);

	const close = await runCli(ctx, ["close", approved, "완료"]);
	assert.equal(close.code, 0, close.stderr);
	assert.ok(close.stdout.includes(`ok ${approved} closed`), close.stdout);
	assert.match(close.stdout, new RegExp(`record: VISUAL-APPROVED \\d{4}-\\d{2}-\\d{2} ${approved} ${ctx.base}/p/${approved}`));

	const plain = idOf(await runCli(ctx, ["submit", makeBoard(path.join(ctx.repo, "plain")), "--title", "그냥 닫기"]));
	const plainClose = await runCli(ctx, ["close", plain, "그만"]);
	assert.equal(plainClose.code, 0, plainClose.stderr);
	assert.match(plainClose.stdout, new RegExp(`record: VISUAL-CLOSED \\d{4}-\\d{2}-\\d{2} ${plain}`));
});

test("reply on a closed proposal exits 5", async (t) => {
	const ctx = await setup(t);
	const id = idOf(await runCli(ctx, ["submit", makeBoard(path.join(ctx.repo, "c")), "--title", "닫힘"]));
	assert.equal((await runCli(ctx, ["close", id, "완료"])).code, 0);
	const result = await runCli(ctx, ["reply", id, "다시"]);
	assert.equal(result.code, 5, result.stdout);
});

test("show of an unknown proposal exits 4", async (t) => {
	const ctx = await setup(t);
	const result = await runCli(ctx, ["show", "no-such-id"]);
	assert.equal(result.code, 4, result.stdout);
});

test("show labels a report board's ack and revised tab", async (t) => {
	const ctx = await setup(t);
	const dir = path.join(ctx.repo, "report");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "board.json"),
		JSON.stringify({ title: "보고서", kind: "report", sections: [{ title: "결과", cards: [{ title: "끝", frames: [["완료", "screen.svg"]] }] }] }),
	);
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "보고서"]));

	const feedback = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "ack", comment: "확인했습니다" });
	assert.equal(feedback.status, 200, `feedback rejected: ${await feedback.text()}`);

	const show = await runCli(ctx, ["show", id]);
	assert.equal(show.code, 0, show.stderr);
	assert.ok(show.stdout.includes("ack"), show.stdout);
	assert.ok(show.stdout.includes("갱신 1"), show.stdout);
	assert.ok(show.stdout.includes("report"), show.stdout);
	assert.ok(!show.stdout.includes("1안"), show.stdout);
	assert.ok(!show.stdout.includes("change"), show.stdout);
});

test("resubmitting identical content notes it, changed content is exit 8, --new forces a new id", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "dup"));
	const first = await runCli(ctx, ["submit", dir, "--title", "중복"]);
	assert.equal(first.code, 0, first.stderr);
	const id = idOf(first);

	const again = await runCli(ctx, ["submit", dir, "--title", "중복"]);
	assert.equal(again.code, 0, again.stderr);
	assert.equal(idOf(again), id);
	assert.ok(again.stdout.includes("note: already submitted"), again.stdout);

	const parsed = JSON.parse(fs.readFileSync(path.join(dir, "board.json"), "utf8"));
	parsed.lead = "바뀐 내용";
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(parsed));
	const changed = await runCli(ctx, ["submit", dir, "--title", "중복"]);
	assert.equal(changed.code, 8, changed.stdout);
	assert.ok(changed.stderr.includes("open proposal exists"), changed.stderr);
	assert.ok(changed.stderr.includes(`${CLI_HINT} revise`), changed.stderr);

	const forced = await runCli(ctx, ["submit", dir, "--title", "중복", "--new"]);
	assert.equal(forced.code, 0, forced.stderr);
	assert.notEqual(idOf(forced), id);
});

test("wait prints WAITING and then the feedback message", { timeout: 30000 }, async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "wait"));
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "대기"], { env: { PI_SESSION_ID: "wait-owner" } }));

	const { child, done } = spawnCli(ctx, ["wait", id]);
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	const exited = once(child, "close");
	const waiting = await waitForText(child, `WAITING ${id}`);

	const response = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "고쳐 주세요" });
	assert.equal(response.status, 200);
	const { seq } = await response.json();
	assert.ok(waiting.includes(`WAITING ${id}`));

	await exited;
	const result = await done;
	assert.equal(result.code, 0, result.stderr + stdout);
	assert.ok(stdout.includes(`FEEDBACK ${id} ${seq}`), stdout);
	assert.ok(stdout.includes("[omo-desk] 의견이 왔습니다"), stdout);
	assert.ok(stdout.includes(`${CLI_HINT} show ${id}`), stdout);
});

test("wait times out on a proposal that stays mine", { timeout: 30000 }, async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "quiet"));
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "조용"]));
	const result = await runCli(ctx, ["wait", id, "--timeout", "1"]);
	assert.equal(result.code, 6, result.stdout + result.stderr);
	assert.ok(result.stdout.includes(`WAITING ${id}`), result.stdout);
});

test("ensure against a foreign process on the configured port exits 3", async (t) => {
	const tmp = makeTmpHome("desk-cli-stub-");
	const stub = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, name: "other" }));
	});
	await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
	const port = stub.address().port;
	t.after(async () => {
		await new Promise((resolve) => stub.close(resolve));
		tmp.cleanup();
	});
	fs.writeFileSync(
		path.join(tmp.home, "config.json"),
		JSON.stringify({ v: 1, port, publicBase: null, pcTailnetIps: [], owner: null }),
	);
	const repo = makeGitRepo(tmp.home);
	const result = await runCli({ home: tmp.home, base: null, repo }, ["list"]);
	assert.equal(result.code, 3, result.stdout + result.stderr);
});

// A stand-in for <home>/app/src/server.mjs: it reports DESK_FAKE_VERSION, records a
// /api/shutdown hit, and marks the first non-health request it serves. While the old
// server still holds the port it waits for the test's "old-closed" marker, not a timer.
const FAKE_APP_SOURCE = [
	'import fs from "node:fs";',
	'import http from "node:http";',
	'import path from "node:path";',
	"const home = process.env.OMO_DESK_HOME;",
	'const version = process.env.DESK_FAKE_VERSION || "0.0.0";',
	'const countFile = path.join(home, "fake-shutdowns");',
	'const servedFile = path.join(home, "fake-served");',
	'const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));',
	'fs.writeFileSync(path.join(home, "fake.pid"), String(process.pid));',
	"const handler = (req, res) => {",
	'\tres.setHeader("content-type", "application/json");',
	'\tif (req.url === "/api/shutdown") {',
	'\t\tconst n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;',
	"\t\tfs.writeFileSync(countFile, String(n + 1));",
	'\t\tres.end("{}");',
	"\t\treturn;",
	"\t}",
	'\tif (req.url === "/api/health") {',
	'\t\tres.end(JSON.stringify({ ok: true, name: "omo-desk", version }));',
	"\t\treturn;",
	"\t}",
	"\tfs.writeFileSync(servedFile, req.url);",
	'\tres.end(JSON.stringify({ items: [] }));',
	"};",
	'const closedFile = path.join(home, "old-closed");',
	"const whenOldClosed = (go) => {",
	"\tif (fs.existsSync(closedFile)) return go();",
	"\tconst watcher = fs.watch(home, () => { if (fs.existsSync(closedFile)) { watcher.close(); go(); } });",
	"};",
	"const start = (retried) => {",
	"\tconst server = http.createServer(handler);",
	'\tserver.on("error", (error) => { if (error.code === "EADDRINUSE" && !retried) whenOldClosed(() => start(true)); });',
	'\tserver.listen(config.port, "127.0.0.1");',
	"};",
	"start(false);",
].join("\n");

// Resolves when the process is gone: Wait-Process returns on the exit itself, so nothing here polls.
function waitForExit(pid) {
	return new Promise((resolve) => {
		const waiter = spawn("powershell", ["-NoProfile", "-Command", `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`], {
			stdio: "ignore",
			windowsHide: true,
		});
		waiter.on("exit", resolve);
		waiter.on("error", resolve);
	});
}

async function ensureCtx(t, appVersion = null) {
	const tmp = makeTmpHome("desk-cli-ensure-");
	let shuttingDown = false;
	let oldClosing = false;
	const old = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/shutdown") {
			fs.appendFileSync(path.join(tmp.home, "old-shutdowns"), "x");
			shuttingDown = true;
			res.end("{}");
			return;
		}
		if (req.url === "/api/health") {
			// A real server keeps answering for a moment after /api/shutdown. Answer one more
			// health check after it, then close: that is the window ensure must not mistake for success.
			const closeAfter = shuttingDown;
			res.end(JSON.stringify({ ok: true, name: "omo-desk", version: "0.0.0-installed" }), () => {
				if (!closeAfter || oldClosing) return;
				oldClosing = true;
				old.close(() => fs.writeFileSync(path.join(tmp.home, "old-closed"), ""));
				old.closeAllConnections();
			});
			return;
		}
		fs.appendFileSync(path.join(tmp.home, "old-served"), req.url);
		res.end(JSON.stringify({ items: [] }));
	});
	await new Promise((resolve) => old.listen(0, "127.0.0.1", resolve));
	const port = old.address().port;
	fs.writeFileSync(
		path.join(tmp.home, "config.json"),
		JSON.stringify({ v: 1, port, publicBase: null, pcTailnetIps: [], owner: null }),
	);
	const appSrc = path.join(tmp.home, "app", "src");
	fs.mkdirSync(appSrc, { recursive: true });
	fs.writeFileSync(path.join(appSrc, "server.mjs"), FAKE_APP_SOURCE);
	if (appVersion !== null) {
		fs.writeFileSync(
			path.join(tmp.home, "app", "package.json"),
			JSON.stringify({ name: "omo-desk", version: appVersion }),
		);
	}
	const repo = makeGitRepo(tmp.home);
	t.after(async () => {
		if (!oldClosing) {
			oldClosing = true;
			const closed = new Promise((resolve) => old.close(resolve));
			old.closeAllConnections();
			await closed;
		}
		const pidFile = path.join(tmp.home, "fake.pid");
		if (fs.existsSync(pidFile)) {
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			const exited = waitForExit(pid);
			try {
				process.kill(pid);
			} catch {
				// already gone
			}
			await exited;
		}
		tmp.cleanup();
	});
	return { home: tmp.home, base: `http://127.0.0.1:${port}`, repo };
}

test("ensure shuts down a stale server when the installed app matches the cli", { timeout: 30000 }, async (t) => {
	const ctx = await ensureCtx(t, REPO_VERSION);
	const result = await runCli(ctx, ["list"], { env: { DESK_NO_ENSURE: undefined, DESK_FAKE_VERSION: REPO_VERSION } });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.ok(!result.stderr.includes("differs"), result.stderr);
	assert.ok(
		fs.existsSync(path.join(ctx.home, "old-shutdowns")),
		"the stale server was not shut down",
	);
	assert.ok(!fs.existsSync(path.join(ctx.home, "old-served")), "the stale server served the request");
	assert.ok(
		fs.existsSync(path.join(ctx.home, "fake-served")),
		`the new server never served the request: ${result.stderr}`,
	);
});

test("ensure warns once and does not shut down a server whose version still differs", { timeout: 30000 }, async (t) => {
	const other = "0.0.0-installed";
	const ctx = await ensureCtx(t, other);
	const result = await runCli(ctx, ["list"], { env: { DESK_NO_ENSURE: undefined, DESK_FAKE_VERSION: other } });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.ok(result.stderr.includes(`server version ${other} differs from cli ${REPO_VERSION}`), result.stderr);
	assert.equal((result.stderr.match(/differs from cli/g) || []).length, 1, result.stderr);
	assert.ok(!fs.existsSync(path.join(ctx.home, "old-shutdowns")), "the running server was shut down");
	assert.ok(!fs.existsSync(path.join(ctx.home, "fake-shutdowns")), "a new server was shut down");
	assert.ok(
		fs.existsSync(path.join(ctx.home, "old-served")),
		"the running server did not serve the request",
	);
});

test("reply with a dash reads the text from stdin", async (t) => {
	const ctx = await setup(t);
	const id = idOf(await runCli(ctx, ["submit", makeBoard(path.join(ctx.repo, "stdin")), "--title", "표준입력"]));
	const reply = await runCli(ctx, ["reply", id, "-"], { input: "from stdin" });
	assert.equal(reply.code, 0, reply.stdout + reply.stderr);
	const show = await runCli(ctx, ["show", id]);
	assert.ok(show.stdout.includes("from stdin"), show.stdout);
	assert.ok(!show.stdout.includes("  -\n"), show.stdout);
});

// ---- task 3: explicit session options (--session / --session-file) ----------

const STRIP_SESSION = { DESK_SESSION: undefined, PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined };
const STALE_ENV = { DESK_SESSION: "sess-B", PI_SESSION_ID: "sess-C", PI_SESSION_FILE: "C:/qa/stale-B.jsonl" };

function fakePi() {
	const handlers = new Map();
	const sent = [];
	return {
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			sendMessage(message, opts) {
				sent.push({ message, opts });
			},
		},
		sent,
		async emit(event, ctx) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

/** One machine-readable line, aggregated into evidence/task-3-route.json by the task run. */
function emitRoute(part, data) {
	process.stdout.write(`DESK_ROUTE_EVIDENCE ${JSON.stringify({ part, ...data })}\n`);
}

/** A port that was open and is now closed, so an unexpected ensure would exit 3, not 1. */
async function closedPort() {
	const server = http.createServer(() => {});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

test("submit, revise, reply, close and pending carry an explicit --session and its file", async (t) => {
	const ctx = await setup(t);
	const file = "C:/qa/2026-10-05T15-52-31-471Z_sess-A.jsonl";
	const dir = makeBoard(path.join(ctx.repo, "carry"));
	const submitted = await runCli(ctx, ["submit", dir, "--title", "세션", "--session", "sess-A", "--session-file", file], { env: STRIP_SESSION });
	assert.equal(submitted.code, 0, submitted.stderr);
	const id = idOf(submitted);
	assert.ok(submitted.stdout.includes("owner: sess-A"), submitted.stdout);

	let detail = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	assert.equal(detail.summary.owner, "sess-A");
	assert.deepEqual(detail.events.find((event) => event.type === "submitted").session, { id: "sess-A", file });

	const jsonSubmit = await runCli(ctx, ["submit", dir, "--title", "세션", "--json", "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(jsonSubmit.code, 0, jsonSubmit.stderr);
	assert.ok(!/^owner: /m.test(jsonSubmit.stdout), jsonSubmit.stdout);
	const parsed = JSON.parse(jsonSubmit.stdout);
	assert.equal(parsed.summary.id, id);
	assert.equal(parsed.summary.owner, "sess-A");
	assert.equal(typeof parsed.url, "string");

	const revised = await runCli(ctx, ["revise", id, dir, "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(revised.code, 0, revised.stderr);
	assert.ok(revised.stdout.includes("owner: sess-A"), revised.stdout);

	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 2, verdict: "change", comment: "다시" });
	const fbBody = await fb.json();
	assert.equal(fbBody.routed, "sess-A");
	const here = async (session) => (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.repo)}&session=${encodeURIComponent(session)}`)).json();
	assert.deepEqual((await here("probe-1")).noticeKeys, [`${id}:${fbBody.seq}`]);

	const pending = await runCli(ctx, ["pending", "--session", "sess-A", "--json"], { env: STRIP_SESSION });
	assert.equal(pending.code, 0, pending.stderr);
	assert.deepEqual(JSON.parse(pending.stdout).noticeKeys, []);
	assert.deepEqual((await here("probe-2")).noticeKeys, [], "pending --session marked A live, so A was queried");

	const replied = await runCli(ctx, ["reply", id, "확인했습니다", "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(replied.code, 0, replied.stderr);
	const closed = await runCli(ctx, ["close", id, "완료", "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(closed.code, 0, closed.stderr);
	detail = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	for (const type of ["revised", "reply", "closed"]) {
		assert.deepEqual(detail.events.find((event) => event.type === type).session, { id: "sess-A", file: null }, type);
	}
	emitRoute("cli", {
		submit: { exit: submitted.code, owner: detail.summary.owner, id },
		jsonSubmit: { exit: jsonSubmit.code, hasOwnerLine: /^owner: /m.test(jsonSubmit.stdout) },
		revise: { exit: revised.code },
		pending: { exit: pending.code, noticeKeys: JSON.parse(pending.stdout).noticeKeys },
		reply: { exit: replied.code },
		close: { exit: closed.code },
		events: detail.events.map((event) => ({ type: event.type, session: event.session })),
	});
});

test("an explicit session wins over stale env and the legacy fallbacks stay", async (t) => {
	const ctx = await setup(t);
	const explicitFile = "C:/qa/explicit.jsonl";

	const aDir = makeBoard(path.join(ctx.repo, "stale-a"));
	const a = await runCli(ctx, ["submit", aDir, "--title", "flag", "--session", "sess-A"], { env: { ...STALE_ENV } });
	assert.equal(a.code, 0, a.stderr);
	const aId = idOf(a);
	assert.ok(a.stdout.includes("owner: sess-A"), a.stdout);
	let detail = JSON.parse((await runCli(ctx, ["show", aId, "--json"])).stdout);
	assert.equal(detail.summary.owner, "sess-A");
	assert.deepEqual(detail.events.find((event) => event.type === "submitted").session, { id: "sess-A", file: null });
	const proposal = JSON.parse(fs.readFileSync(path.join(ctx.home, "data", "proposals", aId, "proposal.json"), "utf8"));
	assert.deepEqual(proposal.session, { id: "sess-A", file: null });

	const fDir = makeBoard(path.join(ctx.repo, "stale-file"));
	const f = await runCli(ctx, ["submit", fDir, "--title", "file", "--session-file", explicitFile], { env: { ...STALE_ENV } });
	assert.equal(f.code, 0, f.stderr);
	detail = JSON.parse((await runCli(ctx, ["show", idOf(f), "--json"])).stdout);
	assert.equal(detail.summary.owner, "sess-B");
	assert.deepEqual(detail.events.find((event) => event.type === "submitted").session, { id: "sess-B", file: explicitFile });

	const eDir = makeBoard(path.join(ctx.repo, "stale-env"));
	const e = await runCli(ctx, ["submit", eDir, "--title", "env"], { env: { ...STALE_ENV } });
	assert.equal(e.code, 0, e.stderr);
	const eId = idOf(e);
	detail = JSON.parse((await runCli(ctx, ["show", eId, "--json"])).stdout);
	assert.equal(detail.summary.owner, "sess-B");
	assert.deepEqual(detail.events.find((event) => event.type === "submitted").session, { id: "sess-B", file: "C:/qa/stale-B.jsonl" });
	const eRev = await runCli(ctx, ["revise", eId, eDir], { env: { ...STALE_ENV } });
	assert.equal(eRev.code, 0, eRev.stderr);
	detail = JSON.parse((await runCli(ctx, ["show", eId, "--json"])).stdout);
	assert.deepEqual(detail.events.find((event) => event.type === "revised").session, { id: "sess-B", file: "C:/qa/stale-B.jsonl" });

	const pDir = makeBoard(path.join(ctx.repo, "pi-fallback"));
	const p = await runCli(ctx, ["submit", pDir, "--title", "pi"], { env: { DESK_SESSION: undefined, PI_SESSION_ID: "sess-C", PI_SESSION_FILE: "C:/qa/pi.jsonl" } });
	assert.equal(p.code, 0, p.stderr);
	const pId = idOf(p);
	detail = JSON.parse((await runCli(ctx, ["show", pId, "--json"])).stdout);
	assert.equal(detail.summary.owner, "sess-C");
	assert.deepEqual(detail.events.find((event) => event.type === "submitted").session, { id: "sess-C", file: "C:/qa/pi.jsonl" });
	const pRev = await runCli(ctx, ["revise", pId, pDir], { env: { DESK_SESSION: undefined, PI_SESSION_ID: "sess-C", PI_SESSION_FILE: undefined } });
	assert.equal(pRev.code, 0, pRev.stderr);
	detail = JSON.parse((await runCli(ctx, ["show", pId, "--json"])).stdout);
	assert.deepEqual(detail.events.find((event) => event.type === "revised").session, { id: "sess-C", file: null });
});

test("a missing, blank or option-like session value is a usage error before ensure", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "usage"));
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "사용법"]));
	const before = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	const port = await closedPort();
	const closed = { DESK_URL: `http://127.0.0.1:${port}` };
	const bad = [
		["--session"],
		["--session", ""],
		["--session", "   "],
		["--session", "--note", "x"],
		["--session-file"],
		["--session-file", ""],
		["--session-file", "--new"],
	];
	const commands = {
		submit: [dir, "--title", "사용법2"],
		revise: [id, dir],
		reply: [id, "안녕"],
		close: [id, "완료"],
		pending: [],
	};
	for (const [command, baseArgs] of Object.entries(commands)) {
		for (const tokens of bad) {
			const result = await runCli(ctx, [command, ...baseArgs, ...tokens], { env: closed });
			assert.equal(result.code, 1, `${command} ${tokens.join(" ")}: ${result.stdout}${result.stderr}`);
			assert.ok(!result.stderr.includes("server unreachable"), `${command} ${tokens.join(" ")}: ensure ran`);
		}
	}
	const after = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	assert.equal(after.events.length, before.events.length, "no event changed");
	const list = JSON.parse((await runCli(ctx, ["list", "--json"])).stdout);
	assert.equal(list.items.length, 1, "no proposal was created");
});

test("a stripped environment leaves the board ownerless until an explicit session binds it", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "ownerless"));
	const first = await runCli(ctx, ["submit", dir, "--title", "주인 없음"], { env: STRIP_SESSION });
	assert.equal(first.code, 0, first.stderr);
	const id = idOf(first);
	assert.ok(first.stdout.includes("owner: none"), first.stdout);

	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "봐 주세요" });
	assert.equal(fb.status, 200);
	const fbBody = await fb.json();
	assert.equal(fbBody.routed, null);
	assert.equal(fbBody.delivery, "none");
	assert.ok(!fs.existsSync(path.join(ctx.home, "inbox")), "no inbox for an ownerless route");

	const before = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	const again = await runCli(ctx, ["submit", dir, "--title", "주인 없음", "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(again.code, 0, again.stderr);
	assert.equal(idOf(again), id);
	assert.ok(again.stdout.includes("note: already submitted"), again.stdout);
	assert.ok(again.stdout.includes("owner: none"), again.stdout);
	const after = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	assert.equal(after.summary.rev, before.summary.rev);
	assert.equal(after.events.length, before.events.length);
	assert.equal(after.summary.owner, before.summary.owner);
	assert.equal(after.summary.owner, null);
	assert.notEqual(after.summary.owner, "sess-A");

	const rev = await runCli(ctx, ["revise", id, dir, "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(rev.code, 0, rev.stderr);
	assert.ok(rev.stdout.includes("owner: sess-A"), rev.stdout);
	const bound = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	assert.equal(bound.summary.rev, before.summary.rev + 1);
	assert.equal(bound.events.length, before.events.length + 1);
	assert.equal(bound.summary.owner, "sess-A");
	assert.deepEqual(bound.events.find((event) => event.type === "revised").session, { id: "sess-A", file: null });
});

test("real CLI, real server and real inbox: one followUp, dedupe and the status gate", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "roundtrip"));
	const submitted = await runCli(ctx, ["submit", dir, "--title", "왕복", "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(submitted.code, 0, submitted.stderr);
	const id = idOf(submitted);
	assert.ok(submitted.stdout.includes("owner: sess-A"), submitted.stdout);

	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "qa-roundtrip" });
	assert.equal(fb.status, 200);
	const fbBody = await fb.json();
	assert.equal(fbBody.routed, "sess-A");
	assert.equal(fbBody.delivery, "pending");
	const seq = fbBody.seq;
	const inboxDir = path.join(ctx.home, "inbox", "sess-A");
	const inboxFile = path.join(inboxDir, `${id}-${String(seq).padStart(6, "0")}.json`);
	assert.ok(fs.existsSync(inboxFile), "the server wrote A's inbox file");
	assert.deepEqual(fs.readdirSync(path.join(ctx.home, "inbox")), ["sess-A"], "only A's inbox");
	const payload = fs.readFileSync(inboxFile, "utf8");

	const fp = fakePi();
	const timers = [];
	const handle = createDesk(fp.pi, {
		env: { DESK_URL: ctx.base, OMO_DESK_HOME: ctx.home },
		home: ctx.home,
		timer: {
			setInterval: (fn, ms) => {
				const entry = { fn, ms };
				timers.push(entry);
				return entry;
			},
			clearInterval: (entry) => {
				const at = timers.indexOf(entry);
				if (at >= 0) timers.splice(at, 1);
			},
		},
		spawn: () => ({ unref() {} }),
	});
	t.after(() => handle.stop());
	const hostCtx = { cwd: ctx.repo, hasUI: false, sessionManager: { getSessionId: () => "sess-A" } };
	const followUps = () => fp.sent.filter((entry) => entry.opts && entry.opts.deliverAs === "followUp");

	await fp.emit("session_start", hostCtx);
	assert.equal(followUps().length, 0, "session_start alone delivers no followUp");
	await handle.inbox();
	assert.equal(followUps().length, 1, "exactly one followUp");
	assert.equal(followUps()[0].message.content, JSON.parse(payload).text);
	assert.deepEqual(followUps()[0].message.details, { proposalId: id, seq });
	assert.equal(followUps()[0].opts.triggerTurn, true);
	assert.ok(!fs.existsSync(inboxFile), "the drained file is removed");

	fs.mkdirSync(inboxDir, { recursive: true });
	fs.writeFileSync(inboxFile, payload);
	await handle.inbox();
	assert.equal(followUps().length, 1, "the delivered payload is not delivered again");
	assert.ok(!fs.existsSync(inboxFile), "the duplicate file is removed");

	const second = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "second" });
	const secondSeq = (await second.json()).seq;
	const secondFile = path.join(inboxDir, `${id}-${String(secondSeq).padStart(6, "0")}.json`);
	const revisedDir = makeBoard(path.join(ctx.repo, "reply-revision"));
	const revised = await runCli(ctx, ["revise", id, revisedDir, "--session", "sess-A"], { env: STRIP_SESSION });
	assert.equal(revised.code, 0, revised.stderr);
	const detail = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	assert.equal(detail.summary.status, "mine");
	assert.ok(fs.existsSync(secondFile), "the second feedback is still waiting in the inbox");
	await handle.inbox();
	assert.equal(followUps().length, 1, "a payload the server calls mine is dropped");
	assert.ok(!fs.existsSync(secondFile), "the dropped file is removed");
	const afterDrain = JSON.parse((await runCli(ctx, ["show", id, "--json"])).stdout);
	const secondEvent = afterDrain.events.find((event) => event.type === "feedback" && event.seq === secondSeq);
	assert.equal(secondEvent.delivery, "delivered", "the API reports the dropped feedback as delivered");

	assert.ok(timers.length > 0, "the extension registered its timers");
	handle.stop();
	assert.equal(timers.length, 0, "teardown clears the extension timers");
	emitRoute("integration", {
		submit: { exit: submitted.code, owner: detail.summary.owner, id },
		feedback: { status: fb.status, routed: fbBody.routed, delivery: fbBody.delivery, seq },
		followUp: { count: followUps().length, details: followUps()[0].message.details, triggerTurn: followUps()[0].opts.triggerTurn },
		statusGate: { reviseExit: revised.code, status: detail.summary.status, followUpCount: followUps().length },
		teardown: { timers: timers.length },
	});
});

test("pending --session identifies the caller, so a never-seen session still gets the notice", async (t) => {
	const ctx = await setup(t);
	const dir = makeBoard(path.join(ctx.repo, "notice"));
	const id = idOf(await runCli(ctx, ["submit", dir, "--title", "알림", "--session", "sess-A"], { env: STRIP_SESSION }));
	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "확인 필요" });
	const seq = (await fb.json()).seq;

	const never = await runCli(ctx, ["pending", "--session", "never-seen-B", "--json"], { env: STRIP_SESSION });
	assert.equal(never.code, 0, never.stderr);
	assert.deepEqual(JSON.parse(never.stdout).noticeKeys, [`${id}:${seq}`]);

	const mine = await runCli(ctx, ["pending", "--session", "sess-A", "--json"], { env: STRIP_SESSION });
	assert.equal(mine.code, 0, mine.stderr);
	assert.deepEqual(JSON.parse(mine.stdout).noticeKeys, []);
});
