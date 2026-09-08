import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/connection_diagnostics.dart';
import 'package:joi_mobile/iroh_ffi_transport.dart';

void main() {
  test(
    'native event preserves stage and code without interpreting payload',
    () {
      final event = NativeTransportEvent.fromJson({
        'type': 'error',
        'code': 'connectFailed',
        'stage': 'endpointDial',
      });
      expect(event.code, 'connectFailed');
      expect(event.stage, 'endpointDial');
    },
  );
  test(
    'history is bounded, retains failure and excludes untrusted strings',
    () {
      var diagnostics = const ConnectionDiagnostics().record(
        stage: ConnectionStage.endpointDial,
        code: 'secret=private /home/private',
        failure: true,
        newAttempt: true,
      );
      for (var i = 0; i < 70; i++) {
        diagnostics = diagnostics.record(
          stage: ConnectionStage.nativeConnect,
          newAttempt: true,
        );
      }
      expect(diagnostics.history.length, 40);
      expect(diagnostics.lastFailure, contains('unknownFailure'));
      expect(diagnostics.summary, isNot(contains('private')));
      expect(diagnostics.attempt, 71);
    },
  );
}
