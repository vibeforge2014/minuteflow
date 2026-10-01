/**
 * SQLite 存储（node:sqlite，与应用本地库同一技术栈）。单文件 + WAL，
 * 供订单/激活码/设备绑定/回调幂等/退款记账。所有写操作都走显式事务。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.mjs";

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    out_trade_no TEXT NOT NULL UNIQUE,
    amount_fen INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'created',
    qr_payload TEXT,
    transaction_id TEXT,
    license_id TEXT,
    paid_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state, expires_at);

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_encrypted TEXT NOT NULL,
    order_id TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    issued_at TEXT NOT NULL,
    revoked_at TEXT,
    customer_email TEXT
  );

  CREATE TABLE IF NOT EXISTS device_bindings (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    machine_fingerprint TEXT NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT,
    architecture TEXT,
    app_version TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (license_id, machine_fingerprint)
  );

  -- 回调幂等：微信按 notify id、支付宝按 notify_id 时间戳去重，重复投递只记一条。
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    event_type TEXT,
    payload_digest TEXT,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    refund_id TEXT,
    amount_fen INTEGER NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'processed',
    created_at TEXT NOT NULL
  );
`);

export const nowIso = () => new Date().toISOString();

/**
 * 包一层显式事务（node:sqlite 没有 better-sqlite3 的 db.transaction）。
 * 支持扁平嵌套：事务内再调用 transaction() 时直接并入外层（外层保证原子性），
 * 否则 finalizeOrder → issueLicenseForOrder 这类组合会报
 * "cannot start a transaction within a transaction"。
 */
let transactionDepth = 0;
export function transaction(fn) {
  if (transactionDepth > 0) return fn();
  transactionDepth += 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}
