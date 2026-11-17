const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getScenario, isScenarioTestFile, scenarioTestFiles } = require('./scenarios');
const { scenarioAppLoadsDomain, scanModelFaultSource, runIsolatedDomainGrade } = require('./isolated-grade');
const { buildReworkDiff } = require('./rework-diff');
const { fallbackAppJs, fallbackTestJs, fallbackIndexHtml } = require('./fallback-artifacts');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sessionProtectedFiles(session) {
  if (session?._cleanArtifacts) return scenarioTestFiles(session._cleanArtifacts);
  if (session?.scenarioId) return ['test.js'];
  return [];
}

function isProtectedScenarioFile(session, relPath) {
  if (!relPath) return false;
  const protectedSet = new Set(sessionProtectedFiles(session));
  if (protectedSet.has(relPath)) return true;
  return Boolean(session?.scenarioId || session?._cleanArtifacts) && isScenarioTestFile(relPath);
}

function scenarioFaultFiles(session) {
  const preset = getScenario(session?.scenarioId);
  const file = preset?.pass1Fault?.file;
  return file ? [file] : [];
}

function isScenarioReworkNonTarget(session, relPath) {
  if (!session?.scenarioId) return false;
  if (isProtectedScenarioFile(session, relPath)) return false;
  const faultFiles = scenarioFaultFiles(session);
  return faultFiles.length > 0 && !faultFiles.includes(relPath);
}

function scenarioAllowedLocals(session) {
  const arts = session?._cleanArtifacts || {};
  return Object.keys(arts).filter((p) => p.endsWith('.js') && !isScenarioTestFile(p));
}

function isHostileScenarioAppJs(content) {
  const text = String(content || '');
  if (!scenarioAppLoadsDomain(text)) return true;
  return scanModelFaultSource(text, ['domain.js']).includes('assert')
    || /\brequire\s*\(\s*['"](?:node:)?assert['"]\s*\)/.test(text)
    || /\brequire\.cache\b/.test(text);
}

function isKeptModelScenarioFile(session, relPath) {
  const file = session?.files?.[relPath];
  if (!file || (file.source !== 'model' && file.source !== 'offline_fixture')) return false;
  if (isScenarioTestFile(relPath)) return false;
  if (scenarioFaultFiles(session).includes(relPath)) return false;
  if (relPath === 'app.js') return !isHostileScenarioAppJs(file.content);
  if (relPath === 'index.html') return true;
  return false;
}

// Files named in the failing output (stack frames, syntax checks) plus their local require() deps,
// so a failure surfacing in test.js also hands @builder the module under test (e.g. domain.js).
// Scenario grading tests are read-only; scenario rework may only patch the seeded fault file.
function reworkTargetFiles(session, testRun) {
  if (session.scenarioId) {
    return scenarioFaultFiles(session).filter((p) => session.files[p] && !isProtectedScenarioFile(session, p));
  }
  const jsFiles = Object.keys(session.files).filter((p) => p.endsWith('.js'));
  const output = `${testRun.stderr || ''}\n${testRun.stdout || ''}`;
  const hits = new Set();
  for (const p of jsFiles) {
    if (new RegExp(`(^|[\\\\/\\s(])${escapeRegExp(p)}(:\\d+|\\b)`).test(output)) hits.add(p);
  }
  for (const check of testRun.checks || []) {
    if (!check.passed && check.name.startsWith('syntax:')) hits.add(check.name.slice('syntax:'.length));
  }
  if (!hits.size) jsFiles.forEach((p) => hits.add(p));
  const queue = [...hits];
  while (queue.length) {
    const src = session.files[queue.shift()]?.content || '';
    for (const m of src.matchAll(/require\(\s*['"]\.\/([\w./-]+?)(?:\.js)?['"]\s*\)/g)) {
      const dep = `${m[1]}.js`;
      if (session.files[dep] && !hits.has(dep)) {
        hits.add(dep);
        queue.push(dep);
      }
    }
  }
  return jsFiles.filter((p) => hits.has(p) && !isProtectedScenarioFile(session, p));
}

// Mixed into MuseSwarmEngine.prototype; `this` is the engine (uses emitEvent and serializeSession).
const workspaceMethods = {
  // source: 'model' (parsed from a live Muse Spark reply), 'offline_fixture' (simulated reply),
  // or an engine-authored write: 'scenario_fixture', 'fault_injection', 'deterministic_restore',
  // 'engine_fallback', 'engine_summary'.
  recordRejectedWrite(session, relPath, attemptedContent, authorAgent, source = 'rejected_protected_file') {
    const safeRel = relPath.replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (!session.fileHistory) session.fileHistory = {};
    const history = session.fileHistory[safeRel] || (session.fileHistory[safeRel] = []);
    const text = String(attemptedContent);
    history.push({
      revision: history.length + 1,
      author: authorAgent,
      source,
      rejected: true,
      updatedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(text, 'utf8'),
      content: text,
    });
    this.emitEvent(session, 'file_write_rejected', {
      path: safeRel,
      author: authorAgent,
      source,
    });
    return history[history.length - 1];
  },

  recordRejectedProtectedWrite(session, relPath, attemptedContent, authorAgent) {
    return this.recordRejectedWrite(session, relPath, attemptedContent, authorAgent, 'rejected_protected_file');
  },

  // Isolated child-process grade: model's domain.js never shares a process with assert.
  // Parent compares JSON outputs to the clean fixture domain.js (also run in its own child).
  runIndependentScenarioGrade(session, overlay = {}) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts || !session.scenarioId) return { passed: true, skipped: true };
    const faultFile = scenarioFaultFiles(session)[0] || 'domain.js';
    let modelDomain = artifacts[faultFile];
    if (Object.prototype.hasOwnProperty.call(overlay, faultFile)) modelDomain = overlay[faultFile];
    else if (session.files[faultFile]?.content != null) modelDomain = session.files[faultFile].content;
    const grade = runIsolatedDomainGrade(
      session.scenarioId,
      modelDomain,
      artifacts[faultFile],
      scenarioAllowedLocals(session)
    );
    return {
      passed: Boolean(grade.passed),
      skipped: false,
      stdout: '',
      stderr: grade.passed ? '' : `${grade.reason || 'independent grade failed'}${grade.detail ? ': ' + grade.detail : ''}`,
      scan: grade.scan || [],
      reason: grade.reason,
    };
  },

  applyIndependentGrade(testRun, grade) {
    testRun.checks.push({
      name: 'independent_grade',
      passed: grade.passed,
      detail: grade.skipped
        ? 'skipped'
        : grade.passed
          ? 'isolated child-process domain.js outputs matched the fixture'
          : (grade.stderr || grade.reason || 'independent grade failed').trim().slice(0, 400),
    });
    if (!grade.passed) {
      testRun.passed = false;
      testRun.stderr += `\n[independent_grade] ${(grade.stderr || '').trim().slice(0, 400)}`;
    }
    testRun.passedCount = testRun.checks.filter((c) => c.passed).length;
    testRun.failedCount = testRun.checks.filter((c) => !c.passed).length;
    return testRun.passed;
  },

  restoreScenarioCodeFixtures(session, source = 'deterministic_restore', { force = false } = {}) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts) return;
    for (const relPath of ['domain.js', 'app.js', 'test.js', 'index.html']) {
      const fixture = artifacts[relPath];
      if (typeof fixture !== 'string') continue;
      if (!force && isKeptModelScenarioFile(session, relPath)) continue;
      if (session.files[relPath]?.content !== fixture) {
        this.writeWorkspaceFile(session, relPath, fixture, 'engine', source);
      }
    }
  },

  enforceScenarioGradingTests(session) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts) return;
    for (const relPath of sessionProtectedFiles(session)) {
      const fixture = artifacts[relPath];
      if (typeof fixture !== 'string') continue;
      const current = session.files[relPath]?.content;
      if (current !== fixture) {
        this.writeWorkspaceFile(session, relPath, fixture, 'engine', 'scenario_fixture');
      } else {
        const fullPath = path.join(session.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fixture, 'utf8');
      }
    }
  },

  writeWorkspaceFile(session, relPath, content, authorAgent, source = 'unspecified') {
    const safeRel = relPath.replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (isProtectedScenarioFile(session, safeRel) && authorAgent !== 'engine') {
      this.recordRejectedProtectedWrite(session, safeRel, content, authorAgent);
      return null;
    }
    const fullPath = path.join(session.workspaceDir, safeRel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const text = String(content);
    fs.writeFileSync(fullPath, text, 'utf8');

    if (!session.fileHistory) session.fileHistory = {};
    if (!session.reworkDiffs) session.reworkDiffs = [];

    const previous = session.files[safeRel];
    const history = session.fileHistory[safeRel] || (session.fileHistory[safeRel] = []);
    const updatedAt = new Date().toISOString();
    const pass = (session.reworkCycles || 0) > 0 ? session.reworkCycles + 1 : 1;
    history.push({
      revision: history.length + 1,
      author: authorAgent,
      source,
      reworkAttempt: session._captureReworkDiff ? session.reworkCycles || 0 : 0,
      updatedAt,
      bytes: Buffer.byteLength(text, 'utf8'),
      pass,
      content: text,
    });

    let diffMeta = null;
    if (session._captureReworkDiff && typeof previous?.content === 'string' && previous.content !== text) {
      diffMeta = buildReworkDiff({
        filePath: safeRel,
        before: previous.content,
        after: text,
        author: authorAgent,
        source,
        reworkAttempt: session.reworkCycles || 1,
      });
      session.reworkDiffs.push(diffMeta);
    }

    session.files[safeRel] = {
      path: safeRel,
      size: Buffer.byteLength(text, 'utf8'),
      author: authorAgent,
      source,
      updatedAt,
      content: text,
      diff: diffMeta ? diffMeta.diff : (previous?.diff || null),
      beforeSnippet: diffMeta ? diffMeta.beforeSnippet : (previous?.beforeSnippet || null),
      afterSnippet: diffMeta ? diffMeta.afterSnippet : (previous?.afterSnippet || null),
    };

    this.emitEvent(session, 'file_written', {
      path: safeRel,
      author: authorAgent,
      source,
      size: session.files[safeRel].size,
      revision: history.length,
      reworkDiff: Boolean(diffMeta),
    });
    return fullPath;
  },

  runWorkspaceTests(session, label = {}) {
    this.enforceScenarioGradingTests(session);
    const startMs = Date.now();
    const results = {
      run: (session.verificationRuns || []).length + 1,
      pass: label.pass || (session.reworkCycles || 0) + 1,
      phase: label.phase || 'verify',
      reworkAttempt: label.reworkAttempt || 0,
      candidate: label.candidate || null,
      passed: true,
      checks: [],
      passedCount: 0,
      failedCount: 0,
      durationMs: 0,
      stdout: '',
      stderr: '',
      executedAt: new Date().toISOString(),
    };

    // 1. Syntax check all .js files via node --check
    for (const relPath of Object.keys(session.files)) {
      if (relPath.endsWith('.js')) {
        const fullPath = path.join(session.workspaceDir, relPath);
        try {
          execSync(`node --check "${fullPath}"`, { cwd: session.workspaceDir, stdio: 'pipe', timeout: 8000 });
          results.checks.push({ name: `syntax:${relPath}`, passed: true, detail: 'Valid JS syntax' });
        } catch (err) {
          results.passed = false;
          const errMsg = (err.stderr ? err.stderr.toString() : err.message).slice(0, 400);
          results.checks.push({ name: `syntax:${relPath}`, passed: false, detail: errMsg });
          results.stderr += `\n[Syntax Error in ${relPath}]: ${errMsg}`;
        }
      }
    }

    // 2. Run test.js if present
    const testPath = path.join(session.workspaceDir, 'test.js');
    if (fs.existsSync(testPath)) {
      try {
        const out = execSync(`node "${testPath}"`, {
          cwd: session.workspaceDir,
          stdio: 'pipe',
          timeout: 12000,
        });
        const stdoutStr = out.toString();
        results.stdout += stdoutStr;
        const passMatches = (stdoutStr.match(/\[PASS\]/gi) || []).length;
        results.checks.push({
          name: 'runtime:test.js',
          passed: true,
          assertionsPassed: passMatches || 1,
          detail: stdoutStr.trim().slice(0, 300),
        });
      } catch (err) {
        results.passed = false;
        const errOut = (err.stdout ? err.stdout.toString() : '') + '\n' + (err.stderr ? err.stderr.toString() : err.message);
        results.stderr += errOut;
        results.checks.push({ name: 'runtime:test.js', passed: false, detail: errOut.trim().slice(0, 400) });
      }
    } else {
      results.passed = false;
      results.checks.push({ name: 'runtime:test.js', passed: false, detail: 'Missing test.js in workspace' });
    }

    // 3. Verify required UI & contract files exist
    const hasHtml = Boolean(session.files['index.html']);
    results.checks.push({
      name: 'artifact:index.html',
      passed: hasHtml,
      detail: hasHtml ? `index.html present (${session.files['index.html'].size} bytes)` : 'Missing index.html',
    });
    if (!hasHtml) results.passed = false;

    results.passedCount = results.checks.filter((c) => c.passed).length;
    results.failedCount = results.checks.filter((c) => !c.passed).length;
    results.durationMs = Date.now() - startMs;

    session.verificationRuns.push(results);
    this.emitEvent(session, 'verification_run', { results });
    return results;
  },

  saveSessionSnapshot(session) {
    if (!session || !session.workspaceDir) return;
    const dirName = path.basename(session.workspaceDir);
    if (session.golden || session.readOnly || dirName.startsWith('golden-')) return;
    try {
      const serialized = this.serializeSession(session);
      fs.writeFileSync(
        path.join(session.workspaceDir, '.session.json'),
        JSON.stringify(serialized, null, 2),
        'utf8'
      );
      if (session.benchmark) {
        fs.writeFileSync(
          path.join(session.workspaceDir, 'benchmark.json'),
          JSON.stringify(session.benchmark, null, 2),
          'utf8'
        );
      }
    } catch (_) {}
  },

  writeFallbackArtifacts(session) {
    if (session._cleanArtifacts) {
      this.restoreScenarioCodeFixtures(session, 'engine_fallback', { force: true });
      return;
    }

    this.writeWorkspaceFile(session, 'app.js', fallbackAppJs, 'engine', 'engine_fallback');
    if (!isProtectedScenarioFile(session, 'test.js')) {
      this.writeWorkspaceFile(session, 'test.js', fallbackTestJs, 'engine', 'engine_fallback');
    }
    this.writeWorkspaceFile(session, 'index.html', fallbackIndexHtml, 'engine', 'engine_fallback');
  },
};

module.exports = {
  workspaceMethods,
  sessionProtectedFiles,
  isProtectedScenarioFile,
  scenarioFaultFiles,
  isScenarioReworkNonTarget,
  scenarioAllowedLocals,
  isHostileScenarioAppJs,
  reworkTargetFiles,
};
