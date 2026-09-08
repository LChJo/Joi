enum ConnectionStage {
  idle,
  nativeConnect,
  endpointBind,
  endpointDial,
  streamOpen,
  transportHello,
  handshake,
  credentialSave,
  sessionReady,
  feedLoad,
  ready,
}

String stageLabel(ConnectionStage stage) => const {
  ConnectionStage.idle: '等待连接',
  ConnectionStage.nativeConnect: '启动原生连接',
  ConnectionStage.endpointBind: '创建网络端点',
  ConnectionStage.endpointDial: '连接电脑（直连/中继）',
  ConnectionStage.streamOpen: '打开控制通道',
  ConnectionStage.transportHello: '发送传输握手',
  ConnectionStage.handshake: '验证配对/恢复握手',
  ConnectionStage.credentialSave: '保存设备凭据',
  ConnectionStage.sessionReady: '安全会话已建立',
  ConnectionStage.feedLoad: '读取首页',
  ConnectionStage.ready: '首页已同步',
}[stage]!;

// Never render arbitrary native errors, exception messages, or remote payloads.
String safeConnectionCode(String? value) =>
    const {
      'connectFailed',
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
      'joi remote-diag-1\n阶段：${stageLabel(stage)}\n'
      '握手：${pairing ? '首次配对 pair' : '恢复连接 resume'}\n'
      '尝试：$attempt\n最近失败：${lastFailure ?? '无'}\n${history.join('\n')}';
}
