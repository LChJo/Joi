"""Inspect the deterministic export fixtures. Requires PyMuPDF.

python scripts/verify-result-export.py <desktop.pdf> <android.pdf>
The fixtures contain no user data. Never pass user exports to CI logs.
"""
import argparse
import re
from pathlib import Path
import pymupdf

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('files', nargs='+')
parser.add_argument('--complex', dest='complex_pdf')
args = parser.parse_args()
if len(args.files) not in (1, 2):
    parser.error('Pass Android PDF, or desktop PDF followed by Android PDF')
output = Path('tmp/export-validation')
output.mkdir(parents=True, exist_ok=True)
labels = ('android',) if len(args.files) == 1 else ('desktop', 'android')
fixtures = list(zip(labels, args.files, strict=True))
if args.complex_pdf:
    fixtures.append(('android-complex', args.complex_pdf))
for label, filename in fixtures:
    document = pymupdf.open(filename)
    text = ''.join(page.get_text() for page in document)
    normalized = re.sub(r'\s+', '', text)
    assert '中文全文起点' in normalized, 'missing selectable Chinese text'
    assert '全文终点END' in normalized, 'missing final result tail'
    assert len(document) > 1, 'fixture must paginate'
    links = sum(len(page.get_links()) for page in document)
    assert links > 0, 'missing clickable link'
    if label == 'android-complex':
        for marker in ('PARENT', 'CHILD', 'FIRST', 'SECOND', 'TABLETAIL',
                       '[图片]', '[U+20BB7]', '[U+1F469U+200DU+1F4BB]', '✅', '🚀', '🙂'):
            assert marker in normalized, f'missing complex fixture marker: {marker}'
        assert normalized.count('表格单元格') == 400, 'table content lost'
        assert normalized.count('code-token') == 400, 'code content lost'
        assert ''.join(chr(0x4e00 + i) for i in range(150)) in normalized, 'CMap batch boundary lost'
        assert len(re.findall(r'段落\d+中文内容完整保留。', normalized)) == 120, 'paragraphs lost'
        assert any(link.get('uri') == 'https://example.com/table'
                   for page in document for link in page.get_links()), 'table link lost'
    for page in document:
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    assert span['bbox'][0] >= -1 and span['bbox'][2] <= page.rect.width + 1, 'right edge clipped'
                    assert span['bbox'][1] >= -1 and span['bbox'][3] <= page.rect.height + 1, 'bottom edge clipped'
    document[0].get_pixmap().save(output / f'{label}-first.png')
    document[-1].get_pixmap().save(output / f'{label}-last.png')
    if label == 'android-complex':
        document[len(document) // 2].get_pixmap().save(output / f'{label}-middle.png')
    print(f'{label}: {len(document)} pages, {links} links; selectable Chinese and final tail verified')
