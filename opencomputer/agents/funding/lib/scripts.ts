import type { Statement } from "./persist";

// Code for the runtime's Code Mode `execute` tool. Code-defined tools are not
// callable inside Code Mode, but the project database is (tools.database.*),
// so tools return ready-to-run code and the model passes it to execute
// verbatim. Rows are emitted as plain object literals wrapped in
// JSON.stringify(...) to avoid double-escaped JSON. Only syntax the Code Mode
// interpreter supports is used (no `this`, no function declarations).

const J = (v: unknown) => JSON.stringify(v);

function statementLiteral(s: Statement): string {
  const params = s.parameters.map((p, i) => (s.jsonParams?.includes(i) && typeof p === "string" ? `JSON.stringify(${p})` : J(p)));
  return `{ sql: ${J(s.sql)}, parameters: [${params.join(", ")}] }`;
}

// \`tools\` is a proxy (typeof reports "function" for any name), so probe with a real call:
// the database namespace attaches asynchronously and may be missing on the first execute.
const GUARD = `try { await tools.database.query({ sql: "SELECT 1", parameters: [] }); } catch (e) { return { retry: true, reason: "database tools not loaded yet; run the same code again" }; }`;

const ROWS = `const rowsOf = (r0) => { const r = typeof r0 === "string" ? JSON.parse(r0) : r0; const rows = Array.isArray(r) ? r : (r?.rows ?? r?.result?.rows ?? []); const cols = (r?.columns ?? r?.result?.columns ?? []).map((c) => (typeof c === "string" ? c : c?.name)); return rows.map((row) => (Array.isArray(row) ? Object.fromEntries(cols.map((c, i) => [c, row[i]])) : row)); };`;

/** Execute statements in order (idempotent), then optionally run a verification query. */
export function writeCode(statements: Statement[], verify?: Statement): string {
  return [
    GUARD,
    ROWS,
    `const statements = [\n${statements.map(statementLiteral).join(",\n")}\n];`,
    `const writes = { ok: 0, failed: [] };`,
    `for (const s of statements) { try { await tools.database.execute(s); writes.ok += 1; } catch (e) { writes.failed.push(String(e?.message ?? e).slice(0, 200)); } }`,
    verify ? `const v = rowsOf(await tools.database.query(${statementLiteral(verify)}))[0] ?? null;\nreturn { writes, verification: v ? { report_sha256: v.report_sha256, status: v.status, evidence_rows: v.evidence_rows, filing_rows: v.filing_rows, offering_rows: v.offering_rows, candidate_rows: v.candidate_rows } : null };` : `return { writes };`,
  ].join("\n");
}

/** Run named read queries and return their rows. */
export function readCode(queries: { name: string; statement: Statement }[]): string {
  return [GUARD, ROWS, `const out = {};`, ...queries.map((q) => `out[${J(q.name)}] = rowsOf(await tools.database.query(${statementLiteral(q.statement)}));`), `return out;`].join("\n");
}
