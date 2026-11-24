import 'i18n.dart';
import 'result_reader.dart';
import 'result_history.dart';
import 'goal_artifacts.dart';
import 'goal_route_map.dart';
import 'i18n_messages.dart' show errorMessageKeys, sourceMessageKeys;
import 'connection_diagnostics_view.dart';
import 'composer_text_field.dart';
import 'conversation_output.dart';
import 'message_body.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'remote_controller.dart';
import 'user_question_card.dart';
import 'workbench_choice.dart';
import 'home_screen.dart';

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

/// A refusal retains its message key so an open notice follows the selected language.
UiNotice actFailureMessage(Object error) {
  if (error is RemoteActionFailure) {
    return switch (error.code) {
      'joi_clarification_unavailable' => UiNotice(
        Msg.mobileThisCardNoLongerNeedsAnAnswerPullDown,
      ),
      'joi_retry_unavailable' => UiNotice(
        Msg.mobileThisTaskCannotContinueRightNowPullDownTo,
      ),
      'joi_workbench_invalid' || 'joi_partner_selection_invalid' => UiNotice(
        Msg.mobileTheSelectedWorkbenchOrPartnerIsUnavailableChooseAnother,
      ),
      'remote_operation_forbidden' => UiNotice(
        Msg.mobileThisVersionOfJoiDoesNotSupportTheAction,
      ),
      'remote_read_busy' ||
      'remote_cursor_expired' => UiNotice(Msg.mobileJoiIsBusyTryAgainLater),
      _ => UiNotice(Msg.mobileJoiDeclinedThisActionValuePullDownToRefresh, {
        'p0': (error.code).toString(),
      }),
    };
  }
  if (error is TimeoutException) {
    return UiNotice(Msg.mobileJoiDidNotRespondWithin20SecondsTryAgain);
  }
  if (error is StateError) {
    return switch (error.message) {
      'remote_upgrade_required' => UiNotice(
        Msg.mobileThePhoneAndDesktopVersionsDoNotMatchUpdate,
      ),
      'joi_remote_not_ready' => UiNotice(
        Msg.mobileNoSessionWithJoiYetWaitAMomentOr,
      ),
      'joi_remote_disconnected' => UiNotice(
        Msg.mobileDisconnectedFromJoiAndReconnectingTryAgainLaterYour,
      ),
      _ => UiNotice(Msg.mobileTheActionDidNotCompleteRefreshTheLatestStatus),
    };
  }
  return UiNotice(Msg.mobileTheActionDidNotCompleteRefreshTheLatestStatus);
}

String actFailureNotice(Object error) => noticeText(actFailureMessage(error));

class _GoalActionsState extends State<GoalActions> {
  final _draft = TextEditingController();
  bool _showContinue = false;
  bool _showReviewRequirements = false;
  bool _busy = false;
  Object? _notice;

  @override
  void didUpdateWidget(covariant GoalActions oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.goal.goalId != widget.goal.goalId ||
        oldWidget.goal.questionId != widget.goal.questionId ||
        oldWidget.goal.questionVersion != widget.goal.questionVersion) {
      _showReviewRequirements = false;
      _draft.clear();
    }
  }

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
        setState(() {
          _showContinue = false;
          _showReviewRequirements = false;
        });
        widget.onChanged?.call();
      }
    } catch (error) {
      if (mounted) setState(() => _notice = actFailureMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The card's secondary menu.
  ///
  /// A bottom sheet rather than a popup menu: the items are full sentences and this is a phone, so
  /// the same list the desktop renders as a dropdown arrives here as something a thumb can hit. The
  /// sheet only collects a choice — the guard that decides what is offerable stays in this widget,
  /// so the two clients cannot drift on which actions a card has.
  Future<void> _openActions() async {
    final goal = widget.goal;
    final choice = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (goal.terminal)
              ListTile(
                leading: const Icon(Icons.play_arrow_rounded),
                title: Text(
                  _showContinue
                      ? tr(Msg.mobileCollapseAdditionalInput)
                      : tr(Msg.mobileContinueConversation),
                ),
                onTap: () => Navigator.pop(context, 'continue'),
              ),
            if (!goal.terminal)
              ListTile(
                leading: const Icon(Icons.stop_circle_outlined),
                title: Text(tr(Msg.homeCancelTask)),
                onTap: () => Navigator.pop(context, 'cancel'),
              ),
            if (goal.archived)
              ListTile(
                leading: const Icon(Icons.unarchive_outlined),
                title: Text(tr(Msg.commonUnarchive)),
                onTap: () => Navigator.pop(context, 'unarchive'),
              )
            else if (goal.canArchive)
              ListTile(
                leading: const Icon(Icons.archive_outlined),
                title: Text(tr(Msg.commonArchive)),
                onTap: () => Navigator.pop(context, 'archive'),
              ),
            if (goal.canDelete)
              ListTile(
                leading: Icon(
                  Icons.delete_outline_rounded,
                  color: Theme.of(context).colorScheme.error,
                ),
                title: Text(
                  tr(Msg.mobileRemoveCard),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                onTap: () => Navigator.pop(context, 'dismiss'),
              ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'continue') {
      setState(() => _showContinue = !_showContinue);
      return;
    }
    await _act(choice);
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        dependOnUiLocale(context);
        final state = widget.controller.state;
        final goal = widget.goal;
        final busy =
            _busy ||
            state.busyGoals.contains(goal.goalId) ||
            state.connection != RemoteConnectionState.connected;
        final reason = goal.reasonCode;
        final queueCurrent =
            goal.questions.isNotEmpty &&
            (reason == null || reason == 'question_required');
        final question = goal.status == 'NEEDS_ATTENTION' && !queueCurrent;
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
        final continuation = goal.needsContinuationDecision;
        final continuationSummary = goal.summary?.trim();
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
        final VoidCallback? submitDraft =
            busy || (answer || historical) && _draft.text.trim().isEmpty
            ? null
            : () => _act(answer || historical ? 'clarify' : 'retry');
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final queuedQuestion in goal.questions.where(
              isPendingQuestion,
            ))
              UserQuestionCard(
                key: ValueKey(queuedQuestion.identity),
                question: queuedQuestion,
                compact: true,
                supported:
                    widget.controller is QuestionRemoteController &&
                    (widget.controller as QuestionRemoteController)
                        .supportsQuestions,
                onAnswer: (input) async {
                  final controller = widget.controller;
                  if (controller is! QuestionRemoteController) {
                    throw const RemoteActionFailure('remote_upgrade_required');
                  }
                  await (controller as QuestionRemoteController).answerQuestion(
                    'GOAL',
                    goal.goalId,
                    queuedQuestion.questionId,
                    input,
                  );
                  widget.onChanged?.call();
                },
              ),
            if (question) ...[
              const SizedBox(height: 12),
              if (historical) ...[
                Text(
                  tr(Msg.homeHistoricalReviewPaused),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 8),
              ],
              if (continuation) ...[
                Text(
                  tr(Msg.homeContinueImprovingTheResult),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 8),
              ],
              Text(
                continuation
                    ? tr(
                        sourceMessageKeys[goal.prompt] ==
                                Msg.homeContinuationStalledHint
                            ? Msg.homeContinuationStalledHint
                            : Msg.homeTheResultStillNeedsAdditionsOrVerificationThisRound,
                      )
                    : historical
                    ? tr(Msg.homeHistoricalReviewRecoveryHint)
                    : goal.prompt ?? tr(Msg.homeJoiNeedsYourConfirmation),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
            if (continuation) ...[
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  border: Border.all(
                    color: Theme.of(context).colorScheme.outlineVariant,
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      tr(Msg.homeCurrentResultAndRemainingWork),
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 8),
                    if (continuationSummary != null &&
                        continuationSummary.isNotEmpty) ...[
                      Text(
                        continuationSummary,
                        maxLines: 6,
                        overflow: TextOverflow.ellipsis,
                      ),
                      TextButton(
                        onPressed: busy
                            ? null
                            : () => Navigator.push(
                                context,
                                MaterialPageRoute(
                                  builder: (_) => ResultReaderPage(
                                    controller: widget.controller,
                                    goal: goal,
                                  ),
                                ),
                              ),
                        child: Text(tr(Msg.homeViewTheFullCurrentResult)),
                      ),
                    ] else
                      Text(
                        tr(
                          Msg.homeNoResultNotesAreAvailableYetToIdentifySpecific,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text(
                tr(Msg.homeContinueImprovingTryUpToTwoMoreRoundsYou),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 4),
              Text(
                tr(Msg.homeKeepCurrentResultEndThisTaskPreserveConclusionsAnd),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
            ],
            if (_busy)
              Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(tr(Msg.mobileSubmittingPleaseWait)),
              ),
            if (directory)
              Text(tr(Msg.mobileChooseAWorkingDirectoryForThisWorkbenchOnThe)),
            if (historical)
              Text(
                tr(Msg.homeExistingAnswersAndResultsArePreservedJoiWillReview),
              ),
            if (workbench)
              FilledButton(
                onPressed: busy
                    ? null
                    : () async {
                        final resolved = await showWorkbenchChoice(
                          context,
                          widget.controller,
                          widget.goal,
                        );
                        if (resolved == true) widget.onChanged?.call();
                      },
                child: Text(tr(Msg.mobileChooseAWorkbenchToContinue)),
              ),
            if (partner)
              OutlinedButton(
                onPressed: busy
                    ? null
                    : () async {
                        final choice = await chooseRemote(
                          context,
                          tr(Msg.mobileChoosePartner),
                          state.partners,
                        );
                        if (choice != null && mounted) {
                          await _act('clarify', partnerId: choice.id);
                        }
                      },
                child: Text(tr(Msg.mobileChooseAPartnerToContinue)),
              ),
            if (resume)
              FilledButton(
                onPressed: busy
                    ? null
                    : () => _act('clarify', actionChoice: 'RESUME'),
                child: Text(tr(Msg.homeResumeOriginalWorkfa2119)),
              ),
            if (continuation)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => _act('clarify', actionChoice: 'CONTINUE'),
                    child: Text(tr(Msg.homeContinueImproving)),
                  ),
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => _act('clarify', actionChoice: 'ACCEPT_CURRENT'),
                    child: Text(tr(Msg.homeKeepCurrentResult)),
                  ),
                ],
              ),
            if (historical)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => _act('clarify', actionChoice: 'RESUME'),
                    child: Text(tr(Msg.homeRecheckAndContinue)),
                  ),
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => setState(
                            () => _showReviewRequirements =
                                !_showReviewRequirements,
                          ),
                    child: Text(tr(Msg.homeOptionalReviewRequirements)),
                  ),
                ],
              ),
            if (answer ||
                historical && _showReviewRequirements ||
                _showContinue) ...[
              const SizedBox(height: 8),
              ComposerTextField(
                controller: _draft,
                enabled: !busy,
                maxLength: 8000,
                onChanged: (_) => setState(() {}),
                onSend: submitDraft,
                decoration: InputDecoration(
                  labelText: answer
                      ? tr(Msg.mobileEnterYourAnswer)
                      : tr(Msg.mobileAdditionalRequirementsOptional),
                  counterText: '',
                ),
              ),
              FilledButton(
                onPressed: submitDraft,
                child: Text(
                  historical
                      ? tr(Msg.homeAddDetailsAndContinue)
                      : answer
                      ? tr(Msg.homeAnswerAndContinue)
                      : tr(Msg.mobileSubmitContinuation),
                ),
              ),
            ],
            // One icon button instead of a row of links that grew with every action the card learned.
            Align(
              alignment: Alignment.centerRight,
              child: IconButton(
                tooltip: tr(Msg.mobileMoreActions),
                icon: const Icon(Icons.more_horiz_rounded),
                onPressed: busy ? null : () => _openActions(),
              ),
            ),
            if (_notice != null)
              Text(
                noticeText(_notice!),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        );
      },
    ),
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
  static const _maxAgentPages = 4;
  late RemoteGoalCard _goal;
  String? _text;
  Object? _error;
  List<Map<String, dynamic>> _agents = [];
  Map<String, dynamic> _facts = {};
  String? _cursor;
  int _agentPages = 1;
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
    if (_loading || (more && _cursor == null)) return;
    _loading = true;
    final generation = _generation;
    try {
      if (!more) {
        final detail = await widget.controller.read(
          'goal.get',
          goalId: _goal.goalId,
        );
        if (!mounted || generation != _generation) return;
        setState(() {
          _text = detail['text'] as String?;
          final value = detail['goal'] ?? detail['action'];
          if (value is Map<String, dynamic>) {
            _goal = RemoteGoalCard.fromJson(value);
            _facts = value;
          }
        });
      }
      final rows = <Map<String, dynamic>>[if (more) ..._agents];
      final ids = rows.map((row) => row['agentId']).toSet();
      var pages = more ? _agentPages : 0;
      var cursor = more ? _cursor : null;
      do {
        final agents = await widget.controller.read(
          'goal.agents',
          goalId: _goal.goalId,
          cursor: cursor,
        );
        if (!mounted || generation != _generation) return;
        rows.addAll(
          (agents['items'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .where((row) => ids.add(row['agentId'])),
        );
        cursor = agents['nextCursor'] as String?;
        pages++;
      } while (!more && cursor != null && pages < _agentPages);
      setState(() {
        _agents = rows;
        _agentPages = pages;
        _cursor = pages < _maxAgentPages ? cursor : null;
        _error = null;
      });
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () => _error = UiNotice(
            Msg.mobileCouldNotLoadTheLatestDetailsTheTaskMay,
          ),
        );
      }
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => Scaffold(
      appBar: AppBar(
        title: Text(tr(Msg.mobileTaskDetails)),
        actions: [
          IconButton(
            tooltip: tr(Msg.mobileRefresh),
            onPressed: () => _load(),
            icon: const Icon(Icons.refresh),
          ),
          ConnectionDiagnosticsButton(controller: widget.controller),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(goalWorkbenchName(_goal)),
          Text(
            goalTitle(_goal),
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          Text(goalStatusLabel(_goal)),
          Text(goalProgressLabel(_goal)),
          if (goalRecoveryHint(_goal) case final String hint) Text(hint),
          if (_error != null) Text(noticeText(_error!)),
          if (_text == null && _error == null)
            const LinearProgressIndicator()
          else if (_text != null) ...[
            const SizedBox(height: 20),
            Text(tr(Msg.mobileTaskContent)),
            const SizedBox(height: 8),
            MessageBody(_text!),
          ],
          if (_goal.summary != null && !_goal.needsContinuationDecision) ...[
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
              child: Text(tr(Msg.mobileFinalResultViewFullText)),
            ),
            MessageBody(_goal.summary!),
          ],
          AnimatedBuilder(
            animation: widget.controller,
            builder: (context, _) =>
                widget.controller.state.supportsResultHistory
                ? TextButton.icon(
                    onPressed: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => ResultHistoryPage(
                          controller: widget.controller,
                          goal: _goal,
                        ),
                      ),
                    ),
                    icon: const Icon(Icons.history),
                    label: Text(tr(Msg.homeResultHistory)),
                  )
                : const SizedBox.shrink(),
          ),
          if (_facts['failure'] case final Map<String, dynamic> failure) ...[
            const Divider(height: 32),
            Text(
              failure['executionStarted'] == true
                  ? tr(Msg.mobileTaskExecutionDidNotFinish)
                  : tr(Msg.mobileTaskExecutionHasNotStarted),
            ),
            if (errorMessageKeys[failure['reasonCode']] case final Msg reason)
              Text(tr(reason)),
            Text(switch (failure) {
              {'reasonCode': final String reason}
                  when reason.startsWith('goal_synthesis_') =>
                tr(Msg.homeRetrySynthesisWithExistingWork),
              {'suggestedAction': 'CHECK_MODEL_SOURCE'} => tr(
                Msg.mobileCheckTheModelSourceAndConnectionSettingsOnThe,
              ),
              {'suggestedAction': 'RESTART_OR_UPDATE'} => tr(
                Msg.mobileRestartOrUpdateJoiOnTheDesktopThenTry,
              ),
              _ => tr(
                Msg.mobileContinueTheConversationToRetryOrCheckDiagnosticsOn,
              ),
            }),
          ],
          if (_facts['harness'] case final Map<String, dynamic> harness) ...[
            const Divider(height: 32),
            Text(tr(Msg.mobileTaskProgress)),
            if (harness['destination'] case final String destination)
              MessageBody(destination),
            Text(
              tr(Msg.mobileDecidedValueUnconfirmedValueUnexploredValue, {
                'p0': (harness['decisionCount'] ?? 0).toString(),
                'p1': (harness['fogCount'] ?? 0).toString(),
                'p2': (harness['openPathCount'] ?? 0).toString(),
              }),
            ),
            if (harness['topFogNote'] case final String note) MessageBody(note),
            ListenableBuilder(
              listenable: widget.controller,
              builder: (context, _) => widget.controller.state.supportsGoalMap
                  ? TextButton.icon(
                      onPressed:
                          widget.controller.state.connection ==
                              RemoteConnectionState.connected
                          ? () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => GoalRouteMapPage(
                                  controller: widget.controller,
                                  goalId: _goal.goalId,
                                ),
                              ),
                            )
                          : null,
                      icon: const Icon(Icons.route_outlined),
                      label: Text(tr(Msg.homeGoalRouteMap)),
                    )
                  : const SizedBox.shrink(),
            ),
          ],
          if ((_facts['artifacts'] as List? ?? []).isNotEmpty) ...[
            const Divider(height: 32),
            Text(tr(Msg.mobileArtifactInformationOpenOnTheDesktop)),
            GoalArtifactList(
              key: ValueKey(
                'artifacts-${_goal.goalId}-${_facts['resultId'] ?? _facts['completedAt'] ?? _facts['artifactCount'] ?? 0}',
              ),
              controller: widget.controller,
              goalId: _goal.goalId,
              initialItems: (_facts['artifacts'] as List)
                  .whereType<Map<String, dynamic>>()
                  .toList(),
              nextCursor: _facts['artifactNextCursor'] as String?,
            ),
          ],
          GoalQuestionHistory(questions: _goal.questions),
          GoalActions(
            key: ValueKey(_goal.goalId),
            controller: widget.controller,
            goal: _goal,
            onChanged: () {
              unawaited(_load());
            },
          ),
          const Divider(height: 32),
          Text(
            tr(Msg.mobilePartnerWorkHistory),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          if (_agents.isEmpty)
            Padding(
              padding: EdgeInsets.all(12),
              child: Text(tr(Msg.mobileNoPartnerWorkHistoryYet)),
            ),
          for (final agent in _agents)
            ListTile(
              title: Text(
                agent['partnerName'] as String? ?? tr(Msg.commonPartners),
              ),
              subtitle: Text(
                executionStatusLabel(
                  status: agent['status'] as String? ?? 'UNKNOWN',
                  resultAssessment: agent['resultAssessment'] as String?,
                  executionPhase: agent['executionPhase'] as String?,
                  waitReason: agent['waitReason'] as String?,
                ),
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
              child: Text(tr(Msg.mobileMorePartners)),
            ),
        ],
      ),
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
  Object? _error;
  late String _status;
  String? _resultAssessment;
  String? _executionPhase;
  String? _waitReason;
  bool _loading = false;
  bool _foreground = true;
  int _generation = 0;
  int _loadedPages = 1;
  Timer? _timer;
  @override
  void initState() {
    super.initState();
    _status = widget.agent['status'] as String? ?? 'UNKNOWN';
    _resultAssessment = widget.agent['resultAssessment'] as String?;
    _executionPhase = widget.agent['executionPhase'] as String?;
    _waitReason = widget.agent['waitReason'] as String?;
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
      var resultAssessment = _resultAssessment;
      var executionPhase = _executionPhase;
      var waitReason = _waitReason;
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
        final agent = page['agent'] as Map<String, dynamic>?;
        if (agent != null) {
          status = agent['status'] as String? ?? status;
          resultAssessment = agent['resultAssessment'] as String?;
          executionPhase = agent['executionPhase'] as String?;
          waitReason = agent['waitReason'] as String?;
        }
        pages++;
      } while (!more && cursor != null && pages < _loadedPages);
      setState(() {
        final merged = more ? [..._items, ...items] : items;
        _items = {
          for (final item in merged) item['entryId']: item,
        }.values.toList();
        _cursor = cursor;
        _status = status;
        _resultAssessment = resultAssessment;
        _executionPhase = executionPhase;
        _waitReason = waitReason;
        _error = null;
        _loadedPages = more ? _loadedPages + 1 : pages;
      });
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () => _error = UiNotice(
            Msg.mobileCouldNotLoadRecordsRefreshAndTryAgain,
          ),
        );
      }
    } finally {
      _loading = false;
    }
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => Scaffold(
      appBar: AppBar(
        title: Text(
          widget.agent['partnerName'] as String? ??
              tr(Msg.mobilePartnerHistory),
        ),
        actions: [
          IconButton(
            tooltip: tr(Msg.mobileRefresh),
            onPressed: () => _load(),
            icon: const Icon(Icons.refresh),
          ),
          ConnectionDiagnosticsButton(controller: widget.controller),
        ],
      ),
      body: _recordList(),
    ),
  );

  Widget _recordList() {
    final rows = groupConversationOutput(_items);
    final activeSince =
        _items.reversed
                .where((item) => item['role'] == 'USER')
                .firstOrNull?['sequence']
            as int?;
    final header = <Widget>[
      Text(
        executionStatusLabel(
          status: _status,
          resultAssessment: _resultAssessment,
          executionPhase: _executionPhase,
          waitReason: _waitReason,
        ),
      ),
      if (_error != null) Text(noticeText(_error!)),
      if (rows.isEmpty)
        Padding(
          padding: const EdgeInsets.all(20),
          child: Text(tr(Msg.mobileNoRecordsToShowYet)),
        ),
    ];
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: header.length + rows.length + (_cursor == null ? 0 : 1),
      itemBuilder: (context, index) {
        if (index < header.length) return header[index];
        final position = index - header.length;
        if (position == rows.length) {
          return TextButton(
            onPressed: () => _load(more: true),
            child: Text(tr(Msg.mobileLoadMoreRecords)),
          );
        }
        final row = rows[position];
        return ConversationOutputRow(
          key: ValueKey(row.first['entryId']),
          entries: row,
          status: _status,
          activeSince: activeSince,
        );
      },
    );
  }
}
