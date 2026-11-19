const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

function translateSql(sql) {
  const ignoreConflicts = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  let translated = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
  if (ignoreConflicts) translated = `${translated.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
  let parameter = 0;
  return translated.replace(/\?/g, () => `$${++parameter}`);
}

class PostgresConnection {
  constructor(queryable) {
    this.queryable = queryable;
    this.type = "postgres";
  }

  prepare(sql) {
    const translated = translateSql(sql);
    return {
      get: async (...parameters) => {
        const result = await this.queryable.query(translated, parameters);
        return result.rows[0];
      },
      all: async (...parameters) => {
        const result = await this.queryable.query(translated, parameters);
        return result.rows;
      },
      run: async (...parameters) => {
        const result = await this.queryable.query(translated, parameters);
        return { changes: result.rowCount };
      }
    };
  }

  async exec(sql) {
    await this.queryable.query(sql);
  }
}

class PostgresDatabase extends PostgresConnection {
  constructor(connectionString) {
    const pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: true },
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      application_name: "fbc-paypoint"
    });
    super(pool);
    this.pool = pool;
    this.type = "postgres";
    pool.on("error", error => console.error("Supabase database pool error.", error.message));
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresConnection(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class SQLiteConnection {
  constructor(database, runOperation = operation => operation()) {
    this.database = database;
    this.runOperation = runOperation;
    this.type = "sqlite";
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    const run = (method, parameters) => this.runOperation(() => statement[method](...parameters));
    return {
      get: (...parameters) => run("get", parameters),
      all: (...parameters) => run("all", parameters),
      run: (...parameters) => run("run", parameters)
    };
  }

  exec(sql) {
    return this.database.exec(sql);
  }
}

class SQLiteDatabase extends SQLiteConnection {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    super(database, operation => this.runExclusive(operation));
    this.type = "sqlite";
    this.operationTail = Promise.resolve();
  }

  async runExclusive(operation) {
    let release;
    const previous = this.operationTail;
    this.operationTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  async exec(sql) {
    return this.runExclusive(() => this.database.exec(sql));
  }

  async transaction(callback) {
    return this.runExclusive(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback(new SQLiteConnection(this.database));
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close() {
    this.database.close();
  }
}

function createDatabase({ databasePath }) {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) return new PostgresDatabase(connectionString);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL must be configured for production. SQLite is only available for local development.");
  }
  return new SQLiteDatabase(databasePath);
}

module.exports = { createDatabase };
