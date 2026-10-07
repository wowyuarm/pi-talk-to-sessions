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
 *
 * pi 1.0 notes:
 * - The host's `ctx.modelRegistry` is used directly for model lookup, so no
 *   separate auth/registry cache is kept (and it can never go stale).
 * - `createAgentSession()` no longer takes `authStorage`/`modelRegistry`; it
 *   builds a default `ModelRuntime` from the same `agentDir` files.
 * - `SessionManager` owns finalized model context: target history is restored
 *   by preloading an in-memory manager with the target's entries (plus one
 *   `custom_message` entry for bridge history). Assigning
 *   `agent.state.messages` directly no longer affects persisted context.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	createAgentSession,
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

/** Cap for the interactive /sessions picker. */
const MAX_PICKER = 50;

/** Custom message type marking restored bridge history inside the sub-session. */
const BRIDGE_CUSTOM_TYPE = "talk-to-sessions:bridge-history";

/** Prior exchanges live beside, never inside, Pi session files. */
const BRIDGE_DIR = "talk-to-sessions";
const BRIDGE_VERSION = 1;
const MAX_BRIDGE_EXCHANGES = 12;
const MAX_BRIDGE_FILES = MAX_BRIDGE_EXCHANGES * 2;
const MAX_BRIDGE_CONTEXT_CHARS = 24_000;
const MAX_BRIDGE_QUESTION_CHARS = 6_000;
const MAX_BRIDGE_ANSWER_CHARS = 12_000;

/** Max options shown when a session reference is ambiguous. */
const MAX_MATCH_OPTIONS = 8;

/** Minimum characters before trying session-ID prefix matching. */
const MIN_ID_PREFIX = 4;

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
	const dir = bridgePairDir(callerSessionId, targetSessionId);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	}

	const recentNames = names
		.filter((name) => name.endsWith(".json"))
		.sort()
		.slice(-MAX_BRIDGE_FILES);
	const exchanges: BridgeExchange[] = [];
	for (const name of recentNames) {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
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

	// Best-effort pruning so stale sidecar files cannot accumulate forever.
	try {
		const names = (await readdir(dir))
			.filter((entry) => entry.endsWith(".json"))
			.sort();
		const excess = names.slice(0, Math.max(0, names.length - MAX_BRIDGE_FILES));
		await Promise.all(excess.map((entry) => unlink(join(dir, entry)).catch(() => {})));
	} catch {
		// Pruning must never fail the conversation.
	}
}

function toResolved(s: SessionInfo): ResolvedSession {
	return {
		path: s.path,
		cwd: s.cwd || "",
		firstMessage: s.firstMessage || "(empty)",
		name: s.name,
	};
}

function matchOptions(ref: string, matches: SessionInfo[]): string {
	const shown = matches
		.slice(0, MAX_MATCH_OPTIONS)
		.map((s, i) => `${i + 1}. ${preview(s.name || s.firstMessage, 120)}\n   path: ${s.path}`)
		.join("\n\n");
	const more =
		matches.length > MAX_MATCH_OPTIONS ? `\n\n… and ${matches.length - MAX_MATCH_OPTIONS} more.` : "";
	return (
		`Multiple sessions match "${ref}". Pass a more specific phrase, a session ID, or a path:\n\n` +
		`${shown}${more}`
	);
}

/** Resolve a session reference (file path, basename, session ID, or a phrase
 * from its first user message / display name) to a session. Phrase and ID
 * matching search every project; use list_sessions to browse first. Returns
 * an error string on failure. */
async function resolveSession(
	sessionRef: string,
	currentFile: string | undefined,
): Promise<ResolvedSession | { error: string }> {
	const ref = sessionRef.trim();

	// 1. Direct file path.
	if (existsSync(ref)) {
		try {
			const reader = SessionManager.open(ref);
			return {
				path: ref,
				cwd: reader.getCwd() || "",
				firstMessage: firstUserMessage(reader.getEntries()) ?? "(empty)",
				name: reader.getSessionName() ?? undefined,
			};
		} catch {
			return { error: `Could not open session file: ${ref}` };
		}
	}

	const all = (await SessionManager.listAll()).filter((s) => s.path !== currentFile);
	const lower = ref.toLowerCase();

	// 2. Exact session path, file basename, or session ID.
	const exact = all.filter(
		(s) => s.path === ref || basename(s.path) === ref || s.id === ref || s.id.toLowerCase() === lower,
	);
	if (exact.length === 1) return toResolved(exact[0]);
	if (exact.length > 1) return { error: matchOptions(ref, exact) };

	// 3. Unique session-ID prefix (avoids flooding on very short input).
	if (ref.length >= MIN_ID_PREFIX) {
		const prefixed = all.filter((s) => s.id.toLowerCase().startsWith(lower));
		if (prefixed.length === 1) return toResolved(prefixed[0]);
		if (prefixed.length > 1) return { error: matchOptions(ref, prefixed) };
	}

	// 4. Phrase from the display name or first user message (case-insensitive).
	const matches = all
		.filter((s) => `${s.name || ""} ${s.firstMessage || ""}`.toLowerCase().includes(lower))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	if (matches.length === 0) {
		return {
			error: `No session found matching "${ref}". Call list_sessions to see available sessions.`,
		};
	}
	if (matches.length > 1) return { error: matchOptions(ref, matches) };
	return toResolved(matches[0]);
}

/** Find the first user text message in a list of session entries. */
function firstUserMessage(entries: SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg?.role === "user") {
				const content = msg.content;
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					const text = content
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join(" ");
					if (text) return text;
				}
			}
		}
	}
	return undefined;
}

/** Find usage on the last assistant message carrying one. */
function lastAssistantUsage(messages: readonly { role?: string; usage?: unknown }[]): unknown {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant" && m.usage) return m.usage;
	}
	return undefined;
}

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

export default function (pi: ExtensionAPI) {
	// --------------------------------------------------------------------
	// Tool: list_sessions
	// --------------------------------------------------------------------
	pi.registerTool({
		name: "list_sessions",
		label: "List Sessions",
		description: [
			"List recent pi sessions for the current project (same working directory),",
			"most recent first, excluding the current session. Each entry shows a path,",
			"working directory, first user message, message count, and last modified",
			"time. Use this to find a session to talk to, then pass its path (or a",
			"distinctive phrase from its first message) to talk_to_session.",
			"Pass a different cwd to browse another project, or all=true to list",
			"sessions across every project.",
		].join(" "),
		promptSnippet: "List recent pi sessions to find one to talk to",
		promptGuidelines: [
			"Use list_sessions when the user refers to another session by its topic or first message and you need to find its path. It lists the current project by default; pass all=true to search every project.",
		],
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({
					description: "Max sessions to return (most recent first). Default 10.",
					default: 10,
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory whose sessions to list. Defaults to the current session's directory.",
				}),
			),
			all: Type.Optional(
				Type.Boolean({
					description: "List sessions across all projects instead of just the current one. Default false.",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const limit = Math.max(1, Math.min(params.limit ?? 10, MAX_LIST));
			const current = ctx.sessionManager.getSessionFile();
			const scopeCwd = params.cwd?.trim() || ctx.sessionManager.getCwd() || ctx.cwd;

			let sessions: SessionInfo[];
			let scopeLabel: string;
			if (params.all) {
				const allSessions = await SessionManager.listAll(undefined, undefined, signal);
				sessions = allSessions
					.filter((s) => s.path !== current)
					.sort(byModifiedDesc)
					.slice(0, limit);
				scopeLabel = "all projects";
			} else {
				const scoped = await SessionManager.list(scopeCwd, undefined, undefined, signal);
				sessions = scoped
					.filter((s) => s.path !== current)
					.sort(byModifiedDesc)
					.slice(0, limit);
				scopeLabel = scopeCwd;
			}

			if (sessions.length === 0) {
				const hint = params.all
					? "No other sessions found."
					: `No other sessions found for ${scopeCwd}. Pass all=true to search every project.`;
				return {
					content: [{ type: "text", text: hint }],
					details: { count: 0, scope: scopeLabel },
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
						text: `Recent sessions for ${scopeLabel} (excluding current), ${sessions.length} shown:\n\n${lines.join("\n\n")}`,
					},
				],
				details: {
					count: sessions.length,
					scope: scopeLabel,
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
					"Target session: its file path, file basename, session ID (exact or unique prefix), or a distinctive phrase from its first user message or display name (matched case-insensitively across all projects).",
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

			// 3. Resolve models: prefer the target session's last model, with the
			//    current session's model as fallback. Auth is only proven at
			//    request time (a provider can look configured yet fail key
			//    resolution when called), so a failed first attempt retries once
			//    with the fallback model instead of trusting a pre-check.
			const registry = ctx.modelRegistry;
			const targetModel = targetModelInfo
				? registry.find(targetModelInfo.provider, targetModelInfo.modelId)
				: undefined;
			const fallbackModel = ctx.model;
			let model = targetModel ?? fallbackModel;
			let fallbackNote = "";
			if (!targetModel && targetModelInfo) {
				fallbackNote = `Target session's model (${targetModelInfo.provider}/${targetModelInfo.modelId}) is not available; fell back to current session's model.`;
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
			//    The target's entries are preloaded into the manager (the owner of
			//    finalized model context), plus one hidden custom message carrying
			//    this pair's prior exchanges. Nothing is written to either Pi
			//    session file. A fresh manager is built per attempt so a failed
			//    attempt leaves no trace in the retry.
			const loader = new DefaultResourceLoader({
				cwd: bCwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();

			const restoredBridge = bridgeContext(priorExchanges, targetSessionId);
			const askWithModel = async (attemptModel: typeof model) => {
				const subManager = SessionManager.inMemory(bCwd, undefined, reader.getEntries());
				if (restoredBridge.content) {
					subManager.appendCustomMessageEntry(BRIDGE_CUSTOM_TYPE, restoredBridge.content, false);
				}
				const created = await createAgentSession({
					cwd: bCwd,
					agentDir: getAgentDir(),
					model: attemptModel,
					thinkingLevel: bctx.thinkingLevel as never,
					noTools: "all",
					resourceLoader: loader,
					sessionManager: subManager,
				});
				const sub = created.session;

				// 5. Wire abort from the calling agent's signal.
				const onAbort = () => {
					void sub.abort().catch(() => {});
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				try {
					await sub.prompt(`${PREFACE}\n\n${question}`, { expandPromptTemplates: false });
					return {
						answer: sub.getLastAssistantText() ?? "",
						usage: lastAssistantUsage(
							sub.messages as { role?: string; usage?: unknown }[],
						),
					};
				} finally {
					if (signal) signal.removeEventListener("abort", onAbort);
					sub.dispose();
				}
			};

			let answer = "";
			let usage: unknown;
			let promptError: string | undefined;
			try {
				({ answer, usage } = await askWithModel(model));
			} catch (err) {
				const firstError = (err as Error).message;
				const canRetry =
					fallbackModel &&
					model !== fallbackModel &&
					/api key|auth|credential|login|unauthorized|forbidden/i.test(firstError);
				if (!canRetry) {
					promptError = firstError;
				} else {
					const firstLine = firstError.split("\n")[0];
					fallbackNote = `Target session's model (${model.provider}/${model.id}) failed at request time (${firstLine}); fell back to current session's model.`;
					model = fallbackModel;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Retrying session ${basename(targetPath)} (${model.provider}/${model.id})…`,
							},
						],
						details: {},
					});
					try {
						({ answer, usage } = await askWithModel(model));
					} catch (retryErr) {
						promptError = (retryErr as Error).message;
					}
				}
			}

			if (promptError) {
					const hint = /api key|auth|credential|login|unauthorized|forbidden/i.test(promptError)
					? "The model's credentials failed at request time — check that its provider is logged in, then try again."
					: "This can happen if its context is too large for the model's window — try compacting that session first.";
				return {
					content: [
						{
							type: "text",
							text: `The target session's agent failed to respond: ${promptError}\n\n${hint}`,
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

			// 6. Build the return: the answer verbatim, plus a compact provenance
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
	// Command: /sessions (human browsing; current project by default)
	// --------------------------------------------------------------------
	pi.registerCommand("sessions", {
		description: "Browse recent pi sessions (current project; 'all' for every project)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim();
			const current = ctx.sessionManager.getSessionFile();

			let sessions: SessionInfo[];
			let scopeLabel: string;
			if (arg === "all") {
				const allSessions = await SessionManager.listAll(undefined, undefined, ctx.signal ?? undefined);
				sessions = allSessions
					.filter((s) => s.path !== current)
					.sort(byModifiedDesc)
					.slice(0, MAX_PICKER);
				scopeLabel = "all projects";
			} else {
				const dir = arg || ctx.sessionManager.getCwd() || ctx.cwd;
				const scoped = await SessionManager.list(dir, undefined, undefined, ctx.signal ?? undefined);
				sessions = scoped
					.filter((s) => s.path !== current)
					.sort(byModifiedDesc)
					.slice(0, MAX_PICKER);
				scopeLabel = dir;
			}

			if (sessions.length === 0) {
				ctx.ui.notify(`No other sessions found (${scopeLabel}).`, "info");
				return;
			}

			const labels = sessions.map((s, i) => {
				const title = preview(s.name || s.firstMessage || "(empty)", 70);
				const when = s.modified.toISOString().slice(0, 10);
				return `${i + 1}. ${when} · ${title} (${s.messageCount} msgs)`;
			});

			const choice = await ctx.ui.select(`Pick a session (${scopeLabel}):`, labels);
			if (choice == null) return;
			const idx = labels.indexOf(choice);
			if (idx < 0) return;
			const s = sessions[idx];
			ctx.ui.notify(`${s.path}\ncwd: ${s.cwd || "?"}\nfirst: ${preview(s.firstMessage, 200)}`, "info");
		},
	});
}
