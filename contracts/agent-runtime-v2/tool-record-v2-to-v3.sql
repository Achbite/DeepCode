BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS tool_records_are_not_deleted;

PRAGMA user_version = 3;
COMMIT;
