# NAV SQL Trace Formatter

Single-page web app for SQL Server trace output from Dynamics NAV/Business Central style queries.

## What It Does

- Accepts a trace SQL statement containing placeholders like `@0`, `@1`, `@12`.
- Accepts a matching `exec sp_execute ...` statement containing parameter values.
- Produces formatted SQL using this rule:
  - Prefer a single `DECLARE` statement at the top when all used parameters have confident inferred SQL types.
  - Fallback to inline replacement when any used parameter is missing or type inference is not confident.
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
- `NULL` or unsupported token -> not confident (forces inline fallback)

## Tests

Run:

```bash
node --test tests/formatter.test.mjs
```

The tests validate parsing, type inference, mode selection, placeholder replacement safety, and formatter fallback behavior.
