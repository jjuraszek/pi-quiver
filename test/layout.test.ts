import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const extensionFiles = readdirSync(new URL("../extensions", import.meta.url)).filter(
	(f) => f.endsWith(".ts") || f.endsWith(".js"),
);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("every top-level extensions/*.ts or *.js default-exports a function", async () => {
	assert.ok(extensionFiles.length >= 6, `expected at least 6 extensions, got ${extensionFiles.length}`);
	for (const file of extensionFiles) {
		const mod = await import(new URL(`../extensions/${file}`, import.meta.url).href);
		assert.equal(typeof mod.default, "function", `extensions/${file} must default-export a function`);
	}
});

test("no test files live under extensions/", () => {
	const leaked = extensionFiles.filter((f) => f.endsWith(".test.ts"));
	assert.deepEqual(leaked, [], `test files leaked into extensions/: ${leaked.join(", ")}`);
});

test("files allowlist ships extensions/ and lib/", () => {
	assert.ok(pkg.files.includes("extensions"), "package.json files must include extensions");
	assert.ok(pkg.files.includes("lib"), "package.json files must include lib");
});

// packaging + isolation contract (spec 2026-08-20-fetch-claude-code-portability)
test("packaging isolates Claude artifacts from pi and npm", () => {
	assert.deepStrictEqual(pkg.pi.extensions, ["./extensions"]);
	assert.ok(pkg.files.includes("dist"));
	for (const banned of ["skills", ".claude-plugin", "bin"]) {
		for (const entry of pkg.files as string[]) {
			const firstSegment = entry.replace(/^\.\//, "").split("/")[0];
			assert.notStrictEqual(firstSegment, banned, `files entry "${entry}" would ship ${banned} in the tarball`);
		}
	}
	assert.deepStrictEqual(pkg.bin, { "pi-quiver": "dist/bin/pi-quiver.js" });
});

test("fetch core imports no @earendil-works packages", () => {
	const src = readFileSync(new URL("../lib/fetch-core.ts", import.meta.url), "utf8");
	assert.ok(!src.includes("@earendil-works"));
});

test("doc-to-md core imports no @earendil-works packages", () => {
	const src = readFileSync(new URL("../lib/doc-to-md-core.ts", import.meta.url), "utf8");
	assert.ok(!src.includes("@earendil-works"));
});

test("herdr-tab core imports no @earendil-works packages", () => {
	const src = readFileSync(new URL("../lib/herdr-tab.ts", import.meta.url), "utf8");
	assert.ok(!src.includes("@earendil-works"));
});

test("marketplace allowlist entries exist and contain SKILL.md", () => {
	const mp = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
	assert.strictEqual(mp.plugins.length, 1);
	for (const rel of mp.plugins[0].skills) {
		const skill = readFileSync(new URL(`../${rel}/SKILL.md`, import.meta.url), "utf8");
		assert.match(skill, /^---\nname: /);
	}
});
