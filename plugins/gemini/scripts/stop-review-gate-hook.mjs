#!/usr/bin/env node

/**
 * Stop review gate hook — runs a Gemini adversarial review before
 * allowing Claude to stop, if the review gate is enabled.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { runGeminiHeadless } from "./lib/gemini.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // If the review gate is not enabled, allow immediately.
  if (!config.stopReviewGate) {
    process.stdout.write(`${JSON.stringify({ decision: "allow", reason: "Review gate is disabled." })}\n`);
    return;
  }

  // Get the last assistant message from the hook input.
  const lastMessage = input.last_assistant_message ?? input.transcript_suffix ?? "";
  if (!lastMessage.trim()) {
    process.stdout.write(`${JSON.stringify({ decision: "allow", reason: "No previous assistant message found." })}\n`);
    return;
  }

  // Build the stop-gate prompt.
  const template = loadPromptTemplate(PLUGIN_ROOT, "stop-review-gate");
  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: lastMessage
  });

  // Run Gemini review in headless mode.
  const result = await runGeminiHeadless(cwd, {
    prompt,
    sandbox: true,
    outputFormat: "text",
    env: process.env
  });

  const output = result.stdout.trim();
  const firstLine = output.split("\n")[0] ?? "";

  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || "Gemini found issues in the last turn.";
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  } else {
    const reason = firstLine.startsWith("ALLOW:") ? firstLine.slice("ALLOW:".length).trim() : "No blocking issues found.";
    process.stdout.write(`${JSON.stringify({ decision: "allow", reason })}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ decision: "allow", reason: `Gate error: ${error.message}` })}\n`);
});
