import { app } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

let database;

const nowIso = () => new Date().toISOString();

const safeJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const seedMeetings = [
  {
    id: "product-weekly-2026-07-30",
    title: "产品团队周会",
    scheduledAt: "2026-07-30T10:00:00+08:00",
    durationSeconds: 1477,
    status: "recording",
    mode: "online",
    favorite: false,
    participants: ["我", "刘婷", "周哲", "王敏"],
    tags: ["产品", "周会"],
    goals: ["对齐本周重点进展与风险", "决定登录流程改版的下一步方案", "明确需要跨团队协作的事项"],
    notes: ["关注登录改版的 AB 方案选择", "确认埋点需求与数据口径", "跟进客服反馈的两类高频问题"],
    summary: {
      topics: ["登录流程改版", "AB 测试流量", "客服高频问题"],
      keyPoints: [
        "会议开始，主持人说明本周议程与目标。",
        "刘婷汇报登录流程改版进展，A 方案已完成可用性测试。",
        "周哲反馈数据埋点方案，需要补充登录失败原因的细分埋点。",
        "讨论 AB 测试方案，倾向先在 5% 流量灰度。",
        "确认需要法务评估第三方登录的合规风险。",
        "建议下周邀请客服参与需求评审。",
        "决定本周四前完成埋点方案评审。",
        "针对用户反馈的高频问题，由产品与客服对齐处理方案。"
      ],
      decisions: ["本周四前完成埋点方案评审。"],
      actionItems: [
        { id: "a1", title: "输出登录流程 AB 测试方案并评审", owner: "刘婷", dueDate: "08-03", status: "in_progress", done: false },
        { id: "a2", title: "补充登录失败原因的埋点设计", owner: "周哲", dueDate: "08-01", status: "in_progress", done: false },
        { id: "a3", title: "法务评估第三方登录合规风险", owner: "王敏（法务）", dueDate: "08-02", status: "todo", done: false },
        { id: "a4", title: "整理客服高频问题并对齐处理方案", owner: "我", dueDate: "08-04", status: "todo", done: false }
      ],
      openQuestions: ["登录失败原因是否需要拆分到设备维度？"],
      risks: ["第三方登录合规评估可能影响上线时间。"],
      nextSteps: ["完成小流量灰度后复盘转化和留存表现。"],
      updatedAt: "2026-07-30T10:20:00+08:00",
      stale: false
    },
    transcript: [
      { id: "t1", startMs: 0, endMs: 12000, speakerId: "me", speakerName: "我", text: "大家好，我们开始今天的周会，先快速对齐议程。", status: "final", track: "microphone" },
      { id: "t2", startMs: 60000, endMs: 92000, speakerId: "liuting", speakerName: "刘婷", text: "我先汇报登录流程改版的进展。A 方案的可用性测试已经完成，整体反馈比 B 方案更好。", status: "final", track: "system" },
      { id: "t3", startMs: 180000, endMs: 212000, speakerId: "zhouzhe", speakerName: "周哲", text: "我这边看了初版埋点方案，有个补充：登录失败原因需要再细分几个类型，方便后续分析。", status: "final", track: "system" },
      { id: "t4", startMs: 300000, endMs: 327000, speakerId: "me", speakerName: "我", text: "好的，这个很关键，细分一下原因我们才能更准确定位问题。", status: "final", track: "microphone" },
      { id: "t5", startMs: 360000, endMs: 392000, speakerId: "liuting", speakerName: "刘婷", text: "关于 AB 测试，我倾向先在 5% 流量灰度，验证转化和留存影响。", status: "final", track: "system" },
      { id: "t6", startMs: 480000, endMs: 512000, speakerId: "zhouzhe", speakerName: "周哲", text: "同意，另外需要确认一下埋点评审的时间，我争取周四前完成。", status: "final", track: "system" },
      { id: "t7", startMs: 600000, endMs: 632000, speakerId: "me", speakerName: "我", text: "下周可以邀请客服一起参与需求评审，把高频问题的处理方案一起过一遍。", status: "final", track: "microphone" }
    ],
    createdAt: "2026-07-30T09:52:00+08:00",
    updatedAt: "2026-07-30T10:24:00+08:00"
  },
  {
    id: "mobile-review-2026-07-28",
    title: "项目复盘：移动端体验优化",
    scheduledAt: "2026-07-28T16:00:00+08:00",
    durationSeconds: 3492,
    status: "complete",
    mode: "online",
    favorite: false,
    participants: ["我", "赵宇"],
    tags: ["复盘"],
    goals: ["复盘移动端体验问题"],
    notes: ["聚焦首屏速度与导航层级"],
    summary: { topics: ["移动端体验"], keyPoints: ["确认首屏加载和导航层级是主要改进点。"], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [], stale: false },
    transcript: [],
    createdAt: "2026-07-28T15:55:00+08:00",
    updatedAt: "2026-07-28T17:02:00+08:00"
  },
  {
    id: "design-review-2026-07-28",
    title: "设计评审：登录流程改版",
    scheduledAt: "2026-07-28T10:00:00+08:00",
    durationSeconds: 2538,
    status: "complete",
    mode: "online",
    favorite: true,
    participants: ["我", "刘婷", "王敏"],
    tags: ["设计"],
    goals: ["评审登录流程"],
    notes: ["重点关注错误恢复"],
    summary: { topics: ["登录流程"], keyPoints: ["A 方案在错误恢复上更清晰。"], decisions: ["进入可用性测试。"], actionItems: [], openQuestions: [], risks: [], nextSteps: [], stale: false },
    transcript: [],
    createdAt: "2026-07-28T09:52:00+08:00",
    updatedAt: "2026-07-28T10:47:00+08:00"
  },
  {
    id: "market-sync-2026-07-27",
    title: "与市场团队对齐会",
    scheduledAt: "2026-07-27T14:30:00+08:00",
    durationSeconds: 2165,
    status: "complete",
    mode: "offline",
    favorite: false,
    participants: ["我", "陈晨"],
    tags: ["市场"],
    goals: ["对齐发布节奏"],
    notes: [],
    summary: { topics: ["发布节奏"], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [], stale: false },
    transcript: [],
    createdAt: "2026-07-27T14:22:00+08:00",
    updatedAt: "2026-07-27T15:10:00+08:00"
  }
];

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      mode TEXT NOT NULL DEFAULT 'online',
      favorite INTEGER NOT NULL DEFAULT 0,
      participants_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      goals_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      notes_markdown TEXT NOT NULL DEFAULT '',
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      speaker_id TEXT NOT NULL,
      speaker_name TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'final',
      track TEXT NOT NULL DEFAULT 'mixed',
      confidence REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transcript_meeting_time
      ON transcript_segments(meeting_id, start_ms);
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      transport TEXT NOT NULL,
      base_url TEXT,
      model TEXT,
      secret_id TEXT,
      options_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio_chunks (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      track TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      meeting_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS meeting_search USING fts5(
      meeting_id UNINDEXED,
      title,
      notes,
      summary,
      transcript,
      tokenize = 'unicode61'
    );
  `);
  const meetingColumns = db.prepare("PRAGMA table_info(meetings)").all();
  if (!meetingColumns.some((column) => column.name === "notes_markdown")) {
    db.exec("ALTER TABLE meetings ADD COLUMN notes_markdown TEXT NOT NULL DEFAULT ''");
  }
}

function rowToMeeting(db, row) {
  const transcript = db.prepare(`
    SELECT id, start_ms, end_ms, speaker_id, speaker_name, text, status, track, confidence
    FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms ASC
  `).all(row.id).map((segment) => ({
    id: segment.id,
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    speakerId: segment.speaker_id,
    speakerName: segment.speaker_name,
    text: segment.text,
    status: segment.status,
    track: segment.track,
    confidence: segment.confidence ?? undefined
  }));

  const notes = safeJson(row.notes_json, []);
  return {
    id: row.id,
    title: row.title,
    scheduledAt: row.scheduled_at,
    durationSeconds: row.duration_seconds,
    status: row.status,
    mode: row.mode,
    favorite: Boolean(row.favorite),
    participants: safeJson(row.participants_json, []),
    tags: safeJson(row.tags_json, []),
    goals: safeJson(row.goals_json, []),
    notes,
    notesMarkdown: row.notes_markdown || notes.map((item) => `- ${item}`).join("\n"),
    summary: safeJson(row.summary_json, {}),
    transcript,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined
  };
}

function indexMeeting(db, meeting) {
  db.prepare("DELETE FROM meeting_search WHERE meeting_id = ?").run(meeting.id);
  db.prepare(`
    INSERT INTO meeting_search(meeting_id, title, notes, summary, transcript)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    meeting.id,
    meeting.title,
    meeting.notesMarkdown || meeting.notes.join("\n"),
    JSON.stringify(meeting.summary),
    meeting.transcript.map((item) => item.text).join("\n")
  );
}

function persistMeeting(db, meeting) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO meetings(
      id, title, scheduled_at, duration_seconds, status, mode, favorite,
      participants_json, tags_json, goals_json, notes_json, notes_markdown, summary_json,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      scheduled_at = excluded.scheduled_at,
      duration_seconds = excluded.duration_seconds,
      status = excluded.status,
      mode = excluded.mode,
      favorite = excluded.favorite,
      participants_json = excluded.participants_json,
      tags_json = excluded.tags_json,
      goals_json = excluded.goals_json,
      notes_json = excluded.notes_json,
      notes_markdown = excluded.notes_markdown,
      summary_json = excluded.summary_json,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `).run(
    meeting.id,
    meeting.title,
    meeting.scheduledAt,
    meeting.durationSeconds ?? 0,
    meeting.status ?? "draft",
    meeting.mode ?? "online",
    meeting.favorite ? 1 : 0,
    JSON.stringify(meeting.participants ?? []),
    JSON.stringify(meeting.tags ?? []),
    JSON.stringify(meeting.goals ?? []),
    JSON.stringify(meeting.notes ?? []),
    meeting.notesMarkdown ?? (meeting.notes ?? []).map((item) => `- ${item}`).join("\n"),
    JSON.stringify(meeting.summary ?? {}),
    meeting.createdAt ?? timestamp,
    timestamp,
    meeting.deletedAt ?? null
  );

  db.prepare("DELETE FROM transcript_segments WHERE meeting_id = ?").run(meeting.id);
  const insertSegment = db.prepare(`
    INSERT INTO transcript_segments(
      id, meeting_id, start_ms, end_ms, speaker_id, speaker_name, text,
      status, track, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const segment of meeting.transcript ?? []) {
    insertSegment.run(
      segment.id ?? randomUUID(),
      meeting.id,
      segment.startMs,
      segment.endMs,
      segment.speakerId,
      segment.speakerName,
      segment.text,
      segment.status ?? "final",
      segment.track ?? "mixed",
      segment.confidence ?? null,
      timestamp
    );
  }
  const persisted = getMeeting(db, meeting.id);
  indexMeeting(db, persisted);
  return persisted;
}

function getMeeting(db, id) {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
  return row ? rowToMeeting(db, row) : null;
}

export function openDatabase() {
  if (database) return database;
  const dataDirectory = path.join(app.getPath("userData"), "data");
  mkdirSync(dataDirectory, { recursive: true });
  database = new DatabaseSync(path.join(dataDirectory, "meetings.sqlite"));
  createSchema(database);

  const count = database.prepare("SELECT COUNT(*) AS count FROM meetings").get().count;
  if (count === 0) {
    database.exec("BEGIN");
    try {
      for (const meeting of seedMeetings) persistMeeting(database, meeting);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}

export function listMeetings(query = "", includeDeleted = false) {
  const db = openDatabase();
  let rows;
  if (query.trim()) {
    rows = db.prepare(`
      SELECT m.* FROM meetings m
      JOIN meeting_search s ON s.meeting_id = m.id
      WHERE meeting_search MATCH ?
        AND (? = 1 OR m.deleted_at IS NULL)
      ORDER BY m.scheduled_at DESC
    `).all(`${query.trim().replaceAll('"', '""')}*`, includeDeleted ? 1 : 0);
  } else {
    rows = db.prepare(`
      SELECT * FROM meetings
      WHERE (? = 1 OR deleted_at IS NULL)
      ORDER BY scheduled_at DESC
    `).all(includeDeleted ? 1 : 0);
  }
  return rows.map((row) => rowToMeeting(db, row));
}

export function loadMeeting(id) {
  return getMeeting(openDatabase(), id);
}

export function saveMeeting(meeting) {
  const db = openDatabase();
  db.exec("BEGIN");
  try {
    const saved = persistMeeting(db, meeting);
    db.exec("COMMIT");
    return saved;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createMeeting(input) {
  const timestamp = nowIso();
  return saveMeeting({
    id: randomUUID(),
    title: input.title || "未命名会议",
    scheduledAt: input.scheduledAt || timestamp,
    durationSeconds: 0,
    status: "draft",
    mode: input.mode || "online",
    favorite: false,
    participants: input.participants ?? ["我"],
    tags: input.tags ?? [],
    goals: input.goals ?? [],
    notes: [],
    notesMarkdown: "",
    summary: {
      topics: [],
      keyPoints: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      nextSteps: [],
      stale: false
    },
    transcript: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function softDeleteMeeting(id) {
  const db = openDatabase();
  db.prepare("UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), id);
  return true;
}

export function restoreMeeting(id) {
  const db = openDatabase();
  db.prepare("UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
  return loadMeeting(id);
}

export function appendAudioChunk(record) {
  const db = openDatabase();
  db.prepare(`
    INSERT INTO audio_chunks(
      id, meeting_id, session_id, track, sequence, byte_length, path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    record.meetingId,
    record.sessionId,
    record.track,
    record.sequence,
    record.byteLength,
    record.path,
    nowIso()
  );
}

export function finalizeAudioPath(sessionId, track, targetPath) {
  openDatabase().prepare(`
    UPDATE audio_chunks SET path = ?
    WHERE session_id = ? AND track = ?
  `).run(targetPath, sessionId, track);
}

export function listMeetingAudioPaths(meetingId) {
  return openDatabase().prepare(`
    SELECT DISTINCT path FROM audio_chunks
    WHERE meeting_id = ? ORDER BY path
  `).all(meetingId).map((row) => row.path);
}

export function listExpiredAudioPaths(retentionDays) {
  return openDatabase().prepare(`
    SELECT DISTINCT ac.path
    FROM audio_chunks ac
    JOIN meetings m ON m.id = ac.meeting_id
    WHERE m.status = 'complete'
      AND julianday('now') - julianday(m.updated_at) >= ?
  `).all(retentionDays).map((row) => row.path);
}

export function deleteAudioPathRecord(audioPath) {
  openDatabase().prepare("DELETE FROM audio_chunks WHERE path = ?").run(audioPath);
}

export function listModelProfiles() {
  return openDatabase().prepare("SELECT * FROM model_profiles ORDER BY kind, name").all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      transport: row.transport,
      baseUrl: row.base_url ?? "",
      model: row.model ?? "",
      secretId: row.secret_id ?? undefined,
      options: safeJson(row.options_json, {}),
      enabled: Boolean(row.enabled)
    }));
}

export function saveModelProfile(profile) {
  const db = openDatabase();
  const timestamp = nowIso();
  const id = profile.id || randomUUID();
  db.prepare(`
    INSERT INTO model_profiles(
      id, name, kind, transport, base_url, model, secret_id, options_json,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      transport = excluded.transport,
      base_url = excluded.base_url,
      model = excluded.model,
      secret_id = excluded.secret_id,
      options_json = excluded.options_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    profile.name,
    profile.kind,
    profile.transport,
    profile.baseUrl || null,
    profile.model || null,
    profile.secretId || null,
    JSON.stringify(profile.options ?? {}),
    profile.enabled === false ? 0 : 1,
    timestamp,
    timestamp
  );
  return { ...profile, id };
}

export function markInterruptedRecordings() {
  const db = openDatabase();
  db.prepare(`
    UPDATE meetings
    SET status = 'interrupted', updated_at = ?
    WHERE status = 'recording'
  `).run(nowIso());
}
