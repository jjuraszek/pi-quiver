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
