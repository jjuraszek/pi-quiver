#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { DOC_TO_MD_OPTIONS, SUPPORTED_EXTENSIONS, usagePatterns } = await import(pathToFileURL(join(ROOT, "lib", "doc-to-md-options.ts")).href);
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "skills", "doc-to-md");
const formats = SUPPORTED_EXTENSIONS.join(" ");
const head = readFileSync(join(ROOT, "skills", "doc-to-md", "SKILL.head.md"), "utf8").replaceAll("{{VERSION}}", version).replaceAll("{{FORMATS}}", formats);
const row = (d) => `| \`${d.flag}\` | ${d.help}${d.default !== null && d.type !== "bool" ? ` (default \`${d.default}\`)` : ""} |`;
const flags = ["| Flag | Meaning |", "|---|---|", "| `--json` | Print the handle as one JSON object (CLI only) |", ...DOC_TO_MD_OPTIONS.filter((d) => d.flag).map(row)].join("\n");
mkdirSync(out, { recursive: true });
const usage = usagePatterns(`npx -y pi-quiver@${version} doc-to-md`);
writeFileSync(join(out, "SKILL.md"), `${head}\n## Flags\n\n${flags}\n\n## Usage patterns\n\n\`\`\`text\n${usage}\n\`\`\`\n`);
