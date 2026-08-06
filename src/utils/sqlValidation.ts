import sqlParser from 'node-sql-parser';
const { Parser } = sqlParser;

const parser = new Parser();

/**
 * Only the non-secret cache tables are queryable. `credentials`, `sessions`
 * and `tenants` are never in this set — they hold encrypted login fields and
 * session cookies and must never be reachable through the SQL tool.
 */
const allowedTables = new Set(['payslips', 'form106']);

const PRAGMA_REGEX = /PRAGMA\s+(?:table_info|index_list)\(['"]?([\w]+)['"]?\)/i;

export function validateSelectQuery(sql: string): { valid: boolean; reason?: string } {
  try {
    if (typeof sql !== 'string') {
      return { valid: false, reason: 'Query must be a string' };
    }

    const trimmedSql = sql.trim();
    if (!trimmedSql) {
      return { valid: false, reason: 'Empty query' };
    }

    if (containsUnquotedSemicolon(trimmedSql)) {
      return { valid: false, reason: 'Multiple statements are not allowed' };
    }

    const pragmaMatch = trimmedSql.match(PRAGMA_REGEX);
    if (pragmaMatch) {
      const tableName = pragmaMatch[1];
      if (!allowedTables.has(tableName)) {
        return { valid: false, reason: `Access to table not allowed in PRAGMA: ${tableName}` };
      }
      return { valid: true };
    }

    const tableMatches = trimmedSql.match(/from\s+([\w]+)/gi) || [];
    const tables = tableMatches
      .map((match: string) => match.replace(/from\s+/i, '').trim())
      .filter(Boolean);

    const disallowedTables = tables.filter((t: string) => !allowedTables.has(t));
    if (disallowedTables.length > 0) {
      return { valid: false, reason: `Access to table(s) not allowed: ${disallowedTables.join(', ')}` };
    }

    try {
      const ast = parser.astify(trimmedSql, { database: 'SQLite' });

      if (Array.isArray(ast)) {
        return { valid: false, reason: 'Only one statement is allowed' };
      }

      if (ast.type !== 'select') {
        return { valid: false, reason: 'Only SELECT statements are allowed' };
      }

      return { valid: true };
    } catch (parseError) {
      return {
        valid: false,
        reason: `Invalid SQL syntax: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Unknown error during validation',
    };
  }
}

function containsUnquotedSemicolon(sql: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prev = sql[i - 1];
    const next = sql[i + 1];

    if (inSingleQuote) {
      if (char === "'" && prev !== '\\') {
        if (next === "'") {
          i++;
        } else {
          inSingleQuote = false;
        }
      }
    } else if (inDoubleQuote) {
      if (char === '"' && prev !== '\\') {
        if (next === '"') {
          i++;
        } else {
          inDoubleQuote = false;
        }
      }
    } else {
      if (char === "'" && prev !== '\\') {
        inSingleQuote = true;
      } else if (char === '"' && prev !== '\\') {
        inDoubleQuote = true;
      } else if (char === ';') {
        return true;
      }
    }
  }

  return false;
}
