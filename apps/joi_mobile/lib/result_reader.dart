import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'remote_controller.dart';
import 'connection_diagnostics_view.dart';
import 'goal_detail.dart';
import 'result_export.dart';

class ResultReaderPage extends StatefulWidget {
  const ResultReaderPage({
    super.key,
    required this.controller,
    required this.goal,
    this.service,
  });
  final RemoteController controller;
  final RemoteGoalCard goal;
  final ResultExportService? service;
  @override
  State<ResultReaderPage> createState() => _ResultReaderPageState();
}

class _ResultReaderPageState extends State<ResultReaderPage> {
  late final ResultExportService _service =
      widget.service ?? ResultExportService();
  String? _body;
  String? _error;
  String _notice = '';
  bool _menu = false;
  bool _busy = false;
  SavedResult? _saved;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final detail = await widget.controller.read(
        'goal.get',
        goalId: widget.goal.goalId,
      );
      final body = resultBody(detail);
      if (mounted) setState(() => _body = body);
    } catch (_) {
      if (mounted) setState(() => _error = '未能读取完整结果，请返回后重试。');
    }
  }

  Future<void> _export(String format) async {
    if (_busy || _body == null) return;
    setState(() {
      _busy = true;
      _menu = false;
      _notice = '正在处理…';
    });
    try {
      if (format == 'copy') {
        await Clipboard.setData(ClipboardData(text: _body!));
        if (mounted) setState(() => _notice = '已复制全文');
      } else {
        final saved = await _service.export(widget.goal.title, _body!, format, (
          message,
        ) {
          if (mounted) setState(() => _notice = message);
        });
        if (mounted) {
          setState(() {
            _saved = saved;
            _notice = '已保存 ${saved.count} 个文件到 ${saved.location}';
          });
        }
      }
    } catch (_) {
      if (mounted) setState(() => _notice = '导出未完成或已取消，请重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_menu,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop && _menu) setState(() => _menu = false);
    },
    child: Scaffold(
      appBar: AppBar(
        title: const Text('查看全文'),
        actions: [ConnectionDiagnosticsButton(controller: widget.controller)],
      ),
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 180),
            children: [
              if (_error != null)
                Text(_error!)
              else if (_body == null)
                const LinearProgressIndicator()
              else
                MessageBody(_body!),
            ],
          ),
          if (_menu)
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => setState(() => _menu = false),
              ),
            ),
          Positioned(
            right: 20,
            bottom: 20,
            left: 20,
            child: SafeArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (_notice.isNotEmpty)
                    Material(
                      borderRadius: BorderRadius.circular(8),
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: Text(_notice),
                      ),
                    ),
                  if (_saved != null)
                    TextButton(
                      onPressed: () async {
                        final opened = await _service.store
                            .open(_saved!.id)
                            .catchError((_) => false);
                        if (!opened && mounted) {
                          setState(() => _notice = '文件已保存，但无法打开，请在保存目录查看。');
                        }
                      },
                      child: const Text('打开'),
                    ),
                  if (_menu) ...[
                    FilledButton(
                      onPressed: () => _export('copy'),
                      child: const Text('复制全文'),
                    ),
                    FilledButton(
                      onPressed: () => _export('pdf'),
                      child: const Text('导出 PDF'),
                    ),
                    FilledButton(
                      onPressed: () => _export('png'),
                      child: const Text('导出 PNG'),
                    ),
                  ],
                  IconButton.filled(
                    tooltip: '导出全文',
                    onPressed: _body == null || _busy
                        ? null
                        : () => setState(() => _menu = !_menu),
                    icon: _busy
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.download_outlined),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
