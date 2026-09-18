import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'connection_diagnostics.dart';
import 'remote_controller.dart';

Color connectionColor(RemoteConnectionState state) => switch (state) {
  RemoteConnectionState.connected => const Color(0xff79c99e),
  RemoteConnectionState.connecting ||
  RemoteConnectionState.reconnecting => Colors.amber,
  RemoteConnectionState.offline => Colors.redAccent,
  RemoteConnectionState.unpaired => Colors.grey,
};
String connectionLabel(RemoteConnectionState state) => switch (state) {
  RemoteConnectionState.connected => '已连接',
  RemoteConnectionState.connecting => '连接中',
  RemoteConnectionState.reconnecting => '重连中',
  RemoteConnectionState.offline => '离线',
  RemoteConnectionState.unpaired => '未配对',
};

class ConnectionDiagnosticsButton extends StatelessWidget {
  const ConnectionDiagnosticsButton({super.key, required this.controller});
  final RemoteController controller;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => IconButton(
      tooltip: '连接诊断 · ${connectionLabel(controller.state.connection)}',
      icon: Text(
        'i',
        style: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w600,
          color: connectionColor(controller.state.connection),
        ),
      ),
      onPressed: () => showDialog<void>(
        context: context,
        builder: (context) => AnimatedBuilder(
          animation: controller,
          builder: (context, _) {
            final state = controller.state;
            final summary =
                '${state.diagnostics.summary}\n状态：${state.connection.name}\n线路：${state.path.name}';
            return AlertDialog(
              title: const Text('连接诊断'),
              content: SizedBox(
                width: 420,
                child: SingleChildScrollView(child: SelectableText(summary)),
              ),
              actions: [
                TextButton(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: summary));
                    if (context.mounted) {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('已复制脱敏诊断')));
                    }
                  },
                  child: const Text('复制诊断'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('关闭'),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

class ConnectionProgress extends StatelessWidget {
  const ConnectionProgress({super.key, required this.controller});
  final RemoteController controller;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Column(
      children: [
        Text(
          '${stageLabel(controller.state.diagnostics.stage)} · 第 ${controller.state.diagnostics.attempt} 次尝试',
        ),
      ],
    ),
  );
}
