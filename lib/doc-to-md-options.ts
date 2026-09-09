/**
 * doc_to_md option descriptors - the single source of truth for the pi tool schema,
 * the CLI flags/--help, and the `quiver.docToMd` settings shape. pi-free.
 */
import { extname } from "node:path";

export type InputType = "pdf" | "docx" | "pptx" | "xlsx" | "xls";
export type ImageFormat = "png" | "jpg";

export interface Tunables {
	primaryTimeoutMs: number;
	fallbackTimeoutMs: number;
	sofficeTimeoutMs: number;
	excelTimeoutMs: number;
	warmTimeoutMs: number;
	pymupdfVersion: string;
	imageDpi: number;
	imageFormat: ImageFormat;
	maxCellsPerSheet: number;
	maxOutputBytes: number;
	outlineMaxEntries: number;
}

export interface DocToMdOptions extends Tunables {
	path: string;
	info: boolean;
	pages: number[] | null;
	outputDir: string | null;
	overwrite: boolean;
}

/** What adapters pass in: intents as raw strings/booleans, tunables optional. */
export interface PerCallInput extends Partial<Tunables> {
	path: string;
	info?: boolean;
	pages?: string | null;
	outputDir?: string | null;
	overwrite?: boolean;
}

export type DescriptorType = "string" | "int" | "bool" | "pages" | "enum" | "version";

export interface OptionDescriptor {
	key: keyof DocToMdOptions;
	flag: string | null;
	type: DescriptorType;
	default: string | number | boolean | null;
	settable: boolean;
	env?: string;
	enumValues?: readonly string[];
	help: string;
}

export class UsageError extends Error {}

export const MIN_PYMUPDF4LLM = "1.27.0";
const VERSION_RE = /^\d+(\.\d+)*$/;

export const DOC_TO_MD_OPTIONS: readonly OptionDescriptor[] = [
	{ key: "path", flag: null, type: "string", default: null, settable: false, help: "Local .pdf .docx .pptx .xlsx .xls file" },
	{ key: "info", flag: "--info", type: "bool", default: false, settable: false, help: "Inspect only (page count, metadata, TOC or sheet inventory); no bundle" },
	{ key: "pages", flag: "--pages", type: "pages", default: null, settable: false, help: "Inclusive 1-based pages, e.g. \"12-15\" or \"3,7,10-12\" (PDF/DOCX/PPTX only); default all" },
	{ key: "outputDir", flag: "--output-dir", type: "string", default: null, settable: false, help: "Bundle root for <stem>.md + images/; default a per-call temp dir" },
	{ key: "overwrite", flag: "--overwrite", type: "bool", default: false, settable: false, help: "Replace an existing completed <stem>.md bundle" },
	{ key: "primaryTimeoutMs", flag: "--primary-timeout", type: "int", default: 60000, settable: true, env: "PI_DOC_TO_MD_CONVERT_TIMEOUT_MS", help: "pymupdf4llm tier; also the unpdf tier" },
	{ key: "fallbackTimeoutMs", flag: "--fallback-timeout", type: "int", default: 30000, settable: true, help: "PyMuPDF get_text tier; also info on PDF" },
	{ key: "sofficeTimeoutMs", flag: "--soffice-timeout", type: "int", default: 120000, settable: true, env: "PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS", help: "DOCX/PPTX -> PDF via LibreOffice" },
	{ key: "excelTimeoutMs", flag: "--excel-timeout", type: "int", default: 60000, settable: true, help: "Excel child (both openpyxl loads); also info on Excel" },
	{ key: "warmTimeoutMs", flag: "--warm-timeout", type: "int", default: 120000, settable: true, env: "PI_DOC_TO_MD_WARM_TIMEOUT_MS", help: "Absolute backend discovery/bootstrap deadline (first call per process)" },
	{ key: "pymupdfVersion", flag: "--pymupdf-version", type: "version", default: "1.27.2.3", settable: true, env: "PI_DOC_TO_MD_PYMUPDF_VERSION", help: "pymupdf4llm pin (>= 1.27.0)" },
	{ key: "imageDpi", flag: "--image-dpi", type: "int", default: 150, settable: true, help: "Render DPI for page images" },
	{ key: "imageFormat", flag: "--image-format", type: "enum", default: "png", settable: true, enumValues: ["png", "jpg"], help: "Rendered image format (embedded images keep their native extension)" },
	{ key: "maxCellsPerSheet", flag: "--max-cells-per-sheet", type: "int", default: 50000, settable: true, help: "rows x cols budget per worksheet" },
	{ key: "maxOutputBytes", flag: "--max-output-bytes", type: "int", default: 20000000, settable: true, help: "Child stdout cap in bytes" },
	{ key: "outlineMaxEntries", flag: "--outline-max-entries", type: "int", default: 40, settable: true, help: "Heading outline / TOC / sheet inventory cap in the handle" },
];

export const TUNABLE_DEFAULTS: Tunables = Object.fromEntries(
	DOC_TO_MD_OPTIONS.filter((d) => d.settable).map((d) => [d.key, d.default]),
) as unknown as Tunables;

export function versionAtLeast(v: string, min: string): boolean {
	const a = v.split(".").map(Number), b = min.split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0, y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}

function coerceValue(d: OptionDescriptor, raw: unknown, fromString = false): { ok: true; value: unknown } | { ok: false; reason: string } {
	switch (d.type) {
		case "int": {
			const n = fromString && typeof raw === "string" ? Number(raw) : raw;
			return typeof n === "number" && Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, reason: "must be a positive integer" };
		}
		case "bool": return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, reason: "must be true or false" };
		case "enum": return typeof raw === "string" && d.enumValues!.includes(raw) ? { ok: true, value: raw } : { ok: false, reason: `must be one of ${d.enumValues!.join(", ")}` };
		case "version":
			if (typeof raw !== "string" || !VERSION_RE.test(raw)) return { ok: false, reason: "must be digits and dots" };
			if (!versionAtLeast(raw, MIN_PYMUPDF4LLM)) return { ok: false, reason: `must be >= ${MIN_PYMUPDF4LLM}` };
			return { ok: true, value: raw };
		case "string": return typeof raw === "string" && raw.length > 0 ? { ok: true, value: raw } : { ok: false, reason: "must be a non-empty string" };
		case "pages": return typeof raw === "string" ? { ok: true, value: parsePages(raw) } : { ok: false, reason: "must be a string" };
	}
}

/** Single validation boundary for `quiver.docToMd`: unknown/ill-typed/intent keys are dropped with one warning each. */
export function coerceDocToMdSettings(raw: unknown, warn: (message: string) => void = console.warn): Partial<Tunables> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const d = DOC_TO_MD_OPTIONS.find((o) => o.key === k);
		if (!d || !d.settable) { warn(`pi-quiver: quiver.docToMd.${k} is not a tunable setting; ignored.`); continue; }
		const c = coerceValue(d, v);
		if (!c.ok) { warn(`pi-quiver: quiver.docToMd.${k} ${c.reason}; ignored.`); continue; }
		out[k] = c.value;
	}
	return out as Partial<Tunables>;
}

export function parsePages(spec: string): number[] {
	const out = new Set<number>();
	const parts = spec.split(",").map((s) => s.trim());
	if (parts.length === 0 || parts.some((p) => p === "")) throw new UsageError(`invalid --pages "${spec}": expected e.g. "12-15" or "3,7,10-12"`);
	for (const p of parts) {
		const m = p.match(/^(\d+)(?:-(\d+))?$/);
		if (!m) throw new UsageError(`invalid --pages "${spec}": bad token "${p}"`);
		const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
		if (a < 1 || b < a) throw new UsageError(`invalid --pages "${spec}": pages are 1-based and ranges ascend`);
		for (let i = a; i <= b; i++) out.add(i);
	}
	return [...out].sort((x, y) => x - y);
}

export function sanitizeStem(base: string): string {
	const s = base.replace(/[^A-Za-z0-9._-]+/g, "_");
	return s.length ? s : "document";
}

const SUPPORTED: Record<string, InputType> = { ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".xlsx": "xlsx", ".xls": "xls" };

export function classifyInput(filePath: string): InputType {
	const t = SUPPORTED[extname(filePath).toLowerCase()];
	if (!t) throw new Error(`Unsupported file type "${extname(filePath) || "(none)"}"; supported: .pdf, .docx, .pptx, .xlsx, .xls`);
	return t;
}

/** per-call > settings > deprecated env > default. Throws UsageError for bad per-call values or info + bundle option. */
export function resolveOptions(perCall: PerCallInput, settings: Partial<Tunables>, env: NodeJS.ProcessEnv): DocToMdOptions {
	const out: Record<string, unknown> = { path: perCall.path };
	for (const d of DOC_TO_MD_OPTIONS) {
		if (d.key === "path") continue;
		let value: unknown = d.default;
		if (d.env && env[d.env] !== undefined) {
			const c = coerceValue(d, env[d.env], true);
			if (!c.ok) throw new UsageError(`${d.env} ${c.reason} (got "${env[d.env]}")`);
			value = c.value;
		}
		if (d.settable && (settings as Record<string, unknown>)[d.key] !== undefined) value = (settings as Record<string, unknown>)[d.key];
		const pc = (perCall as unknown as Record<string, unknown>)[d.key];
		if (pc !== undefined && pc !== null) {
			const c = coerceValue(d, pc);
			if (!c.ok) throw new UsageError(`${d.flag} ${c.reason}`);
			value = c.value;
		}
		out[d.key] = value;
	}
	const o = out as unknown as DocToMdOptions;
	if (o.info && (o.pages !== null || o.outputDir !== null || o.overwrite)) {
		throw new UsageError("--info cannot be combined with --pages, --output-dir or --overwrite");
	}
	return o;
}

export function renderHelp(): string {
	const row = (d: OptionDescriptor) => `  ${(d.flag ?? "<path>").padEnd(26)} ${d.help}${d.default !== null && d.key !== "info" && d.key !== "overwrite" ? ` (default ${d.default})` : ""}`;
	return [
		"Usage: pi-quiver doc-to-md [flags] <path>",
		"", "Per-call:", ...DOC_TO_MD_OPTIONS.filter((d) => !d.settable).map(row),
		"", "Tunables (also settable under quiver.docToMd in settings.json; per-call > settings > default):",
		...DOC_TO_MD_OPTIONS.filter((d) => d.settable).map(row),
		"", "Result: a handle (Saved-To, Images-Dir, Page-Count, Outline ...). Read the Saved-To file for the Markdown.",
		"Exit codes: 0 success, 1 runtime error, 2 usage error.",
	].join("\n");
}
