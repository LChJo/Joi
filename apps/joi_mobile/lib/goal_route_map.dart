import 'dart:async';

import 'package:flutter/material.dart';

import 'i18n.dart';
import 'message_body.dart';
import 'remote_controller.dart';

class GoalRouteMapPage extends StatefulWidget {
  const GoalRouteMapPage({
    super.key,
    required this.controller,
    required this.goalId,
  });

  final RemoteController controller;
  final String goalId;

  @override
  State<GoalRouteMapPage> createState() => _GoalRouteMapPageState();
}

class _GoalRouteMapPageState extends State<GoalRouteMapPage> {
  final _cursors = <String?>[null];
  final _scroll = ScrollController();
  Map<String, dynamic>? _map;
  String? _next;
  int _page = 0;
  bool _loading = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load(0, null));
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load(int page, String? cursor) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final result = await widget.controller.read(
        'goal.map',
        goalId: widget.goalId,
        cursor: cursor,
      );
      if (!mounted) return;
      setState(() {
        _map = result['harness'] as Map<String, dynamic>? ?? {};
        _next = result['nextCursor'] as String?;
        _page = page;
        _cursors.replaceRange(page, _cursors.length, [cursor]);
      });
      if (_scroll.hasClients) _scroll.jumpTo(0);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final map = _map ?? const <String, dynamic>{};
    final currentLayer = map['currentLayer'] as int? ?? 0;
    final paths = (map['paths'] as List? ?? [])
        .whereType<Map<String, dynamic>>();
    final layers = <int, List<Map<String, dynamic>>>{};
    for (final path in paths) {
      if (path['layer'] case final int layer) {
        (layers[layer] ??= []).add(path);
      }
    }
    final decisions = (map['decisions'] as List? ?? [])
        .whereType<Map<String, dynamic>>();
    final fog = (map['fog'] as List? ?? []).whereType<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(
        title: Text(tr(Msg.homeGoalRouteMap)),
        actions: [
          IconButton(
            tooltip: tr(Msg.mobileRefresh),
            onPressed: _loading ? null : () => _load(0, null),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(20),
        children: [
          if (_loading) const LinearProgressIndicator(),
          if (_failed) ...[
            Text(tr(Msg.homeGoalDetailLoadFailed)),
            TextButton(
              onPressed: () => _load(0, null),
              child: Text(tr(Msg.commonRetry)),
            ),
          ],
          if (_map != null && map.isEmpty) Text(tr(Msg.homeRouteMapEmpty)),
          if (map.isNotEmpty) ...[
            if (map['destination'] case final String destination)
              MessageBody(destination),
            if (currentLayer > 0)
              Text(tr(Msg.homeRouteCurrentLayer, {'layer': '$currentLayer'})),
            Text(
              tr(Msg.homeRouteMapCounts, {
                'paths': (map['pathCount'] ?? 0).toString(),
                'decisions': (map['decisionCount'] ?? 0).toString(),
                'fog': (map['fogCount'] ?? 0).toString(),
              }),
            ),
            if (layers.isEmpty && map['pathCount'] == 0)
              Text(tr(Msg.homeRouteMapEmpty)),
            for (final entry in layers.entries)
              ExpansionTile(
                key: ValueKey((_page, entry.key)),
                initiallyExpanded: entry.key == currentLayer,
                title: Text(tr(Msg.homeRouteLayer, {'layer': '${entry.key}'})),
                children: [
                  for (final path in entry.value)
                    ListTile(
                      key: ValueKey(path['pathId']),
                      title: Text(path['title'] as String? ?? ''),
                      subtitle: Text(
                        tr(switch (path['status']) {
                          'CLOSED' => Msg.homeMapPathClosed,
                          'OUT_OF_SCOPE' => Msg.homeMapPathOutOfScope,
                          _ => Msg.homeMapPathOpen,
                        }),
                      ),
                      trailing: switch (path['workStatus']) {
                        'PLANNED' => Text(tr(Msg.homeMapWorkPlanned)),
                        'READY' => Text(tr(Msg.homeMapWorkReady)),
                        'RUNNING' => Text(tr(Msg.homeMapWorkRunning)),
                        'WAITING' => Text(tr(Msg.homeMapWorkWaiting)),
                        'COMPLETED' => Text(tr(Msg.homeMapWorkCompleted)),
                        'FAILED' => Text(tr(Msg.homeMapWorkFailed)),
                        'CANCELED' => Text(tr(Msg.homeMapWorkCanceled)),
                        _ => null,
                      },
                    ),
                ],
              ),
            if (decisions.isNotEmpty)
              ExpansionTile(
                title: Text(tr(Msg.homeRouteDecisions)),
                children: [
                  for (final decision in decisions)
                    ListTile(
                      title: Text(decision['summary'] as String? ?? ''),
                      subtitle: switch (decision['detail']) {
                        final String detail when detail.isNotEmpty => Text(
                          detail,
                        ),
                        _ => null,
                      },
                    ),
                ],
              ),
            if (fog.isNotEmpty)
              ExpansionTile(
                title: Text(tr(Msg.homeRouteFog)),
                children: [
                  for (final item in fog)
                    ListTile(
                      title: Text(item['note'] as String? ?? ''),
                      subtitle: Text(
                        tr(
                          item['status'] == 'GRADUATED'
                              ? Msg.homeRouteFogGraduated
                              : Msg.homeRouteFogActive,
                        ),
                      ),
                    ),
                ],
              ),
            Wrap(
              spacing: 12,
              children: [
                if (_page > 0)
                  TextButton(
                    onPressed: _loading || _failed
                        ? null
                        : () => _load(_page - 1, _cursors[_page - 1]),
                    child: Text(tr(Msg.commonPreviousPage)),
                  ),
                if (_next != null)
                  TextButton(
                    onPressed: _loading || _failed
                        ? null
                        : () => _load(_page + 1, _next),
                    child: Text(tr(Msg.commonNextPage)),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
