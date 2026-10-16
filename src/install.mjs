import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { launchServer } from "./launch.mjs";
import { agentDir, layout, readConfig } from "./paths.mjs";
import { SERVE_PROXY, guard, parseServe, serveOff, serveOn, status } from "./tailscale.mjs";

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "omo-desk";
export const RELOAD_HINT = "열린 omo 세션에서 /reload 하면 확장이 반영됩니다.";
export function runValueName(env = process.env) {
	return env.DESK_RUN_VALUE || RUN_VALUE;
}

const APP_ENTRIES = ["bin", "src", "web", "extension", "skill", "rules", "package.json"];
const STOP_TIMEOUT_MS = 5_000;
const SERVER_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

// ---- injectable defaults (never touched by tests, which pass fakes) -------------------------------

export function defaultReg(args) {
	const result = spawnSync("reg.exe", args, { windowsHide: true, encoding: "utf8", timeout: 15_000 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function defaultTailscale(args) {
	const result = spawnSync("tailscale", args, { windowsHide: true, encoding: "utf8", timeout: 15_000 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolve(opts) {
	const env = opts.env ?? process.env;
	return {
		env,
		repoRoot: opts.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
		userHome: opts.userHome ?? env.DESK_USER_HOME ?? os.homedir(),
		execPath: opts.execPath ?? process.execPath,
		fetchImpl: opts.fetch ?? globalThis.fetch,
		now: opts.now ?? Date.now,
		sleep: opts.sleep ?? defaultSleep,
		runners: {
			reg: opts.runners?.reg ?? defaultReg,
			tailscale: opts.runners?.tailscale ?? defaultTailscale,
			spawn: opts.runners?.spawn ?? spawn,
			git: opts.runners?.git ?? ((args, options) => spawnSync("git", args, { ...options, windowsHide: true, encoding: "utf8" })),
		},
	};
}

// ---- small fs helpers ----------------------------------------------------------------------------

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Canonical form of a path for identity comparison: resolve symlinks/junctions when the path exists
 * (falling back to the plain resolve otherwise), and fold case on win32 where NTFS is
 * case-insensitive. A raw string compare misses `c:/users/.../app` and a junction into <home>/app.
 */
function canonicalPath(target) {
	let resolved;
	try {
		resolved = fs.realpathSync.native(target);
	} catch {
		resolved = path.resolve(target);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSamePath(a, b) {
	return canonicalPath(a) === canonicalPath(b);
}

function writeIfChanged(file, text) {
	const current = readText(file);
	if (current === text) return "unchanged";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return "written";
}

function readJsonSafe(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function filesEqual(a, b) {
	try {
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch {
		return false;
	}
}

function dirSnapshot(root) {
	if (!fs.existsSync(root)) return null;
	const files = {};
	const walk = (dir, rel) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const key = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(full, key);
			else files[key] = fs.readFileSync(full);
		}
	};
	walk(root, "");
	return files;
}

function sameDir(a, b) {
	const left = dirSnapshot(a);
	const right = dirSnapshot(b);
	if (left === null || right === null) return left === right;
	const keys = Object.keys(left).sort();
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && Buffer.compare(left[key], right[key]) === 0);
}

function syncDir(src, dst) {
	if (sameDir(src, dst)) return "unchanged";
	if (!fs.existsSync(src)) return "skipped";
	fs.rmSync(dst, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.cpSync(src, dst, { recursive: true });
	return "written";
}

function removePath(file) {
	if (!fs.existsSync(file)) return "absent";
	fs.rmSync(file, { recursive: true, force: true });
	return "removed";
}

// ---- registry / launcher / config values ---------------------------------------------------------

export function runCommandValue(paths) {
	return `wscript.exe "${paths.launcher}"`;
}

export function launcherContent({ nodeExe, serverPath }) {
	return [
		'Set sh = CreateObject("WScript.Shell")',
		`sh.Run """${nodeExe}"" --max-semi-space-size=1 --max-old-space-size=128 ""${serverPath}""", 0, False`,
		"",
	].join("\r\n");
}

export function readRunValue(regRunner, valueName = RUN_VALUE) {
	let result;
	try {
		result = regRunner(["query", RUN_KEY, "/v", valueName]);
	} catch {
		return undefined;
	}
	if (!result || result.status !== 0) return undefined;
	const line = String(result.stdout ?? "")
		.split(/\r?\n/)
		.find((candidate) => candidate.includes(valueName) && candidate.includes("REG_"));
	if (!line) return undefined;
	return line.replace(/^\s*\S+\s+REG_\w+\s+/, "").trim();
}

function updateConfig(env, patch) {
	const file = layout(env).config;
	const merged = { ...readConfig(env), ...patch };
	const text = `${JSON.stringify(merged, null, 2)}\n`;
	const current = readJsonSafe(file);
	if (current && isDeepStrictEqual(current, merged)) return "unchanged";
	return writeIfChanged(file, text);
}

// ---- health polling ------------------------------------------------------------------------------

async function healthOk(fetchImpl, port) {
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
		return Boolean(response && response.ok);
	} catch {
		return false;
	}
}

async function waitUntil(check, { timeoutMs, now, sleep }) {
	const start = now();
	for (;;) {
		if (await check()) return true;
		if (now() - start >= timeoutMs) return false;
		await sleep(POLL_MS);
	}
}

// ---- install -------------------------------------------------------------------------------------

export async function install(opts = {}) {
	const resolved = resolve(opts);
	const { env, userHome, execPath, fetchImpl, now, sleep, runners } = resolved;
	const repoRoot = opts.repoRoot ?? resolved.repoRoot;
	const l = layout(env);
	if (opts.fromPackage) {
		const lock = path.join(l.home, "setup.lock");
		fs.mkdirSync(l.home, { recursive: true });
		let acquired = false;
		try {
			try {
				const fd = fs.openSync(lock, "wx");
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedMs: now() }));
				fs.closeSync(fd);
				acquired = true;
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				const holder = readJsonSafe(lock);
				let alive = false;
				if (Number.isInteger(holder?.pid) && holder.pid > 0) {
					try { process.kill(holder.pid, 0); alive = true; } catch {}
				}
				if (alive && Number.isFinite(holder?.startedMs) && now() - holder.startedMs < 10 * 60_000) {
					return { ok: true, lines: ["setup: locked"] };
				}
				fs.rmSync(lock, { force: true });
				const fd = fs.openSync(lock, "wx");
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedMs: now() }));
				fs.closeSync(fd);
				acquired = true;
			}
			const sourceFile = path.join(l.app, "source.json");
			const previous = readJsonSafe(sourceFile);
			if (previous?.channel === "checkout") return { ok: true, lines: ["setup: checkout install kept"] };
			const git = runners.git(["rev-parse", "HEAD"], { cwd: repoRoot });
			const sha = git.status === 0 ? String(git.stdout).trim() || null : null;
			if (previous?.channel === "package" && previous.sha === sha && isSamePath(previous.source, repoRoot) &&
				fs.existsSync(path.join(l.app, "src", "server.mjs"))) return { ok: true, lines: ["app: current"] };
			fs.rmSync(path.join(l.home, "disabled"), { force: true });
			const result = await install({ ...opts, fromPackage: false, repoRoot, packageInner: true });
			const state = result.ok
				? { sha, doneMs: now() }
				: { sha, failedMs: now(), error: result.lines.join("; ") };
			writeIfChanged(path.join(l.home, "setup-state.json"), `${JSON.stringify(state, null, 2)}\n`);
			fs.mkdirSync(l.app, { recursive: true });
			const metadata = {
				channel: "package",
				source: repoRoot,
				sha,
				version: readJsonSafe(path.join(repoRoot, "package.json"))?.version ?? null,
				installedMs: now(),
			};
			writeIfChanged(sourceFile, `${JSON.stringify(metadata, null, 2)}\n`);
			fs.rmSync(path.join(l.home, "disabled"), { force: true });
			fs.mkdirSync(l.logs, { recursive: true });
			fs.appendFileSync(path.join(l.logs, "install.log"), `${now()} ${result.ok ? "done" : "failed"} ${sha ?? ""}\n`);
			return result;
		} finally {
			if (acquired) fs.rmSync(lock, { force: true });
		}
	}
	const lines = [];
	let ok = true;
	const fail = (reason) => {
		ok = false;
		return `failed:${reason}`;
	};

	// 1. app - refuse a non-repo source before anything is stopped or deleted, so a refused install
	// leaves a running server alone instead of shutting it down and exiting 1.
	if (!fs.existsSync(path.join(repoRoot, "src", "server.mjs")) || isSamePath(repoRoot, l.app)) {
		lines.push(`app: ${fail(`not a repo checkout ${repoRoot}`)}`);
		return { ok, lines };
	}

	// 0. stop - a running server must not serve a half-copied app.
	const port = readConfig(env).port;
	if (await healthOk(fetchImpl, port)) {
		try {
			await fetchImpl(`http://127.0.0.1:${port}/api/shutdown`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-desk": "1" },
				body: "{}",
			});
		} catch {
			// the wait below is the source of truth
		}
		const down = await waitUntil(async () => !(await healthOk(fetchImpl, port)), { timeoutMs: STOP_TIMEOUT_MS, now, sleep });
		lines.push(`stop: ${down ? "stopped" : fail("server did not stop")}`);
		// a live server still holds <home>/app open - copying over it only produces EPERM noise.
		if (!down) return { ok, lines };
	} else {
		lines.push("stop: skipped");
	}

	// 1. app - replace the copy wholesale (the source was validated up front).
	fs.rmSync(l.app, { recursive: true, force: true });
	fs.mkdirSync(l.app, { recursive: true });
	for (const entry of APP_ENTRIES) {
		const src = path.join(repoRoot, entry);
		if (fs.existsSync(src)) fs.cpSync(src, path.join(l.app, entry), { recursive: true });
	}
	const missing = APP_ENTRIES.filter((entry) => !fs.existsSync(path.join(l.app, entry)));
	lines.push(missing.length === 0 ? "app: written" : `app: ${fail(`missing ${missing[0]}`)}`);

	// 2. launcher
	const launcher = launcherContent({ nodeExe: execPath, serverPath: path.join(l.app, "src", "server.mjs") });
	lines.push(`launcher: ${writeIfChanged(l.launcher, launcher)}`);

	// 3. autostart
	if (opts.noAutostart) {
		lines.push("autostart: skipped");
	} else {
		const wanted = runCommandValue(l);
		if (readRunValue(runners.reg, runValueName(env)) === wanted) {
			lines.push("autostart: unchanged");
		} else {
			const result = runners.reg(["add", RUN_KEY, "/v", runValueName(env), "/t", "REG_SZ", "/d", wanted, "/f"]);
			lines.push(`autostart: ${result.status === 0 ? "written" : fail(String(result.stderr ?? "").trim())}`);
		}
	}

	// 4. extension
	const extSrc = path.join(l.app, "extension", "omo-desk.ts");
	const extDst = path.join(agentDir(env), "extensions", "omo-desk.ts");
	if (opts.packageInner) lines.push(`extension: legacy ${removePath(extDst)}`);
	else if (!fs.existsSync(extSrc)) lines.push("extension: skipped");
	else if (filesEqual(extSrc, extDst)) lines.push("extension: unchanged");
	else {
		fs.mkdirSync(path.dirname(extDst), { recursive: true });
		fs.copyFileSync(extSrc, extDst);
		lines.push("extension: written");
	}

	// 5. skill - replace both skill homes with the app copy.
	const skillSrc = path.join(l.app, "skill");
	if (!fs.existsSync(skillSrc)) lines.push("skill: skipped");
	else {
		const statuses = [
			syncDir(skillSrc, path.join(userHome, ".agents", "skills", "visual-board")),
			syncDir(skillSrc, path.join(userHome, ".claude", "skills", "visual-board")),
		];
		lines.push(`skill: ${statuses.includes("written") ? "written" : "unchanged"}`);
	}

	// 6. rule
	const ruleSrc = path.join(l.app, "rules", "visual-board.md");
	const ruleDst = path.join(userHome, ".claude", "rules", "visual-board.md");
	if (!fs.existsSync(ruleSrc)) lines.push("rule: skipped");
	else {
		fs.mkdirSync(path.dirname(ruleDst), { recursive: true });
		lines.push(`rule: ${writeIfChanged(ruleDst, fs.readFileSync(ruleSrc, "utf8"))}`);
	}

	// 7. config from tailscale status
	const ts = env.DESK_NO_TAILSCALE === "1" ? { publicBase: null, pcTailnetIps: [], owner: null, dns: null } : status(runners.tailscale);
	lines.push(`config: ${updateConfig(env, { publicBase: ts.publicBase, pcTailnetIps: ts.pcTailnetIps, owner: ts.owner })}`);

	// 8. tailscale serve on the tailnet port, guarded against disturbing 443.
	if (env.DESK_NO_TAILSCALE === "1" || opts.noTailscale || ts.publicBase === null) {
		lines.push("tailscale: skipped");
	} else {
		const baseline = parseServe(runners.tailscale(["serve", "status", "--json"]));
		const already = baseline.Web?.[`${ts.dns}:4378`]?.Handlers?.["/"]?.Proxy === SERVE_PROXY;
		if (already) {
			const stored = updateConfig(env, { baseline443: { web: baseline.Web?.[`${ts.dns}:443`] ?? null, allowFunnel: baseline.AllowFunnel ?? {} } });
			lines.push(`tailscale: ${stored === "written" ? "written" : "unchanged"}`);
		} else {
			serveOn(runners.tailscale);
			const after = parseServe(runners.tailscale(["serve", "status", "--json"]));
			if (guard(baseline, after, ts.dns)) {
				updateConfig(env, { baseline443: { web: baseline.Web?.[`${ts.dns}:443`] ?? null, allowFunnel: baseline.AllowFunnel ?? {} } });
				lines.push("tailscale: written");
			} else {
				serveOff(runners.tailscale);
				lines.push(`tailscale: ${fail("443-guard")}`);
			}
		}
	}

	// 9. server
	const launched = await launchServer({ env, spawnImpl: runners.spawn, execPath });
	const up = await waitUntil(async () => await healthOk(fetchImpl, port), { timeoutMs: SERVER_TIMEOUT_MS, now, sleep });
	if (up) {
		// server.json belongs to the running server (src/server.mjs), not to install.
		lines.push(`server: started:${launched.pid}`);
	} else {
		lines.push(`server: ${fail("health timeout")}`);
	}

	lines.push(RELOAD_HINT);
	const sourceFile = path.join(l.app, "source.json");
	if (fs.existsSync(l.app) && !opts.packageInner) {
		const metadata = {
			channel: "checkout",
			source: repoRoot,
			sha: null,
			version: readJsonSafe(path.join(repoRoot, "package.json"))?.version ?? null,
			installedMs: now(),
		};
		writeIfChanged(sourceFile, `${JSON.stringify(metadata, null, 2)}\n`);
	}
	return { ok, lines };
}

// ---- uninstall -----------------------------------------------------------------------------------

export async function uninstall(opts = {}) {
	const { env, userHome, fetchImpl, now, sleep, runners } = resolve(opts);
	const l = layout(env);
	const priorSource = readJsonSafe(path.join(l.app, "source.json"));
	const cwd = process.cwd();
	const appPath = canonicalPath(l.app);
	const cwdPath = canonicalPath(cwd);
	const movedCwd = cwdPath === appPath || cwdPath.startsWith(`${appPath}${path.sep}`);
	if (movedCwd) process.chdir(path.dirname(l.home));
	const disabled = priorSource?.channel === "package" || opts.disable;
	if (disabled) writeIfChanged(path.join(l.home, "disabled"), "disabled\n");
	const lines = [];
	let ok = true;
	const fail = (reason) => {
		ok = false;
		return `failed:${reason}`;
	};
	const cfg = readConfig(env);

	if (await healthOk(fetchImpl, cfg.port)) {
		try {
			await fetchImpl(`http://127.0.0.1:${cfg.port}/api/shutdown`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-desk": "1" },
				body: "{}",
			});
		} catch {
			// the wait below is the source of truth
		}
		const down = await waitUntil(async () => !(await healthOk(fetchImpl, cfg.port)), { timeoutMs: STOP_TIMEOUT_MS, now, sleep });
		lines.push(`server: ${down ? "stopped" : fail("server did not stop")}`);
	} else {
		lines.push("server: not-running");
	}

	if (readRunValue(runners.reg, runValueName(env)) !== undefined) {
		const result = runners.reg(["delete", RUN_KEY, "/v", runValueName(env), "/f"]);
		lines.push(`autostart: ${result.status === 0 ? "removed" : fail(String(result.stderr ?? "").trim())}`);
	} else {
		lines.push("autostart: absent");
	}

	lines.push(`extension: ${removePath(path.join(agentDir(env), "extensions", "omo-desk.ts"))}`);
	const skillDirs = [
		path.join(userHome, ".agents", "skills", "visual-board"),
		path.join(userHome, ".claude", "skills", "visual-board"),
	];
	lines.push(`skill: ${skillDirs.map(removePath).includes("removed") ? "removed" : "absent"}`);
	lines.push(`rule: ${removePath(path.join(userHome, ".claude", "rules", "visual-board.md"))}`);

	if (env.DESK_NO_TAILSCALE === "1" || opts.noTailscale || cfg.publicBase === null) {
		lines.push("tailscale: skipped");
	} else {
		const dns = status(runners.tailscale).dns;
		const baseline = parseServe(runners.tailscale(["serve", "status", "--json"]));
		serveOff(runners.tailscale);
		const after = parseServe(runners.tailscale(["serve", "status", "--json"]));
		if (guard(baseline, after, dns, { proxy: null })) lines.push("tailscale: off");
		else lines.push(`tailscale: ${fail("443-guard")}`);
	}

	lines.push(`app: ${removePath(l.app)}`);
	lines.push(`launcher: ${removePath(l.launcher)}`);
	lines.push(`config: ${removePath(l.config)}`);
	lines.push(`serverJson: ${removePath(l.serverJson)}`);
	lines.push(`data kept: ${l.data}`);
	const result = { ok, lines };
	if (disabled) {
		fs.mkdirSync(l.home, { recursive: true });
		writeIfChanged(path.join(l.home, "disabled"), "disabled\n");
	}
	return result;
}

// ---- doctor --------------------------------------------------------------------------------------

export async function doctor(opts = {}) {
	const { env, userHome, execPath, fetchImpl, runners } = resolve(opts);
	const l = layout(env);
	const lines = [];
	let ok = true;
	const record = (name, good, detail) => {
		if (!good) ok = false;
		lines.push(good ? `${name}: ok` : `${name}: fail ${detail ?? ""}`.trimEnd());
	};
	const cfg = readConfig(env);

	record("health", await healthOk(fetchImpl, cfg.port), "no answer");
	record("run", readRunValue(runners.reg, runValueName(env)) === runCommandValue(l), "Run value differs");
	record("launcher", readText(l.launcher) === launcherContent({ nodeExe: execPath, serverPath: path.join(l.app, "src", "server.mjs") }), "content differs");
	const source = readJsonSafe(path.join(l.app, "source.json"));
	const noTailscale = env.DESK_NO_TAILSCALE === "1" || opts.noTailscale;
	const extensionOk = source?.channel === "package"
		? filesEqual(path.join(l.app, "extension", "omo-desk.ts"), path.join(source.source, "extension", "omo-desk.ts")) &&
			!fs.existsSync(path.join(agentDir(env), "extensions", "omo-desk.ts"))
		: filesEqual(path.join(l.app, "extension", "omo-desk.ts"), path.join(agentDir(env), "extensions", "omo-desk.ts"));
	record("extension", extensionOk, "differs from the app copy");
	record(
		"skill",
		fs.existsSync(path.join(userHome, ".agents", "skills", "visual-board", "SKILL.md")) &&
			fs.existsSync(path.join(userHome, ".claude", "skills", "visual-board", "SKILL.md")),
		"missing",
	);
	record("rule", fs.existsSync(path.join(userHome, ".claude", "rules", "visual-board.md")), "missing");

	const ts = noTailscale ? { dns: null } : status(runners.tailscale);
	const serve = noTailscale ? {} : parseServe(runners.tailscale(["serve", "status", "--json"]));
	const proxy = ts.dns ? serve.Web?.[`${ts.dns}:4378`]?.Handlers?.["/"]?.Proxy : undefined;
	if (!noTailscale) {
		record("serve", proxy === SERVE_PROXY, "4378 handler missing");
		record("funnel", !(ts.dns && Object.prototype.hasOwnProperty.call(serve.AllowFunnel ?? {}, `${ts.dns}:4378`)), "AllowFunnel has a 4378 key");
	}
	const baseline443 = cfg.baseline443;
	if (!noTailscale) record(
		"baseline443",
		Boolean(baseline443) &&
			isDeepStrictEqual(serve.Web?.[`${ts.dns}:443`] ?? null, baseline443.web ?? null) &&
			isDeepStrictEqual(serve.AllowFunnel ?? {}, baseline443.allowFunnel ?? {}),
		"443 entry drifted from baseline",
	);
	return { ok, lines };
}
