import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/connection_diagnostics_view.dart';
import 'package:joi_mobile/goal_detail.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/result_export.dart';
import 'package:joi_mobile/result_history.dart';
import 'package:joi_mobile/result_reader.dart';

import 'widget_test.dart' show FakeRemoteController;

const historyGoal = RemoteGoalCard(
  goalId: 'goal',
  activeWork: 0,
  completedWork: 1,
  status: 'COMPLETED',
  title: '任务标题',
  totalWork: 1,
  resultId: 'result-0',
  summary: '最新结果预览',
);

class HistoryController extends FakeRemoteController {
  HistoryController({bool supported = true, this.count = 24})
    : view = RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        supportsResultHistory: supported,
      ),
      super(const RemoteViewState());

  RemoteViewState view;
  final int count;
  final calls = <Map<String, String?>>[];
  bool failList = false;
  bool failMore = false;
  bool failResult = false;

  @override
  RemoteViewState get state => view;

  void goOffline() {
    view = view.copyWith(connection: RemoteConnectionState.offline);
    notifyListeners();
  }

  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
    String? agentId,
    String? cursor,
  }) async {
    calls.add({
      'kind': kind,
      'goalId': goalId,
      'resultId': resultId,
      'cursor': cursor,
    });
    if (kind == 'goal.results') {
      if (failList || cursor != null && failMore) throw StateError('offline');
      final start = cursor == null ? 0 : 20;
      final end = count < start + 20 ? count : start + 20;
      return {
        'items': [
          for (var index = start; index < end; index++)
            {
              'resultId': 'result-$index',
              'completedAt': DateTime.utc(
                2026,
                11,
                2,
                13,
                30 - index,
              ).toIso8601String(),
              'status': index == 1 ? 'COMPLETED_WITH_GAPS' : 'COMPLETED',
            },
        ],
        if (end < count) 'nextCursor': 'second-page',
      };
    }
    if (kind == 'goal.result') {
      if (failResult) throw StateError('offline');
      return {
        'goalId': goalId,
        'resultId': resultId,
        'completedAt': '2026-11-02T13:00:00.000Z',
        'status': 'COMPLETED',
        'body': '# $resultId 正文\n\n完整 Markdown 内容。',
      };
    }
    return super.read(
      kind,
      goalId: goalId,
      resultId: resultId,
      agentId: agentId,
      cursor: cursor,
    );
  }
}

class HistoryExportService extends ResultExportService {
  final exports = <Map<String, String>>[];

  @override
  Future<SavedResult> export(
    String title,
    String body,
    String format,
    void Function(String) progress, {
    void Function(UiNotice)? localizedProgress,
  }) async {
    exports.add({'body': body, 'format': format});
    return const SavedResult(1, 'Documents/Joi', 'saved-result');
  }
}

void main() {
  test(
    'history capability and result identity survive unrelated state updates',
    () {
      expect(const RemoteViewState().supportsResultHistory, isFalse);
      expect(
        const RemoteViewState(supportsResultHistory: true)
            .copyWith(connection: RemoteConnectionState.offline)
            .supportsResultHistory,
        isTrue,
      );
      expect(
        const RemoteViewState(
          supportsResultHistory: true,
        ).copyWith(supportsResultHistory: false).supportsResultHistory,
        isFalse,
      );
      expect(historyGoal.withArchivedAt('2026-11-02').resultId, 'result-0');
    },
  );

  testWidgets(
    'lists completed snapshots in order and keeps position on return',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = HistoryController();
      await tester.pumpWidget(
        MaterialApp(
          home: ResultHistoryPage(controller: controller, goal: historyGoal),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(tr(Msg.homeLatestResult)), findsOneWidget);
      expect(find.text(tr(Msg.mobileCompletedWithGaps)), findsOneWidget);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('result-0'))).dy,
        lessThan(tester.getTopLeft(find.byKey(const ValueKey('result-1'))).dy),
      );
      expect(find.byType(ConnectionDiagnosticsButton), findsOneWidget);
      expect(find.byType(MessageBody), findsNothing);
      await tester.scrollUntilVisible(
        find.text(tr(Msg.homeLoadMoreResults)),
        600,
      );
      await tester.tap(find.text(tr(Msg.homeLoadMoreResults)));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('result-23')),
        300,
      );
      await tester.ensureVisible(find.byKey(const ValueKey('result-23')));
      await tester.pumpAndSettle();
      final position = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position
          .pixels;
      await tester.tap(find.byKey(const ValueKey('result-23')));
      await tester.pumpAndSettle();
      expect(
        tester.widget<MessageBody>(find.byType(MessageBody)).text,
        '# result-23 正文\n\n完整 Markdown 内容。',
      );
      await tester.tap(find.byTooltip(tr(Msg.homeBackToResultHistory)));
      await tester.pumpAndSettle();
      expect(
        tester
            .state<ScrollableState>(find.byType(Scrollable).first)
            .position
            .pixels,
        position,
      );
      expect(controller.calls.where((call) => call['kind'] == 'goal.results'), [
        {
          'kind': 'goal.results',
          'goalId': 'goal',
          'resultId': null,
          'cursor': null,
        },
        {
          'kind': 'goal.results',
          'goalId': 'goal',
          'resultId': null,
          'cursor': 'second-page',
        },
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'copies and exports only the selected frozen body while offline',
    (tester) async {
      final controller = HistoryController(count: 2);
      final service = HistoryExportService();
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
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: ResultHistoryPage(
            controller: controller,
            goal: historyGoal,
            service: service,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.calls.map((call) => call['kind']), ['goal.results']);
      expect(
        tester
            .widgetList<ListTile>(find.byType(ListTile))
            .map((tile) => tile.key),
        [const ValueKey('result-0'), const ValueKey('result-1')],
      );
      await tester.tap(find.byKey(const ValueKey('result-1')));
      await tester.pumpAndSettle();
      controller.goOffline();
      await tester.pumpAndSettle();
      final readCount = controller.calls.length;
      for (final label in [
        tr(Msg.exportCopyFullText),
        tr(Msg.exportExportPdf),
        tr(Msg.exportExportPng),
      ]) {
        await tester.tap(find.byTooltip(tr(Msg.exportExportFullText)));
        await tester.pumpAndSettle();
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
      }
      const body = '# result-1 正文\n\n完整 Markdown 内容。';
      expect(clipboard, body);
      expect(service.exports, [
        {'body': body, 'format': 'pdf'},
        {'body': body, 'format': 'png'},
      ]);
      expect(controller.calls.length, readCount);
      expect(find.text(historyGoal.title), findsNothing);
      expect(find.text(historyGoal.summary!), findsNothing);
      expect(find.byType(ConnectionDiagnosticsButton), findsOneWidget);
      await tester.tap(find.byTooltip(tr(Msg.exportExportFullText)));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip(tr(Msg.homeBackToResultHistory)));
      await tester.pumpAndSettle();
      expect(find.byType(ResultReaderPage), findsOneWidget);
      expect(find.text(tr(Msg.exportCopyFullText)), findsNothing);
      await tester.tap(find.byTooltip(tr(Msg.homeBackToResultHistory)));
      await tester.pumpAndSettle();
      expect(find.byType(ResultHistoryPage), findsOneWidget);
    },
  );

  testWidgets('shows empty history after a successful empty page', (
    tester,
  ) async {
    final controller = HistoryController(count: 0);
    await tester.pumpWidget(
      MaterialApp(
        home: ResultHistoryPage(controller: controller, goal: historyGoal),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(tr(Msg.homeNoResultHistory)), findsOneWidget);
    expect(find.text(tr(Msg.homeLoadMoreResults)), findsNothing);
  });

  testWidgets('retries a failed history page without erasing loaded entries', (
    tester,
  ) async {
    final controller = HistoryController()..failList = true;
    await tester.pumpWidget(
      MaterialApp(
        home: ResultHistoryPage(controller: controller, goal: historyGoal),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(tr(Msg.homeHistoryLoadFailed)), findsOneWidget);
    expect(find.text(tr(Msg.homeNoResultHistory)), findsNothing);
    controller.failList = false;
    await tester.tap(find.text(tr(Msg.commonRetry)));
    await tester.pumpAndSettle();
    controller.failMore = true;
    await tester.scrollUntilVisible(
      find.text(tr(Msg.homeLoadMoreResults)),
      600,
    );
    await tester.tap(find.text(tr(Msg.homeLoadMoreResults)));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('result-19')), findsOneWidget);
    expect(find.text(tr(Msg.homeHistoryLoadFailed)), findsOneWidget);
    controller.failMore = false;
    await tester.tap(find.text(tr(Msg.commonRetry)));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('result-23')),
      300,
    );
    expect(find.byKey(const ValueKey('result-23')), findsOneWidget);
    expect(controller.calls.last['cursor'], 'second-page');
    expect(find.text(tr(Msg.homeHistoryLoadFailed)), findsNothing);
  });

  testWidgets(
    'failed snapshot loads can retry and never use the latest preview',
    (tester) async {
      final controller = HistoryController()..failResult = true;
      await tester.pumpWidget(
        MaterialApp(
          home: ResultReaderPage(
            controller: controller,
            goal: historyGoal,
            resultId: 'result-previous',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(MessageBody), findsNothing);
      expect(
        tester
            .widget<IconButton>(
              find.ancestor(
                of: find.byTooltip(tr(Msg.exportExportFullText)),
                matching: find.byType(IconButton),
              ),
            )
            .onPressed,
        isNull,
      );
      controller.failResult = false;
      await tester.tap(find.text(tr(Msg.commonRetry)));
      await tester.pumpAndSettle();
      expect(
        tester.widget<MessageBody>(find.byType(MessageBody)).text,
        '# result-previous 正文\n\n完整 Markdown 内容。',
      );
      expect(controller.calls.map((call) => call['kind']), [
        'goal.result',
        'goal.result',
      ]);
    },
  );

  for (final supported in [true, false]) {
    testWidgets(
      'reader history visibility follows host capability $supported',
      (tester) async {
        final controller = HistoryController(supported: supported, count: 0);
        await tester.pumpWidget(
          MaterialApp(
            home: ResultReaderPage(controller: controller, goal: historyGoal),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byTooltip(tr(Msg.homeResultHistory)),
          supported ? findsOneWidget : findsNothing,
        );
        if (supported) {
          await tester.tap(find.byTooltip(tr(Msg.homeResultHistory)));
          await tester.pumpAndSettle();
          expect(find.byType(ResultHistoryPage), findsOneWidget);
        }
      },
    );

    testWidgets(
      'running goal history visibility follows host capability $supported',
      (tester) async {
        final controller = HistoryController(supported: supported, count: 0);
        controller.goalDetail = {
          'text': '当前任务',
          'goal': {'goalId': 'goal', 'status': 'RUNNING', 'title': '进行中的任务'},
        };
        controller.goalAgents = {'items': []};
        await tester.pumpWidget(
          MaterialApp(
            home: GoalDetailPage(controller: controller, initial: historyGoal),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.text(tr(Msg.homeResultHistory)),
          supported ? findsOneWidget : findsNothing,
        );
        if (supported) {
          await tester.tap(find.text(tr(Msg.homeResultHistory)));
          await tester.pumpAndSettle();
          expect(find.byType(ResultHistoryPage), findsOneWidget);
        }
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
