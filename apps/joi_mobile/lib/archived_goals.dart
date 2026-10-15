import 'i18n.dart';
import 'package:flutter/material.dart';

import 'connection_diagnostics_view.dart';
import 'goal_detail.dart';
import 'home_screen.dart';
import 'remote_controller.dart';
import 'result_reader.dart';

/// The cards the user filed away.
///
/// Archiving is the reversible half of cleaning up the feed, so every way back lives here: 「取消归档」
/// puts the card back on the home feed, 「继续对话」 revives the goal (which also unarchives it), and
/// 「移除卡片」 is still the one action that throws it away. The actions themselves come from the same
/// [GoalActions] the home card uses, so the two screens cannot drift on what a card offers.
class ArchivedGoalsPage extends StatelessWidget {
  const ArchivedGoalsPage({super.key, required this.controller});

  final RemoteController controller;

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => Scaffold(
      appBar: AppBar(
        title: Text(tr(Msg.commonArchived)),
        actions: [ConnectionDiagnosticsButton(controller: controller)],
      ),
      body: AnimatedBuilder(
        animation: controller,
        builder: (context, _) {
          dependOnUiLocale(context);
          final goals = controller.state.archivedGoals;
          if (goals.isEmpty) {
            return Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  tr(Msg.mobileNoArchivedGoalsYetChooseArchiveUnderMoreActions),
                ),
              ),
            );
          }
          return ListView.builder(
            padding: const EdgeInsets.all(16),
            itemCount: goals.length,
            itemBuilder: (context, index) {
              final goal = goals[index];
              return Card(
                key: ValueKey('archived-${goal.goalId}'),
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      GoalCardBody(
                        goal: goal,
                        // The compact shape, and it carries the 归档 timestamp itself — this page is a
                        // list of things put away, not a second feed.
                        compact: true,
                        supportsHome: true,
                        onOpen: () => Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => GoalDetailPage(
                              controller: controller,
                              initial: goal,
                            ),
                          ),
                        ),
                        onOpenResult: () => Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => ResultReaderPage(
                              controller: controller,
                              goal: goal,
                            ),
                          ),
                        ),
                      ),
                      GoalActions(
                        key: ValueKey('archived-actions-${goal.goalId}'),
                        controller: controller,
                        goal: goal,
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    ),
  );
}
