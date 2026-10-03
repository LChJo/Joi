import 'result_reader.dart';
import 'connection_diagnostics_view.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'remote_controller.dart';
import 'workbench_suggestions.dart';
import 'home_screen.dart';

class MessageBody extends StatelessWidget {
  const MessageBody(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => MarkdownBody(
    data: text,
    selectable: true,
    imageBuilder: (_, _, _) => const Text('[图片]'),
    onTapLink: (_, href, _) async {
      final uri = Uri.tryParse(href ?? '');
      if (uri == null || !['https', 'http'].contains(uri.scheme)) return;
      try {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } catch (_) {
        if (context.mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('无法打开链接，可复制后在浏览器查看。')));
        }
      }
    },
  );
}

class GoalActions extends StatefulWidget {
  const GoalActions({
    super.key,
    required this.controller,
    required this.goal,
    this.onChanged,
  });
  final RemoteController controller;
  final RemoteGoalCard goal;
  final VoidCallback? onChanged;
  @override
  State<GoalActions> createState() => _GoalActionsState();
}

/// What to tell the user when an action did not go through.
///
/// One sentence for every cause is what made this look like a button that does nothing: a phone
/// that has not been paired, a host that is too old, a dropped session, a host that never
/// answered, and a host that answered "no" all read identically, and none of them said which. Each
/// now says what it is — and a refusal keeps the host's own reason code, which is the one part of
/// this a bug report actually needs.
String actFailureNotice(Object error) {
  if (error is RemoteActionFailure) {
    return switch (error.code) {
      'joi_clarification_unavailable' => '这张卡片已经不需要回答了，下拉刷新看看最新状态。',
      'joi_retry_unavailable' => '这个任务现在不能继续，下拉刷新看看最新状态。',
      'joi_workbench_invalid' ||
      'joi_partner_selection_invalid' => '你选的工作台或搭档已经不可用了，请重新选择。',
      'remote_operation_forbidden' => '这版 joi 还不支持这个操作，请在电脑端完成。',
      'remote_read_busy' || 'remote_cursor_expired' => 'joi 正在忙，稍后重试。',
      _ => 'joi 没有接受这个操作（${error.code}）。下拉刷新看看最新状态。',
    };
  }
  if (error is TimeoutException) return 'joi 超过 20 秒没有响应，请稍后重试。输入已保留。';
  if (error is StateError) {
    return switch (error.message) {
      'remote_upgrade_required' => '手机端和 joi 的版本不匹配，请在电脑端更新 joi 后重新配对。',
      'joi_remote_not_ready' => '还没和 joi 建立会话，请稍等或重新扫码。',
      'joi_remote_disconnected' => '和 joi 的连接断了，正在重连，稍后重试。输入已保留。',
      _ => '操作未完成，请刷新查看最新状态后重试。输入已保留。',
    };
  }
  return '操作未完成，请刷新查看最新状态后重试。输入已保留。';
}

List<WorkbenchMatchSource> _matchSources(List<RemoteChoice> workbenches) =>
    [
      for (final workbench in workbenches)
        WorkbenchMatchSource(
          name: workbench.name,
          scopeSummary: workbench.description,
          workbenchId: workbench.id,
        ),
    ];

Future<WorkbenchSuggestion?> chooseWorkbenchSuggestion(
  BuildContext context,
  List<WorkbenchSuggestion> suggestions,
) => showModalBottomSheet<WorkbenchSuggestion>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('归到哪里', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 4),
        const Text('优先复用已有工作台；都不合适时再新建一个工作范围。'),
        const SizedBox(height: 12),
        for (final suggestion in suggestions)
          Card(
            clipBehavior: Clip.antiAlias,
            child: ListTile(
              title: Text(suggestion.name),
              subtitle: Text(suggestion.description),
              trailing: Icon(
                suggestion.reusesExisting
                    ? Icons.subdirectory_arrow_right_rounded
                    : Icons.add_rounded,
              ),
              onTap: () => Navigator.pop(context, suggestion),
            ),
          ),
      ],
    ),
  ),
);

class _GoalActionsState extends State<GoalActions> {
  final _draft = TextEditingController();
  bool _showContinue = false;
  bool _busy = false;
  String? _notice;

  /// A workbench this card already created. Remembered so a retry binds it instead of minting a
  /// duplicate — the host returns `bound: false` when the input had already moved on, and that is
  /// recoverable by selecting the workbench, not by creating a second one.
  RemoteWorkbenchCreation? _createdWorkbench;

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  Future<void> _act(
    String action, {
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
  }) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await widget.controller.act(
        widget.goal.goalId,
        action,
        text:
            action == 'retry' ||
                action == 'clarify' &&
                    actionChoice == null &&
                    workbenchId == null &&
                    partnerId == null
            ? _draft.text
            : null,
        workbenchId: workbenchId,
        partnerId: partnerId,
        actionChoice: actionChoice,
        questionId: widget.goal.questionId,
        questionVersion: widget.goal.questionVersion,
      );
      if (mounted) {
        _draft.clear();
        setState(() => _showContinue = false);
        widget.onChanged?.call();
      }
    } catch (error) {
      if (mounted) setState(() => _notice = actFailureNotice(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Apply a picked candidate: reuse an existing workbench, or create the suggested cluster.
  Future<void> _applySuggestion(WorkbenchSuggestion suggestion) async {
    if (_busy) return;
    final existing = suggestion.workbenchId;
    if (existing != null) {
      // Reuse never needs a creation step, so it cannot half-succeed.
      await _act('clarify', workbenchId: existing);
      return;
    }
    if (_createdWorkbench?.name == suggestion.name) {
      await _act('clarify', workbenchId: _createdWorkbench!.id);
      return;
    }
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final created = await widget.controller.createWorkbench(
        inputId: widget.goal.goalId,
        name: suggestion.name,
        personaSummary: suggestion.personaSummary,
        projectLabel: suggestion.projectLabel,
        scopeSummary: suggestion.scopeSummary,
      );
      if (!mounted) return;
      if (created.bound) {
        _createdWorkbench = null;
        widget.onChanged?.call();
        return;
      }
      // The workbench exists; the input had already moved past awaiting one. Selecting it is the
      // way forward, so say that instead of reporting a failure the user cannot act on.
      setState(() {
        _createdWorkbench = created;
        _notice = '「${created.name}」已创建，但这条卡片已经不等待归属了。请在「选择工作台继续」里选它。';
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _notice = _createdWorkbench == null
              ? actFailureNotice(error)
              : '「${_createdWorkbench!.name}」已经建好了，请在「选择工作台继续」里选它。';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller.state;
      final goal = widget.goal;
      final busy =
          _busy ||
          state.busyGoals.contains(goal.goalId) ||
          state.connection != RemoteConnectionState.connected;
      final reason = goal.reasonCode;
      final question = goal.status == 'NEEDS_ATTENTION';
      final workbench = const [
        'workbench_selection_invalid',
        'workbench_creation_unavailable',
        'workbench_not_found',
      ].contains(reason);
      final partner = reason == 'partner_selection_required';
      final resume = const [
        'partner_waiting_recovery_required',
        'partner_auth_required',
      ].contains(reason);
      final continuation = reason == 'goal_continuation_required';
      final directory = reason == 'workbench_workspace_not_ready';
      final historical = reason == 'harness_review_unrecoverable';
      final answer =
          question &&
          !workbench &&
          !partner &&
          !resume &&
          !continuation &&
          !directory &&
          !historical;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (question) ...[
            const SizedBox(height: 12),
            Text(
              goal.prompt ?? 'joi 需要你确认',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
          if (_busy)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('正在提交，请稍候…'),
            ),
          if (directory) const Text('请回到桌面为工作台选择工作目录，然后继续。'),
          if (historical) const Text('请确认历史工作已结束，再安全收尾。'),
          if (workbench || partner)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: busy
                      ? null
                      : () async {
                          final choice = await chooseRemote(
                            context,
                            workbench ? '选择工作台' : '选择搭档',
                            workbench ? state.workbenches : state.partners,
                          );
                          if (choice != null && mounted) {
                            await _act(
                              'clarify',
                              workbenchId: workbench ? choice.id : null,
                              partnerId: partner ? choice.id : null,
                            );
                          }
                        },
                  child: Text(workbench ? '选择工作台继续' : '选择搭档继续'),
                ),
                if (workbench && state.supportsWorkbenchCreation)
                  FilledButton.icon(
                    onPressed: busy
                        ? null
                        : () async {
                            final suggestion = await chooseWorkbenchSuggestion(
                              context,
                              workbenchSuggestions(
                                seed: goal.title,
                                workbenches: _matchSources(state.workbenches),
                              ),
                            );
                            if (suggestion != null && mounted) {
                              await _applySuggestion(suggestion);
                            }
                          },
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('归到哪里'),
                  ),
              ],
            ),
          if (resume)
            FilledButton(
              onPressed: busy
                  ? null
                  : () => _act('clarify', actionChoice: 'RESUME'),
              child: const Text('继续原工作'),
            ),
          if (continuation)
            Wrap(
              spacing: 8,
              children: [
                FilledButton(
                  onPressed: busy
                      ? null
                      : () => _act('clarify', actionChoice: 'CONTINUE'),
                  child: const Text('继续补齐'),
                ),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => _act('clarify', actionChoice: 'ACCEPT_CURRENT'),
                  child: const Text('接受现状'),
                ),
              ],
            ),
          if (historical)
            TextButton(
              onPressed: busy ? null : () => _act('closeHistoricalReview'),
              child: const Text('结束历史整理'),
            ),
          if (answer || _showContinue) ...[
            const SizedBox(height: 8),
            TextField(
              controller: _draft,
              enabled: !busy,
              minLines: 1,
              maxLines: 5,
              maxLength: 8000,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: answer ? '输入回答' : '补充要求（可留空）',
                counterText: '',
              ),
            ),
            FilledButton(
              onPressed: busy || answer && _draft.text.trim().isEmpty
                  ? null
                  : () => _act(answer ? 'clarify' : 'retry'),
              child: Text(answer ? '回答并继续' : '提交继续'),
            ),
          ],
          Wrap(
            spacing: 8,
            children: [
              if (goal.terminal)
                TextButton(
                  onPressed: busy
                      ? null
                      : () => setState(() => _showContinue = !_showContinue),
                  child: Text(_showContinue ? '收起' : '继续对话'),
                ),
              if (goal.canCancel)
                TextButton(
                  onPressed: busy ? null : () => _act('cancel'),
                  child: const Text('取消任务'),
                ),
              if (goal.canDelete)
                TextButton(
                  onPressed: busy ? null : () => _act('dismiss'),
                  child: const Text('移除卡片'),
                ),
            ],
          ),
          if (_notice != null)
            Text(
              _notice!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
        ],
      );
    },
  );
}

class GoalDetailPage extends StatefulWidget {
  const GoalDetailPage({
    super.key,
    required this.controller,
    required this.initial,
  });
  final RemoteController controller;
  final RemoteGoalCard initial;
  @override
  State<GoalDetailPage> createState() => _GoalDetailPageState();
}

class _GoalDetailPageState extends State<GoalDetailPage>
    with WidgetsBindingObserver {
  late RemoteGoalCard _goal;
  String? _text;
  String? _error;
  List<Map<String, dynamic>> _agents = [];
  Map<String, dynamic> _facts = {};
  String? _cursor;
  bool _loading = false;
  bool _foreground = true;
  Timer? _timer;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _goal = widget.initial;
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
    _timer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_foreground &&
          ModalRoute.of(context)?.isCurrent == true &&
          widget.controller.state.connection ==
              RemoteConnectionState.connected) {
        unawaited(_load());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    if (_loading) return;
    _loading = true;
    final generation = _generation;
    try {
      final detail = more
          ? null
          : await widget.controller.read('goal.get', goalId: _goal.goalId);
      final agents = await widget.controller.read(
        'goal.agents',
        goalId: _goal.goalId,
        cursor: more ? _cursor : null,
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        if (detail != null) {
          _text = detail['text'] as String?;
          final value = detail['goal'] ?? detail['action'];
          if (value is Map<String, dynamic>) {
            _goal = RemoteGoalCard.fromJson(value);
            _facts = value;
          }
        }
        final next = (agents['items'] as List? ?? [])
            .whereType<Map<String, dynamic>>()
            .toList();
        _agents = more
            ? [
                ..._agents,
                ...next.where(
                  (a) => !_agents.any((old) => old['agentId'] == a['agentId']),
                ),
              ]
            : [
                ...next,
                ..._agents.where(
                  (old) => !next.any((a) => a['agentId'] == old['agentId']),
                ),
              ];
        if (more || _agents.length <= next.length) {
          _cursor = agents['nextCursor'] as String?;
        }
        _error = null;
      });
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(() => _error = '未能读取最新详情，任务可能已变化或连接中断。');
      }
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('任务详情'),
      actions: [
        IconButton(
          tooltip: '刷新',
          onPressed: () => _load(),
          icon: const Icon(Icons.refresh),
        ),
        ConnectionDiagnosticsButton(controller: widget.controller),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(_goal.workbenchName),
        Text(_goal.title, style: Theme.of(context).textTheme.headlineSmall),
        Text(statusLabel(_goal.status)),
        if (_error != null) Text(_error!),
        if (_text == null && _error == null)
          const LinearProgressIndicator()
        else if (_text != null) ...[
          const SizedBox(height: 20),
          const Text('任务正文'),
          const SizedBox(height: 8),
          MessageBody(_text!),
        ],
        if (_goal.summary != null) ...[
          const Divider(height: 32),
          TextButton(
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => ResultReaderPage(
                  controller: widget.controller,
                  goal: _goal,
                ),
              ),
            ),
            child: const Text('最终结果 · 查看全文'),
          ),
          MessageBody(_goal.summary!),
        ],
        if (_facts['failure'] case final Map<String, dynamic> failure) ...[
          const Divider(height: 32),
          Text(failure['executionStarted'] == true ? '任务执行未完成' : '任务尚未开始执行'),
          Text(switch (failure['suggestedAction']) {
            'CHECK_MODEL_SOURCE' => '请在电脑端检查模型来源与连接配置。',
            'RESTART_OR_UPDATE' => '请在电脑端重启或更新 joi 后重试。',
            _ => '可以继续对话重试，或在电脑端查看诊断。',
          }),
        ],
        if (_facts['harness'] case final Map<String, dynamic> harness) ...[
          const Divider(height: 32),
          const Text('任务进展'),
          if (harness['destination'] case final String destination)
            MessageBody(destination),
          Text(
            '已决策 ${harness['decisionCount'] ?? 0} · 待确认 ${harness['fogCount'] ?? 0} · 待探索 ${harness['openPathCount'] ?? 0}',
          ),
          if (harness['topFogNote'] case final String note) MessageBody(note),
        ],
        if ((_facts['artifacts'] as List? ?? []).isNotEmpty) ...[
          const Divider(height: 32),
          const Text('产物信息（请在电脑端打开）'),
          for (final artifact
              in (_facts['artifacts'] as List)
                  .whereType<Map<String, dynamic>>())
            ListTile(
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: Text(artifact['name'] as String? ?? '产物'),
              subtitle: Text(
                '${artifact['mimeType'] ?? ''} · ${artifact['size'] ?? 0} 字节',
              ),
            ),
        ],
        GoalActions(
          key: ValueKey(_goal.goalId),
          controller: widget.controller,
          goal: _goal,
          onChanged: () {
            unawaited(_load());
          },
        ),
        const Divider(height: 32),
        Text('搭档工作记录', style: Theme.of(context).textTheme.titleLarge),
        if (_agents.isEmpty)
          const Padding(padding: EdgeInsets.all(12), child: Text('还没有搭档工作记录。')),
        for (final agent in _agents)
          ListTile(
            title: Text(agent['partnerName'] as String? ?? '搭档'),
            subtitle: Text(
              statusLabel(agent['status'] as String? ?? 'UNKNOWN'),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => AgentRecordPage(
                  controller: widget.controller,
                  goalId: _goal.goalId,
                  agent: agent,
                ),
              ),
            ),
          ),
        if (_cursor != null)
          TextButton(
            onPressed: () => _load(more: true),
            child: const Text('更多搭档'),
          ),
      ],
    ),
  );
}

class AgentRecordPage extends StatefulWidget {
  const AgentRecordPage({
    super.key,
    required this.controller,
    required this.goalId,
    required this.agent,
  });
  final RemoteController controller;
  final String goalId;
  final Map<String, dynamic> agent;
  @override
  State<AgentRecordPage> createState() => _AgentRecordPageState();
}

class _AgentRecordPageState extends State<AgentRecordPage>
    with WidgetsBindingObserver {
  List<Map<String, dynamic>> _items = [];
  String? _cursor;
  String? _error;
  late String _status;
  bool _loading = false;
  bool _foreground = true;
  int _generation = 0;
  int _loadedPages = 1;
  Timer? _timer;
  @override
  void initState() {
    super.initState();
    _status = widget.agent['status'] as String? ?? 'UNKNOWN';
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_foreground &&
          ['RUNNING', 'WAITING'].contains(_status) &&
          ModalRoute.of(context)?.isCurrent == true &&
          widget.controller.state.connection ==
              RemoteConnectionState.connected) {
        unawaited(_load());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    if (_loading) return;
    _loading = true;
    final generation = _generation;
    try {
      // Live snapshots replace run entries, so rebuild the loaded window rather
      // than append stale entries from older revisions of the same run.
      var cursor = more ? _cursor : null;
      final items = <Map<String, dynamic>>[];
      var pages = 0;
      var status = _status;
      do {
        final page = await widget.controller.read(
          'agent.conversation',
          goalId: widget.goalId,
          agentId: widget.agent['agentId'] as String,
          cursor: cursor,
        );
        if (!mounted || generation != _generation) return;
        items.addAll(
          (page['items'] as List? ?? []).whereType<Map<String, dynamic>>(),
        );
        cursor = page['nextCursor'] as String?;
        status =
            (page['agent'] as Map<String, dynamic>?)?['status'] as String? ??
            status;
        pages++;
      } while (!more && cursor != null && pages < _loadedPages);
      setState(() {
        final merged = more ? [..._items, ...items] : items;
        _items = {
          for (final item in merged) item['entryId']: item,
        }.values.toList();
        _cursor = cursor;
        _status = status;
        _error = null;
        _loadedPages = more ? _loadedPages + 1 : pages;
      });
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(() => _error = '记录读取失败，请刷新重试。');
      }
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.agent['partnerName'] as String? ?? '搭档记录'),
      actions: [
        IconButton(
          tooltip: '刷新',
          onPressed: () => _load(),
          icon: const Icon(Icons.refresh),
        ),
        ConnectionDiagnosticsButton(controller: widget.controller),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(statusLabel(_status)),
        if (_error != null) Text(_error!),
        if (_items.isEmpty)
          const Padding(padding: EdgeInsets.all(20), child: Text('暂无可展示的记录。')),
        for (final item in _items)
          Card(
            key: ValueKey(item['entryId']),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child:
                  item['kind'] == 'TOOL_CALL' || item['kind'] == 'TOOL_RESULT'
                  ? ExpansionTile(
                      title: Text(
                        item['toolName'] as String? ??
                            (item['kind'] == 'TOOL_CALL' ? '工具调用' : '工具结果'),
                      ),
                      children: [
                        MessageBody(item['text'] as String? ?? '没有额外可展示的内容。'),
                      ],
                    )
                  : item['kind'] == 'ARTIFACT'
                  ? ListTile(
                      leading: const Icon(Icons.insert_drive_file_outlined),
                      title: Text(
                        (item['artifact'] as Map<String, dynamic>?)?['name']
                                as String? ??
                            '产物',
                      ),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          const {
                                'USER': '用户',
                                'AGENT': '搭档',
                                'SYSTEM': '系统',
                                'TOOL': '工具',
                              }[item['role']] ??
                              '消息',
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                        const SizedBox(height: 8),
                        MessageBody(item['text'] as String? ?? ''),
                      ],
                    ),
            ),
          ),
        if (_cursor != null)
          TextButton(
            onPressed: () => _load(more: true),
            child: const Text('加载更多记录'),
          ),
      ],
    ),
  );
}
