"""Inspect the deterministic export fixtures. Requires PyMuPDF.

python scripts/verify-result-export.py <desktop.pdf> <android.pdf>
The fixtures contain no user data. Never pass user exports to CI logs.
"""
import re
import sys
from pathlib import Path
import pymupdf

output = Path('tmp/export-validation')
output.mkdir(parents=True, exist_ok=True)
for label, filename in zip(('desktop', 'android'), sys.argv[1:], strict=True):
    document = pymupdf.open(filename)
    text = ''.join(page.get_text() for page in document)
    normalized = re.sub(r'\s+', '', text)
    assert '中文全文起点' in normalized, 'missing selectable Chinese text'
    assert '全文终点END' in normalized, 'missing final result tail'
    assert len(document) > 1, 'fixture must paginate'
    links = sum(len(page.get_links()) for page in document)
    assert links > 0, 'missing clickable link'
    for page in document:
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    assert span['bbox'][0] >= -1 and span['bbox'][2] <= page.rect.width + 1, 'right edge clipped'
    document[0].get_pixmap().save(output / f'{label}-first.png')
    document[-1].get_pixmap().save(output / f'{label}-last.png')
    print(f'{label}: {len(document)} pages, {links} links; selectable Chinese and final tail verified')
