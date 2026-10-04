import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { launchServer } from "./launch.mjs";
import { agentDir, layout, readConfig } from "./paths.mjs";
import { SERVE_PROXY, guard, parseServe, serveOff, serveOn, status } from "./tailscale.mjs";

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "omo-visual-board";
export const RELOAD_HINT = "열린 omo 세션에서 /reload 하면 확장이 반영됩니다.";

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
		repoRoot: opts.repoRoot ?? process.cwd(),
		userHome: opts.userHome ?? os.homedir(),
		execPath: opts.execPath ?? process.execPath,
		fetchImpl: opts.fetch ?? globalThis.fetch,
		now: opts.now ?? Date.now,
		sleep: opts.sleep ?? defaultSleep,
		runners: {
			reg: opts.runners?.reg ?? defaultReg,
			tailscale: opts.runners?.tailscale ?? defaultTailscale,
			spawn: opts.runners?.spawn ?? spawn,
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

export function readRunValue(regRunner) {
	let result;
	try {
		result = regRunner(["query", RUN_KEY, "/v", RUN_VALUE]);
	} catch {
		return undefined;
	}
	if (!result || result.status !== 0) return undefined;
	const line = String(result.stdout ?? "")
		.split(/\r?\n/)
		.find((candidate) => candidate.includes(RUN_VALUE) && candidate.includes("REG_"));
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
	const { env, repoRoot, userHome, execPath, fetchImpl, now, sleep, runners } = resolve(opts);
	const l = layout(env);
	const lines = [];
	let ok = true;
	const fail = (reason) => {
		ok = false;
		return `failed:${reason}`;
	};

	// 0. stop - a running server must not serve a half-copied app.
	const port = readConfig(env).port;
	if (await healthOk(fetchImpl, port)) {
		try {
			await fetchImpl(`http://127.0.0.1:${port}/api/shutdown`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-vb": "1" },
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

	// 1. app - replace the copy wholesale.
	fs.rmSync(l.app, { recursive: true, force: true });
	fs.mkdirSync(l.app, { recursive: true });
	for (const entry of APP_ENTRIES) {
		const src = path.join(repoRoot, entry);
		if (fs.existsSync(src)) fs.cpSync(src, path.join(l.app, entry), { recursive: true });
	}
	lines.push("app: written");

	// 2. launcher
	const launcher = launcherContent({ nodeExe: execPath, serverPath: path.join(l.app, "src", "server.mjs") });
	lines.push(`launcher: ${writeIfChanged(l.launcher, launcher)}`);

	// 3. autostart
	if (opts.noAutostart) {
		lines.push("autostart: skipped");
	} else {
		const wanted = runCommandValue(l);
		if (readRunValue(runners.reg) === wanted) {
			lines.push("autostart: unchanged");
		} else {
			const result = runners.reg(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", wanted, "/f"]);
			lines.push(`autostart: ${result.status === 0 ? "written" : fail(String(result.stderr ?? "").trim())}`);
		}
	}

	// 4. extension
	const extSrc = path.join(l.app, "extension", "visual-board.ts");
	const extDst = path.join(agentDir(env), "extensions", "visual-board.ts");
	if (!fs.existsSync(extSrc)) lines.push("extension: skipped");
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
	const ts = status(runners.tailscale);
	lines.push(`config: ${updateConfig(env, { publicBase: ts.publicBase, pcTailnetIps: ts.pcTailnetIps, owner: ts.owner })}`);

	// 8. tailscale serve on the tailnet port, guarded against disturbing 443.
	if (opts.noTailscale || ts.publicBase === null) {
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
		const version = readJsonSafe(path.join(l.app, "package.json"))?.version;
		fs.mkdirSync(l.home, { recursive: true });
		fs.writeFileSync(l.serverJson, `${JSON.stringify({ pid: launched.pid, port, started: new Date(now()).toISOString(), version }, null, 2)}\n`);
		lines.push(`server: started:${launched.pid}`);
	} else {
		lines.push(`server: ${fail("health timeout")}`);
	}

	lines.push(RELOAD_HINT);
	return { ok, lines };
}

// ---- uninstall -----------------------------------------------------------------------------------

export async function uninstall(opts = {}) {
	const { env, userHome, fetchImpl, now, sleep, runners } = resolve(opts);
	const l = layout(env);
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
				headers: { "content-type": "application/json", "x-vb": "1" },
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

	if (readRunValue(runners.reg) !== undefined) {
		const result = runners.reg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
		lines.push(`autostart: ${result.status === 0 ? "removed" : fail(String(result.stderr ?? "").trim())}`);
	} else {
		lines.push("autostart: absent");
	}

	lines.push(`extension: ${removePath(path.join(agentDir(env), "extensions", "visual-board.ts"))}`);
	const skillDirs = [
		path.join(userHome, ".agents", "skills", "visual-board"),
		path.join(userHome, ".claude", "skills", "visual-board"),
	];
	lines.push(`skill: ${skillDirs.map(removePath).includes("removed") ? "removed" : "absent"}`);
	lines.push(`rule: ${removePath(path.join(userHome, ".claude", "rules", "visual-board.md"))}`);

	if (cfg.publicBase === null) {
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
	return { ok, lines };
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
	record("run", readRunValue(runners.reg) === runCommandValue(l), "Run value differs");
	record("launcher", readText(l.launcher) === launcherContent({ nodeExe: execPath, serverPath: path.join(l.app, "src", "server.mjs") }), "content differs");
	record(
		"extension",
		filesEqual(path.join(l.app, "extension", "visual-board.ts"), path.join(agentDir(env), "extensions", "visual-board.ts")),
		"differs from the app copy",
	);
	record(
		"skill",
		fs.existsSync(path.join(userHome, ".agents", "skills", "visual-board", "SKILL.md")) &&
			fs.existsSync(path.join(userHome, ".claude", "skills", "visual-board", "SKILL.md")),
		"missing",
	);
	record("rule", fs.existsSync(path.join(userHome, ".claude", "rules", "visual-board.md")), "missing");

	const ts = status(runners.tailscale);
	const serve = parseServe(runners.tailscale(["serve", "status", "--json"]));
	const proxy = ts.dns ? serve.Web?.[`${ts.dns}:4378`]?.Handlers?.["/"]?.Proxy : undefined;
	record("serve", proxy === SERVE_PROXY, "4378 handler missing");
	record("funnel", !(ts.dns && Object.prototype.hasOwnProperty.call(serve.AllowFunnel ?? {}, `${ts.dns}:4378`)), "AllowFunnel has a 4378 key");
	const baseline443 = cfg.baseline443;
	record(
		"baseline443",
		Boolean(baseline443) &&
			isDeepStrictEqual(serve.Web?.[`${ts.dns}:443`] ?? null, baseline443.web ?? null) &&
			isDeepStrictEqual(serve.AllowFunnel ?? {}, baseline443.allowFunnel ?? {}),
		"443 entry drifted from baseline",
	);
	return { ok, lines };
}
