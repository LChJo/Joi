import 'dart:io';
import 'i18n.dart';
import 'dart:isolate';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:printing/printing.dart';

import 'result_export_worker.dart';

export 'result_document.dart';
export 'result_export_worker.dart' show decodeResultRaster;

String resultBody(Map<String, dynamic> detail) {
  final goal = detail['goal'];
  final body = goal is Map ? goal['completionSummary'] : null;
  if (body is! String || body.trim().isEmpty) throw StateError('export_empty');
  return body;
}

enum ResultExportStage { layout, raster, save, cancelled }

class ResultExportException implements Exception {
  const ResultExportException(this.stage);
  final ResultExportStage stage;
  String get message => switch (stage) {
    ResultExportStage.layout => '正文排版失败，请重试。',
    ResultExportStage.raster => '图片转换失败，请重试或导出 PDF。',
    ResultExportStage.save => '保存失败，请检查可用空间和目录授权。',
    ResultExportStage.cancelled => '已取消导出。',
  };
  @override
  String toString() => 'result_export_${stage.name}';
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

abstract class ResultRasterizer {
  Stream<PdfRaster> raster(Uint8List document, int page);
}

class PrintingResultRasterizer implements ResultRasterizer {
  @override
  Stream<PdfRaster> raster(Uint8List document, int page) => Printing.raster(
    document,
    pages: [page],
    dpi: 1080 / PdfPageFormat.a4.width * 72,
  );
}

class ResultExportService {
  ResultExportService({ResultFileStore? store, ResultRasterizer? rasterizer})
    : store = store ?? AndroidResultFileStore(),
      rasterizer = rasterizer ?? PrintingResultRasterizer();
  final ResultFileStore store;
  final ResultRasterizer rasterizer;
  bool _busy = false;

  Future<SavedResult> export(
    String title,
    String body,
    String format,
    void Function(String) progress, {
    void Function(UiNotice)? localizedProgress,
  }) async {
    if (_busy) throw StateError('export_busy');
    _busy = true;
    Directory? temporary;
    ResultExportWorker? worker;
    var stage = ResultExportStage.layout;
    try {
      if (body.trim().isEmpty || !['pdf', 'png'].contains(format)) {
        throw const ResultExportException(ResultExportStage.layout);
      }
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
          '${safe.isEmpty ? 'Joi' : String.fromCharCodes(safe.runes.take(60))}-$stamp-${id.split('-').last}';
      temporary = await Directory(
        '${(await getTemporaryDirectory()).path}/joi-export-$id',
      ).create();
      progress('正在排版…');
      localizedProgress?.call(const UiNotice(Msg.exportStateLayout));
      final fonts = await Future.wait(
        ['NotoSansSC.ttf', 'NotoSansSymbols2.ttf', 'NotoEmoji.ttf'].map(
          (name) async => Uint8List.sublistView(
            await rootBundle.load('assets/fonts/$name'),
          ),
        ),
      );
      worker = await ResultExportWorker.start(temporary.path, name);
      final document = await worker.request('render', {
        'body': body,
        'fonts': fonts,
      });
      final pdf = document['bytes'] as Uint8List;
      final pageCount = document['pageCount'] as int;
      if (pageCount < 1 || pdf.isEmpty) throw StateError('export_empty');
      final files = <File>[];
      if (format == 'pdf') {
        stage = ResultExportStage.save;
        files.add(await File('${temporary.path}/$name.pdf').writeAsBytes(pdf));
      } else {
        stage = ResultExportStage.raster;
        for (var i = 0; i < pageCount; i++) {
          progress('正在生成图片 ${i + 1}/$pageCount…');
          localizedProgress?.call(
            UiNotice(Msg.exportStateRaster, {
              'page': formatUiNumber(i + 1),
              'total': formatUiNumber(pageCount),
            }),
          );
          var received = 0;
          // A single requested page bounds the plugin queue as well as the canvas.
          await for (final page in rasterizer.raster(pdf, i)) {
            if (++received != 1) throw StateError('export_raster_invalid');
            await worker.request('page', {
              'width': page.width,
              'height': page.height,
              'pixels': TransferableTypedData.fromList([page.pixels]),
            });
          }
          if (received != 1) throw StateError('export_raster_empty');
        }
        final result = await worker.request('finish', {});
        files.addAll((result['paths'] as List).cast<String>().map(File.new));
        if (files.isEmpty) throw StateError('export_raster_empty');
      }
      stage = ResultExportStage.save;
      progress('正在保存…');
      localizedProgress?.call(const UiNotice(Msg.exportStateSave));
      if (format == 'png' && files.length == 1) {
        files[0] = await files[0].rename('${temporary.path}/$name.png');
      }
      return await store.save(
        id,
        files,
        format == 'pdf' ? 'application/pdf' : 'image/png',
      );
    } on ResultExportException {
      rethrow;
    } on PlatformException catch (error) {
      throw ResultExportException(
        error.code == 'export_cancelled' ? ResultExportStage.cancelled : stage,
      );
    } catch (_) {
      throw ResultExportException(stage);
    } finally {
      await worker?.dispose();
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
