---
description: Delegate investigation or fix requests to the Gemini rescue subagent
argument-hint: "[--background|--wait] [--model <model>] [--write] [what Gemini should investigate or fix]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `gemini:gemini-rescue` subagent.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- If the request includes `--background`, run the `gemini:gemini-rescue` subagent in the background.
- If the request includes `--wait`, run in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call.
- If the user did not supply a request, ask what Gemini should investigate or fix.

Operating rules:
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary.
- Do not ask the subagent to inspect files, monitor progress, poll `/gemini:status`, fetch `/gemini:result`, call `/gemini:cancel`, or do follow-up work.
- Leave model unset unless the user explicitly asks for one.
- Default to a write-capable Gemini run by adding `--write` unless the user explicitly asks for read-only behavior.
