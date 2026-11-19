import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'i18n.dart';
import 'remote_controller.dart';

class UserQuestionCard extends StatelessWidget {
  const UserQuestionCard({
    super.key,
    required this.question,
    required this.supported,
    required this.onAnswer,
    this.onResume,
    this.compact = false,
  });
  final RemoteUserQuestion question;
  final bool supported;
  final bool compact;
  final Future<void> Function()? onResume;
  final Future<void> Function(Map<String, Object?> input) onAnswer;
  @override
  Widget build(BuildContext context) => _QuestionCard(
    key: ValueKey(question.identity),
    question: question,
    supported: supported,
    compact: compact,
    onAnswer: onAnswer,
    onResume: onResume,
  );
}

class _QuestionCard extends StatefulWidget {
  const _QuestionCard({
    super.key,
    required this.question,
    required this.supported,
    required this.compact,
    this.onAnswer,
    this.onResume,
  });
  final RemoteUserQuestion question;
  final bool supported;
  final bool compact;
  final Future<void> Function()? onResume;
  final Future<void> Function(Map<String, Object?>)? onAnswer;
  @override
  State<_QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<_QuestionCard> {
  final _draft = TextEditingController();
  final _selected = <String>{};
  Timer? _timer;
  bool _busy = false, _submitted = false, _failed = false;
  RemoteUserQuestion get q => widget.question;
  bool get _recoverable =>
      q.delivery == 'INTERRUPTED' &&
      q.status != 'CANCELED' &&
      q.status != 'SUPERSEDED';
  bool get _expired =>
      q.expiresAt != null && !DateTime.now().isBefore(q.expiresAt!);
  bool get _locked =>
      !q.active ||
      !widget.supported ||
      q.expiresAt == null ||
      _expired ||
      _busy ||
      _submitted;
  bool get _hasAnswer =>
      _selected.isNotEmpty || (q.allowCustom && _draft.text.trim().isNotEmpty);

  @override
  void initState() {
    super.initState();
    _draft.addListener(_draftChanged);
    _updateTimer();
  }

  void _draftChanged() {
    setState(() {});
  }

  void _updateTimer() {
    _timer?.cancel();
    if (q.active && q.expiresAt != null && !_expired) {
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
        if (_expired) _timer?.cancel();
      });
    }
  }

  @override
  void didUpdateWidget(covariant _QuestionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.question.status != q.status ||
        oldWidget.question.delivery != q.delivery ||
        oldWidget.question.expiresAt != q.expiresAt) {
      _updateTimer();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _draft.dispose();
    super.dispose();
  }

  Future<void> _send(bool useDefault) async {
    final onAnswer = widget.onAnswer;
    if (onAnswer == null || _locked || (!useDefault && !_hasAnswer)) return;
    setState(() {
      _busy = true;
      _failed = false;
    });
    final input = <String, Object?>{
      'version': q.version,
      if (useDefault) 'useDefault': true,
      if (!useDefault)
        'selectedOptionIds': q.options
            .map((o) => o['id'])
            .whereType<String>()
            .where(_selected.contains)
            .toList(),
      if (!useDefault && q.allowCustom && _draft.text.trim().isNotEmpty)
        'text': _draft.text.trim(),
    };
    try {
      await onAnswer(input);
      if (mounted && q.active) {
        setState(() {
          _submitted = true;
          _busy = false;
        });
      }
    } catch (_) {
      if (mounted && q.active) {
        setState(() {
          _busy = false;
          _failed = true;
        });
      }
    }
  }

  Future<void> _resume() async {
    final resume = widget.onResume;
    if (resume == null || !widget.supported || !_recoverable || _busy) {
      return;
    }
    setState(() {
      _busy = true;
      _failed = false;
    });
    try {
      await resume();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _status() => tr(
    q.delivery == 'INTERRUPTED'
        ? Msg.chatQuestionInterrupted
        : switch (q.status) {
            'ACTIVE' =>
              q.kind == 'CONFIRM'
                  ? Msg.chatQuestionConfirm
                  : Msg.chatQuestionActive,
            'QUEUED' => Msg.chatQuestionQueued,
            'ANSWERED' => Msg.chatQuestionAnswered,
            'SUPERSEDED' => Msg.chatQuestionSuperseded,
            _ => Msg.chatQuestionCanceled,
          },
  );
  String _timestamp(String value) {
    final parsed = DateTime.tryParse(value);
    return parsed == null
        ? value
        : DateFormat.yMMMd(uiLocale.code).add_Hm().format(parsed.toLocal());
  }

  Widget _default(ColorScheme colors) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: colors.primary.withValues(alpha: .05),
      border: Border(left: BorderSide(color: colors.outlineVariant, width: 2)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          tr(Msg.chatQuestionDefaultLabel),
          style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
        ),
        const SizedBox(height: 4),
        SelectableText(q.defaultAnswer),
        for (final option in q.options.where(
          (o) => q.defaultOptionIds.contains(o['id']),
        ))
          Text(option['label'] as String? ?? ''),
      ],
    ),
  );
  Widget _notice(String text) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Semantics(liveRegion: true, child: Text(text)),
  );

  List<Widget> _recordedAnswer(
    ColorScheme colors,
    Map<String, dynamic> answer,
  ) => [
    const Divider(),
    Text(
      tr(switch (answer['source']) {
        'USER' => Msg.chatQuestionAnswerUser,
        'USER_DEFAULT' => Msg.chatQuestionAnswerUserDefault,
        _ => Msg.chatQuestionAnswerTimeout,
      }),
    ),
    Text(
      _timestamp(answer['answeredAt'] as String? ?? ''),
      style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
    ),
    SelectableText(answer['text'] as String? ?? ''),
    if (!widget.compact)
      for (final option in q.options.where(
        (o) => (answer['selectedOptionIds'] as List? ?? const []).contains(
          o['id'],
        ),
      ))
        Text(option['label'] as String? ?? ''),
    if (q.delivery != 'INTERRUPTED')
      Text(
        tr(
          q.delivery == 'DELIVERED'
              ? Msg.chatQuestionDeliveryDelivered
              : Msg.chatQuestionDeliveryPending,
        ),
      ),
  ];

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final colors = Theme.of(context).colorScheme;
    final answer = q.answer;
    final compact = widget.compact;
    final summary =
        compact &&
        q.status == 'ANSWERED' &&
        q.delivery != 'INTERRUPTED' &&
        answer != null;
    final metaStyle = TextStyle(color: colors.onSurfaceVariant, fontSize: 12);
    final source = Text(
      tr(Msg.chatQuestionSource, {'name': q.sourceName}),
      style: metaStyle,
    );
    final status = Semantics(
      liveRegion: true,
      child: Text(
        _status(),
        style: TextStyle(
          color: colors.primary,
          fontWeight: FontWeight.w600,
          fontSize: compact ? 12 : null,
        ),
      ),
    );
    final recommendedAction = FilledButton(
      style: FilledButton.styleFrom(minimumSize: const Size(44, 48)),
      onPressed: _locked ? null : () => _send(true),
      child: Padding(
        padding: EdgeInsets.symmetric(vertical: compact ? 0 : 8),
        child: Text(
          tr(Msg.chatQuestionUseDefault),
          textAlign: TextAlign.center,
        ),
      ),
    );
    final answerAction = OutlinedButton(
      style: OutlinedButton.styleFrom(minimumSize: const Size(44, 48)),
      onPressed: _locked || !_hasAnswer ? null : () => _send(false),
      child: Padding(
        padding: EdgeInsets.symmetric(vertical: compact ? 0 : 8),
        child: Text(tr(Msg.chatQuestionSubmit), textAlign: TextAlign.center),
      ),
    );
    final seconds = q.expiresAt == null
        ? 0
        : ((q.expiresAt!.difference(DateTime.now()).inMilliseconds / 1000)
                  .ceil())
              .clamp(0, 1800);
    final remaining =
        '${(seconds ~/ 60).toString().padLeft(2, '0')}:${(seconds % 60).toString().padLeft(2, '0')}';
    if (summary) {
      return _panel(
        colors,
        flush: true,
        child: ExpansionTile(
          dense: true,
          tilePadding: const EdgeInsets.symmetric(horizontal: 10),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          shape: const Border(),
          collapsedShape: const Border(),
          title: Row(
            children: [
              status,
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  q.question,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 6),
              const Text('·'),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  answer['text'] as String? ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            source,
            SelectableText(q.question),
            ..._recordedAnswer(colors, answer),
          ],
        ),
      );
    }
    return _panel(
      colors,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (compact)
            Wrap(spacing: 8, children: [status, source])
          else ...[
            status,
            source,
          ],
          SizedBox(height: compact ? 4 : 10),
          if (q.status == 'QUEUED' && q.delivery != 'INTERRUPTED') ...[
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(
                q.question,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              children: [_default(colors)],
            ),
            Text(tr(Msg.chatQuestionQueuedHint)),
          ] else
            Text(q.question, style: Theme.of(context).textTheme.titleMedium),
          if (q.active) ...[
            if (!widget.supported)
              _notice(tr(Msg.chatQuestionRemoteUnavailable)),
            if (q.options.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                tr(
                  q.multiSelect
                      ? Msg.chatQuestionChooseMany
                      : Msg.chatQuestionChooseOne,
                ),
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
              ),
              RadioGroup<String>(
                groupValue: _selected.firstOrNull,
                onChanged: (id) {
                  if (!_locked && id != null) {
                    setState(() {
                      _selected.clear();
                      _selected.add(id);
                    });
                  }
                },
                child: Column(
                  children: [
                    for (final option in q.options)
                      q.multiSelect
                          ? CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: compact,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: _selected.contains(option['id']),
                              title: Text(option['label'] as String? ?? ''),
                              subtitle: _optionDescription(option),
                              onChanged: _locked
                                  ? null
                                  : (value) => setState(() {
                                      if (value == true) {
                                        _selected.add(option['id'] as String);
                                      } else {
                                        _selected.remove(option['id']);
                                      }
                                    }),
                            )
                          : RadioListTile<String>(
                              contentPadding: EdgeInsets.zero,
                              dense: compact,
                              value: option['id'] as String? ?? '',
                              enabled: !_locked,
                              title: Text(option['label'] as String? ?? ''),
                              subtitle: _optionDescription(option),
                            ),
                  ],
                ),
              ),
            ],
            if (q.allowCustom) ...[
              const SizedBox(height: 10),
              Focus(
                onKeyEvent: (_, event) {
                  if (event is! KeyDownEvent ||
                      event.logicalKey != LogicalKeyboardKey.enter ||
                      (!HardwareKeyboard.instance.isControlPressed &&
                          !HardwareKeyboard.instance.isMetaPressed) ||
                      HardwareKeyboard.instance.isAltPressed) {
                    return KeyEventResult.ignored;
                  }
                  if (_draft.value.composing.isValid &&
                      !_draft.value.composing.isCollapsed) {
                    return KeyEventResult.ignored;
                  }
                  unawaited(_send(false));
                  return KeyEventResult.handled;
                },
                child: TextField(
                  controller: _draft,
                  enabled: !_locked,
                  minLines: compact ? 2 : 3,
                  maxLines: 8,
                  maxLength: 8000,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    labelText: tr(Msg.chatQuestionCustomAnswer),
                    isDense: compact,
                    counterText: compact ? '' : null,
                    alignLabelWithHint: true,
                    border: const OutlineInputBorder(),
                  ),
                ),
              ),
              if (!compact)
                Text(
                  tr(Msg.chatQuestionKeyboardHint),
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
            ],
            SizedBox(height: compact ? 6 : 12),
            if (compact) ...[
              Wrap(
                spacing: 8,
                children: [
                  if (q.expiresAt != null)
                    Tooltip(
                      message: tr(Msg.chatQuestionDeadline, {
                        'time': _timestamp(q.expiresAt!.toIso8601String()),
                      }),
                      child: Text(
                        tr(Msg.chatQuestionCountdown, {'remaining': remaining}),
                        style: metaStyle,
                      ),
                    ),
                  Text(tr(Msg.chatQuestionTimeoutPolicy), style: metaStyle),
                ],
              ),
              SelectableText.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: '${tr(Msg.chatQuestionDefaultLabel)} · ',
                      style: metaStyle,
                    ),
                    TextSpan(text: q.defaultAnswer),
                  ],
                ),
              ),
              Wrap(spacing: 8, children: [recommendedAction, answerAction]),
            ] else ...[
              if (q.expiresAt != null) ...[
                Semantics(
                  liveRegion: false,
                  child: Text(
                    tr(Msg.chatQuestionCountdown, {'remaining': remaining}),
                  ),
                ),
                Text(
                  tr(Msg.chatQuestionDeadline, {
                    'time': _timestamp(q.expiresAt!.toIso8601String()),
                  }),
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ],
              Text(
                tr(Msg.chatQuestionTimeoutPolicy),
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
              ),
              const SizedBox(height: 8),
              _default(colors),
              const SizedBox(height: 12),
              recommendedAction,
              const SizedBox(height: 8),
              answerAction,
            ],
            if (_busy)
              _notice(tr(Msg.chatQuestionSubmitting))
            else if (_submitted)
              _notice(tr(Msg.chatQuestionSubmitted))
            else if (_expired)
              _notice(tr(Msg.chatQuestionExpired))
            else if (q.expiresAt == null)
              _notice(tr(Msg.chatQuestionTimingPending)),
            if (_failed) _notice(tr(Msg.chatQuestionSubmitFailed)),
          ],
          if (answer != null) ..._recordedAnswer(colors, answer),
          if (q.status == 'CANCELED') Text(tr(Msg.chatQuestionCanceledHint)),
          if (q.status == 'SUPERSEDED')
            Text(tr(Msg.chatQuestionSupersededHint)),
          if (q.delivery == 'INTERRUPTED') ...[
            if (answer == null) _default(colors),
            Text(tr(Msg.chatQuestionInterruptedHint)),
            if (widget.onResume != null && _recoverable) ...[
              if (!widget.supported)
                _notice(tr(Msg.chatQuestionRemoteUnavailable)),
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(44, 48),
                ),
                onPressed: !widget.supported || _busy ? null : _resume,
                child: Text(
                  tr(
                    answer == null
                        ? Msg.chatQuestionResumeDefault
                        : Msg.chatQuestionResumeSaved,
                  ),
                ),
              ),
              if (_failed) _notice(tr(Msg.chatError)),
            ],
          ],
        ],
      ),
    );
  }

  Widget _panel(
    ColorScheme colors, {
    required Widget child,
    bool flush = false,
  }) => Container(
    margin: EdgeInsets.symmetric(vertical: widget.compact ? 4 : 8),
    padding: EdgeInsets.all(
      flush
          ? 0
          : widget.compact
          ? 10
          : 14,
    ),
    decoration: BoxDecoration(
      color: colors.surface,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(
        color: q.active ? colors.primary : colors.outlineVariant,
      ),
    ),
    child: child,
  );

  Widget? _optionDescription(Map<String, dynamic> option) {
    final parts = [
      if (option['recommended'] == true) tr(Msg.chatQuestionRecommended),
      if (option['description'] is String) option['description'] as String,
    ];
    return parts.isEmpty ? null : Text(parts.join(' · '));
  }
}

bool isPendingQuestion(RemoteUserQuestion question) =>
    question.status == 'ACTIVE' || question.status == 'QUEUED';

class GoalQuestionHistory extends StatelessWidget {
  const GoalQuestionHistory({super.key, required this.questions});

  final List<RemoteUserQuestion> questions;

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final history = questions.where((question) => !isPendingQuestion(question));
    if (history.isEmpty) return const SizedBox.shrink();
    return ExpansionTile(
      dense: true,
      tilePadding: EdgeInsets.zero,
      title: Text(tr(Msg.chatGoalQuestionHistory)),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final question in history)
          _QuestionCard(
            key: ValueKey(question.identity),
            question: question,
            supported: false,
            compact: false,
          ),
      ],
    );
  }
}
