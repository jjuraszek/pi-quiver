import { test } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The one test shape that catches ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING:
// pack the tarball (triggers prepack/esbuild), install it, run the installed bin.
test("packed tarball installs and the bin runs", { timeout: 400_000 }, () => {
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
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(workDir, "home"), USERPROFILE: join(workDir, "home"), PI_CODING_AGENT_DIR: join(workDir, "agent") };
		for (const key of Object.keys(env)) {
			if (key.startsWith("SLACK_") || key.startsWith("PI_QUIVER_SLACK_")) delete env[key];
		}
		const help = spawnSync(bin, ["slack", "--help"], {
			cwd: workDir, env, encoding: "utf8", shell: process.platform === "win32", timeout: 60_000,
		});
		assert.strictEqual(help.status, 0, String(help.error ?? help.stderr));
		assert.strictEqual(help.stderr, "");
		for (const [subcommand, flags] of [
			["post", ["--channel", "--text", "--detail", "--detail-file", "--blocks-file", "--no-unfurl", "--as"]],
			["reply", ["--channel", "--thread-ts", "--text", "--text-file", "--no-unfurl", "--as"]],
			["dm", ["--user", "--text", "--text-file", "--blocks-file", "--no-unfurl", "--as"]],
			["canvas", ["--id", "--markdown-file", "--as"]],
		] as const) {
			const line = help.stdout.split("\n").find((line) => line.startsWith(`pi-quiver slack ${subcommand} `));
			assert.ok(line, `help lists ${subcommand}`);
			for (const flag of [...flags, "--token-from-env", "--dry-run"]) assert.ok(line.split(/[\s[\]()]/).includes(flag), `${subcommand} help lists ${flag}`);
			assert.strictEqual(line.split(/[\s[\]()]/).includes("--no-unfurl"), subcommand !== "canvas", `${subcommand} help limits --no-unfurl to messages`);
		}
		const version = spawnSync(bin, ["--version"], {
			cwd: workDir, env, encoding: "utf8", shell: process.platform === "win32", timeout: 60_000,
		});
		assert.strictEqual(version.status, 0, String(version.error ?? version.stderr));
		assert.strictEqual(version.stderr, "");
		assert.strictEqual(version.stdout.trim(), JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
		const dryRun = spawnSync(bin, ["slack", "post", "--channel", "C123456", "--text", "probe", "--token-from-env", "--dry-run"], {
			cwd: workDir, env: { ...env, SLACK_USER_TOKEN: "xoxp-synthetic-packed-install" }, encoding: "utf8", shell: process.platform === "win32", timeout: 60_000,
		});
		assert.strictEqual(dryRun.status, 0, String(dryRun.error ?? dryRun.stderr));
		assert.strictEqual(dryRun.stdout, "");
		assert.strictEqual(dryRun.stderr, "");
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
		assert.ok(existsSync(join(workDir, "node_modules", "pi-quiver", "scripts", "docx_numbering.py")), "docx_numbering.py ships in the tarball");
		const json = String(execFileSync(bin, ["doc-to-md", "--json", "--pages", "1", "--output-dir", join(workDir, "out2"), fixture], { stdio: "pipe", shell: process.platform === "win32", timeout: 60_000, env: scrub }));
		const h = JSON.parse(json);
		assert.strictEqual(h.tier, "unpdf");
		assert.ok(h.savedTo.endsWith("multipage.md"));
		if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0) {
			const md = String(execFileSync(bin, ["doc-to-md", "--output-dir", join(workDir, "out3"), join(ROOT, "test", "fixtures", "numbered.docx")], { stdio: "pipe", shell: process.platform === "win32", timeout: 300_000 }));
			assert.match(md, /Engine: mammoth/);
			assert.ok(readFileSync(join(workDir, "out3", "numbered.md"), "utf8").includes("3.2.1 Trip settings"));
		}
		// bundle purity: the CLI bundle must not pull the pi runtime or typebox
		const bundle = readFileSync(join(workDir, "node_modules", "pi-quiver", "dist", "bin", "pi-quiver.js"), "utf8");
		assert.ok(!bundle.includes("@earendil-works") && !bundle.includes("@sinclair/typebox"));
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});
