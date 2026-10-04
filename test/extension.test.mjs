// Fake-pi harness for the visual-board extension: no senpi, no server, no wall clock.
// Run: node --test test/extension.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createVisualBoard, safeSegment } from "../extension/visual-board.ts";
import { safeSegment as pathsSafeSegment } from "../src/paths.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const SESSION = "s-1";
const INBOX_FILE = "261004-abcd-000003.json";
const PAYLOAD = {
	v: 1,
	proposalId: "261004-abcd",
	seq: 3,
	title: "결제 화면",
	url: "http://127.0.0.1:4377/p/261004-abcd",
	approved: false,
	text: "[visual-board] 의견이 왔습니다: 결제 화면 (261004-abcd, 1안, #3)",
};

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
		handlers,
		sent,
		async emit(event, ctx) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

function fakeCtx({ sessionId = SESSION, cwd = "C:/work/proj", hasUI = true } = {}) {
	const statuses = [];
	const ctx = {
		cwd,
		hasUI,
		ui: { setStatus: (key, text) => statuses.push([key, text]) },
		sessionManager: { getSessionId: () => sessionId },
	};
	return { ctx, statuses };
}

function setup({ env = {}, sessionId = SESSION, hasUI = true, cwd, piCwd, here, proposal, fetchThrows = false, fsOverrides = {} } = {}) {
	const tmp = makeTmpHome();
	const fp = fakePi();
	if (piCwd !== undefined) fp.pi.cwd = piCwd;
	const { ctx, statuses } = fakeCtx({ sessionId, hasUI, cwd });
	const timers = [];
	const spawned = [];
	const fetchCalls = [];
	const state = {
		here: here ?? { footer: "", notice: null, noticeKeys: [] },
		proposal: proposal ?? { summary: { status: "theirs" } },
	};
	let clock = 1_750_000_000_000;
	const fsImpl = { ...fsp, ...fsOverrides };
	const fetchImpl = async (url, opts = {}) => {
		fetchCalls.push({ url: String(url), opts });
		if (fetchThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:4377");
		const parsed = new URL(String(url));
		if (parsed.pathname === "/api/here") {
			const body = typeof state.here === "function" ? state.here(parsed) : state.here;
			return { ok: true, status: 200, json: async () => body };
		}
		if (parsed.pathname.startsWith("/api/p/")) {
			const body = typeof state.proposal === "function" ? state.proposal(parsed) : state.proposal;
			return { ok: true, status: 200, json: async () => body };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	};
	const handle = createVisualBoard(fp.pi, {
		env: { OMO_VISUAL_BOARD_HOME: tmp.home, ...env },
		home: tmp.home,
		now: () => clock,
		timer: {
			setInterval: (fn, ms) => {
				const id = { fn, ms };
				timers.push(id);
				return id;
			},
			clearInterval: (id) => {
				const at = timers.indexOf(id);
				if (at >= 0) timers.splice(at, 1);
			},
		},
		fetch: fetchImpl,
		fs: fsImpl,
		spawn: (cmd, args, opts) => {
			spawned.push({ cmd, args, opts });
			return { unref() {} };
		},
	});
	return {
		home: tmp.home,
		handle,
		pi: fp,
		ctx,
		statuses,
		timers,
		spawned,
		fetchCalls,
		state,
		inboxDir: path.join(tmp.home, "inbox", sessionId),
		writeInbox(name = INBOX_FILE, payload = PAYLOAD) {
			mkdirSync(path.join(tmp.home, "inbox", sessionId), { recursive: true });
			writeFileSync(path.join(tmp.home, "inbox", sessionId, name), JSON.stringify(payload));
		},
		async tick(ms) {
			for (const timer of timers.filter((entry) => entry.ms === ms)) await timer.fn();
		},
		advance(ms) {
			clock += ms;
			return clock;
		},
		cleanup() {
			try {
				handle?.stop?.();
			} catch {
				// already stopped
			}
			tmp.cleanup();
		},
	};
}

test("omo-task child sessions are inert: null, no handlers", () => {
	for (const key of ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"]) {
		const tmp = makeTmpHome();
		const fp = fakePi();
		const handle = createVisualBoard(fp.pi, { env: { [key]: "1" }, home: tmp.home });
		assert.equal(handle, null, key);
		assert.equal(fp.handlers.size, 0, key);
		tmp.cleanup();
	}
	const tmp = makeTmpHome();
	const empty = createVisualBoard(fakePi().pi, { env: { OMO_SENPI_TASK_RPC_CHILD: "" }, home: tmp.home });
	assert.notEqual(empty, null, "an empty value is not a child session");
	empty.stop();
	tmp.cleanup();
});

test("session_start registers the 3 s/30 s timers and asks /api/here with start=1", async () => {
	const s = setup({ here: { footer: "보드 내 차례 1 · 세션 차례 0", notice: null, noticeKeys: [] } });
	assert.equal(s.timers.length, 0);
	await s.pi.emit("session_start", s.ctx);
	assert.deepEqual(
		s.timers.map((timer) => timer.ms).sort((a, b) => a - b),
		[3000, 30000],
	);
	assert.equal(s.fetchCalls.length, 1);
	assert.match(s.fetchCalls[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Fproj&session=s-1&start=1$/);
	assert.deepEqual(s.statuses.at(-1), ["visual-board", "보드 내 차례 1 · 세션 차례 0"]);
	await s.tick(30000);
	assert.equal(s.fetchCalls.length, 2);
	assert.doesNotMatch(s.fetchCalls[1].url, /start=1/, "later ticks are not a session start");
	s.cleanup();
});

test("a payload whose proposal is theirs is delivered once as a followUp and the file is removed", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "visual-board");
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.deepEqual(s.pi.sent[0].message.details, { proposalId: PAYLOAD.proposalId, seq: PAYLOAD.seq });
	assert.deepEqual(s.pi.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	assert.ok(
		s.fetchCalls.some((call) => call.url.endsWith(`/api/p/${PAYLOAD.proposalId}?since=${PAYLOAD.seq}`)),
		"the payload is confirmed against the proposal before delivery",
	);
	assert.ok(s.fetchCalls.some((call) => call.url.includes("/api/here")), "a delivery refreshes the status");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the empty inbox delivers nothing more");
	s.cleanup();
});

test("a payload the server calls mine is dropped without a message", async () => {
	const s = setup({ proposal: { summary: { status: "mine" } } });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 0);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

test("a failed proposal fetch still delivers rather than lose the feedback", async () => {
	const s = setup({ fetchThrows: true });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

test("a failed delete is retried next tick without a second delivery", async () => {
	let rmCalls = 0;
	const s = setup({
		fsOverrides: {
			rm: async (file, opts) => {
				rmCalls += 1;
				if (rmCalls === 1) throw new Error("EBUSY: locked");
				return fsp.rm(file, opts);
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), true, "the delete failed, the file stays");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the delivered set prevents a second delivery");
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /cannot delete/);
	s.cleanup();
});

test("an unparsable inbox file is deleted and logged", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	mkdirSync(s.inboxDir, { recursive: true });
	writeFileSync(path.join(s.inboxDir, "broken.json"), "{ this is not json");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 0);
	assert.equal(existsSync(path.join(s.inboxDir, "broken.json")), false);
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /unparsable/);
	s.cleanup();
});

test("an unreachable server shows 보드 서버 꺼짐 and starts the CLI at most once per 120 s", async () => {
	const s = setup({ fetchThrows: true });
	await s.pi.emit("session_start", s.ctx);
	assert.deepEqual(s.statuses.at(-1), ["visual-board", "보드 서버 꺼짐"]);
	assert.equal(s.spawned.length, 1);
	const [spawned] = s.spawned;
	assert.match(path.basename(spawned.cmd), /^node(\.exe)?$/i);
	assert.match(spawned.args[0], /app[\\/]bin[\\/]vb\.mjs$/);
	assert.deepEqual(spawned.args.slice(1), ["server", "start"]);
	assert.deepEqual(spawned.opts, { detached: true, stdio: "ignore", windowsHide: true });
	await s.tick(30000);
	assert.equal(s.spawned.length, 1, "still inside the 120 s window");
	s.advance(120000);
	await s.tick(30000);
	assert.equal(s.spawned.length, 2);
	s.cleanup();
});

test("session_shutdown stops the timers and POSTs /api/bye with the session id", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("session_shutdown", s.ctx);
	assert.equal(s.timers.length, 0);
	const bye = s.fetchCalls.find((call) => call.url.endsWith("/api/bye"));
	assert.ok(bye, "the server is told the session is gone");
	assert.equal(bye.opts.method, "POST");
	assert.equal(bye.opts.headers["x-vb"], "1");
	assert.match(bye.opts.headers["content-type"], /application\/json/);
	assert.deepEqual(JSON.parse(bye.opts.body), { session: SESSION });
	const failing = setup({ fetchThrows: true });
	await failing.pi.emit("session_start", failing.ctx);
	await assert.doesNotReject(() => failing.pi.emit("session_shutdown", failing.ctx), "bye errors are ignored");
	failing.cleanup();
	s.cleanup();
});

test("status announces new notice keys once, sets the footer, and clears it when empty", async () => {
	const s = setup({
		here: { footer: "보드 내 차례 0 · 세션 차례 1", notice: "notice-1", noticeKeys: ["261004-abcd:3"] },
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "visual-board");
	assert.equal(s.pi.sent[0].message.content, "notice-1");
	assert.deepEqual(s.pi.sent[0].message.details, { pending: ["261004-abcd:3"] });
	assert.deepEqual(s.pi.sent[0].opts, { deliverAs: "nextTurn", triggerTurn: false });
	await s.tick(30000);
	assert.equal(s.pi.sent.length, 1, "the same key is not announced twice");
	s.state.here = { footer: "", notice: "notice-1", noticeKeys: ["261004-abcd:3"] };
	await s.tick(30000);
	assert.deepEqual(s.statuses.at(-1), ["visual-board", undefined], "an empty footer clears the status");
	const sets = s.statuses.length;
	await s.tick(30000);
	assert.equal(s.statuses.length, sets, "an unchanged footer is not re-set");
	s.state.here = { footer: "", notice: "notice-2", noticeKeys: ["261004-abcd:3", "261004-efgh:7"] };
	await s.tick(30000);
	assert.equal(s.pi.sent.length, 2);
	assert.equal(s.pi.sent[1].message.content, "notice-2");
	assert.deepEqual(s.pi.sent[1].message.details, { pending: ["261004-abcd:3", "261004-efgh:7"] });
	s.cleanup();
});

test("session_start without ctx.cwd falls back to pi.cwd for /api/here", async () => {
	const s = setup({ cwd: null, piCwd: "C:/work/from-pi", here: { footer: "보드 내 차례 1 · 세션 차례 0", notice: null, noticeKeys: [] } });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.fetchCalls.length, 1);
	assert.match(s.fetchCalls[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Ffrom-pi&session=s-1&start=1$/);
	assert.deepEqual(s.statuses.at(-1), ["visual-board", "보드 내 차례 1 · 세션 차례 0"]);
	s.cleanup();
});

test("without a UI the footer is not touched", async () => {
	const s = setup({ hasUI: false, here: { footer: "보드 내 차례 1 · 세션 차례 0", notice: null, noticeKeys: [] } });
	await s.pi.emit("session_start", s.ctx);
	await s.tick(30000);
	assert.equal(s.statuses.length, 0);
	s.cleanup();
});

test("a throwing hook is logged, never thrown into senpi", async () => {
	const s = setup({
		fsOverrides: {
			readdir: async () => {
				throw new Error("EACCES: denied");
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	await assert.doesNotReject(() => s.tick(3000));
	const logFile = path.join(s.home, "logs", "extension.log");
	assert.equal(existsSync(logFile), true);
	assert.match(readFileSync(logFile, "utf8"), /inbox:/);
	s.cleanup();
});

test("the embedded safeSegment matches src/paths.mjs", () => {
	const table = ["s-1", "a/b\\c", "한글 세션", "", "..", "x".repeat(200), "a b?c*d", null, undefined, 12345, "dup--__.."];
	for (const value of table) {
		assert.equal(safeSegment(value), pathsSafeSegment(value), JSON.stringify(value));
	}
});
