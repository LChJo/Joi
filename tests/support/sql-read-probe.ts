import type { DatabaseSync } from "node:sqlite";

interface Database {
  transaction<T>(operation: (connection: DatabaseSync) => T): T;
}

export function probeSqlReads(database: Database) {
  const statements: string[] = [];
  const connections = new WeakMap<DatabaseSync, DatabaseSync>();
  return {
    statements,
    database: {
      transaction<T>(operation: (connection: DatabaseSync) => T): T {
        return database.transaction(connection => {
          let observed = connections.get(connection);
          if (observed === undefined) {
            observed = new Proxy(connection, {
              get(target, property) {
                if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
                const value: unknown = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) as unknown : value;
              },
            });
            connections.set(connection, observed);
          }
          return operation(observed);
        });
      },
    },
  };
}
