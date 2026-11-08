"""Common bootstrap ownership, provenance binding, capacity and privacy controls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('kit_bootstrap', Path(__file__).resolve().parents[1] / 'scripts/deploy.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
IMAGE = 'sha256:' + 'a' * 64
CONTAINER = 'b' * 64
ELF = b'\x7fELF\x02\x01' + b'\0' * 12 + (62).to_bytes(2, 'little') + b'x' * 4076


class FakeProcess:
    def __init__(self, source):
        self.stdout = io.BytesIO(source)
        self.stderr = io.BytesIO()
        self.returncode = 0
    def wait(self, timeout=None):
        return self.returncode
    def poll(self):
        return self.returncode
    def kill(self):
        self.returncode = -9


def archive(name='node', content=ELF, symbolic=False, extra=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as target:
        member = tarfile.TarInfo(name)
        member.mode = 0o755
        if symbolic:
            member.type = tarfile.SYMTYPE
            member.linkname = '/private/foreign'
        else:
            member.size = len(content)
        target.addfile(member, None if symbolic else io.BytesIO(content))
        if extra:
            second = tarfile.TarInfo('foreign')
            second.size = 1
            target.addfile(second, io.BytesIO(b'x'))
    return output.getvalue()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.cache = self.root / 'runtime'
        self.calls = []
        self.token = None
    def tearDown(self):
        self.temporary.cleanup()
    def docker(self, args, **unused):
        self.calls.append(args)
        if args[1:3] == ['image', 'inspect']:
            return IMAGE + '|linux|amd64'
        if args[1] == 'create':
            self.token = args[args.index('--label') + 1].split('=')[1]
            self.assertNotIn('--mount', args)
            self.assertNotIn('--volume', args)
            self.assertEqual(args[-1], IMAGE)
            return CONTAINER
        if args[1:3] == ['container', 'inspect']:
            return f'{CONTAINER}|{IMAGE}|created|{self.token}'
        if args[1] == 'ps':
            return CONTAINER
        if args[1] == 'rm':
            return CONTAINER
        self.fail('unexpected bootstrap command')
    def fallback(self, copy=None):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(bootstrap.shutil, 'which', return_value=None))
        stack.enter_context(patch.object(bootstrap.sys, 'platform', 'linux'))
        stack.enter_context(patch.object(bootstrap.platform, 'machine', return_value='x86_64'))
        stack.enter_context(patch.object(bootstrap, '_run', side_effect=self.docker))
        stack.enter_context(patch.object(bootstrap, '_version', return_value=None))
        if copy:
            stack.enter_context(patch.object(bootstrap, '_copy_node', side_effect=copy))
        return stack
    def test_host_node_uses_no_docker_and_creates_no_cache(self):
        with patch.object(bootstrap.shutil, 'which', return_value=sys.executable), patch.object(bootstrap, '_version') as version:
            node = bootstrap.resolve_node(IMAGE, self.cache)
        self.assertEqual(node, str(Path(sys.executable).resolve()))
        version.assert_called_once()
        self.assertFalse(self.cache.exists())
    def test_fallback_extracts_one_public_binary_from_owned_stopped_image_and_cleans_container(self):
        def copy(docker, container, node):
            self.assertEqual(container, CONTAINER)
            self.assertTrue(any(c[1:3] == ['container', 'inspect'] for c in self.calls))
            node.write_bytes(ELF)
            node.chmod(0o600)
        with self.fallback(copy):
            node = Path(bootstrap.resolve_node(IMAGE, self.cache))
        self.assertEqual(node.read_bytes(), ELF)
        self.assertEqual(stat.S_IMODE(node.stat().st_mode), 0o700)
        receipt = json.loads((self.cache / 'runtime.json').read_text())
        self.assertEqual(receipt['imageId'], IMAGE)
        self.assertEqual(receipt['nodeSha256'], bootstrap._sha(node))
        self.assertEqual(self.calls[-1], ['docker', 'rm', CONTAINER])
        self.assertFalse(any(c[1] in {'start', 'run', 'pull'} for c in self.calls))
    def test_foreign_architecture_or_image_identity_is_rejected_before_create(self):
        for actual in [IMAGE + '|linux|arm64', 'sha256:' + 'c' * 64 + '|linux|amd64']:
            with self.fallback(), patch.object(bootstrap, '_run', return_value=actual):
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.resolve_node(IMAGE, self.cache)
            self.assertFalse(self.cache.exists())
    def test_existing_cache_and_symlink_parent_are_never_adopted(self):
        self.cache.mkdir(mode=0o700)
        (self.cache / 'foreign').write_text('PRIVATE_SENTINEL')
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.resolve_node(IMAGE, self.cache)
        self.assertEqual((self.cache / 'foreign').read_text(), 'PRIVATE_SENTINEL')
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.resolve_node(IMAGE, alias / 'other')
    def test_failed_copy_cleans_partial_cache_and_only_the_owned_container(self):
        def broken(docker, container, node):
            node.write_text('PRIVATE_SENTINEL')
            raise RuntimeError('PRIVATE_SENTINEL')
        with self.fallback(broken):
            with self.assertRaisesRegex(bootstrap.BootstrapError, '^BOOTSTRAP_EXTRACTION_FAILED$'):
                bootstrap.resolve_node(IMAGE, self.cache)
        self.assertFalse(self.cache.exists())
        self.assertEqual(self.calls[-1], ['docker', 'rm', CONTAINER])
    def test_foreign_cleanup_identity_is_not_removed(self):
        def copy(docker, container, node):
            node.write_bytes(ELF)
            node.chmod(0o600)
        original = self.docker
        checks = 0
        def changed(args, **kw):
            nonlocal checks
            if args[1:3] == ['container', 'inspect']:
                checks += 1
                if checks > 1:
                    return f'{CONTAINER}|{IMAGE}|created|FOREIGN'
            return original(args, **kw)
        with self.fallback(copy), patch.object(bootstrap, '_run', side_effect=changed):
            with self.assertRaisesRegex(bootstrap.BootstrapError, '^BOOTSTRAP_CLEANUP_REQUIRED$'):
                bootstrap.resolve_node(IMAGE, self.cache)
        self.assertFalse(self.cache.exists())
        self.assertFalse(any(c[1] == 'rm' for c in self.calls))
    def test_stream_rejects_wrong_paths_links_extra_members_and_capacity_before_copy(self):
        for source in [archive(name='../node'), archive(symbolic=True), archive(extra=True)]:
            node = self.root / 'node'
            with patch.object(bootstrap.subprocess, 'Popen', return_value=FakeProcess(source)):
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap._copy_node('docker', CONTAINER, node)
            node.unlink(missing_ok=True)
        with patch.object(bootstrap.subprocess, 'Popen', return_value=FakeProcess(archive())), \
             patch.object(bootstrap.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(bootstrap.BootstrapError, '^BOOTSTRAP_CAPACITY$'):
                bootstrap._copy_node('docker', CONTAINER, self.root / 'node')
        self.assertFalse((self.root / 'node').exists())
    def test_stream_copies_exact_regular_file_and_private_mode(self):
        node = self.root / 'node'
        with patch.object(bootstrap.subprocess, 'Popen', return_value=FakeProcess(archive())):
            bootstrap._copy_node('docker', CONTAINER, node)
        self.assertEqual(node.read_bytes(), ELF)
        self.assertEqual(stat.S_IMODE(node.stat().st_mode), 0o600)
    def test_version_and_cli_channels_are_finite_and_loader_environment_is_removed(self):
        with patch.object(bootstrap, '_run', return_value='v22.0.0'):
            with self.assertRaisesRegex(bootstrap.BootstrapError, '^BOOTSTRAP_NODE_VERSION$'):
                bootstrap._version('/private/node')
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap._output(SimpleNamespace(returncode=1, stderr=b'PRIVATE_SENTINEL', stdout=b''), 'plan')
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap._output(SimpleNamespace(returncode=0, stderr=b'', stdout=b'{"private":"PRIVATE_SENTINEL"}'), 'plan')
        with patch.dict(os.environ, {'NODE_OPTIONS': '--require PRIVATE_SENTINEL', 'LD_PRELOAD': 'PRIVATE_SENTINEL'}):
            self.assertNotIn('NODE_OPTIONS', bootstrap._environment())
            self.assertNotIn('LD_PRELOAD', bootstrap._environment())
    def test_main_allowed_control_keeps_same_cli_arguments_and_cleans_temporary_runtime(self):
        config = self.root / 'deployment.json'
        config.write_text(json.dumps({'schema': 1, 'profile': 'docker-server', 'artifact': {'image': IMAGE}}))
        config.chmod(0o600)
        seen = []
        expected = {'ok': True, 'action': 'verify', 'instance': 'fixture'}
        def resolve(image, cache):
            self.assertEqual(image, IMAGE)
            self.assertFalse(cache.exists())
            seen.append(cache)
            cache.mkdir(mode=0o700)
            return str(cache / 'node')
        def child(args, **options):
            self.assertEqual(args[-2:], ['verify', str(config)])
            self.assertTrue(args[1].endswith('/scripts/deploy.mjs'))
            self.assertNotIn('NODE_OPTIONS', options['env'])
            return SimpleNamespace(returncode=0, stdout=json.dumps(expected).encode(), stderr=b'')
        output = io.StringIO()
        with patch.object(bootstrap, 'resolve_node', side_effect=resolve), patch.object(bootstrap.subprocess, 'run', side_effect=child), \
             patch.dict(os.environ, {'NODE_OPTIONS': 'PRIVATE_SENTINEL'}), contextlib.redirect_stdout(output):
            code = bootstrap.main(['verify', str(config)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertFalse(seen[0].parent.exists())

    def test_main_rejects_malformed_private_input_without_echoing_values(self):
        config = self.root / 'deployment.json'
        config.write_text('{"private":"PRIVATE_SENTINEL')
        config.chmod(0o600)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = bootstrap.main(['plan', str(config)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'code': 'BOOTSTRAP_PRIVATE_CONFIG'})
        self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())


if __name__ == '__main__':
    unittest.main()
