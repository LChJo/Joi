import 'dart:math';
import 'dart:typed_data';

import 'package:characters/characters.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
// The pinned PDF API exposes the Unicode map override through this type.
// ignore: implementation_imports
import 'package:pdf/src/pdf/obj/unicode_cmap.dart';
// ignore: implementation_imports
import 'package:pdf/src/pdf/obj/object_stream.dart';

class _ResultTtfFont extends pw.TtfFont {
  _ResultTtfFont(super.data);
  @override
  PdfFont buildFont(PdfDocument pdfDocument) {
    final font = super.buildFont(pdfDocument) as PdfTtfFont;
    font.unicodeCMap = _ResultUnicodeMap(pdfDocument);
    return font;
  }
}

class _ResultUnicodeMap extends PdfObjectStream implements PdfUnicodeCmap {
  _ResultUnicodeMap(super.pdfDocument);
  @override
  final cmap = <int>[0];
  @override
  final bool protect = false;

  @override
  void prepare() {
    // ToUnicode destinations are UTF-16BE sequences, including surrogate pairs.
    buf.putString(
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
      '/CMapName /JoiUTF16 def\n/CMapType 2 def\n'
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n',
    );
    for (var start = 0; start < cmap.length; start += 100) {
      final end = min(start + 100, cmap.length);
      buf.putString('${end - start} beginbfchar\n');
      for (var index = start; index < end; index++) {
        final unicode = String.fromCharCode(cmap[index]).codeUnits
            .map((unit) => unit.toRadixString(16).padLeft(4, '0'))
            .join();
        buf.putString(
          '<${index.toRadixString(16).padLeft(4, '0')}> <$unicode>\n',
        );
      }
      buf.putString('endbfchar\n');
    }
    buf.putString(
      'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n',
    );
    super.prepare();
  }
}

class RenderedResultDocument {
  const RenderedResultDocument(this.bytes, this.pageCount);
  final Uint8List bytes;
  final int pageCount;
}

String normalizeExportText(String value, Set<int> supported) {
  return value
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .replaceAll('\t', '    ')
      .characters
      .map((character) {
        final runes = character.runes.toList();
        final sequence =
            runes.any(
              (r) =>
                  r == 0x200d ||
                  r == 0x20e3 ||
                  (r >= 0x1f3fb && r <= 0x1f3ff) ||
                  (r >= 0xe0020 && r <= 0xe007f),
            ) ||
            runes.where((r) => r >= 0x1f1e6 && r <= 0x1f1ff).length > 1;
        final visible = runes.where((r) => r != 0xfe0e && r != 0xfe0f).toList();
        if (!sequence &&
            visible.isNotEmpty &&
            visible.every(
              (r) => supported.contains(r) || r == 10 || r == 13 || r == 9,
            )) {
          return String.fromCharCodes(visible);
        }
        return '[${runes.map((r) => 'U+${r.toRadixString(16).toUpperCase().padLeft(4, '0')}').join(' ')}]';
      })
      .join();
}

md.Node _normalizeNode(md.Node node, Set<int> supported) {
  if (node is md.Text) {
    return md.Text(normalizeExportText(node.text, supported));
  }
  final element = node as md.Element;
  if (element.tag == 'img') return md.Text('[图片]');
  if (element.tag == 'br') return md.Text('\n');
  return md.Element(
    element.tag,
    (element.children ?? []).map((n) => _normalizeNode(n, supported)).toList(),
  )..attributes.addAll(element.attributes);
}

List<pw.InlineSpan> _inline(List<md.Node> nodes) => nodes.map((node) {
  if (node is md.Text) return pw.TextSpan(text: node.text);
  final e = node as md.Element;
  final children = _inline(e.children ?? []);
  if (e.tag == 'a' &&
      RegExp(r'^https?://').hasMatch(e.attributes['href'] ?? '')) {
    return pw.TextSpan(
      children: children,
      annotation: pw.AnnotationUrl(e.attributes['href']!),
      style: const pw.TextStyle(
        color: PdfColors.teal800,
        decoration: pw.TextDecoration.underline,
      ),
    );
  }
  return pw.TextSpan(
    children: children,
    style: pw.TextStyle(
      fontWeight: e.tag == 'strong' ? pw.FontWeight.bold : null,
      fontStyle: e.tag == 'em' ? pw.FontStyle.italic : null,
    ),
  );
}).toList();

// Slice normalized inline content, retaining its annotations and formatting.
md.Node _sliceInline(md.Node node, int start, int end) {
  if (node is md.Text) {
    final runes = node.text.runes.toList();
    return md.Text(
      String.fromCharCodes(
        runes.sublist(start.clamp(0, runes.length), end.clamp(0, runes.length)),
      ),
    );
  }
  final element = node as md.Element;
  final children = <md.Node>[];
  var offset = 0;
  for (final child in element.children ?? <md.Node>[]) {
    final length = child.textContent.runes.length;
    if (offset < end && offset + length > start) {
      children.add(
        _sliceInline(child, max(0, start - offset), min(length, end - offset)),
      );
    }
    offset += length;
  }
  return md.Element(element.tag, children)
    ..attributes.addAll(element.attributes);
}

List<md.Node> _cellChunks(md.Node cell, int limit) {
  final runes = cell.textContent.runes.toList();
  final chunks = <md.Node>[];
  var start = 0;
  while (start < runes.length) {
    var end = start;
    var breaks = 0;
    while (end < runes.length && end - start < limit && breaks < 8) {
      if (runes[end] == 10) breaks++;
      end++;
    }
    chunks.add(_sliceInline(cell, start, end));
    start = end;
  }
  return chunks;
}

pw.Widget _text(List<md.Node> nodes, {String marker = '', double size = 11}) =>
    pw.RichText(
      overflow: pw.TextOverflow.span,
      text: pw.TextSpan(
        style: pw.TextStyle(fontSize: size, lineSpacing: 3),
        children: [
          pw.TextSpan(text: marker),
          ..._inline(nodes),
        ],
      ),
    );

List<pw.Widget> _blocks(
  List<md.Node> nodes, {
  String marker = '',
  int depth = 0,
}) {
  final widgets = <pw.Widget>[];
  for (final node in nodes) {
    final e = node is md.Element ? node : null;
    if (e != null && ['ul', 'ol'].contains(e.tag)) {
      var index = int.tryParse(e.attributes['start'] ?? '') ?? 1;
      for (final child in e.children ?? <md.Node>[]) {
        widgets.addAll(
          _blocks(
            [child],
            depth: depth + 1,
            marker: '${'  ' * depth}${e.tag == 'ol' ? '${index++}. ' : '• '}',
          ),
        );
      }
    } else if (e?.tag == 'li') {
      final inline = <md.Node>[];
      var prefix = marker;
      void flush() {
        if (inline.isEmpty) return;
        widgets.add(_text(inline.toList(), marker: prefix));
        inline.clear();
        prefix = '';
      }

      for (final child in e!.children ?? <md.Node>[]) {
        if (child is md.Element &&
            ['p', 'ul', 'ol', 'blockquote', 'pre'].contains(child.tag)) {
          flush();
          widgets.addAll(_blocks([child], marker: prefix, depth: depth));
          prefix = '';
        } else {
          inline.add(child);
        }
      }
      flush();
      widgets.add(pw.SizedBox(height: 4));
    } else if (e?.tag == 'blockquote') {
      widgets.addAll(
        _blocks(e!.children ?? [], marker: '$marker│ ', depth: depth),
      );
    } else if (e?.tag == 'table') {
      final rows = <md.Element>[];
      void visit(md.Node n) {
        if (n is md.Element) {
          if (n.tag == 'tr') {
            rows.add(n);
          } else {
            for (final child in n.children ?? <md.Node>[]) {
              visit(child);
            }
          }
        }
      }

      visit(node);
      final columns = rows.fold<int>(
        0,
        (n, row) => max(n, row.children?.length ?? 0),
      );
      // Very wide tables become vertical rows so no column is clipped.
      if (columns > 8) {
        for (final row in rows) {
          for (final cell in row.children ?? <md.Node>[]) {
            widgets.add(_text([cell]));
          }
          widgets.add(pw.SizedBox(height: 8));
        }
      } else {
        final tableRows = <pw.TableRow>[];
        for (final row in rows) {
          final chunks = (row.children ?? <md.Node>[])
              .map((cell) => _cellChunks(cell, max(12, 360 ~/ max(1, columns))))
              .toList();
          final count = chunks.fold<int>(1, (n, c) => max(n, c.length));
          for (var i = 0; i < count; i++) {
            tableRows.add(
              pw.TableRow(
                children: [
                  for (var column = 0; column < columns; column++)
                    pw.Padding(
                      padding: const pw.EdgeInsets.all(5),
                      child: _text(
                        column < chunks.length && i < chunks[column].length
                            ? [chunks[column][i]]
                            : [md.Text('')],
                      ),
                    ),
                ],
              ),
            );
          }
        }
        widgets.add(
          pw.Table(
            border: pw.TableBorder.all(color: PdfColors.grey500),
            defaultColumnWidth: const pw.FlexColumnWidth(),
            children: tableRows,
          ),
        );
      }
    } else if (e?.tag == 'hr') {
      widgets.add(pw.Divider());
    } else {
      final heading = e != null && RegExp(r'^h[1-6]$').hasMatch(e.tag);
      widgets.add(
        _text(
          e?.children ?? [node],
          marker: marker,
          size: heading
              ? 18
              : e?.tag == 'pre'
              ? 9
              : 11,
        ),
      );
      widgets.add(pw.SizedBox(height: 8));
    }
  }
  return widgets;
}

Future<RenderedResultDocument> renderResultDocument(
  String body,
  List<ByteData> fontData,
) async {
  if (body.trim().isEmpty) throw StateError('export_empty');
  if (fontData.isEmpty) throw StateError('export_font_missing');
  final fonts = fontData.map(_ResultTtfFont.new).toList();
  final supported = <int>{};
  for (final data in fontData) {
    supported.addAll(
      TtfParser(data).charToGlyphIndexMap.entries
          .where((e) => e.value != 0)
          .map((e) => e.key),
    );
  }
  final document = pw.Document(
    theme: pw.ThemeData.withFont(
      base: fonts.first,
      bold: fonts.first,
      italic: fonts.first,
      boldItalic: fonts.first,
      fontFallback: fonts.skip(1).toList(),
    ),
  );
  final nodes = md.Document(extensionSet: md.ExtensionSet.gitHubFlavored)
      .parseLines(
        body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n'),
      )
      .map((n) => _normalizeNode(n, supported))
      .toList();
  document.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(36),
      maxPages: 10000,
      build: (_) => _blocks(nodes),
    ),
  );
  final bytes = await document.save();
  return RenderedResultDocument(
    bytes,
    document.document.pdfPageList.pages.length,
  );
}

Future<Uint8List> renderResultPdf(String body, ByteData fontData) async =>
    (await renderResultDocument(body, [fontData])).bytes;
