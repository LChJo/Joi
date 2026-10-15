import 'result_reader.dart';
import 'package:flutter/material.dart';

import 'archived_goals.dart';
import 'remote_controller.dart';
import 'goal_detail.dart';
import 'connection_diagnostics_view.dart';
import 'joi_brand.dart';
import 'workbench_choice.dart';

String statusLabel(String value) =>
    const {
      'ARRANGING': '正在安排',
      'ARRANGED': '已安排',
      'RUNNING': '执行中',
      'REVIEWING': '复盘中',
      'EXTENDING': '补充执行',
      'NEEDS_ATTENTION': '需要你',
      'FINALIZING': '整理结果',
      'COMPLETED': '已完成',
      'COMPLETED_WITH_GAPS': '有缺口完成',
      'FAILED': '未完成',
      'CANCELED': '已取消',
      'WAITING': '等待回答',
      'IDLE': '空闲',
      'UNKNOWN': '状态待确认',
      'ROUTING': '选择工作台',
      'PLANNING': '规划中',
      'DISPATCHING': '安排搭档',
    }[value] ??
    '状态更新中';

const _waitLabels = {
  'CAPACITY': '等待执行容量',
  'WORKSPACE_READ': '等待工作区可读',
  'WORKSPACE_WRITE': '等待写入',
};

String executionStatusLabel({
  required String status,
  String? executionPhase,
  String? waitReason,
}) {
  if (waitReason == 'CAPACITY') return _waitLabels['CAPACITY']!;
  return switch (executionPhase) {
    'READ_QUEUED' => _waitLabels['WORKSPACE_READ']!,
    'READ_RUNNING' => '分析中',
    'WRITE_QUEUED' => _waitLabels['WORKSPACE_WRITE']!,
    'WRITE_RUNNING' => '写入执行中',
    _ => statusLabel(status),
  };
}

String goalProgressLabel(RemoteGoalCard goal) {
  final parts = [
    '${goal.agentCount} 位搭档',
    '${goal.completedWork}/${goal.totalWork} 已完成',
  ];
  if (goal.failedWork > 0) parts.add('${goal.failedWork} 失败');
  if (goal.executingWork != null || goal.resourceWaitingWork != null) {
    if ((goal.executingWork ?? 0) > 0) {
      parts.add('${goal.executingWork} 执行中');
    }
    if ((goal.resourceWaitingWork ?? 0) > 0) {
      parts.add('${goal.resourceWaitingWork} 等待中');
    }
    for (final reason in goal.waitingReasons) {
      final label = _waitLabels[reason];
      if (label != null) parts.add(label);
    }
  } else if (goal.activeWork > 0) {
    parts.add('${goal.activeWork} 进行中');
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
  Widget build(BuildContext context) => InkWell(
    onTap: !supportsHome || goal.goalId.isEmpty ? null : onOpen,
    child: compact ? _compact(context) : _full(context),
  );

  Widget _compact(BuildContext context) {
    final archivedAt = goal.archivedAt;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            _WorkbenchOrb(name: goal.workbenchName),
            const SizedBox(width: 10),
            Expanded(child: Text(goal.workbenchName)),
            Text(statusLabel(goal.status)),
          ],
        ),
        const SizedBox(height: 6),
        Text(goal.title, style: Theme.of(context).textTheme.titleMedium),
        if (archivedAt != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '${DateTime.tryParse(archivedAt)?.toLocal().toString() ?? archivedAt} 归档',
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
          Expanded(child: Text(goal.workbenchName)),
          Text(statusLabel(goal.status)),
        ],
      ),
      const SizedBox(height: 8),
      Text(goal.title, style: Theme.of(context).textTheme.titleMedium),
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
        const Padding(padding: EdgeInsets.only(top: 8), child: Text('查看详情 ›')),
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
                decoration: const InputDecoration(labelText: '搜索名称或范围'),
                onChanged: (text) =>
                    setState(() => query = text.trim().toLowerCase()),
              ),
              if (automatic)
                ListTile(
                  title: const Text('由 joi 判断'),
                  onTap: () => Navigator.pop(
                    context,
                    const RemoteChoice('', '由 joi 判断'),
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
                      const ListTile(title: Text('没有匹配项，请在桌面配置后刷新。')),
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
  String? _notice;
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
      if (mounted) setState(() => _notice = '未确认发送成功，已保留输入。连接恢复后可重试。');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final ready = state.connection == RemoteConnectionState.connected;
    final selected = state.workbenches
        .where((b) => b.id == _workbenchId)
        .firstOrNull;
    final link = !ready
        ? (state.connection == RemoteConnectionState.offline ? '离线' : '重连中')
        : switch (state.path) {
            RemoteConnectionPath.direct => '直连',
            RemoteConnectionPath.relay => '中继',
            _ => '已连接',
          };
    final groups = <String, List<RemoteGoalCard>>{
      '需要你': state.goals.where((g) => g.status == 'NEEDS_ATTENTION').toList(),
      '进行中': state.goals
          .where((g) => !g.terminal && g.status != 'NEEDS_ATTENTION')
          .toList(),
      '已结束': state.goals.where((g) => g.terminal).toList(),
    };
    return Scaffold(
      appBar: AppBar(
        title: const JoiBrand(),
        actions: [
          Padding(padding: const EdgeInsets.all(16), child: Text(link)),
          IconButton(
            tooltip: '已归档',
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
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('桌面版本较旧，升级后可阅读详情和操作卡片。'),
              ),
            if (_notice ?? state.notice case final String notice)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(notice, semanticsLabel: notice),
              ),
            if (!ready) ConnectionProgress(controller: widget.controller),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async {
                  try {
                    await widget.controller.refresh();
                    widget.controller.setForeground(true);
                  } catch (_) {
                    if (mounted) setState(() => _notice = '刷新失败，已保留上次内容。');
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
                              ? '尚未同步首页，连接成功后会显示电脑上的任务。'
                              : state.archivedGoals.isEmpty
                              ? '暂时没有任务，和 joi 说点什么吧。'
                              : '首页没有任务了，归档的卡片在右上角「已归档」里。',
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
                    label: Text(selected?.name ?? '由 joi 判断'),
                    onPressed: !ready || !state.supportsHome || _sending
                        ? null
                        : () async {
                            final choice = await chooseRemote(
                              context,
                              '选择工作台',
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
                          decoration: const InputDecoration(
                            hintText: '和 joi 说点什么…',
                            counterText: '',
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        tooltip: '发送',
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
