import 'dart:async';

import 'package:flutter/material.dart';

import 'connection_diagnostics_view.dart';
import 'home_screen.dart' show statusLabel;
import 'i18n.dart';
import 'remote_controller.dart';
import 'result_export.dart';
import 'result_reader.dart';

class ResultHistoryPage extends StatefulWidget {
  const ResultHistoryPage({
    super.key,
    required this.controller,
    required this.goal,
    this.service,
  });

  final RemoteController controller;
  final RemoteGoalCard goal;
  final ResultExportService? service;

  @override
  State<ResultHistoryPage> createState() => _ResultHistoryPageState();
}

class _ResultHistoryPageState extends State<ResultHistoryPage> {
  final _scroll = ScrollController();
  List<Map<String, dynamic>> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _loaded = false;
  bool _failedMore = false;
  UiNotice? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.controller.read(
        'goal.results',
        goalId: widget.goal.goalId,
        cursor: more ? _cursor : null,
      );
      if (!mounted) return;
      final items = (page['items'] as List? ?? [])
          .whereType<Map<String, dynamic>>()
          .where(
            (item) =>
                item['resultId'] is String &&
                (item['resultId'] as String).isNotEmpty &&
                item['completedAt'] is String &&
                DateTime.tryParse(item['completedAt'] as String) != null &&
                const [
                  'COMPLETED',
                  'COMPLETED_WITH_GAPS',
                ].contains(item['status']),
          );
      setState(() {
        _items = {
          for (final item in [
            ...(more ? _items : <Map<String, dynamic>>[]),
            ...items,
          ])
            item['resultId']: item,
        }.values.toList();
        _cursor = page['nextCursor'] as String?;
        _loaded = true;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = const UiNotice(Msg.homeHistoryLoadFailed);
          _failedMore = more;
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => Scaffold(
      appBar: AppBar(
        title: Text(tr(Msg.homeResultHistory)),
        actions: [
          IconButton(
            tooltip: tr(Msg.mobileRefresh),
            onPressed: _loading ? null : () => _load(),
            icon: const Icon(Icons.refresh),
          ),
          ConnectionDiagnosticsButton(controller: widget.controller),
        ],
      ),
      body: ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(16),
        children: [
          if (_loading) const LinearProgressIndicator(),
          for (var index = 0; index < _items.length; index++)
            ListTile(
              key: ValueKey(_items[index]['resultId'] as String),
              leading: const Icon(Icons.description_outlined),
              title: Text(
                tr(Msg.homeResultAt, {
                  'p0': formatUiDate(
                    DateTime.parse(_items[index]['completedAt'] as String),
                  ),
                }),
              ),
              subtitle: Text(statusLabel(_items[index]['status'] as String)),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (index == 0) Text(tr(Msg.homeLatestResult)),
                  const Icon(Icons.chevron_right),
                ],
              ),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ResultReaderPage(
                    controller: widget.controller,
                    goal: widget.goal,
                    resultId: _items[index]['resultId'] as String,
                    fromHistory: true,
                    service: widget.service,
                  ),
                ),
              ),
            ),
          if (_loaded && _items.isEmpty && _error == null)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(tr(Msg.homeNoResultHistory)),
            ),
          if (_error != null) ...[
            Text(noticeText(_error!)),
            TextButton(
              onPressed: _loading ? null : () => _load(more: _failedMore),
              child: Text(tr(Msg.commonRetry)),
            ),
          ],
          if (_cursor != null && _error == null)
            TextButton(
              onPressed: _loading ? null : () => _load(more: true),
              child: Text(tr(Msg.homeLoadMoreResults)),
            ),
        ],
      ),
    ),
  );
}
