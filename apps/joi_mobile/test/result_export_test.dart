import 'package:flutter/material.dart';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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
      await expectLater(operation, throwsA(isA<FileSystemException>()));
      expect(store.temporary, isNotNull);
      expect(await store.temporary!.exists(), isFalse);
      await expectLater(
        service.export('title', '# final', 'pdf', (_) {}),
        throwsA(isA<FileSystemException>()),
      );
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
