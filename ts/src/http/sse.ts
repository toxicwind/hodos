/** SSE (Server-Sent Events) helper with heartbeat support. */

/** Create an SSE encoder that formats data as SSE lines. */
export function createSSEEncoder(): TransformStream {
	return new TransformStream({
		transform(chunk, controller) {
			const data = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
			// Format as SSE: "data: \\n\\n" (with optional event type)
			controller.enqueue(`data: ${data}\n\n`);
		},
	});
}

/** Add heartbeat comments to keep SSE connections alive. */
export function attachHeartbeat(
	stream: ReadableStream<Uint8Array>,
	intervalMs: number = 15000,
): ReadableStream<Uint8Array> {
	let timer: NodeJS.Timeout | null = null;

	return new ReadableStream({
		start(controller) {
			const reader = stream.getReader();
			timer = setInterval(() => {
				// Send SSE comment (heartbeat) - ignored by clients but keeps connection alive
				controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
			}, intervalMs);

			// Pipe the original stream
			const pump = () => {
				reader
					.read()
					.then(({ done, value }) => {
						if (done) {
							clearInterval(timer);
							controller.close();
							return;
						}
						controller.enqueue(value);
						return pump();
					})
					.catch((err) => {
						clearInterval(timer);
						controller.error(err);
					});
			};
			pump();
		},
		cancel() {
			if (timer) {
				clearInterval(timer);
			}
		},
	});
}

/** Create a streaming SSE response with heartbeat. */
export function createSSEResponse(
	asyncIterable: AsyncIterable<any>,
	options: { eventType?: string; heartbeatIntervalMs?: number } = {},
): Response {
	const { eventType, heartbeatIntervalMs = 15000 } = options;

	// Transform the async iterable into a stream of SSE-formatted chunks
	const encoder = new TextEncoder();
	let timer: NodeJS.Timeout | null = null;

	const stream = new ReadableStream({
		start(controller) {
			// Start heartbeat timer
			timer = setInterval(() => {
				controller.enqueue(encoder.encode(": heartbeat\n\n"));
			}, heartbeatIntervalMs);

			// Process the async iterable
			(async () => {
				try {
					for await (const chunk of asyncIterable) {
						let data: string;
						if (typeof chunk === "string") {
							data = chunk;
						} else if (chunk instanceof Uint8Array) {
							data = new TextDecoder().decode(chunk);
						} else {
							data = JSON.stringify(chunk);
						}

						const lines = data.split("\n");
						for (const line of lines) {
							if (eventType) {
								controller.enqueue(
									encoder.encode(`event: ${eventType}\ndata: ${line}\n\n`)
								);
							} else {
								controller.enqueue(encoder.encode(`data: ${line}\n\n`));
							}
						}
					}
				} finally {
					if (timer) {
						clearInterval(timer);
					}
					controller.close();
				}
			})();
		},
		cancel() {
			if (timer) {
				clearInterval(timer);
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// CORS headers if needed
			"Access-Control-Allow-Origin": "*",
		},
	});
}

/** Parse SSE stream from upstream (for proxying). */
export function parseSSEStream(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					let pos;
					while ((pos = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, pos).trim();
						buffer = buffer.slice(pos + 1);
						if (line.startsWith("data: ")) {
							yield line.slice(6);
						}
						// Ignore other SSE fields (event:, id:, retry:, : comments)
					}
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}