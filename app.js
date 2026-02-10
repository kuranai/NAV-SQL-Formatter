(function (global) {
  "use strict";

  const INT32_MIN = -2147483648n;
  const INT32_MAX = 2147483647n;
  const SQL_MAX_PRECISION = 38;
  const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
  const STORAGE_KEYS = {
    sql: "navSqlFormatter.sql",
    exec: "navSqlFormatter.exec",
  };

  /**
   * @typedef {Object} ParsedParam
   * @property {string} name
   * @property {string} rawToken
   * @property {string | null} normalizedLiteral
   * @property {string | null} inferredType
   * @property {boolean} confidence
   * @property {string | null} parseError
   */

  /**
   * @typedef {Object} GenerationResult
   * @property {"declare" | "inline"} mode
   * @property {string} outputSql
   * @property {string[]} warnings
   * @property {ParsedParam[]} params
   */

  function normalizeParamName(name) {
    return name.toLowerCase();
  }

  function isIdentifierChar(char) {
    return /[A-Za-z0-9_#$@]/.test(char);
  }

  function isTracePlaceholder(name) {
    return /^@[A-Za-z0-9_#$]+$/.test(name);
  }

  function dedupeStrings(items) {
    return Array.from(new Set(items.filter(Boolean)));
  }

  function consumeSingleQuoted(text, startIndex) {
    let i = startIndex + 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return text.length;
  }

  function consumeDoubleQuoted(text, startIndex) {
    let i = startIndex + 1;
    while (i < text.length) {
      if (text[i] === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return text.length;
  }

  function consumeBracketIdentifier(text, startIndex) {
    let i = startIndex + 1;
    while (i < text.length) {
      if (text[i] === "]") {
        if (text[i + 1] === "]") {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return text.length;
  }

  function consumeLineComment(text, startIndex) {
    let i = startIndex + 2;
    while (i < text.length && text[i] !== "\n") {
      i += 1;
    }
    return i;
  }

  function consumeBlockComment(text, startIndex) {
    const end = text.indexOf("*/", startIndex + 2);
    return end === -1 ? text.length : end + 2;
  }

  function splitByCommaOutsideStrings(input) {
    const segments = [];
    let start = 0;
    let i = 0;

    while (i < input.length) {
      if (input[i] === "'") {
        i = consumeSingleQuoted(input, i);
        continue;
      }
      if (input[i] === ",") {
        segments.push(input.slice(start, i));
        start = i + 1;
      }
      i += 1;
    }

    segments.push(input.slice(start));
    return segments;
  }

  function decodeSqlString(value) {
    return value.replace(/''/g, "'");
  }

  function decimalTypeFromLiteral(token) {
    const signless = token.replace(/^[+-]/, "");
    const parts = signless.split(".");
    const integerPart = parts[0] === "" ? "0" : parts[0];
    const fractionPart = parts[1] || "";
    const precision = integerPart.length + fractionPart.length;
    const scale = fractionPart.length;

    if (precision > SQL_MAX_PRECISION) {
      return null;
    }

    return `decimal(${precision},${scale})`;
  }

  /**
   * @param {string} rawToken
   * @returns {{normalizedLiteral: string | null, inferredType: string | null, confidence: boolean, parseError: string | null}}
   */
  function parseValueToken(rawToken) {
    const token = rawToken.trim();

    if (!token) {
      return {
        normalizedLiteral: null,
        inferredType: null,
        confidence: false,
        parseError: "Value is empty.",
      };
    }

    if (/^null$/i.test(token)) {
      return {
        normalizedLiteral: "NULL",
        inferredType: null,
        confidence: false,
        parseError: "NULL has no concrete type for conservative inference.",
      };
    }

    if (/^N'(?:[^']|'')*'$/.test(token)) {
      const value = decodeSqlString(token.slice(2, -1));
      const len = Math.max(1, value.length);
      const inferredType = len > 4000 ? "nvarchar(max)" : `nvarchar(${len})`;
      return {
        normalizedLiteral: token,
        inferredType,
        confidence: true,
        parseError: null,
      };
    }

    if (/^'(?:[^']|'')*'$/.test(token)) {
      const value = decodeSqlString(token.slice(1, -1));
      let inferredType;

      if (DATETIME_RE.test(value)) {
        inferredType = "datetime";
      } else if (DATE_RE.test(value)) {
        inferredType = "date";
      } else if (TIME_RE.test(value)) {
        inferredType = "time";
      } else {
        const len = Math.max(1, value.length);
        inferredType = len > 8000 ? "varchar(max)" : `varchar(${len})`;
      }

      return {
        normalizedLiteral: token,
        inferredType,
        confidence: true,
        parseError: null,
      };
    }

    if (/^0x[0-9A-Fa-f]*$/.test(token)) {
      const digits = token.length - 2;
      if (digits % 2 !== 0) {
        return {
          normalizedLiteral: token,
          inferredType: null,
          confidence: false,
          parseError: "Hex literal has odd digit count.",
        };
      }
      const bytes = digits / 2;
      const inferredType = bytes > 8000 ? "varbinary(max)" : `varbinary(${Math.max(1, bytes)})`;
      return {
        normalizedLiteral: token,
        inferredType,
        confidence: true,
        parseError: null,
      };
    }

    if (/^[+-]?\d+$/.test(token)) {
      try {
        const value = BigInt(token);
        const inferredType = value >= INT32_MIN && value <= INT32_MAX ? "int" : "bigint";
        return {
          normalizedLiteral: token,
          inferredType,
          confidence: true,
          parseError: null,
        };
      } catch (_error) {
        return {
          normalizedLiteral: token,
          inferredType: null,
          confidence: false,
          parseError: "Could not parse integer literal.",
        };
      }
    }

    if (/^[+-]?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/.test(token)) {
      const inferredType = decimalTypeFromLiteral(token);
      if (!inferredType) {
        return {
          normalizedLiteral: token,
          inferredType: null,
          confidence: false,
          parseError: "Decimal precision exceeds SQL Server limit (38).",
        };
      }
      return {
        normalizedLiteral: token,
        inferredType,
        confidence: true,
        parseError: null,
      };
    }

    return {
      normalizedLiteral: token,
      inferredType: null,
      confidence: false,
      parseError: "Unsupported token format.",
    };
  }

  function parseAssignmentSegment(segment) {
    const trimmed = segment.trim();
    if (!trimmed) {
      return null;
    }

    const match = trimmed.match(/^(@[A-Za-z0-9_#$]+)\s*=\s*([\s\S]*)$/);
    if (!match) {
      return null;
    }

    let valueToken = match[2].trim();
    if (valueToken.endsWith(";")) {
      valueToken = valueToken.slice(0, -1).trimEnd();
    }

    return {
      name: match[1],
      valueToken,
    };
  }

  /**
   * @param {string} execText
   * @returns {{params: Map<string, ParsedParam>, warnings: string[]}}
   */
  function parseExecStatement(execText) {
    const warnings = [];
    const params = new Map();

    if (!execText || !execText.trim()) {
      warnings.push("EXEC statement is empty.");
      return { params, warnings };
    }

    const segments = splitByCommaOutsideStrings(execText);

    for (const segment of segments) {
      const assignment = parseAssignmentSegment(segment);
      if (!assignment || !isTracePlaceholder(assignment.name)) {
        continue;
      }

      const parsedValue = parseValueToken(assignment.valueToken);
      const key = normalizeParamName(assignment.name);

      if (params.has(key)) {
        warnings.push(`Duplicate assignment for ${assignment.name}; last value wins.`);
      }

      params.set(key, {
        name: assignment.name,
        rawToken: assignment.valueToken,
        normalizedLiteral: parsedValue.normalizedLiteral,
        inferredType: parsedValue.inferredType,
        confidence: parsedValue.confidence,
        parseError: parsedValue.parseError,
      });
    }

    if (params.size === 0) {
      warnings.push("No parameter assignments were parsed from EXEC statement.");
    }

    return {
      params,
      warnings: dedupeStrings(warnings),
    };
  }

  function transformSqlParameters(sqlText, transformFn) {
    let output = "";
    let i = 0;

    while (i < sqlText.length) {
      const char = sqlText[i];

      if (char === "'") {
        const end = consumeSingleQuoted(sqlText, i);
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === '"') {
        const end = consumeDoubleQuoted(sqlText, i);
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === "[") {
        const end = consumeBracketIdentifier(sqlText, i);
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === "-" && sqlText[i + 1] === "-") {
        const end = consumeLineComment(sqlText, i);
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === "/" && sqlText[i + 1] === "*") {
        const end = consumeBlockComment(sqlText, i);
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === "@" && sqlText[i + 1] === "@") {
        let end = i + 2;
        while (end < sqlText.length && /[A-Za-z0-9_#$]/.test(sqlText[end])) {
          end += 1;
        }
        output += sqlText.slice(i, end);
        i = end;
        continue;
      }

      if (char === "@" && isIdentifierChar(sqlText[i + 1] || "")) {
        let end = i + 1;
        while (end < sqlText.length && isIdentifierChar(sqlText[end])) {
          end += 1;
        }

        const token = sqlText.slice(i, end);
        if (isTracePlaceholder(token)) {
          const key = normalizeParamName(token);
          const replacement = transformFn(token, key, i, end);
          output += replacement == null ? token : replacement;
          i = end;
          continue;
        }
      }

      output += char;
      i += 1;
    }

    return output;
  }

  function collectSqlParameters(sqlText) {
    const ordered = [];
    const seen = new Set();

    transformSqlParameters(sqlText, function collect(token, key) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push({ name: token, key });
      }
      return null;
    });

    return ordered;
  }

  function sortSqlParamsForDeclare(sqlParams) {
    return sqlParams
      .map(function withIndex(param, index) {
        const numericMatch = param.name.match(/^@(\d+)$/);
        return {
          param,
          index,
          isNumeric: Boolean(numericMatch),
          numericValue: numericMatch ? Number.parseInt(numericMatch[1], 10) : Number.NaN,
        };
      })
      .sort(function compare(left, right) {
        if (left.isNumeric && right.isNumeric) {
          return left.numericValue - right.numericValue;
        }
        if (left.isNumeric) {
          return -1;
        }
        if (right.isNumeric) {
          return 1;
        }
        return left.index - right.index;
      })
      .map(function toParam(item) {
        return item.param;
      });
  }

  function replaceSqlParameters(sqlText, paramsByKey) {
    return transformSqlParameters(sqlText, function replace(token, key) {
      const parsed = paramsByKey.get(key);
      if (!parsed || !parsed.normalizedLiteral) {
        return null;
      }
      return parsed.normalizedLiteral;
    });
  }

  function applyFormatting(sqlText, warnings, formatterOverride) {
    if (!sqlText || !sqlText.trim()) {
      return sqlText;
    }

    const formatter = formatterOverride || global.sqlFormatter;
    if (!formatter || typeof formatter.format !== "function") {
      warnings.push("SQL formatter is unavailable; output was left unformatted.");
      return sqlText;
    }

    try {
      return formatter.format(sqlText, {
        language: "transactsql",
        keywordCase: "upper",
      });
    } catch (error) {
      const message = error && error.message ? ` (${error.message})` : "";
      warnings.push(`SQL formatter failed; output was left unformatted.${message}`);
      return sqlText;
    }
  }

  /**
   * @param {string} sqlText
   * @param {string} execText
   * @param {{formatter?: {format: (sql: string, options?: object) => string}}} [options]
   * @returns {GenerationResult}
   */
  function generate(sqlText, execText, options) {
    const safeSql = typeof sqlText === "string" ? sqlText : "";
    const safeExec = typeof execText === "string" ? execText : "";
    const warnings = [];

    const parseResult = parseExecStatement(safeExec);
    warnings.push.apply(warnings, parseResult.warnings);

    const sqlParams = collectSqlParameters(safeSql);
    const usedKeys = new Set(sqlParams.map(function keyOnly(item) {
      return item.key;
    }));

    let canDeclare = sqlParams.length > 0;

    for (const sqlParam of sqlParams) {
      const parsed = parseResult.params.get(sqlParam.key);
      if (!parsed) {
        warnings.push(`Missing value for ${sqlParam.name} in EXEC statement.`);
        canDeclare = false;
        continue;
      }

      if (!parsed.normalizedLiteral) {
        warnings.push(`No literal value was parsed for ${sqlParam.name}.`);
        canDeclare = false;
      }

      if (!parsed.confidence || !parsed.inferredType) {
        const detail = parsed.parseError ? ` (${parsed.parseError})` : "";
        warnings.push(`Type inference is not confident for ${sqlParam.name}${detail}.`);
        canDeclare = false;
      }
    }

    for (const [key, param] of parseResult.params.entries()) {
      if (!usedKeys.has(key)) {
        warnings.push(`EXEC parameter ${param.name} is not referenced in the SQL statement.`);
      }
    }

    let mode = "inline";
    let outputSql = safeSql;

    if (canDeclare) {
      mode = "declare";
      const declareParams = sortSqlParamsForDeclare(sqlParams);
      const declarations = declareParams.map(function declaration(sqlParam) {
        const parsed = parseResult.params.get(sqlParam.key);
        return `${sqlParam.name} ${parsed.inferredType} = ${parsed.normalizedLiteral}`;
      });
      outputSql = `DECLARE ${declarations.join(",\n        ")};\n\n${safeSql.trim()}`;
    } else {
      outputSql = replaceSqlParameters(safeSql, parseResult.params);
      for (const sqlParam of sqlParams) {
        const parsed = parseResult.params.get(sqlParam.key);
        if (!parsed) {
          warnings.push(`Unresolved placeholder ${sqlParam.name} was left unchanged.`);
          continue;
        }

        if (!parsed.normalizedLiteral) {
          warnings.push(`Placeholder ${sqlParam.name} was left unchanged due to missing literal.`);
        } else if (parsed.parseError) {
          warnings.push(`Used best-effort value for ${sqlParam.name}: ${parsed.parseError}`);
        }
      }
    }

    const formattedOutput = applyFormatting(
      outputSql,
      warnings,
      options && options.formatter ? options.formatter : null,
    );

    return {
      mode,
      outputSql: formattedOutput,
      warnings: dedupeStrings(warnings),
      params: Array.from(parseResult.params.values()),
    };
  }

  function saveInputState(sqlText, execText) {
    if (!global.localStorage) {
      return;
    }

    try {
      global.localStorage.setItem(STORAGE_KEYS.sql, sqlText);
      global.localStorage.setItem(STORAGE_KEYS.exec, execText);
    } catch (_error) {
      // Ignore storage errors (private mode / quota).
    }
  }

  function loadInputState() {
    if (!global.localStorage) {
      return { sql: "", exec: "" };
    }

    try {
      return {
        sql: global.localStorage.getItem(STORAGE_KEYS.sql) || "",
        exec: global.localStorage.getItem(STORAGE_KEYS.exec) || "",
      };
    } catch (_error) {
      return { sql: "", exec: "" };
    }
  }

  function clearInputState() {
    if (!global.localStorage) {
      return;
    }

    try {
      global.localStorage.removeItem(STORAGE_KEYS.sql);
      global.localStorage.removeItem(STORAGE_KEYS.exec);
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function renderWarnings(warningsElement, warnings) {
    warningsElement.innerHTML = "";

    if (!warnings.length) {
      const noWarning = document.createElement("p");
      noWarning.textContent = "No warnings.";
      warningsElement.appendChild(noWarning);
      return;
    }

    const title = document.createElement("p");
    title.textContent = warnings.length === 1 ? "1 warning:" : `${warnings.length} warnings:`;
    warningsElement.appendChild(title);

    const list = document.createElement("ul");
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.appendChild(item);
    }
    warningsElement.appendChild(list);
  }

  function setModeBadge(modeBadgeElement, mode) {
    modeBadgeElement.classList.remove("declare", "inline");
    modeBadgeElement.classList.add(mode);
    modeBadgeElement.textContent = `MODE: ${mode.toUpperCase()}`;
  }

  async function copyOutput(outputElement) {
    const text = outputElement.value || "";
    if (!text) {
      return false;
    }

    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      try {
        await global.navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        // Try fallback below.
      }
    }

    outputElement.focus();
    outputElement.select();
    try {
      return document.execCommand("copy");
    } catch (_error) {
      return false;
    }
  }

  function initUi() {
    const sqlInput = document.getElementById("sqlInput");
    const execInput = document.getElementById("execInput");
    const outputSql = document.getElementById("outputSql");
    const warnings = document.getElementById("warnings");
    const modeBadge = document.getElementById("modeBadge");
    const generateBtn = document.getElementById("generateBtn");
    const copyBtn = document.getElementById("copyBtn");
    const clearBtn = document.getElementById("clearBtn");

    if (!sqlInput || !execInput || !outputSql || !warnings || !modeBadge) {
      return;
    }

    const initial = loadInputState();
    sqlInput.value = initial.sql;
    execInput.value = initial.exec;

    setModeBadge(modeBadge, "inline");
    renderWarnings(warnings, []);

    generateBtn.addEventListener("click", function onGenerate() {
      const result = generate(sqlInput.value, execInput.value);
      outputSql.value = result.outputSql;
      setModeBadge(modeBadge, result.mode);
      renderWarnings(warnings, result.warnings);
      saveInputState(sqlInput.value, execInput.value);
    });

    copyBtn.addEventListener("click", async function onCopy() {
      const copied = await copyOutput(outputSql);
      copyBtn.textContent = copied ? "Copied" : "Copy Failed";
      setTimeout(function resetLabel() {
        copyBtn.textContent = "Copy Output";
      }, 1200);
    });

    clearBtn.addEventListener("click", function onClear() {
      sqlInput.value = "";
      execInput.value = "";
      outputSql.value = "";
      setModeBadge(modeBadge, "inline");
      renderWarnings(warnings, []);
      clearInputState();
    });

    sqlInput.addEventListener("input", function onSqlInput() {
      saveInputState(sqlInput.value, execInput.value);
    });

    execInput.addEventListener("input", function onExecInput() {
      saveInputState(sqlInput.value, execInput.value);
    });
  }

  const api = {
    generate,
    parseExecStatement,
    parseValueToken,
    collectSqlParameters,
    replaceSqlParameters,
    applyFormatting,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.NavSqlFormatter = api;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUi);
    } else {
      initUi();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
