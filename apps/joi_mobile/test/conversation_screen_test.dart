import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/home_screen.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'package:joi_mobile/conversation_screen.dart';
import 'package:joi_mobile/goal_detail.dart';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

class ChatPeer extends ChangeNotifier implements ConversationRemoteController {
  @override
  bool get supportsConversations => true;
  bool refuseSend = false;
  final inputs = <Map<String, dynamic>>[];
  Map<String, dynamic>? chat;
  Map<String, dynamic> historyPage = {'items': <Object>[], 'nextCursor': null};
  final config = <String, dynamic>{
    'partnerId': 'joi-chat',
    'partnerName': 'joi',
    'networkId': 'network',
    'networkName': '网络',
    'modelName': 'Model',
    'skills': <String>[],
    'attachmentIds': <String>[],
  };

  void progress(String text, String status) {
    final turns = List<Map<String, dynamic>>.from(chat!['turns'] as List);
    chat = {
      ...chat!,
      'turns': [
        {
          ...turns.single,
          'status': status,
          'entries': [
            {
              'entryId': 'reply',
              'kind': 'MARKDOWN',
              'role': 'AGENT',
              'text': text,
            },
          ],
        },
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> conversation(
    String operation, {
    Map<String, Object?> parameters = const {},
  }) async {
    switch (operation) {
      case 'catalog':
        return {
          'workbenches': [
            {'workbenchId': 'wb', 'name': '项目'},
          ],
          'networks': [
            {'sourceId': 'network', 'displayName': '网络', 'status': 'READY'},
          ],
          'partners': [],
        };
      case 'skills':
        return {'items': []};
      case 'list':
        return {
          'items': [
            if (chat != null)
              {
                'conversationId': chat!['conversationId'],
                'workbenchId': 'wb',
                'title': chat!['title'],
                'canArchive': false,
                'canDelete': false,
              },
          ],
        };
      case 'send':
        final input = Map<String, dynamic>.from(parameters['input']! as Map);
        inputs.add(input);
        if (refuseSend) {
          refuseSend = false;
          throw StateError('receipt_lost');
        }
        chat = {
          'conversationId': input['conversationId'],
          'workbenchId': 'wb',
          'title': '手机对话',
          'turns': [
            {
              'turnId': 'turn',
              'text': input['text'],
              'status': 'RUNNING',
              'config': config,
              'entries': <Object>[],
            },
          ],
        };
        progress('初始片段', 'RUNNING');
        return chat!;
      case 'get':
        return chat!;
      case 'history':
        return historyPage;
      case 'stop':
        progress('停止前的内容', 'STOPPED');
        return {'stopped': true};
      default:
        throw StateError('unexpected_operation');
    }
  }
}

class PartnerHistoryPeer extends PlaceholderRemoteController {
  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
    String? agentId,
    String? cursor,
  }) async {
    if (kind != 'agent.conversation') throw StateError('unexpected_operation');
    final firstPage = cursor == null;
    return {
      if (firstPage) 'nextCursor': 'next',
      'agent': {'status': 'COMPLETED'},
      'items': [
        if (firstPage)
          {
            'entryId': 'call',
            'kind': 'TOOL_CALL',
            'toolCallId': 'opaque',
            'toolName': 'read',
            'text': 'fixture.txt',
          }
        else ...[
          {
            'entryId': 'result',
            'kind': 'TOOL_RESULT',
            'toolCallId': 'opaque',
            'toolName': 'read',
            'text': 'PRIVATE_TOOL_BODY',
          },
          {
            'entryId': 'answer',
            'kind': 'MARKDOWN',
            'role': 'AGENT',
            'text': '## 合成记录已读',
          },
        ],
      ],
    };
  }
}

void main() {
  setUpAll(() async {
    await (FontLoader(
      'TestNoto',
    )..addFont(rootBundle.load('assets/fonts/NotoSansSC.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  testWidgets(
    'partner history keeps the tool disclosure open across a page boundary',
    (tester) async {
      final peer = PartnerHistoryPeer();
      addTearDown(peer.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: AgentRecordPage(
            controller: peer,
            goalId: 'fixture-goal',
            agent: const {'agentId': 'fixture-agent', 'status': 'COMPLETED'},
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('read'));
      await tester.pumpAndSettle();
      expect(find.text('fixture.txt'), findsNWidgets(2));
      await tester.tap(find.text(tr(Msg.mobileLoadMoreRecords)));
      await tester.pumpAndSettle();
      expect(find.byType(ExpansionTile), findsOneWidget);
      expect(find.text('fixture.txt'), findsNWidgets(2));
      expect(find.text('合成记录已读'), findsOneWidget);
      expect(find.text('PRIVATE_TOOL_BODY'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'phone conversation groups mixed tool calls and scrolls wide tables',
    (tester) async {
      tester.view.physicalSize = const Size(320, 680);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final peer = ChatPeer();
      addTearDown(peer.dispose);
      peer.chat = {
        'conversationId': 'phone-tools',
        'workbenchId': 'wb',
        'title': '工具记录',
        'turns': [
          {
            'turnId': 'tools-turn',
            'text': '检查表格',
            'status': 'COMPLETED',
            'config': peer.config,
            'entries': [
              {
                'entryId': 'call-1',
                'kind': 'TOOL_CALL',
                'toolName': 'read',
                'toolCallId': '1',
                'text': 'fixture.txt',
              },
              {
                'entryId': 'result-1',
                'kind': 'TOOL_RESULT',
                'toolName': 'read',
                'toolCallId': '1',
                'toolState': 'completed',
              },
              {
                'entryId': 'call-2',
                'kind': 'TOOL_CALL',
                'toolName': 'bash',
                'toolCallId': '2',
                'text': 'echo fixture',
              },
              {
                'entryId': 'result-2',
                'kind': 'TOOL_RESULT',
                'toolName': 'bash',
                'toolCallId': '2',
                'toolState': 'failed',
                'text': 'PRIVATE_TOOL_BODY',
              },
              {
                'entryId': 'answer',
                'kind': 'MARKDOWN',
                'role': 'AGENT',
                'text':
                    '| A | B | C | D |\n| -- | -- | -- | -- |\n| One | Two | Three | Four |',
              },
            ],
          },
        ],
      };
      await tester.pumpWidget(
        MaterialApp(home: ConversationScreen(controller: peer)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.menu));
      await tester.pumpAndSettle();
      await tester.tap(find.text('工具记录'));
      await tester.pumpAndSettle();
      final group = find.byType(ExpansionTile);
      expect(group, findsOneWidget);
      expect(find.text(tr(Msg.chatToolCount, {'count': 2})), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (w) =>
              w is SingleChildScrollView &&
              w.scrollDirection == Axis.horizontal,
        ),
        findsWidgets,
      );
      await tester.tap(find.text('bash'));
      await tester.pumpAndSettle();
      expect(find.text('fixture.txt'), findsOneWidget);
      expect(find.text('PRIVATE_TOOL_BODY'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'loading all older turns stays complete during later live refreshes',
    (tester) async {
      final peer = ChatPeer();
      addTearDown(peer.dispose);
      final recent = {
        'turnId': 'recent',
        'text': '新问题',
        'status': 'RUNNING',
        'config': peer.config,
        'entries': <Object>[],
      };
      peer.chat = {
        'conversationId': 'long-chat',
        'workbenchId': 'wb',
        'title': '长对话',
        'historyCursor': 'older',
        'turns': [recent],
      };
      peer.historyPage = {
        'items': [
          {
            ...recent,
            'turnId': 'older-turn',
            'text': '早期问题',
            'status': 'COMPLETED',
          },
        ],
        'nextCursor': null,
      };
      await tester.pumpWidget(
        MaterialApp(home: ConversationScreen(controller: peer)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.menu));
      await tester.pumpAndSettle();
      await tester.tap(find.text('长对话'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(tr(Msg.chatLoadEarlier)));
      await tester.pump();
      expect(find.text('早期问题'), findsOneWidget);
      expect(find.text(tr(Msg.chatLoadEarlier)), findsNothing);
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      expect(find.text('早期问题'), findsOneWidget);
      expect(find.text(tr(Msg.chatLoadEarlier)), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'phone conversation retains a failed draft and request identity, displays prefixes and stops',
    (tester) async {
      tester.view.physicalSize = const Size(360, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final peer = ChatPeer()..refuseSend = true;
      final screenshot = GlobalKey();
      addTearDown(peer.dispose);
      await tester.pumpWidget(
        RepaintBoundary(
          key: screenshot,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: ThemeData(
              brightness: Brightness.dark,
              fontFamily: 'TestNoto',
              colorScheme: ColorScheme.fromSeed(
                brightness: Brightness.dark,
                seedColor: const Color(0xff79c99e),
                surface: const Color(0xff111a15),
              ),
            ),
            home: ConversationScreen(controller: peer),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final composer = find.byType(TextField).last;
      await tester.enterText(composer, '手机上的问题');
      await tester.pump();
      final controller = tester.widget<TextField>(composer).controller!;
      controller.value = controller.value.copyWith(
        composing: const TextRange(start: 0, end: 2),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(peer.inputs, isEmpty);
      controller.clearComposing();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      expect(peer.inputs, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('手机上的问题'), findsOneWidget);
      expect(peer.inputs, hasLength(1));
      await tester.showKeyboard(composer);
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(peer.inputs, hasLength(2));
      expect(peer.inputs[0]['requestId'], peer.inputs[1]['requestId']);
      expect(find.text('初始片段'), findsOneWidget);
      peer.progress('持续增加的片段', 'RUNNING');
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      expect(find.text('持续增加的片段'), findsOneWidget);
      await tester.tap(find.byTooltip(tr(Msg.chatStop)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('停止前的内容'), findsOneWidget);
      expect(find.byTooltip(tr(Msg.chatStop)), findsNothing);
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();
      expect(
        tester.getBottomLeft(find.byTooltip(tr(Msg.chatSend))).dy,
        lessThanOrEqualTo(460),
      );
      tester.view.resetViewInsets();
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        final boundary =
            screenshot.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage();
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        final file = File('../../test-results/android-conversation-phone.png');
        await file.parent.create(recursive: true);
        await file.writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('the phone home offers the normal conversation entry', (
    tester,
  ) async {
    final controller = PlaceholderRemoteController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: controller,
          state: const RemoteViewState(
            connection: RemoteConnectionState.connected,
            supportsHome: true,
          ),
        ),
      ),
    );
    expect(find.byTooltip(tr(Msg.chatTitle)), findsOneWidget);
  });
}
