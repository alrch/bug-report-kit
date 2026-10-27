"""Build-time download only. A request must never trigger model installation."""
import argparse
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('destination')
parser.add_argument('--repository', default='Systran/faster-whisper-small')
parser.add_argument('--revision', default='536b0662742c02347bc0e980a01041f333bce120')
args = parser.parse_args()
if len(args.revision) != 40 or any(c not in '0123456789abcdef' for c in args.revision):
    raise ValueError('Use an immutable model revision')
path = Path(args.destination)
snapshot_download(args.repository, revision=args.revision, local_dir=path,
                  allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*', 'preprocessor_config.json'])
for name in ['model.bin', 'config.json', 'tokenizer.json']:
    if not (path / name).is_file():
        raise ValueError('Incomplete speech model')
with (path / 'model.bin').open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
(path / 'model-source.json').write_text(json.dumps({'repository': args.repository, 'revision': args.revision, 'modelSha256': digest}))
