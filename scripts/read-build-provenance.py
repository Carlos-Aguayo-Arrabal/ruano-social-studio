"""Extract public Node digests only; never publish complete synthetic CI logs."""
import io
import json
import re
import sys
import zipfile
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()
if zipfile.is_zipfile(io.BytesIO(raw)):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        text = '\n'.join(archive.read(name).decode('utf-8', 'replace') for name in archive.namelist() if not name.endswith('/'))
else:
    text = raw.decode('utf-8', 'replace')
digests = sorted(set(re.findall(r'node@sha256:[a-f0-9]{64}', text)))
if not digests:
    raise SystemExit('No Node digest found; provenance remains unverified')
result = {'sourceRun': sys.argv[2], 'observedNodeDigests': digests, 'rawLogsPublished': False}
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/replayed-build-provenance.json').write_text(json.dumps(result, indent=2) + '\n')
print('::notice title=Replayed build provenance::' + json.dumps(result))
