import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/app.dart';
import 'package:joi_mobile/remote_controller.dart';

class FakeRemoteController extends ChangeNotifier implements RemoteController {
  FakeRemoteController(this._state);

  final List<String> sentMessages = [];
  final RemoteViewState _state;

  @override
  RemoteViewState get state => _state;

  @override
  Future<void> connectFromQr(String payload) async {}

  @override
  Future<void> refresh() async {}

  @override
  Future<void> sendMessage(String text) async {
    sentMessages.add(text);
  }
}

void main() {
  testWidgets('connected portrait shell renders task cards and sends text', (
    tester,
  ) async {
    final controller = FakeRemoteController(
      const RemoteViewState(
        connection: RemoteConnectionState.connected,
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
    expect(find.text('设置'), findsNothing);
    expect(find.text('文件'), findsNothing);

    await tester.enterText(find.byType(TextField), '继续完成任务');
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pump();

    expect(controller.sentMessages, ['继续完成任务']);
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
