import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/gemini/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Gemini returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Gemini Adversarial Review",
      jobClass: "review"
    },
    {
      rendered: "# Gemini Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Gemini Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
});

test("renderReviewResult renders structured findings with severity ranking", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Issues found.",
        findings: [
          {
            severity: "low",
            title: "Minor style issue",
            body: "Consider renaming.",
            file: "src/app.js",
            line_start: 10,
            line_end: 10,
            recommendation: "Rename variable."
          },
          {
            severity: "high",
            title: "Missing guard",
            body: "Could crash on null.",
            file: "src/app.js",
            line_start: 4,
            line_end: 6,
            recommendation: "Add null check."
          }
        ],
        next_steps: ["Add tests."]
      },
      rawOutput: "...",
      parseError: null
    },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /# Gemini Review/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /\[high\] Missing guard/);
  assert.match(output, /\[low\] Minor style issue/);
  assert.match(output, /Next steps:/);
  assert.match(output, /Add tests/);
  const highPos = output.indexOf("[high]");
  const lowPos = output.indexOf("[low]");
  assert.ok(highPos < lowPos, "high severity should appear before low severity");
});
