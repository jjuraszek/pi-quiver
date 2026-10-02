/**
 * Bundle protocol: a call owns `<stem>` for its whole duration via `<stem>.md.lock`;
 * children stage assets under `images/`, `sheets/`, `pages/`, `attachments/`, and `ocr/` staging dirs;
 * Node publishes them to stem-prefixed files in those asset dirs and records every file it
 * wrote in a manifest, and commits `<stem>.md` atomically (tmp + rename).
 */
import fs, { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { PageStat } from "./doc-to-md-handle.ts";

export interface Bundle {
	root: string; stem: string; renamedFrom: string | null; renameReason: string | null; mdPath: string; lockPath: string; imagesDir: string; stagingDir: string; lockId: string;
	sheetsDir: string; sheetsStagingDir: string;
	pagesDir: string; pagesStagingDir: string;
	attachmentsDir: string; attachmentsStagingDir: string;
	ocrDir: string; ocrStagingDir: string; pageStatsPath: string; wordsPath: string;
	manifest: Set<string>;
	csvManifest: Set<string>;
	pageManifest: Set<string>;
	attachmentManifest: Set<string>;
	ocrManifest: Set<string>;
	sourceMap: Map<string, string>;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ownedPattern(stem: string): RegExp {
	return new RegExp(`^${escRe(stem)}-(p|s)\\d+(-\\d+)?\\.[a-z0-9]+$`);
}

export function ownedCsvPattern(stem: string): RegExp {
	return new RegExp(`^${escRe(stem)}-s\\d+-[a-z0-9-]+\\.csv$`);
}

export function ownedPagePattern(stem: string): RegExp { return new RegExp(`^${escRe(stem)}-p\\d+\\.[a-z0-9]+$`); }

export function ownedOcrPattern(stem: string): RegExp { return new RegExp(`^${escRe(stem)}-p\\d+(?:\\.words\\.json|\\.md)$`); }

const FILE_LINK_RE = /\[[^\]]*\]\(\s*((?:sheets|attachments)\/[^)\s]+)\s*\)/g;
const IMG_LINK_RE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)]*?))\s*\)|<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

function imageTarget(m: RegExpMatchArray): string {
	const target = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
	const destination = target.replace(/^<([\s\S]*)>$/, "$1").trim();
	return m[2] === undefined ? destination : destination.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, "");
}

export function openBundle(root: string, requested: string, overwrite: boolean): Bundle {
	mkdirSync(root, { recursive: true });
	let stem: string, mdPath: string, lockPath: string;
	let renameReason: string | null = null;
	const exists = `${requested}.md exists`;
	const held = `${requested}.md.lock held; delete it if no conversion is running`;
	for (let i = 1; ; i++) {
		stem = i === 1 ? requested : `${requested}-${i}`;
		mdPath = join(root, `${stem}.md`); lockPath = `${mdPath}.lock`;
		if (!overwrite) {
			const mdExists = existsSync(mdPath);
			if (mdExists || existsSync(lockPath)) {
				if (i === 1) renameReason = mdExists ? exists : held;
				continue;
			}
		}
		let fd: number;
		try { fd = openSync(lockPath, "wx"); }
		catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Output directory not writable: ${root} (${(e as Error).message})`);
			if (overwrite) throw new Error(`Another conversion owns ${mdPath} (lock: ${lockPath}); if no conversion is running, delete the lock`);
			if (i === 1) renameReason = held;
			continue;
		}
		closeSync(fd);
		if (!overwrite && existsSync(mdPath)) { unlinkSync(lockPath); if (i === 1) renameReason = exists; continue; }
		break;
	}
	const renamedFrom = stem === requested ? null : requested;
	const imagesDir = join(root, "images");
	const sheetsDir = join(root, "sheets");
	const pagesDir = join(root, "pages");
	const attachmentsDir = join(root, "attachments");
	const ocrDir = join(root, "ocr");
	try {
		if (existsSync(mdPath) && overwrite) {
			const owned = ownedPattern(stem), ownedCsv = ownedCsvPattern(stem), ownedPage = ownedPagePattern(stem);
			const attachments = new Set([...readFileSync(mdPath, "utf8").matchAll(FILE_LINK_RE)]
				.filter((m) => m[1].startsWith("attachments/"))
				.map((m) => m[1].slice("attachments/".length))
				.filter((f) => f.startsWith(`${stem}-`)));
			unlinkSync(mdPath);
			if (existsSync(imagesDir)) for (const f of readdirSync(imagesDir)) if (owned.test(f)) rmSync(join(imagesDir, f), { force: true });
			if (existsSync(sheetsDir)) for (const f of readdirSync(sheetsDir)) if (ownedCsv.test(f)) rmSync(join(sheetsDir, f), { force: true });
			if (existsSync(pagesDir)) for (const f of readdirSync(pagesDir)) if (ownedPage.test(f)) rmSync(join(pagesDir, f), { force: true });
			if (existsSync(attachmentsDir)) for (const f of readdirSync(attachmentsDir)) if (attachments.has(f)) rmSync(join(attachmentsDir, f), { force: true });
			rmSync(join(root, `${stem}.pages.json`), { force: true });
			rmSync(join(root, `${stem}.words.json`), { force: true });
			const ownedOcr = ownedOcrPattern(stem);
			if (existsSync(ocrDir)) for (const f of readdirSync(ocrDir)) if (ownedOcr.test(f)) rmSync(join(ocrDir, f), { force: true });
		}
		const lockId = randomBytes(6).toString("hex");
		const stagingDir = join(imagesDir, `.stage-${lockId}`);
		const sheetsStagingDir = join(sheetsDir, `.stage-${lockId}`);
		mkdirSync(stagingDir, { recursive: true });
		const pagesStagingDir = join(pagesDir, `.stage-${lockId}`);
		const attachmentsStagingDir = join(attachmentsDir, `.stage-${lockId}`);
		const ocrStagingDir = join(ocrDir, `.stage-${lockId}`);
		return { root, stem, renamedFrom, renameReason, mdPath, lockPath, imagesDir, stagingDir, lockId, sheetsDir, sheetsStagingDir, pagesDir, pagesStagingDir, attachmentsDir, attachmentsStagingDir, ocrDir, ocrStagingDir, pageStatsPath: join(root, `${stem}.pages.json`), wordsPath: join(root, `${stem}.words.json`), ocrManifest: new Set(), manifest: new Set(), csvManifest: new Set(), pageManifest: new Set(), attachmentManifest: new Set(), sourceMap: new Map() };
	} catch (e) { rmSync(lockPath, { force: true }); throw e; }
}

export interface DoneMeta { native?: { file: string; width: number; height: number }; dpi?: number; requestedDpi?: number }
export interface StagedPage { files: string[]; meta: DoneMeta }

/** Publish completed pages, retaining metadata with native filenames renamed; discard partial pages. */
export function publishStaged(b: Bundle): Map<number, StagedPage> {
	const out = new Map<number, StagedPage>();
	if (!existsSync(b.stagingDir)) return out;
	for (const dir of readdirSync(b.stagingDir).sort()) {
		const m = dir.match(/^p(\d+)$/);
		if (!m) continue;
		const pageDir = join(b.stagingDir, dir);
		if (!existsSync(join(pageDir, ".done"))) { rmSync(pageDir, { recursive: true, force: true }); continue; }
		const page = Number(m[1]);
		const raw = readFileSync(join(pageDir, ".done"), "utf8").trim();
		let meta: DoneMeta = {};
		try {
			const v = raw ? JSON.parse(raw) : {};
			if (v && typeof v === "object" && !Array.isArray(v)) meta = v;
		} catch { /* Completed images survive truncated metadata. */ }
		const files = readdirSync(pageDir).filter((f) => f !== ".done" && statSync(join(pageDir, f)).isFile()).sort();
		const names: string[] = [];
		files.forEach((f, i) => {
			const name = `${b.stem}-p${page}-${i + 1}${extname(f).toLowerCase()}`;
			renameSync(join(pageDir, f), join(b.imagesDir, name));
			b.manifest.add(name);
			b.sourceMap.set(`${dir}/${f}`, `images/${name}`);
			names.push(name);
		});
		if (meta.native) meta.native = { ...meta.native, file: names[files.indexOf(meta.native.file)] ?? meta.native.file };
		rmSync(pageDir, { recursive: true, force: true });
		out.set(page, { files: names, meta });
	}
	return out;
}

/** Excel: `s<idx>-<n>.<ext>` (embedded) and `s<idx>.<fmt>` (rendered view) staged flat -> `images/<stem>-<file>`. */
export function publishSheetImages(b: Bundle): void {
	for (const f of readdirSync(b.stagingDir).sort()) {
		if (!/^s\d+(-\d+)?\.[a-z0-9]+$/i.test(f)) continue;
		const name = `${b.stem}-${f.toLowerCase()}`;
		renameSync(join(b.stagingDir, f), join(b.imagesDir, name));
		b.manifest.add(name);
		b.sourceMap.set(f, `images/${name}`);
	}
}

/** Excel: `sheetsStagingDir/s<idx>-<slug>.csv` -> `sheets/<stem>-s<idx>-<slug>.csv`; `sheets/` is created only when a CSV exists. */
export function publishSheetCsvs(b: Bundle): void {
	if (!existsSync(b.sheetsStagingDir)) return;
	for (const f of readdirSync(b.sheetsStagingDir).sort()) {
		if (!/^s\d+-[a-z0-9-]+\.csv$/.test(f)) continue;
		const name = `${b.stem}-${f}`;
		renameSync(join(b.sheetsStagingDir, f), join(b.sheetsDir, name));
		b.csvManifest.add(name);
		b.sourceMap.set(`sheets/${f}`, `sheets/${name}`);
	}
}

export function publishPageImages(b: Bundle, pageCount: number): void {
	if (!existsSync(b.pagesStagingDir)) return;
	for (const f of readdirSync(b.pagesStagingDir).sort()) {
		const m = f.match(/^p(\d+)(\.[a-z0-9]+)$/i);
		if (!m || !statSync(join(b.pagesStagingDir, f)).isFile()) continue;
		const name = `${b.stem}-p${m[1].padStart(String(pageCount).length, "0")}${m[2]}`;
		mkdirSync(b.pagesDir, { recursive: true });
		renameSync(join(b.pagesStagingDir, f), join(b.pagesDir, name));
		b.pageManifest.add(name);
		b.sourceMap.set(`pages/${f}`, `pages/${name}`);
	}
	rmSync(b.pagesStagingDir, { recursive: true, force: true });
}

export function writePageStats(b: Bundle, stats: PageStat[]): void {
	writeFileSync(b.pageStatsPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
}

/** Rename within the bundle root keeps the complete words document atomic. */
export function publishWords(b: Bundle): string | null {
	const staged = join(b.stagingDir, "words.json");
	try {
		if (!existsSync(staged)) throw new Error("child staged no words.json");
		renameSync(staged, b.wordsPath);
		return null;
	} catch (e) {
		rmSync(b.wordsPath, { force: true });
		return `write failed - ${(e as Error).message}`;
	}
}

/** Move `.done`-gated Markdown and words sidecars into `ocr/`; drop partial dirs and the checkpoint. Returns page -> absolute paths for each kind. */
export function publishSidecars(b: Bundle): { sidecars: Map<number, string>; wordSidecars: Map<number, string> } {
	const sidecars = new Map<number, string>(), wordSidecars = new Map<number, string>();
	if (!existsSync(b.ocrStagingDir)) return { sidecars, wordSidecars };
	for (const dir of readdirSync(b.ocrStagingDir).sort()) {
		const m = dir.match(/^p(\d+)$/);
		if (!m) continue;
		const pageDir = join(b.ocrStagingDir, dir);
		if (!existsSync(join(pageDir, ".done"))) continue;
		const file = `${b.stem}-${dir}.md`;
		if (!existsSync(join(pageDir, file))) continue;
		mkdirSync(b.ocrDir, { recursive: true });
		renameSync(join(pageDir, file), join(b.ocrDir, file));
		b.ocrManifest.add(file);
		sidecars.set(Number(m[1]), join(b.ocrDir, file));
		const wfile = `${b.stem}-${dir}.words.json`;
		if (existsSync(join(pageDir, wfile))) {
			renameSync(join(pageDir, wfile), join(b.ocrDir, wfile));
			b.ocrManifest.add(wfile);
			wordSidecars.set(Number(m[1]), join(b.ocrDir, wfile));
		}
	}
	rmSync(b.ocrStagingDir, { recursive: true, force: true });
	return { sidecars, wordSidecars };
}

export function publishAttachments(b: Bundle): void {
	if (!existsSync(b.attachmentsStagingDir)) return;
	for (const f of readdirSync(b.attachmentsStagingDir).sort()) {
		if (!statSync(join(b.attachmentsStagingDir, f)).isFile()) continue;
		const name = `${b.stem}-${f}`;
		mkdirSync(b.attachmentsDir, { recursive: true });
		renameSync(join(b.attachmentsStagingDir, f), join(b.attachmentsDir, name));
		b.attachmentManifest.add(name);
		b.sourceMap.set(`attachments/${f}`, `attachments/${name}`);
	}
	rmSync(b.attachmentsStagingDir, { recursive: true, force: true });
}

export function rewriteLinks(md: string, sourceMap: Map<string, string>): string {
	const images = md.replace(IMG_LINK_RE, (whole, mdAngle, mdPlain, htmlDouble, htmlSingle, htmlUnquoted) => {
		const target = imageTarget([whole, mdAngle, mdPlain, htmlDouble, htmlSingle, htmlUnquoted] as unknown as RegExpMatchArray);
		const dest = sourceMap.get(target) ?? sourceMap.get(target.replace(/^\.\//, ""));
		return dest ? whole.replace(mdAngle === undefined ? target : `<${mdAngle}>`, dest) : whole;
	});
	return images.replace(FILE_LINK_RE, (whole, target: string) => {
		const dest = sourceMap.get(target);
		return dest ? whole.split(target).join(dest) : whole;
	});
}

export function validateImageLinks(md: string, manifest: Set<string>, csvManifest: Set<string> = new Set(), html = false, pageManifest: Set<string> = new Set(), attachmentManifest: Set<string> = new Set()): void {
	for (const m of md.matchAll(IMG_LINK_RE)) {
		const target = imageTarget(m);
		if (html && !target.replace(/^\.\//, "").startsWith("p1/")) continue;
		if (target.startsWith("pages/")) {
			if (!pageManifest.has(target.slice("pages/".length))) throw new Error(`unexpected image reference in output: ${target}`);
		} else if (!target.startsWith("images/") || !manifest.has(target.slice("images/".length))) throw new Error(`unexpected image reference in output: ${target}`);
	}
	for (const m of md.matchAll(FILE_LINK_RE)) {
		if (m[1].startsWith("attachments/")) {
			if (!attachmentManifest.has(m[1].slice("attachments/".length))) throw new Error(`unexpected attachment reference in output: ${m[1]}`);
		} else if (!csvManifest.has(m[1].slice("sheets/".length))) throw new Error(`unexpected sheet reference in output: ${m[1]}`);
	}
}

export function commitBundle(b: Bundle, markdown: string): void {
	const tmp = `${b.mdPath}.tmp`;
	writeFileSync(tmp, markdown, "utf8");
	renameSync(tmp, b.mdPath);
	try { fs.rmSync(b.stagingDir, { recursive: true, force: true }); } catch { /* Markdown is published; cleanup is best-effort. */ }
	try { fs.rmSync(b.sheetsStagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	try { fs.rmSync(b.pagesStagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	try { fs.rmSync(b.attachmentsStagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	try { fs.rmSync(b.ocrStagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	try { fs.rmSync(b.lockPath, { force: true }); } catch { /* Markdown is published; cleanup is best-effort. */ }
}

export function abortBundle(b: Bundle): void {
	for (const f of b.manifest) rmSync(join(b.imagesDir, f), { force: true });
	for (const f of b.csvManifest) rmSync(join(b.sheetsDir, f), { force: true });
	for (const f of b.pageManifest) rmSync(join(b.pagesDir, f), { force: true });
	for (const f of b.attachmentManifest) rmSync(join(b.attachmentsDir, f), { force: true });
	for (const f of b.ocrManifest) rmSync(join(b.ocrDir, f), { force: true });
	rmSync(b.ocrStagingDir, { recursive: true, force: true });
	rmSync(b.pageStatsPath, { force: true });
	rmSync(b.wordsPath, { force: true });
	rmSync(`${b.mdPath}.tmp`, { force: true });
	rmSync(b.stagingDir, { recursive: true, force: true });
	rmSync(b.sheetsStagingDir, { recursive: true, force: true });
	rmSync(b.pagesStagingDir, { recursive: true, force: true });
	rmSync(b.attachmentsStagingDir, { recursive: true, force: true });
	rmSync(b.lockPath, { force: true });
}

export function tempBundleRoot(): string {
	const dir = join(tmpdir(), `pi-quiver-doc-to-md-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return resolve(dir);
}
