// User prompts sent to each role, plus the canned plans used when a reply cannot be parsed.

function architectPrompt(session) {
  return `User Software Request: "${session.prompt}"

Design a complete, self-contained, zero-external-dependency web + Node.js software solution that fulfills this request and can be verified immediately with \`node test.js\` and previewed in a browser via \`index.html\`.

Return ONLY a valid JSON object inside a \`\`\`json code block with the following exact schema:
{
  "projectTitle": "Short title",
  "briefMd": "Full markdown content for brief.md covering Problem, Target Users, Core Features, and Architecture",
  "runbookMd": "Full markdown content for runbook.md covering File Layout (index.html, app.js, test.js), Module Contracts, and Do NOT rules",
  "kanbanTasks": [
    {
      "id": "TASK-1",
      "title": "Core Logic & Interactive UI Implementation",
      "assignee": "@builder",
      "description": "Implement app.js (exports core functions for Node tests AND attaches to window in browser) and index.html (sleek interactive dark-mode UI).",
      "acceptanceCriteria": ["app.js works in both Node.js CommonJS and browser DOM", "index.html provides interactive UI", "test.js runs automated assertions"]
    },
    {
      "id": "TASK-2",
      "title": "Runtime Verification & Edge-Case Audit",
      "assignee": "@verifier",
      "parentId": "TASK-1",
      "description": "Execute node test.js, verify all core functions and edge cases, and audit UI/code quality.",
      "acceptanceCriteria": ["node test.js exits 0", "All edge cases verified"]
    },
    {
      "id": "TASK-3",
      "title": "Documentation & Launch Synthesis",
      "assignee": "@lead",
      "parentId": "TASK-2",
      "description": "Produce README.md and LAUNCH_SUMMARY.md based on verified artifacts.",
      "acceptanceCriteria": ["Complete README.md with usage instructions"]
    }
  ],
  "messageToBuilder": "Direct bot-to-bot message to @builder (using @builder mention) explaining the architecture contract and handing off TASK-1.",
  "messageToVerifier": "Direct bot-to-bot message to @verifier (using @verifier mention) outlining what edge cases and invariants to test in TASK-2."
}`;
}

function architectFallbackPlan(session) {
  return {
    projectTitle: 'MuseSwarm Generated Application',
    briefMd: `# Project Brief\n\n**Request:** ${session.prompt}\n\n## Architecture\n- \`app.js\`: Isomorphic core engine (Node.js CommonJS export + browser \`window.AppCore\`).\n- \`index.html\`: Interactive modern UI dashboard.\n- \`test.js\`: Automated zero-dependency Node.js test suite using \`assert\`.`,
    runbookMd: `# Runbook\n\n## Files Required\n1. \`app.js\` — Core logic module exported via \`if (typeof module !== 'undefined') module.exports = ...\` and attached to \`window\`.\n2. \`index.html\` — Standalone interactive web app loading \`app.js\`.\n3. \`test.js\` — Node.js test suite that requires \`./app.js\`, runs assertions, and prints PASS.\n\n## Do NOT\n- Do NOT require external npm packages.\n- Do NOT leave placeholder TODOs.`,
    kanbanTasks: [
      {
        id: 'TASK-1',
        title: 'Implement Core Engine (app.js), UI (index.html), and Unit Tests (test.js)',
        assignee: '@builder',
        description: 'Build isomorphic app.js, interactive index.html, and comprehensive test.js.',
        acceptanceCriteria: ['Zero external dependencies', 'node test.js passes with 0 exit code'],
      },
      {
        id: 'TASK-2',
        title: 'Verify Runtime Tests & Audit Edge Cases',
        assignee: '@verifier',
        parentId: 'TASK-1',
        description: 'Inspect code and verify node test.js output.',
        acceptanceCriteria: ['All assertions pass'],
      },
      {
        id: 'TASK-3',
        title: 'Synthesize Release Package & Documentation',
        assignee: '@lead',
        parentId: 'TASK-2',
        description: 'Write README.md and final launch report.',
        acceptanceCriteria: ['Clear documentation'],
      },
    ],
    messageToBuilder: `@builder I have written brief.md and runbook.md for "${session.prompt}". Please implement app.js (compatible with both Node CommonJS and browser window), index.html, and test.js for TASK-1.`,
    messageToVerifier: `@verifier Once @builder completes TASK-1, run the test suite and audit app.js and index.html against our acceptance criteria.`,
  };
}

function builderPrompt(session, archPlan, tight) {
  return `You are @builder executing TASK-1 for the project: "${session.prompt}".

Here is \`brief.md\` from @architect:
${(archPlan.briefMd || '').slice(0, tight ? 1200 : 4000)}

Here is \`runbook.md\` from @architect:
${(archPlan.runbookMd || '').slice(0, tight ? 1200 : 4000)}

Message from @architect:
"${archPlan.messageToBuilder}"

Write compact, complete files now. Do not deliberate${tight ? ' (your previous reply ran out of tokens while reasoning and returned no files)' : ''}: put tokens into file contents, not commentary.
CRITICAL RULES:
1. \`app.js\` MUST be pure JavaScript with ZERO external npm packages. Export for Node (\`module.exports\`) AND \`globalThis.AppCore\`.
2. \`index.html\` MUST be a short dark-mode page that loads \`<script src="app.js"></script>\` (keep it under 80 lines).
${session.scenarioId
    ? `3. Do NOT emit \`test.js\` (or any other test file). Grading tests are engine-owned and read-only; a test.js write is rejected and does not change the score.`
    : `3. \`test.js\` MUST require \`./app.js\`, use Node \`assert\`, print \`[PASS]\` lines, and exit 0. At least 5 tests.`}
4. Messages to other bots: one sentence each. No long comments in source.

Return ONLY one strict JSON object (no prose, no markdown fences). Every file's full source goes in a JSON string, with newlines escaped as \\n and double quotes escaped as \\". Schema:
{
  "messageToArchitect": "One sentence to @architect.",
  "messageToVerifier": "One sentence to @verifier.",
  "files": [
    { "path": "app.js", "content": "<full source of app.js>" },
    { "path": "index.html", "content": "<full source of index.html>" }${session.scenarioId ? '' : `,
    { "path": "test.js", "content": "<full source of test.js>" }`}
  ]
}`;
}

function reworkFixPrompt(session, { reworkAttempt, failOutFull, writableBlock, readOnlyTests, targets }, tight) {
  return `The sandbox test runner reported an error for "${session.prompt}" (Rework Attempt #${reworkAttempt})${tight ? ' (your previous reply ran out of tokens while reasoning and returned no content)' : ''}.

Failing test output:
${failOutFull.slice(0, tight ? 600 : 1200)}

Writable file (patch ONLY this):
${writableBlock}
${readOnlyTests.length ? `--- test.js (read-only) ---
test.js is engine-owned grading and must not be edited.
` : ''}
Patch ONLY ${targets.join(', ') || 'domain.js'}. Do not emit test.js or app.js.
Return ONLY one strict JSON object (no prose, no markdown fences). Schema:
{
  "messageToVerifier": "Root cause and fix, addressed to @verifier",
  "files": [ { "path": "${targets[0] || 'domain.js'}", "content": "<full patched source>" } ]
}`;
}

function verifierAuditPrompt(session, testRun, rubricEval) {
  return `You are @verifier auditing the completed code and sandbox test execution for "${session.prompt}".

Sandbox Execution Result:
- Passed: ${testRun.passed} (${testRun.passedCount}/${testRun.checks.length} checks green)
- Checks: ${JSON.stringify(testRun.checks)}
- Stdout:
${testRun.stdout}

Automated Rubric Baseline: ${JSON.stringify(rubricEval)}

Files in workspace: ${Object.keys(session.files).join(', ')}

app.js preview:
${(session.files['app.js']?.content || '').slice(0, 2500)}

Return ONLY a valid JSON object inside a \`\`\`json code block:
{
  "verdict": "VERIFIED_PASS",
  "qualityScore": 98,
  "rubric": {
    "correctness": 25,
    "testCoverage": 24,
    "architectureAdherence": 25,
    "uiCompleteness": 24
  },
  "messageToBuilder": "Constructive peer review message to @builder citing specific strengths in app.js and test.js.",
  "messageToLead": "Handoff message to @lead (with @lead mention) confirming all checks passed and summarizing verified capabilities."
}`;
}

function leadReleasePrompt(session, testRun, tight) {
  return `You are @lead wrapping up the MuseSwarm build for "${session.prompt}".
Verified files: ${Object.keys(session.files).join(', ')}
Rubric Score: ${session.rubricEvaluation.qualityScore}/100
Test output:
${(testRun.stdout || '').slice(0, tight ? 600 : 2000)}

Write a short, structured release note. Do not deliberate: answer directly${tight ? ' (your previous reply ran out of tokens while reasoning and returned no content)' : ''}.
Return ONLY one strict JSON object (no prose, no markdown fences) with newlines escaped as \\n:
{
  "readmeMd": "README.md, at most ${tight ? 25 : 60} lines: title, one-paragraph summary, ## Features (bullets), ## Files (one bullet per file), ## Run (node test.js, open index.html)",
  "finalBroadcast": "One or two sentences to @all summarizing what @architect, @builder, @verifier, and @lead accomplished."
}`;
}

function leadFallbackPlan(session, archPlan) {
  return {
    readmeMd: `# ${archPlan.projectTitle || 'MuseSwarm Generated App'}\n\nBuilt autonomously by **MuseSwarm** (\`@architect\`, \`@builder\`, \`@verifier\`, \`@lead\`) powered by Meta's \`Muse Spark Open\` (\`meta-models/muse-spark-open-1026\`) on Baseten.\n\n## Run Tests\n\`\`\`bash\nnode test.js\n\`\`\`\n\n## Open Web App\nOpen \`index.html\` in your browser or via the MuseSwarm Live Preview drawer.`,
    finalBroadcast: `@all Release package synthesized! All Kanban tasks (TASK-1, TASK-2, TASK-3) are complete, verified by @verifier (${session.rubricEvaluation.qualityScore}/100), and documented in README.md.`,
  };
}

module.exports = {
  architectPrompt,
  architectFallbackPlan,
  builderPrompt,
  reworkFixPrompt,
  verifierAuditPrompt,
  leadReleasePrompt,
  leadFallbackPlan,
};
