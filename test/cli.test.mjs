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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(REPO, "web");
const BIN = path.join(REPO, "bin", "vb.mjs");
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
	const tmp = makeTmpHome("vb-cli-");
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
		VB_NO_ENSURE: "1",
		PI_SESSION_ID: "test-sess",
		VB_WAIT_POLL_MS: "20",
		VB_ENSURE_POLL_MS: "20",
		OMO_VISUAL_BOARD_HOME: home,
	};
	if (base) env.VB_URL = base;
	else delete env.VB_URL;
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
		headers: { "content-type": "application/json", "x-vb": "1" },
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
	assert.equal(reply.stdout.trim(), `ok ${approved} mine`);

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
	assert.ok(stdout.includes("[visual-board] 의견이 왔습니다"), stdout);
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
	const tmp = makeTmpHome("vb-cli-stub-");
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

// A stand-in for <home>/app/src/server.mjs: it reports VB_FAKE_VERSION, records a
// /api/shutdown hit, and marks the first non-health request it serves. While the old
// server still holds the port it waits for the test's "old-closed" marker, not a timer.
const FAKE_APP_SOURCE = [
	'import fs from "node:fs";',
	'import http from "node:http";',
	'import path from "node:path";',
	"const home = process.env.OMO_VISUAL_BOARD_HOME;",
	'const version = process.env.VB_FAKE_VERSION || "0.0.0";',
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
	'\t\tres.end(JSON.stringify({ ok: true, name: "omo-visual-board", version }));',
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
	const tmp = makeTmpHome("vb-cli-ensure-");
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
			res.end(JSON.stringify({ ok: true, name: "omo-visual-board", version: "0.0.0-installed" }), () => {
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
			JSON.stringify({ name: "omo-visual-board", version: appVersion }),
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
	const result = await runCli(ctx, ["list"], { env: { VB_NO_ENSURE: undefined, VB_FAKE_VERSION: REPO_VERSION } });
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
	const result = await runCli(ctx, ["list"], { env: { VB_NO_ENSURE: undefined, VB_FAKE_VERSION: other } });
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
