#!/usr/bin/env python3
"""Explicit, one-time repair of the schema-7 tool.interrupted CHECK omission.

Run only against an idle config root. This is an operator action, never a
daemon startup migration. The supplied backup path must not already exist.
"""

from __future__ import annotations

import argparse
from contextlib import closing
from itertools import zip_longest
import json
import os
from pathlib import Path
import sqlite3


SCHEMA = Path(__file__).resolve().parents[1] / "contracts/agent-runtime/session.sql"
EVENT = "        'tool.interrupted',\n"


def normalize(sql: str) -> str:
    return " ".join(sql.replace(" IF NOT EXISTS", "").split())


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def verify_unchanged(connection: sqlite3.Connection) -> dict[str, int]:
    """Compare the actual rows with the consistent backup, without hashes."""
    counts = {}
    tables = connection.execute(
        "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    for (table,) in tables:
        name = quote(table)
        current = connection.execute(f"SELECT rowid, * FROM main.{name} ORDER BY rowid")
        original = connection.execute(f"SELECT rowid, * FROM before_repair.{name} ORDER BY rowid")
        count = 0
        for after, before in zip_longest(current, original):
            if after != before:
                raise RuntimeError(f"Row verification failed for {table}; repair rolled back")
            count += 1
        counts[table] = count
    # All other table definitions, indexes and triggers must be preserved.
    objects = "SELECT type,name,tbl_name,sql FROM {}.sqlite_schema WHERE name != 'session_events' ORDER BY type,name"
    if connection.execute(objects.format("main")).fetchall() != connection.execute(
        objects.format("before_repair")
    ).fetchall():
        raise RuntimeError("Schema objects changed outside the event constraint; repair rolled back")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("Foreign key verification failed; repair rolled back")
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise RuntimeError("Database integrity verification failed; repair rolled back")
    return counts


def repair(config_root: Path, backup: Path) -> dict:
    runtime = config_root.resolve(strict=True) / "runtime" / "agent-runtime"
    database = (runtime / "session.sqlite3").resolve(strict=True)
    backup = backup.resolve()
    table_sql = next(
        statement.strip() for statement in SCHEMA.read_text().split(";")
        if statement.strip().startswith("CREATE TABLE IF NOT EXISTS session_events (")
    )
    if table_sql.count(EVENT) != 1:
        raise RuntimeError("Current contract no longer matches this one-time repair")
    previous_sql = table_sql.replace(EVENT, "")

    # Same SQLite lease as ConfigRootLease; no PID guessing or process killing.
    with closing(sqlite3.connect(runtime / "root-owner.lock", timeout=0)) as lease:
        lease.execute("PRAGMA journal_mode=DELETE")
        lease.execute("BEGIN EXCLUSIVE")
        with closing(sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=0)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("BEGIN IMMEDIATE")
            try:
                if connection.execute("PRAGMA user_version").fetchone() != (7,):
                    raise RuntimeError("This repair only accepts the confirmed schema-7 omission")
                stored = connection.execute(
                    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='session_events'"
                ).fetchone()
                if stored and normalize(stored[0]) == normalize(table_sql):
                    connection.rollback()
                    return {"status": "already_current", "database": str(database)}
                if not stored or normalize(stored[0]) != normalize(previous_sql):
                    raise RuntimeError("Unexpected event table difference; database was not modified")

                # A reserved write lock prevents changes while another read-only
                # connection makes the backup (backing up a writer can deadlock).
                fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source:
                    with closing(sqlite3.connect(backup)) as destination:
                        source.backup(destination)
                connection.execute("ATTACH DATABASE ? AS before_repair", (backup.as_uri() + "?mode=ro",))

                definitions = connection.execute(
                    "SELECT sql FROM sqlite_schema WHERE tbl_name='session_events' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"
                ).fetchall()
                columns = [row[1] for row in connection.execute("PRAGMA table_info(session_events)")]
                connection.execute("CREATE TEMP TABLE saved_events AS SELECT rowid AS saved_rowid, * FROM session_events")
                connection.execute("DROP TABLE session_events")
                connection.execute(table_sql)
                connection.execute(
                    "INSERT INTO session_events(rowid," + ",".join(map(quote, columns)) + ") SELECT * FROM saved_events"
                )
                for (definition,) in definitions:
                    connection.execute(definition)
                counts = verify_unchanged(connection)
                actual = connection.execute("SELECT sql FROM sqlite_schema WHERE name='session_events'").fetchone()[0]
                if normalize(actual) != normalize(table_sql):
                    raise RuntimeError("Rebuilt event constraint differs from the current contract")
                connection.commit()
                return {"status": "repaired", "database": str(database), "backup": str(backup), "rows": counts}
            except BaseException:
                connection.rollback()
                raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(repair(args.config_root, args.backup), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
