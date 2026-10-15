import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/result_reader.dart';
import 'package:joi_mobile/result_export.dart';
import 'widget_test.dart' show FakeRemoteController;

class ReaderController extends FakeRemoteController {
  ReaderController()
    : super(const RemoteViewState(connection: RemoteConnectionState.connected));
  final result = Completer<Map<String, dynamic>>();
  bool offline = false;
  int reads = 0;
  @override
  RemoteViewState get state => RemoteViewState(
    connection: offline
        ? RemoteConnectionState.offline
        : RemoteConnectionState.connected,
  );
  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  }) {
    reads++;
    return result.future;
  }
}

const goal = RemoteGoalCard(
  activeWork: 0,
  completedWork: 1,
  status: 'COMPLETED',
  title: '标题不复制',
  totalWork: 1,
  goalId: 'goal',
  summary: '截断预览',
);

void main() {
  for (final stage in ResultExportStage.values) {
    testWidgets('shows safe ${stage.name} export failure and allows retry', (
      tester,
    ) async {
      final controller = ReaderController();
      final service = ReaderExportService(stage);
      await tester.pumpWidget(
        MaterialApp(
          home: ResultReaderPage(
            controller: controller,
            goal: goal,
            service: service,
          ),
        ),
      );
      controller.result.complete({
        'goal': {'completionSummary': '# 正文'},
      });
      await tester.pumpAndSettle();
      for (var attempt = 0; attempt < 2; attempt++) {
        await tester.tap(find.byTooltip('导出全文'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('导出 PNG'));
        await tester.pumpAndSettle();
        expect(find.text(ResultExportException(stage).message), findsOneWidget);
        expect(find.text('打开'), findsNothing);
      }
      expect(service.calls, 2);
    });
  }
  testWidgets(
    'loads complete snapshot, copies offline exactly, and back closes menu first',
    (tester) async {
      final controller = ReaderController();
      String? clipboard;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: ResultReaderPage(controller: controller, goal: goal),
        ),
      );
      expect(
        tester
            .widget<IconButton>(
              find.ancestor(
                of: find.byTooltip('导出全文'),
                matching: find.byType(IconButton),
              ),
            )
            .onPressed,
        isNull,
      );
      final body = '# 最终正文\n\n${'跨分片内容' * 5000}\n\n末尾';
      controller.result.complete({
        'text': '原始提问',
        'goal': {'completionSummary': body},
      });
      await tester.pumpAndSettle();
      controller.offline = true;
      controller.notifyListeners();
      await tester.tap(find.byTooltip('导出全文'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('复制全文'), findsNothing);
      expect(find.text('查看全文'), findsOneWidget);
      await tester.tap(find.byTooltip('导出全文'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('复制全文'));
      await tester.pumpAndSettle();
      expect(clipboard, body);
      expect(controller.reads, 1);
      expect(find.text('已复制全文'), findsOneWidget);
    },
  );
  testWidgets('failed load never exports the truncated preview', (
    tester,
  ) async {
    final controller = ReaderController();
    await tester.pumpWidget(
      MaterialApp(
        home: ResultReaderPage(controller: controller, goal: goal),
      ),
    );
    controller.result.completeError(StateError('offline'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<IconButton>(
            find.ancestor(
              of: find.byTooltip('导出全文'),
              matching: find.byType(IconButton),
            ),
          )
          .onPressed,
      isNull,
    );
    expect(find.text('截断预览'), findsNothing);
    expect(find.textContaining('未能读取完整结果'), findsOneWidget);
  });
}

class ReaderExportService extends ResultExportService {
  ReaderExportService(this.failure);
  final ResultExportStage failure;
  int calls = 0;
  @override
  Future<SavedResult> export(
    String title,
    String body,
    String format,
    void Function(String) progress,
  ) async {
    calls++;
    throw ResultExportException(failure);
  }
}
