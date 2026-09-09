/**
 * unpdf child (Node). argv[2] = mode (info | pdf-text); options JSON on stdin; JSON result on stdout.
 * Exit 0 ok, 1 failure, 3 user error. Runs as its own process so a PDF.js stall is killable.
 * Only selected pages are requested (getPage(n)), so an unselected toxic page cannot burn the budget.
 */
import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";

const SEP = (n: number) => `--- end of page.page_number=${n} ---`;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	if (mode !== "info" && mode !== "pdf-text") { process.stderr.write("usage: unpdf-worker <info|pdf-text>\n"); return 1; }
	const o = JSON.parse((await readStdin()) || "{}") as { path: string; pages?: number[] | null };
	try {
		const pdf = await getDocumentProxy(new Uint8Array(readFileSync(o.path)));
		const pageCount = pdf.numPages;
		if (mode === "info") {
			const meta = (await pdf.getMetadata().catch(() => null))?.info as Record<string, unknown> | undefined;
			const metadata: Record<string, string> = {};
			for (const k of ["Title", "Author", "Subject", "Creator", "Producer"]) if (typeof meta?.[k] === "string" && meta[k]) metadata[k.toLowerCase()] = meta[k] as string;
			process.stdout.write(JSON.stringify({ pageCount, metadata, toc: [] }));
			return 0;
		}
		const pages = o.pages ?? Array.from({ length: pageCount }, (_, i) => i + 1);
		const bad = pages.filter((p) => p < 1 || p > pageCount);
		if (bad.length) { process.stdout.write(JSON.stringify({ error: `pages out of range: ${bad.join(", ")} (document has ${pageCount} pages)`, pageCount })); return 3; }
		const out: string[] = [], emptyPages: number[] = [], failedPages: { page: number; error: string }[] = [];
		for (const n of pages) {
			let text = "";
			try {
				const page = await pdf.getPage(n);
				const content = await page.getTextContent();
				text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("").trim();
			} catch (e) { failedPages.push({ page: n, error: String(e).slice(0, 300) }); }
			if (!text) emptyPages.push(n);
			out.push(text, SEP(n));
		}
		if (failedPages.length === pages.length) throw new Error(`every selected page failed: ${failedPages[0].error}`);
		process.stdout.write(JSON.stringify({ markdown: `${out.join("\n\n")}\n`, pages, pageCount, emptyPages, failedPages, notes: ["No images: unpdf backend"] }));
		return 0;
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
		return 1;
	}
}

main().then((code) => { process.exitCode = code; });
