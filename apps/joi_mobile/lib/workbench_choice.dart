import 'package:flutter/material.dart';
import 'remote_controller.dart';

Future<bool?> showWorkbenchChoice(
  BuildContext context,
  RemoteController controller,
  RemoteGoalCard goal,
) => showModalBottomSheet<bool>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  isDismissible: false,
  enableDrag: false,
  builder: (_) => _WorkbenchChoice(controller: controller, goal: goal),
);

class _WorkbenchChoice extends StatefulWidget {
  const _WorkbenchChoice({required this.controller, required this.goal});
  final RemoteController controller;
  final RemoteGoalCard goal;
  @override
  State<_WorkbenchChoice> createState() => _WorkbenchChoiceState();
}

class _WorkbenchChoiceState extends State<_WorkbenchChoice> {
  late final _name = TextEditingController(
    text: widget.goal.workbenchProposal?.name,
  );
  late final _project = TextEditingController(
    text: widget.goal.workbenchProposal?.projectLabel,
  );
  late final _scope = TextEditingController(
    text: widget.goal.workbenchProposal?.scopeSummary,
  );
  String _query = '';
  bool _creating = false;
  bool _busy = false;
  String? _error;
  RemoteWorkbenchCreation? _created;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_checkQuestion);
  }

  void _checkQuestion() {
    final current = widget.controller.state.goals
        .where((goal) => goal.goalId == widget.goal.goalId)
        .firstOrNull;
    if (_closing ||
        current == null ||
        current.needsWorkbenchChoice &&
            current.questionId == widget.goal.questionId &&
            current.questionVersion == widget.goal.questionVersion) {
      return;
    }
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) {
        Navigator.pop(context, true);
      }
    });
  }

  @override
  void dispose() {
    widget.controller.removeListener(_checkQuestion);
    _name.dispose();
    _project.dispose();
    _scope.dispose();
    super.dispose();
  }

  Future<void> _submit([String? workbenchId]) async {
    if (_busy) return;
    workbenchId ??= _created?.id;
    if (workbenchId == null &&
        [_name, _project, _scope].any((field) => field.text.trim().isEmpty)) {
      setState(() => _error = '请填写工作台名称、工程名称和工作范围。');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final goal = widget.goal;
    try {
      if (workbenchId != null) {
        await widget.controller.act(
          goal.goalId,
          'clarify',
          workbenchId: workbenchId,
          questionId: goal.questionId,
          questionVersion: goal.questionVersion,
        );
      } else {
        final created = await widget.controller.createWorkbench(
          inputId: goal.goalId,
          name: _name.text.trim(),
          projectLabel: _project.text.trim(),
          scopeSummary: _scope.text.trim(),
          personaSummary: '围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。',
          questionId: goal.questionId ?? 'legacy_question:${goal.goalId}',
          questionVersion: goal.questionVersion ?? 1,
          idempotencyKey:
              'workbench-choice:${goal.goalId}:v${goal.questionVersion ?? 1}',
        );
        if (!created.bound) {
          if (mounted) {
            setState(() {
              _created = created;
              _error = '工作台已创建，请刷新任务状态后选择它继续。';
            });
          }
          return;
        }
      }
      if (mounted && !_closing) {
        _closing = true;
        Navigator.pop(context, true);
      }
    } catch (_) {
      if (mounted) setState(() => _error = '工作台选择未完成，请刷新任务状态后重试。已保留填写内容。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller.state;
      final busy = _busy || state.connection != RemoteConnectionState.connected;
      final visible = state.workbenches.where(
        (workbench) => '${workbench.name} ${workbench.description}'
            .toLowerCase()
            .contains(_query.trim().toLowerCase()),
      );
      return PopScope(
        canPop: !_busy,
        child: Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .85,
            ),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '选择工作台',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => Navigator.pop(context, false),
                        child: const Text('稍后选择'),
                      ),
                    ],
                  ),
                  const Text('请选择这条任务的工作台，或创建一个独立的工作范围。确认后 Joi 再开始安排。'),
                  const SizedBox(height: 16),
                  if (_creating) ...[
                    TextField(
                      controller: _name,
                      enabled: !busy,
                      maxLength: 80,
                      decoration: const InputDecoration(labelText: '工作台名称'),
                    ),
                    TextField(
                      controller: _project,
                      enabled: !busy,
                      maxLength: 120,
                      decoration: const InputDecoration(labelText: '工程名称'),
                    ),
                    TextField(
                      controller: _scope,
                      enabled: !busy,
                      maxLength: 1000,
                      minLines: 3,
                      maxLines: 6,
                      decoration: const InputDecoration(labelText: '工作范围'),
                    ),
                    FilledButton(
                      onPressed: busy ? null : () => _submit(),
                      child: Text(
                        _busy
                            ? '正在提交…'
                            : _created == null
                            ? '创建并继续'
                            : '选择已创建的工作台继续',
                      ),
                    ),
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => setState(() {
                              _creating = false;
                              _error = null;
                            }),
                      child: const Text('返回选择'),
                    ),
                  ] else ...[
                    if (state.workbenches.length > 6)
                      TextField(
                        enabled: !busy,
                        onChanged: (value) => setState(() => _query = value),
                        decoration: const InputDecoration(labelText: '搜索工作台'),
                      ),
                    for (final workbench in visible)
                      ListTile(
                        title: Text(workbench.name),
                        subtitle: Text(workbench.description),
                        enabled: !busy,
                        onTap: busy ? null : () => _submit(workbench.id),
                      ),
                    if (visible.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Text('没有匹配的工作台，可以新建。'),
                      ),
                    if (state.supportsWorkbenchCreation)
                      FilledButton.icon(
                        onPressed: busy
                            ? null
                            : () => setState(() => _creating = true),
                        icon: const Icon(Icons.add_rounded),
                        label: const Text('新建工作台'),
                      ),
                  ],
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}
