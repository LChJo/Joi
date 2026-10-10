import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/app.dart';
import 'package:joi_mobile/archived_goals.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/goal_detail.dart';

class FakeRemoteController extends ChangeNotifier implements RemoteController {
  FakeRemoteController(this._state);

  final List<String> sentMessages = [];
  final List<String?> sentWorkbenches = [];
  final List<Map<String, Object?>> actions = [];
  final List<Map<String, String>> createdWorkbenches = [];
  bool failSend = false;
  Map<String, dynamic>? goalDetail;
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

  /// Whether the host also bound the input to the workbench it just created. Real hosts say no
  /// when the card moved on, which the screen has to survive.
  bool createBinds = true;

  @override
  Future<RemoteWorkbenchCreation> createWorkbench({
    required String inputId,
    required String name,
    required String personaSummary,
    required String projectLabel,
    required String scopeSummary,
  }) async {
    createdWorkbenches.add({
      'inputId': inputId,
      'name': name,
      'personaSummary': personaSummary,
      'projectLabel': projectLabel,
      'scopeSummary': scopeSummary,
    });
    return RemoteWorkbenchCreation('workbench-new', name, bound: createBinds);
  }

  @override
  void setForeground(bool value) {}

  /// Set to make the next action fail the way the real controller does.
  Object? actError;
  @override
  Future<void> act(
    String inputId,
    String action, {
    String? text,
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
    String? questionId,
    int? questionVersion,
  }) async {
    final failure = actError;
    if (failure != null) throw failure;
    actions.add({
      'inputId': inputId,
      'action': action,
      'text': text,
      'workbenchId': workbenchId,
      'partnerId': partnerId,
      'actionChoice': actionChoice,
      'questionId': questionId,
      'questionVersion': questionVersion,
    });
  }

  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  }) async => switch (kind) {
    'goal.get' =>
      goalDetail ??
          {
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

/// Every per-card action lives in the card's 「更多操作」 sheet, so a test that exercises one has to
/// open the sheet and pick the row first.
Future<void> tapGoalAction(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('更多操作'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'reconnecting offers diagnostics instead of a misleading empty feed',
    (tester) async {
      final controller = FakeRemoteController(
        const RemoteViewState(connection: RemoteConnectionState.reconnecting),
      );
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      expect(find.byTooltip('连接诊断 · 重连中'), findsOneWidget);
      expect(find.text('暂时没有任务，和 joi 说点什么吧。'), findsNothing);
      await tester.tap(find.byTooltip('连接诊断 · 重连中'));
      await tester.pumpAndSettle();
      expect(find.textContaining('remote-diag-3'), findsOneWidget);
      expect(find.text('复制诊断'), findsOneWidget);
    },
  );
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

    final semantics = tester.ensureSemantics();
    try {
      expect(find.bySemanticsLabel('joi'), findsOneWidget);
    } finally {
      semantics.dispose();
    }
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
      await tapGoalAction(tester, '继续对话');
      await tester.enterText(find.byType(TextField), '继续补证');
      await tester.tap(find.text('提交继续'));
      await tester.pump();
      expect(controller.actions.first, containsPair('action', 'retry'));
      expect(controller.actions.first, containsPair('text', '继续补证'));
      await tapGoalAction(tester, '移除卡片');
      expect(controller.actions.last, containsPair('action', 'dismiss'));
      expect(controller.actions.last, containsPair('inputId', 'g'));
    },
  );

  testWidgets('archives a finished goal from the card menu', (tester) async {
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
              title: '可归档的任务',
              status: 'COMPLETED',
              canArchive: true,
              canDelete: false,
              activeWork: 0,
              completedWork: 1,
              totalWork: 1,
            ),
          ),
        ),
      ),
    );
    // A failed goal with work behind it has no finalized outcome, so removal stays out of reach and
    // archiving is the action that takes it off the feed.
    await tester.tap(find.byTooltip('更多操作'));
    await tester.pumpAndSettle();
    expect(find.text('移除卡片'), findsNothing);
    await tester.tap(find.text('归档'));
    await tester.pumpAndSettle();
    expect(controller.actions.last, containsPair('action', 'archive'));
    expect(controller.actions.last, containsPair('inputId', 'g'));
  });

  testWidgets('offers only cancellation on a running goal card', (tester) async {
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
              title: '在途的任务',
              status: 'RUNNING',
              activeWork: 1,
              completedWork: 0,
              totalWork: 1,
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('更多操作'));
    await tester.pumpAndSettle();
    expect(find.text('取消任务'), findsOneWidget);
    expect(find.text('归档'), findsNothing);
    expect(find.text('移除卡片'), findsNothing);
  });

  testWidgets('shows archived cards with the way back to the feed', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        archivedGoals: [
          RemoteGoalCard(
            goalId: 'archived-1',
            title: '收起来的目标',
            status: 'COMPLETED',
            workbenchName: '归档工程',
            archivedAt: '2026-10-09T09:00:00.000Z',
            canArchive: true,
            canDelete: true,
            activeWork: 0,
            completedWork: 1,
            totalWork: 1,
          ),
        ],
      ),
    );
    await tester.pumpWidget(
      MaterialApp(home: ArchivedGoalsPage(controller: controller)),
    );
    expect(find.text('收起来的目标'), findsOneWidget);
    expect(find.text('归档工程'), findsOneWidget);
    // A filed-away card is the compact shape: the progress bar and the Work counts would only make
    // a list of things put away harder to scan, and the 归档 time takes their place.
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(
      find.text(
        '${DateTime.parse('2026-10-09T09:00:00.000Z').toLocal()} 归档',
      ),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('更多操作'));
    await tester.pumpAndSettle();
    expect(find.text('取消归档'), findsOneWidget);
    expect(find.text('继续对话'), findsOneWidget);
    expect(find.text('移除卡片'), findsOneWidget);
    expect(find.text('归档'), findsNothing);
    await tester.tap(find.text('取消归档'));
    await tester.pumpAndSettle();
    expect(controller.actions.last, containsPair('action', 'unarchive'));
  });

  testWidgets('an empty archive says where archived cards come from', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(connection: RemoteConnectionState.connected),
    );
    await tester.pumpWidget(
      MaterialApp(home: ArchivedGoalsPage(controller: controller)),
    );
    expect(find.textContaining('还没有归档的目标'), findsOneWidget);
  });

  testWidgets('names the refusal instead of one sentence for every cause', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
      ),
    )..actError = const RemoteActionFailure('joi_clarification_unavailable');
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
    await tapGoalAction(tester, '继续对话');
    await tester.enterText(find.byType(TextField), '继续补证');
    await tester.tap(find.text('提交继续'));
    await tester.pump();

    // The host's reason reaches the screen, and the draft survives so it can be retried — a
    // failure that clears the input is a failure the user has to type out again.
    expect(find.textContaining('已经不需要回答'), findsOneWidget);
    expect(find.textContaining('操作未确认'), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '继续补证',
    );
  });

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

  Future<void> pumpWorkbenchCard(
    WidgetTester tester,
    FakeRemoteController controller, {
    String title = '调试 AI 应用',
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: GoalActions(
          controller: controller,
          goal: RemoteGoalCard(
            goalId: 'g',
            title: title,
            status: 'NEEDS_ATTENTION',
            reasonCode: 'workbench_selection_invalid',
            activeWork: 0,
            completedWork: 0,
            totalWork: 0,
          ),
        ),
      ),
    ),
  );

  testWidgets(
    'offers abstract clusters instead of a workbench named after the input',
    (tester) async {
      final controller = FakeRemoteController(
        const RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          supportsWorkbenchCreation: true,
          workbenches: [RemoteChoice('existing', '已有工作台', '已有范围')],
        ),
      );
      await pumpWorkbenchCard(tester, controller);

      await tester.tap(find.text('归到哪里'));
      await tester.pumpAndSettle();
      expect(find.text('调试 AI 应用 工作台'), findsNothing);
      expect(find.text('调研与分析工坊'), findsOneWidget);
      expect(find.text('工程开发与调试工坊'), findsOneWidget);
      expect(find.text('行程与出行规划工坊'), findsOneWidget);

      await tester.tap(find.text('调研与分析工坊'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches.single['projectLabel'], '调研与分析');
      // Creation and binding are one request now; a second clarify is what used to strand the card.
      expect(controller.actions, isEmpty);
      expect(find.textContaining('已创建，但'), findsNothing);
    },
  );

  testWidgets('reuses an existing workbench instead of creating one', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        supportsWorkbenchCreation: true,
        workbenches: [
          RemoteChoice('existing', '皖南川藏线片区景点调研环境', '皖南川藏线的景点资料整理与出行信息比较。'),
        ],
      ),
    );
    await pumpWorkbenchCard(
      tester,
      controller,
      title: '皖南川藏线民宿周边哪些景点值得去，要不要门票',
    );

    await tester.tap(find.text('归到哪里'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('皖南川藏线片区景点调研环境'));
    await tester.pumpAndSettle();

    expect(controller.createdWorkbenches, isEmpty);
    expect(controller.actions.single, containsPair('workbenchId', 'existing'));
  });

  testWidgets('reports an unbound workbench instead of a dead end', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        supportsWorkbenchCreation: true,
      ),
    )..createBinds = false;
    await pumpWorkbenchCard(tester, controller, title: '移动端任务');

    await tester.tap(find.text('归到哪里'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('调研与分析工坊'));
    await tester.pumpAndSettle();

    expect(find.textContaining('调研与分析工坊'), findsWidgets);
    expect(find.textContaining('选择工作台继续'), findsWidgets);
  });

  testWidgets(
    'reuses the workbench it already created instead of minting a duplicate',
    (tester) async {
      final controller = FakeRemoteController(
        const RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          supportsWorkbenchCreation: true,
        ),
      )..createBinds = false;
      await pumpWorkbenchCard(tester, controller, title: '移动端任务');

      await tester.tap(find.text('归到哪里'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('调研与分析工坊'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('归到哪里'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('调研与分析工坊'));
      await tester.pumpAndSettle();

      expect(controller.createdWorkbenches, hasLength(1));
      expect(
        controller.actions.single,
        containsPair('workbenchId', 'workbench-new'),
      );
    },
  );

  testWidgets('reads the question a flat clarification card advertises', (
    tester,
  ) async {
    // The unassigned-action shape puts questionId at the top level; the nested `clarification`
    // object only exists on goal cards.
    final card = RemoteGoalCard.fromJson(const {
      'inputId': 'input-1',
      'status': 'CLARIFICATION_REQUIRED',
      'textPreview': '移动端任务',
      'questionId': 'goal_question:input-1:v1',
      'questionVersion': 1,
    });
    expect(card.questionId, 'goal_question:input-1:v1');
    expect(card.questionVersion, 1);
  });

  testWidgets('answers a goal continuation with the question the card advertised', (
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
              prompt: '已自动补充两轮，当前结果仍有明确缺口。',
              reasonCode: 'goal_continuation_required',
              questionId: 'goal_question:g:v1',
              questionVersion: 1,
              activeWork: 0,
              completedWork: 0,
              totalWork: 1,
            ),
          ),
        ),
      ),
    );
    expect(find.text('是否继续完善结果？'), findsOneWidget);
    expect(find.text('已自动补充两轮，当前结果仍有明确缺口。'), findsNothing);
    expect(
      find.text('当前结果仍有内容需要补充或核实。自动补充已达到本次上限，joi 已暂停，等待你决定是否继续。'),
      findsOneWidget,
    );
    expect(find.text('当前结果与待补充内容'), findsOneWidget);
    expect(find.text('暂时没有可展示的结果说明，无法列出具体待补充内容。'), findsOneWidget);
    expect(find.text('继续完善：再尝试最多两轮补充；仍有未解决事项时会再次询问你。'), findsOneWidget);
    expect(
      find.text('保留当前结果：结束本次任务，保存已有结论和未解决事项，标记为“已完成（有缺口）”。'),
      findsOneWidget,
    );
    await tester.tap(find.text('继续完善'));
    await tester.pump();
    // The server refuses to resolve a clarification whose question does not match the card it is
    // answering, so a decision sent without these came back as joi_clarification_unavailable.
    expect(
      controller.actions.single,
      containsPair('questionId', 'goal_question:g:v1'),
    );
    expect(controller.actions.single, containsPair('questionVersion', 1));
    expect(controller.actions.single, containsPair('actionChoice', 'CONTINUE'));
    await tester.tap(find.text('保留当前结果'));
    await tester.pump();
    expect(
      controller.actions.last,
      containsPair('actionChoice', 'ACCEPT_CURRENT'),
    );
    expect(
      controller.actions.last,
      containsPair('questionId', 'goal_question:g:v1'),
    );
    expect(controller.actions.last, containsPair('questionVersion', 1));
  });

  testWidgets(
    'shows continuation context once on a narrow home card and opens its current result',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = FakeRemoteController(
        const RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          goals: [
            RemoteGoalCard(
              goalId: 'g',
              title: '任务',
              status: 'NEEDS_ATTENTION',
              reasonCode: 'goal_continuation_required',
              summary: '横评维度已建立，但近七天来源不足。',
              activeWork: 0,
              completedWork: 3,
              totalWork: 3,
            ),
          ],
        ),
      );
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      await tester.pumpAndSettle();
      expect(find.text('横评维度已建立，但近七天来源不足。'), findsOneWidget);
      expect(find.text('当前结果与待补充内容'), findsOneWidget);
      await tester.ensureVisible(find.text('查看当前结果全文'));
      await tester.tap(find.text('查看当前结果全文'));
      await tester.pumpAndSettle();
      expect(find.text('当前结果'), findsOneWidget);
      expect(find.text('完整结论'), findsOneWidget);
      expect(find.byTooltip('导出全文'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('keeps continuation detail separate from a final result', (
    tester,
  ) async {
    const summary = '横评维度已建立，但近七天来源不足。';
    final controller =
        FakeRemoteController(
            const RemoteViewState(
              connection: RemoteConnectionState.connected,
              supportsHome: true,
            ),
          )
          ..goalDetail = {
            'text': '完整任务正文',
            'goal': {
              'goalId': 'g',
              'title': '任务',
              'status': 'NEEDS_ATTENTION',
              'completionSummary': summary,
              'clarification': {'reasonCode': 'goal_continuation_required'},
            },
          };
    await tester.pumpWidget(
      MaterialApp(
        home: GoalDetailPage(
          controller: controller,
          initial: const RemoteGoalCard(
            goalId: 'g',
            title: '任务',
            status: 'NEEDS_ATTENTION',
            reasonCode: 'goal_continuation_required',
            summary: summary,
            activeWork: 0,
            completedWork: 3,
            totalWork: 3,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('当前结果与待补充内容'), findsOneWidget);
    expect(find.text(summary), findsOneWidget);
    expect(find.text('最终结果 · 查看全文'), findsNothing);
    await tester.pumpWidget(const SizedBox());
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
