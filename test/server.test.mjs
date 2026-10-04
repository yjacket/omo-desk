import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { identityFor } from "../src/identity.mjs";
import { safeSegment } from "../src/paths.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(REPO, "web");
const toSlash = (value) => String(value).replace(/\\/g, "/");

function board() {
	return {
		title: "테스트 보드",
		sections: [
			{
				title: "화면",
				cards: [{ title: "로그인", frames: [["로그인 화면", "screen.svg"]] }],
			},
		],
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

function makeBoard(home, name = "proto") {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board()));
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	fs.writeFileSync(path.join(dir, "screen.mmd"), "flowchart TD\n\tA-->B\n");
	return dir;
}

async function withServer(t, options = {}) {
	const tmp = makeTmpHome("vb-srv-");
	const server = createServer({
		home: tmp.home,
		webDir: options.webDir || WEB,
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: ["100.64.0.9"], ...(options.config || {}) },
		...(options.now ? { now: options.now } : {}),
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		tmp.cleanup();
	});
	return { home: tmp.home, server, port, base: `http://127.0.0.1:${port}` };
}

function postJson(base, p, body, headers = {}) {
	return fetch(base + p, {
		method: "POST",
		headers: { "content-type": "application/json", "x-vb": "1", ...headers },
		body: JSON.stringify(body),
	});
}

function rawGet(port, rawPath, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function submit(ctx, { srcDir, session = "s1", title = "기획안", extra = {} } = {}) {
	const identity = await identityFor(srcDir, {});
	const body = {
		cwd: srcDir,
		identity: { ...identity, session: { id: session, file: null } },
		title,
		srcDir,
		...extra,
	};
	const res = await postJson(ctx.base, "/api/proposals", body);
	return { res, body: await res.json() };
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

test("health reports the service with no-store", async (t) => {
	const ctx = await withServer(t);
	const res = await fetch(`${ctx.base}/api/health`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	const body = await res.json();
	assert.equal(body.ok, true);
	assert.equal(body.name, "omo-visual-board");
	assert.equal(body.port, ctx.port);
	assert.equal(typeof body.version, "string");
	assert.ok(body.pid > 0);
});

test("submit returns summary and url", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { res, body } = await submit(ctx, { srcDir: dir, title: "로그인 개편" });
	assert.equal(res.status, 200);
	assert.equal(body.existing, false);
	assert.equal(body.summary.title, "로그인 개편");
	assert.equal(body.summary.status, "mine");
	assert.equal(body.summary.rev, 1);
	assert.equal(body.url, `${ctx.base}/p/${body.summary.id}`);
});

test("invalid board is rejected with details", async (t) => {
	const ctx = await withServer(t);
	const dir = path.join(ctx.home, "broken");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), "{ not json");
	const res = await postJson(ctx.base, "/api/proposals", { cwd: dir, srcDir: dir, title: "깨짐" });
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.equal(body.error, "invalid_board");
	assert.ok(Array.isArray(body.details) && body.details.length > 0);
});

test("feedback routes to the owner, writes the inbox, stores client and ua", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-1", title: "의견" });
	const id = sub.summary.id;

	const res = await postJson(
		ctx.base,
		`/api/p/${id}/feedback`,
		{ rev: 1, verdict: "change", comment: "고쳐 주세요" },
		{ "user-agent": "vb-test/1.0" },
	);
	assert.equal(res.status, 200);
	const fb = await res.json();
	assert.equal(fb.ok, true);
	assert.equal(fb.routed, "owner-1");
	assert.equal(fb.delivery, "pending");
	assert.equal(fb.status, "theirs");
	assert.equal(typeof fb.seq, "number");

	const inbox = path.join(ctx.home, "inbox", safeSegment("owner-1"), `${id}-${String(fb.seq).padStart(6, "0")}.json`);
	assert.ok(fs.existsSync(inbox), "inbox file exists");
	const payload = JSON.parse(fs.readFileSync(inbox, "utf8"));
	assert.equal(payload.proposalId, id);
	assert.match(payload.text, /\[visual-board\] 의견이 왔습니다/);
	assert.ok(payload.text.includes(`node "` + toSlash(path.join(ctx.home, "app", "bin", "vb.mjs")) + `" show ${id}`));

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.client, "127.0.0.1");
	assert.equal(event.ua, "vb-test/1.0");
	assert.equal(event.delivery, "pending");
});

test("feedback with an unknown frame label is bad_input", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-2" });
	const res = await postJson(ctx.base, `/api/p/${sub.summary.id}/feedback`, {
		rev: 1,
		verdict: "change",
		marks: [{ frame: "없는 라벨", x: 0, y: 0, w: 0.2, h: 0.2 }],
	});
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "bad_input");
});

test("a .mmd revision file is served as plain text", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await fetch(`${ctx.base}/files/${sub.summary.id}/revs/1/screen.mmd`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
	assert.match(await res.text(), /flowchart/);
});

test("bad percent-encoding in a file path is bad_input", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await rawGet(ctx.port, `/files/${sub.summary.id}/revs/1/%E0%A4%A`);
	assert.equal(res.status, 400);
});

test("path traversal in a file route is forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const id = sub.summary.id;
	const plain = await rawGet(ctx.port, `/files/${id}/revs/1/../../proposal.json`);
	assert.equal(plain.status, 403);
	const encoded = await rawGet(ctx.port, `/files/${id}/revs/1/%2e%2e/%2e%2e/proposal.json`);
	assert.equal(encoded.status, 403);
});

test("revision files are immutable and svg is typed", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await fetch(`${ctx.base}/files/${sub.summary.id}/revs/1/screen.svg`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/svg+xml");
	assert.match(res.headers.get("cache-control"), /immutable/);
});

test("list and facets describe submitted proposals", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, title: "목록" });
	const res = await fetch(`${ctx.base}/api/proposals`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.items.length, 1);
	assert.equal(body.items[0].id, sub.summary.id);
	assert.equal(body.items[0].url, `${ctx.base}/p/${sub.summary.id}`);
	assert.ok(Array.isArray(body.facets) && body.facets.length === 1);
	assert.equal(body.facets[0].count, 1);
});

test("proposal counts stay overall across filters", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	await submit(ctx, { srcDir: dir, title: "내 차례" });
	const theirs = await submit(ctx, { srcDir: dir, title: "상대 차례" });
	const closed = await submit(ctx, { srcDir: dir, title: "닫힘" });
	await postJson(ctx.base, `/api/p/${theirs.body.summary.id}/feedback`, { rev: 1, verdict: "change", comment: "수정" });
	await postJson(ctx.base, `/api/p/${closed.body.summary.id}/close`, { summary: "완료" });
	for (const status of ["open", "mine", "theirs", "closed", "all"]) {
		const res = await fetch(`${ctx.base}/api/proposals?status=${status}`);
		assert.equal(res.status, 200, status);
		const body = await res.json();
		assert.deepEqual(body.counts, { mine: 1, theirs: 1, closed: 1 }, status);
	}
});

test("tailnet feedback is accepted but tailnet session writes are forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-3" });
	const headers = { "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" };
	const fb = await postJson(ctx.base, `/api/p/${sub.summary.id}/feedback`, { rev: 1, verdict: "approve" }, headers);
	assert.equal(fb.status, 200);
	const write = await postJson(ctx.base, "/api/proposals", { cwd: dir, srcDir: dir, title: "tailnet" }, headers);
	assert.equal(write.status, 403);
	assert.equal((await write.json()).error, "forbidden");
});

test("the tailscale funnel header is rejected everywhere", async (t) => {
	const ctx = await withServer(t);
	const res = await fetch(`${ctx.base}/api/health`, { headers: { "tailscale-funnel-request": "1" } });
	assert.equal(res.status, 403);
});

test("POST without the x-vb guard is forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const res = await fetch(`${ctx.base}/api/proposals`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: dir, srcDir: dir, title: "no guard" }),
	});
	assert.equal(res.status, 403);
});

test("reply, revise and close move the status, then feedback is closed", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-4" });
	const id = sub.summary.id;

	const revised = await postJson(ctx.base, `/api/p/${id}/revise`, { srcDir: makeBoard(ctx.home, "proto-r2"), session: { id: "owner-4" } });
	assert.equal(revised.status, 200);
	const revisedBody = await revised.json();
	assert.equal(revisedBody.summary.rev, 2);
	assert.equal(revisedBody.summary.status, "mine");
	assert.equal(revisedBody.url, `${ctx.base}/p/${id}`);

	const replied = await postJson(ctx.base, `/api/p/${id}/reply`, { text: "확인했습니다", session: { id: "owner-4" } });
	assert.equal(replied.status, 200);
	assert.equal((await replied.json()).summary.status, "mine");

	const closed = await postJson(ctx.base, `/api/p/${id}/close`, { summary: "완료", session: { id: "owner-4" } });
	assert.equal(closed.status, 200);
	assert.equal((await closed.json()).summary.status, "closed");

	const after = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 2, verdict: "approve" });
	assert.equal(after.status, 409);
	assert.equal((await after.json()).error, "closed");
});

test("dismiss closes a proposal from the inbox", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-5" });
	const id = sub.summary.id;
	await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "approve" });
	const res = await postJson(ctx.base, `/api/p/${id}/dismiss`, {});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, status: "closed" });
});

test("an identical resubmit is idempotent, changed content is a duplicate", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const first = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(first.body.existing, false);

	const again = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(again.res.status, 200);
	assert.equal(again.body.existing, true);
	assert.equal(again.body.summary.id, first.body.summary.id);

	const parsed = board();
	parsed.lead = "바뀐 내용";
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(parsed));
	const changed = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(changed.res.status, 409);
	const changedBody = await changed.body;
	assert.equal(changedBody.error, "duplicate");
	assert.equal(changedBody.id, first.body.summary.id);
	assert.equal(changedBody.url, `${ctx.base}/p/${first.body.summary.id}`);
});

test("peer access: pc classification follows x-forwarded-for", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-6" });
	const res = await postJson(
		ctx.base,
		`/api/p/${sub.summary.id}/feedback`,
		{ rev: 1, verdict: "change", comment: "pc" },
		{ "x-forwarded-for": "100.64.0.9" },
	);
	assert.equal(res.status, 200);
	const detail = await (await fetch(`${ctx.base}/api/p/${sub.summary.id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.via, "pc");
	assert.equal(event.client, "100.64.0.9");
});

test("configured owner rejects another tailscale login", async (t) => {
	const ctx = await withServer(t, { config: { owner: "me@x" } });
	const dir = makeBoard(ctx.home);
	const res = await postJson(
		ctx.base,
		"/api/proposals",
		{ cwd: dir, srcDir: dir, title: "남의 로그인" },
		{ "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "other@x" },
	);
	assert.equal(res.status, 403);
});

test("caps hides pc targets from the tailnet", async (t) => {
	const ctx = await withServer(t);
	const tailnet = await (
		await fetch(`${ctx.base}/api/caps`, { headers: { "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" } })
	).json();
	assert.equal(tailnet.access, "tailnet");
	assert.equal(tailnet.open, false);
	assert.ok(tailnet.targets.length > 0);
	assert.ok(tailnet.targets.every((target) => target.where !== "pc"));

	const local = await (await fetch(`${ctx.base}/api/caps`)).json();
	assert.equal(local.access, "local");
	assert.equal(local.open, true);
	assert.ok(local.targets.some((target) => target.where === "pc"));
});

test("open dry-runs every target and forbids the tailnet", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const targets = JSON.parse(fs.readFileSync(path.join(WEB, "targets.json"), "utf8"));
	for (const target of targets) {
		const res = await postJson(ctx.base, "/api/open", { target: target.id, q: "hello", proposalId: sub.summary.id, dry: true });
		assert.equal(res.status, 200, target.id);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.dry, true);
		assert.ok(Array.isArray(body.cmd), target.id);
		if (target.id === "aside") assert.equal(body.cmd[1], "--single-argument");
		else if (target.copy) assert.equal(body.cmd.length, 0);
		else assert.equal(body.cmd[0], "rundll32");
	}
	const denied = await postJson(
		ctx.base,
		"/api/open",
		{ target: "chatgpt", q: "hello", dry: true },
		{ "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" },
	);
	assert.equal(denied.status, 403);
});

test("a body over 30 MiB is too long", async (t) => {
	const ctx = await withServer(t);
	const big = `"${"x".repeat(30 * 1024 * 1024 + 1)}"`;
	const res = await fetch(`${ctx.base}/api/proposals`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-vb": "1" },
		body: big,
	});
	assert.equal(res.status, 413);
});

test("static pages come from webDir", async (t) => {
	const tmp = makeTmpHome("vb-web-");
	t.after(() => tmp.cleanup());
	const dir = path.join(tmp.home, "web");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "inbox.html"), "<h1>inbox</h1>");
	fs.writeFileSync(path.join(dir, "proposal.html"), "<h1>proposal</h1>");
	fs.writeFileSync(path.join(dir, "app.js"), "console.log(1);");
	fs.copyFileSync(path.join(WEB, "targets.json"), path.join(dir, "targets.json"));

	const ctx = await withServer(t, { webDir: dir });
	const inbox = await fetch(`${ctx.base}/`);
	assert.equal(inbox.status, 200);
	assert.equal(inbox.headers.get("content-type"), "text/html; charset=utf-8");
	assert.match(await inbox.text(), /inbox/);

	const proposal = await fetch(`${ctx.base}/p/whatever`);
	assert.equal(proposal.status, 200);
	assert.match(await proposal.text(), /proposal/);

	const js = await fetch(`${ctx.base}/web/app.js`);
	assert.equal(js.status, 200);
	assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");

	const targets = await fetch(`${ctx.base}/web/targets.json`);
	assert.equal(targets.status, 200);
	assert.equal(targets.headers.get("content-type"), "application/json; charset=utf-8");
});

test("here counts only the current worktree, across clones and branches", async (t) => {
	const ctx = await withServer(t);
	const origin = path.join(ctx.home, "origin.git");
	git(ctx.home, "init", "--bare", origin);
	git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

	const cloneA = path.join(ctx.home, "clone-a");
	git(ctx.home, "clone", toSlash(origin), "clone-a");
	fs.writeFileSync(path.join(cloneA, "seed.txt"), "seed\n");
	git(cloneA, "add", "-A");
	git(cloneA, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
	git(cloneA, "push", "origin", "main");
	const cloneB = path.join(ctx.home, "clone-b");
	git(ctx.home, "clone", toSlash(origin), "clone-b");

	const dirA = makeBoard(ctx.home, path.join("clone-a", "board"));
	const dirB = makeBoard(ctx.home, path.join("clone-b", "board"));
	const a = await submit(ctx, { srcDir: dirA, session: "sA", title: "A 안" });
	const b = await submit(ctx, { srcDir: dirB, session: "sB", title: "B 안" });
	assert.notEqual(a.body.summary.id, b.body.summary.id);

	const hereA = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirA)}&session=sA`)).json();
	assert.equal(hereA.mine, 1);
	assert.equal(hereA.theirs, 0);
	assert.deepEqual(hereA.pending, []);
	assert.equal(hereA.notice, null);
	assert.equal(hereA.footer, "보드 내 차례 1 · 세션 차례 0");

	const hereB = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirB)}&session=sB`)).json();
	assert.equal(hereB.mine, 1);
	assert.equal(hereB.theirs, 0);

	git(cloneA, "checkout", "-b", "b");
	const hereBranch = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirA)}&session=sA`)).json();
	assert.equal(hereBranch.mine, 1);
	assert.equal(hereBranch.pending.length, 0);
});

test("here notice follows owner liveness, not delivery", async (t) => {
	let clock = Date.parse("2026-01-01T00:00:00Z");
	const now = () => new Date(clock);
	const ctx = await withServer(t, { now });
	const dir = makeBoard(ctx.home, "live");
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-live", title: "라이브" });
	const id = sub.summary.id;
	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "봐 주세요" }, { "x-forwarded-for": "100.64.0.9" });
	const fbBody = await fb.json();
	assert.equal(fbBody.routed, "owner-live");
	const inbox = path.join(ctx.home, "inbox", safeSegment("owner-live"), `${id}-${String(fbBody.seq).padStart(6, "0")}.json`);
	fs.rmSync(inbox);

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.delivery, "delivered");

	const hereUrl = (session, extra = "") => `${ctx.base}/api/here?cwd=${encodeURIComponent(dir)}&session=${session}${extra}`;

	let mine = await (await fetch(hereUrl("owner-live"))).json();
	assert.equal(mine.mine, 0);
	assert.equal(mine.theirs, 1);
	assert.equal(mine.pending.length, 1);
	assert.equal(mine.pending[0].latest.seq, fbBody.seq);
	assert.equal(mine.pending[0].latest.delivery, "delivered");
	assert.equal(mine.notice, null);

	clock += 10_000;
	const recent = await (await fetch(hereUrl("other"))).json();
	assert.equal(recent.notice, null);
	assert.deepEqual(recent.noticeKeys, []);

	clock += 90_000;
	const stale = await (await fetch(hereUrl("other"))).json();
	assert.ok(stale.notice && stale.notice.includes(id));
	assert.deepEqual(stale.noticeKeys, [`${id}:${fbBody.seq}`]);

	const resumed = await (await fetch(hereUrl("owner-live", "&start=1"))).json();
	assert.ok(resumed.notice && resumed.notice.includes(id));

	const bye = await postJson(ctx.base, "/api/bye", { session: "owner-live" });
	assert.deepEqual(await bye.json(), { ok: true });
	const afterBye = await (await fetch(hereUrl("other"))).json();
	assert.ok(afterBye.notice && afterBye.notice.includes(id));
	assert.deepEqual(afterBye.noticeKeys, [`${id}:${fbBody.seq}`]);

	const seen = await (await fetch(hereUrl("fresh"))).json();
	assert.ok(seen.notice && seen.notice.includes(id));
});
