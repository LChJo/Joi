import 'package:flutter/material.dart';

import 'i18n.dart';
import 'message_body.dart';

typedef ConversationEntry = Map<String, dynamic>;

bool _isTool(ConversationEntry entry) =>
    entry['kind'] == 'TOOL_CALL' || entry['kind'] == 'TOOL_RESULT';

List<List<ConversationEntry>> groupConversationOutput(
  List<ConversationEntry> entries,
) {
  final rows = <List<ConversationEntry>>[];
  for (final entry in entries) {
    if (entry['kind'] == 'ACTIVITY') continue;
    if (_isTool(entry) && rows.isNotEmpty && _isTool(rows.last.first)) {
      rows.last.add(entry);
    } else {
      rows.add([entry]);
    }
  }
  return rows;
}

class _ToolCall {
  _ToolCall(this.name, this.sequence);

  final String? name;
  final int sequence;
  String? parameters;
  bool hasResult = false;
  String? state;

  Msg label(String status, int? activeSince) {
    if (state == 'completed') return Msg.chatToolCompleted;
    if (state == 'failed') return Msg.chatToolFailed;
    if (activeSince != null && sequence < activeSince) {
      return Msg.chatToolResultMissing;
    }
    return switch (status) {
      'RUNNING' || 'QUEUED' => Msg.chatToolRunning,
      'STOPPED' || 'CANCELED' => Msg.chatStopped,
      'INTERRUPTED' => Msg.chatInterrupted,
      _ => Msg.chatToolResultMissing,
    };
  }
}

List<_ToolCall> _pairTools(List<ConversationEntry> entries) {
  final calls = <_ToolCall>[];
  final byId = <String, _ToolCall>{};
  for (final entry in entries) {
    final id = entry['toolCallId'] as String?;
    final name = entry['toolName'] as String?;
    final result = entry['kind'] == 'TOOL_RESULT';
    final paired = id != null
        ? byId[id]
        : result
        ? calls.reversed
              .where(
                (call) =>
                    !call.hasResult && (name == null || call.name == name),
              )
              .firstOrNull
        : null;
    final call = paired ?? _ToolCall(name, entry['sequence'] as int? ?? 0);
    if (paired == null) calls.add(call);
    if (id != null) byId[id] = call;
    if (result) {
      call.hasResult = true;
      call.state =
          entry['toolState'] == 'failed' ||
              (entry['toolState'] == null && entry['text'] == '执行失败')
          ? 'failed'
          : 'completed';
    } else {
      final text = (entry['text'] as String?)?.trim();
      if (text != null && text.isNotEmpty) call.parameters ??= text;
      call.state ??= entry['toolState'] as String?;
    }
  }
  return calls;
}

class ConversationOutputRow extends StatelessWidget {
  const ConversationOutputRow({
    super.key,
    required this.entries,
    required this.status,
    this.activeSince,
  });

  final List<ConversationEntry> entries;
  final String status;
  final int? activeSince;

  @override
  Widget build(BuildContext context) {
    final entry = entries.first;
    if (_isTool(entry)) return _tools(context);
    if (entry['kind'] == 'ARTIFACT') {
      final artifact = entry['artifact'] as Map?;
      return ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.insert_drive_file_outlined),
        title: Text(artifact?['name'] as String? ?? tr(Msg.homeArtifacts)),
      );
    }
    final text = entry['text'] as String? ?? '';
    if (text.isEmpty) return const SizedBox.shrink();
    final message = Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: MessageBody(text, scrollTables: true),
    );
    if (entry['role'] != 'USER') return message;
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(left: 24, top: 6, bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: message,
      ),
    );
  }

  Widget _tools(BuildContext context) {
    final calls = _pairTools(entries), latest = calls.last;
    final theme = Theme.of(context);
    final state = latest.label(status, activeSince);
    return ExpansionTile(
      key: PageStorageKey(entries.first['entryId']),
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(left: 24, bottom: 6),
      expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
      leading: SizedBox.square(
        dimension: 16,
        child:
            state == Msg.chatToolRunning &&
                !MediaQuery.disableAnimationsOf(context)
            ? const CircularProgressIndicator(strokeWidth: 2)
            : Icon(switch (state) {
                Msg.chatToolCompleted => Icons.check,
                Msg.chatToolFailed => Icons.error_outline,
                _ => Icons.build_outlined,
              }, size: 16),
      ),
      title: Row(
        children: [
          Expanded(
            child: Text(
              latest.name ?? tr(Msg.chatTool),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              tr(state),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall,
            ),
          ),
        ],
      ),
      subtitle: Row(
        children: [
          Expanded(
            child: Text(
              latest.parameters ?? tr(Msg.chatToolParametersMissing),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          Text(tr(Msg.chatToolCount, {'count': calls.length})),
        ],
      ),
      children: [
        for (final call in calls)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${call.name ?? tr(Msg.chatTool)} · ${tr(call.label(status, activeSince))}',
                  style: theme.textTheme.labelMedium,
                ),
                SelectionArea(
                  child: Text(
                    call.parameters ?? tr(Msg.chatToolParametersMissing),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
