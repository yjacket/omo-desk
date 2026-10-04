/* Proposal page: board + marks + conversation + revisions. Served at /p/<id>, data from /api/p/<id>. */
(function () {
	"use strict";

	const POLL_MS = 3000;
	const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs";
	// htmlLabels must be false at the top level too: foreignObject labels taint the canvas and break crops.
	const MERMAID_CONFIG = {
		startOnLoad: false,
		htmlLabels: false,
		flowchart: { htmlLabels: false },
		securityLevel: "strict",
		suppressErrorRendering: true,
	};
	const MMD_PAD = 8;
	const CROP_PAD = 0.35;
	const MIN_MARK_PX = 8;
	const DEFAULT_HEADERS = { "content-type": "application/json", "x-vb": "1" };
	const EVENT_LABELS = { submitted: "제출", feedback: "내 의견", reply: "세션 답", revised: "고친 안", closed: "끝남" };
	const STATUS_LABELS = { mine: "내 차례", theirs: "세션 차례", closed: "끝남" };
	const VERDICT_TEXT = { approve: "이대로 진행", change: "고쳐 주세요" };
	const PROMPT_HEAD = [
		"나는 개발자다. 코딩 에이전트가 보여 준 검토 보드를 보고 있고, 잘 모르는 부분을 물어보고 결정하려 한다.",
		"먼저 각 질문의 선택지 차이를 쉽게 설명하고 추천과 이유를 말해 줘. 내가 정하면 보드에 붙일 결론을 3줄 이내로 정리해 줘.",
		"",
	];
	const PROMPT_LEAD = "\n\n[도식 원본 - 그림은 보드에 있고 여기는 글로 된 원본]";

	const $ = (id) => document.getElementById(id);
	const el = {
		chips: $("chips"),
		title: $("title"),
		lead: $("lead"),
		tabs: $("tabs"),
		loadError: $("loadError"),
		revBanner: $("revBanner"),
		revBannerText: $("revBannerText"),
		revBannerBtn: $("revBannerBtn"),
		closedBanner: $("closedBanner"),
		oldNote: $("oldNote"),
		sections: $("sections"),
		marksCard: $("marksCard"),
		marks: $("marks"),
		decideCard: $("decideCard"),
		side: $("side"),
		questions: $("questions"),
		commentWrap: $("commentWrap"),
		comment: $("comment"),
		sendRow: $("sendRow"),
		sendBtn: $("sendBtn"),
		approveBtn: $("approveBtn"),
		closeBtn: $("closeBtn"),
		status: $("status"),
		thread: $("thread"),
		fab: $("aiFab"),
		panel: $("aiPanel"),
		targets: $("aiTargets"),
		aiMsg: $("aiMsg"),
		stage: $("mmdStage"),
	};
	const theme = getComputedStyle(document.documentElement);
	const MARK_COLOR = theme.getPropertyValue("--mark").trim() || "#1463ff";
	const MARK_FILL = theme.getPropertyValue("--mark-fill").trim() || "rgba(20,99,255,0.10)";
	const MIN_DIAGRAM_PX = Number.parseFloat(theme.getPropertyValue("--frame-min")) || 150;

	const idMatch = location.pathname.match(/^\/p\/([^/]+)/);
	const id = idMatch ? decodeURIComponent(idMatch[1]) : null;

	const state = {
		id,
		summary: null,
		revs: [],
		events: [],
		lastSeq: 0,
		latest: 0,
		rev: 0,
		readOnly: false,
		closed: false,
		outcome: null,
		boards: {},
		marks: [],
		caps: null,
		prompt: null,
		mermaid: null,
		bannerRev: null,
	};
	window.__vb = state;

	let pollTimer = null;
	let mmdCounter = 0;

	// ---------- helpers ----------

	function esc(value) {
		return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	}

	function encPath(rel) {
		return String(rel).split("/").map(encodeURIComponent).join("/");
	}

	function frameUrl(rev, rel) {
		return `/files/${encodeURIComponent(id)}/revs/${rev}/${encPath(rel)}`;
	}

	function cropUrl(rel) {
		return `/files/${encodeURIComponent(id)}/${encPath(rel)}`;
	}

	function ago(iso) {
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return "";
		const minutes = Math.floor(Math.max(0, Date.now() - t) / 60000);
		if (minutes < 1) return "방금";
		if (minutes < 60) return `${minutes}분 전`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}시간 전`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}일 전`;
		const at = new Date(t);
		return `${at.getMonth() + 1}월 ${at.getDate()}일`;
	}

	// Session start from the latest event with a session log file (<utc stamp>_<id>.jsonl), as local "M월 D일 HH:mm"; "" without one.
	function sessionStart() {
		const latest = [...state.events].reverse().find((ev) => ev.session && ev.session.file);
		if (!latest) return "";
		const stamp = String(latest.session.file).split(/[\\/]/).pop().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
		if (!stamp) return "";
		const [, y, mo, d, h, mi, s, ms] = stamp.map(Number);
		const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
		const two = (n) => String(n).padStart(2, "0");
		return `${at.getMonth() + 1}월 ${at.getDate()}일 ${two(at.getHours())}:${two(at.getMinutes())}`;
	}

	async function api(path, options) {
		const res = await fetch(path, { cache: "no-store", ...options });
		if (!res.ok) {
			const error = new Error(`${res.status} ${path}`);
			error.status = res.status;
			throw error;
		}
		return res.json();
	}

	async function fetchText(url, { optional = false } = {}) {
		let res;
		try {
			res = await fetch(url);
		} catch (error) {
			if (optional) return "";
			throw error;
		}
		if (!res.ok) {
			if (optional) return "";
			throw new Error(`${res.status} ${url}`);
		}
		return res.text();
	}

	function setStatus(text) {
		el.status.textContent = text;
	}

	function canMark() {
		return !state.readOnly && !state.closed;
	}

	function visibleMarks() {
		return state.marks.filter((mark) => mark.rev === state.rev);
	}

	function anyChecked() {
		return Boolean(el.questions.querySelector("input:checked"));
	}

	// ---------- header, tabs, banners ----------

	function chip(key, value, extraClass) {
		return `<span class="chip${extraClass ? ` ${extraClass}` : ""}"><i>${esc(key)}</i><span title="${esc(value)}">${esc(value)}</span></span>`;
	}

	function renderHeader() {
		const s = state.summary;
		document.title = s.title;
		el.title.textContent = s.title;
		const chips = [chip("제품", s.product.name || s.product.key), chip("기능", s.feature.branch)];
		const started = sessionStart();
		if (started) chips.push(`<span class="chip">세션 ${esc(started)} 시작</span>`);
		chips.push(`<span class="chip status ${esc(s.status)}">${esc(STATUS_LABELS[s.status] || s.status)}</span>`);
		if (s.status === "theirs" && s.approved) chips.push('<span class="chip ok">진행 승인</span>');
		el.chips.innerHTML = chips.join("");
	}

	function renderTabs() {
		el.tabs.innerHTML = "";
		for (const r of state.revs) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "tab");
			button.setAttribute("aria-selected", String(r.n === state.rev));
			button.textContent = `${r.n}안`;
			button.addEventListener("click", () => selectRev(r.n));
			el.tabs.appendChild(button);
		}
	}

	function showRevBanner(n) {
		state.bannerRev = n;
		el.revBannerText.textContent = `새 안(${n}안)이 올라왔습니다.`;
		el.revBanner.hidden = false;
	}

	function hideRevBanner() {
		state.bannerRev = null;
		el.revBanner.hidden = true;
	}

	function updateMode() {
		document.body.classList.toggle("readonly", state.readOnly);
		document.body.classList.toggle("closed", state.closed);
		el.oldNote.hidden = !state.readOnly;
		el.closedBanner.hidden = !state.closed;
		if (state.closed) el.closedBanner.textContent = state.outcome ? `끝남: ${state.outcome}` : "끝남";

		const inputsOn = canMark();
		const marks = visibleMarks();
		const typed = el.comment.value.trim() !== "";
		const formHasContent = typed || marks.length > 0 || anyChecked();

		el.decideCard.hidden = state.closed && !formHasContent;
		for (const input of el.questions.querySelectorAll("input")) input.disabled = !inputsOn;
		el.commentWrap.hidden = !inputsOn && !(state.closed && typed);
		el.comment.disabled = !inputsOn;
		el.sendRow.hidden = !inputsOn;
		el.marksCard.hidden = !inputsOn && marks.length === 0;
		for (const node of el.marks.querySelectorAll("textarea,button")) node.disabled = !inputsOn;
	}

	// ---------- revisions and boards ----------

	async function loadBoard(rev) {
		if (state.boards[rev]) return state.boards[rev];
		let board;
		try {
			board = await api(frameUrl(rev, "board.json"));
		} catch (error) {
			console.error("board.json for revision", rev, error);
			board = { title: state.summary ? state.summary.title : "", sections: [], questions: [] };
		}
		state.boards[rev] = board;
		return board;
	}

	async function selectRev(wanted, { replace = true } = {}) {
		const n = state.revs.some((r) => r.n === wanted) ? wanted : state.latest;
		if (n === state.rev) return;
		state.rev = n;
		state.readOnly = n !== state.latest;
		if (replace) {
			const url = new URL(location.href);
			url.searchParams.set("rev", String(n));
			history.replaceState(null, "", url);
		}
		if (state.bannerRev === n) hideRevBanner();
		await loadBoard(n);
		if (state.rev !== n) return;
		renderTabs();
		renderDecide();
		renderMarks();
		updateMode();
		await renderBoard();
	}

	async function renderBoard() {
		const rev = state.rev;
		const board = state.boards[rev] || {};
		el.lead.textContent = board.lead || "";
		el.sections.innerHTML = "";
		const frames = [];
		const pending = [];
		for (const section of board.sections || []) {
			const group = document.createElement("section");
			group.className = "group";
			group.innerHTML = `<h2>${esc(section.title)}</h2>${section.desc ? `<p>${esc(section.desc)}</p>` : ""}`;
			for (const card of section.cards || []) {
				const node = document.createElement("div");
				node.className = "card";
				const badge = card.badge ? `<span class="badge${card.gray ? " gray" : ""}">${esc(card.badge)}</span>` : "";
				node.innerHTML =
					`<h3>${badge}${esc(card.title || "")}</h3>` +
					`<div class="frames ${esc(card.layout || "")}"></div>` +
					(card.note ? `<p class="note">${esc(card.note)}</p>` : "");
				const box = node.querySelector(".frames");
				for (const [label, rel] of card.frames || []) {
					const isMmd = /\.mmd$/i.test(rel);
					const wrap = document.createElement("div");
					wrap.className = `frame${card.diagram || isMmd ? " diagram" : ""}`;
					box.appendChild(wrap);
					frames.push({ section: section.title, label, rel });
					pending.push(isMmd ? mountMermaid(wrap, label, rev, rel) : mountImage(wrap, label, rev, rel));
				}
				group.appendChild(node);
			}
			el.sections.appendChild(group);
		}
		const sources = await Promise.all(pending);
		if (state.rev !== rev) return;
		state.prompt = buildPrompt(board, frames, sources);
	}

	function pillFor(label) {
		const pill = document.createElement("span");
		pill.className = "pill";
		pill.textContent = label;
		return pill;
	}

	function mountImage(wrap, label, rev, rel) {
		const img = new Image();
		img.alt = label;
		const canvas = document.createElement("canvas");
		wrap.append(img, canvas, pillFor(label));
		attach(wrap, label, img, canvas);
		img.src = frameUrl(rev, rel);
		if (/\.svg$/i.test(rel)) return fetchText(frameUrl(rev, rel.replace(/\.svg$/i, ".mmd")), { optional: true });
		return Promise.resolve("");
	}

	async function mountMermaid(wrap, label, rev, rel) {
		const pill = pillFor(label);
		wrap.appendChild(pill);
		let source = "";
		try {
			source = await fetchText(frameUrl(rev, rel));
			const rendered = await renderMermaid(source);
			if (!wrap.isConnected) return source;
			const img = new Image();
			img.alt = label;
			const canvas = document.createElement("canvas");
			wrap.insertBefore(img, pill);
			wrap.insertBefore(canvas, pill);
			attach(wrap, label, img, canvas);
			img.src = rendered;
		} catch (error) {
			console.error("mermaid frame", label, error);
			if (!wrap.isConnected) return source;
			wrap.classList.add("still", "plain");
			const note = document.createElement("p");
			note.className = "fallback";
			note.textContent = "그림을 그리지 못해 원문을 보여 줍니다.";
			const pre = document.createElement("pre");
			pre.textContent = source;
			wrap.insertBefore(note, pill);
			wrap.insertBefore(pre, pill);
		}
		return source;
	}

	function ensureMermaid() {
		if (!state.mermaid) {
			state.mermaid = import(MERMAID_URL).then((mod) => {
				const mermaid = mod.default || mod;
				mermaid.initialize(MERMAID_CONFIG);
				return mermaid;
			});
			state.mermaid.catch(() => {
				// a failed load is reported per frame; allow a retry on the next frame
				state.mermaid = null;
			});
		}
		return state.mermaid;
	}

	async function renderMermaid(source) {
		const mermaid = await ensureMermaid();
		mmdCounter += 1;
		const { svg } = await mermaid.render(`vb-mmd-${mmdCounter}`, source);
		el.stage.innerHTML = svg;
		const root = el.stage.querySelector("svg");
		if (!root) throw new Error("mermaid returned no svg");
		// Explicit viewBox/width/height from the real bbox: without them the last ER row is clipped and naturalWidth is 0.
		const box = root.getBBox();
		const width = Math.ceil(box.width + MMD_PAD * 2);
		const height = Math.ceil(box.height + MMD_PAD * 2);
		root.setAttribute("viewBox", `${box.x - MMD_PAD} ${box.y - MMD_PAD} ${width} ${height}`);
		root.setAttribute("width", String(width));
		root.setAttribute("height", String(height));
		root.removeAttribute("style");
		root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		const text = new XMLSerializer().serializeToString(root);
		el.stage.innerHTML = "";
		return URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
	}

	// ---------- marks ----------

	function drawMark(c, x, y, w, h, n, scale) {
		const s = scale || 1;
		const r = 11 * s;
		c.save();
		c.fillStyle = MARK_FILL;
		c.fillRect(x, y, w, h);
		c.setLineDash([]);
		c.lineWidth = 6 * s;
		c.strokeStyle = "rgba(255,255,255,0.95)";
		c.strokeRect(x, y, w, h);
		c.setLineDash([10 * s, 6 * s]);
		c.lineWidth = 3 * s;
		c.strokeStyle = MARK_COLOR;
		c.strokeRect(x, y, w, h);
		if (n) {
			c.setLineDash([]);
			c.beginPath();
			c.arc(x, y, r + 2 * s, 0, Math.PI * 2);
			c.fillStyle = "#fff";
			c.fill();
			c.beginPath();
			c.arc(x, y, r, 0, Math.PI * 2);
			c.fillStyle = MARK_COLOR;
			c.fill();
			c.fillStyle = "#fff";
			c.font = `bold ${Math.round(12 * s)}px sans-serif`;
			c.textAlign = "center";
			c.textBaseline = "middle";
			c.fillText(String(n), x, y + 0.5);
		}
		c.restore();
	}

	function attach(wrap, label, img, canvas) {
		const ctx = canvas.getContext("2d");
		const diagram = wrap.classList.contains("diagram");
		let start = null;
		let cur = null;
		function size() {
			if (diagram) {
				// Measure at fit width first; a diagram shorter than the frame minimum is shown at that height and scrolls sideways.
				wrap.classList.remove("wide");
				wrap.classList.toggle("wide", img.getBoundingClientRect().height < MIN_DIAGRAM_PX);
			}
			const r = img.getBoundingClientRect();
			const b = wrap.getBoundingClientRect();
			// The canvas sits in the frame's scrolled content, so its offset includes the frame's scroll position.
			canvas.style.left = `${r.left - b.left + wrap.scrollLeft}px`;
			canvas.style.top = `${r.top - b.top + wrap.scrollTop}px`;
			canvas.style.width = `${r.width}px`;
			canvas.style.height = `${r.height}px`;
			canvas.width = Math.round(r.width);
			canvas.height = Math.round(r.height);
			redraw();
		}
		function pos(e) {
			const b = canvas.getBoundingClientRect();
			return {
				x: Math.max(0, Math.min(canvas.width, e.clientX - b.left)),
				y: Math.max(0, Math.min(canvas.height, e.clientY - b.top)),
			};
		}
		function redraw() {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			visibleMarks().forEach((m, i) => {
				if (m.frame === label) drawMark(ctx, m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height, i + 1);
			});
			if (start && cur) {
				drawMark(ctx, Math.min(start.x, cur.x), Math.min(start.y, cur.y), Math.abs(cur.x - start.x), Math.abs(cur.y - start.y), 0);
			}
		}
		wrap._redraw = redraw;
		wrap._size = size;
		img.addEventListener("load", size);
		if (img.complete && img.naturalWidth) size();
		canvas.addEventListener("pointerdown", (e) => {
			if (!canMark()) return;
			if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
			start = pos(e);
			cur = start;
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!start) return;
			cur = pos(e);
			redraw();
		});
		canvas.addEventListener("pointerup", (e) => {
			if (!start) return;
			const end = pos(e);
			const x = Math.min(start.x, end.x);
			const y = Math.min(start.y, end.y);
			const w = Math.abs(end.x - start.x);
			const h = Math.abs(end.y - start.y);
			start = null;
			cur = null;
			if (w < MIN_MARK_PX || h < MIN_MARK_PX) {
				redraw();
				return;
			}
			state.marks.push({
				rev: state.rev,
				frame: label,
				x: x / canvas.width,
				y: y / canvas.height,
				w: w / canvas.width,
				h: h / canvas.height,
				comment: "",
				img,
			});
			redrawAll();
			renderMarks();
			updateMode();
		});
		canvas.addEventListener("pointercancel", () => {
			start = null;
			cur = null;
			redraw();
		});
	}

	function redrawAll() {
		for (const wrap of document.querySelectorAll(".frame")) if (wrap._redraw) wrap._redraw();
	}

	function resizeAll() {
		for (const wrap of document.querySelectorAll(".frame")) if (wrap._size) wrap._size();
	}

	function cropOf(mark, n) {
		const img = mark.img;
		const W = img.naturalWidth || img.width;
		const H = img.naturalHeight || img.height;
		if (!W || !H) return null;
		const sx = Math.max(0, (mark.x - mark.w * CROP_PAD) * W);
		const sy = Math.max(0, (mark.y - mark.h * CROP_PAD) * H);
		const sw = Math.min(W - sx, mark.w * (1 + 2 * CROP_PAD) * W);
		const sh = Math.min(H - sy, mark.h * (1 + 2 * CROP_PAD) * H);
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(sw));
		c.height = Math.max(1, Math.round(sh));
		const g = c.getContext("2d");
		g.fillStyle = "#fff";
		g.fillRect(0, 0, c.width, c.height);
		try {
			g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
			drawMark(g, mark.x * W - sx, mark.y * H - sy, mark.w * W, mark.h * H, n, Math.max(1, W / 1280));
			return c.toDataURL("image/png");
		} catch (error) {
			console.error("crop failed", mark.frame, error);
			return null;
		}
	}

	function renderMarks() {
		const list = visibleMarks();
		if (!list.length) {
			el.marks.innerHTML = '<p class="empty">아직 표시한 곳이 없습니다.</p>';
			return;
		}
		el.marks.innerHTML = "";
		list.forEach((mark, i) => {
			mark.crop = cropOf(mark, i + 1);
			const item = document.createElement("div");
			item.className = "mark";
			const picture = mark.crop ? `<img alt="표시 ${i + 1}" src="${mark.crop}">` : '<div class="nocrop"></div>';
			item.innerHTML =
				`${picture}<div><b><span class="num">${i + 1}</span>${esc(mark.frame)}</b>` +
				'<textarea placeholder="여기를 어떻게 바꾸면 좋을까요?"></textarea></div>' +
				'<button class="del" type="button">지우기</button>';
			const textarea = item.querySelector("textarea");
			textarea.value = mark.comment;
			textarea.addEventListener("input", () => {
				mark.comment = textarea.value;
			});
			item.querySelector(".del").addEventListener("click", () => {
				state.marks.splice(state.marks.indexOf(mark), 1);
				redrawAll();
				renderMarks();
				updateMode();
			});
			el.marks.appendChild(item);
		});
	}

	// ---------- questions and comment ----------

	function renderDecide() {
		const board = state.boards[state.rev] || {};
		el.side.hidden = !board.sideSession;
		el.side.textContent = board.sideSession || "";
		el.questions.innerHTML = "";
		for (const q of board.questions || []) {
			const node = document.createElement("div");
			node.className = "q";
			const options = (q.options || [])
				.map(
					(o) =>
						`<label><input type="radio" name="q_${esc(q.id)}" value="${esc(o.value)}"><span>${esc(o.label)}` +
						`${o.rec ? ' <span class="rec">추천</span>' : ""}</span>${o.why ? `<span class="why">${esc(o.why)}</span>` : ""}</label>`,
				)
				.join("");
			node.innerHTML = `<b>${esc(q.text)}</b>${q.help ? `<p class="qhelp">${esc(q.help)}</p>` : ""}<div class="opts">${options}</div>`;
			el.questions.appendChild(node);
		}
		el.comment.placeholder = board.commentPlaceholder || "전체 의견";
	}

	function clearForm() {
		state.marks = state.marks.filter((mark) => mark.rev !== state.rev);
		el.comment.value = "";
		for (const input of el.questions.querySelectorAll("input:checked")) input.checked = false;
		redrawAll();
		renderMarks();
	}

	// ---------- conversation ----------

	function answerLines(ev) {
		const board = state.boards[ev.rev] || {};
		const questions = board.questions || [];
		return Object.entries(ev.answers || {}).map(([qid, value]) => {
			const question = questions.find((q) => q.id === qid);
			const option = question && (question.options || []).find((o) => o.value === value);
			return `${question ? question.text : qid}: ${option ? option.label : value}`;
		});
	}

	function eventNode(ev) {
		const li = document.createElement("li");
		li.className = `ev ${esc(ev.type)}`;
		li.dataset.seq = String(ev.seq);
		let extra = "";
		let body = "";
		if (ev.type === "submitted" || ev.type === "revised") {
			extra = `<span class="tag">${ev.rev}안</span>`;
			body = ev.note ? esc(ev.note) : "";
		} else if (ev.type === "feedback") {
			extra = `<span class="tag">${ev.rev}안</span><span class="verdict ${esc(ev.verdict)}">${esc(VERDICT_TEXT[ev.verdict] || ev.verdict)}</span>`;
			const answers = answerLines(ev);
			if (answers.length) body += `<ul>${answers.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
			if (ev.comment) body += esc(ev.comment);
			const marks = ev.marks || [];
			if (marks.length) {
				body += `<div class="crops">${marks
					.map((mark) => {
						const caption = `<span class="num">${mark.n}</span>${esc(mark.frame)}${mark.comment ? ` ${esc(mark.comment)}` : ""}`;
						const picture = mark.crop ? `<img alt="표시 ${mark.n}" src="${cropUrl(mark.crop)}">` : "";
						return `<figure>${picture}<figcaption>${caption}</figcaption></figure>`;
					})
					.join("")}</div>`;
			}
		} else if (ev.type === "reply") {
			body = esc(ev.text || "");
		} else if (ev.type === "closed") {
			body = ev.summary ? esc(ev.summary) : "";
		}
		li.innerHTML =
			`<div class="evh"><span class="who">${esc(EVENT_LABELS[ev.type] || ev.type)}</span>${extra}` +
			`<span class="when" title="${esc(ev.at || "")}">${esc(ago(ev.at))}</span></div><div class="evb">${body}</div>`;
		return li;
	}

	function renderThread() {
		el.thread.innerHTML = "";
		for (const ev of state.events) el.thread.appendChild(eventNode(ev));
	}

	function appendEvents(list) {
		for (const ev of list) el.thread.appendChild(eventNode(ev));
	}

	// ---------- data flow ----------

	function absorb(data) {
		state.summary = data.summary;
		state.revs = data.revs;
		state.latest = data.summary.rev;
		const fresh = [];
		for (const ev of data.events) {
			if (ev.seq <= state.lastSeq) continue;
			state.events.push(ev);
			state.lastSeq = ev.seq;
			fresh.push(ev);
		}
		return fresh;
	}

	function applyFresh(fresh) {
		appendEvents(fresh);
		for (const ev of fresh) {
			if (ev.type === "revised") {
				loadBoard(ev.rev);
				renderTabs();
				if (ev.rev !== state.rev) showRevBanner(ev.rev);
			} else if (ev.type === "closed") {
				state.closed = true;
				state.outcome = ev.summary ?? null;
			}
		}
		renderHeader();
		updateMode();
	}

	async function poll() {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (document.visibilityState !== "visible") return;
		try {
			const data = await api(`/api/p/${encodeURIComponent(id)}?since=${state.lastSeq}`);
			const fresh = absorb(data);
			if (fresh.length) applyFresh(fresh);
			else renderHeader();
		} catch (error) {
			console.error("poll", error);
		}
		schedule();
	}

	function schedule() {
		if (pollTimer || document.visibilityState !== "visible") return;
		pollTimer = setTimeout(poll, POLL_MS);
	}

	// ---------- sending ----------

	function setBusy(busy) {
		el.sendBtn.disabled = busy;
		el.approveBtn.disabled = busy;
		el.closeBtn.disabled = busy;
	}

	async function send(verdict) {
		if (!canMark()) return;
		const board = state.boards[state.rev] || {};
		const answers = {};
		for (const q of board.questions || []) {
			const picked = el.questions.querySelector(`input[name="q_${q.id}"]:checked`);
			if (picked) answers[q.id] = picked.value;
		}
		const comment = el.comment.value.trim();
		const marks = visibleMarks().map((m, i) => ({ n: i + 1, frame: m.frame, x: m.x, y: m.y, w: m.w, h: m.h, comment: m.comment || null, crop: m.crop || null }));
		if (verdict === "change" && !Object.keys(answers).length && !comment && !marks.length) {
			setStatus("고른 것이나 의견이 없습니다.");
			return;
		}
		setBusy(true);
		setStatus("보내는 중…");
		const headers = window.__vbSendHeaders || DEFAULT_HEADERS;
		try {
			const res = await fetch(`/api/p/${encodeURIComponent(id)}/feedback`, {
				method: "POST",
				headers,
				body: JSON.stringify({ rev: state.rev, verdict, answers, comment: comment || null, marks }),
			});
			if (res.status === 409) {
				setStatus("이미 끝난 기획안입니다.");
				return;
			}
			if (!res.ok) {
				setStatus("보내지 못했습니다.");
				return;
			}
			const result = await res.json();
			setStatus(result.delivery === "none" ? "기록했습니다. 세션이 확인하면 답이 옵니다." : "세션에 보냈습니다.");
			clearForm();
			await poll();
		} catch (error) {
			console.error("send", error);
			setStatus("보내지 못했습니다.");
		} finally {
			setBusy(false);
		}
	}

	async function dismiss() {
		if (!canMark()) return;
		if (!window.confirm("이 기획안을 닫을까요?")) return;
		setBusy(true);
		try {
			const res = await fetch(`/api/p/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: DEFAULT_HEADERS, body: "{}" });
			if (res.status === 409) {
				setStatus("이미 끝난 기획안입니다.");
				return;
			}
			if (!res.ok) {
				setStatus("보내지 못했습니다.");
				return;
			}
			await poll();
		} catch (error) {
			console.error("dismiss", error);
			setStatus("보내지 못했습니다.");
		} finally {
			setBusy(false);
		}
	}

	// ---------- AI panel ----------

	function buildPrompt(board, frames, sources) {
		const head = PROMPT_HEAD.concat([`[보드] ${board.title || (state.summary ? state.summary.title : "")}`, board.lead || "", ""]);
		for (const section of board.sections || []) {
			head.push(`[구획] ${section.title}${section.desc ? ` - ${section.desc}` : ""}`);
			for (const card of section.cards || []) if (card.note) head.push(`- ${card.note}`);
		}
		head.push("");
		(board.questions || []).forEach((q, i) => {
			head.push(`[질문 ${i + 1}] ${q.text}${q.help ? ` - ${q.help}` : ""}`);
			for (const o of q.options || []) head.push(`  * ${o.label}${o.rec ? " (추천)" : ""}${o.why ? `: ${o.why}` : ""}`);
		});
		const blocks = [];
		frames.forEach((frame, i) => {
			const source = (sources[i] || "").trim();
			if (source) blocks.push(`\n[도식 ${frame.label}]\n\`\`\`mermaid\n${source}\n\`\`\``);
		});
		return { head: head.join("\n"), blocks };
	}

	// The largest prompt whose encoded length fits; null when even the head does not fit.
	function promptFor(limit) {
		const prompt = state.prompt;
		if (!prompt) return "";
		if (encodeURIComponent(prompt.head).length > limit) return null;
		let diagrams = "";
		for (const block of prompt.blocks) {
			if (encodeURIComponent(prompt.head + PROMPT_LEAD + diagrams + block).length <= limit) diagrams += block;
		}
		return prompt.head + (diagrams ? PROMPT_LEAD + diagrams : "");
	}

	function copySync(text) {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.left = "-10000px";
		document.body.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}

	function copyText(text) {
		if (copySync(text)) return Promise.resolve();
		if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
		return Promise.reject(new Error("clipboard unavailable"));
	}

	async function postOpen(body) {
		const res = await fetch("/api/open", { method: "POST", headers: DEFAULT_HEADERS, body: JSON.stringify(body) });
		if (!res.ok) throw new Error(`open ${res.status}`);
		return res.json();
	}

	function renderTargets() {
		el.targets.innerHTML = "";
		for (const target of (state.caps && state.caps.targets) || []) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.target = target.id;
			button.innerHTML = `${esc(target.label)}${target.hint ? `<small>${esc(target.hint)}</small>` : ""}`;
			el.targets.appendChild(button);
		}
	}

	async function loadCaps() {
		try {
			state.caps = await api("/api/caps");
		} catch (error) {
			console.error("caps", error);
			state.caps = { open: false, targets: [] };
		}
		renderTargets();
	}

	function openTarget(target) {
		el.aiMsg.textContent = "";
		const full = promptFor(Infinity);
		if (target.copy) {
			copyText(full).then(
				() => {
					el.aiMsg.textContent = "복사했습니다.";
				},
				() => {
					el.aiMsg.textContent = "복사하지 못했습니다.";
				},
			);
			return;
		}
		const template = String(target.url || "");
		const wantsPrompt = template.includes("{q}");
		const fitted = wantsPrompt ? promptFor(target.maxEncoded || Infinity) : null;
		const tooLong = wantsPrompt && fitted === null;
		const longNote = "내용이 길어 복사해 두었습니다. 열린 창에 붙여 넣으세요.";

		if (state.caps && state.caps.open === true) {
			const body = { target: target.id, proposalId: id };
			if (wantsPrompt) {
				if (tooLong) body.useHome = true;
				else body.q = fitted;
			}
			const copied = tooLong ? copyText(full) : Promise.resolve();
			copied
				.then(() => postOpen(body))
				.then(
					() => {
						el.aiMsg.textContent = tooLong ? longNote : "열었습니다.";
					},
					(error) => {
						console.error("open", error);
						el.aiMsg.textContent = "열지 못했습니다.";
					},
				);
			return;
		}

		// Tailnet: no server-side launcher. Open synchronously inside the click so mobile popup blockers allow it.
		let url;
		if (tooLong) url = target.home || template.replace(/\{q\}/g, "");
		else url = template.replace(/\{q\}/g, encodeURIComponent(fitted || "")).replace(/\{board\}/g, location.href);
		const copiedFirst = tooLong && copySync(full);
		const win = window.open(url, "_blank");
		if (!win) {
			el.aiMsg.textContent = "열지 못했습니다.";
			return;
		}
		try {
			win.opener = null;
		} catch {
			// cross-origin window: nothing to detach
		}
		if (!tooLong) {
			el.aiMsg.textContent = "열었습니다.";
			return;
		}
		if (copiedFirst) {
			el.aiMsg.textContent = longNote;
			return;
		}
		copyText(full).then(
			() => {
				el.aiMsg.textContent = longNote;
			},
			() => {
				el.aiMsg.textContent = "복사하지 못했습니다.";
			},
		);
	}

	// ---------- boot ----------

	function showLoadError(message) {
		el.loadError.textContent = message;
		el.loadError.hidden = false;
		el.decideCard.hidden = true;
		el.marksCard.hidden = true;
		$("threadCard").hidden = true;
		el.fab.hidden = true;
	}

	async function init() {
		if (!id) {
			showLoadError("기획안을 찾을 수 없습니다.");
			return;
		}
		let data;
		try {
			data = await api(`/api/p/${encodeURIComponent(id)}`);
		} catch (error) {
			console.error("load", error);
			showLoadError(error.status === 404 ? "기획안을 찾을 수 없습니다." : "기획안을 불러오지 못했습니다.");
			return;
		}
		absorb(data);
		state.closed = data.summary.status === "closed";
		const closedEvent = state.events.find((ev) => ev.type === "closed");
		state.outcome = closedEvent ? closedEvent.summary ?? null : data.summary.outcome;
		await Promise.all(state.revs.map((r) => loadBoard(r.n)));
		renderHeader();
		renderThread();
		const wanted = Number.parseInt(new URLSearchParams(location.search).get("rev") || "", 10);
		await selectRev(Number.isFinite(wanted) ? wanted : state.latest, { replace: false });
		loadCaps();
		schedule();
	}

	el.sendBtn.addEventListener("click", () => send("change"));
	el.approveBtn.addEventListener("click", () => send("approve"));
	el.closeBtn.addEventListener("click", dismiss);
	el.revBannerBtn.addEventListener("click", () => {
		if (state.bannerRev != null) selectRev(state.bannerRev);
	});
	el.comment.addEventListener("input", () => {
		if (state.closed) updateMode();
	});
	el.fab.addEventListener("click", () => {
		el.panel.hidden = !el.panel.hidden;
		el.aiMsg.textContent = "";
	});
	el.targets.addEventListener("click", (e) => {
		const button = e.target.closest("button[data-target]");
		if (!button || !state.caps) return;
		const target = state.caps.targets.find((t) => t.id === button.dataset.target);
		if (target) openTarget(target);
	});
	window.addEventListener("resize", resizeAll);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") poll();
		else if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	});

	init();
})();
