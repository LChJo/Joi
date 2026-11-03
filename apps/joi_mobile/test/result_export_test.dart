import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:printing/printing.dart';
import 'package:joi_mobile/connection_diagnostics_view.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/result_export.dart';

class FailingStore implements ResultFileStore {
  Directory? temporary;
  @override
  Future<SavedResult> save(String id, List<File> files, String mime) async {
    temporary = files.first.parent;
    expect(await files.first.exists(), isTrue);
    throw const FileSystemException('fake_disk_full');
  }

  @override
  Future<bool> open(String id) async => false;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (call) async => Directory.systemTemp.path,
        );
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          null,
        );
  });
  for (final variant in ['empty', 'extra', 'oversized']) {
    test('rejects $variant raster output without publishing', () async {
      final store = InspectingStore();
      final service = ResultExportService(
        store: store,
        rasterizer: InvalidRasterizer(variant),
      );
      await expectLater(
        service.export('测试', '# 正文', 'png', (_) {}),
        throwsA(
          isA<ResultExportException>().having(
            (e) => e.stage,
            'stage',
            ResultExportStage.raster,
          ),
        ),
      );
      expect(store.saves, 0);
    });
  }
  test('decodes a platform pixel view with nonzero offset exactly', () {
    const codec = StandardMethodCodec();
    final message = codec.encodeMethodCall(
      MethodCall('onPageRasterized', {
        'image': Uint8List.fromList([255, 0, 0, 255, 0, 128, 255, 64]),
        'width': 2,
        'height': 1,
      }),
    );
    final pixels =
        (codec.decodeMethodCall(message).arguments as Map)['image']
            as Uint8List;
    expect(pixels.offsetInBytes, greaterThan(0));
    final decoded = decodeResultRaster(pixels, 2, 1);
    expect(decoded.getPixel(0, 0).toList(), [255, 0, 0, 255]);
    expect(decoded.getPixel(1, 0).toList(), [0, 128, 255, 64]);
  });
  test('rejects invalid raster dimensions and incomplete pixel views', () {
    expect(() => decodeResultRaster(Uint8List(8), 0, 1), throwsStateError);
    expect(() => decodeResultRaster(Uint8List(7), 2, 1), throwsStateError);
    expect(() => decodeResultRaster(Uint8List(9), 2, 1), throwsStateError);
  });
  test('keeps supported text and makes unsupported graphemes explicit', () {
    final supported = '中文 hello ✅🚀🙂'.runes.toSet();
    expect(normalizeExportText('中文 ✅🚀🙂', supported), '中文 ✅🚀🙂');
    expect(normalizeExportText('hello 𠮷', supported), 'hello [U+20BB7]');
    expect(normalizeExportText('👩‍💻', supported), '[U+1F469 U+200D U+1F4BB]');
    expect(normalizeExportText('️', supported), '[U+FE0F]');
    expect(normalizeExportText('hello\r\n\t中文', supported), 'hello\n    中文');
  });
  test('exports ordered bounded PNG groups with white transparency', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (call) async => Directory.systemTemp.path,
        );
    final rasterizer = FixtureRasterizer();
    final store = InspectingStore();
    final service = ResultExportService(store: store, rasterizer: rasterizer);
    final body = List.generate(200, (i) => '段落 $i 完整保留。\n\n').join();
    final saved = await service.export('测试', body, 'png', (_) {});
    expect(saved.count, greaterThan(1));
    expect(rasterizer.pages, List.generate(rasterizer.pages.length, (i) => i));
    expect(rasterizer.pages.length, greaterThan(5));
    expect(
      store.heights.fold(0, (a, b) => a + b),
      rasterizer.pages.length * 1440,
    );
    expect(store.temporary!.existsSync(), isFalse);
  });
  test(
    'raster failure never publishes files and releases export lock',
    () async {
      final store = InspectingStore();
      final service = ResultExportService(
        store: store,
        rasterizer: BrokenRasterizer(),
      );
      for (var attempt = 0; attempt < 2; attempt++) {
        await expectLater(
          service.export('测试', '# 正文', 'png', (_) {}),
          throwsA(
            isA<ResultExportException>().having(
              (e) => e.stage,
              'stage',
              ResultExportStage.raster,
            ),
          ),
        );
      }
      expect(store.saves, 0);
    },
  );
  test(
    'save failure cleans temporary files and rejects duplicate operations',
    () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('plugins.flutter.io/path_provider'),
            (call) async => Directory.systemTemp.path,
          );
      final store = FailingStore();
      final service = ResultExportService(store: store);
      final operation = service.export('title', '# final', 'pdf', (_) {});
      await expectLater(
        service.export('title', '# final', 'pdf', (_) {}),
        throwsStateError,
      );
      await expectLater(
        operation,
        throwsA(
          isA<ResultExportException>().having(
            (e) => e.stage,
            'stage',
            ResultExportStage.save,
          ),
        ),
      );
      expect(store.temporary, isNotNull);
      expect(await store.temporary!.exists(), isFalse);
      await expectLater(
        service.export('title', '# final', 'pdf', (_) {}),
        throwsA(isA<ResultExportException>()),
      );
    },
  );
  test(
    'renders complex Markdown with offline fallbacks and page metadata',
    () async {
      final fonts = await Future.wait(
        [
          'NotoSansSC.ttf',
          'NotoSansSymbols2.ttf',
          'NotoEmoji.ttf',
        ].map((name) async => await rootBundle.load('assets/fonts/$name')),
      );
      expect(fonts, hasLength(3));
      final body =
          '# 中文全文起点\n\n✅ 🚀 🙂 𠮷 👩‍💻\n\n'
          '${String.fromCharCodes(List.generate(150, (i) => 0x4e00 + i))}\n\n'
          '- 父项 PARENT\n  - 子项 CHILD\n\n'
          '> 引用第一行  \n> 引用第二行\n\n'
          '硬换行 FIRST  \nSECOND\n\n'
          '| 图片 | 链接 |\n|---|---|\n| ![占位](https://invalid.example/a) | [表内链接](https://example.com/table) |\n\n'
          '| 长列 | 末列 |\n|---|---|\n| ${'表格单元格' * 400} | TABLETAIL |\n\n'
          '```\n${'code-token' * 400}\n```\n\n'
          '${List.generate(120, (i) => '段落 $i 中文内容完整保留。\n\n').join()}全文终点 END';
      final rendered = await renderResultDocument(body, fonts);
      expect(rendered.pageCount, greaterThan(1));
      final directory = Directory('../../tmp/export-validation');
      await directory.create(recursive: true);
      await File(
        '${directory.path}/android-complex-result.pdf',
      ).writeAsBytes(rendered.bytes);
    },
  );
  test(
    'renders Chinese multipage PDF offline with long code and links',
    () async {
      final body =
          '# 中文全文起点\n\n[链接](https://example.com)\n\n| 列一 | 列二 |\n|---|---|\n| 数据 | 内容 |\n\n```\n${'longCode' * 400}\n```\n\n${List.generate(120, (i) => '段落 $i 中文内容完整保留。\n\n').join()}全文终点 END';
      final bytes = await renderResultPdf(
        body,
        await rootBundle.load('assets/fonts/NotoSansSC.ttf'),
      );
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
      final directory = Directory('../../tmp/export-validation');
      await directory.create(recursive: true);
      await File('${directory.path}/android-result.pdf').writeAsBytes(bytes);
    },
  );
  test('diagnostic colors reflect current connection', () {
    expect(
      connectionColor(RemoteConnectionState.connected),
      const Color(0xff79c99e),
    );
    expect(connectionColor(RemoteConnectionState.offline), Colors.redAccent);
    expect(connectionColor(RemoteConnectionState.unpaired), Colors.grey);
    expect(connectionColor(RemoteConnectionState.reconnecting), Colors.amber);
  });
  test('snapshot only accepts complete final result', () {
    expect(
      resultBody({
        'text': 'question',
        'goal': {'completionSummary': '# final\n\nbody'},
      }),
      '# final\n\nbody',
    );
    expect(
      () => resultBody({'text': 'question', 'goal': {}}),
      throwsStateError,
    );
    expect(
      () => resultBody({
        'goal': {'completionSummary': '  '},
      }),
      throwsStateError,
    );
  });
}

class FixtureRasterizer implements ResultRasterizer {
  final pages = <int>[];
  bool active = false;
  @override
  Stream<PdfRaster> raster(Uint8List pdf, int page) async* {
    expect(active, isFalse);
    active = true;
    pages.add(page);
    try {
      final pixels = Uint8List(6 * 8 * 4);
      for (var i = 0; i < pixels.length; i += 4) {
        pixels[i] = page.isEven ? 255 : 0;
        pixels[i + 1] = page.isEven ? 0 : 255;
        pixels[i + 3] = 255;
      }
      // The first source pixel is transparent and must composite onto white.
      pixels[3] = 0;
      const codec = StandardMethodCodec();
      final message = codec.encodeMethodCall(
        MethodCall('onPageRasterized', {'image': pixels}),
      );
      final view =
          (codec.decodeMethodCall(message).arguments as Map)['image']
              as Uint8List;
      expect(view.offsetInBytes, greaterThan(0));
      yield PdfRaster(6, 8, view);
    } finally {
      active = false;
    }
  }
}

class BrokenRasterizer implements ResultRasterizer {
  @override
  Stream<PdfRaster> raster(Uint8List pdf, int page) async* {
    throw StateError('synthetic_raster_failure');
  }
}

class InvalidRasterizer implements ResultRasterizer {
  InvalidRasterizer(this.variant);
  final String variant;
  @override
  Stream<PdfRaster> raster(Uint8List pdf, int page) async* {
    if (variant == 'empty') return;
    if (variant == 'oversized') {
      yield PdfRaster(1, 8192, Uint8List(8192 * 4));
    } else {
      yield PdfRaster(6, 8, Uint8List(6 * 8 * 4));
      yield PdfRaster(6, 8, Uint8List(6 * 8 * 4));
    }
  }
}

class InspectingStore implements ResultFileStore {
  final heights = <int>[];
  Directory? temporary;
  int saves = 0;
  @override
  Future<SavedResult> save(String id, List<File> files, String mime) async {
    saves++;
    temporary = files.first.parent;
    for (final file in files) {
      final decoded = img.decodePng(await file.readAsBytes())!;
      expect(decoded.width, 1080);
      expect(decoded.height, lessThanOrEqualTo(8192));
      expect(decoded.height % 1440, 0);
      for (var y = 0; y < decoded.height; y += 1440) {
        final page = (heights.fold(0, (a, b) => a + b) + y) ~/ 1440;
        expect(decoded.getPixel(0, y).toList().take(3), [255, 255, 255]);
        expect(
          decoded.getPixel(1000, y + 1000).toList().take(3),
          page.isEven ? [255, 0, 0] : [0, 255, 0],
        );
      }
      final reference = Uint8List(1080 * decoded.height * 3);
      final pageOffset = heights.fold(0, (a, b) => a + b) ~/ 1440;
      for (var y = 0; y < decoded.height; y++) {
        final even = (pageOffset + y ~/ 1440).isEven;
        for (var x = 0; x < 1080; x++) {
          final white = x < 180 && y % 1440 < 180;
          final offset = (y * 1080 + x) * 3;
          reference[offset] = white || even ? 255 : 0;
          reference[offset + 1] = white || !even ? 255 : 0;
          reference[offset + 2] = white ? 255 : 0;
        }
      }
      expect(
        listEquals(decoded.getBytes(order: img.ChannelOrder.rgb), reference),
        isTrue,
        reason: 'Every exported pixel must match the ordered source pages',
      );
      heights.add(decoded.height);
    }
    return SavedResult(files.length, '下载/Joi', id);
  }

  @override
  Future<bool> open(String id) async => false;
}
