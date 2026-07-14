/**
 * pi-talk-to-sessions
 *
 * Talk to another pi session's agent from within the current session.
 *
 * Mental model: the current agent treats another session as a context
 * retrieval point. The target's effective conversation history is loaded
 * read-only into an isolated in-memory sub-session. A small external sidecar
 * stores only prior exchanges from this caller to this target, so the target
 * can continue that relationship without modifying either session file.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Prepended to the caller's question so the target agent can distinguish the
 * new request from its own original session context and restored exchanges.
 */
const PREFACE =
	"[The question below comes from another pi session's agent. Answer it directly using your session context and any restored prior exchanges with that calling agent.]";

/** Max sessions returned by list_sessions. */
const MAX_LIST = 100;

/** Prior exchanges live beside, never inside, Pi session files. */
const BRIDGE_DIR = "talk-to-sessions";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_EXCHANGES = 12;
const MAX_BRIDGE_CONTEXT_CHARS = 24_000;
const MAX_BRIDGE_QUESTION_CHARS = 6_000;
const MAX_BRIDGE_ANSWER_CHARS = 12_000;

/** Lazily-created auth + model registry, shared across calls. Reads the host's
 * ~/.pi/agent/auth.json and models.json, so the sub-session uses the same
 * credentials as the interactive session. */
let cachedAuth: AuthStorage | undefined;
let cachedRegistry: ModelRegistry | undefined;
function registries(): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
	if (!cachedAuth || !cachedRegistry) {
		cachedAuth = AuthStorage.create();
		cachedRegistry = ModelRegistry.create(cachedAuth);
	}
	return { authStorage: cachedAuth, modelRegistry: cachedRegistry };
}

function preview(text: string, max: number): string {
	const clean = (text || "").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function formatDate(d: Date): string {
	return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function clipForBridgeContext(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[truncated for bridge context]`;
}

interface ResolvedSession {
	path: string;
	cwd: string;
	firstMessage: string;
	name?: string;
}

interface BridgeExchange {
	version: number;
	occurredAt: string;
	callerSessionId: string;
	targetSessionId: string;
	question: string;
	answer: string;
	model: string;
}

function bridgePairDir(firstSessionId: string, secondSessionId: string): string {
	const [a, b] = [firstSessionId, secondSessionId].sort();
	return join(getAgentDir(), BRIDGE_DIR, `${a}--${b}`);
}

function isBridgeExchange(value: unknown): value is BridgeExchange {
	if (!value || typeof value !== "object") return false;
	const exchange = value as Record<string, unknown>;
	return (
		exchange.version === BRIDGE_VERSION &&
		typeof exchange.occurredAt === "string" &&
		typeof exchange.callerSessionId === "string" &&
		typeof exchange.targetSessionId === "string" &&
		typeof exchange.question === "string" &&
		typeof exchange.answer === "string" &&
		typeof exchange.model === "string"
	);
}

async function loadBridgeExchanges(
	callerSessionId: string,
	targetSessionId: string,
): Promise<BridgeExchange[]> {
	let names: string[];
	try {
		names = await readdir(bridgePairDir(callerSessionId, targetSessionId));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	}

	const recentNames = names
		.filter((name) => name.endsWith(".json"))
		.sort()
		.slice(-MAX_BRIDGE_EXCHANGES * 2);
	const exchanges: BridgeExchange[] = [];
	for (const name of recentNames) {
		try {
			const parsed: unknown = JSON.parse(
				await readFile(join(bridgePairDir(callerSessionId, targetSessionId), name), "utf8"),
			);
			if (isBridgeExchange(parsed)) exchanges.push(parsed);
		} catch {
			// A damaged or incomplete sidecar entry must not stop the conversation.
		}
	}
	return exchanges
		.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
		.slice(-MAX_BRIDGE_EXCHANGES);
}

function bridgeContext(
	exchanges: BridgeExchange[],
	targetSessionId: string,
): { content?: string; count: number } {
	if (exchanges.length === 0) return { count: 0 };

	const lines = [
		"[Restored cross-session exchange history]",
		"The following is a private record of prior conversations between you and the current calling agent. It is not part of your original session, but treat it as already-established context with this agent.",
	];
	let used = lines.join("\n").length;
	let count = 0;
	for (const exchange of [...exchanges].reverse()) {
		const youAnswered = exchange.targetSessionId === targetSessionId;
		const question = clipForBridgeContext(exchange.question, MAX_BRIDGE_QUESTION_CHARS);
		const answer = clipForBridgeContext(exchange.answer, MAX_BRIDGE_ANSWER_CHARS);
		const block = youAnswered
			? `\nOther agent asked you:\n${question}\n\nYou answered:\n${answer}\n`
			: `\nYou asked the other agent:\n${question}\n\nOther agent answered:\n${answer}\n`;
		if (used + block.length > MAX_BRIDGE_CONTEXT_CHARS) break;
		lines.splice(2, 0, block);
		used += block.length;
		count++;
	}
	return { content: count ? lines.join("\n") : undefined, count };
}

async function saveBridgeExchange(exchange: BridgeExchange): Promise<void> {
	const dir = bridgePairDir(exchange.callerSessionId, exchange.targetSessionId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const name = `${exchange.occurredAt.replace(/[:.]/g, "-")}_${randomUUID()}.json`;
	const destination = join(dir, name);
	const temporary = `${destination}.tmp`;
	await writeFile(temporary, `${JSON.stringify(exchange)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, destination);
}

/** Resolve a session reference (file path or a phrase from its first user
 * message) to a SessionInfo-like object. Returns an error string on failure. */
async function resolveSession(
	sessionRef: string,
	currentFile: string | undefined,
): Promise<ResolvedSession | { error: string }> {
	// 1. Direct file path.
	if (existsSyncSafe(sessionRef)) {
		try {
			const reader = SessionManager.open(sessionRef);
			const header = reader.getHeader();
			const entries = reader.getEntries();
			const firstMessage = firstUserMessage(entries) ?? "(empty)";
			return {
				path: sessionRef,
				cwd: header?.cwd || "",
				firstMessage,
				name: reader.getSessionName() ?? undefined,
			};
		} catch {
			return { error: `Could not open session file: ${sessionRef}` };
		}
	}

	// 2. Match by first user message (case-insensitive substring).
	const all = await SessionManager.listAll();
	const needle = sessionRef.toLowerCase();
	const matches = all
		.filter((s) => s.path !== currentFile)
		.filter((s) => (s.firstMessage || "").toLowerCase().includes(needle))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	if (matches.length === 0) {
		return {
			error: `No session found matching "${sessionRef}". Call list_sessions to see available sessions.`,
		};
	}
	if (matches.length > 1) {
		const opts = matches
			.map((s, i) => `${i + 1}. ${preview(s.name || s.firstMessage, 120)}\n   path: ${s.path}`)
			.join("\n\n");
		return {
			error: `Multiple sessions match "${sessionRef}". Pass a more specific phrase or a path:\n\n${opts}`,
		};
	}
	const m = matches[0];
	return {
		path: m.path,
		cwd: m.cwd || "",
		firstMessage: m.firstMessage || "(empty)",
		name: m.name,
	};
}

function existsSyncSafe(p: string): boolean {
	try {
		// Avoid importing fs just for this; statSync throws if missing.
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Find the first user text message in a list of session entries. */
function firstUserMessage(entries: ReturnType<SessionManager["getEntries"]>): string | undefined {
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (msg?.role === "user") {
				const content = msg.content;
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					const text = content
						.filter((c: { type?: string }) => c.type === "text")
						.map((c: { text?: string }) => c.text ?? "")
						.join(" ");
					if (text) return text;
				}
			}
		}
	}
	return undefined;
}

/** Extract the text of the last assistant message from a message list. */
function lastAssistantText(messages: { role?: string; content?: unknown }[]): {
	text: string;
	usage?: unknown;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			const content = m.content;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				text = content
					.filter((c: { type?: string }) => c.type === "text")
					.map((c: { text?: string }) => c.text ?? "")
					.join("\n");
			}
			return { text: text.trim(), usage: (m as { usage?: unknown }).usage };
		}
	}
	return { text: "" };
}

export default function (pi: ExtensionAPI) {
	// --------------------------------------------------------------------
	// Tool: list_sessions
	// --------------------------------------------------------------------
	pi.registerTool({
		name: "list_sessions",
		label: "List Sessions",
		description: [
			"List recent pi sessions across all projects (excluding the current session),",
			"most recent first. Each entry shows a path, working directory, first user",
			"message, message count, and last modified time. Use this to find a session",
			"to talk to, then pass its path (or a distinctive phrase from its first",
			"message) to talk_to_session.",
		].join(" "),
		promptSnippet: "List recent pi sessions to find one to talk to",
		promptGuidelines: [
			"Use list_sessions when the user refers to another session by its topic or first message and you need to find its path.",
		],
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({
					description: "Max sessions to return (most recent first). Default 10.",
					default: 10,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const limit = Math.max(1, Math.min(params.limit ?? 10, MAX_LIST));
			const current = ctx.sessionManager.getSessionFile();
			const all = await SessionManager.listAll();
			const sessions = all
				.filter((s) => s.path !== current)
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, limit);

			if (sessions.length === 0) {
				return {
					content: [{ type: "text", text: "No other sessions found." }],
					details: { count: 0 },
				};
			}

			const lines = sessions.map((s, i) => {
				const title = preview(s.name || s.firstMessage || "(empty)", 160);
				return [
					`${i + 1}. ${title}`,
					`   path: ${s.path}`,
					`   cwd: ${s.cwd || "?"} | msgs: ${s.messageCount} | modified: ${formatDate(s.modified)}`,
				].join("\n");
			});

			return {
				content: [
					{
						type: "text",
						text: `Recent sessions (excluding current), ${sessions.length} shown:\n\n${lines.join("\n\n")}`,
					},
				],
				details: {
					count: sessions.length,
					sessions: sessions.map((s) => ({
						path: s.path,
						cwd: s.cwd,
						modified: s.modified.toISOString(),
					})),
				},
			};
		},
	});

	// --------------------------------------------------------------------
	// Tool: talk_to_session
	// --------------------------------------------------------------------
	pi.registerTool({
		name: "talk_to_session",
		label: "Talk To Session",
		description: [
			"Ask a question to another pi session's agent. Its effective history is loaded",
			"read-only into an isolated in-memory sub-session, while prior exchanges between",
			"these two sessions are restored as temporary agent-to-agent context. Neither Pi",
			"session file is modified. Call list_sessions first to resolve the target session.",
		].join(" "),
		promptSnippet: "Continue an agent-to-agent conversation using another session's context",
		promptGuidelines: [
			"Use talk_to_session when the user wants to ask, continue, or check a conversation with another session. Call list_sessions first to resolve the target session.",
		],
		parameters: Type.Object({
			session: Type.String({
				description:
					"Target session: either its file path, or a distinctive phrase from its first user message (matched case-insensitively).",
			}),
			question: Type.String({
				description:
					"The question to ask the target session's agent, written by you (the calling agent). Sent verbatim, with a short preface prepended.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { session: sessionRef, question } = params;
			const callerSessionId = ctx.sessionManager.getSessionId();

			// 1. Resolve target session.
			const resolved = await resolveSession(sessionRef, ctx.sessionManager.getSessionFile());
			if ("error" in resolved) {
				return {
					content: [{ type: "text", text: resolved.error }],
					details: {},
					isError: true,
				};
			}
			const targetPath = resolved.path;

			onUpdate?.({
				content: [{ type: "text", text: `Loading session ${basename(targetPath)}…` }],
				details: {},
			});

			// 2. Read target session's effective context (read-only).
			let reader: SessionManager;
			try {
				reader = SessionManager.open(targetPath);
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Failed to open session: ${(err as Error).message}` },
					],
					details: { targetSession: targetPath },
					isError: true,
				};
			}
			const bctx = reader.buildSessionContext();
			if (bctx.messages.length === 0) {
				return {
					content: [
						{ type: "text", text: `Session ${basename(targetPath)} has no conversation history.` },
					],
					details: { targetSession: targetPath },
					isError: true,
				};
			}

			const bCwd = reader.getCwd() || ctx.cwd;
			const targetSessionId = reader.getSessionId();
			const targetModelInfo = bctx.model; // { provider, modelId } | null

			// A already has prior exchanges in its own session. Restore only the
			// missing half: this target's previous conversation with this caller.
			let priorExchanges: BridgeExchange[] = [];
			let bridgeReadNote = "";
			if (callerSessionId && targetSessionId) {
				try {
					priorExchanges = await loadBridgeExchanges(callerSessionId, targetSessionId);
				} catch (error) {
					bridgeReadNote = `Could not restore prior cross-session exchanges: ${(error as Error).message}`;
				}
			}

			// 3. Resolve model: target session's last model, else current session's model.
			const { authStorage, modelRegistry } = registries();
			let model = ctx.model;
			let fallbackNote = "";
			if (targetModelInfo) {
				const m = modelRegistry.find(targetModelInfo.provider, targetModelInfo.modelId);
				if (m && modelRegistry.hasConfiguredAuth(m)) {
					model = m;
				} else {
					fallbackNote = `Target session's model (${targetModelInfo.provider}/${targetModelInfo.modelId}) is not available; fell back to current session's model.`;
				}
			}
			if (!model) {
				return {
					content: [
						{
							type: "text",
							text: "No model available to answer (target model unavailable and no current model).",
						},
					],
					details: { targetSession: targetPath },
					isError: true,
				};
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Asking session ${basename(targetPath)} (${model.provider}/${model.id})…`,
					},
				],
				details: {},
			});

			// 4. Isolated in-memory sub-session. No tools, no extensions/skills/
			//    prompts/themes. Context files (AGENTS.md) from the target's cwd
			//    are kept so the sub-session inherits the target's working context.
			const loader = new DefaultResourceLoader({
				cwd: bCwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();

			const created = await createAgentSession({
				cwd: bCwd,
				agentDir: getAgentDir(),
				model,
				thinkingLevel: bctx.thinkingLevel as never,
				noTools: "all",
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(bCwd),
				authStorage,
				modelRegistry,
			});
			const sub = created.session;

			// 5. Inject original target history plus this pair's prior exchanges.
			// This is in-memory only: neither Pi session file is changed.
			const restoredBridge = bridgeContext(priorExchanges, targetSessionId);
			sub.agent.state.messages = restoredBridge.content
				? [
						...bctx.messages,
						{
							role: "custom",
							customType: "talk-to-sessions:bridge-history",
							content: restoredBridge.content,
							display: false,
							timestamp: Date.now(),
						},
					]
				: bctx.messages;

			// 6. Wire abort from the calling agent's signal.
			const onAbort = () => {
				void sub.abort().catch(() => {});
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			let answer = "";
			let usage: unknown;
			let promptError: string | undefined;
			try {
				await sub.prompt(`${PREFACE}\n\n${question}`, { expandPromptTemplates: false });
				const result = lastAssistantText(
					sub.messages as { role?: string; content?: unknown }[],
				);
				answer = result.text;
				usage = result.usage;
			} catch (err) {
				promptError = (err as Error).message;
			} finally {
				if (signal) signal.removeEventListener("abort", onAbort);
				sub.dispose();
			}

			if (promptError) {
				return {
					content: [
						{
							type: "text",
							text: `The target session's agent failed to respond: ${promptError}\n\nThis can happen if its context is too large for the model's window — try compacting that session first.`,
						},
					],
					details: { targetSession: targetPath, model: `${model.provider}/${model.id}` },
					isError: true,
				};
			}

			// A's tool call/result is already in A's session. Persist this complete
			// exchange only so B can recover it during a later call from A.
			let bridgeWriteNote = "";
			if (answer && callerSessionId && targetSessionId) {
				try {
					await saveBridgeExchange({
						version: BRIDGE_VERSION,
						occurredAt: new Date().toISOString(),
						callerSessionId,
						targetSessionId,
						question,
						answer,
						model: `${model.provider}/${model.id}`,
					});
				} catch (error) {
					bridgeWriteNote = `Could not save this cross-session exchange: ${(error as Error).message}`;
				}
			}

			// 7. Build the return: the answer verbatim, plus a compact provenance
			//    footer so the calling agent knows the source and that it may be
			//    stale relative to current files.
			let lastModified = "";
			try {
				lastModified = formatDate(statSync(targetPath).mtime);
			} catch {
				/* ignore */
			}
			const provenance = [
				`via session ${basename(targetPath)}`,
				lastModified ? `last modified ${lastModified}` : "",
				`model ${model.provider}/${model.id}`,
				restoredBridge.count ? `restored ${restoredBridge.count} prior exchange${restoredBridge.count === 1 ? "" : "s"}` : "",
				fallbackNote,
				bridgeReadNote,
				bridgeWriteNote,
			]
				.filter(Boolean)
				.join(" · ");

			const text = answer
				? `${answer}\n\n— [${provenance}]`
				: `(The other session's agent returned no text.)\n\n— [${provenance}]`;

			return {
				content: [{ type: "text", text }],
				details: {
					targetSession: targetPath,
					targetCwd: bCwd,
					model: `${model.provider}/${model.id}`,
					targetModelInfo: targetModelInfo
						? `${targetModelInfo.provider}/${targetModelInfo.modelId}`
						: null,
					fallbackNote: fallbackNote || undefined,
					restoredExchangeCount: restoredBridge.count,
					bridgeReadNote: bridgeReadNote || undefined,
					bridgeWriteNote: bridgeWriteNote || undefined,
					usage,
				},
			};
		},
	});

	// --------------------------------------------------------------------
	// Command: /sessions (human browsing)
	// --------------------------------------------------------------------
	pi.registerCommand("sessions", {
		description: "Browse recent pi sessions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const all = await SessionManager.listAll();
			const current = ctx.sessionManager.getSessionFile();
			const sessions = all
				.filter((s) => s.path !== current)
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 50);

			if (sessions.length === 0) {
				ctx.ui.notify("No other sessions found.", "info");
				return;
			}

			const labels = sessions.map((s, i) => {
				const title = preview(s.name || s.firstMessage || "(empty)", 70);
				const when = s.modified.toISOString().slice(0, 10);
				return `${i + 1}. ${when} · ${title} (${s.messageCount} msgs)`;
			});

			const choice = await ctx.ui.select("Pick a session:", labels);
			if (choice == null) return;
			const idx = labels.indexOf(choice);
			if (idx < 0) return;
			const s = sessions[idx];
			ctx.ui.notify(`${s.path}\ncwd: ${s.cwd || "?"}\nfirst: ${preview(s.firstMessage, 200)}`, "info");
		},
	});
}
