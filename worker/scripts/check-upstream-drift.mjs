import fs from 'node:fs';

const workerRoot = new URL('../', import.meta.url);
const repoRoot = new URL('../', workerRoot);
const py = fs.readFileSync(new URL('app/services/grok/services/model.py', repoRoot), 'utf8');
const ts = fs.readFileSync(new URL('worker/src/grok/models.ts', repoRoot), 'utf8');
const openaiRoute = fs.readFileSync(new URL('worker/src/routes/openai.ts', repoRoot), 'utf8');
const processor = fs.readFileSync(new URL('worker/src/grok/processor.ts', repoRoot), 'utf8');

const pyIds = [...py.matchAll(/model_id="([^"]+)"/g)].map((m) => m[1]);
const tsIds = [...ts.matchAll(/^\s*"([^"]+)":\s*\{/gm)].map((m) => m[1]);

const onlyInPy = pyIds.filter((x) => !tsIds.includes(x));
const onlyInTs = tsIds.filter((x) => !pyIds.includes(x));

const errors = [];
if (onlyInPy.length || onlyInTs.length) {
  errors.push(`Model drift detected. onlyInPy=${JSON.stringify(onlyInPy)} onlyInTs=${JSON.stringify(onlyInTs)}`);
}

for (const needle of ['tool_choice', 'parallel_tool_calls', 'tools?: OpenAIToolDefinition[]']) {
  if (!openaiRoute.includes(needle)) errors.push(`Missing tool-call route support marker: ${needle}`);
}
for (const needle of ['parseToolCalls', 'tool_calls', 'finish_reason: hasToolCalls ? "tool_calls" : "stop"']) {
  if (!processor.includes(needle)) errors.push(`Missing tool-call processor marker: ${needle}`);
}

if (errors.length) {
  console.error('\n[check-upstream-drift] FAILED');
  for (const err of errors) console.error('-', err);
  process.exit(1);
}

console.log('[check-upstream-drift] OK');
console.log(JSON.stringify({ pyIds, tsIds }, null, 2));
