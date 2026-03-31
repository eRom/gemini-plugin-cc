#!/usr/bin/env node

/**
 * gemini-companion.mjs — Main CLI entry point for the Gemini Claude Code plugin.
 *
 * Subcommands:
 *   setup                  Check readiness and optionally toggle review gate
 *   review                 Standard code review via Gemini
 *   adversarial-review     Adversarial review via Gemini
 *   task                   Delegate a task to Gemini
 *   task-worker            Background task worker
 *   status                 Show job status
 *   result                 Show stored job result
 *   cancel                 Cancel an active job
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  checkGeminiAvailable,
  checkGeminiAuth,
  resolveModel,
  runGeminiReview,
  runGeminiTask,
  parseGeminiJsonOutput
} from "./lib/gemini.mjs";
import {
  collectBranchReviewContext,
  collectWorkingTreeReviewContext,
  ensureGitRepository,
  resolveBaseBranch
} from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  enrichJob,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  createJobProgressUpdater,
  createProgressReporter,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(text) {
  process.stdout.write(text);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Toggle review gate
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
  }
  if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
  }

  const nodeCheck = binaryAvailable("node");
  const npmCheck = binaryAvailable("npm");
  const geminiCheck = checkGeminiAvailable();
  const authCheck = geminiCheck.available ? checkGeminiAuth({ cwd }) : { authenticated: false, detail: "gemini not available" };
  const config = getConfig(workspaceRoot);

  const report = {
    ready: geminiCheck.available && authCheck.authenticated,
    node: nodeCheck,
    npm: npmCheck,
    gemini: geminiCheck,
    auth: authCheck,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken: [],
    nextSteps: []
  };

  if (!geminiCheck.available) {
    report.nextSteps.push("Install Gemini CLI: npm install -g @google/gemini-cli");
  } else if (!authCheck.authenticated) {
    report.nextSteps.push("Authenticate: run `!gemini` in Claude Code to trigger the login flow.");
  }

  if (options.json) {
    output(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    output(renderSetupReport(report));
  }
}

// ---------------------------------------------------------------------------
// Review target resolution
// ---------------------------------------------------------------------------

function resolveReviewTarget(cwd, argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"]
  });

  const scope = options.scope ?? "auto";
  const baseRef = options.base ?? null;

  const gitRoot = ensureGitRepository(cwd);

  if (baseRef || scope === "branch") {
    const base = baseRef ?? resolveBaseBranch(gitRoot);
    const context = collectBranchReviewContext(gitRoot, base);
    return {
      kind: "branch",
      label: `branch review against ${base}`,
      context,
      gitRoot
    };
  }

  const context = collectWorkingTreeReviewContext(gitRoot);
  return {
    kind: "working-tree",
    label: "working tree review",
    context,
    gitRoot
  };
}

// ---------------------------------------------------------------------------
// Review commands
// ---------------------------------------------------------------------------

async function executeReviewRun(cwd, argv, reviewKind) {
  const target = resolveReviewTarget(cwd, argv);

  if (!target.context.trim()) {
    output("Nothing to review — the working tree is clean.\n");
    return;
  }

  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model"],
    booleanOptions: ["wait", "background"]
  });

  const model = resolveModel(options.model);
  const isAdversarial = reviewKind === "adversarial-review";
  const promptTemplate = isAdversarial ? "adversarial-review" : "review";
  const reviewLabel = isAdversarial ? "Adversarial Review" : "Review";
  const userFocus = positionals.join(" ").trim();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Build prompt
  const template = loadPromptTemplate(PLUGIN_ROOT, promptTemplate);
  const prompt = interpolateTemplate(template, {
    TARGET_LABEL: target.label,
    USER_FOCUS: userFocus || "(none specified)",
    REVIEW_INPUT: target.context
  });

  // Create job
  const jobId = generateJobId("rev");
  const logFile = createJobLogFile(workspaceRoot, jobId, `Gemini ${reviewLabel}`);
  const job = createJobRecord({
    id: jobId,
    kind: reviewKind,
    jobClass: "review",
    status: "queued",
    title: `Gemini ${reviewLabel}: ${target.label}`,
    workspaceRoot,
    logFile,
    write: false
  });
  writeJobFile(workspaceRoot, jobId, job);
  upsertJob(workspaceRoot, job);

  const progressUpdater = createJobProgressUpdater(workspaceRoot, jobId);
  const reporter = createProgressReporter({
    stderr: true,
    logFile,
    onEvent: progressUpdater
  });

  reporter({ message: `Starting Gemini ${reviewLabel}`, phase: "starting" });

  const execution = await runTrackedJob(job, async () => {
    const result = await runGeminiReview(cwd, prompt, {
      model,
      onProgress: reporter,
      env: process.env
    });

    const parsed = result.parsed;
    const rendered = renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: target.label
    });

    const summary = parsed.parsed
      ? `${parsed.parsed.verdict}: ${parsed.parsed.summary?.slice(0, 120) ?? ""}`
      : "Review completed (parse error)";

    return {
      exitStatus: result.exitStatus,
      payload: parsed,
      rendered,
      summary
    };
  }, { logFile });

  output(execution.rendered);
}

async function handleReview(argv) {
  await executeReviewRun(process.cwd(), argv, "review");
}

async function handleAdversarialReview(argv) {
  await executeReviewRun(process.cwd(), argv, "adversarial-review");
}

// ---------------------------------------------------------------------------
// Task commands
// ---------------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "effort"],
    booleanOptions: ["wait", "background", "write", "resume-last"]
  });

  const taskText = positionals.join(" ").trim();
  if (!taskText) {
    fail("No task text provided. Usage: gemini-companion task <what Gemini should do>");
  }

  const cwd = process.cwd();
  const model = resolveModel(options.model);
  const write = Boolean(options.write);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Create job
  const jobId = generateJobId("tsk");
  const logFile = createJobLogFile(workspaceRoot, jobId, "Gemini rescue task");
  const job = createJobRecord({
    id: jobId,
    kind: "task",
    jobClass: "task",
    status: "queued",
    title: `Gemini task: ${taskText.slice(0, 80)}`,
    workspaceRoot,
    logFile,
    write
  });
  writeJobFile(workspaceRoot, jobId, job);
  upsertJob(workspaceRoot, job);

  const progressUpdater = createJobProgressUpdater(workspaceRoot, jobId);
  const reporter = createProgressReporter({
    stderr: true,
    logFile,
    onEvent: progressUpdater
  });

  reporter({ message: "Starting Gemini task", phase: "starting" });

  const execution = await runTrackedJob(job, async () => {
    const result = await runGeminiTask(cwd, taskText, {
      model,
      write,
      onProgress: reporter,
      env: process.env
    });

    const rendered = renderTaskResult({ rawOutput: result.rawOutput });
    const summary = result.rawOutput
      ? result.rawOutput.slice(0, 120).replace(/\n/g, " ")
      : "Task completed";

    return {
      exitStatus: result.exitStatus,
      payload: { rawOutput: result.rawOutput },
      rendered,
      summary
    };
  }, { logFile });

  output(execution.rendered);
}

async function handleTaskWorker(argv) {
  // Background worker — identical logic to handleTask but designed
  // to be spawned as a detached process.
  await handleTask(argv);
}

// ---------------------------------------------------------------------------
// Status / Result / Cancel
// ---------------------------------------------------------------------------

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "wait", "all"],
    valueOptions: ["timeout-ms"]
  });

  const cwd = process.cwd();
  const jobReference = positionals[0] ?? null;

  if (jobReference) {
    const snapshot = buildSingleJobSnapshot(cwd, jobReference, { maxProgressLines: 20 });
    if (options.json) {
      output(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      output(renderJobStatusReport(snapshot.job));
    }
    return;
  }

  const report = buildStatusSnapshot(cwd, {
    all: Boolean(options.all),
    env: process.env
  });

  if (options.json) {
    output(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    output(renderStatusReport(report));
  }
}

function handleResult(argv) {
  const { positionals } = parseArgs(argv, {});
  const cwd = process.cwd();
  const reference = positionals[0] ?? null;

  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);

  output(renderStoredJobResult(job, storedJob));
}

function handleCancel(argv) {
  const { positionals } = parseArgs(argv, {});
  const cwd = process.cwd();
  const reference = positionals[0] ?? null;

  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  // Terminate the process
  if (job.pid) {
    terminateProcessTree(job.pid);
  }

  // Update job state
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: new Date().toISOString()
  });
  writeJobFile(workspaceRoot, job.id, {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: new Date().toISOString()
  });

  output(renderCancelReport(job));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  // If the subcommand has quoted arguments, split them
  let effectiveArgv = argv;
  if (argv.length === 1 && /\s/.test(argv[0])) {
    effectiveArgv = splitRawArgumentString(argv[0]);
  }

  switch (subcommand) {
    case "setup":
      handleSetup(effectiveArgv);
      break;
    case "review":
      await handleReview(effectiveArgv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(effectiveArgv);
      break;
    case "task":
      await handleTask(effectiveArgv);
      break;
    case "task-worker":
      await handleTaskWorker(effectiveArgv);
      break;
    case "status":
      handleStatus(effectiveArgv);
      break;
    case "result":
      handleResult(effectiveArgv);
      break;
    case "cancel":
      handleCancel(effectiveArgv);
      break;
    default:
      fail(`Unknown subcommand: ${subcommand}\nAvailable: setup, review, adversarial-review, task, status, result, cancel`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
