import 'dart:io';
import 'dart:math';
import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:image/image.dart' as img;
import 'package:path_provider/path_provider.dart';

String resultBody(Map<String, dynamic> detail) {
  final goal = detail['goal'];
  final body = goal is Map ? goal['completionSummary'] : null;
  if (body is! String || body.trim().isEmpty) throw StateError('export_empty');
  return body;
}

class SavedResult {
  const SavedResult(this.count, this.location, this.id);
  final int count;
  final String location;
  final String id;
}

abstract class ResultFileStore {
  Future<SavedResult> save(String id, List<File> files, String mime);
  Future<bool> open(String id);
}

class AndroidResultFileStore implements ResultFileStore {
  static const channel = MethodChannel('joi/result-export');
  @override
  Future<SavedResult> save(String id, List<File> files, String mime) async {
    final result = await channel.invokeMapMethod<String, dynamic>('save', {
      'id': id,
      'paths': files.map((f) => f.path).toList(),
      'mime': mime,
    });
    return SavedResult(
      files.length,
      result?['location'] as String? ?? '下载/Joi',
      id,
    );
  }

  @override
  Future<bool> open(String id) async =>
      await channel.invokeMethod<bool>('open', {'id': id}) ?? false;
}

// The PDF text engine splits overlong words itself; retain the exact characters.
String _wrap(String value) => value;
List<pw.InlineSpan> _inline(List<md.Node> nodes) => nodes.map((node) {
  if (node is md.Text) return pw.TextSpan(text: _wrap(node.text));
  final e = node as md.Element;
  if (e.tag == 'img') return const pw.TextSpan(text: '[图片]');
  if (e.tag == 'br') return const pw.TextSpan(text: '\n');
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

// Split table cells without discarding inline links or formatting.
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

List<pw.Widget> _blocks(List<md.Node> nodes, {String marker = ''}) {
  final widgets = <pw.Widget>[];
  for (final node in nodes) {
    if (node is md.Element && ['ul', 'ol'].contains(node.tag)) {
      var index = 0;
      for (final child in node.children ?? <md.Node>[]) {
        widgets.addAll(
          _blocks([child], marker: node.tag == 'ol' ? '${++index}. ' : '• '),
        );
      }
    } else if (node is md.Element && node.tag == 'blockquote') {
      widgets.addAll(_blocks(node.children ?? [], marker: '│ '));
    } else if (node is md.Element && node.tag == 'table') {
      final rows = <md.Element>[];
      void visit(md.Node n) {
        if (n is md.Element) {
          if (n.tag == 'tr') {
            rows.add(n);
          } else {
            for (final c in n.children ?? <md.Node>[]) {
              visit(c);
            }
          }
        }
      }

      visit(node);
      // Split very long cells into bounded rows, retaining all text in order.
      final tableRows = <pw.TableRow>[];
      for (final row in rows) {
        final cells = row.children ?? [];
        final limit = max(12, 360 ~/ max(1, cells.length));
        final chunks = cells
            .map(
              (cell) => [
                for (var i = 0; i < cell.textContent.runes.length; i += limit)
                  _sliceInline(cell, i, i + limit),
              ],
            )
            .toList();
        final count = chunks.fold<int>(1, (n, c) => max(n, c.length));
        for (var i = 0; i < count; i++) {
          tableRows.add(
            pw.TableRow(
              children: chunks
                  .map(
                    (c) => pw.Padding(
                      padding: const pw.EdgeInsets.all(5),
                      child: pw.RichText(
                        text: pw.TextSpan(
                          children: i < c.length
                              ? _inline([c[i]])
                              : [const pw.TextSpan(text: '')],
                        ),
                      ),
                    ),
                  )
                  .toList(),
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
    } else {
      final e = node is md.Element ? node : null;
      final heading = e != null && RegExp(r'^h[1-6]$').hasMatch(e.tag);
      final prefix = marker;
      widgets.add(
        pw.RichText(
          overflow: pw.TextOverflow.span,
          text: pw.TextSpan(
            style: pw.TextStyle(fontSize: heading ? 18 : 11, lineSpacing: 3),
            children: [
              pw.TextSpan(text: prefix),
              ..._inline(e?.children ?? [node]),
            ],
          ),
        ),
      );
      widgets.add(pw.SizedBox(height: 8));
    }
  }
  return widgets;
}

Future<Uint8List> renderResultPdf(String body, ByteData fontData) async {
  if (body.trim().isEmpty) throw StateError('export_empty');
  final font = pw.Font.ttf(fontData);
  final document = pw.Document(
    theme: pw.ThemeData.withFont(
      base: font,
      bold: font,
      italic: font,
      boldItalic: font,
    ),
  );
  final nodes = md.Document(
    extensionSet: md.ExtensionSet.gitHubFlavored,
  ).parseLines(body.split('\n'));
  document.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(36),
      maxPages: 10000,
      build: (_) => _blocks(nodes),
    ),
  );
  return document.save();
}

class ResultExportService {
  ResultExportService({ResultFileStore? store})
    : store = store ?? AndroidResultFileStore();
  final ResultFileStore store;
  bool _busy = false;
  Future<SavedResult> export(
    String title,
    String body,
    String format,
    void Function(String) progress,
  ) async {
    if (_busy) throw StateError('export_busy');
    _busy = true;
    Directory? temporary;
    try {
      final id =
          '${DateTime.now().microsecondsSinceEpoch}-${Random.secure().nextInt(0x7fffffff).toRadixString(16)}';
      final safe = title
          .replaceAll(RegExp(r'[\x00-\x1f<>:"/\\|?*]'), '_')
          .replaceAll(RegExp(r'^[. ]+|[. ]+$'), '');
      final stamp = DateTime.now()
          .toIso8601String()
          .replaceAll(RegExp('[^0-9]'), '')
          .substring(0, 14);
      final name =
          '${safe.isEmpty ? 'Joi' : safe.substring(0, min(60, safe.length))}-$stamp-${id.split('-').last}';
      temporary = await Directory(
        '${(await getTemporaryDirectory()).path}/joi-export-$id',
      ).create();
      progress('正在排版…');
      final pdf = await renderResultPdf(
        body,
        await rootBundle.load('assets/fonts/NotoSansSC.ttf'),
      );
      final files = <File>[];
      if (format == 'pdf') {
        files.add(await File('${temporary.path}/$name.pdf').writeAsBytes(pdf));
      } else if (format == 'png') {
        // A bounded canvas holds up to five A4 pages (<8192px); pages are
        // rasterized and encoded sequentially, preserving pagination boundaries.
        img.Image? canvas;
        var used = 0;
        var index = 0;
        Future<void> flush() async {
          if (canvas == null) return;
          final cropped = img.copyCrop(
            canvas!,
            x: 0,
            y: 0,
            width: 1080,
            height: used,
          );
          final bytes = img.encodePng(cropped);
          files.add(
            await File(
              '${temporary!.path}/$name-${(++index).toString().padLeft(3, '0')}.png',
            ).writeAsBytes(bytes),
          );
          canvas = null;
          used = 0;
        }

        await for (final page in Printing.raster(
          pdf,
          dpi: 1080 / PdfPageFormat.a4.width * 72,
        )) {
          final decoded = img.Image.fromBytes(
            width: page.width,
            height: page.height,
            bytes: page.pixels.buffer,
            numChannels: 4,
          );
          final raster = img.copyResize(decoded, width: 1080);
          if (used + raster.height > 8192) await flush();
          canvas ??= img.fill(
            img.Image(width: 1080, height: 8192, numChannels: 3),
            color: img.ColorRgb8(255, 255, 255),
          );
          img.compositeImage(canvas!, raster, dstY: used);
          used += raster.height;
          progress('正在生成图片 ${index + 1}…');
        }
        await flush();
      } else {
        throw StateError('export_format');
      }
      progress('正在保存…');
      if (format == 'png' && files.length == 1) {
        files[0] = await files[0].rename('${temporary.path}/$name.png');
      }
      return await store.save(
        id,
        files,
        format == 'pdf' ? 'application/pdf' : 'image/png',
      );
    } finally {
      if (temporary != null) {
        try {
          await temporary.delete(recursive: true);
        } catch (_) {
          /* Private cache cleanup must not hide a saved result. */
        }
      }
      _busy = false;
    }
  }
}
