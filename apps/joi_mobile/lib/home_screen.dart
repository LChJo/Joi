import 'i18n.dart';
import 'result_reader.dart';
import 'package:flutter/material.dart';

import 'archived_goals.dart';
import 'conversation_screen.dart';
import 'remote_controller.dart';
import 'goal_detail.dart';
import 'connection_diagnostics_view.dart';
import 'joi_brand.dart';
import 'workbench_choice.dart';

String goalWorkbenchName(RemoteGoalCard goal) => goal.workbenchName.isEmpty
    ? tr(Msg.commonAwaitingAssignment)
    : goal.workbenchName;
String goalTitle(RemoteGoalCard goal) =>
    goal.title.isEmpty ? tr(Msg.commonInputAwaitingConfirmation) : goal.title;

String goalStatusLabel(RemoteGoalCard goal) =>
    goal.status == 'NEEDS_ATTENTION' &&
        goal.reasonCode == 'harness_review_unrecoverable'
    ? tr(Msg.homeReviewInterrupted)
    : statusLabel(goal.status);

String statusLabel(String value) =>
    {
      'ARRANGING': tr(Msg.homePlanning),
      'ARRANGED': tr(Msg.statusScheduled),
      'RUNNING': tr(Msg.homeExecuting),
      'REVIEWING': tr(Msg.mobileReviewing),
      'EXTENDING': tr(Msg.remoteExtending),
      'NEEDS_ATTENTION': tr(Msg.homeNeedsYou),
      'FINALIZING': tr(Msg.mobilePreparingResults),
      'COMPLETED': tr(Msg.statusCompleted),
      'COMPLETED_WITH_GAPS': tr(Msg.mobileCompletedWithGaps),
      'FAILED': tr(Msg.mobileNotCompleted),
      'CANCELED': tr(Msg.statusCanceled),
      'WAITING': tr(Msg.mobileAwaitingAnAnswer),
      'IDLE': tr(Msg.mobileIdle),
      'UNKNOWN': tr(Msg.mobileStatusUnconfirmed),
      'ROUTING': tr(Msg.homeChooseWorkbench),
      'PLANNING': tr(Msg.mobilePlanning),
      'DISPATCHING': tr(Msg.mobileAssigningPartners),
    }[value] ??
    tr(Msg.mobileUpdatingStatus);

Map<String, String> get _waitLabels => {
  'CAPACITY': tr(Msg.homeWaitingForExecutionCapacity),
  'WORKSPACE_READ': tr(Msg.homeWaitingForWorkspaceReadAccess),
  'WORKSPACE_WRITE': tr(Msg.homeWaitingToWrite),
};

String executionStatusLabel({
  required String status,
  String? resultAssessment,
  String? executionPhase,
  String? waitReason,
}) {
  if (status == 'FAILED' && resultAssessment == 'INSUFFICIENT') {
    return tr(Msg.homeInsufficient);
  }
  if (waitReason == 'CAPACITY') return _waitLabels['CAPACITY']!;
  return switch (executionPhase) {
    'READ_QUEUED' => _waitLabels['WORKSPACE_READ']!,
    'READ_RUNNING' => tr(Msg.homeAnalyzing),
    'WRITE_QUEUED' => _waitLabels['WORKSPACE_WRITE']!,
    'WRITE_RUNNING' => tr(Msg.homeWriting),
    _ => statusLabel(status),
  };
}

String goalProgressLabel(RemoteGoalCard goal) {
  final parts = [
    tr(Msg.mobileValuePartners, {'p0': formatUiNumber(goal.agentCount)}),
    tr(Msg.mobileValueValueCompleted, {
      'p0': formatUiNumber(goal.completedWork),
      'p1': formatUiNumber(goal.totalWork),
    }),
  ];
  if (goal.failedWork > 0) {
    parts.add(tr(Msg.homeValueFailed, {'p0': formatUiNumber(goal.failedWork)}));
  }
  if (goal.executingWork != null || goal.resourceWaitingWork != null) {
    if ((goal.executingWork ?? 0) > 0) {
      parts.add(
        tr(Msg.homeValueExecuting, {'p0': formatUiNumber(goal.executingWork!)}),
      );
    }
    if ((goal.resourceWaitingWork ?? 0) > 0) {
      parts.add(
        tr(Msg.homeValueWaiting, {
          'p0': formatUiNumber(goal.resourceWaitingWork!),
        }),
      );
    }
    for (final reason in goal.waitingReasons) {
      final label = _waitLabels[reason];
      if (label != null) parts.add(label);
    }
  } else if (goal.activeWork > 0) {
    parts.add(
      tr(Msg.homeValueInProgress, {'p0': formatUiNumber(goal.activeWork)}),
    );
  }
  if (goal.stage != null) parts.add(statusLabel(goal.stage!));
  return parts.join(' · ');
}

/// The tappable part of a goal card.
///
/// Shared with the archive page, which asks for the [compact] shape: a filed-away goal is not
/// mid-flight, so its progress bar, Work counts and result preview would only make a list of things
/// put away harder to scan. What is left is the workbench, the goal and when it was filed; the full
/// result is still one tap in, at `GoalDetailPage`.
class GoalCardBody extends StatelessWidget {
  const GoalCardBody({
    super.key,
    required this.goal,
    required this.supportsHome,
    required this.onOpen,
    required this.onOpenResult,
    this.compact = false,
  });

  final RemoteGoalCard goal;
  final bool supportsHome;
  final VoidCallback onOpen;
  final VoidCallback onOpenResult;
  final bool compact;

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => InkWell(
      onTap: !supportsHome || goal.goalId.isEmpty ? null : onOpen,
      child: compact ? _compact(context) : _full(context),
    ),
  );

  Widget _compact(BuildContext context) {
    final archivedAt = goal.archivedAt;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            _WorkbenchOrb(name: goalWorkbenchName(goal)),
            const SizedBox(width: 10),
            Expanded(child: Text(goalWorkbenchName(goal))),
            Text(goalStatusLabel(goal)),
          ],
        ),
        const SizedBox(height: 6),
        Text(goalTitle(goal), style: Theme.of(context).textTheme.titleMedium),
        if (archivedAt != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              tr(Msg.homeValueArchived, {
                'p0':
                    (DateTime.tryParse(archivedAt) == null
                            ? archivedAt
                            : formatUiDate(DateTime.parse(archivedAt)))
                        .toString(),
              }),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
    );
  }

  Widget _full(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Expanded(child: Text(goalWorkbenchName(goal))),
          Text(goalStatusLabel(goal)),
        ],
      ),
      const SizedBox(height: 8),
      Text(goalTitle(goal), style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 12),
      LinearProgressIndicator(
        value: goal.totalWork == 0
            ? 0
            : (goal.completedWork / goal.totalWork).clamp(0, 1),
      ),
      const SizedBox(height: 8),
      Text(goalProgressLabel(goal)),
      if (goal.summary != null &&
          (!supportsHome || !goal.needsContinuationDecision))
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: InkWell(
            onTap: supportsHome ? onOpenResult : null,
            child: Text(
              goal.summary!,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
      if (supportsHome)
        Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text(tr(Msg.mobileViewDetails)),
        ),
    ],
  );
}

/// The small round workbench mark that heads a compact card, so a list of archived goals still shows
/// at a glance which workbench each one belonged to.
class _WorkbenchOrb extends StatelessWidget {
  const _WorkbenchOrb({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: scheme.primaryContainer,
      ),
      child: Text(
        name.isEmpty ? '·' : name.substring(0, 1),
        style: TextStyle(
          color: scheme.onPrimaryContainer,
          fontSize: 13,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

Future<RemoteChoice?> chooseRemote(
  BuildContext context,
  String title,
  List<RemoteChoice> choices, {
  bool automatic = false,
}) {
  var query = '';
  return showModalBottomSheet<RemoteChoice>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          20,
          20,
          MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SizedBox(
          height:
              (MediaQuery.sizeOf(context).height -
                  MediaQuery.viewInsetsOf(context).bottom) *
              .55,
          child: Column(
            children: [
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              TextField(
                autofocus: false,
                decoration: InputDecoration(
                  labelText: tr(Msg.mobileSearchNameOrScope),
                ),
                onChanged: (text) =>
                    setState(() => query = text.trim().toLowerCase()),
              ),
              if (automatic)
                ListTile(
                  title: Text(tr(Msg.mobileLetJoiDecide)),
                  onTap: () => Navigator.pop(
                    context,
                    RemoteChoice('', tr(Msg.mobileLetJoiDecide)),
                  ),
                ),
              Expanded(
                child: ListView(
                  children: [
                    for (final item in choices.where(
                      (c) => '${c.name} ${c.description}'
                          .toLowerCase()
                          .contains(query),
                    ))
                      ListTile(
                        title: Text(item.name),
                        subtitle: item.description.isEmpty
                            ? null
                            : Text(item.description),
                        onTap: () => Navigator.pop(context, item),
                      ),
                    if (choices
                        .where(
                          (c) => '${c.name} ${c.description}'
                              .toLowerCase()
                              .contains(query),
                        )
                        .isEmpty)
                      ListTile(
                        title: Text(
                          tr(
                            Msg.mobileNoMatchesConfigureOnTheDesktopThenRefresh,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.controller, required this.state});
  final RemoteController controller;
  final RemoteViewState state;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _composer = TextEditingController();
  String? _workbenchId;
  Object? _notice;
  bool _sending = false;
  bool _workbenchChoiceOpen = false;
  final _shownWorkbenchQuestions = <String>{};
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _offerWorkbenchChoice();
  }

  @override
  void didUpdateWidget(covariant HomeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    _offerWorkbenchChoice();
  }

  void _offerWorkbenchChoice() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted ||
          _workbenchChoiceOpen ||
          !(ModalRoute.of(context)?.isCurrent ?? true) ||
          widget.state.connection != RemoteConnectionState.connected) {
        return;
      }
      String key(RemoteGoalCard goal) =>
          '${goal.goalId}:${goal.questionId ?? "legacy"}:${goal.questionVersion ?? 1}';
      final next = widget.state.goals
          .where(
            (goal) =>
                goal.needsWorkbenchChoice &&
                !_shownWorkbenchQuestions.contains(key(goal)),
          )
          .firstOrNull;
      if (next == null) return;
      _shownWorkbenchQuestions.add(key(next));
      _workbenchChoiceOpen = true;
      try {
        await showWorkbenchChoice(context, widget.controller, next);
      } finally {
        _workbenchChoiceOpen = false;
        if (mounted) _offerWorkbenchChoice();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      widget.controller.setForeground(state == AppLifecycleState.resumed);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _composer.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _notice = null;
    });
    try {
      final selected = widget.state.workbenches.any((b) => b.id == _workbenchId)
          ? _workbenchId
          : null;
      await widget.controller.sendMessage(text, workbenchId: selected);
      if (mounted) setState(() => _workbenchId = null);
      if (mounted && _composer.text.trim() == text) _composer.clear();
    } catch (_) {
      if (mounted) {
        setState(
          () => _notice = UiNotice(
            Msg.mobileDeliveryWasNotConfirmedYourInputIsPreservedRetry,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final state = widget.state;
    final ready = state.connection == RemoteConnectionState.connected;
    final selected = state.workbenches
        .where((b) => b.id == _workbenchId)
        .firstOrNull;
    final link = !ready
        ? (state.connection == RemoteConnectionState.offline
              ? tr(Msg.mobileOffline)
              : tr(Msg.mobileReconnecting))
        : switch (state.path) {
            RemoteConnectionPath.direct => tr(Msg.mobileDirect),
            RemoteConnectionPath.relay => tr(Msg.mobileRelay),
            _ => tr(Msg.mobileConnected),
          };
    final groups = <String, List<RemoteGoalCard>>{
      tr(Msg.homeNeedsYou): state.goals
          .where((g) => g.status == 'NEEDS_ATTENTION')
          .toList(),
      tr(Msg.statusInProgress): state.goals
          .where((g) => !g.terminal && g.status != 'NEEDS_ATTENTION')
          .toList(),
      tr(Msg.mobileFinished): state.goals.where((g) => g.terminal).toList(),
    };
    return Scaffold(
      bottomNavigationBar: NavigationBar(
        selectedIndex: 0,
        onDestinationSelected: (index) {
          if (index != 1) return;
          final Object controller = widget.controller;
          if (controller is ConversationRemoteController &&
              controller.supportsConversations) {
            Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => ConversationScreen(controller: controller),
              ),
            );
          } else {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  tr(Msg.mobileTheDesktopVersionIsOlderUpdateItToRead),
                ),
              ),
            );
          }
        },
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.favorite_outline),
            label: 'joi',
          ),
          NavigationDestination(
            icon: const Icon(Icons.chat_bubble_outline_rounded),
            label: tr(Msg.chatTitle),
            tooltip: tr(Msg.chatTitle),
          ),
        ],
      ),
      appBar: AppBar(
        title: const JoiBrand(),
        actions: [
          const UiLanguageButton(),
          Padding(padding: const EdgeInsets.all(16), child: Text(link)),
          IconButton(
            tooltip: tr(Msg.commonArchived),
            icon: const Icon(Icons.inventory_2_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) =>
                    ArchivedGoalsPage(controller: widget.controller),
              ),
            ),
          ),
          ConnectionDiagnosticsButton(controller: widget.controller),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (ready && !state.supportsHome)
              Padding(
                padding: EdgeInsets.all(12),
                child: Text(
                  tr(Msg.mobileTheDesktopVersionIsOlderUpdateItToRead),
                ),
              ),
            if (_notice ?? state.localizedNotice ?? state.notice
                case final Object notice)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  noticeText(notice),
                  semanticsLabel: noticeText(notice),
                ),
              ),
            if (!ready || homeSyncPending(state))
              ConnectionProgress(controller: widget.controller),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async {
                  try {
                    await widget.controller.refresh();
                    if (mounted) setState(() => _notice = null);
                    widget.controller.setForeground(true);
                  } catch (_) {
                    if (mounted) {
                      setState(
                        () => _notice = UiNotice(
                          Msg.mobileRefreshFailedPreviousContentIsPreserved,
                        ),
                      );
                    }
                  }
                },
                child: ListView(
                  key: const PageStorageKey('home-feed'),
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (state.goals.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          // An empty feed with a full archive is a state the user caused, so it
                          // says where the cards went instead of reading as data loss.
                          !ready
                              ? tr(
                                  Msg.mobileTheHomePageHasNotSyncedYetDesktopTasks,
                                )
                              : state.archivedGoals.isEmpty
                              ? tr(Msg.mobileNoTasksYetTellJoiWhatYouHaveIn)
                              : tr(
                                  Msg.mobileNoTasksOnTheHomePageArchivedCardsAre,
                                ),
                        ),
                      ),
                    for (final group in groups.entries)
                      if (group.value.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          child: Text(
                            group.key,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        for (final goal in group.value)
                          Card(
                            key: ValueKey(goal.goalId),
                            margin: const EdgeInsets.only(bottom: 12),
                            child: Padding(
                              padding: const EdgeInsets.all(16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  GoalCardBody(
                                    goal: goal,
                                    supportsHome: state.supportsHome,
                                    onOpen: () => Navigator.push(
                                      context,
                                      MaterialPageRoute(
                                        builder: (_) => GoalDetailPage(
                                          controller: widget.controller,
                                          initial: goal,
                                        ),
                                      ),
                                    ),
                                    onOpenResult: () => Navigator.push(
                                      context,
                                      MaterialPageRoute(
                                        builder: (_) => ResultReaderPage(
                                          controller: widget.controller,
                                          goal: goal,
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (state.supportsHome)
                                    GoalActions(
                                      key: ValueKey('actions-${goal.goalId}'),
                                      controller: widget.controller,
                                      goal: goal,
                                    ),
                                ],
                              ),
                            ),
                          ),
                      ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextButton.icon(
                    icon: const Icon(Icons.workspaces_outline, size: 18),
                    label: Text(selected?.name ?? tr(Msg.mobileLetJoiDecide)),
                    onPressed: !ready || !state.supportsHome || _sending
                        ? null
                        : () async {
                            final choice = await chooseRemote(
                              context,
                              tr(Msg.homeChooseWorkbench),
                              state.workbenches,
                              automatic: true,
                            );
                            if (choice != null && mounted) {
                              setState(
                                () => _workbenchId = choice.id.isEmpty
                                    ? null
                                    : choice.id,
                              );
                            }
                          },
                  ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _composer,
                          enabled: !_sending,
                          minLines: 1,
                          maxLines: 5,
                          maxLength: 32000,
                          onChanged: (_) => setState(() {}),
                          decoration: InputDecoration(
                            hintText: tr(Msg.mobileSaySomethingToJoi),
                            counterText: '',
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        tooltip: tr(Msg.remoteSend),
                        onPressed:
                            !ready ||
                                _sending ||
                                state.sending ||
                                _composer.text.trim().isEmpty
                            ? null
                            : _send,
                        icon: _sending
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.arrow_upward_rounded),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
