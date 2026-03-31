import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeGemini(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  const scriptPath = path.join(binDir, "gemini");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { invocations: 0, lastPrompt: null, lastModel: null, lastOutputFormat: null };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("gemini-cli test");
  process.exit(0);
}

let prompt = "";
let outputFormat = "text";
let model = null;
let sandbox = false;
let yolo = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p" && args[i + 1]) { prompt = args[i + 1]; i++; }
  else if (args[i] === "--output-format" && args[i + 1]) { outputFormat = args[i + 1]; i++; }
  else if (args[i] === "-m" && args[i + 1]) { model = args[i + 1]; i++; }
  else if (args[i] === "--sandbox") { sandbox = true; }
  else if (args[i] === "--yolo") { yolo = true; }
}

const state = loadState();
state.invocations += 1;
state.lastPrompt = prompt;
state.lastModel = model;
state.lastOutputFormat = outputFormat;
state.lastSandbox = sandbox;
state.lastYolo = yolo;
saveState(state);

// Auth check: simple "hello" prompt
if (prompt === "hello") {
  if (BEHAVIOR === "logged-out") {
    console.error("not authenticated - please sign in with gemini auth login");
    process.exit(1);
  }
  if (outputFormat === "json") {
    console.log(JSON.stringify({ response: "Hello!" }));
  } else {
    console.log("Hello!");
  }
  process.exit(0);
}

// Stop gate review (text output, contains stop-gate markers)
if (prompt.includes("Only review the work from the previous Claude turn") || prompt.includes("stop-gate review")) {
  if (BEHAVIOR === "adversarial-clean") {
    console.log("ALLOW: No blocking issues found in the previous turn.");
  } else {
    console.log("BLOCK: Missing empty-state guard in src/app.js:4-6.");
  }
  process.exit(0);
}

// Adversarial review (structured JSON)
if (prompt.includes("adversarial software review") || prompt.includes("adversarial")) {
  const result = BEHAVIOR === "adversarial-clean"
    ? { verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] }
    : {
        verdict: "needs-attention",
        summary: "One adversarial concern surfaced.",
        findings: [{
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }],
        next_steps: ["Add an empty-state test."]
      };
  console.log(JSON.stringify({ response: JSON.stringify(result) }));
  process.exit(0);
}

// Standard review (structured JSON)
if (prompt.includes("code review") || prompt.includes("Review the provided repository")) {
  if (BEHAVIOR === "invalid-json") {
    console.log("not valid json");
    process.exit(0);
  }
  const result = { verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] };
  console.log(JSON.stringify({ response: JSON.stringify(result) }));
  process.exit(0);
}

// Slow task
if (BEHAVIOR === "slow-task") {
  setTimeout(() => {
    console.log(JSON.stringify({ response: "Handled the requested task.\\nTask prompt accepted." }));
    process.exit(0);
  }, 400);
} else {
  // Default task response
  console.log(JSON.stringify({ response: "Handled the requested task.\\nTask prompt accepted." }));
  process.exit(0);
}
`;
  writeExecutable(scriptPath, source);
}

export function buildEnv(binDir) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`
  };
}
