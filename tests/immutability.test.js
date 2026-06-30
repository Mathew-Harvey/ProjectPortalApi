const fs = require('fs');
const path = require('path');

// Durable-core guard: the append-only event log and immutable media rows must
// never be UPDATEd or DELETEd anywhere in the codebase. This test scans the
// source so a future change that mutates them fails CI instead of silently
// breaking the audit trail.

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('append-only / immutable invariants', () => {
  const root = path.resolve(__dirname, '..');
  const files = sourceFiles(root);

  test('no UPDATE or DELETE against the event table', () => {
    const offenders = [];
    const re = /(UPDATE\s+event\b|DELETE\s+FROM\s+event\b)/i;
    for (const f of files) {
      if (re.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });

  test('no UPDATE or DELETE against the media table', () => {
    const offenders = [];
    const re = /(UPDATE\s+media\b|DELETE\s+FROM\s+media\b)/i;
    for (const f of files) {
      if (re.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });
});
