/**
 * gemini.mjs — Headless Gemini CLI wrapper.
 *
 * Replaces the entire codex.mjs + app-server.mjs + broker stack with
 * simple process spawning.  Gemini CLI is invoked in non-interactive
 * mode (`gemini -p "..." --output-format json`) and the result is
 * captured from stdout.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, runCommand } from "./process.mjs";
import { readJsonFile } from "./fs.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const GEMINI_BINARY = "gemini";

const MODEL_ALIASES = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-2.5-flash",
  "flash-lite": "gemini-2.5-flash-lite"
};

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

export function checkGeminiAvailable(options = {}) {
  return binaryAvailable(GEMINI_BINARY, ["--version"], options);
}

export function checkGeminiAuth(options = {}) {
  const result = runCommand(GEMINI_BINARY, ["-p", "hello", "--output-format", "json"], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env
  });

  if (result.error?.code === "ENOENT") {
    return { authenticated: false, detail: "gemini not found" };
  }

  if (result.status !== 0) {
    const msg = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    if (/auth|login|sign.?in|credential|token/i.test(msg)) {
      return { authenticated: false, detail: msg };
    }
    // Non-auth failure still means the binary runs.
    return { authenticated: true, detail: msg };
  }

  return { authenticated: true, detail: "ok" };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export function resolveModel(requested) {
  if (!requested) {
    return DEFAULT_MODEL;
  }
  return MODEL_ALIASES[requested] ?? requested;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parse structured JSON from Gemini CLI `--output-format json` output.
 *
 * The Gemini CLI JSON output wraps the model response in a top-level
 * object.  We extract the text content and attempt to parse it as the
 * review schema JSON.
 */
export function parseGeminiJsonOutput(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return { parsed: null, rawOutput: "", parseError: "Empty output" };
  }

  // Try parsing the full stdout as JSON first (Gemini --output-format json).
  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    // Not valid JSON — treat as raw text.
    return { parsed: null, rawOutput: trimmed, parseError: "Output is not valid JSON" };
  }

  // Gemini CLI JSON envelope: { response: string, ... } or { text: string }
  const responseText =
    typeof envelope.response === "string"
      ? envelope.response
      : typeof envelope.text === "string"
        ? envelope.text
        : typeof envelope.result === "string"
          ? envelope.result
          : null;

  if (responseText) {
    return extractJsonFromText(responseText);
  }

  // Maybe the envelope IS the review result directly.
  if (envelope.verdict && envelope.summary) {
    return { parsed: envelope, rawOutput: trimmed, parseError: null };
  }

  return { parsed: null, rawOutput: trimmed, parseError: "Could not locate response text in JSON envelope" };
}

function extractJsonFromText(text) {
  const trimmed = text.trim();

  // Try direct parse.
  try {
    const parsed = JSON.parse(trimmed);
    return { parsed, rawOutput: trimmed, parseError: null };
  } catch {
    // Continue to fenced block extraction.
  }

  // Extract from ```json ... ``` fenced blocks.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      return { parsed, rawOutput: trimmed, parseError: null };
    } catch (error) {
      return { parsed: null, rawOutput: trimmed, parseError: `Fenced JSON parse failed: ${error.message}` };
    }
  }

  return { parsed: null, rawOutput: trimmed, parseError: "No JSON found in response text" };
}

// ---------------------------------------------------------------------------
// Core execution — spawn Gemini CLI in headless mode
// ---------------------------------------------------------------------------

/**
 * Run a Gemini CLI prompt in headless mode and capture the result.
 *
 * @param {string} cwd - Working directory
 * @param {object} options
 * @param {string} options.prompt - The prompt to send
 * @param {string} [options.model] - Model name or alias
 * @param {boolean} [options.sandbox] - Run in sandbox mode (read-only)
 * @param {boolean} [options.yolo] - Auto-approve all tool calls
 * @param {string} [options.systemPromptFile] - Path to custom system prompt
 * @param {string} [options.outputFormat] - json | stream-json | text
 * @param {Function} [options.onProgress] - Progress callback
 * @param {object} [options.env] - Custom environment
 * @returns {Promise<{exitStatus: number, stdout: string, stderr: string}>}
 */
export async function runGeminiHeadless(cwd, options = {}) {
  const args = ["-p", options.prompt];

  // Output format
  const outputFormat = options.outputFormat ?? "json";
  args.push("--output-format", outputFormat);

  // Model
  const model = resolveModel(options.model);
  args.push("-m", model);

  // Sandbox
  if (options.sandbox) {
    args.push("--sandbox");
  }

  // Auto-approve (for write tasks)
  if (options.yolo) {
    args.push("--yolo");
  }

  // Build env
  const env = { ...(options.env ?? process.env) };

  // Custom system prompt via file
  if (options.systemPromptFile && fs.existsSync(options.systemPromptFile)) {
    env.GEMINI_SYSTEM_MD = options.systemPromptFile;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(GEMINI_BINARY, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      if (options.onProgress) {
        const line = chunk.toString("utf8").trim();
        if (line) {
          options.onProgress({ message: `Gemini: ${line.slice(0, 120)}`, phase: "running" });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (options.onProgress) {
        const line = chunk.toString("utf8").trim();
        if (line) {
          options.onProgress({ message: line.slice(0, 200), stderrMessage: line.slice(0, 200) });
        }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitStatus: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}

// ---------------------------------------------------------------------------
// High-level: run a review
// ---------------------------------------------------------------------------

/**
 * Run a Gemini review with a structured prompt and parse the JSON result.
 */
export async function runGeminiReview(cwd, prompt, options = {}) {
  const result = await runGeminiHeadless(cwd, {
    prompt,
    model: options.model,
    sandbox: true, // Reviews are always read-only.
    outputFormat: "json",
    onProgress: options.onProgress,
    env: options.env
  });

  if (options.onProgress) {
    options.onProgress({ message: "Response received", phase: "finalizing" });
  }

  const parsed = parseGeminiJsonOutput(result.stdout);

  return {
    exitStatus: result.exitStatus,
    parsed,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

// ---------------------------------------------------------------------------
// High-level: run a task (rescue / delegation)
// ---------------------------------------------------------------------------

/**
 * Run a Gemini task (write-capable or read-only).
 */
export async function runGeminiTask(cwd, prompt, options = {}) {
  const result = await runGeminiHeadless(cwd, {
    prompt,
    model: options.model,
    sandbox: !options.write,
    yolo: options.write,
    outputFormat: "json",
    onProgress: options.onProgress,
    env: options.env
  });

  if (options.onProgress) {
    options.onProgress({ message: "Gemini completed", phase: "finalizing" });
  }

  // Extract raw text from JSON envelope
  let rawOutput = "";
  try {
    const envelope = JSON.parse(result.stdout.trim());
    rawOutput = envelope.response ?? envelope.text ?? envelope.result ?? result.stdout;
  } catch {
    rawOutput = result.stdout;
  }

  return {
    exitStatus: result.exitStatus,
    rawOutput: typeof rawOutput === "string" ? rawOutput : result.stdout,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
