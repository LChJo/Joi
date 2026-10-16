import 'i18n.dart';
import 'package:flutter/material.dart';
import 'remote_controller.dart';
import 'workbench_suggestions.dart';

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
  late final _choices = workbenchCreationSuggestions(
    seed: widget.goal.title,
    proposalName: widget.goal.workbenchProposal?.name,
    proposalProjectLabel: widget.goal.workbenchProposal?.projectLabel,
    proposalScopeSummary: widget.goal.workbenchProposal?.scopeSummary,
  );
  final _name = TextEditingController();
  final _project = TextEditingController();
  final _scope = TextEditingController();
  bool _manual = false;
  String _query = '';
  bool _busy = false;
  Object? _error;
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

  Future<void> _submit({
    String? workbenchId,
    WorkbenchSuggestion? choice,
    int? index,
  }) async {
    if (_busy) return;
    if (workbenchId == null && choice == null) {
      if (!_manual) return;
      if ([_name, _project, _scope].any((field) => field.text.trim().isEmpty)) {
        setState(
          () => _error = UiNotice(
            Msg.mobileEnterAWorkbenchNameProjectNameAndWorkScope,
          ),
        );
        return;
      }
      choice = WorkbenchSuggestion(
        description: '',
        kind: 'template',
        name: _name.text.trim(),
        projectLabel: _project.text.trim(),
        scopeSummary: _scope.text.trim(),
        personaSummary: '围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。',
      );
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
          name: choice!.name,
          projectLabel: choice.projectLabel,
          scopeSummary: choice.scopeSummary,
          personaSummary: choice.personaSummary,
          questionId: goal.questionId ?? 'legacy_question:${goal.goalId}',
          questionVersion: goal.questionVersion ?? 1,
          idempotencyKey:
              'workbench-choice:${goal.goalId}:v${goal.questionVersion ?? 1}:${index == null ? 'manual' : 'option:$index'}',
        );
        if (!created.bound) {
          if (mounted) {
            setState(() {
              _created = created;
              _error = UiNotice(
                Msg.mobileWorkbenchCreatedRefreshTaskStatusAndChooseItTo,
              );
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
      if (mounted) {
        setState(
          () => _error = UiNotice(
            Msg.workbenchesWorkbenchSelectionDidNotCompleteRefreshTaskStatusAnd,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        dependOnUiLocale(context);
        final state = widget.controller.state;
        final busy =
            _busy || state.connection != RemoteConnectionState.connected;
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
                            tr(Msg.homeChooseWorkbench),
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => Navigator.pop(context, false),
                          child: Text(tr(Msg.workbenchesChooseLater)),
                        ),
                      ],
                    ),
                    Text(
                      tr(
                        Msg.workbenchesChooseAnExistingWorkbenchOrCreateASeparateScope,
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (_manual) ...[
                      TextField(
                        controller: _name,
                        enabled: !busy && _created == null,
                        autofocus: true,
                        maxLength: 80,
                        decoration: InputDecoration(
                          labelText: tr(Msg.workbenchesWorkbenchName),
                        ),
                      ),
                      TextField(
                        controller: _project,
                        enabled: !busy && _created == null,
                        maxLength: 120,
                        decoration: InputDecoration(
                          labelText: tr(Msg.homeProjectName),
                        ),
                      ),
                      TextField(
                        controller: _scope,
                        enabled: !busy && _created == null,
                        maxLength: 1000,
                        minLines: 3,
                        maxLines: 6,
                        decoration: InputDecoration(
                          labelText: tr(Msg.workbenchesWorkScope),
                        ),
                      ),
                      FilledButton(
                        onPressed: busy
                            ? null
                            : () => _submit(workbenchId: _created?.id),
                        child: Text(
                          _created == null
                              ? tr(Msg.workbenchesCreateAndContinue)
                              : tr(
                                  Msg.mobileChooseTheCreatedWorkbenchToContinue,
                                ),
                        ),
                      ),
                      TextButton(
                        onPressed: busy || _created != null
                            ? null
                            : () => setState(() {
                                _manual = false;
                                _error = null;
                              }),
                        child: Text(tr(Msg.workbenchesBackToSelection)),
                      ),
                    ] else ...[
                      if (state.workbenches.length > 6)
                        TextField(
                          enabled: !busy,
                          onChanged: (value) => setState(() => _query = value),
                          decoration: InputDecoration(
                            labelText: tr(Msg.homeSearchWorkbenches),
                          ),
                        ),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: MediaQuery.sizeOf(context).height * .25,
                        ),
                        child: ListView(
                          shrinkWrap: true,
                          children: [
                            for (final workbench in visible)
                              ListTile(
                                title: Text(workbench.name),
                                subtitle: Text(workbench.description),
                                enabled: !busy,
                                onTap: busy
                                    ? null
                                    : () => _submit(workbenchId: workbench.id),
                              ),
                            if (visible.isEmpty)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 12,
                                ),
                                child: Text(
                                  tr(
                                    Msg.workbenchesNoMatchingWorkbenchesYouCanCreateOne,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (state.supportsWorkbenchCreation) ...[
                        const Divider(height: 24),
                        Text(
                          tr(Msg.workbenchesPreparedChoices),
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 8),
                        if (_created != null)
                          FilledButton(
                            onPressed: busy
                                ? null
                                : () => _submit(workbenchId: _created!.id),
                            child: Text(
                              tr(Msg.mobileChooseTheCreatedWorkbenchToContinue),
                            ),
                          ),
                        for (var index = 0; index < _choices.length; index++)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Card(
                              margin: EdgeInsets.zero,
                              child: ListTile(
                                title: Text(_choices[index].name),
                                subtitle: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(tr(Msg.workbenchesAutoGenerated)),
                                    Text(_choices[index].scopeSummary),
                                    const SizedBox(height: 6),
                                    Text(
                                      tr(Msg.workbenchesCreateAndContinue),
                                      style: TextStyle(
                                        color: Theme.of(
                                          context,
                                        ).colorScheme.primary,
                                      ),
                                    ),
                                  ],
                                ),
                                enabled: !busy && _created == null,
                                onTap: busy || _created != null
                                    ? null
                                    : () => _submit(
                                        choice: _choices[index],
                                        index: index,
                                      ),
                              ),
                            ),
                          ),
                        Card(
                          margin: EdgeInsets.zero,
                          child: ListTile(
                            leading: const Icon(Icons.add_rounded),
                            title: Text(tr(Msg.workbenchesManualCreate)),
                            subtitle: Text(
                              tr(Msg.workbenchesManualCreateDescription),
                            ),
                            enabled: !busy && _created == null,
                            onTap: busy || _created != null
                                ? null
                                : () => setState(() {
                                    _manual = true;
                                    _error = null;
                                  }),
                          ),
                        ),
                      ],
                    ],
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Text(
                          noticeText(_error!),
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
    ),
  );
}
