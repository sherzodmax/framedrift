// Step 3: fail the job on Pro-gated drift, on any failed comparison, or when step 1 never recorded a gate.
const gate = process.env.FRAMEDRIFT_GATE || '';
if (gate === 'fail') { console.log('::error::framedrift: design drift above the fail-on threshold. See the PR comment / report artifact.'); process.exitCode = 1; }
else if (gate === 'error') { console.log('::error::framedrift: one or more comparisons failed (see the log and the report).'); process.exitCode = 1; }
else if (gate === 'pass') console.log('framedrift gate: pass');
else { console.log(`::error::framedrift: no gate result${gate ? ` ("${gate}")` : ''}; the comparison step did not finish (see its log).`); process.exitCode = 1; }
