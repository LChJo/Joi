import 'package:flutter/material.dart';

import 'remote_controller.dart';
import 'goal_detail.dart';
import 'connection_diagnostics_view.dart';

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
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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
        title: const Text('joi'),
        actions: [
          Padding(padding: const EdgeInsets.all(16), child: Text(link)),
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
            if (ready)
              ConnectionDiagnosticsButton(controller: widget.controller),
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
                          ready
                              ? '暂时没有任务，和 joi 说点什么吧。'
                              : '尚未同步首页，连接成功后会显示电脑上的任务。',
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
                                  InkWell(
                                    onTap:
                                        !state.supportsHome ||
                                            goal.goalId.isEmpty
                                        ? null
                                        : () => Navigator.push(
                                            context,
                                            MaterialPageRoute(
                                              builder: (_) => GoalDetailPage(
                                                controller: widget.controller,
                                                initial: goal,
                                              ),
                                            ),
                                          ),
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Expanded(
                                              child: Text(goal.workbenchName),
                                            ),
                                            Text(statusLabel(goal.status)),
                                          ],
                                        ),
                                        const SizedBox(height: 8),
                                        Text(
                                          goal.title,
                                          style: Theme.of(
                                            context,
                                          ).textTheme.titleMedium,
                                        ),
                                        const SizedBox(height: 12),
                                        LinearProgressIndicator(
                                          value: goal.totalWork == 0
                                              ? 0
                                              : (goal.completedWork /
                                                        goal.totalWork)
                                                    .clamp(0, 1),
                                        ),
                                        const SizedBox(height: 8),
                                        Text(
                                          '${goal.agentCount} 位搭档 · ${goal.completedWork}/${goal.totalWork} 已完成${goal.stage == null ? '' : ' · ${statusLabel(goal.stage!)}'}',
                                        ),
                                        if (goal.summary != null)
                                          Padding(
                                            padding: const EdgeInsets.only(
                                              top: 10,
                                            ),
                                            child: Text(
                                              goal.summary!,
                                              maxLines: 3,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        if (state.supportsHome)
                                          const Padding(
                                            padding: EdgeInsets.only(top: 8),
                                            child: Text('查看详情 ›'),
                                          ),
                                      ],
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
