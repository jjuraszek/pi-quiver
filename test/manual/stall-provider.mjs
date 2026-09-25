#!/usr/bin/env node
// Stalling openai-completions stand-in for the provider-stall-watchdog manual repro.
// Two providers share one port and differ only by base path:
//   /first-event/chat/completions  -> accepts the request and never writes a byte
//   /mid-stream/chat/completions   -> writes one SSE chunk, then hangs
// Connections are held open until the client aborts; nothing is ever completed.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8765);
const sockets = new Set();

const server = createServer((request, response) => {
	request.on("aborted", () => console.error(`[stall-provider] client aborted ${request.url}`));
	if (request.method !== "POST") {
		response.writeHead(404).end();
		return;
	}
	if (request.url === "/first-event/chat/completions") {
		console.error("[stall-provider] first-event stall: holding the request with no response bytes");
		return;
	}
	if (request.url === "/mid-stream/chat/completions") {
		console.error("[stall-provider] mid-stream stall: one chunk, then silence");
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(`data: ${JSON.stringify({ id: "stall-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stall", choices: [{ index: 0, delta: { role: "assistant", content: "Thinking about it" }, finish_reason: null }] })}\n\n`);
		return;
	}
	response.writeHead(404).end();
});

server.on("connection", (socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
});

server.listen(port, "127.0.0.1", () => {
	console.error(`[stall-provider] listening on http://127.0.0.1:${port} (routes: /first-event, /mid-stream)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		for (const socket of sockets) socket.destroy();
		server.close(() => process.exit(0));
	});
}
