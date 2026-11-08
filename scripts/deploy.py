#!/usr/bin/env python3
"""Run the common installer with host Node>=24 or Node from its accepted local image.

No host installation/download occurs. resolve_node(image, private_cache) accepts
an absent cache directory beneath a private caller-owned parent; the caller owns
its lifetime. Only the public /usr/local/bin/node is copied from a stopped,
unmounted, uniquely owned container. The deployment CLI itself remains deploy.mjs.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tarfile
import threading
import uuid

_IMAGE = re.compile(r'(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})')
_ID = re.compile(r'[a-f0-9]{64}')
_LABEL = 'org.bug-report-kit.bootstrap'
_ACTIONS = {'plan', 'install', 'update', 'status', 'verify', 'recover', 'rollback'}
_CLI_ERRORS = {'INVALID_CONFIG', 'UNSAFE_PATHS', 'UNSAFE_PRIVATE_PATH', 'INVALID_ACTION', 'ADAPTER_INVALID',
 'STATE_INVALID', 'STATE_BINDING_CHANGED', 'RESOURCE_CHANGED', 'RECOVERY_REQUIRED', 'NOT_INSTALLED',
 'LOCKED', 'RECOVERY_REQUIRES_OPERATOR', 'IMAGE_IDENTITY', 'INVALID_TRANSITION', 'CONFIG_CHANGED',
 'ACTIVATION_FAILED_RESTORED', 'DOCKER_FAILED', 'UNPINNED_IMAGE', 'HEALTH_FAILED', 'FOREIGN_RESOURCE',
 'COMPATIBILITY_FAILED', 'USAGE', 'DEPLOYMENT_FAILED'}


class BootstrapError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _fail(code):
    raise BootstrapError(code)


def _environment():
    # Do not let loader/preload options execute extra code with a public binary.
    return {k: v for k, v in os.environ.items() if k not in
            {'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'}}


def runtime_environment():
    """Sanitized environment shared with owning read-only launchers."""
    return _environment()


def _run(args, timeout=60):
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, env=_environment())
        if result.returncode or len(result.stdout) > 4096 or len(result.stderr) > 65536:
            _fail('BOOTSTRAP_COMMAND_FAILED')
        return result.stdout.decode('utf-8').strip()
    except BootstrapError:
        raise
    except Exception:
        _fail('BOOTSTRAP_COMMAND_FAILED')


def _private(path, directory=False):
    path = Path(path)
    try:
        info = path.lstat()
        if path.resolve(strict=True) != path or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            _fail('BOOTSTRAP_PRIVATE_PATH')
        if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
            _fail('BOOTSTRAP_PRIVATE_PATH')
        return info
    except BootstrapError:
        raise
    except Exception:
        _fail('BOOTSTRAP_PRIVATE_PATH')


def _version(node):
    value = _run([str(node), '--version'], timeout=10)
    match = re.fullmatch(r'v([0-9]+)\.[0-9]+\.[0-9]+', value)
    if not match or int(match[1]) < 24:
        _fail('BOOTSTRAP_NODE_VERSION')


def _sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_node(docker, container, target):
    """Stream one regular tar member, checking size/capacity before any copy."""
    process = None
    timer = None
    reader = None
    errors = bytearray()
    overflow = []
    try:
        process = subprocess.Popen([docker, 'cp', f'{container}:/usr/local/bin/node', '-'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_environment())
        def drain():
            while True:
                try:
                    chunk = process.stderr.read(4096)
                except (OSError, ValueError):
                    return
                if not chunk:
                    return
                if len(errors) + len(chunk) > 65536:
                    overflow.append(True)
                    process.kill()
                    return
                errors.extend(chunk)
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        timer = threading.Timer(60, process.kill)
        timer.daemon = True
        timer.start()
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            member = archive.next()
            if member is None or member.name != 'node' or not member.isfile() or member.mode & 0o6022 or not 4096 <= member.size <= 256 * 1024 * 1024:
                _fail('BOOTSTRAP_NODE_PATH')
            # Leave a modest reserve for the running application's filesystem.
            if shutil.disk_usage(target.parent).free < member.size + 64 * 1024 * 1024:
                _fail('BOOTSTRAP_CAPACITY')
            source = archive.extractfile(member)
            copied = 0
            with target.open('xb') as destination:
                target.chmod(0o600)
                while copied < member.size:
                    chunk = source.read(min(1024 * 1024, member.size - copied))
                    if not chunk:
                        _fail('BOOTSTRAP_EXTRACTION_FAILED')
                    destination.write(chunk)
                    copied += len(chunk)
                destination.flush()
                os.fsync(destination.fileno())
            if archive.next() is not None:
                _fail('BOOTSTRAP_NODE_PATH')
        if process.wait(timeout=10) != 0:
            _fail('BOOTSTRAP_EXTRACTION_FAILED')
        reader.join(timeout=1)
        if overflow or reader.is_alive():
            _fail('BOOTSTRAP_EXTRACTION_FAILED')
    except BootstrapError:
        raise
    except Exception:
        _fail('BOOTSTRAP_EXTRACTION_FAILED')
    finally:
        if timer:
            timer.cancel()
        if process:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        if reader:
            reader.join(timeout=1)


def resolve_node(image, private_cache, docker='docker'):
    """Return a verified absolute Node executable; never log private channels.

    The image must already have been accepted/provisioned by its owning project.
    Its immutable local Docker identity binds the copied public binary; the local
    SHA records and detects changes to that copy, not independent vendor provenance.
    Existing directories are never adopted. The caller cleans the private cache.
    """
    if not isinstance(image, str) or not _IMAGE.fullmatch(image):
        _fail('BOOTSTRAP_IMAGE_PIN')
    cache = Path(private_cache)
    if not cache.is_absolute() or cache.exists() or cache.is_symlink():
        _fail('BOOTSTRAP_PRIVATE_PATH')
    _private(cache.parent, directory=True)
    host = shutil.which('node')
    if host:
        try:
            node = Path(host).resolve(strict=True)
            info = node.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
                _fail('BOOTSTRAP_NODE_PATH')
            _version(node)
            return str(node)
        except Exception:
            # An old/incompatible host binary is not installed or altered.
            pass
    native = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    if sys.platform != 'linux' or native is None:
        _fail('BOOTSTRAP_UNSUPPORTED_HOST')
    actual = _run([docker, 'image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}', image]).split('|')
    if len(actual) != 3 or not re.fullmatch(r'sha256:[a-f0-9]{64}', actual[0]) or actual[1:] != ['linux', native]:
        _fail('BOOTSTRAP_IMAGE_PLATFORM')
    image_id = actual[0]
    if image.startswith('sha256:') and image_id != image:
        _fail('BOOTSTRAP_IMAGE_PIN')
    cache.mkdir(mode=0o700)
    cache.chmod(0o700)
    _private(cache, directory=True)
    token = uuid.uuid4().hex
    name = f'bug-kit-node-{token}'
    container = None
    node = cache / 'node'
    succeeded = False
    try:
        container = _run([docker, 'create', '--name', name, '--label', f'{_LABEL}={token}', '--network', 'none',
                          '--read-only', '--user', '65534:65534', '--entrypoint', '/bin/false', image_id])
        if not _ID.fullmatch(container):
            _fail('BOOTSTRAP_RESOURCE_CHANGED')
        guard = _run([docker, 'container', 'inspect', '--format',
            '{{.Id}}|{{.Image}}|{{.State.Status}}|{{index .Config.Labels "' + _LABEL + '"}}', container])
        if guard != f'{container}|{image_id}|created|{token}':
            _fail('BOOTSTRAP_RESOURCE_CHANGED')
        _copy_node(docker, container, node)
        info = node.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o6022 or not 4096 <= info.st_size <= 256 * 1024 * 1024:
            _fail('BOOTSTRAP_NODE_PATH')
        # Docker cp must yield one regular executable, never a link or tar/archive.
        with node.open('rb') as source:
            header = source.read(20)
            if len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != {'amd64': 62, 'arm64': 183}[native]:
                _fail('BOOTSTRAP_NODE_PATH')
        node.chmod(0o700)
        expected_hash = _sha(node)
        _private(node)
        if _sha(node) != expected_hash:
            _fail('BOOTSTRAP_NODE_HASH')
        try:
            _version(node)
        except BootstrapError as error:
            if error.code == 'BOOTSTRAP_COMMAND_FAILED':
                _fail('BOOTSTRAP_UNSUPPORTED_HOST')
            raise
        if _sha(node) != expected_hash:
            _fail('BOOTSTRAP_NODE_HASH')
        receipt = {'schema': 1, 'imageId': image_id, 'platform': f'linux/{native}', 'nodeSha256': expected_hash}
        with (cache / 'runtime.json').open('x') as target:
            json.dump(receipt, target)
        (cache / 'runtime.json').chmod(0o600)
        succeeded = True
        return str(node)
    except BootstrapError:
        raise
    except Exception:
        _fail('BOOTSTRAP_EXTRACTION_FAILED')
    finally:
        # Even a timed-out create may have created our uniquely named resource.
        try:
            found = _run([docker, 'ps', '-aq', '--no-trunc', '--filter', f'name=^/{name}$'])
            if found:
                if not _ID.fullmatch(found) or container is not None and _ID.fullmatch(container) and found != container:
                    _fail('BOOTSTRAP_RESOURCE_CHANGED')
                value = _run([docker, 'container', 'inspect', '--format',
                    '{{.Id}}|{{.Image}}|{{.State.Status}}|{{index .Config.Labels "' + _LABEL + '"}}', found])
                if value != f'{found}|{image_id}|created|{token}':
                    _fail('BOOTSTRAP_RESOURCE_CHANGED')
                _run([docker, 'rm', found])
        except Exception:
            succeeded = False
            _fail('BOOTSTRAP_CLEANUP_REQUIRED')
        finally:
            if not succeeded:
                # Remove only the new directory created by this call, never an old cache.
                shutil.rmtree(cache)


def _deployment_image(config):
    info = _private(config)
    if info.st_size > 32768:
        _fail('BOOTSTRAP_PRIVATE_CONFIG')
    try:
        value = json.loads(Path(config).read_text())
        if not isinstance(value, dict) or value.get('schema') != 1 or value.get('profile') != 'docker-server' or set(value.get('artifact', {})) != {'image'}:
            _fail('BOOTSTRAP_PRIVATE_CONFIG')
        image = value['artifact']['image']
        if not isinstance(image, str) or not _IMAGE.fullmatch(image):
            _fail('BOOTSTRAP_IMAGE_PIN')
        return image
    except BootstrapError:
        raise
    except Exception:
        _fail('BOOTSTRAP_PRIVATE_CONFIG')


def _output(result, action):
    # Never forward raw CLI stdout/stderr, even for an adapter printing private data.
    try:
        channel = result.stdout if result.returncode == 0 else result.stderr
        if len(channel) > 4096:
            raise ValueError()
        value = json.loads(channel)
        if result.returncode:
            if set(value) != {'ok', 'code'} or value['ok'] is not False or value['code'] not in _CLI_ERRORS:
                raise ValueError()
        else:
            extra = {'plan': {'installed', 'managed', 'recoveryRequired', 'change'}, 'status': {'installed', 'managed', 'recoveryRequired'},
                     'install': {'changed'}, 'update': {'changed'}, 'rollback': {'changed'}, 'recover': {'recovered'}, 'verify': set()}[action]
            if set(value) != {'ok', 'action', 'instance'} | extra or value['ok'] is not True or value['action'] != action or not re.fullmatch('[a-z0-9][a-z0-9-]{0,47}', value['instance']):
                raise ValueError()
            if any(type(value[k]) is not bool for k in extra):
                raise ValueError()
        return value
    except Exception:
        _fail('BOOTSTRAP_CLI_FAILED')


def main(argv=None):
    os.umask(0o077)
    result = {'ok': False, 'code': 'BOOTSTRAP_FAILED'}
    try:
        args = list(sys.argv[1:] if argv is None else argv)
        if len(args) not in {2, 4} or args[0] not in _ACTIONS or len(args) == 4 and (args[2] != '--adapter' or not Path(args[3]).is_absolute()):
            _fail('BOOTSTRAP_USAGE')
        config = Path(os.path.abspath(args[1]))
        image = _deployment_image(config)
        with tempfile.TemporaryDirectory(prefix='bug-kit-deploy-') as temporary:
            private = Path(temporary).resolve(strict=True)
            private.chmod(0o700)
            node = resolve_node(image, private / 'runtime')
            # Both successful and failed child channels remain internal until typed.
            child = subprocess.run([node, str(Path(__file__).resolve().with_suffix('.mjs')), *args],
                                   capture_output=True, timeout=1800, env=_environment())
            result = _output(child, args[0])
    except BootstrapError as error:
        result = {'ok': False, 'code': error.code}
    except Exception:
        result = {'ok': False, 'code': 'BOOTSTRAP_FAILED'}
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
