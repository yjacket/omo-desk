/**
 * omo-desk senpi extension (plan todos 4-6).
 *
 * Loaded into every interactive session from <agentDir>/extensions. It is inert
 * in omo-task child sessions, registers no tools and never does blocking I/O:
 *   - every 3 s it drains <home>/inbox/<session>/*.json and delivers each
 *     feedback payload the server dropped there (followUp, wakes the turn);
 *   - every 30 s it refreshes the footer from /api/here, starts the server when
 *     it is down, and announces unanswered reviews once per session;
 *   - it reports waiting decision boards to senpi as a wake source and goal hold,
 *     emitting wake_source_state and continuation_hold_state; refreshes also happen
 *     after every tool execution; and it tells a session once when its board passes
 *     the answer window.
 *
 * senpi evaluates extensions through jiti/vm, where dynamic import() of repo
 * modules fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so safeSegment and
 * the home-dir expression are embedded here; test/extension.test.mjs keeps the
 * embedded safeSegment equal to src/paths.mjs.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"];
const INBOX_MS = 3000;
const STATUS_MS = 30000;
const SPAWN_COOLDOWN_MS = 120_000;
const FETCH_TIMEOUT_MS = 5000;
const TOOL_REFRESH_TIMEOUT_MS = 1500;
const DEFAULT_PORT = 4377;
const SERVER_DOWN = "보드 서버 꺼짐";
const WAKE_SOURCE = "omo-desk";
const WAKE_EVENT = "wake_source_state";
const HOLD_EVENT = "continuation_hold_state";
const ANSWER_WINDOW_DEFAULT_MIN = 30;

/** Same rule as src/paths.mjs safeSegment. */
export function safeSegment(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export function createDesk(pi, deps = {}) {
	const env = deps.env ?? process.env;
	if (CHILD_ENV.some((key) => String(env[key] ?? "").length > 0)) return null;
	const home = deps.home ?? env.OMO_DESK_HOME ?? path.join(os.homedir(), ".omo-desk");
	const agentDir = deps.agentDir ?? env.DESK_AGENT_DIR ?? env.OMO_CODING_AGENT_DIR ?? env.SENPI_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omo", "agent");
	const source = path.resolve(deps.source ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))));
	const ownFile = path.resolve(deps.extensionFile ?? fileURLToPath(import.meta.url));
	const now = deps.now ?? (() => Date.now());
	const timer = deps.timer ?? { setInterval, clearInterval };
	const doFetch = deps.fetch ?? ((...args) => globalThis.fetch(...args));
	const abortAfter = deps.abortAfter ?? ((ms) => AbortSignal.timeout(ms));
	const fsImpl = deps.fs ?? fs;
	const spawnImpl = deps.spawn ?? spawn;
	const execPath = deps.execPath ?? process.execPath;
	const platform = deps.platform ?? process.platform;
	const legacyExtension = path.join(agentDir, "extensions", "omo-desk.ts");
	const packageMode = deps.packageMode ?? (!deps.home && existsSync(path.join(source, ".git")) && existsSync(path.join(source, "bin", "desk.mjs")) && path.resolve(path.dirname(ownFile)) !== path.resolve(path.join(agentDir, "extensions")));
	const setupOnly = packageMode && existsSync(legacyExtension);
	const loadedSha = deps.loadedSha ?? (packageMode ? readCloneSha(source) : null);
	const activeKey = Symbol.for("omo-desk.extension.active");
	const owner = packageMode && !setupOnly;
	if (owner && globalThis[activeKey]) return null;
	if (owner) globalThis[activeKey] = source;
	let reloadTries = 0;
	let lastReloadAt = -Infinity;

	const delivered = new Set();
	const noticed = new Set();
	const timedOut = new Set();
	let ctx;
	let sessionId;
	let timers = [];
	let running = false;
	let staleGeneration = false;
	let lastFooter;
	let lastSpawnAt = -Infinity;
	let baseUrlCache;
	let waitingSnapshot = [];
	let initializedSession = false;
	let refreshPromise;
	let refreshRerun = false;
	let rerunStart = false;
	let refreshTimeoutMs = FETCH_TIMEOUT_MS;
	let rerunTimeoutMs = FETCH_TIMEOUT_MS;
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
		if (staleGeneration) return undefined;
		try {
			return await fn(...args);
		} catch (error) {
			if (String(error?.message ?? error).includes("stale extension generation")) {
				staleGeneration = true;
				stop();
				await log("stopped: extension generation replaced by reload");
				return undefined;
			}
			await log(`${name}: ${String((error && error.stack) || error)}`);
			return undefined;
		}
	};

	async function baseUrl() {
		if (baseUrlCache) return baseUrlCache;
		if (env.DESK_URL) return (baseUrlCache = String(env.DESK_URL).replace(/\/+$/, ""));
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

	const packageTick = safe("package", async () => {
		if (!packageMode || await exists(path.join(home, "disabled"))) return;
		let state;
		try {
			state = JSON.parse(await fsImpl.readFile(path.join(home, "app", "source.json"), "utf8"));
		} catch {
			state = undefined;
		}
		if (state?.channel === "checkout") return;
		const sha = await readCloneShaAsync(source, fsImpl);
		if (!sha) return;
		const sameSource = state?.source && path.resolve(state.source) === source;
		if (state?.channel === "package" && state.sha === sha && sameSource) {
			const legacyGone = !(await exists(legacyExtension));
			if ((setupOnly && legacyGone) || loadedSha !== sha) {
				if (reloadTries >= 3 || now() - lastReloadAt < 60_000) return;
				if (ctx?.isIdle?.() === false || (ctx?.hasPendingMessages?.() ?? ctx?.pendingMessages?.length > 0)) return;
				reloadTries += 1;
				lastReloadAt = now();
				(ctx?.requestReload ?? ctx?.reload)?.call(ctx);
			}
			return;
		}
		let claim;
		try {
			claim = JSON.parse(await fsImpl.readFile(path.join(home, "setup-state.json"), "utf8"));
		} catch {
			claim = undefined;
		}
		if ((claim?.sha === sha && claim.failedMs && now() - claim.failedMs < 10 * 60_000) || (claim?.sha === sha && claim.claimMs && now() - claim.claimMs < 60_000)) return;
		await fsImpl.mkdir(home, { recursive: true });
		const claimFile = path.join(home, "setup-state.json");
		await fsImpl.writeFile(claimFile, JSON.stringify({ sha, claimMs: now(), pid: process.pid }));
		let confirmed;
		try { confirmed = JSON.parse(await fsImpl.readFile(claimFile, "utf8")); } catch { return; }
		if (confirmed.sha !== sha || confirmed.pid !== process.pid) return;
		const child = spawnImpl(execPath, [path.join(source, "bin", "desk.mjs"), "install", "--from-package"], { detached: true, stdio: "ignore", windowsHide: true, cwd: home, env });
		child?.unref?.();
	});

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
		// A package install that has not finished setup has no app yet; setup starts the server itself.
		if (await exists(path.join(home, "disabled")) || (packageMode && !(await exists(path.join(home, "app", "bin", "desk.mjs"))))) return;
		if (now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return;
		lastSpawnAt = now();
		const node = await resolveNode();
		const child = spawnImpl(node, [path.join(home, "app", "bin", "desk.mjs"), "server", "start"], { detached: true, stdio: "ignore", windowsHide: true });
		child?.on?.("error", (e) => void log("ensure: " + e.message));
		child?.unref?.();
	});

	async function setFooter(text) {
		if (!ctx?.hasUI) return;
		const value = text || undefined;
		if (value === lastFooter) return;
		lastFooter = value;
		try {
			ctx.ui?.setStatus?.("omo-desk", value);
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
			pi?.sendMessage?.({ customType: "omo-desk", content: text, display: true, details: { pending: keys } }, { deliverAs: "nextTurn", triggerTurn: false });
		}
		for (const key of keys) noticed.add(key);
	});

	const answerWindowMs = () => {
		const rawMinutes = ctx?.getAskUserSettings?.()?.timeoutMinutes;
		const timeoutMinutes = typeof rawMinutes === "number" && rawMinutes > 0 ? Math.min(120, Math.max(1, rawMinutes)) : ANSWER_WINDOW_DEFAULT_MIN;
		return timeoutMinutes * 60_000;
	};

	const publishWaiting = safe("publishWaiting", () => {
		try {
			void ctx?.hasUI;
		} catch (error) {
			if (String(error?.message ?? error).includes("stale extension generation")) {
				staleGeneration = true;
				stop();
				void log("stopped: extension generation replaced by reload");
			} else {
				void log(`publishWaiting: ${String((error && error.message) || error)}`);
			}
			return;
		}
		const windowMs = answerWindowMs();
		const currentTime = now();
		for (const item of waitingSnapshot) {
			if (item.status !== "mine") continue;
			const since = Date.parse(item.since);
			if (isNaN(since) || currentTime - since < windowMs) continue;
			const key = `${item.id}@${item.since}`;
			if (timedOut.has(key)) continue;
			timedOut.add(key);
			const minutes = Math.floor((currentTime - since) / 60_000);
			const content = `[omo-desk] 답이 없습니다: ${item.title} (${item.id}), ${minutes}분\n처리: 되돌릴 수 있으면 권장안으로 진행하고 node "${home.replace(/\\/g, "/")}/app/bin/desk.mjs" reply ${item.id} 로 알리세요. 되돌릴 수 없으면 멈추세요. 나중에 온 답도 전달됩니다.`;
			pi?.sendMessage?.(
				{ customType: "omo-desk", content, display: true, details: { proposalId: item.id, timedOut: true } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		const live = waitingSnapshot.filter((item) => {
			if (item.status === "theirs") return !delivered.has(`${item.id}-${item.seq}`);
			if (item.status === "mine") {
				const since = Date.parse(item.since);
				if (isNaN(since)) return false;
				return currentTime - since < windowMs;
			}
			return false;
		});
		if (live.length > 0) {
			pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: live.length });
			pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: true });
		} else {
			pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: false });
			pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: 0 });
		}
	});

	const refreshStatus = safe("status", async (start) => {
		// After /desk uninstall there is no server to report on.
		if (await exists(path.join(home, "disabled"))) {
			await setFooter(undefined);
			return;
		}
		const cwd = ctx?.cwd ?? pi?.cwd ?? process.cwd();
		if (!sessionId || !cwd) return;
		const url = `${await baseUrl()}/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}${start ? "&start=1" : ""}`;
		let response;
		try {
			response = await doFetch(url, { headers: { accept: "application/json" }, signal: abortAfter(refreshTimeoutMs) });
		} catch (error) {
			await log(`status: ${String((error && error.message) || error)}`);
			await setFooter(SERVER_DOWN);
			await ensureServer();
			publishWaiting();
			return;
		}
		if (!response || !response.ok) {
			await setFooter(SERVER_DOWN);
			await ensureServer();
			publishWaiting();
			return;
		}
		const body = await response.json();
		waitingSnapshot = Array.isArray(body?.waiting) ? body.waiting : [];
		if (!initializedSession) {
			for (const item of waitingSnapshot) {
				const since = Date.parse(item.since);
				if (item.status === "mine" && !isNaN(since) && now() - since >= answerWindowMs()) timedOut.add(`${item.id}@${item.since}`);
			}
			initializedSession = true;
		}
		await setFooter(typeof body?.footer === "string" ? body.footer : "");
		await notice(body);
		publishWaiting();
	});

	const status = (start, timeoutMs = FETCH_TIMEOUT_MS) => {
		if (refreshPromise) {
			refreshRerun = true;
			rerunStart ||= Boolean(start);
			rerunTimeoutMs = Math.min(rerunTimeoutMs, timeoutMs);
			return refreshPromise;
		}
		refreshTimeoutMs = timeoutMs;
		refreshPromise = (async () => {
			try {
				await refreshStatus(start);
				while (refreshRerun) {
					refreshRerun = false;
					const startRerun = rerunStart;
					rerunStart = false;
					refreshTimeoutMs = rerunTimeoutMs;
					rerunTimeoutMs = FETCH_TIMEOUT_MS;
					await refreshStatus(startRerun);
				}
			} finally {
				refreshPromise = undefined;
				refreshRerun = false;
				rerunStart = false;
				rerunTimeoutMs = FETCH_TIMEOUT_MS;
			}
		})();
		return refreshPromise;
	};

	const onToolExecutionEnd = safe("tool_execution_end", () => status(false, TOOL_REFRESH_TIMEOUT_MS));

	async function removeQuietly(file) {
		try {
			await fsImpl.rm(file, { force: true });
		} catch (error) {
			// the file stays; the delivered set keeps the next tick from delivering it twice
			await log(`inbox: cannot delete ${file}: ${String((error && error.message) || error)}`);
		}
	}

	const drainInbox = safe("inbox", async () => {
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
				const response = await doFetch(`${await baseUrl()}/api/p/${encodeURIComponent(payload.proposalId)}?since=${encodeURIComponent(payload.seq)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
				const body = response?.ok ? await response.json() : undefined;
				theirs = !response?.ok || body?.summary?.status === "theirs";
			} catch {
				// the server is unreachable: deliver rather than lose the feedback
				theirs = true;
			}
			if (theirs) {
				pi?.sendMessage?.(
					{ customType: "omo-desk", content: payload.text, display: true, details: { proposalId: payload.proposalId, seq: payload.seq } },
					{ deliverAs: "followUp", triggerTurn: true },
				);
				delivered.add(key);
				waitingSnapshot = waitingSnapshot.filter((item) => item.id !== payload.proposalId);
				deliveredAny = true;
			}
			await removeQuietly(file);
		}
		if (deliveredAny) {
			publishWaiting();
			await status(false);
		}
	});

	let inboxRunning = false;

	/** A slow tick must not overlap the next one: both would deliver the same feedback. */
	const inbox = safe("inbox", async () => {
		if (inboxRunning) return;
		inboxRunning = true;
		try {
			await drainInbox();
		} finally {
			inboxRunning = false;
		}
	});

	function start() {
		if (setupOnly) {
			const id = timer.setInterval(() => packageTick(), STATUS_MS);
			id?.unref?.();
			timers.push(id);
			return;
		}
		if (running) return;
		running = true;
		const every = (ms, fn) => {
			const id = timer.setInterval(fn, ms);
			id?.unref?.();
			timers.push(id);
		};
		every(INBOX_MS, () => inbox());
		every(STATUS_MS, () => status(false));
		if (packageMode) every(STATUS_MS, () => packageTick());
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
		if (owner && globalThis[activeKey] === source) delete globalThis[activeKey];
	}

	const onSessionStart = safe("session_start", async (_event, nextCtx) => {
		ctx = nextCtx;
		await packageTick();
		start();
		if (setupOnly) return;
		initializedSession = false;
		try {
			sessionId = nextCtx?.sessionManager?.getSessionId?.() ?? sessionId;
		} catch {
			// keep the previous id
		}
		await status(true);
	});

	const onSessionShutdown = safe("session_shutdown", async () => {
		stop();
		if (owner && globalThis[activeKey] === source) delete globalThis[activeKey];
		if (setupOnly) return;
		pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: false });
		pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: 0 });
		if (!sessionId) return;
		try {
			await doFetch(`${await baseUrl()}/api/bye`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-desk": "1" },
				body: JSON.stringify({ session: sessionId }),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch {
			// the server is already gone
		}
	});

	try {
		pi?.on?.("session_start", onSessionStart);
		pi?.on?.("session_shutdown", onSessionShutdown);
		if (setupOnly) return { stop, packageTick };
		if (owner) pi?.registerCommand?.("desk", {
			handler: async (args, commandCtx) => {
				const action = String(args ?? "").trim().split(/\s+/)[0];
				let executable;
				let cliArgs;
				if (action === "install") {
					if (!packageMode) {
						commandCtx?.ui?.notify?.("패키지 설치에서만 사용할 수 있습니다.", "warning");
						return;
					}
					executable = path.join(source, "bin", "desk.mjs");
					cliArgs = ["install", "--from-package"];
				} else if (action === "uninstall") {
					executable = path.join(packageMode ? source : path.join(home, "app"), "bin", "desk.mjs");
					cliArgs = ["uninstall"];
				} else {
					commandCtx?.ui?.notify?.("사용법: /desk install | /desk uninstall", "info");
					return;
				}
				const child = spawnImpl(execPath, [executable, ...cliArgs], { detached: true, stdio: "ignore", windowsHide: true, cwd: home, env });
				child?.unref?.();
				commandCtx?.ui?.notify?.(action === "install" ? "omo-desk 설치를 시작했습니다." : "omo-desk 제거를 시작했습니다.", "info");
			},
		});
		pi?.on?.("tool_execution_end", onToolExecutionEnd);
	} catch (error) {
		void log(`register: ${String((error && error.message) || error)}`);
	}

	return { inbox, status, notice, packageTick, stop };
}

function readCloneSha(source) {
	try {
		const gitDir = path.join(source, ".git");
		let head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
		const ref = head.slice(5);
		try {
			const sha = readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim();
			if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
		} catch {}
		for (const line of readFileSync(path.join(gitDir, "packed-refs"), "utf8").split(/\r?\n/)) {
			const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
			if (match?.[2] === ref) return match[1];
		}
	} catch {}
	return null;
}

async function readCloneShaAsync(source, fsImpl) {
	try {
		const gitDir = path.join(source, ".git");
		const head = String(await fsImpl.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
		const ref = head.slice(5);
		try {
			const sha = String(await fsImpl.readFile(path.join(gitDir, ...ref.split("/")), "utf8")).trim();
			if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
		} catch {}
		for (const line of String(await fsImpl.readFile(path.join(gitDir, "packed-refs"), "utf8")).split(/\r?\n/)) {
			const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
			if (match?.[2] === ref) return match[1];
		}
	} catch {}
	return null;
}

export default function omoDeskExtension(pi, deps = {}) {
	return createDesk(pi, deps);
}
