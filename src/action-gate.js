// Step 3: fail the job if Pro gating found drift above the threshold (or every frame errored).
const gate = process.env.FRAMEDRIFT_GATE || 'pass';
if (gate === 'fail') { console.log('::error::framedrift: design drift above the fail-on threshold. See the PR comment / report artifact.'); process.exitCode = 1; }
else if (gate === 'error') { console.log('::error::framedrift: every comparison failed (see log).'); process.exitCode = 1; }
else console.log(`framedrift gate: ${gate}`);
