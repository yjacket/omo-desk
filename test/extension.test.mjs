// Fake-pi harness for the omo-desk extension: no senpi, no server, no wall clock.
// Run: node --test test/extension.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDesk, safeSegment } from "../extension/omo-desk.ts";
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
	text: "[omo-desk] 의견이 왔습니다: 결제 화면 (261004-abcd, 1안, #3)",
};

function fakePi() {
	const handlers = new Map();
	const sent = [];
	const emitted = [];
	return {
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			sendMessage(message, opts) {
				sent.push({ message, opts });
			},
			events: {
				emit(channel, data) {
					emitted.push({ channel, data });
				},
			},
		},
		handlers,
		sent,
		emitted,
		async emit(event, ctx) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

function fakeCtx({ sessionId = SESSION, cwd = "C:/work/proj", hasUI = true, askUser } = {}) {
	const statuses = [];
	const ctx = {
		cwd,
		hasUI,
		ui: { setStatus: (key, text) => statuses.push([key, text]) },
		sessionManager: { getSessionId: () => sessionId },
	};
	if (askUser) {
		ctx.getAskUserSettings = () => askUser;
	}
	return { ctx, statuses };
}

function setup({ env = {}, sessionId = SESSION, hasUI = true, cwd, piCwd, here, proposal, proposalStatus = 200, fetchThrows = false, fsOverrides = {}, spawn: spawnOverride, askUser, abortAfter } = {}) {
	const tmp = makeTmpHome();
	const fp = fakePi();
	if (piCwd !== undefined) fp.pi.cwd = piCwd;
	const { ctx, statuses } = fakeCtx({ sessionId, hasUI, cwd, askUser });
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
			const body = typeof state.here === "function" ? state.here(parsed, opts) : state.here;
			return { ok: true, status: 200, json: async () => await body };
		}
		if (parsed.pathname.startsWith("/api/p/")) {
			const body = typeof state.proposal === "function" ? state.proposal(parsed) : state.proposal;
			return { ok: proposalStatus >= 200 && proposalStatus < 300, status: proposalStatus, json: async () => body };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	};
	const handle = createDesk(fp.pi, {
		env: { OMO_DESK_HOME: tmp.home, ...env },
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
		abortAfter,
		fs: fsImpl,
		spawn:
			spawnOverride ??
			((cmd, args, opts) => {
				spawned.push({ cmd, args, opts });
				return { unref() {} };
			}),
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
		const handle = createDesk(fp.pi, { env: { [key]: "1" }, home: tmp.home });
		assert.equal(handle, null, key);
		assert.equal(fp.handlers.size, 0, key);
		tmp.cleanup();
	}
	const tmp = makeTmpHome();
	const empty = createDesk(fakePi().pi, { env: { OMO_SENPI_TASK_RPC_CHILD: "" }, home: tmp.home });
	assert.notEqual(empty, null, "an empty value is not a child session");
	empty.stop();
	tmp.cleanup();
});

test("session_start registers the 3 s/30 s timers and asks /api/here with start=1", async () => {
	const s = setup({ here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
	assert.equal(s.timers.length, 0);
	await s.pi.emit("session_start", s.ctx);
	assert.deepEqual(
		s.timers.map((timer) => timer.ms).sort((a, b) => a - b),
		[3000, 30000],
	);
	assert.equal(s.fetchCalls.length, 1);
	assert.match(s.fetchCalls[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Fproj&session=s-1&start=1$/);
	assert.deepEqual(s.statuses.at(-1), ["omo-desk", "🙋 1"]);
	await s.tick(30000);
	assert.equal(s.fetchCalls.length, 2);
	assert.doesNotMatch(s.fetchCalls[1].url, /start=1/, "later ticks are not a session start");
	s.cleanup();
});

test("tool_execution_end refreshes /api/here once after session_start", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.fetchCalls.filter((call) => call.url.includes("/api/here")).length, 2);
	assert.match(s.fetchCalls[0].url, /start=1$/);
	assert.doesNotMatch(s.fetchCalls[1].url, /start=1/);
	assert.equal(s.fetchCalls[1].opts.signal instanceof AbortSignal, true);
	s.cleanup();
});

test("overlapping tool refreshes coalesce into one rerun awaited by every handler", async () => {
	let release;
	let releaseSecond;
	let startedFirst;
	let startedSecond;
	const firstStarted = new Promise((resolve) => { startedFirst = resolve; });
	const secondStarted = new Promise((resolve) => { startedSecond = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
	let hereCalls = 0;
	const s = setup({
		here: (_parsed) => {
			hereCalls += 1;
			if (hereCalls === 2) {
				startedFirst();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			if (hereCalls === 3) {
				startedSecond();
				return secondGate.then(() => ({ footer: "", waiting: [{ id: "fresh", title: "Fresh", status: "theirs", seq: 2 }] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	let settled = 0;
	const handlers = [s.pi.emit("tool_execution_end", s.ctx), s.pi.emit("tool_execution_end", s.ctx), s.pi.emit("tool_execution_end", s.ctx)]
		.map((promise) => promise.then(() => { settled += 1; }));
	await firstStarted;
	assert.equal(hereCalls, 2, "only the first refresh is running");
	assert.equal(settled, 0, "all tool handlers remain pending while refresh is held");
	release();
	await secondStarted;
	assert.equal(hereCalls, 3, "one coalesced rerun follows the held refresh");
	assert.equal(settled, 0, "tool handlers remain pending until the rerun completes");
	releaseSecond();
	await Promise.all(handlers);
	assert.equal(settled, 3);
	assert.ok(s.pi.emitted.some((event) => event.channel === "wake_source_state" && event.data.activeCount === 1), "the rerun includes the board added between fetches");
	assert.equal(hereCalls, 3, "the burst produced exactly two additional fetches");
	s.cleanup();
});

test("session_start during a held refresh carries start=1 into the rerun", async () => {
	let release;
	let started;
	const startedFirst = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	let hereCalls = 0;
	const s = setup({
		here: (_parsed, opts) => {
			hereCalls += 1;
			if (hereCalls === 2) {
				started();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const firstRefresh = s.handle.status(false);
	await startedFirst;
	const startingSession = s.pi.emit("session_start", s.ctx);
	release();
	await Promise.all([firstRefresh, startingSession]);
	assert.equal(hereCalls, 3);
	assert.match(s.fetchCalls[1].url, /\/api\/here\?.*session=s-1$/);
	assert.match(s.fetchCalls[2].url, /\/api\/here\?.*session=s-1&start=1$/);
	s.cleanup();
});

test("a tool refresh that joins a held timer refresh reruns with the short tool timeout", async () => {
	let release;
	let started;
	const startedFirst = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const timeouts = [];
	let hereCalls = 0;
	const s = setup({
		abortAfter: (ms) => {
			timeouts.push(ms);
			return new AbortController().signal;
		},
		here: () => {
			hereCalls += 1;
			if (hereCalls === 2) {
				started();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const timerRefresh = s.handle.status(false);
	await startedFirst;
	const toolRefresh = s.pi.emit("tool_execution_end", s.ctx);
	release();
	await Promise.all([timerRefresh, toolRefresh]);
	assert.equal(hereCalls, 3);
	assert.deepEqual(timeouts, [5000, 5000, 1500]);
	s.cleanup();
});

test("tool_execution_end resolves when its injected abort signal fires", async () => {
	let signalReady;
	const ready = new Promise((resolve) => { signalReady = resolve; });
	const controller = new AbortController();
	let hereCalls = 0;
	const s = setup({
		abortAfter: (ms) => {
			return ms === 1500 ? controller.signal : AbortSignal.timeout(ms);
		},
		here: (_parsed, opts) => {
			hereCalls += 1;
			if (hereCalls === 1) return { footer: "", waiting: [] };
			return new Promise((_resolve, reject) => {
			signalReady();
			if (opts.signal.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return;
			}
			opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const pending = s.pi.emit("tool_execution_end", s.ctx);
	await ready;
	controller.abort();
	await assert.doesNotReject(() => pending);
	s.cleanup();
});

test("a payload whose proposal is theirs is delivered once as a followUp and the file is removed", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "omo-desk");
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

const flush = () => new Promise(setImmediate);

test("two overlapping inbox ticks deliver the payload once", async () => {
	let started = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const s = setup({
		fsOverrides: {
			readdir: async () => [INBOX_FILE],
			readFile: async () => JSON.stringify(PAYLOAD),
		},
	});
	s.state.proposal = () => {
		started += 1;
		return gate.then(() => ({ summary: { status: "theirs" } }));
	};
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	const first = s.handle.inbox();
	await flush();
	const second = s.handle.inbox();
	await flush();
	assert.equal(started, 1, "the second tick is skipped while the first one runs");
	release();
	await Promise.all([first, second]);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

test("a 500 from the proposal check delivers the feedback once and removes the file", async () => {
	const s = setup({ proposalStatus: 500 });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false, "the file is not kept: the delivery was made");
	const check = s.fetchCalls.find((call) => call.url.includes("/api/p/"));
	assert.ok(check.opts.signal instanceof AbortSignal, "every proposal fetch is bounded by a timeout");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the delivered set prevents a second delivery");
	s.cleanup();
});

test("a spawn 'error' is logged, never thrown into senpi", async () => {
	let onError;
	let seen;
	const logged = new Promise((resolve) => {
		seen = resolve;
	});
	const s = setup({
		fetchThrows: true,
		spawn: () => ({
			unref() {},
			on(event, handler) {
				if (event === "error") onError = handler;
			},
		}),
		fsOverrides: {
			appendFile: async (file, text) => {
				await fsp.appendFile(file, text);
				if (String(text).includes("ensure:")) seen();
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(typeof onError, "function", "the spawn gets an error listener");
	assert.doesNotThrow(() => onError(new Error("spawn node ENOENT")));
	await logged;
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /ensure: spawn node ENOENT/);
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
	assert.deepEqual(s.statuses.at(-1), ["omo-desk", "보드 서버 꺼짐"]);
	assert.equal(s.spawned.length, 1);
	const [spawned] = s.spawned;
	assert.match(path.basename(spawned.cmd), /^node(\.exe)?$/i);
	assert.match(spawned.args[0], /app[\\/]bin[\\/]desk\.mjs$/);
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
	assert.equal(bye.opts.headers["x-desk"], "1");
	assert.match(bye.opts.headers["content-type"], /application\/json/);
	assert.deepEqual(JSON.parse(bye.opts.body), { session: SESSION });
	const failing = setup({ fetchThrows: true });
	await failing.pi.emit("session_start", failing.ctx);
	await assert.doesNotReject(() => failing.pi.emit("session_shutdown", failing.ctx), "bye errors are ignored");
	failing.cleanup();
	s.cleanup();
});

test("a stale extension generation stops timers and logs once without a stack trace", async () => {
	const s = setup();
	let stale = false;
	const staleCtx = Object.defineProperties({ ...s.ctx }, {
		cwd: { get() {
			if (stale) throw new Error("stale extension generation after reload");
			return "C:/work/proj";
		} },
	});
	await s.pi.emit("session_start", staleCtx);
	const timers = [...s.timers];
	const callbacks = timers.map((entry) => entry.fn);
	assert.equal(callbacks.length, 2);
	stale = true;
	await timers.find((entry) => entry.ms === 30000).fn();
	assert.equal(s.timers.length, 0);
	const logFile = path.join(s.home, "logs", "extension.log");
	const stoppedLog = readFileSync(logFile, "utf8");
	assert.equal(stoppedLog.split("\n").filter(Boolean).length, 1);
	assert.match(stoppedLog, /stopped/);
	assert.doesNotMatch(stoppedLog, /Error:|at /);
	await Promise.all(callbacks.map((callback) => callback()));
	assert.equal(readFileSync(logFile, "utf8"), stoppedLog);
	s.cleanup();
});

test("status announces new notice keys once, sets the footer, and clears it when empty", async () => {
	const s = setup({
		here: { footer: "🤖 1", notice: "notice-1", noticeKeys: ["261004-abcd:3"] },
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "omo-desk");
	assert.equal(s.pi.sent[0].message.content, "notice-1");
	assert.deepEqual(s.pi.sent[0].message.details, { pending: ["261004-abcd:3"] });
	assert.deepEqual(s.pi.sent[0].opts, { deliverAs: "nextTurn", triggerTurn: false });
	await s.tick(30000);
	assert.equal(s.pi.sent.length, 1, "the same key is not announced twice");
	s.state.here = { footer: "", notice: "notice-1", noticeKeys: ["261004-abcd:3"] };
	await s.tick(30000);
	assert.deepEqual(s.statuses.at(-1), ["omo-desk", undefined], "an empty footer clears the status");
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
	const s = setup({ cwd: null, piCwd: "C:/work/from-pi", here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.fetchCalls.length, 1);
	assert.match(s.fetchCalls[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Ffrom-pi&session=s-1&start=1$/);
	assert.deepEqual(s.statuses.at(-1), ["omo-desk", "🙋 1"]);
	s.cleanup();
});

test("without a UI the footer is not touched", async () => {
	const s = setup({ hasUI: false, here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
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

test("a mine board inside the window -> recorded order is [wake activeCount 1, hold true]", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	assert.deepEqual(s.pi.emitted[0], { channel: "wake_source_state", data: { source: "omo-desk", activeCount: 1 } });
	assert.deepEqual(s.pi.emitted[1], { channel: "continuation_hold_state", data: { source: "omo-desk", active: true } });
	s.cleanup();
});

test("waiting goes from 1 to [] -> recorded order [hold false, wake 0]", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	s.pi.emitted.length = 0;
	s.state.here.waiting = [];
	await s.tick(30000);
	assert.equal(s.pi.emitted.length, 2);
	assert.deepEqual(s.pi.emitted[0], { channel: "continuation_hold_state", data: { source: "omo-desk", active: false } });
	assert.deepEqual(s.pi.emitted[1], { channel: "wake_source_state", data: { source: "omo-desk", activeCount: 0 } });
	s.cleanup();
});

test("a mine board older than the window is not counted while a theirs board of the same age is", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 40 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [
				{ id: "261004-mine", title: "Mine", status: "mine", since, seq: null },
				{ id: "261004-theirs", title: "Theirs", status: "theirs", since, seq: 3 },
			],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	assert.equal(s.pi.emitted[0].data.activeCount, 1);
	assert.equal(s.pi.emitted[1].data.active, true);
	s.cleanup();
});

test("getAskUserSettings timeoutMinutes 5 shrinks the window", async () => {
	const now = 1_750_000_000_000;
	const mine4min = new Date(now - 4 * 60_000).toISOString();
	const mine6min = new Date(now - 6 * 60_000).toISOString();
	const s = setup({
		hasUI: true,
		askUser: { timeoutMinutes: 5 },
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [
				{ id: "261004-4", title: "4min", status: "mine", since: mine4min, seq: null },
				{ id: "261004-6", title: "6min", status: "mine", since: mine6min, seq: null },
			],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.deepEqual(counts, [1], "only the 4-min board is inside the 5-minute window");
	s.cleanup();
});

test("unreachable server: the cached snapshot is re-published; expired board releases hold", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	let refreshCallCount = 0;
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	s.state.here = () => {
		refreshCallCount++;
		if (refreshCallCount > 1) throw new Error("server down");
		return { waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] };
	};
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	await s.tick(30000);
	assert.ok(s.pi.emitted.some((e) => e.data.activeCount === 1), "first refresh still shows the board");
	s.pi.emitted.length = 0;
	await s.tick(30000);
	assert.ok(s.pi.emitted.some((e) => e.data.activeCount === 1), "server down: cached snapshot re-published with board still inside window");
	s.pi.emitted.length = 0;
	s.advance(35 * 60_000);
	await s.tick(30000);
	const emissions = s.pi.emitted.filter((e) => e.channel === "wake_source_state");
	assert.ok(emissions.some((e) => e.data.activeCount === 0), "after advancing past the window, server down refresh shows count 0");
	s.cleanup();
});

test("shutdown emits hold false then wake 0", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	await s.pi.emit("session_shutdown", s.ctx);
	const shutdownEvents = s.pi.emitted.filter((e) => e.channel === "continuation_hold_state" || e.channel === "wake_source_state");
	assert.equal(shutdownEvents.length, 2);
	assert.deepEqual(shutdownEvents[0], { channel: "continuation_hold_state", data: { source: "omo-desk", active: false } });
	assert.deepEqual(shutdownEvents[1], { channel: "wake_source_state", data: { source: "omo-desk", activeCount: 0 } });
	s.cleanup();
});

test("a pi without events never throws", async () => {
	const fp = fakePi();
	delete fp.pi.events;
	const tmp = makeTmpHome();
	const { ctx } = fakeCtx();
	const handle = createDesk(fp.pi, {
		env: { OMO_DESK_HOME: tmp.home },
		home: tmp.home,
		now: () => 1_750_000_000_000,
		timer: { setInterval: () => ({}), clearInterval: () => {} },
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since: new Date(1_750_000_000_000 - 10 * 60_000).toISOString(), seq: null }] }),
		}),
	});
	await assert.doesNotReject(async () => {
		await handle.status(true);
	});
	handle.stop();
	tmp.cleanup();
});

test("every emitted pair satisfies hold.active === (activeCount > 0)", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	for (let i = 0; i < s.pi.emitted.length; i += 2) {
		const wake = s.pi.emitted[i];
		const hold = s.pi.emitted[i + 1];
		if (wake && hold) {
			const holdActive = hold.data.active;
			const wakeCount = wake.data.activeCount;
			assert.equal(holdActive, wakeCount > 0, `pair at ${i}: hold.active=${holdActive} but activeCount=${wakeCount}`);
		}
	}
	s.cleanup();
});

test("board cached as theirs with inbox payload, post-delivery refresh fails", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	let refreshCallCount = 0;
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }],
		},
	});
	s.state.here = () => {
		refreshCallCount++;
		if (refreshCallCount > 1) throw new Error("server down after delivery");
		return { waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }], footer: "" };
	};
	await s.pi.emit("session_start", s.ctx);
	s.pi.sent.length = 0;
	s.pi.emitted.length = 0;
	s.writeInbox();
	await s.tick(3000);
	const delivered = s.pi.sent.length > 0;
	assert.equal(delivered, true, "board delivered as followUp");
	const eventAfterDelivery = s.pi.emitted.filter((e) => e.channel === "wake_source_state");
	const hasCountZero = eventAfterDelivery.some((e) => e.data.activeCount === 0);
	assert.equal(hasCountZero, true, "post-delivery refresh emits count 0 even when server fails");
	s.cleanup();
});

test("a since of 'garbage' never counts as live", async () => {
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since: "garbage", seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.ok(counts.every((c) => c === 0), "board with invalid since never counts");
	s.cleanup();
});

test("a second session_start (reload) re-emits the current state on its first refresh", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const firstStart = s.pi.emitted.length;
	s.pi.emitted.length = 0;
	await s.pi.emit("session_start", s.ctx);
	assert.ok(s.pi.emitted.length > 0, "second session_start causes a refresh with events");
	s.cleanup();
});

test("a theirs item whose id-seq was already delivered by this copy is not counted", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	s.writeInbox("261004-abcd-000003.json", PAYLOAD);
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "payload delivered");
	s.pi.emitted.length = 0;
	await s.tick(30000);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.ok(counts.some((c) => c === 0), "after delivery, the same theirs item no longer counts");
	s.cleanup();
});

test("timeoutMinutes 0, -1 and 500 clamp to defaults/bounds", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 35 * 60_000).toISOString();
	for (const minutes of [0, -1, 500]) {
		const s = setup({
			askUser: { timeoutMinutes: minutes },
			here: {
				footer: "",
				notice: null,
				noticeKeys: [],
				waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
			},
		});
		await s.pi.emit("session_start", s.ctx);
		const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
		if (minutes === 0 || minutes === -1) {
			assert.ok(counts.some((c) => c === 0), `timeoutMinutes ${minutes} should clamp to default 30, board older than window`);
		} else if (minutes === 500) {
			assert.ok(counts.some((c) => c === 1), `timeoutMinutes 500 should clamp to 120, board inside 120-minute window`);
		}
		s.cleanup();
	}
});

test("expired mine board sends one timeout followUp before event emissions", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.advance(30 * 60_000);
	await s.handle.status(false);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].opts.deliverAs, "followUp");
	assert.equal(s.pi.sent[0].opts.triggerTurn, true);
	assert.deepEqual(s.pi.sent[0].message.details, { proposalId: "261004-abcd", timedOut: true });
	assert.match(s.pi.sent[0].message.content, /^\[omo-desk\] 답이 없습니다: Test \(261004-abcd\), 31분\n처리:/);
	assert.match(s.pi.sent[0].message.content, /node ".*\/app\/bin\/desk\.mjs" reply 261004-abcd 로 알리세요/);
	assert.ok(s.pi.sent[0].message.content.includes("/"), "home path uses forward slashes");
	assert.equal(s.pi.emitted.length, 4);
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 1, "second refresh does not re-send");
	s.cleanup();
});

test("revised since gets a new timeout notice", async () => {
	const now = 1_750_000_000_000;
	let since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({ here: () => ({ footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] }) });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.advance(31 * 60_000);
	since = new Date(now + 30 * 60_000).toISOString();
	s.advance(31 * 60_000);
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 1);
	s.cleanup();
});

test("expired boards already present at session_start stay silent across reload", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 31 * 60_000).toISOString();
	const s = setup({ here: { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] } });
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.cleanup();
});

test("theirs boards and same-since session replies never trigger timeout notices", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({ here: { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }] } });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.advance(28 * 60_000);
	s.state.here = { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] };
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 0, "session reply does not move since or restart its notice");
	s.cleanup();
});

test("the embedded safeSegment matches src/paths.mjs", () => {
	const table = ["s-1", "a/b\\c", "한글 세션", "", "..", "x".repeat(200), "a b?c*d", null, undefined, 12345, "dup--__.."];
	for (const value of table) {
		assert.equal(safeSegment(value), pathsSafeSegment(value), JSON.stringify(value));
	}
});
