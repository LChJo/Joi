import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:joi_mobile/app.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:joi_mobile/goal_detail.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'widget_test.dart' show FakeRemoteController;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('AC-I18N-02 resolves system and explicit preferences', () {
    expect(resolveUiLocale('system', [const Locale('zh', 'TW')]), 'zh-CN');
    expect(resolveUiLocale('system', [const Locale('fr')]), 'en');
    expect(resolveUiLocale('en', [const Locale('zh')]), 'en');
    expect(resolveUiLocale('removed', [const Locale('zh')]), 'zh-CN');
  });
  test('AC-I18N-01 formats shared plural resources', () {
    uiLocale.setForTest('en');
    expect(tr(Msg.commonItemCount, {'count': 1}), '1 item');
    expect(tr(Msg.commonItemCount, {'count': 2}), '2 items');
    uiLocale.setForTest('zh-CN');
    expect(tr(Msg.commonItemCount, {'count': 2}), '2 项');
  });
  test('AC-I18N-03 reformats an existing action refusal', () {
    uiLocale.setForTest('en');
    final notice = actFailureMessage(
      const RemoteActionFailure('something_new'),
    );
    expect(noticeText(notice), contains('declined'));
    uiLocale.setForTest('zh-CN');
    expect(noticeText(notice), contains('没有接受'));
    expect(noticeText(notice), contains('something_new'));
  });
  testWidgets(
    'AC-I18N-05 translates missing card labels and preserves real names',
    (tester) async {
      uiLocale.setForTest('en');
      final controller = FakeRemoteController(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          supportsHome: true,
          goals: [
            RemoteGoalCard.fromJson({'goalId': 'missing'}),
            RemoteGoalCard.fromJson({
              'goalId': 'named',
              'title': '待确认的输入',
              'workbench': {'name': '等待归属'},
            }),
          ],
        ),
      );
      await tester.pumpWidget(JoiMobileApp(controller: controller));
      await tester.pumpAndSettle();
      expect(find.text('Awaiting assignment'), findsOneWidget);
      expect(find.text('Input awaiting confirmation'), findsOneWidget);
      expect(find.text('等待归属'), findsOneWidget);
      expect(find.text('待确认的输入'), findsOneWidget);
    },
  );
  test('AC-I18N-04 persists only local locale preferences', () async {
    final directory = await Directory.systemTemp.createTemp('joi-i18n-');
    try {
      final controller = UiLocaleController();
      await controller.initialize(directory);
      await controller.setPreference('en');
      final reopened = UiLocaleController();
      await reopened.initialize(directory);
      expect(reopened.preference, 'en');
      expect(
        await File('${directory.path}/ui-preferences.json').readAsString(),
        contains('en'),
      );
      controller.dispose();
      reopened.dispose();
    } finally {
      await directory.delete(recursive: true);
    }
  });
  testWidgets('AC-I18N-03 switches a connected page without losing its draft', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
        supportsHome: true,
      ),
    );
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '保留我的 draft');
    await tester.tap(find.byTooltip('语言'));
    await tester.pumpAndSettle();
    await tester.tap(
      find
          .ancestor(
            of: find.text('English'),
            matching: find.byType(CheckedPopupMenuItem<String>),
          )
          .last,
    );
    await tester.pumpAndSettle();
    expect(find.byTooltip('Language'), findsOneWidget);
    expect(find.text('保留我的 draft'), findsOneWidget);
    expect(controller.sentMessages, isEmpty);
    expect(controller.state.connection, RemoteConnectionState.connected);
  });
  test(
    'AC-I18N-04 exposes persistence failure while keeping the selection live',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'joi-i18n-failure-',
      );
      final blocker = File('${directory.path}/blocked');
      await blocker.writeAsString('test');
      final controller = UiLocaleController();
      try {
        await controller.initialize(Directory('${blocker.path}/preferences'));
        await controller.setPreference('en');
        expect(controller.preference, 'en');
        expect(controller.persistenceFailed, isTrue);
      } finally {
        controller.dispose();
        await directory.delete(recursive: true);
      }
    },
  );
  testWidgets('AC-I18N-05 lays out both languages on a narrow mobile screen', (
    tester,
  ) async {
    final font = FontLoader('Roboto')
      ..addFont(rootBundle.load('assets/fonts/NotoSansSC.ttf'));
    await font.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final boundary = GlobalKey();
    final controller = FakeRemoteController(const RemoteViewState());
    for (final locale in ['en', 'zh-CN']) {
      uiLocale.setForTest(locale);
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: JoiMobileApp(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage();
        final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!;
        final output = File('../../tmp/i18n-mobile-$locale.png');
        await output.parent.create(recursive: true);
        await output.writeAsBytes(bytes.buffer.asUint8List());
        image.dispose();
      });
    }
  });
  testWidgets('AC-I18N-03 retranslates an open pairing dialog', (tester) async {
    final controller = FakeRemoteController(const RemoteViewState());
    await tester.pumpWidget(JoiMobileApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('输入连接码'));
    await tester.pumpAndSettle();
    uiLocale.setForTest('en');
    await tester.pumpAndSettle();
    expect(
      find.widgetWithText(AlertDialog, 'Enter connection code'),
      findsOneWidget,
    );
    expect(find.text('Paste a joi://pair link'), findsOneWidget);
  });
}
