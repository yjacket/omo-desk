import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A private temp directory for one test; call cleanup() when the test ends. */
export function makeTmpHome(prefix = "vb-test-") {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
