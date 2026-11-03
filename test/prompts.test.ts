import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const surfaces = ["../prompts/elevator.md", "../skills/elevator/SKILL.md"];

test("elevator surfaces share a prose body without ordered slots", () => {
	const bodies = surfaces.map((path) => {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		const frontmatter = source.match(/^---\n[\s\S]*?\n---\n/);
		assert.ok(frontmatter, path);
		const content = source.slice(frontmatter[0].length);
		const paragraphEnd = content.indexOf("\n\n");
		assert.notEqual(paragraphEnd, -1, path);
		return content.slice(paragraphEnd + 2);
	});
	assert.strictEqual(bodies[0], bodies[1]);
	assert.doesNotMatch(bodies[0], /^\s*\d[.)]\s/m);
	assert.doesNotMatch(bodies[0], /in order/i);
	assert.match(bodies[0], /short answer gets a short\s+answer/);
});

test("elevator is registered as a pi prompt", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(pkg.pi.prompts.includes("./prompts/elevator.md"));
});

test("elevator is registered as a user-invoked Claude skill", () => {
	const marketplace = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
	const plugin = marketplace.plugins.find((entry: { name: string }) => entry.name === "quiver");
	assert.ok(plugin);
	assert.ok(plugin.skills.includes("./skills/elevator"));
	const skill = readFileSync(new URL("../skills/elevator/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
	assert.match(skill.match(/^---\n([\s\S]*?)\n---\n/)![1], /^disable-model-invocation: true$/m);
});

test("elevator surface headers preserve their input contracts", () => {
	const prefixes = [
		'---\ndescription: Explain and judge something like for a PM during an elevator talk\nargument-hint: "[ticket|PR|path|topic|free text]"\n---\nExplain ${@:-the thing we were just discussing} like for a PM during an elevator talk.\n\n',
		'---\nname: elevator\ndescription: Explain and judge something like for a PM during an elevator talk\nargument-hint: "[ticket|PR|path|topic|free text]"\ndisable-model-invocation: true\n---\nExplain $ARGUMENTS like for a PM during an elevator talk. An empty subject means the thing we were just discussing.\n\n',
	];
	for (const [index, path] of surfaces.entries()) {
		const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
		assert.strictEqual(source.slice(0, prefixes[index].length), prefixes[index], path);
	}
});
