import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layout, readConfig } from "./paths.mjs";
import { identityFor, normPath } from "./identity.mjs";
import { validateBoard } from "./board.mjs";
import { classify, ALLOW, postGuard } from "./access.mjs";
import { feedbackMessage, pendingNotice, footerText } from "./message.mjs";
import { createStore } from "./store.mjs";

const BODY_LIMIT = 30 * 1024 * 1024;
const URL_LIMIT = 30000;
const IDENTITY_TTL_MS = 60_000;
const LIVE_WINDOW_MS = 90_000;
const PROBE_TIMEOUT_MS = 3000;
const ASIDE_FALLBACK = "C:\\Program Files\\Aside\\Application\\Aside.exe";
const NAME = "omo-visual-board";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mmd": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

const INVALID_SEGMENT = /^(?:|\.|\.\.)$/;

function toSlash(value) {
	return String(value).replace(/\\/g, "/");
}

function contentType(file) {
	return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function readVersion() {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
		if (parsed && typeof parsed.version === "string") return parsed.version;
	} catch {
		// a missing or broken package.json is not fatal for the health route
	}
	return "0.0.0";
}

function readTargets(webDir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(webDir, "targets.json"), "utf8"));
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// no targets file means an empty chooser
	}
	return [];
}

function asideExe() {
	if (process.platform !== "win32") return ASIDE_FALLBACK;
	try {
		const out = execFileSync("reg", ["query", "HKCR\\aside\\shell\\open\\command"], { encoding: "utf8", windowsHide: true });
		const quoted = out.match(/"([^"]+)"/);
		if (quoted) return quoted[1];
		const first = out.trim().split(/\s+/)[0];
		if (first) return first;
	} catch {
		// Aside is optional; fall back to the default install path
	}
	return ASIDE_FALLBACK;
}

function appendLog(logsDir, line) {
	try {
		fs.mkdirSync(logsDir, { recursive: true });
		fs.appendFileSync(path.join(logsDir, "server.log"), `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never take the server down
	}
}

function fail(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

export function createServer({ home, webDir, port = 4377, host = "127.0.0.1", config = {}, now = () => new Date(), asidePath = null } = {}) {
	if (!home) throw fail("bad_input", "home is required");
	const cfg = { v: 1, port, publicBase: null, pcTailnetIps: [], owner: null, ...config };
	const dir = {
		data: path.join(home, "data"),
		inbox: path.join(home, "inbox"),
		proposals: path.join(home, "data", "proposals"),
		logs: path.join(home, "logs"),
	};
	const cli = `node "${toSlash(path.join(home, "app", "bin", "vb.mjs"))}"`;
	const store = createStore({ dataDir: dir.data, inboxDir: dir.inbox, now });
	const targets = readTargets(webDir);
	const version = readVersion();
	const aside = asidePath ?? asideExe();
	const lastSeen = new Map();
	const identityCache = new Map();
	let actualPort = port;

	const url = (id) => `${cfg.publicBase || `http://127.0.0.1:${actualPort}`}/p/${id}`;
	const nowMs = () => now().getTime();

	const sendJson = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(text);
	};

	const sendFile = (res, file, headers = {}) => {
		let bytes;
		try {
			bytes = fs.readFileSync(file);
		} catch {
			sendJson(res, 404, { error: "not_found" });
			return;
		}
		res.writeHead(200, { "content-type": contentType(file), ...headers });
		res.end(bytes);
	};

	const sendError = (res, error) => {
		const code = error && error.code;
		if (code === "not_found") return sendJson(res, 404, { error: "not_found" });
		if (code === "closed") return sendJson(res, 409, { error: "closed" });
		if (code === "duplicate") return sendJson(res, 409, { error: "duplicate", id: error.id, url: url(error.id) });
		if (code === "bad_rev") return sendJson(res, 400, { error: "bad_rev" });
		if (code === "bad_input") return sendJson(res, 400, { error: "bad_input" });
		if (code === "too_long") return sendJson(res, 413, { error: "too_long" });
		appendLog(dir.logs, `error: ${error && error.stack ? error.stack : error}`);
		return sendJson(res, 500, { error: "internal" });
	};

	const hasAccess = (access, level) => ALLOW[level].includes(access);

	function guard(res, access, level) {
		if (hasAccess(access, level)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function decodeOnce(value) {
		try {
			return decodeURIComponent(value);
		} catch {
			throw fail("bad_input", `bad path encoding: ${value}`);
		}
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			let tooLong = false;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > BODY_LIMIT) tooLong = true;
				else chunks.push(chunk);
			});
			req.on("end", () => (tooLong ? reject(fail("too_long", "body too large")) : resolve(Buffer.concat(chunks))));
			req.on("error", reject);
		});
	}

	async function readJsonBody(req) {
		const raw = await readBody(req);
		try {
			const parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			throw fail("bad_input", "body must be json");
		}
	}

	function proposalDir(id) {
		return path.join(dir.proposals, id);
	}

	function clientOf(headers) {
		const forwarded = headers["x-forwarded-for"];
		const first = forwarded === undefined ? null : String(forwarded).split(",")[0].trim();
		return first || "127.0.0.1";
	}

	function feedbackBody(access, req) {
		return {
			via: access,
			client: clientOf(req.headers),
			ua: String(req.headers["user-agent"] || "").slice(0, 200),
		};
	}

	function serveStatic(res, file) {
		sendFile(res, file);
	}

	async function handleGet(res, rawPath, query, access) {
		const parts = rawPath.split("/");

		if (rawPath === "/" || rawPath === "") {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "inbox.html"));
		}
		if (parts[1] === "p" && parts.length === 3) {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "proposal.html"));
		}
		if (parts[1] === "web" && parts.length === 3) {
			if (!guard(res, access, "read")) return;
			const name = decodeOnce(parts[2]);
			if (name.includes("/") || name.includes("\\") || name.includes(":") || INVALID_SEGMENT.test(name)) {
				return sendJson(res, 403, { error: "forbidden" });
			}
			return sendFile(res, path.join(webDir, name));
		}
		if (parts[1] === "files" && parts.length >= 5) {
			if (!guard(res, access, "read")) return;
			return handleFileGet(res, parts);
		}
		if (parts[1] === "api") {
			if (parts[2] === "health" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				return sendJson(res, 200, { ok: true, name: NAME, version, pid: process.pid, port: actualPort });
			}
			if (parts[2] === "caps" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				const open = ALLOW.open.includes(access);
				const visible = targets.filter((target) => target.where === "any" || (target.where === "pc" && open));
				return sendJson(res, 200, { access, open, targets: visible });
			}
			if (parts[2] === "proposals" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				const status = query.get("status") || "open";
				const items = store
					.list({ product: query.get("product"), feature: query.get("feature"), status })
					.map((summary) => ({ ...summary, url: url(summary.id) }));
				const counts = { mine: 0, theirs: 0, closed: 0 };
				for (const summary of store.list({ status: "all" })) counts[summary.status]++;
				return sendJson(res, 200, { items, facets: store.facets(), counts });
			}
			if (parts[2] === "here" && parts.length === 3) {
				if (!guard(res, access, "session")) return;
				return handleHere(res, query);
			}
			if (parts[2] === "p" && parts.length === 4) {
				if (!guard(res, access, "read")) return;
				const id = decodeOnce(parts[3]);
				const since = Number.parseInt(query.get("since") || "0", 10) || 0;
				const data = store.get(id, { since });
				return sendJson(res, 200, { ...data, url: url(id) });
			}
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	function handleFileGet(res, parts) {
		const id = decodeOnce(parts[2]);
		const kind = parts[3];
		if (kind !== "revs" && kind !== "crops") return sendJson(res, 404, { error: "not_found" });
		if (kind === "revs" && parts.length < 6) return sendJson(res, 404, { error: "not_found" });
		try {
			store.get(id);
		} catch (error) {
			return sendError(res, error);
		}
		const raw = parts.slice(4).join("/");
		let decoded;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			return sendJson(res, 400, { error: "bad_input" });
		}
		const segments = decoded.split("/");
		if (segments.some((segment) => INVALID_SEGMENT.test(segment) || segment.includes("\\") || segment.includes(":"))) {
			return sendJson(res, 403, { error: "forbidden" });
		}
		const base = path.join(proposalDir(id), kind);
		const abs = path.resolve(base, decoded);
		if (abs !== base && !abs.startsWith(base + path.sep)) {
			return sendJson(res, 403, { error: "forbidden" });
		}
		const headers = kind === "revs" ? { "cache-control": "public, max-age=31536000, immutable" } : {};
		return sendFile(res, abs, headers);
	}

	async function handleHere(res, query) {
		const cwd = query.get("cwd");
		if (!cwd) return sendJson(res, 400, { error: "bad_input" });
		const session = query.get("session");
		const start = query.get("start") === "1";
		if (session) lastSeen.set(session, nowMs());
		const identity = await cachedIdentity(cwd);
		const work = store.forWorktree({ worktree: identity.feature.worktree, featureKey: identity.feature.key });
		const pending = work.pending.map((summary) => {
			const events = store.get(summary.id).events;
			const feedback = [...events].reverse().find((event) => event.type === "feedback") || null;
			return {
				...summary,
				url: url(summary.id),
				latest: feedback ? { seq: feedback.seq, delivery: feedback.delivery } : null,
			};
		});
		const noticed = pending.filter((item) => {
			if (start && item.owner === session) return true;
			return item.owner !== session && !isLive(item.owner);
		});
		return sendJson(res, 200, {
			product: identity.product,
			feature: identity.feature,
			mine: work.mine,
			theirs: work.theirs,
			pending,
			notice: pendingNotice(noticed, cli),
			noticeKeys: noticed.map((item) => `${item.id}:${item.latest ? item.latest.seq : 0}`),
			footer: footerText({ mine: work.mine, theirs: work.theirs }),
		});
	}

	function cachedIdentity(cwd) {
		const key = normPath(cwd);
		const at = nowMs();
		const hit = identityCache.get(key);
		if (hit && at - hit.at < IDENTITY_TTL_MS) return hit.promise;
		const promise = identityFor(cwd);
		identityCache.set(key, { at, promise });
		return promise;
	}

	function isLive(owner) {
		if (owner == null) return false;
		const seen = lastSeen.get(owner);
		return seen !== undefined && nowMs() - seen <= LIVE_WINDOW_MS;
	}

	async function handlePost(res, req, rawPath, access) {
		if (!postGuard(req.headers)) {
			sendJson(res, 403, { error: "forbidden" });
			return;
		}
		const parts = rawPath.split("/");
		const body = await readJsonBody(req);

		if (parts[1] === "api" && parts[2] === "open" && parts.length === 3) {
			if (!guard(res, access, "open")) return;
			return handleOpen(res, body, access);
		}
		if (parts[1] === "api" && parts[2] === "proposals" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			return handleCreate(res, body);
		}
		if (parts[1] === "api" && parts[2] === "bye" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			if (body.session) lastSeen.delete(body.session);
			return sendJson(res, 200, { ok: true });
		}
		if (parts[1] === "api" && parts[2] === "shutdown" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			sendJson(res, 200, { ok: true });
			close().then(() => process.exit(0));
			return;
		}
		if (parts[1] === "api" && parts[2] === "p" && parts.length === 5) {
			const id = decodeOnce(parts[3]);
			const action = parts[4];
			if (action === "feedback") {
				if (!guard(res, access, "feedback")) return;
				return handleFeedback(res, req, id, body, access);
			}
			if (action === "dismiss") {
				if (!guard(res, access, "feedback")) return;
				const summary = store.close(id, { summary: body.summary || "검토함에서 닫음", by: "me", session: null });
				return sendJson(res, 200, { ok: true, status: summary.status });
			}
			if (action === "revise") {
				if (!guard(res, access, "session")) return;
				return handleRevise(res, id, body);
			}
			if (action === "reply") {
				if (!guard(res, access, "session")) return;
				const summary = store.reply(id, { text: body.text, session: body.session ?? null });
				return sendJson(res, 200, { summary });
			}
			if (action === "close") {
				if (!guard(res, access, "session")) return;
				const summary = store.close(id, { summary: body.summary ?? null, by: "session", session: body.session ?? null });
				return sendJson(res, 200, { summary });
			}
			return sendJson(res, 404, { error: "not_found" });
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	function handleCreate(res, body) {
		let identity = body.identity && typeof body.identity === "object" ? body.identity : null;
		if (!identity) {
			if (!body.cwd) return sendJson(res, 400, { error: "bad_input" });
			return identityFor(body.cwd).then((computed) => createWith(res, body, computed));
		}
		return createWith(res, body, identity);
	}

	function createWith(res, body, identity) {
		const validated = validateBoard(body.srcDir);
		if (!validated.ok) return sendJson(res, 400, { error: "invalid_board", details: validated.errors });
		const title = (typeof body.title === "string" ? body.title.trim() : "") || validated.board.title;
		const { summary, existing } = store.create({
			identity,
			title,
			srcDir: body.srcDir,
			files: validated.files,
			note: body.note ?? null,
			force: body.force === true,
		});
		return sendJson(res, 200, { summary, url: url(summary.id), existing: existing === true });
	}

	function handleRevise(res, id, body) {
		const validated = validateBoard(body.srcDir);
		if (!validated.ok) return sendJson(res, 400, { error: "invalid_board", details: validated.errors });
		const summary = store.revise(id, {
			srcDir: body.srcDir,
			files: validated.files,
			note: body.note ?? null,
			session: body.session ?? null,
		});
		return sendJson(res, 200, { summary, url: url(summary.id) });
	}

	function handleFeedback(res, req, id, body, access) {
		const result = store.feedback(id, {
			rev: body.rev,
			verdict: body.verdict,
			answers: body.answers,
			comment: body.comment ?? null,
			marks: body.marks ?? [],
			...feedbackBody(access, req),
		});
		const { summary, event, owner } = result;
		if (owner != null) {
			const board = store.board(id, event.rev);
			const text = feedbackMessage({ summary, board, event, url: url(id), cropDir: proposalDir(id), cli });
			const payload = {
				v: 1,
				proposalId: id,
				seq: event.seq,
				title: summary.title,
				url: url(id),
				approved: event.verdict === "approve",
				text,
			};
			try {
				store.writeInbox(owner, payload);
			} catch (error) {
				try {
					store.writeInbox(owner, payload);
				} catch (again) {
					appendLog(dir.logs, `inbox write failed: ${again && again.stack ? again.stack : again}`);
					return sendJson(res, 200, { ok: true, seq: event.seq, status: summary.status, routed: owner, delivery: "none" });
				}
			}
		}
		return sendJson(res, 200, {
			ok: true,
			seq: event.seq,
			status: summary.status,
			routed: owner,
			delivery: owner == null ? "none" : "pending",
		});
	}

	function handleOpen(res, body, access) {
		const target = targets.find((entry) => entry.id === body.target);
		if (!target) return sendJson(res, 400, { error: "bad_input" });
		const open = ALLOW.open.includes(access);
		if (target.where === "pc" && !open) return sendJson(res, 403, { error: "forbidden" });
		let boardUrl = null;
		let urlValue = null;
		if (target.copy) {
			urlValue = null;
		} else if (body.useHome && target.home) {
			urlValue = target.home;
			boardUrl = body.proposalId != null ? url(body.proposalId) : null;
		} else {
			boardUrl = body.proposalId != null ? url(body.proposalId) : null;
			urlValue = String(target.url || "")
				.replace(/\{q\}/g, encodeURIComponent(body.q == null ? "" : String(body.q)))
				.replace(/\{board\}/g, boardUrl == null ? "" : boardUrl);
		}
		if (urlValue != null && urlValue.length > URL_LIMIT) return sendJson(res, 413, { error: "too_long" });

		let cmd;
		if (target.id === "aside") {
			cmd = [aside, "--single-argument", urlValue ?? (boardUrl ?? "")];
		} else if (urlValue == null) {
			cmd = [];
		} else {
			cmd = ["rundll32", "url.dll,FileProtocolHandler", urlValue];
		}
		if (body.dry === true) return sendJson(res, 200, { ok: true, dry: true, cmd });
		if (target.id === "aside" && !fs.existsSync(cmd[0])) {
			appendLog(dir.logs, `open failed: aside not installed at ${cmd[0]}`);
			return sendJson(res, 404, { error: "not_installed" });
		}
		if (cmd.length) {
			try {
				const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
				child.on("error", (error) => appendLog(dir.logs, `open failed: ${error.message}`));
				child.unref?.();
			} catch (error) {
				appendLog(dir.logs, `open failed: ${error.message}`);
			}
		}
		return sendJson(res, 200, { ok: true, cmd });
	}

	async function handle(req, res) {
		const raw = req.url || "/";
		const qIndex = raw.indexOf("?");
		const rawPath = qIndex === -1 ? raw : raw.slice(0, qIndex);
		const query = new URLSearchParams(qIndex === -1 ? "" : raw.slice(qIndex + 1));
		const access = classify({
			remoteAddress: req.socket.remoteAddress,
			headers: req.headers,
			pcIps: cfg.pcTailnetIps,
			owner: cfg.owner,
		});
		if (req.method === "GET" || req.method === "HEAD") return handleGet(res, rawPath, query, access);
		if (req.method === "POST") return handlePost(res, req, rawPath, access);
		return sendJson(res, 405, { error: "method" });
	}

	const httpServer = http.createServer((req, res) => {
		handle(req, res).catch((error) => sendError(res, error));
	});

	function listen() {
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				httpServer.removeListener("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				httpServer.removeListener("error", onError);
				actualPort = httpServer.address().port;
				writeServerJson(path.join(home, "server.json"), dir.logs, actualPort, version);
				resolve({ port: actualPort });
			};
			httpServer.once("error", onError);
			httpServer.once("listening", onListening);
			httpServer.listen(port, host);
		});
	}

	function close() {
		return new Promise((resolve) => {
			if (!httpServer.listening) {
				resolve();
				return;
			}
			httpServer.close(() => resolve());
		});
	}

	return { listen, close, store };
}

async function probeHealth(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!response.ok) return false;
		const body = await response.json();
		return body && body.name === NAME;
	} catch {
		return false;
	}
}

function writeServerJson(file, logsDir, port, version) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ v: 1, name: NAME, port, pid: process.pid, started: new Date().toISOString(), version }),
		);
	} catch (error) {
		appendLog(logsDir, `could not write server.json: ${error.message}`);
	}
}

async function main() {
	const config = readConfig();
	const l = layout();
	const wanted = config.port ?? 4377;
	const server = createServer({
		home: l.home,
		webDir: path.join(REPO_ROOT, "web"),
		port: wanted,
		config,
	});
	try {
		await server.listen();
	} catch (error) {
		if (error && error.code === "EADDRINUSE") {
			if (await probeHealth(wanted)) process.exit(0);
			appendLog(l.logs, `port ${wanted} is held by another process`);
			process.exit(3);
		}
		appendLog(l.logs, `listen failed: ${error && error.message}`);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
