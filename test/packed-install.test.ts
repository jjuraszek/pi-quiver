import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The one test shape that catches ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING:
// pack the tarball (triggers prepack/esbuild), install it, run the installed bin.
test("packed tarball installs and the bin runs", { timeout: 120_000 }, () => {
	const workDir = mkdtempSync(join(tmpdir(), "quiver-pack-"));
	try {
		execFileSync("npm", ["pack", "--pack-destination", workDir], {
			cwd: ROOT, stdio: "pipe", shell: process.platform === "win32", timeout: 60_000,
		});
		const tarball = readdirSync(workDir).find((f) => f.endsWith(".tgz"))!;
		execFileSync("npm", ["install", "--no-save", join(workDir, tarball)], {
			cwd: workDir, stdio: "pipe", shell: process.platform === "win32", timeout: 60_000,
		});
		const bin = join(workDir, "node_modules", ".bin", process.platform === "win32" ? "pi-quiver.cmd" : "pi-quiver");
		// usage error is exit 2 — proves the bin resolves, parses, and runs without type-stripping
		try {
			execFileSync(bin, ["fetch"], { stdio: "pipe", shell: process.platform === "win32", timeout: 60_000 });
			assert.fail("expected exit 2");
		} catch (err) {
			const e = err as { status?: number; stderr?: Buffer };
			assert.strictEqual(e.status, 2);
			assert.match(String(e.stderr), /Usage:/);
		}
		// doc-to-md from the installed tarball: scrubbed PATH + cache env -> unpdf worker tier, proving the bundled
		// CLI and the bundled dist/lib/unpdf-worker.js resolve end-to-end from the installed package.
		const fixture = join(ROOT, "test", "fixtures", "multipage.pdf");
		const outDir = join(workDir, "out");
		const scrub = { ...process.env, PATH: dirname(process.execPath), HOME: workDir, XDG_CACHE_HOME: join(workDir, "xdg"), LOCALAPPDATA: join(workDir, "lad") };
		const out = String(execFileSync(bin, ["doc-to-md", "--pages", "1", "--output-dir", outDir, fixture], { stdio: "pipe", shell: process.platform === "win32", timeout: 60_000, env: scrub }));
		assert.match(out, /^Saved-To: .*multipage\.md$/m);
		assert.match(out, /Tier: unpdf/);
		assert.ok(existsSync(join(outDir, "multipage.md")));
		// bundle purity: the CLI bundle must not pull the pi runtime or typebox
		const bundle = readFileSync(join(workDir, "node_modules", "pi-quiver", "dist", "bin", "pi-quiver.js"), "utf8");
		assert.ok(!bundle.includes("@earendil-works") && !bundle.includes("@sinclair/typebox"));
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});
