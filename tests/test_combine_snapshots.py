import hashlib
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('combine_snapshots', ROOT / 'scripts/combine-snapshots.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CombineSnapshots(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.template = self.make('template')

    def make(self, name, project=None, report_id=None):
        path = self.root / (name + '.sqlite')
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript('''
                CREATE TABLE reports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, screenshot BLOB, attachment BLOB);
                CREATE TABLE reporter_accounts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pin_hash TEXT NOT NULL);
                CREATE TABLE reporter_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL);
                CREATE TABLE report_audio (report_id TEXT PRIMARY KEY REFERENCES reports(id), data BLOB NOT NULL, state TEXT NOT NULL);
                CREATE TABLE transcription_drafts (id TEXT PRIMARY KEY);
                CREATE TABLE speech_workdirs (path TEXT PRIMARY KEY);
            ''')
            if project:
                report_id = report_id or project + '-report'
                db.execute('INSERT INTO reports VALUES (?,?,?,?)', (report_id, project, b'picture', b'attachment'))
                db.execute('INSERT INTO reporter_accounts VALUES (?,?,?)', (project + '-account', project, 'hash'))
                db.execute('INSERT INTO reporter_sessions VALUES (?,?,?)', (project + '-token', project + '-account', project))
                db.execute('INSERT INTO report_audio VALUES (?,?,?)', (report_id, b'audio', 'ready'))
        return path

    def test_preserves_rows_and_all_binary_evidence_without_writing_inputs(self):
        a, b = self.make('a', 'alpha'), self.make('b', 'beta')
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (a, b)]
        target = self.root / 'result.sqlite'
        totals = module.combine(self.template, [('alpha', a), ('beta', b)], target)
        self.assertEqual(totals, {table: 2 for table in module.PERSISTENT})
        with closing(sqlite3.connect(target)) as db:
            self.assertEqual(db.execute('SELECT screenshot,attachment FROM reports WHERE project_id=?', ('alpha',)).fetchone(), (b'picture', b'attachment'))
            self.assertEqual(db.execute('SELECT data FROM report_audio WHERE report_id=?', ('beta-report',)).fetchone()[0], b'audio')
        self.assertEqual(before, [hashlib.sha256(p.read_bytes()).hexdigest() for p in (a, b)])
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_refuses_collisions_and_retains_existing_target(self):
        a, b = self.make('a', 'alpha', 'same'), self.make('b', 'beta', 'same')
        target = self.root / 'result.sqlite'
        with self.assertRaises(sqlite3.IntegrityError):
            module.combine(self.template, [('alpha', a), ('beta', b)], target)
        self.assertFalse(target.exists())
        target.write_bytes(b'untouched')
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', a)], target)
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_refuses_wrong_project_and_inflight_work(self):
        source = self.make('a', 'alpha')
        target = self.root / 'result.sqlite'
        with self.assertRaises(ValueError):
            module.combine(self.template, [('other', source)], target)
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('INSERT INTO transcription_drafts VALUES (?)', ('active',))
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', source)], target)
        self.assertFalse(target.exists())
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('DELETE FROM transcription_drafts')
            db.execute("UPDATE report_audio SET state='processing'")
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', source)], target)
        self.assertFalse(target.exists())

    def test_refuses_schema_drift_or_live_wal_and_orphans(self):
        source = self.make('a', 'alpha')
        target = self.root / 'result.sqlite'
        Path(str(source) + '-wal').touch()
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', source)], target)
        Path(str(source) + '-wal').unlink()
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('DELETE FROM reporter_accounts')
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', source)], target)
        self.assertFalse(target.exists())
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('ALTER TABLE reports ADD COLUMN unexpected TEXT')
        with self.assertRaises(ValueError):
            module.combine(self.template, [('alpha', source)], target)
        self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
