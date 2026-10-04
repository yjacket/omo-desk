/**
 * visual-board senpi extension (plan todo 11).
 *
 * Loaded into every interactive session from <agentDir>/extensions. It is inert
 * in omo-task child sessions, registers no tools and never does blocking I/O:
 *   - every 3 s it drains <home>/inbox/<session>/*.json and delivers each
 *     feedback payload the server dropped there (followUp, wakes the turn);
 *   - every 30 s it refreshes the footer from /api/here, starts the server when
 *     it is down, and announces unanswered reviews once per session.
 *
 * senpi evaluates extensions through jiti/vm, where dynamic import() of repo
 * modules fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so safeSegment and
 * the home-dir expression are embedded here; test/extension.test.mjs keeps the
 * embedded safeSegment equal to src/paths.mjs.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"];
const INBOX_MS = 3000;
const STATUS_MS = 30000;
const SPAWN_COOLDOWN_MS = 120_000;
const DEFAULT_PORT = 4377;
const SERVER_DOWN = "보드 서버 꺼짐";

/** Same rule as src/paths.mjs safeSegment. */
export function safeSegment(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export function createVisualBoard(pi, deps = {}) {
	const env = deps.env ?? process.env;
	if (CHILD_ENV.some((key) => String(env[key] ?? "").length > 0)) return null;
	const home = deps.home ?? env.OMO_VISUAL_BOARD_HOME ?? path.join(os.homedir(), ".omo-visual-board");
	const now = deps.now ?? (() => Date.now());
	const timer = deps.timer ?? { setInterval, clearInterval };
	const doFetch = deps.fetch ?? ((...args) => globalThis.fetch(...args));
	const fsImpl = deps.fs ?? fs;
	const spawnImpl = deps.spawn ?? spawn;
	const execPath = deps.execPath ?? process.execPath;
	const platform = deps.platform ?? process.platform;

	const delivered = new Set();
	const noticed = new Set();
	let ctx;
	let sessionId;
	let timers = [];
	let running = false;
	let lastFooter;
	let lastSpawnAt = -Infinity;
	let baseUrlCache;

	const log = async (text) => {
		try {
			await fsImpl.mkdir(path.join(home, "logs"), { recursive: true });
			await fsImpl.appendFile(path.join(home, "logs", "extension.log"), `${new Date(now()).toISOString()} ${String(text).slice(0, 1500)}\n`);
		} catch {
			// logging must never disturb the session
		}
	};

	/** Every handler and timer body runs through this: a failure is logged, never thrown into senpi. */
	const safe = (name, fn) => async (...args) => {
		try {
			return await fn(...args);
		} catch (error) {
			await log(`${name}: ${String((error && error.stack) || error)}`);
			return undefined;
		}
	};

	async function baseUrl() {
		if (baseUrlCache) return baseUrlCache;
		if (env.VB_URL) return (baseUrlCache = String(env.VB_URL).replace(/\/+$/, ""));
		let port = DEFAULT_PORT;
		try {
			const raw = await fsImpl.readFile(path.join(home, "config.json"), "utf8");
			const config = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
			if (config && Number(config.port) > 0) port = Number(config.port);
			baseUrlCache = `http://127.0.0.1:${port}`;
		} catch {
			// no config yet (before install) - the default port is what install writes
		}
		return `http://127.0.0.1:${port}`;
	}

	async function exists(file) {
		try {
			await fsImpl.access(file);
			return true;
		} catch {
			return false;
		}
	}

	async function resolveNode() {
		if (/^node(\.exe)?$/i.test(path.basename(execPath))) return execPath;
		const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? "";
		for (const dir of String(pathValue).split(platform === "win32" ? ";" : ":")) {
			const candidate = path.join(dir, platform === "win32" ? "node.exe" : "node");
			if (dir && (await exists(candidate))) return candidate;
		}
		return "node";
	}

	/** The CLI launches the server outside this session's job (WMI on Windows); at most one attempt per 120 s. */
	const ensureServer = safe("ensure", async () => {
		if (now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return;
		lastSpawnAt = now();
		const node = await resolveNode();
		const child = spawnImpl(node, [path.join(home, "app", "bin", "vb.mjs"), "server", "start"], { detached: true, stdio: "ignore", windowsHide: true });
		child?.unref?.();
	});

	async function setFooter(text) {
		if (!ctx?.hasUI) return;
		const value = text || undefined;
		if (value === lastFooter) return;
		lastFooter = value;
		try {
			ctx.ui?.setStatus?.("visual-board", value);
		} catch {
			// the UI may already be gone during shutdown
		}
	}

	/** The server decides when a pending review is worth announcing; each key is announced once per session. */
	const notice = safe("notice", async (body) => {
		const keys = Array.isArray(body?.noticeKeys) ? body.noticeKeys.filter((key) => typeof key === "string") : [];
		if (keys.length === 0) return;
		if (!keys.some((key) => !noticed.has(key))) return;
		const text = typeof body?.notice === "string" ? body.notice : "";
		if (text) {
			pi?.sendMessage?.({ customType: "visual-board", content: text, display: true, details: { pending: keys } }, { deliverAs: "nextTurn", triggerTurn: false });
		}
		for (const key of keys) noticed.add(key);
	});

	const status = safe("status", async (start) => {
		const cwd = ctx?.cwd ?? pi?.cwd ?? process.cwd();
		if (!sessionId || !cwd) return;
		const url = `${await baseUrl()}/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}${start ? "&start=1" : ""}`;
		let response;
		try {
			response = await doFetch(url, { headers: { accept: "application/json" } });
		} catch (error) {
			await log(`status: ${String((error && error.message) || error)}`);
			await setFooter(SERVER_DOWN);
			await ensureServer();
			return;
		}
		if (!response || !response.ok) {
			await setFooter(SERVER_DOWN);
			await ensureServer();
			return;
		}
		const body = await response.json();
		await setFooter(typeof body?.footer === "string" ? body.footer : "");
		await notice(body);
	});

	async function removeQuietly(file) {
		try {
			await fsImpl.rm(file, { force: true });
		} catch (error) {
			// the file stays; the delivered set keeps the next tick from delivering it twice
			await log(`inbox: cannot delete ${file}: ${String((error && error.message) || error)}`);
		}
	}

	const inbox = safe("inbox", async () => {
		if (!sessionId) return;
		const dir = path.join(home, "inbox", safeSegment(sessionId));
		let names;
		try {
			names = await fsImpl.readdir(dir);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		let deliveredAny = false;
		for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
			const file = path.join(dir, name);
			let payload;
			try {
				payload = JSON.parse(String(await fsImpl.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
			} catch (error) {
				await log(`inbox: unparsable ${file}: ${String((error && error.message) || error)}`);
				await removeQuietly(file);
				continue;
			}
			if (!payload || typeof payload !== "object" || !payload.proposalId || payload.seq == null) {
				await log(`inbox: unparsable ${file}: missing proposalId/seq`);
				await removeQuietly(file);
				continue;
			}
			const key = `${payload.proposalId}-${payload.seq}`;
			if (delivered.has(key)) {
				await removeQuietly(file);
				continue;
			}
			let theirs = false;
			try {
				const response = await doFetch(`${await baseUrl()}/api/p/${encodeURIComponent(payload.proposalId)}?since=${encodeURIComponent(payload.seq)}`, { headers: { accept: "application/json" } });
				if (response && response.ok) {
					const body = await response.json();
					theirs = body?.summary?.status === "theirs";
				}
			} catch {
				// the server is unreachable: deliver rather than lose the feedback
				theirs = true;
			}
			if (theirs) {
				pi?.sendMessage?.(
					{ customType: "visual-board", content: payload.text, display: true, details: { proposalId: payload.proposalId, seq: payload.seq } },
					{ deliverAs: "followUp", triggerTurn: true },
				);
				delivered.add(key);
				deliveredAny = true;
			}
			await removeQuietly(file);
		}
		if (deliveredAny) await status(false);
	});

	function start() {
		if (running) return;
		running = true;
		const every = (ms, fn) => {
			const id = timer.setInterval(fn, ms);
			id?.unref?.();
			timers.push(id);
		};
		every(INBOX_MS, () => inbox());
		every(STATUS_MS, () => status(false));
	}

	function stop() {
		for (const id of timers) {
			try {
				timer.clearInterval(id);
			} catch {
				// the timer may already be gone
			}
		}
		timers = [];
		running = false;
	}

	const onSessionStart = safe("session_start", async (_event, nextCtx) => {
		ctx = nextCtx;
		try {
			sessionId = nextCtx?.sessionManager?.getSessionId?.() ?? sessionId;
		} catch {
			// keep the previous id
		}
		start();
		await status(true);
	});

	const onSessionShutdown = safe("session_shutdown", async () => {
		stop();
		if (!sessionId) return;
		try {
			await doFetch(`${await baseUrl()}/api/bye`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-vb": "1" },
				body: JSON.stringify({ session: sessionId }),
			});
		} catch {
			// the server is already gone
		}
	});

	try {
		pi?.on?.("session_start", onSessionStart);
		pi?.on?.("session_shutdown", onSessionShutdown);
	} catch (error) {
		void log(`register: ${String((error && error.message) || error)}`);
	}

	return { inbox, status, notice, stop };
}

export default function visualBoardExtension(pi, deps = {}) {
	return createVisualBoard(pi, deps);
}
