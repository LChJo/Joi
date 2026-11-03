import 'package:flutter/material.dart';
import 'i18n.dart';
import 'remote_controller.dart';

class GoalArtifactList extends StatefulWidget {
  const GoalArtifactList({
    super.key,
    required this.controller,
    required this.goalId,
    required this.initialItems,
    this.nextCursor,
  });
  final RemoteController controller;
  final String goalId;
  final List<Map<String, dynamic>> initialItems;
  final String? nextCursor;

  @override
  State<GoalArtifactList> createState() => _GoalArtifactListState();
}

class _GoalArtifactListState extends State<GoalArtifactList> {
  static const _limit = 20;
  late List<Map<String, dynamic>> _items = widget.initialItems
      .take(_limit)
      .toList();
  late String? _nextCursor = widget.nextCursor;
  final _cursors = <String?>[null];
  int _position = 0;
  int _localPage = 0;
  bool _busy = false;
  bool _failed = false;
  String? _pendingCursor;
  int _pendingPosition = 0;

  Future<void> _load(String? cursor, int position) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _failed = false;
      _pendingCursor = cursor;
      _pendingPosition = position;
    });
    try {
      final page = await widget.controller.read(
        'goal.artifacts',
        goalId: widget.goalId,
        cursor: cursor,
      );
      if (!mounted) return;
      setState(() {
        _items = (page['items'] as List? ?? [])
            .whereType<Map<String, dynamic>>()
            .take(_limit)
            .toList();
        _nextCursor = page['nextCursor'] as String?;
        _position = position;
        if (_cursors.length <= position) {
          _cursors.add(cursor);
        } else {
          _cursors[position] = cursor;
        }
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _local(int page) {
    setState(() {
      _localPage = page;
      _items = widget.initialItems.skip(page * _limit).take(_limit).toList();
    });
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) {
      final remote = widget.nextCursor != null;
      final previous = remote ? _position > 0 : _localPage > 0;
      final next = remote
          ? _nextCursor != null
          : (_localPage + 1) * _limit < widget.initialItems.length;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final artifact in _items)
            ListTile(
              leading: Icon(
                artifact['kind'] == 'DIRECTORY'
                    ? Icons.folder_outlined
                    : Icons.insert_drive_file_outlined,
              ),
              title: Text(
                artifact['fileCount'] != null && artifact['directory'] == null
                    ? tr(Msg.catalogWorkspaceRoot)
                    : artifact['name'] as String? ?? tr(Msg.homeArtifacts),
              ),
              subtitle: Text(
                artifact['fileCount'] != null
                    ? tr(Msg.homeArtifactCount, {
                        'count': artifact['fileCount'].toString(),
                      })
                    : tr(Msg.mobileValueValueBytes, {
                        'p0': (artifact['mimeType'] ?? '').toString(),
                        'p1': (artifact['size'] ?? 0).toString(),
                      }),
              ),
            ),
          if (_failed) ...[
            Text(tr(Msg.homeArtifactPageFailed)),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => _load(_pendingCursor, _pendingPosition),
              child: Text(tr(Msg.commonRetry)),
            ),
          ],
          if (previous || next || _busy)
            Row(
              children: [
                TextButton(
                  onPressed: _busy || !previous
                      ? null
                      : () {
                          if (remote) {
                            _load(_cursors[_position - 1], _position - 1);
                          } else {
                            _local(_localPage - 1);
                          }
                        },
                  child: Text(tr(Msg.commonPreviousPage)),
                ),
                TextButton(
                  onPressed: _busy || !next
                      ? null
                      : () {
                          if (remote) {
                            _load(_nextCursor, _position + 1);
                          } else {
                            _local(_localPage + 1);
                          }
                        },
                  child: Text(tr(Msg.commonNextPage)),
                ),
              ],
            ),
        ],
      );
    },
  );
}
