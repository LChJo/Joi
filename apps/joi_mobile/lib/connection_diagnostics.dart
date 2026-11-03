import 'i18n.dart';

enum ConnectionStage {
  idle,
  nativeConnect,
  endpointBind,
  endpointDial,
  endpointRetry,
  endpointRelayWait,
  streamOpen,
  transportHello,
  handshake,
  credentialSave,
  sessionReady,
  feedLoad,
  ready,
}

String stageLabel(ConnectionStage stage) => {
  ConnectionStage.idle: tr(Msg.mobileWaitingToConnect),
  ConnectionStage.nativeConnect: tr(Msg.mobileStartingNativeConnection),
  ConnectionStage.endpointBind: tr(Msg.mobileCreatingNetworkEndpoint),
  ConnectionStage.endpointDial: tr(Msg.mobileConnectingToComputerDirectRelay),
  ConnectionStage.endpointRetry: tr(Msg.mobileRedialingWithTheExistingEndpoint),
  ConnectionStage.endpointRelayWait: tr(Msg.mobileWaitingForRelayReadiness),
  ConnectionStage.streamOpen: tr(Msg.mobileOpeningControlChannel),
  ConnectionStage.transportHello: tr(Msg.mobileSendingTransportHandshake),
  ConnectionStage.handshake: tr(Msg.mobileVerifyingPairingResumeHandshake),
  ConnectionStage.credentialSave: tr(Msg.mobileSavingDeviceCredentials),
  ConnectionStage.sessionReady: tr(Msg.mobileSecureSessionEstablished),
  ConnectionStage.feedLoad: tr(Msg.mobileLoadingHomePage),
  ConnectionStage.ready: tr(Msg.mobileHomePageSynced),
}[stage]!;

// Never render arbitrary native errors, exception messages, or remote payloads.
String safeConnectionCode(String? value) =>
    const {
      'connectFailed',
      'nativeDiagnosticsV2',
      'nativeDiagnosticsV3',
      'endpointAvailable',
      'relayReady',
      'relayReadyTimeout',
      'quicTimedOut',
      'quicReset',
      'quicLocallyClosed',
      'quicVersionMismatch',
      'quicCidsExhausted',
      'quicPeerApplicationClosed',
      'quicPeerTransportClosed',
      'quicTransportError',
      'quicAuthenticationFailed',
      'quicLocallyRejected',
      'quicUnknownError',
      'quicTlsNoApplicationProtocol',
      'quicTlsHandshakeFailure',
      'quicTlsProtocolVersion',
      'quicTlsCertificateRejected',
      'quicTlsAlert',
      'receiveFailed',
      'sendFailed',
      'nativeStartFailed',
      'nativeConnectTimeout',
      'handshakeTimeout',
      'transportDisconnected',
      'hostProofInvalid',
      'frameReplayed',
      'frameInvalid',
      'eventHandlingFailed',
      'credentialReadFailed',
      'credentialWriteFailed',
      'feedFailed',
      'feedTimeout',
      'feedCursorExpired',
      'feedBusy',
      'feedTooLarge',
      'feedHostUnavailable',
      'feedHostFailed',
      'feedRejected',
      'feedInvalid',
      'feedSendFailed',
      'pairingTimeout',
      'ffiEventInvalid',
      'androidContextMissing',
      'androidContextReady',
    }.contains(value)
    ? value!
    : 'unknownFailure';

class ConnectionDiagnostics {
  const ConnectionDiagnostics({
    this.stage = ConnectionStage.idle,
    this.attempt = 0,
    this.lastFailure,
    this.history = const [],
    this.pairing = false,
  });
  final ConnectionStage stage;
  final int attempt;
  final String? lastFailure;
  final List<String> history;
  final bool pairing;

  ConnectionDiagnostics record({
    ConnectionStage? stage,
    String? code,
    bool failure = false,
    bool newAttempt = false,
    bool? pairing,
  }) {
    final nextStage = stage ?? this.stage;
    final nextAttempt = attempt + (newAttempt ? 1 : 0);
    final nextPairing = pairing ?? this.pairing;
    final line =
        '${DateTime.now().toUtc().toIso8601String()} #$nextAttempt '
        '${nextPairing ? 'pair' : 'resume'} ${nextStage.name}${code == null ? '' : ' ${safeConnectionCode(code)}'}';
    final entries = [...history, line];
    return ConnectionDiagnostics(
      stage: nextStage,
      attempt: nextAttempt,
      pairing: nextPairing,
      lastFailure: failure ? line : lastFailure,
      history: List.unmodifiable(
        entries.skip(entries.length > 40 ? entries.length - 40 : 0),
      ),
    );
  }

  String get summary =>
      tr(Msg.mobileJoiRemoteDiag3StageValueHandshakeValueAttempts, {
        'p0': (stageLabel(stage)).toString(),
        'p1': (pairing ? tr(Msg.exportStatePair) : tr(Msg.exportStateResume))
            .toString(),
        'p2': (attempt).toString(),
        'p3': (lastFailure ?? tr(Msg.exportStateNone)).toString(),
        'p4': (history.join('\n')).toString(),
      });
}
