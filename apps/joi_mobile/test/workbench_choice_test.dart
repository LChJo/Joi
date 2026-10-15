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
    'automatically offers an editable persisted proposal and can reopen after dismissal',
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
      await tester.tap(find.text('新建工作台'));
      await tester.pumpAndSettle();
      expect(find.text('joi 工程维护工坊'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextField, 'joi 工程维护工坊'),
        '我的工程工坊',
      );
      await tester.ensureVisible(find.text('创建并继续'));
      await tester.tap(find.text('创建并继续'));
      await tester.pumpAndSettle();
      expect(controller.createdWorkbenches.single['name'], '我的工程工坊');
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
}
