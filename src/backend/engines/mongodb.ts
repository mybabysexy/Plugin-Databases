import type { Grid } from "../../shared/types.js";
import type { Engine } from "./types.js";

/**
 * Extracts and parses JSON or EJSON from mongosh/mongo CLI output,
 * handling any shell greeting/warning text and inferring dynamic keys.
 */
export function parseMongo(output: string): Grid {
  const trimmed = output.trim();
  if (!trimmed) return { columns: [], rows: [] };

  // Look for JSON object or array in the output
  let jsonStr = trimmed;
  const startIdx = trimmed.search(/[\{\[]/);
  if (startIdx !== -1) {
    const endObj = trimmed.lastIndexOf("}");
    const endArr = trimmed.lastIndexOf("]");
    const endIdx = Math.max(endObj, endArr);
    if (endIdx > startIdx) {
      jsonStr = trimmed.slice(startIdx, endIdx + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);

    // Case 1: Standard Grid { columns, rows }
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      return {
        columns: parsed.columns.map(String),
        rows: parsed.rows.map((row: unknown[]) =>
          Array.isArray(row)
            ? row.map((val) =>
                val === null || val === undefined ? null : String(val),
              )
            : [String(row)],
        ),
      };
    }

    // Case 2: Array of documents (dynamic schema inference)
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return { columns: ["_id"], rows: [] };

      // Infer the superset of keys across all documents in this batch
      const keysSet = new Set<string>();
      parsed.forEach((doc) => {
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
          Object.keys(doc).forEach((k) => keysSet.add(k));
        }
      });

      keysSet.delete("_id");
      const columns = ["_id", ...Array.from(keysSet)];
      const rows = parsed.map((doc) => {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
          return [JSON.stringify(doc)];
        }
        return columns.map((col) => {
          const val = (doc as Record<string, unknown>)[col];
          if (val === undefined || val === null) return null;
          if (typeof val === "object") return JSON.stringify(val);
          return String(val);
        });
      });
      return { columns, rows };
    }

    // Case 3: Single document
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed);
      return {
        columns: keys,
        rows: [
          keys.map((k) => {
            const val = (parsed as Record<string, unknown>)[k];
            if (val === undefined || val === null) return null;
            if (typeof val === "object") return JSON.stringify(val);
            return String(val);
          }),
        ],
      };
    }

    return { columns: ["value"], rows: [[String(parsed)]] };
  } catch {
    // Plain text output fallback
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    return { columns: ["output"], rows: lines.map((l) => [l]) };
  }
}

const lit = (value: string) => JSON.stringify(value);
const q = (name: string) => JSON.stringify(name);

export const mongodb: Engine = {
  id: "mongodb",
  client: "mongosh",
  passwordEnv: "MONGODB_PWD",
  run: (readOnly) => [
    'MCLI="mongosh"',
    'command -v mongosh >/dev/null 2>&1 || MCLI="mongo"',
    "args=(--quiet)",
    'ADDR="${DB_ADDR:-127.0.0.1}"',
    'PORT="${DB_PORT:-27017}"',
    'AUTH_DB="admin"',
    'PARAMS=""',
    'if [[ "$ADDR" == *"?"* ]]; then',
    '  PARAMS="${ADDR#*?}"',
    '  ADDR="${ADDR%%\\?*}"',
    "fi",
    'if [[ "$PARAMS" =~ authSource=([^&]+) ]]; then',
    '  AUTH_DB="${BASH_REMATCH[1]}"',
    "fi",
    // --- build URI ---
    'case "$ADDR" in',
    "  mongodb://*|mongodb+srv://*)",
    '    URI="$ADDR"',
    "    ;;",
    "  *,*)",
    '    URI="mongodb://$ADDR/${DB_NAME:-admin}?authSource=$AUTH_DB"',
    '    if [ -n "$PARAMS" ]; then',
    '      CLEAN_PARAMS=$(echo "$PARAMS" | sed -E "s/(^|&)authSource=[^&]*//g" | sed "s/^&//")',
    '      [ -n "$CLEAN_PARAMS" ] && URI="$URI&$CLEAN_PARAMS"',
    "    fi",
    "    ;;",
    "  *)",
    '    if [ -n "$PORT" ] && [[ "$ADDR" != *:* ]]; then',
    '      TARGET="$ADDR:$PORT"',
    "    else",
    '      TARGET="$ADDR"',
    "    fi",
    '    URI="mongodb://$TARGET/${DB_NAME:-admin}?authSource=$AUTH_DB"',
    '    if [ -n "$PARAMS" ]; then',
    '      CLEAN_PARAMS=$(echo "$PARAMS" | sed -E "s/(^|&)authSource=[^&]*//g" | sed "s/^&//")',
    '      [ -n "$CLEAN_PARAMS" ] && URI="$URI&$CLEAN_PARAMS"',
    "    fi",
    "    ;;",
    "esac",
    ...(readOnly
      ? [
          'if [[ "$URI" == *"replicaSet="* ]] && [[ "$URI" != *"readPreference="* ]]; then',
          '  URI="$URI&readPreference=secondaryPreferred"',
          "fi",
        ]
      : []),
    // --- inject credentials into URI (compatible with both mongosh and legacy mongo) ---
    'if [ -n "$DB_USER" ]; then',
    // URL-encode user/pass using python3 (available on most systems) with sed fallback
    "  _encode() { python3 -c \"import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(),safe=''))\" 2>/dev/null || cat; }",
    "  ENCODED_USER=$(printf '%s' \"$DB_USER\" | _encode)",
    "  ENCODED_PASS=$(printf '%s' \"$MONGODB_PWD\" | _encode)",
    // Strip any existing scheme and inject user:pass@
    '  _SCHEME="${URI%%://*}://"',
    '  _REST="${URI#*://}"',
    '  if [ -n "$ENCODED_PASS" ]; then',
    '    URI="${_SCHEME}${ENCODED_USER}:${ENCODED_PASS}@${_REST}"',
    "  else",
    '    URI="${_SCHEME}${ENCODED_USER}@${_REST}"',
    "  fi",
    "fi",
    '"$MCLI" "${args[@]}" "$URI" --eval "$SQL" </dev/null',
  ],
  parse: parseMongo,
  q,
  lit,
  value: (text) => lit(text),
  ref: (schema, table) => `db.getSiblingDB(${lit(schema)})[${lit(table)}]`,
  databasesSql: [
    "(function() {",
    "  try {",
    '    const res = db.adminCommand("listDatabases");',
    "    const dbs = (res.databases || []).map(function(d) { return [d.name]; });",
    '    print(JSON.stringify({ columns: ["name"], rows: dbs }));',
    "  } catch(e) {",
    '    print(JSON.stringify({ columns: ["name"], rows: [[db.getName()]] }));',
    "  }",
    "})()",
  ].join("\n"),
  tablesSql: (db) =>
    [
      "(function() {",
      `  const d = db.getSiblingDB(${lit(db)});`,
      "  const colls = d.getCollectionInfos().filter(function(c) {",
      '    return !c.name.startsWith("system.");',
      "  });",
      "  const rows = colls.map(function(c) {",
      "    let count = 0;",
      "    try { count = d[c.name].estimatedDocumentCount(); } catch(e) {}",
      '    return [d.getName(), c.name, c.type === "view" ? "view" : "table", String(count)];',
      "  });",
      '  print(JSON.stringify({ columns: ["schema", "name", "kind", "rows"], rows: rows }));',
      "})()",
    ].join("\n"),
  columnsSql: (schema, table) =>
    [
      "(function() {",
      `  const d = db.getSiblingDB(${lit(schema)});`,
      `  const coll = d[${lit(table)}];`,
      "  const sample = coll.find().limit(100).toArray();",
      "  const map = {};",
      '  map["_id"] = { type: "objectId", nullable: "0", primary: "1", def: null, extra: "PK" };',
      "  sample.forEach(function(doc) {",
      "    Object.keys(doc).forEach(function(key) {",
      '      if (key === "_id") return;',
      "      const val = doc[key];",
      "      let t = typeof val;",
      '      if (val === null) t = "null";',
      '      else if (Array.isArray(val)) t = "array";',
      '      else if (val instanceof Date) t = "date";',
      "      else if (val && val._bsontype) t = val._bsontype.toLowerCase();",
      "      if (!map[key]) {",
      '        map[key] = { type: t, nullable: "1", primary: "0", def: null, extra: "" };',
      '      } else if (map[key].type !== t && t !== "null") {',
      '        map[key].type = "mixed";',
      "      }",
      "    });",
      "  });",
      "  const rows = Object.keys(map).map(function(k) {",
      "    const v = map[k];",
      "    return [k, v.type, v.nullable, v.primary, v.def, v.extra];",
      "  });",
      '  print(JSON.stringify({ columns: ["name", "type", "nullable", "primary", "default", "extra"], rows: rows }));',
      "})()",
    ].join("\n"),
  indexesSql: (schema, table) =>
    [
      "(function() {",
      "  try {",
      `    const d = db.getSiblingDB(${lit(schema)});`,
      `    const coll = d[${lit(table)}];`,
      "    const idxs = coll.getIndexes();",
      "    const rows = idxs.map(function(idx) {",
      '      const keys = Object.keys(idx.key).map(function(k) { return k + ": " + idx.key[k]; }).join(", ");',
      "      const flags = [];",
      '      if (idx.unique) flags.push("UNIQUE");',
      '      if (idx.sparse) flags.push("SPARSE");',
      '      if (idx.expireAfterSeconds !== undefined) flags.push("TTL: " + idx.expireAfterSeconds + "s");',
      '      const def = (flags.length ? flags.join(" ") + " " : "") + "(" + keys + ")";',
      "      return [idx.name, def];",
      "    });",
      '    print(JSON.stringify({ columns: ["name", "definition"], rows: rows }));',
      "  } catch(e) {",
      '    print(JSON.stringify({ columns: ["name", "definition"], rows: [] }));',
      "  }",
      "})()",
    ].join("\n"),
  counted: (statement) => statement,
  insertEmpty: (ref) =>
    `${ref}.insertOne({}); print(JSON.stringify({ columns: ["n"], rows: [["1"]] }))`,
  versionSql:
    'print(JSON.stringify({ columns: ["version"], rows: [[db.version()]] }))',
  systemDatabases: ["admin", "config", "local"],
};
