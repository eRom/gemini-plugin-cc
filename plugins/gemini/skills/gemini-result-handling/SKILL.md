---
name: gemini-result-handling
description: Internal guidance for presenting Gemini helper output back to the user
user-invocable: false
---

# Gemini Result Handling

When the helper returns Gemini output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Gemini marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Gemini made edits, say so explicitly and list the touched files when the helper provides them.
- For `gemini:gemini-rescue`, do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt. Report the failure and stop.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file.
- If the helper reports malformed output or a failed Gemini run, include the most actionable stderr lines and stop there.
- If the helper reports that setup or authentication is required, direct the user to `/gemini:setup`.
