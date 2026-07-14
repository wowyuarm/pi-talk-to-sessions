# pi-talk-to-sessions

A [pi](https://github.com/earendil-works/pi) extension that lets the current
session's agent talk to **another** pi session's agent — using that other
session's conversation history as context.

## The mental model

You have two pi sessions. Session A is what you're working in right now.
Session B is an older session that already explored some problem in depth
(a design decision, a debug investigation, a research note).

You want to ask, from inside A: *"What did we conclude in B?"*

This extension gives the agent in A a way to do that without you manually
`/resume`-ing into B and back. The agent in A treats B as a **context
retrieval point**: it loads B's effective conversation history (read-only)
into a throwaway in-memory sub-session, asks B's last-used model a question,
and brings the answer back.

```
current session (you ↔ agent A)        target session B (on disk)
┌──────────────────────────┐           ┌─────────────────────────┐
│ current task context     │           │ B's full history        │
│ A already retains result │  ask ──►  │ B's last-used model     │
│ answer brought back ◄─── │           │ answers from its memory │
└──────────────────────────┘           └─────────────────────────┘
                  │                         ▲
                  └──── exchange sidecar ───┘
                    only restores A ↔ B history to B
```

Key properties:

- **Neither Pi session is modified by the bridge.** B's `.jsonl` file is
  opened read-only. A already stores its own tool call and result normally.
  A small external sidecar is the only added persistence: it retains completed
  A ↔ B exchanges solely so B can recover its missing half on a later call.
- **B's model is inherited.** The sub-session uses the model B was last
  using, so you're talking to "the same agent that has B's memory." If that
  model is no longer available, it falls back to the current session's model
  and says so.
- **B's context is inherited, not its raw log.** The sub-session loads B's
  *effective* context (what `buildSessionContext` produces — compaction
  summaries plus recent turns), so a compacted B still answers coherently.
- **No tools for B.** The sub-session has zero tools. It can only answer
  from memory — it cannot read files, run commands, or recurse into other
  sessions. It is a context retrieval point, not another worker.
- **Isolated environment.** The sub-session loads no other extensions,
  skills, prompt templates, or themes. (It does inherit B's working
  directory's `AGENTS.md` context files, since those are part of B's working
  context.)
- **Prior exchanges are restored only for B.** A already has them in its own
  session. B receives a temporary, clearly marked `you / other agent` history
  before the new question; it is not written into B's session file.
- **A short preface is prepended to the question** so B's agent can distinguish
  the new request from its original context and restored exchange history.

## Install

Requires pi 0.80.0 or newer. Tested with pi 0.80.2.

As a local path package (while developing):

```bash
pi install /home/yu/projects/pi-talk-to-sessions
```

Or, from the project directory, test it without installing:

```bash
pi -e ./extensions/talk-to-sessions.ts
```

## Tools

### `list_sessions`

Lists recent pi sessions across all projects (excluding the current one),
most recent first. Each entry shows a path, working directory, first user
message, message count, and last modified time. Use this to find the session
you want to talk to.

Parameters:
- `limit` (optional, default 10, max 100) — number of sessions to return.

### `talk_to_session`

Asks a question to another session's agent. That session's history is loaded
read-only and its last-used model answers.

Parameters:
- `session` — the target session: either its file path, or a distinctive
  phrase from its first user message (matched case-insensitively).
- `question` — the question to ask, written by the calling agent. Sent
  verbatim, with a short preface prepended that tells the target agent who is
  asking.

The returned text is the target agent's answer, followed by a compact
provenance footer (source file, last modified time, model used, and any
fallback note) so the calling agent knows the answer may be stale relative
to current files.

## Command

### `/sessions`

Browse recent sessions interactively (for humans). Picks one and shows its
path, working directory, and first message.

## Design notes

- **Continuing exchange, without polluting sessions.** Each call still uses a
  fresh in-memory sub-session, but successful exchanges are saved under
  `~/.pi/agent/talk-to-sessions/<session-id>--<session-id>/`. On a later call
  between the same two sessions, up to the latest 12 exchanges (and 24,000
  characters) are restored to B as `you / other agent` context. Each exchange
  is a separate immutable file, so concurrent calls cannot overwrite history.
- **Cost.** Each call is a full LLM completion carrying B's effective context
  plus the restored exchange history. The larger either is, the more tokens.
- **Staleness.** B's answers reflect its state as of its last turn. They are
  reliable for "what did we decide" but may be out of date for "what does the
  code look like now." The provenance footer makes this visible.
