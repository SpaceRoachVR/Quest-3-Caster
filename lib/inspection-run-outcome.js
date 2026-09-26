'use strict';

// Decides how `npm run ui:inspect` should end. The Electron child reports
// success two ways at once: a zero exit status and a result file it writes
// only after every assertion passed. Requiring both means a run that dies
// before printing anything, or that exits 0 without finishing, is reported as
// a failure instead of a silent pass.
function evaluateInspectionRun({ error, signal, status, resultText }) {
  if (error) {
    return { ok: false, exitCode: 1, message: `Renderer inspection could not start: ${error.message}` };
  }
  if (signal) {
    return { ok: false, exitCode: 1, message: `Renderer inspection ended with signal ${signal}.` };
  }
  if (status !== 0) {
    const code = Number.isInteger(status) && status !== 0 ? status : 1;
    return { ok: false, exitCode: code, message: `Renderer inspection exited with status ${status}.` };
  }
  if (typeof resultText !== 'string' || !resultText.trim()) {
    return {
      ok: false,
      exitCode: 1,
      message: 'Renderer inspection exited 0 but produced no inspection result; the renderer script did not complete.'
    };
  }
  let result;
  try {
    result = JSON.parse(resultText);
  } catch (parseError) {
    return { ok: false, exitCode: 1, message: `Renderer inspection result is not valid JSON: ${parseError.message}` };
  }
  if (!result || typeof result !== 'object' || result.completed !== true) {
    return { ok: false, exitCode: 1, message: 'Renderer inspection result does not record a completed run.' };
  }
  return { ok: true, exitCode: 0, message: 'Renderer inspection completed.', result };
}

module.exports = { evaluateInspectionRun };
