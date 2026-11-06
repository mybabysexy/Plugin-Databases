import { describe, expect, it } from "vitest";
import { getEngine, type Conn } from "../../src/backend/engines/index.js";
import { parseMongo } from "../../src/backend/engines/mongodb.js";
import { buildScript } from "../../src/backend/script.js";
import {
  connectionInput,
  filter,
  plainSql,
} from "../../src/backend/validate.js";

describe("MongoDB Engine & Dynamic Schema Parser", () => {
  it("parses structured { columns, rows } format", () => {
    const input = JSON.stringify({
      columns: ["schema", "name", "kind", "rows"],
      rows: [
        ["shop", "users", "table", "150"],
        ["shop", "orders", "table", "320"],
      ],
    });
    const grid = parseMongo(input);
    expect(grid.columns).toEqual(["schema", "name", "kind", "rows"]);
    expect(grid.rows).toEqual([
      ["shop", "users", "table", "150"],
      ["shop", "orders", "table", "320"],
    ]);
  });

  it("parses an array of dynamic documents extracting union of keys with _id first", () => {
    const docs = [
      { _id: "64b0001", name: "Alice", age: 30 },
      {
        _id: "64b0002",
        name: "Bob",
        email: "bob@example.com",
        tags: ["admin", "dev"],
      },
      { _id: "64b0003", role: "guest", meta: { score: 99 } },
    ];
    const grid = parseMongo(JSON.stringify(docs));
    // _id must be first
    expect(grid.columns[0]).toBe("_id");
    // All other fields must be present
    expect(grid.columns).toContain("name");
    expect(grid.columns).toContain("age");
    expect(grid.columns).toContain("email");
    expect(grid.columns).toContain("tags");
    expect(grid.columns).toContain("role");
    expect(grid.columns).toContain("meta");

    expect(grid.rows).toHaveLength(3);
    // Missing fields should be null
    const nameIdx = grid.columns.indexOf("name");
    const emailIdx = grid.columns.indexOf("email");
    const tagsIdx = grid.columns.indexOf("tags");
    const metaIdx = grid.columns.indexOf("meta");

    // Doc 1 (Alice) has no email
    expect(grid.rows[0][emailIdx]).toBeNull();
    // Doc 2 (Bob) has tags serialized as JSON
    expect(grid.rows[1][tagsIdx]).toBe(JSON.stringify(["admin", "dev"]));
    // Doc 3 has meta serialized as JSON
    expect(grid.rows[2][metaIdx]).toBe(JSON.stringify({ score: 99 }));
    expect(grid.rows[2][nameIdx]).toBeNull();
  });

  it("handles empty arrays and single objects", () => {
    expect(parseMongo("[]")).toEqual({ columns: ["_id"], rows: [] });
    const single = parseMongo(JSON.stringify({ _id: "1", status: "ok" }));
    expect(single.columns).toEqual(["_id", "status"]);
    expect(single.rows).toEqual([["1", "ok"]]);
  });

  it("extracts JSON even if preceded by mongosh greetings or warnings", () => {
    const noisyOutput = [
      "Connecting to: mongodb://127.0.0.1:27017/?directConnection=true",
      "Using MongoDB: 7.0.5",
      "Using Mongosh: 2.1.1",
      JSON.stringify({ columns: ["version"], rows: [["7.0.5"]] }),
    ].join("\n");
    const grid = parseMongo(noisyOutput);
    expect(grid.columns).toEqual(["version"]);
    expect(grid.rows).toEqual([["7.0.5"]]);
  });
});

describe("MongoDB Script Generation", () => {
  const engine = getEngine("mongodb");

  it("generates valid standalone bash script with password in environment", () => {
    const conn: Conn = {
      engine: "mongodb",
      address: "127.0.0.1",
      port: 27017,
      username: "myUser",
      password: "secretPassword123",
      database: "myShop",
      runAs: "",
    };
    const script = buildScript(engine, conn, "myShop", ["db.version()"], false);
    // Password must not be hardcoded in plaintext
    expect(script).not.toContain("secretPassword123");
    expect(script).toContain("MONGODB_PWD");
    // Client check supports mongosh and mongo
    expect(script).toContain("command -v mongosh || command -v mongo");
    expect(script).toContain("dbx() {");
    expect(script).toContain(
      'args+=(--username "$DB_USER" --authenticationDatabase "$AUTH_DB")',
    );
    expect(script).toContain('args+=(--password "$MONGODB_PWD")');
  });

  it("generates replica set connection with multiple members and replicaSet query option", () => {
    const conn: Conn = {
      engine: "mongodb",
      address:
        "mongo1:27017,mongo2:27017,mongo3:27017?replicaSet=rs0&authSource=admin",
      port: null,
      username: "adminUser",
      password: "pass",
      database: "admin",
      runAs: "",
      replicaSet: "rs0",
      authSource: "admin",
    };
    const script = buildScript(engine, conn, "admin", ["rs.status()"], false);
    expect(script).toContain('case "$ADDR" in');
    expect(script).toContain("*,*)");
    expect(script).toContain(
      'URI="mongodb://$ADDR/${DB_NAME:-admin}?authSource=$AUTH_DB"',
    );
  });

  it("adds secondaryPreferred readPreference when readOnly is enabled", () => {
    const conn: Conn = {
      engine: "mongodb",
      address: "mongo1:27017,mongo2:27017?replicaSet=rs0",
      port: null,
      username: "",
      password: "",
      database: "analytics",
      runAs: "",
    };
    const script = buildScript(engine, conn, "analytics", ["db.stats()"], true);
    expect(script).toContain("readPreference=secondaryPreferred");
  });
});

describe("MongoDB Validation", () => {
  it("validates MongoDB connection input for standalone", () => {
    const input = connectionInput({
      name: "Local Mongo",
      engine: "mongodb",
      address: "127.0.0.1",
      port: 27017,
      database: "testdb",
    });
    expect(input.engine).toBe("mongodb");
    expect(input.address).toBe("127.0.0.1");
    expect(input.port).toBe(27017);
  });

  it("validates MongoDB connection input for multi-host replica set", () => {
    const input = connectionInput({
      name: "Prod Replica Set",
      engine: "mongodb",
      address: "node1.internal:27017,node2.internal:27017,node3.internal:27017",
      port: "",
      replicaSet: "rs0",
      authSource: "admin",
      database: "production",
    });
    expect(input.engine).toBe("mongodb");
    expect(input.address).toContain(
      "node1.internal:27017,node2.internal:27017",
    );
    expect(input.replicaSet).toBe("rs0");
    expect(input.authSource).toBe("admin");
  });

  it("allows JSON filter for MongoDB queries", () => {
    const f = filter(
      '{"status": "active", "profile.age": { "$gte": 18 }}',
      "mongodb",
    );
    expect(f).toBe('{"status": "active", "profile.age": { "$gte": 18 }}');
  });

  it("allows MongoDB JavaScript expressions in plainSql", () => {
    const cmd = "db.users.find({ role: 'admin' }).limit(10)";
    expect(plainSql("mongodb", cmd)).toBe(cmd);
  });
});
