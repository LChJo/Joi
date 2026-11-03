import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/app.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'widget_test.dart' show FakeRemoteController;

void main() {
  test(
    'optional proposals reject malformed data and keep only public labels',
    () {
      for (final value in [
        null,
        1,
        [],
        {},
        {'name': 'x'},
        {'name': '', 'projectLabel': 'joi', 'scopeSummary': 'scope'},
      ]) {
        expect(RemoteWorkbenchProposal.fromJson(value), isNull);
      }
      final draft = RemoteWorkbenchProposal.fromJson({
        'name': 'joi 工坊',
        'projectLabel': 'joi',
        'scopeSummary': '工程维护。',
        'personaSummary': 'PRIVATE',
      });
      expect(draft?.name, 'joi 工坊');
    },
  );

  testWidgets('dismisses the old choice when another client has resolved it', (
    tester,
  ) async {
    final goals = [
      RemoteGoalCard.fromJson({
        'inputId': 'choice',
        'status': 'CLARIFICATION_REQUIRED',
        'textPreview': '维护工程',
        'clarificationReasonCode': 'workbench_selection_invalid',
        'questionId': 'q1',
        'questionVersion': 1,
      }),
    ];
    final controller = FakeRemoteController(
      RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        supportsWorkbenchCreation: true,
        goals: goals,
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('选择工作台'), findsOneWidget);
    goals[0] = const RemoteGoalCard(
      goalId: 'choice',
      title: '维护工程',
      status: 'ARRANGING',
      activeWork: 0,
      completedWork: 0,
      totalWork: 0,
    );
    controller.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('选择工作台'), findsNothing);
  });
  testWidgets(
    'offers two prepared options and creates the persisted proposal in one tap after reopening',
    (tester) async {
      final controller = FakeRemoteController(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          supportsWorkbenchCreation: true,
          goals: [
            RemoteGoalCard.fromJson({
              'inputId': 'choice',
              'status': 'CLARIFICATION_REQUIRED',
              'textPreview': '维护工程文档',
              'clarificationReasonCode': 'workbench_selection_invalid',
              'questionId': 'q1',
              'questionVersion': 1,
              'workbenchProposal': {
                'name': 'joi 工程维护工坊',
                'projectLabel': 'joi',
                'scopeSummary': '源码及文档维护。',
              },
            }),
          ],
        ),
      );
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      await tester.pumpAndSettle();
      expect(find.text('选择工作台'), findsOneWidget);
      await tester.tap(find.text('稍后选择'));
      await tester.pumpAndSettle();
      expect(find.text('选择工作台'), findsNothing);
      controller.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.text('选择工作台'), findsNothing);
      await tester.tap(find.text('选择工作台继续'));
      await tester.pumpAndSettle();
      expect(find.text('joi 工程维护工坊'), findsOneWidget);
      expect(find.text('创建并继续'), findsOneWidget);
      expect(find.text('手动新建'), findsOneWidget);
      expect(find.text('新建工作台'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      expect(controller.createdWorkbenches, isEmpty);
      await tester.ensureVisible(find.text('joi 工程维护工坊'));
      await tester.tap(find.text('joi 工程维护工坊'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches.single['name'], 'joi 工程维护工坊');
      expect(controller.createdWorkbenches.single['projectLabel'], 'joi');
      expect(controller.actions, isEmpty);
    },
  );

  testWidgets('uses a composer workbench for one successful send', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        workbenches: [RemoteChoice('b', '工程')],
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.tap(find.text('由 joi 判断'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工程'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '第一条');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '第二条');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pumpAndSettle();
    expect(controller.sentWorkbenches, ['b', null]);
  });

  testWidgets(
    'keeps the prepared choice and idempotency key on retry at phone width',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = FakeRemoteController(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          supportsWorkbenchCreation: true,
          goals: [
            RemoteGoalCard.fromJson({
              'inputId': 'retry',
              'status': 'CLARIFICATION_REQUIRED',
              'textPreview': '工程开发与调试',
              'clarificationReasonCode': 'workbench_selection_invalid',
              'questionId': 'retry-question',
              'questionVersion': 3,
            }),
          ],
        ),
      )..createError = StateError('PRIVATE_TRANSPORT_DETAIL');
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('工程开发与调试工坊'));
      await tester.tap(find.text('工程开发与调试工坊'));
      await tester.pumpAndSettle();
      expect(find.textContaining('PRIVATE_TRANSPORT_DETAIL'), findsNothing);
      expect(find.text('创建并继续'), findsOneWidget);
      controller.createError = null;
      await tester.ensureVisible(find.text('工程开发与调试工坊'));
      await tester.tap(find.text('工程开发与调试工坊'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches, hasLength(2));
      expect(
        controller.createdWorkbenches[0],
        controller.createdWorkbenches[1],
      );
      expect(
        controller.createdWorkbenches[1]['idempotencyKey'],
        'workbench-choice:retry:v3:option:0',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('does not offer creation options without host support', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
        goals: [
          RemoteGoalCard.fromJson({
            'inputId': 'legacy',
            'status': 'CLARIFICATION_REQUIRED',
            'clarificationReasonCode': 'workbench_not_found',
          }),
        ],
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('选择工作台'), findsOneWidget);
    expect(find.text('创建并继续'), findsNothing);
    expect(find.text('选择新工作台方案'), findsNothing);
    expect(controller.createdWorkbenches, isEmpty);
  });

  testWidgets(
    'manual creation opens a blank form, keeps edits and retries the same bound draft',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = FakeRemoteController(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          supportsWorkbenchCreation: true,
          goals: [
            RemoteGoalCard.fromJson({
              'inputId': 'manual',
              'status': 'CLARIFICATION_REQUIRED',
              'clarificationReasonCode': 'workbench_selection_invalid',
              'questionId': 'q-manual',
              'questionVersion': 2,
            }),
          ],
        ),
      )..createError = StateError('PRIVATE');
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('手动新建'));
      await tester.tap(find.text('手动新建'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches, isEmpty);
      Finder field(String label) => find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.labelText == label,
      );
      expect(
        (tester.widget<TextField>(field('工作台名称')).controller!).text,
        isEmpty,
      );
      await tester.enterText(field('工作台名称'), '自建工坊');
      await tester.enterText(field('工程名称'), 'joi');
      await tester.enterText(field('工作范围'), '源码维护。');
      await tester.ensureVisible(find.text('返回选择'));
      await tester.tap(find.text('返回选择'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('手动新建'));
      await tester.tap(find.text('手动新建'));
      await tester.pumpAndSettle();
      expect(
        (tester.widget<TextField>(field('工作台名称')).controller!).text,
        '自建工坊',
      );
      await tester.ensureVisible(find.text('创建并继续'));
      await tester.tap(find.text('创建并继续'));
      await tester.pumpAndSettle();
      expect(
        (tester.widget<TextField>(field('工作台名称')).controller!).text,
        '自建工坊',
      );
      controller.createError = null;
      await tester.ensureVisible(find.text('创建并继续'));
      await tester.tap(find.text('创建并继续'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches, hasLength(2));
      expect(
        controller.createdWorkbenches.first,
        controller.createdWorkbenches.last,
      );
      expect(
        controller.createdWorkbenches.last['idempotencyKey'],
        'workbench-choice:manual:v2:manual',
      );
      expect(controller.createdWorkbenches.last['name'], '自建工坊');
      expect(controller.actions, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
}
