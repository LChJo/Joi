import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/goal_detail.dart';
import 'package:joi_mobile/home_screen.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:joi_mobile/remote_controller.dart';

class GoalPeer extends PlaceholderRemoteController {
  bool changed = false;
  bool supportsMap = false;
  bool rejectMapCursor = false;
  final reads = <(String, String?)>[];
  final goal = <String, dynamic>{
    'goalId': 'goal',
    'status': 'FINALIZING',
    'title': 'Long-running task',
    'recovery': {'phase': 'QUEUED', 'attempts': 1},
    'harness': {'currentLayer': 33},
  };

  @override
  RemoteViewState get state => RemoteViewState(
    connection: RemoteConnectionState.connected,
    supportsHome: true,
    supportsGoalMap: supportsMap,
  );

  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
    String? agentId,
    String? cursor,
  }) async {
    reads.add((kind, cursor));
    if (kind == 'goal.map' && cursor != null && rejectMapCursor) {
      throw const RemoteActionFailure('remote_cursor_expired');
    }
    return switch (kind) {
      'goal.get' => {'text': 'Task', 'goal': goal},
      'goal.agents' => {
        'items': [
          if (!changed || cursor == null)
            {
              'agentId': cursor ?? 'current',
              'partnerName': cursor == null ? 'Current partner' : 'Old partner',
            },
        ],
        if (cursor == null && !changed) 'nextCursor': 'previous',
      },
      'goal.map' => {
        'harness': {
          'currentLayer': 33,
          'pathCount': 2,
          'paths': [
            {
              'pathId': cursor ?? 'latest',
              'layer': cursor == null ? 33 : 32,
              'title': cursor == null ? 'Latest path' : 'Earlier path',
              'status': 'OPEN',
            },
          ],
        },
        if (cursor == null) 'nextCursor': 'earlier',
      },
      _ => {},
    };
  }
}

void main() {
  testWidgets(
    'goal card shows synthesis recovery and old cards retain the ordinary state',
    (tester) async {
      final peer = GoalPeer();
      addTearDown(peer.dispose);
      final goal = RemoteGoalCard.fromJson(peer.goal);
      final oldGoal = RemoteGoalCard.fromJson(
        {...peer.goal}..remove('recovery'),
      );
      expect(goalStatusLabel(oldGoal), tr(Msg.mobilePreparingResults));
      expect(goalStatusLabel(goal), tr(Msg.homeSynthesisQueued));
      final waiting = RemoteGoalCard.fromJson({
        ...peer.goal,
        'recovery': {
          'phase': 'WAITING_RETRY',
          'attempts': 2,
          'retryAt': '2026-11-22T12:00:00Z',
        },
      });
      expect(goalStatusLabel(waiting), tr(Msg.homeSynthesisRetryWaiting));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GoalCardBody(
              goal: goal,
              supportsHome: true,
              onOpen: () {},
              onOpenResult: () {},
            ),
          ),
        ),
      );
      expect(find.text(tr(Msg.homeSynthesisQueuedHint)), findsOneWidget);
    },
  );

  testWidgets('refresh removes stale partner rows after paging', (
    tester,
  ) async {
    final peer = GoalPeer();
    addTearDown(peer.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: GoalDetailPage(
          controller: peer,
          initial: RemoteGoalCard.fromJson(peer.goal),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final more = find.text(tr(Msg.mobileMorePartners));
    await tester.ensureVisible(more);
    await tester.tap(more);
    await tester.pumpAndSettle();
    expect(find.text('Old partner'), findsOneWidget);
    peer.changed = true;
    await tester.tap(find.byTooltip(tr(Msg.mobileRefresh)));
    await tester.pumpAndSettle();
    expect(find.text('Current partner'), findsOneWidget);
    expect(find.text('Old partner'), findsNothing);
    expect(more, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('route map negotiates access and recovers expired pages', (
    tester,
  ) async {
    final peer = GoalPeer();
    addTearDown(peer.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: GoalDetailPage(
          controller: peer,
          initial: RemoteGoalCard.fromJson(peer.goal),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final entry = find.text(tr(Msg.homeGoalRouteMap));
    expect(entry, findsNothing);
    expect(peer.reads.where((read) => read.$1 == 'goal.map'), isEmpty);
    peer.supportsMap = true;
    peer.notifyListeners();
    await tester.pump();
    await tester.ensureVisible(entry);
    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(
      find.text(tr(Msg.homeRouteCurrentLayer, {'layer': '33'})),
      findsOneWidget,
    );
    expect(find.text('Latest path'), findsOneWidget);
    final next = find.text(tr(Msg.commonNextPage));
    peer.rejectMapCursor = true;
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Latest path'), findsOneWidget);
    await tester.tap(find.text(tr(Msg.commonRetry)));
    await tester.pumpAndSettle();
    expect(peer.reads.last, ('goal.map', null));
    peer.rejectMapCursor = false;
    await tester.tap(next);
    await tester.pumpAndSettle();
    expect(find.text('Latest path'), findsNothing);
    expect(find.text('Earlier path'), findsNothing);
    await tester.tap(find.text(tr(Msg.homeRouteLayer, {'layer': '32'})));
    await tester.pumpAndSettle();
    expect(find.text('Earlier path'), findsOneWidget);
    await tester.tap(find.text(tr(Msg.commonPreviousPage)));
    await tester.pumpAndSettle();
    expect(find.text('Latest path'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
