import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("skills/doc-to-md/SKILL.md equals the generator output for the current package version", () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-skill-"));
	try {
		execFileSync(process.execPath, [join(ROOT, "scripts", "gen-skill.mjs"), "--out", out], { cwd: ROOT, stdio: "pipe" });
		const generated = readFileSync(join(out, "SKILL.md"), "utf8");
		const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");
		assert.strictEqual(normalizeEol(readFileSync(join(ROOT, "skills", "doc-to-md", "SKILL.md"), "utf8")), normalizeEol(generated), "run: node scripts/gen-skill.mjs");
		const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
		assert.ok(generated.includes(`npx -y pi-quiver@${version} doc-to-md`));
		for (const s of ["--page-images", "--json", ".xlsm", ".msg", ".eml", ".doc", "[^A-Za-z0-9._-]+ -> _"]) assert.ok(generated.includes(s), s);
		const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
		assert.strictEqual(marketplace.plugins.find((p: { name: string }) => p.name === "quiver").version, version);
	} finally { rmSync(out, { recursive: true, force: true }); }
});
