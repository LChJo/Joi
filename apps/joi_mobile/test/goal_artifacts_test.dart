import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/goal_artifacts.dart';
import 'package:joi_mobile/remote_controller.dart';
import 'widget_test.dart' show FakeRemoteController;

List<Map<String, dynamic>> files(int count, [int start = 0]) => [
  for (var i = start; i < start + count; i++)
    {'name': 'file-$i.json', 'mimeType': 'application/json', 'size': 100},
];

class ArtifactController extends FakeRemoteController {
  ArtifactController() : super(const RemoteViewState());
  bool fail = false;
  final cursors = <String?>[];
  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
    String? agentId,
    String? cursor,
  }) async {
    expect(kind, 'goal.artifacts');
    expect(goalId, 'goal');
    cursors.add(cursor);
    if (fail) throw StateError('synthetic failure');
    return cursor == null
        ? {'items': files(20), 'nextCursor': 'page-two'}
        : {'items': files(5, 20)};
  }
}

void main() {
  testWidgets(
    'shows an aggregated changed folder without a byte-size file label',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GoalArtifactList(
              controller: ArtifactController(),
              goalId: 'goal',
              initialItems: const [
                {
                  'name': 'reports',
                  'directory': 'reports',
                  'kind': 'DIRECTORY',
                  'mimeType': 'inode/directory',
                  'size': 0,
                  'fileCount': 25,
                },
              ],
            ),
          ),
        ),
      );
      expect(find.byIcon(Icons.folder_outlined), findsOneWidget);
      expect(find.text('reports'), findsOneWidget);
      expect(find.text('25 个文件'), findsOneWidget);
      expect(find.textContaining('inode/directory'), findsNothing);
      expect(find.textContaining('0 B'), findsNothing);
    },
  );

  testWidgets(
    'replaces remote artifact pages and retries without hiding prior files',
    (tester) async {
      final controller = ArtifactController();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: GoalArtifactList(
                controller: controller,
                goalId: 'goal',
                initialItems: files(20),
                nextCursor: 'page-two',
              ),
            ),
          ),
        ),
      );
      expect(find.text('file-0.json'), findsOneWidget);
      controller.fail = true;
      await tester.ensureVisible(find.text('下一页'));
      await tester.tap(find.text('下一页'));
      await tester.pumpAndSettle();
      expect(find.text('文件加载失败，请重试。'), findsOneWidget);
      expect(find.text('file-0.json'), findsOneWidget);
      controller.fail = false;
      await tester.ensureVisible(find.text('重试'));
      await tester.tap(find.text('重试'));
      await tester.pumpAndSettle();
      expect(find.text('file-0.json'), findsNothing);
      expect(find.text('file-24.json'), findsOneWidget);
      await tester.ensureVisible(find.text('上一页'));
      await tester.tap(find.text('上一页'));
      await tester.pumpAndSettle();
      expect(find.text('file-0.json'), findsOneWidget);
      expect(controller.cursors, ['page-two', 'page-two', null]);
    },
  );

  testWidgets(
    'bounds old-host lists locally and preserves every filename through paging',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: GoalArtifactList(
                controller: ArtifactController(),
                goalId: 'goal',
                initialItems: files(1000),
              ),
            ),
          ),
        ),
      );
      expect(find.byType(ListTile), findsNWidgets(20));
      expect(find.text('file-20.json'), findsNothing);
      await tester.ensureVisible(find.text('下一页'));
      await tester.tap(find.text('下一页'));
      await tester.pumpAndSettle();
      expect(find.byType(ListTile), findsNWidgets(20));
      expect(find.text('file-20.json'), findsOneWidget);
      expect(find.text('file-0.json'), findsNothing);
    },
  );
}
