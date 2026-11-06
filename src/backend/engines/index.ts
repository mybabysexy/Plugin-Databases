import type { EngineId } from "../../shared/types.js";
import { mongodb } from "./mongodb.js";
import { mysql } from "./mysql.js";
import { postgres } from "./postgres.js";
import { sqlite } from "./sqlite.js";
import type { Engine } from "./types.js";

const ENGINE_MAP: Record<EngineId, Engine> = {
  mysql,
  postgres,
  sqlite,
  mongodb,
};

export function getEngine(id: EngineId): Engine {
  return ENGINE_MAP[id];
}

export type { Conn, Engine } from "./types.js";
