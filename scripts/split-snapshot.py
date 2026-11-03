#!/usr/bin/env python3
"""Split an offline shared Kit snapshot into new per-project databases.

Stop writes and take a final SQLite online backup before using this tool. It
does not update running services or authorize exposure of an older runtime.
"""
import argparse
from contextlib import closing
import importlib.util
import os
from pathlib import Path
import sqlite3

spec = importlib.util.spec_from_file_location('combine_snapshots', Path(__file__).with_name('combine-snapshots.py'))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def split(template, source, targets):
    if not targets or len({project for project, _ in targets}) != len(targets):
        raise ValueError('Each output needs a distinct project ID')
    paths = [Path(path) for _, path in targets]
    if len({str(path.absolute()) for path in paths}) != len(paths):
        raise ValueError('Output paths must be distinct')
    if any(path.exists() or path.is_symlink() or not path.parent.is_dir() or path.parent.is_symlink() for path in paths):
        raise ValueError('Every output must be a new file in an existing directory')
    created = []
    try:
        with closing(common.open_snapshot(template)) as blank, closing(common.open_snapshot(source)) as incoming:
            known = set(common.PERSISTENT + common.TRANSIENT)
            tables = lambda db: {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if tables(blank) != known or tables(incoming) != known or any(common.count(blank, table) for table in known):
                raise ValueError('Expected empty template and known Kit tables')
            expected = {table: common.columns(blank, table) for table in known}
            if any(common.columns(incoming, table) != expected[table] for table in known):
                raise ValueError('Snapshot schema differs from the accepted template')
            if any(common.count(incoming, table) for table in common.TRANSIENT) or incoming.execute("SELECT 1 FROM report_audio WHERE state IN ('pending', 'processing') LIMIT 1").fetchone():
                raise ValueError('Active or pending speech work requires separate reconciliation')
            project_ids = {project for project, _ in targets}
            if any(not isinstance(project, str) or not project for project in project_ids):
                raise ValueError('Missing project ID')
            for table in ('reports', 'reporter_accounts', 'reporter_sessions'):
                if any(row[0] not in project_ids for row in incoming.execute('SELECT DISTINCT project_id FROM ' + common.quote(table))):
                    raise ValueError('An existing project has no output')
            if incoming.execute('SELECT 1 FROM reporter_sessions s LEFT JOIN reporter_accounts a ON a.id=s.account_id AND a.project_id=s.project_id WHERE a.id IS NULL LIMIT 1').fetchone():
                raise ValueError('Snapshot contains an orphaned session')
            if incoming.execute('SELECT 1 FROM report_audio a LEFT JOIN reports r ON r.id=a.report_id WHERE r.id IS NULL LIMIT 1').fetchone():
                raise ValueError('Snapshot contains orphaned audio')
            for (project, _), target in zip(targets, paths):
                fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                created.append(target)
                with closing(sqlite3.connect(target)) as output:
                    blank.backup(output)
                    output.execute('PRAGMA foreign_keys=ON')
                    output.execute('BEGIN IMMEDIATE')
                    for table in common.PERSISTENT:
                        names = [column[0] for column in expected[table]]
                        fields = ','.join('a.' + common.quote(name) for name in names)
                        if table == 'report_audio':
                            query = 'SELECT ' + fields + ' FROM report_audio a JOIN reports r ON r.id=a.report_id WHERE r.project_id=?'
                        else:
                            query = 'SELECT ' + fields + ' FROM ' + common.quote(table) + ' a WHERE a.project_id=?'
                        placeholders = ','.join('?' for _ in names)
                        insert = 'INSERT INTO ' + common.quote(table) + ' (' + ','.join(map(common.quote, names)) + ') VALUES (' + placeholders + ')'
                        count = 0
                        for row in incoming.execute(query, (project,)):
                            output.execute(insert, row)
                            count += 1
                        if common.count(output, table) != count:
                            raise ValueError('Output row count differs')
                    if output.execute('PRAGMA foreign_key_check').fetchone() or output.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise ValueError('Output integrity check failed')
                    output.commit()
        return len(created)
    except BaseException:
        for target in created:
            target.unlink(missing_ok=True)
            for suffix in ('-journal', '-wal', '-shm'):
                Path(str(target) + suffix).unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target', action='append', nargs=2, metavar=('PROJECT_ID', 'NEW_DATABASE'), required=True)
    args = parser.parse_args()
    try:
        count = split(args.template, args.source, args.target)
    except (ValueError, OSError, sqlite3.Error):
        parser.exit(1, 'Snapshot split failed; input was not changed.\n')
    print('Snapshot split complete:', count, 'project databases')


if __name__ == '__main__':
    main()
