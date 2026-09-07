import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/app.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/goal_detail.dart';

class FakeRemoteController extends ChangeNotifier implements RemoteController {
  FakeRemoteController(this._state);

  final List<String> sentMessages = [];
  final List<String?> sentWorkbenches = [];
  final List<Map<String, String?>> actions = [];
  bool failSend = false;
  final RemoteViewState _state;

  @override
  RemoteViewState get state => _state;

  @override
  Future<void> connectFromQr(String payload) async {}

  @override
  Future<void> refresh() async {}

  @override
  Future<void> sendMessage(String text, {String? workbenchId}) async {
    if (failSend) throw StateError('offline');
    sentMessages.add(text);
    sentWorkbenches.add(workbenchId);
  }

  @override
  void setForeground(bool value) {}
  @override
  Future<void> act(
    String inputId,
    String action, {
    String? text,
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
  }) async {
    actions.add({
      'inputId': inputId,
      'action': action,
      'text': text,
      'workbenchId': workbenchId,
      'partnerId': partnerId,
      'actionChoice': actionChoice,
    });
  }

  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  }) async => switch (kind) {
    'goal.get' => {
      'text': '完整任务正文',
      'goal': {
        'goalId': goalId,
        'title': '任务一',
        'status': 'COMPLETED',
        'completionSummary': '完整结论',
        'artifacts': [
          {
            'name': '报告.md',
            'mimeType': 'text/markdown',
            'size': 1024,
            'kind': 'FILE',
          },
        ],
        'workbench': {'workbenchId': 'b', 'name': '研究'},
      },
    },
    'goal.agents' => {
      'items': [
        {'agentId': 'agent', 'partnerName': '研究搭档', 'status': 'COMPLETED'},
      ],
    },
    'agent.conversation' => {
      'agent': {'status': 'COMPLETED'},
      'items': [
        {
          'entryId': 'entry',
          'kind': 'MARKDOWN',
          'role': 'AGENT',
          'text': '完整搭档工作记录',
        },
      ],
    },
    _ => {},
  };
}

void main() {
  testWidgets('connected portrait shell renders task cards and sends text', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        path: RemoteConnectionPath.relay,
        goals: [
          RemoteGoalCard(
            activeWork: 2,
            completedWork: 1,
            status: 'RUNNING',
            title: '完成原生远程控制',
            totalWork: 3,
          ),
        ],
      ),
    );

    await tester.pumpWidget(JoiMobileApp(controller: controller));

    expect(find.text('joi'), findsOneWidget);
    expect(find.text('中继'), findsOneWidget);
    expect(find.text('完成原生远程控制'), findsOneWidget);
    expect(find.text('由 joi 判断'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
    expect(find.text('文件'), findsNothing);

    await tester.enterText(find.byType(TextField), '继续完成任务');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pump();

    expect(controller.sentMessages, ['继续完成任务']);
  });

  testWidgets('selects a workbench and preserves failed drafts', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        workbenches: [RemoteChoice('b', '研究工作台')],
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.tap(find.text('由 joi 判断'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('研究工作台'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '整理资料');
    controller.failSend = true;
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    expect(find.text('整理资料'), findsOneWidget);
    controller.failSend = false;
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    expect(controller.sentWorkbenches, ['b']);
    expect(controller.sentMessages, ['整理资料']);
  });

  testWidgets('opens goal detail and the goal-scoped partner record', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        goals: [
          RemoteGoalCard(
            goalId: 'g',
            title: '任务一',
            status: 'COMPLETED',
            activeWork: 0,
            completedWork: 1,
            totalWork: 1,
          ),
        ],
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.tap(find.text('任务一'));
    await tester.pumpAndSettle();
    expect(find.text('任务详情'), findsOneWidget);
    expect(find.text('完整任务正文', findRichText: true), findsOneWidget);
    expect(find.text('完整结论', findRichText: true), findsOneWidget);
    expect(find.text('报告.md'), findsOneWidget);
    await tester.ensureVisible(find.text('研究搭档'));
    await tester.tap(find.text('研究搭档'));
    await tester.pumpAndSettle();
    expect(find.text('完整搭档工作记录', findRichText: true), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'continues a finished goal and removes its card using its stable id',
    (tester) async {
      final controller = FakeRemoteController(
        const RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GoalActions(
              controller: controller,
              goal: const RemoteGoalCard(
                goalId: 'g',
                title: '任务',
                status: 'COMPLETED',
                canDelete: true,
                activeWork: 0,
                completedWork: 1,
                totalWork: 1,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('继续对话'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), '继续补证');
      await tester.tap(find.text('提交继续'));
      await tester.pump();
      expect(controller.actions.first, containsPair('action', 'retry'));
      expect(controller.actions.first, containsPair('text', '继续补证'));
      await tester.tap(find.text('移除卡片'));
      await tester.pump();
      expect(controller.actions.last, containsPair('action', 'dismiss'));
      expect(controller.actions.last, containsPair('inputId', 'g'));
    },
  );

  testWidgets('answers a partner question without creating a new message', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: GoalActions(
            controller: controller,
            goal: const RemoteGoalCard(
              goalId: 'g',
              title: '任务',
              status: 'NEEDS_ATTENTION',
              prompt: '请确认日期',
              reasonCode: 'question_required',
              activeWork: 0,
              completedWork: 0,
              totalWork: 1,
            ),
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), '上周');
    await tester.pump();
    await tester.tap(find.text('回答并继续'));
    await tester.pump();
    expect(controller.actions.single, containsPair('action', 'clarify'));
    expect(controller.actions.single, containsPair('text', '上周'));
    expect(controller.sentMessages, isEmpty);
  });

  testWidgets('unpaired device shows only the QR pairing entry', (
    tester,
  ) async {
    final controller = FakeRemoteController(const RemoteViewState());
    await tester.pumpWidget(JoiMobileApp(controller: controller));

    expect(find.text('扫描二维码绑定 Joi'), findsOneWidget);
    expect(find.text('输入连接码'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });
}
