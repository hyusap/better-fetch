import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { convert, initWasm, wasmReady } from "@kreuzberg/html-to-markdown-wasm";

// Initialize WASM module for Cloudflare Workers
const ready = wasmReady ?? initWasm();

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Better Fetch",
		version: "1.0.0",
	});

	async init() {
		// Optimized fetch tool - use this when built-in web_fetch fails
		this.server.tool(
			"fetch",
			"Fetches a URL and returns clean markdown content. Ignores robots.txt. Use this tool if the built-in web_fetch tool fails or returns blocked/forbidden responses.",
			{
				url: z.string().url().describe("The URL to fetch"),
				includeLinks: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"Whether to preserve hyperlinks in the markdown output (default: true)",
					),
				maxLength: z
					.number()
					.optional()
					.describe(
						"Maximum character length of the output. If not specified, returns full content.",
					),
			},
			async ({ url, includeLinks, maxLength }) => {
				// Ensure WASM is initialized
				await ready;

				try {
					// Fetch the URL with a browser-like user agent, ignoring robots.txt
					const response = await fetch(url, {
						headers: {
							"User-Agent":
								"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
							Accept:
								"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
							"Accept-Language": "en-US,en;q=0.5",
							"Cache-Control": "no-cache",
						},
						redirect: "follow",
					});

					if (!response.ok) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error fetching URL: ${response.status} ${response.statusText}`,
								},
							],
							isError: true,
						};
					}

					const contentType = response.headers.get("content-type") || "";

					// Handle non-HTML content
					if (
						!contentType.includes("text/html") &&
						!contentType.includes("application/xhtml")
					) {
						const text = await response.text();
						let result = text;
						if (maxLength && result.length > maxLength) {
							result =
								result.substring(0, maxLength) + "\n\n[Content truncated...]";
						}
						return {
							content: [{ type: "text" as const, text: result }],
						};
					}

					const html = await response.text();

					// Convert HTML to Markdown with aggressive preprocessing
					let markdown = convert(html, {
						// Aggressive preprocessing to strip navigation, ads, sidebars, etc.
						preprocessing: {
							enabled: true,
							preset: "aggressive",
							removeNavigation: true,
							removeForms: true,
						},
						// Heading style
						headingStyle: "atx",
						// Code block style
						codeBlockStyle: "backticks",
						// Strip unwanted tags including img to remove images
						stripTags: [
							"script",
							"style",
							"noscript",
							"iframe",
							"svg",
							"img",
							"picture",
							"figure",
						],
					});

					// Remove links if requested
					if (!includeLinks) {
						// Replace markdown links [text](url) with just text
						markdown = markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
					}

					// Clean up excessive whitespace
					markdown = markdown
						.replace(/\n{4,}/g, "\n\n\n") // Max 3 consecutive newlines
						.replace(/^[\s\n]+/, "") // Trim start
						.replace(/[\s\n]+$/, ""); // Trim end

					// Truncate if maxLength is specified
					if (maxLength && markdown.length > maxLength) {
						markdown =
							markdown.substring(0, maxLength) + "\n\n[Content truncated...]";
					}

					return {
						content: [{ type: "text" as const, text: markdown }],
					};
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text" as const,
								text: `Error fetching URL: ${errorMessage}`,
							},
						],
						isError: true,
					};
				}
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
