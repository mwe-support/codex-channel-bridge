/** Delivery metadata only. Never store Codex answer text here. */
export const ANSWER_STREAM_SCHEMA = `CREATE TABLE answer_streams (
  archive_record_id TEXT PRIMARY KEY REFERENCES message_archive(record_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);`;
