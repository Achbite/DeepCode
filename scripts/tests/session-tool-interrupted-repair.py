#!/usr/bin/env python3
"""Regression checks for the explicitly authorized, one-time Store repair."""

import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("repair", ROOT / "scripts/repair-session-tool-interrupted.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="deepcode-session-repair-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        runtime = self.root / "runtime/agent-runtime"
        runtime.mkdir(parents=True)
        self.database = runtime / "session.sqlite3"
        self.backup = self.root / "before.sqlite3"
        self.original_schema = repair.SCHEMA.read_text().replace(repair.EVENT, "")
        with sqlite3.connect(self.database) as con:
            con.executescript(self.original_schema)
            con.execute("INSERT INTO sessions VALUES ('session:test','Keep this conversation',NULL,'2026-09-12')")
            con.execute("INSERT INTO session_events VALUES ('session:test',1,'event:1','session.created',NULL,NULL,'{}','2026-09-12')")
            con.execute("INSERT INTO session_events VALUES ('session:test',2,'event:2','input.accepted',NULL,NULL,?, '2026-09-12')", ('{"text":"完整原文🙂\\nsecond line"}',))
            con.execute("INSERT INTO session_commands VALUES ('session:test','command:1','{}','{}',2,'2026-09-12')")
        self.before = self.snapshot(self.database)

    def snapshot(self, path):
        with sqlite3.connect(path) as con:
            return {
                "objects": con.execute("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").fetchall(),
                "tables": {name: con.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid').fetchall()
                           for name, in con.execute("SELECT name FROM sqlite_schema WHERE type='table'").fetchall()},
                "version": con.execute("PRAGMA user_version").fetchone(),
            }

    def test_preserves_rows_indexes_and_backup_and_accepts_interruption(self):
        result = repair.repair(self.root, self.backup)
        self.assertEqual(result["status"], "repaired")
        self.assertEqual(result["rows"]["session_events"], 2)
        self.assertEqual(self.snapshot(self.backup), self.before)
        after = self.snapshot(self.database)
        self.assertEqual(after["tables"], self.before["tables"])
        self.assertEqual(after["version"], (7,))
        self.assertEqual([obj for obj in after["objects"] if obj[1] != "session_events"],
                         [obj for obj in self.before["objects"] if obj[1] != "session_events"])
        with sqlite3.connect(self.database) as con:
            con.execute("INSERT INTO session_events VALUES ('session:test',3,'event:3','tool.interrupted','run:test','call:test','{}','2026-09-12')")
        unchanged = self.snapshot(self.database)
        self.assertEqual(repair.repair(self.root, self.backup)["status"], "already_current")
        self.assertEqual(self.snapshot(self.database), unchanged)
        self.assertEqual(self.snapshot(self.backup), self.before)

    def test_rolls_back_table_rebuild_when_verification_fails(self):
        with patch.object(repair, "verify_unchanged", side_effect=RuntimeError("verification failure")):
            with self.assertRaisesRegex(RuntimeError, "verification failure"):
                repair.repair(self.root, self.backup)
        self.assertEqual(self.snapshot(self.database), self.before)
        self.assertEqual(self.snapshot(self.backup), self.before)

    def test_refuses_live_config_root_without_modifying_database(self):
        lease = sqlite3.connect(self.database.parent / "root-owner.lock", timeout=0)
        self.addCleanup(lease.close)
        lease.execute("BEGIN EXCLUSIVE")
        with self.assertRaises(sqlite3.OperationalError):
            repair.repair(self.root, self.backup)
        self.assertEqual(self.snapshot(self.database), self.before)
        self.assertFalse(self.backup.exists())

    def test_refuses_other_event_constraint_differences(self):
        with sqlite3.connect(self.database) as con:
            con.execute("DROP TABLE session_events")
            con.executescript(self.original_schema.replace("        'tool.input-rejected',\n", ""))
        before = self.snapshot(self.database)
        with self.assertRaisesRegex(RuntimeError, "Unexpected event table difference"):
            repair.repair(self.root, self.backup)
        self.assertEqual(self.snapshot(self.database), before)
        self.assertFalse(self.backup.exists())


if __name__ == "__main__":
    unittest.main()
