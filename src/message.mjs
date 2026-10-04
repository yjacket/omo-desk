const cropJoin = (dir, file) => (!dir ? file : dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`);

const answerLine = (board, answers) => {
	const questions = Array.isArray(board?.questions) ? board.questions : [];
	return Object.entries(answers ?? {})
		.map(([qid, value]) => {
			const question = questions.find((q) => q.id === qid);
			const option = question?.options?.find((o) => o.value === value);
			return `${question ? question.text : qid} -> ${option ? option.label : value}`;
		})
		.join("; ");
};

export function feedbackMessage({ summary, board, event, url, cropDir, cli }) {
	const lines = [
		`[visual-board] 의견이 왔습니다: ${summary.title} (${summary.id}, ${event.rev}안, #${event.seq})`,
		`판단: ${event.verdict === "approve" ? "이대로 진행" : "고쳐 주세요"}`,
	];
	const answers = answerLine(board, event.answers);
	if (answers) lines.push(`답: ${answers}`);
	if (event.comment) lines.push(`전체 의견: ${event.comment}`);
	for (const mark of event.marks ?? []) {
		let line = `표시 ${mark.n} (${mark.frame})`;
		if (mark.comment) line += `: ${mark.comment}`;
		if (mark.crop) line += ` | 그림: ${cropJoin(cropDir, mark.crop)}`;
		lines.push(line);
	}
	if (event.rev < summary.rev) {
		lines.push(`현재 안은 ${summary.rev}안입니다 (이 의견은 ${event.rev}안 기준)`);
	}
	if (url) lines.push(`보기: ${url}`);
	lines.push(`처리: ${cli} show ${summary.id} 로 전체를 읽고 ${cli} reply / revise / close 로 답하세요.`);
	return lines.join("\n");
}

export function pendingNotice(items, cli) {
	if (!items || items.length === 0) return null;
	const lines = [`[visual-board] 이 워크트리에 답을 기다리는 기획안이 ${items.length}건 있습니다.`];
	for (const item of items) {
		lines.push(`- ${item.title} (${item.id}) ${item.url} -> ${cli} show ${item.id}`);
	}
	return lines.join("\n");
}

export function footerText({ mine, theirs }) {
	if (!mine && !theirs) return "";
	return `보드 내 차례 ${mine} · 세션 차례 ${theirs}`;
}
