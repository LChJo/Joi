import 'i18n.dart';
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
  RemoteConnectionState.connected => tr(Msg.mobileConnected),
  RemoteConnectionState.connecting => tr(Msg.mobileConnecting),
  RemoteConnectionState.reconnecting => tr(Msg.mobileReconnecting),
  RemoteConnectionState.offline => tr(Msg.mobileOffline),
  RemoteConnectionState.unpaired => tr(Msg.mobileNotPaired),
};

class ConnectionDiagnosticsButton extends StatelessWidget {
  const ConnectionDiagnosticsButton({super.key, required this.controller});
  final RemoteController controller;

  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => AnimatedBuilder(
      animation: controller,
      builder: (context, _) => IconButton(
        tooltip: tr(Msg.mobileConnectionDiagnosticsValue, {
          'p0': (connectionLabel(controller.state.connection)).toString(),
        }),
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
              dependOnUiLocale(context);
              final state = controller.state;
              final summary = tr(Msg.mobileValueStatusValuePathValue, {
                'p0': (state.diagnostics.summary).toString(),
                'p1': (state.connection.name).toString(),
                'p2': (state.path.name).toString(),
              });
              return AlertDialog(
                title: Text(tr(Msg.mobileConnectionDiagnostics)),
                content: SizedBox(
                  width: 420,
                  child: SingleChildScrollView(child: SelectableText(summary)),
                ),
                actions: [
                  TextButton(
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: summary));
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(
                              tr(Msg.mobileSanitizedDiagnosticsCopied),
                            ),
                          ),
                        );
                      }
                    },
                    child: Text(tr(Msg.mobileCopyDiagnostics)),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: Text(tr(Msg.commonClose)),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    ),
  );
}

class ConnectionProgress extends StatelessWidget {
  const ConnectionProgress({super.key, required this.controller});
  final RemoteController controller;
  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          Text(
            tr(Msg.mobileValueAttemptValue, {
              'p0': (stageLabel(controller.state.diagnostics.stage)).toString(),
              'p1': (controller.state.diagnostics.attempt).toString(),
            }),
          ),
        ],
      ),
    ),
  );
}
