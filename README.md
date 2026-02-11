# NAV SQL Trace Formatter

Single-page web app for SQL Server trace output from Dynamics NAV/Business Central style queries.

## What It Does

- Accepts a trace SQL statement containing placeholders like `@0`, `@1`, `@12`.
- Accepts a matching `exec sp_execute ...` statement containing parameter values.
- Normalizes pasted SQL/EXEC line breaks before parsing and formatting:
  - outside quoted tokens -> treated as whitespace
  - inside quoted strings/identifiers -> removed to avoid breaking token text
- Produces formatted SQL with a single `DECLARE` statement at the top.
- Uses inferred SQL types when confidence is high.
- Falls back to `sql_variant` for uncertain or missing values:
  - unknown/uncertain type with a parsed literal -> `sql_variant = <literal>`
  - missing assignment or missing parsed literal -> uninitialized `sql_variant`
- Always shows warnings, but still returns best-effort output.

## Inference Rules

- `N'...'` -> `nvarchar(n)` / `nvarchar(max)`
- `'YYYY-MM-DD HH:MM:SS[.fff]'` -> `datetime`
- `'YYYY-MM-DD'` -> `date`
- `'HH:MM:SS[.fff]'` -> `time`
- `'...'` -> `varchar(n)` / `varchar(max)`
- `0x...` -> `varbinary(n)` / `varbinary(max)`
- integer -> `int` / `bigint`
- decimal -> `decimal(p,s)`
- `NULL` or unsupported token -> not confident (uses `sql_variant` fallback)

## Tests

Run:

```bash
node --test tests/formatter.test.mjs
```

The tests validate parsing, type inference, DECLARE generation behavior, placeholder replacement safety, and formatter fallback behavior.
