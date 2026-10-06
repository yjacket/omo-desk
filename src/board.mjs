import fs from "node:fs";
import path from "node:path";

export const BOARD_SCHEMA = "visual-board/1";
export const MAX_FRAMES = 60;
export const MAX_QUESTIONS = 30;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const FRAME_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mmd"]);
const LAYOUTS = new Set(["", "one", "two"]);
const QUESTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const OPTION_VALUE = /^[A-Za-z0-9_.-]{1,60}$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const TOP_KEYS = new Set(["title", "lead", "sections", "questions", "commentPlaceholder", "id", "sideSession", "kind"]);
const SECTION_KEYS = new Set(["title", "desc", "cards"]);
const CARD_KEYS = new Set(["badge", "title", "layout", "diagram", "gray", "note", "say", "frames"]);
const QUESTION_KEYS = new Set(["id", "text", "help", "options"]);
const OPTION_KEYS = new Set(["value", "label", "rec", "why"]);

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyPath(prefix, key) {
	return prefix === "" ? key : `${prefix}.${key}`;
}

function pushUnknownKeys(object, allowed, prefix, errors) {
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) errors.push(`${keyPath(prefix, key)}: unknown key`);
	}
}

function pushOptionalType(object, key, type, prefix, errors) {
	if (object[key] !== undefined && typeof object[key] !== type) {
		errors.push(`${keyPath(prefix, key)}: must be a ${type}`);
	}
}

export function validateBoard(dir, options = {}) {
	const root = path.resolve(dir);
	const limits = { maxFile: MAX_FILE_BYTES, maxTotal: MAX_TOTAL_BYTES, ...options, ...options.limits };
	const boardPath = path.join(root, "board.json");
	let raw;
	try {
		raw = fs.readFileSync(boardPath, "utf8");
	} catch (err) {
		const detail = err.code === "ENOENT" ? "not found" : `cannot be read (${err.message})`;
		return { ok: false, errors: [`board.json: ${detail}`] };
	}
	let board;
	try {
		board = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (err) {
		return { ok: false, errors: [`board.json: invalid JSON (${err.message})`] };
	}
	if (!isPlainObject(board)) return { ok: false, errors: ["board.json: must be a JSON object"] };

	const errors = [];
	validateShape(board, root, errors);
	if (errors.length > 0) return { ok: false, errors };
	const collected = collectFiles(board, root, limits);
	if (collected.errors.length > 0) return { ok: false, errors: collected.errors };
	return { ok: true, board, files: collected.files, bytes: collected.bytes };
}

function validateShape(board, root, errors) {
	pushUnknownKeys(board, TOP_KEYS, "", errors);
	if (typeof board.title !== "string" || board.title.trim() === "") {
		errors.push("title: must be a non-empty string");
	}
	pushOptionalType(board, "lead", "string", "", errors);
	pushOptionalType(board, "commentPlaceholder", "string", "", errors);
	pushOptionalType(board, "sideSession", "string", "", errors);
	if (board.kind !== undefined && board.kind !== "decision" && board.kind !== "report") {
		errors.push('kind: must be "decision" or "report"');
	}

	const labels = new Map();
	const frames = [];
	let frameCount = 0;
	if (board.sections !== undefined) {
		if (!Array.isArray(board.sections)) {
			errors.push("sections: must be an array");
		} else {
			board.sections.forEach((section, si) => {
				validateSection(section, `sections[${si}]`, root, labels, frames, errors);
			});
			frameCount = frames.length;
		}
	}

	let questionCount = 0;
	if (board.questions !== undefined) {
		if (!Array.isArray(board.questions)) {
			errors.push("questions: must be an array");
		} else {
			questionCount = board.questions.length;
			const ids = new Set();
			board.questions.forEach((question, qi) => {
				validateQuestion(question, `questions[${qi}]`, ids, errors);
			});
		}
	}
	if (board.kind === "report" && Array.isArray(board.questions) && board.questions.length >= 1) {
		errors.push("questions: report boards take no questions");
	}

	if (frameCount === 0 && questionCount === 0) errors.push("board: must have at least one frame or one question");
	if (frameCount > MAX_FRAMES) errors.push(`board: must have at most ${MAX_FRAMES} frames`);
	if (questionCount > MAX_QUESTIONS) errors.push(`board: must have at most ${MAX_QUESTIONS} questions`);
}

function validateSection(section, prefix, root, labels, frames, errors) {
	if (!isPlainObject(section)) {
		errors.push(`${prefix}: must be an object`);
		return;
	}
	pushUnknownKeys(section, SECTION_KEYS, prefix, errors);
	if (typeof section.title !== "string") errors.push(`${prefix}.title: must be a string`);
	pushOptionalType(section, "desc", "string", prefix, errors);
	if (!Array.isArray(section.cards)) {
		errors.push(`${prefix}.cards: must be an array`);
		return;
	}
	section.cards.forEach((card, ci) => {
		validateCard(card, `${prefix}.cards[${ci}]`, root, labels, frames, errors);
	});
}

function validateCard(card, prefix, root, labels, frames, errors) {
	if (!isPlainObject(card)) {
		errors.push(`${prefix}: must be an object`);
		return;
	}
	pushUnknownKeys(card, CARD_KEYS, prefix, errors);
	for (const key of ["badge", "title", "note", "say"]) pushOptionalType(card, key, "string", prefix, errors);
	for (const key of ["diagram", "gray"]) pushOptionalType(card, key, "boolean", prefix, errors);
	if (card.layout !== undefined && !LAYOUTS.has(card.layout)) {
		errors.push(`${prefix}.layout: must be one of "one", "two" or ""`);
	}
	if (!Array.isArray(card.frames) || card.frames.length === 0) {
		errors.push(`${prefix}.frames: must have at least 1 frame`);
		return;
	}
	card.frames.forEach((frame, fi) => {
		validateFrame(frame, `${prefix}.frames[${fi}]`, root, labels, frames, errors);
	});
}

function validateFrame(frame, prefix, root, labels, frames, errors) {
	if (!Array.isArray(frame) || frame.length !== 2) {
		errors.push(`${prefix}: must be a [label, path] pair`);
		return;
	}
	const [label, rel] = frame;
	if (typeof label !== "string" || label.trim() === "") {
		errors.push(`${prefix}[0]: label must be a non-empty string`);
	} else if (labels.has(label)) {
		errors.push(`${prefix}[0]: duplicate frame label "${label}" (first used at ${labels.get(label)})`);
	} else {
		labels.set(label, prefix);
	}
	if (typeof rel !== "string") {
		errors.push(`${prefix}[1]: path must be a string`);
		return;
	}
	const problem = framePathProblem(rel) ?? frameFileProblem(root, rel);
	if (problem) {
		errors.push(`${prefix}[1]: ${problem}`);
		return;
	}
	frames.push({ rel, prefix: `${prefix}[1]` });
}

function framePathProblem(rel) {
	if (SCHEME.test(rel) || path.isAbsolute(rel)) {
		return "must be a local file inside the board dir (download the image into the board dir)";
	}
	if (rel.includes("\\")) return "must use forward slashes";
	if (rel.includes(":")) return "must not contain ':'";
	if (rel.length > 200) return `must be at most 200 characters (got ${rel.length})`;
	const segments = rel.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		return "must not contain empty, '.' or '..' segments";
	}
	const ext = path.extname(rel).toLowerCase();
	if (!FRAME_EXTENSIONS.has(ext)) return `must have one of these extensions: ${[...FRAME_EXTENSIONS].join(", ")}`;
	return null;
}

function frameFileProblem(root, rel) {
	const abs = path.resolve(root, rel);
	const inside = path.relative(root, abs);
	if (inside.startsWith("..") || path.isAbsolute(inside)) return "must stay inside the board dir";
	let stat;
	try {
		stat = fs.statSync(abs);
	} catch {
		return "file not found";
	}
	if (!stat.isFile()) return "not a regular file";
	return null;
}

function validateQuestion(question, prefix, ids, errors) {
	if (!isPlainObject(question)) {
		errors.push(`${prefix}: must be an object`);
		return;
	}
	pushUnknownKeys(question, QUESTION_KEYS, prefix, errors);
	if (typeof question.id !== "string" || !QUESTION_ID.test(question.id)) {
		errors.push(`${prefix}.id: must match ${QUESTION_ID}`);
	} else if (ids.has(question.id)) {
		errors.push(`${prefix}.id: duplicate question id "${question.id}"`);
	} else {
		ids.add(question.id);
	}
	if (typeof question.text !== "string") errors.push(`${prefix}.text: must be a string`);
	pushOptionalType(question, "help", "string", prefix, errors);
	if (!Array.isArray(question.options) || question.options.length < 2) {
		errors.push(`${prefix}.options: must have at least 2 options`);
		return;
	}
	const values = new Set();
	question.options.forEach((option, oi) => {
		validateOption(option, `${prefix}.options[${oi}]`, values, errors);
	});
}

function validateOption(option, prefix, values, errors) {
	if (!isPlainObject(option)) {
		errors.push(`${prefix}: must be an object`);
		return;
	}
	pushUnknownKeys(option, OPTION_KEYS, prefix, errors);
	if (typeof option.value !== "string" || !OPTION_VALUE.test(option.value)) {
		errors.push(`${prefix}.value: must match ${OPTION_VALUE}`);
	} else if (values.has(option.value)) {
		errors.push(`${prefix}.value: duplicate value "${option.value}"`);
	} else {
		values.add(option.value);
	}
	if (typeof option.label !== "string") errors.push(`${prefix}.label: must be a string`);
	pushOptionalType(option, "rec", "boolean", prefix, errors);
	pushOptionalType(option, "why", "string", prefix, errors);
}

function collectFiles(board, root, limits) {
	const files = ["board.json"];
	const seen = new Set(files);
	const entries = [{ rel: "board.json", prefix: "board.json" }];
	const add = (rel, prefix) => {
		if (seen.has(rel)) return;
		seen.add(rel);
		files.push(rel);
		entries.push({ rel, prefix });
	};
	for (const [si, section] of (board.sections ?? []).entries()) {
		for (const [ci, card] of section.cards.entries()) {
			for (const [fi, frame] of card.frames.entries()) {
				const rel = frame[1];
				const prefix = `sections[${si}].cards[${ci}].frames[${fi}][1]`;
				add(rel, prefix);
				if (path.extname(rel).toLowerCase() !== ".svg") continue;
				const sibling = `${rel.slice(0, -4)}.mmd`;
				let stat = null;
				try {
					stat = fs.statSync(path.resolve(root, sibling));
				} catch {
					stat = null;
				}
				if (stat?.isFile()) add(sibling, prefix);
			}
		}
	}

	const errors = [];
	let bytes = 0;
	for (const { rel, prefix } of entries) {
		const size = fs.statSync(path.resolve(root, rel)).size;
		bytes += size;
		if (size > limits.maxFile) {
			errors.push(`${prefix}: file ${rel} is larger than the limit (${size} > ${limits.maxFile} bytes)`);
		}
	}
	if (bytes > limits.maxTotal) {
		errors.push(`board: total size ${bytes} bytes exceeds the limit (${limits.maxTotal} bytes)`);
	}
	return { files, bytes, errors };
}
