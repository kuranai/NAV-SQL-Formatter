import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  generate,
  parseExecStatement,
  parseValueToken,
  collectSqlParameters,
  replaceSqlParameters,
} = require("../app.js");

const passthroughFormatter = {
  format(sql) {
    return sql;
  },
};

test("parseExecStatement handles commas and escaped quotes", () => {
  const exec = "exec sp_execute 71,@0=N'R,HWL',@1='O''Brien',@2=42";
  const result = parseExecStatement(exec);

  assert.equal(result.params.size, 3);
  assert.equal(result.params.get("@0").normalizedLiteral, "N'R,HWL'");
  assert.equal(result.params.get("@1").normalizedLiteral, "'O''Brien'");
  assert.equal(result.params.get("@2").inferredType, "int");
  assert.deepEqual(result.warnings, []);
});

test("parseExecStatement extracts sample @0..@12 parameters", () => {
  const exec =
    "exec sp_execute 71,@0=0,@1=N'R_HWL',@2=0x0000000000000000,@3=N'',@4='1753-01-01 00:00:00',@5='1753-01-01 00:00:00',@6=0,@7=0,@8='1753-01-01 00:00:00',@9=2,@10=1,@11=0,@12=N''";

  const result = parseExecStatement(exec);

  assert.equal(result.params.size, 13);
  assert.equal(result.params.get("@1").inferredType, "nvarchar(5)");
  assert.equal(result.params.get("@2").inferredType, "varbinary(8)");
  assert.equal(result.params.get("@4").inferredType, "datetime");
  assert.equal(result.params.get("@12").inferredType, "nvarchar(1)");
});

test("parseValueToken infers supported data classes", () => {
  assert.equal(parseValueToken("N'abc'").inferredType, "nvarchar(3)");
  assert.equal(parseValueToken("'1753-01-01 00:00:00'").inferredType, "datetime");
  assert.equal(parseValueToken("'2025-12-31'").inferredType, "date");
  assert.equal(parseValueToken("'14:25:59.120'").inferredType, "time");
  assert.equal(parseValueToken("0xA0FF").inferredType, "varbinary(2)");
  assert.equal(parseValueToken("2147483648").inferredType, "bigint");
  assert.equal(parseValueToken("12.340").inferredType, "decimal(5,3)");
});

test("parseValueToken uses max length type for very long strings", () => {
  const varcharLiteral = `'${"a".repeat(8100)}'`;
  const nvarcharLiteral = `N'${"b".repeat(4100)}'`;

  assert.equal(parseValueToken(varcharLiteral).inferredType, "varchar(max)");
  assert.equal(parseValueToken(nvarcharLiteral).inferredType, "nvarchar(max)");
});

test("generate prefers DECLARE mode when all used params are confidently inferred", () => {
  const sql = "SELECT @0 AS NumberValue, @1 AS TextValue";
  const exec = "exec sp_execute 71,@0=7,@1=N'AB'";

  const result = generate(sql, exec, { formatter: passthroughFormatter });

  assert.equal(result.mode, "declare");
  assert.match(result.outputSql, /DECLARE @0 int = 7,\n\s*@1 nvarchar\(2\) = N'AB';/);
  assert.match(result.outputSql, /SELECT @0 AS NumberValue, @1 AS TextValue/);
});

test("generate sorts numeric placeholders ascending in DECLARE mode", () => {
  const sql = "SELECT @1 AS B, @0 AS A, @10 AS J, @2 AS C";
  const exec = "exec sp_execute 71,@10=10,@2=2,@1=1,@0=0";

  const result = generate(sql, exec, { formatter: passthroughFormatter });

  assert.equal(result.mode, "declare");
  const declareSection = result.outputSql.split("\n\n")[0];
  const idx0 = declareSection.indexOf("@0 int = 0");
  const idx1 = declareSection.indexOf("@1 int = 1");
  const idx2 = declareSection.indexOf("@2 int = 2");
  const idx10 = declareSection.indexOf("@10 int = 10");

  assert.ok(idx0 !== -1 && idx1 !== -1 && idx2 !== -1 && idx10 !== -1);
  assert.ok(idx0 < idx1 && idx1 < idx2 && idx2 < idx10);
});

test("generate uses sql_variant assignment when a used parameter type is unknown", () => {
  const sql = "SELECT @0 AS A, @1 AS B";
  const exec = "exec sp_execute 71,@0=7,@1=NULL";

  const result = generate(sql, exec, { formatter: passthroughFormatter });

  assert.equal(result.mode, "declare");
  assert.match(result.outputSql, /DECLARE @0 int = 7,\n\s*@1 sql_variant = NULL;/);
  assert.match(result.outputSql, /SELECT @0 AS A, @1 AS B/);
  assert.ok(result.warnings.some((warning) => warning.includes("Type inference is not confident for @1")));
  assert.ok(result.warnings.some((warning) => warning.includes("using sql_variant")));
});

test("generate declares missing placeholders as uninitialized sql_variant", () => {
  const sql = "SELECT @0 AS A, @2 AS Missing";
  const exec = "exec sp_execute 71,@0=7,@1=8";

  const result = generate(sql, exec, { formatter: passthroughFormatter });

  assert.equal(result.mode, "declare");
  assert.match(result.outputSql, /DECLARE @0 int = 7,\n\s*@2 sql_variant;/);
  assert.match(result.outputSql, /SELECT @0 AS A, @2 AS Missing/);
  assert.ok(result.warnings.some((warning) => warning.includes("Missing value for @2")));
  assert.ok(result.warnings.some((warning) => warning.includes("uninitialized sql_variant")));
});

test("replaceSqlParameters does not replace placeholders inside strings or comments", () => {
  const sql = "SELECT '@0' AS s, @0 AS v -- @0 in comment\n/* @0 block */";
  const params = parseExecStatement("exec sp_execute 71,@0=9").params;

  const replaced = replaceSqlParameters(sql, params);

  assert.equal(replaced, "SELECT '@0' AS s, 9 AS v -- @0 in comment\n/* @0 block */");
});

test("collectSqlParameters ignores system variables and quoted references", () => {
  const sql = "SELECT @@ROWCOUNT, @0, '@1', -- @2\n@3";
  const params = collectSqlParameters(sql);

  assert.deepEqual(
    params.map((entry) => entry.name),
    ["@0", "@3"],
  );
});

test("duplicate assignments keep the last value", () => {
  const result = parseExecStatement("exec sp_execute 71,@0=1,@0=2");

  assert.equal(result.params.get("@0").normalizedLiteral, "2");
  assert.ok(result.warnings.some((warning) => warning.includes("Duplicate assignment for @0")));
});

test("generate removes input line breaks before formatting", () => {
  const sql = "SELECT\n@0 AS Value\nFROM\nMyTable";
  const exec = "exec sp_execute 71,\n@0=1";

  const result = generate(sql, exec, { formatter: passthroughFormatter });

  assert.equal(result.mode, "declare");
  assert.match(result.outputSql, /^DECLARE @0 int = 1;\n\nSELECT @0 AS Value FROM MyTable$/);
});

test("formatter failures fall back to unformatted output with warning", () => {
  const failingFormatter = {
    format() {
      throw new Error("boom");
    },
  };

  const result = generate("SELECT @0", "exec sp_execute 71,@0=1", {
    formatter: failingFormatter,
  });

  assert.equal(result.mode, "declare");
  assert.ok(result.outputSql.startsWith("DECLARE @0 int = 1;"));
  assert.ok(result.warnings.some((warning) => warning.includes("SQL formatter failed")));
});
