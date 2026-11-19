import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/user_question_card.dart';
import 'package:joi_mobile/goal_detail.dart';

Map<String, dynamic> questionJson({
  String status = 'ACTIVE',
  int version = 1,
}) => {
  'questionId': 'q1',
  'version': version,
  'scope': {'kind': 'CONVERSATION', 'id': 'chat'},
  'sourceName': 'Research partner',
  'question': 'Which approach?',
  'kind': 'QUESTION',
  'status': status,
  'delivery': 'PENDING',
  'options': [
    {'id': 'existing', 'label': 'Use existing', 'recommended': true},
    {'id': 'fresh', 'label': 'Start fresh'},
  ],
  'multiSelect': false,
  'allowCustom': true,
  'defaultAnswer': 'Keep current structure.',
  'defaultOptionIds': ['existing'],
  'expiresAt': DateTime.now()
      .add(const Duration(minutes: 30))
      .toIso8601String(),
};

class GoalQuestionPeer extends PlaceholderRemoteController
    implements QuestionRemoteController {
  final answers = <Map<String, Object?>>[];
  @override
  RemoteViewState get state =>
      const RemoteViewState(connection: RemoteConnectionState.connected);
  @override
  bool get supportsQuestions => true;
  @override
  Future<Map<String, dynamic>> answerQuestion(
    String scopeKind,
    String scopeId,
    String questionId,
    Map<String, Object?> input,
  ) async {
    answers.add({
      'scopeKind': scopeKind,
      'scopeId': scopeId,
      'questionId': questionId,
      'input': input,
    });
    return {};
  }
}

void main() {
  setUp(() => uiLocale.setForTest('en'));
  Future<void> show(
    WidgetTester tester,
    Map<String, dynamic> json,
    Future<void> Function(Map<String, Object?>) answer, {
    bool supported = true,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: UserQuestionCard(
              question: RemoteUserQuestion.fromJson(json),
              supported: supported,
              onAnswer: answer,
            ),
          ),
        ),
      ),
    );
  }

  test(
    'goal question DTO retains queue and receipt through archive projection',
    () {
      final raw = questionJson(status: 'ANSWERED')
        ..['answer'] = {
          'text': 'Recorded',
          'source': 'TIMEOUT_DEFAULT',
          'selectedOptionIds': ['existing'],
          'answeredAt': '2026-11-19T00:00:00Z',
        };
      final goal = RemoteGoalCard.fromJson({
        'goalId': 'goal',
        'questions': [raw],
      });
      expect(goal.questions.single.answer?['source'], 'TIMEOUT_DEFAULT');
      expect(
        goal.withArchivedAt('2026-11-19').questions.single.questionId,
        'q1',
      );
    },
  );

  testWidgets(
    'active card answers once and retains selected and custom drafts on failure',
    (tester) async {
      final calls = <Map<String, Object?>>[];
      final pending = Completer<void>();
      await show(tester, questionJson(), (input) {
        calls.add(input);
        return pending.future;
      });
      expect(find.text('Research partner'), findsNothing);
      expect(find.text('From Research partner'), findsOneWidget);
      expect(find.text('Keep current structure.'), findsOneWidget);
      await tester.tap(find.text('Start fresh'));
      await tester.enterText(find.byType(TextField), 'My answer');
      final submit = find.text('Submit and continue');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.tap(submit);
      expect(calls, [
        {
          'version': 1,
          'selectedOptionIds': ['fresh'],
          'text': 'My answer',
        },
      ]);
      pending.completeError(StateError('SECRET'));
      await tester.pump();
      expect(find.textContaining('Your draft is kept'), findsOneWidget);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'My answer',
      );
    },
  );

  testWidgets('multi-select sends selected ids with custom details', (
    tester,
  ) async {
    Map<String, Object?>? answer;
    final json = questionJson()..['multiSelect'] = true;
    await show(tester, json, (input) async {
      answer = input;
    });
    await tester.tap(find.widgetWithText(CheckboxListTile, 'Use existing'));
    await tester.tap(find.text('Start fresh'));
    await tester.enterText(find.byType(TextField), 'Details');
    final button = find.text('Submit and continue');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pump();
    expect(answer, {
      'version': 1,
      'selectedOptionIds': ['existing', 'fresh'],
      'text': 'Details',
    });
  });

  testWidgets('expired deadline never auto-answers or allows another submit', (
    tester,
  ) async {
    final json = questionJson()
      ..['expiresAt'] = DateTime.now()
          .subtract(const Duration(seconds: 1))
          .toIso8601String();
    await show(tester, json, (_) async => fail('expired answer'));
    expect(
      find.text(
        'The answer window has ended. Waiting for confirmation of the default answer.',
      ),
      findsOneWidget,
    );
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, false);
  });

  testWidgets('adopts default without sending local draft', (tester) async {
    Map<String, Object?>? answer;
    await show(tester, questionJson(), (input) async {
      answer = input;
    });
    await tester.enterText(find.byType(TextField), 'Unsent');
    final button = find.text('Use recommendation and continue');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pump();
    expect(answer, {'version': 1, 'useDefault': true});
    expect(
      find.text('Answer submitted. Waiting for the updated question status.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'queued question is visible but never has an active timer or answer field',
    (tester) async {
      await show(
        tester,
        questionJson(status: 'QUEUED'),
        (_) async => fail('queued answer'),
      );
      expect(find.text('Which approach?'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.textContaining('Time remaining'), findsNothing);
      expect(
        find.text(
          'Queued. The timer starts when this question becomes active.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'recorded timeout answer and interrupted delivery remain visible and closed',
    (tester) async {
      final json = questionJson(status: 'ANSWERED')
        ..['delivery'] = 'INTERRUPTED'
        ..['answer'] = {
          'text': 'Recorded default',
          'source': 'TIMEOUT_DEFAULT',
          'selectedOptionIds': ['existing'],
          'answeredAt': '2026-11-19T00:00:00Z',
        };
      await show(tester, json, (_) async => fail('terminal answer'));
      expect(find.text('Recorded default'), findsOneWidget);
      expect(find.text('Default answer used after timeout'), findsOneWidget);
      expect(
        find.textContaining('will not be resent automatically'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
    },
  );

  testWidgets('old receipts cannot overwrite a new version draft', (
    tester,
  ) async {
    final pending = Completer<void>();
    await show(tester, questionJson(), (_) => pending.future);
    final button = find.text('Use recommendation and continue');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await show(tester, questionJson(version: 2), (_) async {});
    await tester.enterText(find.byType(TextField), 'New draft');
    pending.completeError(StateError('old'));
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'New draft',
    );
    expect(find.textContaining('Your draft is kept'), findsNothing);
  });

  testWidgets(
    'old hosts show an explicit capability notice and disable answers',
    (tester) async {
      await show(
        tester,
        questionJson(),
        (_) async => fail('unsupported'),
        supported: false,
      );
      expect(
        find.textContaining('does not support remote question answers'),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, false);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
    },
  );

  testWidgets(
    'keyboard keeps Enter multiline and prevents submit while composing',
    (tester) async {
      final calls = <Map<String, Object?>>[];
      await show(tester, questionJson(), (input) async {
        calls.add(input);
      });
      await tester.enterText(find.byType(TextField), 'Line one\nLine two');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(calls, isEmpty);
      final field = tester.widget<TextField>(find.byType(TextField));
      field.controller!.value = const TextEditingValue(
        text: 'compose',
        composing: TextRange(start: 0, end: 7),
      );
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      expect(calls, isEmpty);
      field.controller!.value = const TextEditingValue(text: 'Ready');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(calls.single['text'], 'Ready');
    },
  );

  testWidgets(
    'explicit interrupted resume locks during submission and permits a retry',
    (tester) async {
      final pending = Completer<void>();
      var resumes = 0;
      final json = questionJson(status: 'ANSWERED')
        ..['delivery'] = 'INTERRUPTED'
        ..['answer'] = {
          'text': 'Saved answer',
          'source': 'USER',
          'selectedOptionIds': [],
          'answeredAt': '2026-11-19T00:00:00Z',
        };
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: UserQuestionCard(
              question: RemoteUserQuestion.fromJson(json),
              supported: true,
              onAnswer: (_) async => fail('must not resend answer'),
              onResume: () {
                resumes++;
                return pending.future;
              },
            ),
          ),
        ),
      );
      final button = find.text(tr(Msg.chatQuestionResumeSaved));
      expect(button, findsOneWidget);
      await tester.tap(button);
      await tester.tap(button);
      expect(resumes, 1);
      pending.complete();
      await tester.pump();
      expect(
        tester.widget<OutlinedButton>(find.byType(OutlinedButton)).onPressed,
        isNotNull,
      );
      await tester.tap(button);
      expect(resumes, 2);
    },
  );

  testWidgets(
    'unanswered interruption explicitly offers the visible default rather than claiming a saved answer',
    (tester) async {
      var resumes = 0;
      final json = questionJson()..['delivery'] = 'INTERRUPTED';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: UserQuestionCard(
              question: RemoteUserQuestion.fromJson(json),
              supported: true,
              onAnswer: (_) async => fail('must not send a hidden answer'),
              onResume: () async {
                resumes++;
              },
            ),
          ),
        ),
      );
      expect(find.text('Keep current structure.'), findsOneWidget);
      expect(find.text(tr(Msg.chatQuestionResumeSaved)), findsNothing);
      final button = find.text('Use the default and resume');
      expect(button, findsOneWidget);
      await tester.tap(button);
      await tester.pump();
      expect(resumes, 1);
    },
  );

  testWidgets('a withdrawn interrupted card offers no recovery action', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UserQuestionCard(
            question: RemoteUserQuestion.fromJson(
              questionJson(status: 'CANCELED')..['delivery'] = 'INTERRUPTED',
            ),
            supported: true,
            onAnswer: (_) async => fail('must not answer a withdrawn question'),
            onResume: () async => fail('must not resume a withdrawn question'),
          ),
        ),
      ),
    );
    expect(find.text('Use the default and resume'), findsNothing);
  });

  testWidgets(
    'goal actions have one question input and preserve independent workbench controls',
    (tester) async {
      final peer = GoalQuestionPeer();
      addTearDown(peer.dispose);
      RemoteGoalCard goal(String reason) => RemoteGoalCard.fromJson({
        'goalId': 'goal',
        'status': 'NEEDS_ATTENTION',
        'clarification': {'reasonCode': reason, 'prompt': 'Legacy prompt'},
        'questions': [questionJson()],
      });
      Future<void> renderGoal(String reason) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: GoalActions(controller: peer, goal: goal(reason)),
            ),
          ),
        ),
      );
      await renderGoal('question_required');
      expect(find.byType(TextField), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).minLines, 2);
      expect(find.text('Legacy prompt'), findsNothing);
      final button = find.text(tr(Msg.chatQuestionUseDefault));
      await tester.ensureVisible(button);
      await tester.tap(button);
      await tester.pump();
      expect(peer.answers.single, {
        'scopeKind': 'GOAL',
        'scopeId': 'goal',
        'questionId': 'q1',
        'input': {'version': 1, 'useDefault': true},
      });
      await renderGoal('workbench_selection_invalid');
      expect(find.text('Legacy prompt'), findsOneWidget);
      expect(
        find.text(tr(Msg.mobileChooseAWorkbenchToContinue)),
        findsOneWidget,
      );
    },
  );

  testWidgets('goal feed actions omit answered questions', (tester) async {
    final peer = GoalQuestionPeer();
    addTearDown(peer.dispose);
    final answered = questionJson(status: 'ANSWERED')
      ..['delivery'] = 'DELIVERED'
      ..['answer'] = {
        'text': 'Recorded goal answer',
        'source': 'USER',
        'answeredAt': '2026-11-19T00:00:00Z',
      };
    final goal = RemoteGoalCard.fromJson({
      'goalId': 'goal',
      'status': 'COMPLETED',
      'questions': [answered],
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: GoalActions(controller: peer, goal: goal),
        ),
      ),
    );
    expect(find.text('Which approach?'), findsNothing);
    expect(find.text('Recorded goal answer'), findsNothing);
  });

  testWidgets('320px light and dark layouts fit without overflowing', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final brightness in [Brightness.light, Brightness.dark]) {
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(brightness: brightness),
          home: Scaffold(
            body: SingleChildScrollView(
              child: UserQuestionCard(
                question: RemoteUserQuestion.fromJson(questionJson()),
                supported: true,
                onAnswer: (_) async {},
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      final button = find.byType(FilledButton);
      await tester.ensureVisible(button);
      expect(tester.getSize(button).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(button).width, lessThanOrEqualTo(320));
    }
  });
}
