#!/usr/bin/env python3
"""Combine offline Kit SQLite snapshots into a new, empty Kit database.

The caller must stop writes or otherwise coordinate the final snapshot/cutover.
This tool never contacts a server and never modifies its inputs.
"""
import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3

PERSISTENT = ('reports', 'reporter_accounts', 'reporter_sessions', 'report_audio')
TRANSIENT = ('transcription_drafts', 'speech_workdirs')


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def open_snapshot(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Snapshot must be a regular file')
    if Path(str(path) + '-wal').exists() or Path(str(path) + '-shm').exists():
        raise ValueError('Use a standalone online-backup snapshot, not a live WAL database')
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        db.close()
        raise ValueError('Snapshot integrity check failed')
    return db


def columns(db, table):
    return [(row[1], row[2], row[3], row[5]) for row in db.execute('PRAGMA table_info(' + quote(table) + ')')]


def count(db, table):
    return db.execute('SELECT count(*) FROM ' + quote(table)).fetchone()[0]


def combine(template, sources, target):
    if not sources or len({project for project, _ in sources}) != len(sources):
        raise ValueError('Each source needs a distinct project ID')
    target = Path(target)
    if target.exists() or target.is_symlink():
        raise ValueError('Target must be a new file')
    if not target.parent.is_dir() or target.parent.is_symlink():
        raise ValueError('Target directory must already exist')
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        with closing(open_snapshot(template)) as blank, closing(sqlite3.connect(target)) as output:
            known = set(PERSISTENT + TRANSIENT)
            table_names = {row[0] for row in blank.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if table_names != known or any(count(blank, table) for table in known):
                raise ValueError('Template must contain only empty expected Kit tables')
            expected = {table: columns(blank, table) for table in known}
            blank.backup(output)
            output.execute('PRAGMA foreign_keys=ON')
            output.execute('BEGIN IMMEDIATE')
            totals = {table: 0 for table in PERSISTENT}
            for project, source in sources:
                if not isinstance(project, str) or not project:
                    raise ValueError('Missing project ID')
                with closing(open_snapshot(source)) as incoming:
                    names = {row[0] for row in incoming.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                    if names != known or any(columns(incoming, table) != expected[table] for table in known):
                        raise ValueError('Snapshot schema differs from the accepted template')
                    if any(count(incoming, table) for table in TRANSIENT):
                        raise ValueError('Active or pending speech work requires separate reconciliation')
                    if incoming.execute("SELECT 1 FROM report_audio WHERE state IN ('pending', 'processing') LIMIT 1").fetchone():
                        raise ValueError('Active or pending speech work requires separate reconciliation')
                    for table in ('reports', 'reporter_accounts', 'reporter_sessions'):
                        if incoming.execute('SELECT 1 FROM ' + quote(table) + ' WHERE project_id != ? OR project_id IS NULL LIMIT 1', (project,)).fetchone():
                            raise ValueError('Snapshot contains a different project')
                    if incoming.execute('SELECT 1 FROM reporter_sessions s LEFT JOIN reporter_accounts a ON a.id=s.account_id AND a.project_id=s.project_id WHERE a.id IS NULL LIMIT 1').fetchone():
                        raise ValueError('Snapshot contains an orphaned session')
                    if incoming.execute('SELECT 1 FROM report_audio a LEFT JOIN reports r ON r.id=a.report_id WHERE r.id IS NULL LIMIT 1').fetchone():
                        raise ValueError('Snapshot contains orphaned audio')
                    for table in PERSISTENT:
                        names = [column[0] for column in expected[table]]
                        fields = ','.join(map(quote, names))
                        placeholders = ','.join('?' for _ in names)
                        for row in incoming.execute('SELECT ' + fields + ' FROM ' + quote(table)):
                            output.execute('INSERT INTO ' + quote(table) + ' (' + fields + ') VALUES (' + placeholders + ')', row)
                            totals[table] += 1
            if any(count(output, table) != totals[table] for table in PERSISTENT):
                raise ValueError('Combined row counts differ')
            if output.execute('PRAGMA foreign_key_check').fetchone() or output.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Combined integrity check failed')
            output.commit()
        return totals
    except BaseException:
        target.unlink(missing_ok=True)
        for suffix in ('-journal', '-wal', '-shm'):
            Path(str(target) + suffix).unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--source', action='append', nargs=2, metavar=('PROJECT_ID', 'SNAPSHOT'), required=True)
    args = parser.parse_args()
    try:
        totals = combine(args.template, args.source, args.target)
    except (ValueError, OSError, sqlite3.Error):
        parser.exit(1, 'Snapshot combination failed; inputs were not changed.\n')
    print('Snapshot combination complete:', ', '.join(f'{table}={totals[table]}' for table in PERSISTENT))


if __name__ == '__main__':
    main()
