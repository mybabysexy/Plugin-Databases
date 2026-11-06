import type {
  Affected,
  ColumnInfo,
  Description,
  Grid,
  QueryResult,
  RowDelete,
  RowUpdate,
  RowWrite,
  RowsRequest,
  RowsView,
  RoutineEntry,
  TableEntry,
  TableTarget,
  TestResult,
  ToolsView,
} from "../shared/types.js";
import { DatabasesError } from "./errors.js";
import { getEngine, type Conn, type Engine } from "./engines/index.js";
import { sections } from "./engines/parse.js";
import { parseKeys, type Remote } from "./remote.js";
import { buildScript, TOOLS_SCRIPT } from "./script.js";
import { CONSOLE_ROWS, MAX_ROWS } from "./validate.js";

const BINARY = /blob|binary|bytea/i;

function toColumns(grid: Grid): ColumnInfo[] {
  return grid.rows.map(([name, type, nullable, primary, def, extra]) => ({
    name: name ?? "",
    type: type ?? "",
    nullable: nullable === "1",
    primary: primary === "1",
    default: def ?? null,
    extra: extra ?? "",
    editable: !BINARY.test(type ?? "") && !/generated/i.test(extra ?? ""),
  }));
}

function parseMongoValues(values: Record<string, string | null>) {
  const doc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null) {
      doc[k] = null;
    } else {
      const trimmed = v.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          doc[k] = JSON.parse(trimmed);
          continue;
        } catch {
          // keep as string
        }
      }
      doc[k] = v;
    }
  }
  return doc;
}

export function createService(remote: Remote) {
  async function run(
    hostId: number,
    conn: Conn,
    db: string,
    statements: string[],
    readOnly: boolean,
  ): Promise<{ engine: Engine; parts: string[] }> {
    const engine = getEngine(conn.engine);
    const script = buildScript(engine, conn, db, statements, readOnly);
    const output = await remote.run(hostId, conn.runAs, script);
    return { engine, parts: sections(output) };
  }

  /** MySQL and MongoDB have no schema inside a database, so the database is the schema. */
  const schemaOf = (conn: Conn, target: TableTarget) =>
    conn.engine === "mysql" || conn.engine === "mongodb"
      ? target.db
      : target.schema || "public";

  async function columnsOf(
    hostId: number,
    conn: Conn,
    target: TableTarget,
  ): Promise<ColumnInfo[]> {
    const schema = schemaOf(conn, target);
    const engine = getEngine(conn.engine);
    const { parts } = await run(
      hostId,
      conn,
      target.db,
      [engine.columnsSql(schema, target.table)],
      true,
    );
    const columns = toColumns(engine.parse(parts[0] ?? ""));
    if (columns.length === 0) {
      throw new DatabasesError("The table was not found", 404);
    }
    return columns;
  }

  function keyWhere(
    engine: Engine,
    columns: ColumnInfo[],
    key: Record<string, string | null>,
  ): string {
    const keyCols = columns.filter((c) => c.primary);
    if (keyCols.length === 0) {
      throw new DatabasesError(
        "This table has no primary key, so it is read only",
      );
    }
    return keyCols
      .map((c) => {
        const value = key[c.name];
        if (typeof value !== "string") {
          throw new DatabasesError(`The key value for ${c.name} is missing`);
        }
        return `${engine.q(c.name)} = ${engine.value(value, c.type)}`;
      })
      .join(" AND ");
  }

  function assignments(
    engine: Engine,
    columns: ColumnInfo[],
    values: Record<string, string | null>,
  ): Array<{ column: string; expr: string }> {
    return Object.entries(values).map(([name, value]) => {
      const col = columns.find((c) => c.name === name);
      if (!col) throw new DatabasesError(`The column ${name} was not found`);
      if (!col.editable) {
        throw new DatabasesError(`The column ${name} cannot be edited`);
      }
      return {
        column: engine.q(name),
        expr: value === null ? "NULL" : engine.value(value, col.type),
      };
    });
  }

  async function counted(
    hostId: number,
    conn: Conn,
    target: TableTarget,
    statement: (engine: Engine) => string,
  ): Promise<Affected> {
    const engine = getEngine(conn.engine);
    const { parts } = await run(
      hostId,
      conn,
      target.db,
      [engine.counted(statement(engine))],
      false,
    );
    const grid = engine.parse(parts[0] ?? "");
    return { affected: Number(grid.rows[0]?.[0] ?? 0) };
  }

  return {
    async tools(hostId: number): Promise<ToolsView> {
      const output = await remote.run(hostId, "", TOOLS_SCRIPT, 15_000);
      const keys = parseKeys(output);
      return {
        mysql: keys.mysql || null,
        psql: keys.psql || null,
        sqlite3: keys.sqlite3 || null,
        mongosh: keys.mongosh || keys.mongo || null,
      };
    },

    async test(hostId: number, conn: Conn): Promise<TestResult> {
      const engine = getEngine(conn.engine);
      const { parts } = await run(hostId, conn, "", [engine.versionSql], true);
      const grid = engine.parse(parts[0] ?? "");
      return { version: grid.rows[0]?.[0] ?? "" };
    },

    async databases(hostId: number, conn: Conn): Promise<string[]> {
      const engine = getEngine(conn.engine);
      const { parts } = await run(
        hostId,
        conn,
        "",
        [engine.databasesSql],
        true,
      );
      return engine
        .parse(parts[0] ?? "")
        .rows.map((row) => row[0] ?? "")
        .filter((name) => name && !engine.systemDatabases.includes(name));
    },

    async tables(
      hostId: number,
      conn: Conn,
      db: string,
    ): Promise<TableEntry[]> {
      const engine = getEngine(conn.engine);
      const { parts } = await run(
        hostId,
        conn,
        db,
        [engine.tablesSql(db)],
        true,
      );
      return engine
        .parse(parts[0] ?? "")
        .rows.map(([schema, name, kind, rows]) => ({
          schema: schema ?? "",
          name: name ?? "",
          kind: kind === "view" ? "view" : "table",
          rows: rows === null || rows === undefined ? null : Number(rows),
        }));
    },

    /** Stored procedures and functions. SQLite has none. */
    async routines(
      hostId: number,
      conn: Conn,
      db: string,
    ): Promise<RoutineEntry[]> {
      const engine = getEngine(conn.engine);
      if (!engine.routinesSql) return [];
      const { parts } = await run(
        hostId,
        conn,
        db,
        [engine.routinesSql(db)],
        true,
      );
      return engine
        .parse(parts[0] ?? "")
        .rows.map(([schema, name, kind, definition]) => ({
          schema: schema ?? "",
          name: name ?? "",
          kind: kind === "procedure" ? "procedure" : "function",
          definition: definition ?? null,
        }));
    },

    async describe(
      hostId: number,
      conn: Conn,
      target: TableTarget,
    ): Promise<Description> {
      const engine = getEngine(conn.engine);
      const schema = schemaOf(conn, target);
      const { parts } = await run(
        hostId,
        conn,
        target.db,
        [
          engine.columnsSql(schema, target.table),
          engine.indexesSql(schema, target.table),
        ],
        true,
      );
      return {
        columns: toColumns(engine.parse(parts[0] ?? "")),
        indexes: engine
          .parse(parts[1] ?? "")
          .rows.map(([name, definition]) => ({
            name: name ?? "",
            definition: definition ?? "",
          })),
      };
    },

    async rows(
      hostId: number,
      conn: Conn,
      req: RowsRequest & { where: string },
    ): Promise<RowsView> {
      const engine = getEngine(conn.engine);
      const schema = schemaOf(conn, req);

      if (conn.engine === "mongodb") {
        const limit = Math.min(Math.max(req.limit, 1), MAX_ROWS);
        const offset = Math.max(req.offset, 0);
        const mongoScript = [
          "(function() {",
          `  const d = db.getSiblingDB(${JSON.stringify(schema)});`,
          `  const coll = d[${JSON.stringify(req.table)}];`,
          "  let filter = {};",
          `  const rawWhere = ${JSON.stringify(req.where.trim())};`,
          "  if (rawWhere) {",
          "    try { filter = JSON.parse(rawWhere); } catch(e) {}",
          "  }",
          "  let total = 0;",
          "  try { total = coll.countDocuments(filter); } catch(e) {",
          "    try { total = coll.find(filter).count(); } catch(e2) {}",
          "  }",
          "  const sort = {};",
          `  const sortCol = ${JSON.stringify(req.orderBy)};`,
          "  if (sortCol) {",
          `    sort[sortCol] = ${req.dir === "desc" ? -1 : 1};`,
          "  }",
          `  const docs = coll.find(filter).sort(sort).skip(${offset}).limit(${limit}).toArray();`,
          "  const fieldMap = {};",
          '  fieldMap["_id"] = { type: "objectId", nullable: "0", primary: "1", def: null, extra: "PK" };',
          "  docs.forEach(function(doc) {",
          "    Object.keys(doc).forEach(function(key) {",
          '      if (key === "_id") return;',
          "      const val = doc[key];",
          "      let t = typeof val;",
          '      if (val === null) t = "null";',
          '      else if (Array.isArray(val)) t = "array";',
          '      else if (val instanceof Date) t = "date";',
          "      else if (val && val._bsontype) t = val._bsontype.toLowerCase();",
          "      if (!fieldMap[key]) {",
          '        fieldMap[key] = { type: t, nullable: "1", primary: "0", def: null, extra: "" };',
          '      } else if (fieldMap[key].type !== t && t !== "null") {',
          '        fieldMap[key].type = "mixed";',
          "      }",
          "    });",
          "  });",
          "  const cols = Object.keys(fieldMap);",
          "  const colInfos = cols.map(function(k) {",
          "    const v = fieldMap[k];",
          "    return [k, v.type, v.nullable, v.primary, v.def, v.extra];",
          "  });",
          "  const rows = docs.map(function(doc) {",
          "    return cols.map(function(col) {",
          "      const val = doc[col];",
          "      if (val === undefined || val === null) return null;",
          '      if (typeof val === "object") {',
          "        if (val instanceof Date) return val.toISOString();",
          '        if (val._bsontype === "ObjectId") return val.toString();',
          "        return JSON.stringify(val);",
          "      }",
          "      return String(val);",
          "    });",
          "  });",
          "  print(JSON.stringify({",
          "    columnsInfo: colInfos,",
          "    total: total,",
          "    grid: { columns: cols, rows: rows }",
          "  }));",
          "})()",
        ].join("\n");

        const { parts } = await run(hostId, conn, req.db, [mongoScript], true);
        const parsed = JSON.parse(parts[0] || "{}");
        const columns = toColumns({
          columns: [],
          rows: parsed.columnsInfo || [
            ["_id", "objectId", "0", "1", null, "PK"],
          ],
        });
        return {
          columns,
          total: Number(parsed.total || 0),
          grid: parsed.grid || { columns: ["_id"], rows: [] },
        };
      }

      const ref = engine.ref(schema, req.table);
      const where = req.where ? ` WHERE ${req.where}` : "";
      const order = req.orderBy
        ? ` ORDER BY ${engine.q(req.orderBy)} ${req.dir === "desc" ? "DESC" : "ASC"}`
        : "";
      const limit = Math.min(Math.max(req.limit, 1), MAX_ROWS);
      const offset = Math.max(req.offset, 0);
      const { parts } = await run(
        hostId,
        conn,
        req.db,
        [
          engine.columnsSql(schema, req.table),
          `SELECT COUNT(*) AS n FROM ${ref}${where}`,
          `SELECT * FROM ${ref}${where}${order} LIMIT ${limit} OFFSET ${offset}`,
        ],
        true,
      );
      const columns = toColumns(engine.parse(parts[0] ?? ""));
      if (columns.length === 0) {
        throw new DatabasesError("The table was not found", 404);
      }
      return {
        columns,
        total: Number(engine.parse(parts[1] ?? "").rows[0]?.[0] ?? 0),
        grid: engine.parse(parts[2] ?? ""),
      };
    },

    async insert(hostId: number, conn: Conn, req: RowWrite): Promise<Affected> {
      if (conn.engine === "mongodb") {
        const schema = schemaOf(conn, req);
        const doc = parseMongoValues(req.values);
        const insertScript = [
          "(function() {",
          `  const d = db.getSiblingDB(${JSON.stringify(schema)});`,
          `  const coll = d[${JSON.stringify(req.table)}];`,
          `  const doc = ${JSON.stringify(doc)};`,
          '  if (doc._id && typeof doc._id === "string" && /^[0-9a-fA-F]{24}$/.test(doc._id)) {',
          "    try { doc._id = ObjectId(doc._id); } catch(e) {}",
          "  }",
          "  coll.insertOne(doc);",
          '  print(JSON.stringify({ columns: ["n"], rows: [["1"]] }));',
          "})()",
        ].join("\n");
        const { parts } = await run(
          hostId,
          conn,
          req.db,
          [insertScript],
          false,
        );
        const grid = getEngine(conn.engine).parse(parts[0] ?? "");
        return { affected: Number(grid.rows[0]?.[0] ?? 1) };
      }

      const columns = await columnsOf(hostId, conn, req);
      return counted(hostId, conn, req, (engine) => {
        const ref = engine.ref(schemaOf(conn, req), req.table);
        const set = assignments(engine, columns, req.values);
        if (set.length === 0) return engine.insertEmpty(ref);
        return `INSERT INTO ${ref} (${set.map((s) => s.column).join(", ")}) VALUES (${set
          .map((s) => s.expr)
          .join(", ")})`;
      });
    },

    async update(
      hostId: number,
      conn: Conn,
      req: RowUpdate,
    ): Promise<Affected> {
      if (conn.engine === "mongodb") {
        const schema = schemaOf(conn, req);
        const idVal = req.key._id || Object.values(req.key)[0] || "";
        const doc = parseMongoValues(req.values);
        delete doc._id;
        const updateScript = [
          "(function() {",
          `  const d = db.getSiblingDB(${JSON.stringify(schema)});`,
          `  const coll = d[${JSON.stringify(req.table)}];`,
          `  const id = ${JSON.stringify(idVal)};`,
          "  let filter = { _id: id };",
          "  if (/^[0-9a-fA-F]{24}$/.test(id)) {",
          "    try { filter = { $or: [{ _id: ObjectId(id) }, { _id: id }] }; } catch(e) {}",
          "  }",
          `  const update = ${JSON.stringify(doc)};`,
          "  const res = coll.updateOne(filter, { $set: update });",
          "  const n = res ? (res.modifiedCount || res.matchedCount || 1) : 1;",
          '  print(JSON.stringify({ columns: ["n"], rows: [[String(n)]] }));',
          "})()",
        ].join("\n");
        const { parts } = await run(
          hostId,
          conn,
          req.db,
          [updateScript],
          false,
        );
        const grid = getEngine(conn.engine).parse(parts[0] ?? "");
        return { affected: Number(grid.rows[0]?.[0] ?? 1) };
      }

      const columns = await columnsOf(hostId, conn, req);
      return counted(hostId, conn, req, (engine) => {
        const set = assignments(engine, columns, req.values);
        if (set.length === 0) throw new DatabasesError("Nothing to change");
        const ref = engine.ref(schemaOf(conn, req), req.table);
        return `UPDATE ${ref} SET ${set
          .map((s) => `${s.column} = ${s.expr}`)
          .join(", ")} WHERE ${keyWhere(engine, columns, req.key)}`;
      });
    },

    async remove(
      hostId: number,
      conn: Conn,
      req: RowDelete,
    ): Promise<Affected> {
      if (conn.engine === "mongodb") {
        const schema = schemaOf(conn, req);
        const idVal = req.key._id || Object.values(req.key)[0] || "";
        const deleteScript = [
          "(function() {",
          `  const d = db.getSiblingDB(${JSON.stringify(schema)});`,
          `  const coll = d[${JSON.stringify(req.table)}];`,
          `  const id = ${JSON.stringify(idVal)};`,
          "  let filter = { _id: id };",
          "  if (/^[0-9a-fA-F]{24}$/.test(id)) {",
          "    try { filter = { $or: [{ _id: ObjectId(id) }, { _id: id }] }; } catch(e) {}",
          "  }",
          "  const res = coll.deleteOne(filter);",
          "  const n = res ? (res.deletedCount || 1) : 1;",
          '  print(JSON.stringify({ columns: ["n"], rows: [[String(n)]] }));',
          "})()",
        ].join("\n");
        const { parts } = await run(
          hostId,
          conn,
          req.db,
          [deleteScript],
          false,
        );
        const grid = getEngine(conn.engine).parse(parts[0] ?? "");
        return { affected: Number(grid.rows[0]?.[0] ?? 1) };
      }

      const columns = await columnsOf(hostId, conn, req);
      return counted(hostId, conn, req, (engine) => {
        const ref = engine.ref(schemaOf(conn, req), req.table);
        return `DELETE FROM ${ref} WHERE ${keyWhere(engine, columns, req.key)}`;
      });
    },

    async query(
      hostId: number,
      conn: Conn,
      db: string,
      sql: string,
      readOnly: boolean,
    ): Promise<QueryResult> {
      const started = Date.now();
      let queryStmt = sql;

      if (conn.engine === "mongodb") {
        queryStmt = [
          "(function() {",
          `  const __res = (function() { return (${sql.trim()}); })();`,
          '  if (__res && typeof __res.toArray === "function") {',
          "    print(JSON.stringify(__res.toArray()));",
          "  } else {",
          "    print(JSON.stringify(__res));",
          "  }",
          "})()",
        ].join("\n");
      }

      const { engine, parts } = await run(
        hostId,
        conn,
        db,
        [queryStmt],
        readOnly,
      );
      const grid = engine.parse(parts[0] ?? "");
      const truncated = grid.rows.length > CONSOLE_ROWS;
      return {
        columns: grid.columns,
        rows: truncated ? grid.rows.slice(0, CONSOLE_ROWS) : grid.rows,
        truncated,
        elapsedMs: Date.now() - started,
        readOnly,
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;
