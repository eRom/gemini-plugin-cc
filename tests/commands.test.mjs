import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /gemini-companion\.mjs/);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny/i);
  assert.match(source, /recommend background/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /gemini-companion\.mjs/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny/i);
  assert.match(source, /recommend background/i);
  assert.match(source, /\(Recommended\)/);
});

test("command files exist in the expected set", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command routes to the gemini-rescue subagent", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/gemini-rescue.md");
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Gemini's output verbatim/i);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--model <model>/);
  assert.match(rescue, /AskUserQuestion|ask what Gemini should/i);
  assert.match(rescue, /gemini:gemini-rescue/);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Gemini companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /--write/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Return the stdout of the `gemini-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /gemini-companion\.mjs" result/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /gemini-companion\.mjs" cancel/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Gemini install and points users to gemini auth", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @google\/gemini-cli/);
  assert.match(setup, /gemini-companion\.mjs" setup --json/);
  assert.match(readme, /gemini/i);
  assert.match(readme, /\/gemini:setup/);
  assert.match(readme, /\/gemini:setup --enable-review-gate/);
  assert.match(readme, /\/gemini:setup --disable-review-gate/);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");

  assert.match(runtimeSkill, /gemini-companion\.mjs" task/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
});
