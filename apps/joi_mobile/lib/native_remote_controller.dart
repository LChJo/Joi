import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'iroh_ffi_transport.dart';
import 'remote_controller.dart';
import 'connection_diagnostics.dart';
import 'i18n.dart';

const _credentialKey = 'joi.remote.native.credential.v1';

String _base64UrlNoPadding(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

Uint8List _decodeBase64Url(String value) =>
    base64Url.decode(base64Url.normalize(value));

bool _constantTimeEquals(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

class PairingCredential {
  const PairingCredential({
    required this.deviceId,
    required this.hostId,
    this.pairingId,
    required this.secret,
    required this.ticket,
  });

  final String deviceId;
  final String hostId;
  final String? pairingId;
  final String secret;
  final Map<String, Object?> ticket;

  factory PairingCredential.parse(String payload) {
    final uri = Uri.parse(payload.trim());
    if (uri.scheme != 'joi' ||
        uri.host != 'pair' ||
        uri.queryParameters['v'] != '1') {
      throw const FormatException('joi_pairing_uri_invalid');
    }
    final hostId = uri.queryParameters['host'] ?? '';
    final deviceId = uri.queryParameters['device'] ?? '';
    final pairingId = uri.queryParameters['pairing'] ?? '';
    final secret = uri.queryParameters['secret'] ?? '';
    final encodedTicket = uri.queryParameters['ticket'] ?? '';
    if (hostId.isEmpty ||
        deviceId.isEmpty ||
        pairingId.isEmpty ||
        _decodeBase64Url(secret).length != 32) {
      throw const FormatException('joi_pairing_uri_invalid');
    }
    final decoded = jsonDecode(utf8.decode(_decodeBase64Url(encodedTicket)));
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('joi_transport_ticket_invalid');
    }
    _validateTicket(decoded);
    return PairingCredential(
      deviceId: deviceId,
      hostId: hostId,
      pairingId: pairingId,
      secret: secret,
      ticket: Map<String, Object?>.from(decoded),
    );
  }

  factory PairingCredential.fromStoredJson(String value) {
    final decoded = jsonDecode(value);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('joi_credential_invalid');
    }
    final ticket = decoded['ticket'];
    if (decoded['deviceId'] is! String ||
        decoded['hostId'] is! String ||
        decoded['secret'] is! String ||
        ticket is! Map<String, dynamic> ||
        _decodeBase64Url(decoded['secret'] as String).length != 32) {
      throw const FormatException('joi_credential_invalid');
    }
    _validateTicket(ticket);
    return PairingCredential(
      deviceId: decoded['deviceId'] as String,
      hostId: decoded['hostId'] as String,
      secret: decoded['secret'] as String,
      ticket: Map<String, Object?>.from(ticket),
    );
  }

  String toStoredJson() => jsonEncode({
    'deviceId': deviceId,
    'hostId': hostId,
    'secret': secret,
    'ticket': ticket,
  });

  static void _validateTicket(Map<String, dynamic> ticket) {
    final direct = ticket['directAddresses'];
    final relays = ticket['relayUrls'];
    if (ticket['version'] != 1 ||
        ticket['endpointId'] is! String ||
        (ticket['endpointId'] as String).isEmpty ||
        direct is! List ||
        direct.any((value) => value is! String) ||
        relays is! List ||
        relays.any((value) => value is! String)) {
      throw const FormatException('joi_transport_ticket_invalid');
    }
  }
}

class RemoteSessionCrypto {
  static final _hmac = Hmac.sha256();

  static Future<String> handshakeProof(
    PairingCredential credential,
    String clientNonce, {
    required String mode,
  }) async {
    final mac = await _hmac.calculateMac(
      utf8.encode(_proofBody(credential, clientNonce, mode)),
      secretKey: SecretKey(_decodeBase64Url(credential.secret)),
    );
    return _base64UrlNoPadding(mac.bytes);
  }

  static Future<bool> verifyReady(
    PairingCredential credential,
    String clientNonce,
    String hostNonce,
    String proof, {
    required String mode,
  }) async {
    final mac = await _hmac.calculateMac(
      utf8.encode(
        '${_proofBody(credential, clientNonce, mode)}\n$hostNonce\nready',
      ),
      secretKey: SecretKey(_decodeBase64Url(credential.secret)),
    );
    return _constantTimeEquals(mac.bytes, _decodeBase64Url(proof));
  }

  static Future<SecretKey> deriveKey(
    PairingCredential credential,
    String clientNonce,
    String hostNonce,
  ) {
    return Hkdf(hmac: _hmac, outputLength: 32).deriveKey(
      secretKey: SecretKey(_decodeBase64Url(credential.secret)),
      nonce: Uint8List.fromList([
        ..._decodeBase64Url(clientNonce),
        ..._decodeBase64Url(hostNonce),
      ]),
      info: utf8.encode('joi-browser-remote-session-v1'),
    );
  }

  static Future<Map<String, Object?>> encrypt(
    SecretKey key,
    int sequence,
    Object payload,
    String connectionId,
  ) async {
    final box = await AesGcm.with256bits().encrypt(
      utf8.encode(jsonEncode(payload)),
      secretKey: key,
      aad: utf8.encode('joi-remote-v1\n$connectionId\n$sequence'),
    );
    return {
      'ciphertext': _base64UrlNoPadding(box.cipherText),
      'iv': _base64UrlNoPadding(box.nonce),
      'kind': 'encrypted',
      'seq': sequence,
      'tag': _base64UrlNoPadding(box.mac.bytes),
    };
  }

  static Future<Object?> decrypt(
    SecretKey key,
    Map<String, dynamic> frame,
    String connectionId,
  ) async {
    final sequence = frame['seq'];
    if (sequence is! int ||
        sequence < 1 ||
        frame['ciphertext'] is! String ||
        frame['iv'] is! String ||
        frame['tag'] is! String) {
      throw const FormatException('joi_encrypted_frame_invalid');
    }
    final cleartext = await AesGcm.with256bits().decrypt(
      SecretBox(
        _decodeBase64Url(frame['ciphertext'] as String),
        nonce: _decodeBase64Url(frame['iv'] as String),
        mac: Mac(_decodeBase64Url(frame['tag'] as String)),
      ),
      secretKey: key,
      aad: utf8.encode('joi-remote-v1\n$connectionId\n$sequence'),
    );
    return jsonDecode(utf8.decode(cleartext));
  }

  static String _proofBody(
    PairingCredential credential,
    String clientNonce,
    String mode,
  ) => [
    'joi-remote-v1',
    mode,
    credential.hostId,
    credential.deviceId,
    mode == 'pair' ? credential.pairingId ?? '' : '',
    clientNonce,
  ].join('\n');
}

abstract interface class RemoteCredentialStore {
  Future<String?> read();
  Future<void> write(String value);
}

class SecureRemoteCredentialStore implements RemoteCredentialStore {
  const SecureRemoteCredentialStore([
    this._storage = const FlutterSecureStorage(),
  ]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: _credentialKey);

  @override
  Future<void> write(String value) =>
      _storage.write(key: _credentialKey, value: value);
}

class NativeRemoteController extends ChangeNotifier
    implements RemoteController {
  NativeRemoteController({
    required RemoteCredentialStore credentials,
    required NativeTransport transport,
    Random? random,
  }) : _credentials = credentials,
       _random = random ?? Random.secure(),
       _transport = transport {
    _subscription = transport.events.listen((event) {
      _inbound = _inbound
          .then((_) => _onTransportEvent(event))
          .catchError(
            (Object error) => _handleDisconnect(code: _failureCode(error)),
          );
    });
  }

  final RemoteCredentialStore _credentials;
  final Random _random;
  final NativeTransport _transport;
  late final StreamSubscription<NativeTransportEvent> _subscription;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  PairingCredential? _credential;
  String? _clientNonce;
  SecretKey? _key;
  int _inboundSequence = 0;
  int _outboundSequence = 0;
  String _mode = 'resume';
  Timer? _reconnectTimer;
  Timer? _pairingTimer;
  Timer? _handshakeTimer;
  Timer? _refreshTimer;
  bool _refreshing = false;
  bool _foreground = true;
  bool _disposed = false;
  bool _handshakeSent = false;
  bool _feedLoaded = false;
  int _generation = 0;
  Future<void> _inbound = Future.value();
  Future<void> _outbound = Future.value();
  String? _pendingMessageKey;
  String? _pendingMessageSignature;
  RemoteViewState _state = const RemoteViewState();

  @override
  RemoteViewState get state => _state;

  Future<void> initialize() async {
    try {
      final saved = await _credentials.read();
      if (saved == null) return;
      await _connect(PairingCredential.fromStoredJson(saved), mode: 'resume');
    } catch (_) {
      _record(code: 'credentialReadFailed', failure: true);
      _setState(_state.copyWith(connection: RemoteConnectionState.offline));
    }
  }

  @override
  Future<void> connectFromQr(String payload) {
    final credential = PairingCredential.parse(payload);
    _pairingTimer?.cancel();
    _pairingTimer = Timer(const Duration(minutes: 2), () {
      _record(code: 'pairingTimeout', failure: true);
      _generation += 1;
      _credential = null;
      _key = null;
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      _handshakeTimer?.cancel();
      unawaited(_transport.close());
      _setState(
        _state.copyWith(
          connection: RemoteConnectionState.unpaired,
          notice: '未能连接电脑。请确认电脑在线、两端已更新，并在电脑上生成新二维码重试。',
        ),
      );
    });
    return _connect(credential, mode: 'pair');
  }

  Future<void> _connect(
    PairingCredential credential, {
    required String mode,
  }) async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _handshakeTimer?.cancel();
    _generation += 1;
    for (final pending in _pending.values) {
      if (!pending.isCompleted) {
        pending.completeError(StateError('joi_remote_disconnected'));
      }
    }
    _pending.clear();
    if (_credential?.hostId != credential.hostId) {
      _state = const RemoteViewState();
      _pendingMessageKey = null;
      _pendingMessageSignature = null;
    }
    _credential = credential;
    _mode = mode;
    _handshakeSent = false;
    _feedLoaded = false;
    _key = null;
    _clientNonce = null;
    _inboundSequence = 0;
    _outboundSequence = 0;
    _setState(
      _state.copyWith(
        connection: RemoteConnectionState.connecting,
        supportsHome: false,
      ),
    );
    final generation = _generation;
    _record(stage: ConnectionStage.nativeConnect, newAttempt: true);
    // Native: three bounded dials plus relay readiness (at most 28s),
    // with headroom for bind/stream setup. Application handshake gets its own budget.
    _handshakeTimer = Timer(const Duration(seconds: 45), () {
      if (generation == _generation) {
        _handleDisconnect(
          code: _handshakeSent ? 'handshakeTimeout' : 'nativeConnectTimeout',
        );
      }
    });
    try {
      await _transport.connect(
        connectionId: credential.deviceId,
        ticket: credential.ticket,
      );
    } catch (_) {
      if (generation == _generation) {
        _handleDisconnect(code: 'nativeStartFailed');
      }
    }
  }

  @override
  Future<void> refresh() async {
    if (_refreshing ||
        !_foreground ||
        _state.connection != RemoteConnectionState.connected) {
      return;
    }
    _refreshing = true;
    final generation = _generation;
    try {
      final result = await read('feed.get');
      final goals = result['goals'];
      final cards = <RemoteGoalCard>[];
      if (goals is List) {
        for (final item in goals) {
          if (item is! Map<String, dynamic> ||
              item['title'] is! String ||
              item['status'] is! String) {
            continue;
          }
          final thinking = (result['thinking'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .where((t) => t['goalId'] == item['goalId']);
          cards.add(
            RemoteGoalCard.fromJson(
              item,
              stage: thinking.firstOrNull?['stage'] as String?,
            ),
          );
        }
      }
      for (final item
          in (result['unassignedActions'] as List? ?? [])
              .whereType<Map<String, dynamic>>()) {
        cards.add(RemoteGoalCard.fromJson(item));
      }
      if (generation == _generation) {
        if (!_feedLoaded) {
          _feedLoaded = true;
          _record(stage: ConnectionStage.ready);
        }
        // The host sends every card in one list and marks the filed-away ones with `archivedAt`;
        // the home screen and the archive screen each get their own half.
        _setState(
          _state.copyWith(
            goals: cards.where((card) => !card.archived).toList(),
            archivedGoals: cards.where((card) => card.archived).toList(),
            clearNotice: true,
          ),
        );
      }
    } finally {
      _refreshing = false;
    }
  }

  @override
  Future<void> sendMessage(String text, {String? workbenchId}) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _state.sending) return;
    if (_state.connection != RemoteConnectionState.connected) {
      throw StateError('joi_remote_not_ready');
    }
    if (workbenchId != null && !_state.supportsHome) {
      throw StateError('remote_upgrade_required');
    }
    final signature = jsonEncode([trimmed, workbenchId]);
    if (_pendingMessageSignature != signature || _pendingMessageKey == null) {
      _pendingMessageSignature = signature;
      _pendingMessageKey = 'mobile:${_requestId('message')}';
    }
    final generation = _generation;
    _setState(_state.copyWith(sending: true, clearNotice: true));
    try {
      await _sendCommand({
        'idempotencyKey': _pendingMessageKey,
        'kind': 'message.send',
        'requestId': _requestId('send'),
        'text': trimmed,
        'workbenchId': ?workbenchId,
      });
      if (generation != _generation) {
        throw StateError('joi_remote_disconnected');
      }
      _pendingMessageKey = null;
      _pendingMessageSignature = null;
      unawaited(_refreshSafely());
    } finally {
      if (generation == _generation) _setState(_state.copyWith(sending: false));
    }
  }

  @override
  Future<RemoteWorkbenchCreation> createWorkbench({
    required String inputId,
    required String name,
    required String personaSummary,
    required String projectLabel,
    required String scopeSummary,
    String? questionId,
    int? questionVersion,
    String? idempotencyKey,
  }) async {
    if (!_state.supportsWorkbenchCreation) {
      throw StateError('remote_upgrade_required');
    }
    final generation = _generation;
    final response = await _sendCommand({
      'kind': 'workbench.create',
      'requestId': _requestId('workbench'),
      'inputId': inputId,
      'name': name,
      'personaSummary': personaSummary,
      'projectLabel': projectLabel,
      'scopeSummary': scopeSummary,
      // The host creates and binds in one request; a second clarify on top of it was the step
      // that failed while the workbench already existed, stranding the task.
      'bindInputId': inputId,
      if (_state.supportsWorkbenchChoice) ...{
        'questionId': questionId ?? 'legacy_question:$inputId',
        'questionVersion': questionVersion ?? 1,
        'idempotencyKey':
            idempotencyKey ??
            'workbench-choice:$inputId:v${questionVersion ?? 1}',
      },
    });
    final result = response['result'];
    if (generation != _generation || result is! Map<String, dynamic>) {
      throw StateError('remote_read_invalid');
    }
    final workbenchId = result['workbenchId'];
    final resultName = result['name'];
    if (workbenchId is! String || resultName is! String) {
      throw StateError('remote_read_invalid');
    }
    final choice = RemoteChoice(
      workbenchId,
      resultName,
      result['scopeSummary'] as String? ?? '',
    );
    _setState(
      _state.copyWith(
        workbenches: [
          ..._state.workbenches.where((item) => item.id != choice.id),
          choice,
        ],
      ),
    );
    return RemoteWorkbenchCreation(
      choice.id,
      choice.name,
      bound: result['bound'] == true,
    );
  }

  Future<void> _refreshSafely() async {
    final generation = _generation;
    try {
      await refresh();
    } catch (_) {
      if (generation == _generation) {
        _record(code: 'feedFailed', failure: true);
        _setState(_state.copyWith(notice: '未能刷新，已保留上次内容。下拉重试。'));
      }
    }
  }

  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  }) async {
    if (kind != 'feed.get' && !_state.supportsHome) {
      throw StateError('remote_upgrade_required');
    }
    final generation = _generation;
    var response = await _sendCommand({
      'kind': kind,
      'requestId': _requestId('read'),
      if (kind == 'feed.get' && _state.supportsHome) 'paged': true,
      'goalId': ?goalId,
      'agentId': ?agentId,
      'cursor': ?cursor,
    });
    var result = response['result'];
    if (result is Map<String, dynamic> && result['encoding'] == 'json') {
      final buffer = StringBuffer();
      var bytes = 0;
      while (true) {
        if (generation != _generation ||
            result is! Map<String, dynamic> ||
            result['chunk'] is! String) {
          throw StateError('remote_read_invalid');
        }
        final chunk = result['chunk'] as String;
        bytes += utf8.encode(chunk).length;
        if (bytes > 16 * 1024 * 1024) throw StateError('remote_read_too_large');
        buffer.write(chunk);
        final next = result['nextCursor'];
        if (next == null) break;
        response = await _sendCommand({
          'kind': 'read.next',
          'requestId': _requestId('page'),
          'cursor': next,
        });
        result = response['result'];
      }
      result = jsonDecode(buffer.toString());
    }
    if (generation != _generation || result is! Map<String, dynamic>) {
      throw StateError('remote_read_invalid');
    }
    return result;
  }

  Future<void> _loadCatalog() async {
    final generation = _generation;
    try {
      final result = await read('catalog.get');
      if (generation != _generation) return;
      _setState(
        _state.copyWith(
          workbenches: (result['workbenches'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(
                (b) => RemoteChoice(
                  b['workbenchId'] as String,
                  b['name'] as String,
                  b['scopeSummary'] as String? ?? '',
                ),
              )
              .toList(),
          partners: (result['partners'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(
                (p) => RemoteChoice(
                  p['partnerId'] as String,
                  p['displayName'] as String,
                ),
              )
              .toList(),
        ),
      );
    } catch (_) {
      if (generation == _generation) {
        _setState(_state.copyWith(notice: '工作台列表未能更新，请重新刷新。'));
      }
    }
  }

  @override
  Future<void> act(
    String inputId,
    String action, {
    String? text,
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
    String? questionId,
    int? questionVersion,
  }) async {
    if (!_state.supportsHome) throw StateError('remote_upgrade_required');
    if (_state.busyGoals.contains(inputId)) return;
    final generation = _generation;
    _setState(_state.copyWith(busyGoals: {..._state.busyGoals, inputId}));
    try {
      await _sendCommand({
        'kind': 'message.$action',
        'requestId': _requestId('action'),
        'inputId': inputId,
        if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
        'workbenchId': ?workbenchId,
        'partnerId': ?partnerId,
        'actionChoice': ?actionChoice,
        'questionId': ?questionId,
        'questionVersion': ?questionVersion,
      });
      if (generation != _generation) {
        throw StateError('joi_remote_disconnected');
      }
      if (action == 'dismiss') {
        _setState(
          _state.copyWith(
            goals: _state.goals.where((g) => g.goalId != inputId).toList(),
            archivedGoals: _state.archivedGoals
                .where((g) => g.goalId != inputId)
                .toList(),
          ),
        );
      }
      // Archiving is a move between two lists, not a disappearance, so both halves are rewritten
      // here; waiting for the next poll would leave the card sitting where the user just removed it.
      if (action == 'archive') {
        final moved = _state.goals.where((g) => g.goalId == inputId);
        _setState(
          _state.copyWith(
            goals: _state.goals.where((g) => g.goalId != inputId).toList(),
            archivedGoals: [
              ...moved.map(
                (g) =>
                    g.withArchivedAt(DateTime.now().toUtc().toIso8601String()),
              ),
              ..._state.archivedGoals,
            ],
          ),
        );
      }
      if (action == 'unarchive') {
        final moved = _state.archivedGoals.where((g) => g.goalId == inputId);
        _setState(
          _state.copyWith(
            goals: [
              ...moved.map((g) => g.withArchivedAt(null)),
              ..._state.goals,
            ],
            archivedGoals: _state.archivedGoals
                .where((g) => g.goalId != inputId)
                .toList(),
          ),
        );
      }
    } finally {
      if (generation == _generation) {
        _setState(
          _state.copyWith(busyGoals: {..._state.busyGoals}..remove(inputId)),
        );
        unawaited(_refreshSafely());
      }
    }
  }

  @override
  void setForeground(bool value) {
    _foreground = value;
    if (value && _state.connection == RemoteConnectionState.connected) {
      unawaited(_refreshSafely());
      if (_state.supportsHome) unawaited(_loadCatalog());
    }
  }

  Future<Map<String, dynamic>> _sendCommand(
    Map<String, Object?> command,
  ) async {
    final key = _key;
    final credential = _credential;
    final requestId = command['requestId'];
    if (key == null || credential == null || requestId is! String) {
      throw StateError('joi_remote_not_ready');
    }
    final completer = Completer<Map<String, dynamic>>();
    _pending[requestId] = completer;
    final generation = _generation;
    try {
      final reply = completer.future.timeout(const Duration(seconds: 20));
      // Attach the error listener before queued transport work can disconnect.
      unawaited(reply.then<void>((_) {}, onError: (Object _) {}));
      final sent = _outbound.then((_) async {
        if (generation != _generation) {
          throw StateError('joi_remote_disconnected');
        }
        _outboundSequence += 1;
        await _transport.send(
          await RemoteSessionCrypto.encrypt(
            key,
            _outboundSequence,
            command,
            credential.deviceId,
          ),
        );
      });
      _outbound = sent.catchError((_) {});
      await sent;
      return await reply;
    } catch (error, stack) {
      if (!completer.isCompleted) completer.completeError(error, stack);
      rethrow;
    } finally {
      _pending.remove(requestId);
    }
  }

  Future<void> _onTransportEvent(NativeTransportEvent event) async {
    if (_disposed || _credential == null || _reconnectTimer != null) return;
    if (event.type == 'diagnostic') {
      final stage = ConnectionStage.values
          .where((s) => s.name == event.stage)
          .firstOrNull;
      _record(stage: stage, code: event.code);
      return;
    }
    if (event.type == 'connected') {
      _handshakeTimer?.cancel();
      final handshakeGeneration = _generation;
      _handshakeTimer = Timer(const Duration(seconds: 15), () {
        if (handshakeGeneration == _generation) {
          _handleDisconnect(code: 'handshakeTimeout');
        }
      });
      _record(stage: ConnectionStage.handshake);
      final credential = _credential;
      if (credential == null) return;
      final nonce = Uint8List.fromList(
        List<int>.generate(24, (_) => _random.nextInt(256)),
      );
      _clientNonce = _base64UrlNoPadding(nonce);
      final path = _pathFromName(event.path);
      _setState(
        _state.copyWith(
          connection: RemoteConnectionState.connecting,
          path: path,
        ),
      );
      final generation = _generation;
      final proof = await RemoteSessionCrypto.handshakeProof(
        credential,
        _clientNonce!,
        mode: _mode,
      );
      if (generation != _generation || _disposed) return;
      _handshakeSent = true;
      await _transport.send({
        'clientNonce': _clientNonce,
        'deviceId': credential.deviceId,
        'deviceName': 'Joi Android',
        'hostId': credential.hostId,
        'kind': 'handshake.hello',
        'mode': _mode,
        if (_mode == 'pair') 'pairingId': credential.pairingId,
        'proof': proof,
        'version': 1,
      });
      return;
    }
    if (event.type == 'path') {
      _setState(
        _state.copyWith(
          connection: _state.connection,
          goals: _state.goals,
          path: _pathFromName(event.path),
          sending: _state.sending,
        ),
      );
      return;
    }
    if (event.type == 'frame') {
      await _onFrame(event.frame);
      return;
    }
    if (event.type == 'disconnected' || event.type == 'error') {
      _handleDisconnect(code: event.code ?? 'transportDisconnected');
    }
  }

  void _handleDisconnect({String code = 'transportDisconnected'}) {
    if (_disposed || _credential == null || _reconnectTimer != null) return;
    _record(code: code, failure: true);
    _handshakeTimer?.cancel();
    _generation += 1;
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('joi_remote_disconnected'));
      }
    }
    _pending.clear();
    _key = null;
    _refreshTimer?.cancel();
    _refreshTimer = null;
    _setState(
      _state.copyWith(
        connection: RemoteConnectionState.reconnecting,
        sending: false,
        busyGoals: {},
      ),
    );
    _scheduleReconnect();
  }

  Future<void> _onFrame(Object? value) async {
    final generation = _generation;
    if (value is! Map<String, dynamic>) return;
    final credential = _credential;
    final clientNonce = _clientNonce;
    if (_key == null) {
      if (credential == null ||
          clientNonce == null ||
          value['kind'] != 'handshake.ready' ||
          value['hostNonce'] is! String ||
          value['proof'] is! String ||
          !await RemoteSessionCrypto.verifyReady(
            credential,
            clientNonce,
            value['hostNonce'] as String,
            value['proof'] as String,
            mode: _mode,
          )) {
        throw const FormatException('joi_remote_host_proof_invalid');
      }
      final key = await RemoteSessionCrypto.deriveKey(
        credential,
        clientNonce,
        value['hostNonce'] as String,
      );
      if (generation != _generation || _disposed) return;
      _key = key;
      if (credential.pairingId != null) {
        _record(stage: ConnectionStage.credentialSave);
        final resumable = PairingCredential(
          deviceId: credential.deviceId,
          hostId: credential.hostId,
          secret: credential.secret,
          ticket: credential.ticket,
        );
        _credential = resumable;
        await _credentials.write(resumable.toStoredJson());
      }
      if (generation != _generation || _disposed) return;
      _mode = 'resume';
      _record(stage: ConnectionStage.sessionReady);
      _handshakeTimer?.cancel();
      _pairingTimer?.cancel();
      _setState(
        _state.copyWith(
          connection: RemoteConnectionState.connected,
          supportsHome:
              value['capabilities'] is List &&
              (value['capabilities'] as List).contains('home.v2'),
          supportsWorkbenchChoice:
              value['capabilities'] is List &&
              (value['capabilities'] as List).contains('workbench.choice.v1'),
          supportsWorkbenchCreation:
              value['capabilities'] is List &&
              (value['capabilities'] as List).contains('workbench.create'),
          sending: false,
          busyGoals: {},
        ),
      );
      _refreshTimer?.cancel();
      _refreshTimer = Timer.periodic(const Duration(seconds: 2), (_) {
        if (_foreground &&
            _state.connection == RemoteConnectionState.connected &&
            !_state.sending) {
          unawaited(_refreshSafely());
        }
      });
      _record(stage: ConnectionStage.feedLoad);
      unawaited(_refreshSafely());
      if (_state.supportsHome) unawaited(_loadCatalog());
      return;
    }
    final sequence = value['seq'];
    if (sequence is! int || sequence <= _inboundSequence) {
      throw const FormatException('joi_remote_frame_replayed');
    }
    final response = await RemoteSessionCrypto.decrypt(
      _key!,
      value,
      credential!.deviceId,
    );
    if (generation != _generation || _disposed) return;
    _inboundSequence = sequence;
    if (response is! Map<String, dynamic> || response['requestId'] is! String) {
      return;
    }
    final completer = _pending[response['requestId'] as String];
    if (response['error'] != null) {
      if (completer != null && !completer.isCompleted) {
        // The code travels: a refusal the screen can name is a refusal the user can act on and a
        // bug report can quote. Flattening them all into one failure threw that away here.
        completer.completeError(remoteFailureOf(response));
      }
    } else {
      if (completer != null && !completer.isCompleted) {
        completer.complete(response);
      }
    }
  }

  void _scheduleReconnect() {
    if (_credential == null || _reconnectTimer != null) return;
    // A lost pair receipt may mean the host already consumed the offer. Try
    // resume in that case, then pair again if the host never registered us.
    final mode = _credential!.pairingId == null
        ? 'resume'
        : _handshakeSent
        ? (_mode == 'pair' ? 'resume' : 'pair')
        : _mode;
    _reconnectTimer = Timer(const Duration(seconds: 2), () {
      _reconnectTimer = null;
      final credential = _credential;
      if (credential != null) {
        unawaited(
          _connect(
            credential,
            mode: mode,
          ).catchError((_) => _handleDisconnect()),
        );
      }
    });
  }

  void _setState(RemoteViewState value) {
    if (_disposed) return;
    _state = value;
    notifyListeners();
  }

  String _failureCode(Object error) {
    if (_state.diagnostics.stage == ConnectionStage.credentialSave) {
      return 'credentialWriteFailed';
    }
    if (error is FormatException) {
      return switch (error.message) {
        'joi_remote_host_proof_invalid' => 'hostProofInvalid',
        'joi_remote_frame_replayed' => 'frameReplayed',
        'joi_encrypted_frame_invalid' => 'frameInvalid',
        _ => 'eventHandlingFailed',
      };
    }
    return 'eventHandlingFailed';
  }

  void _record({
    ConnectionStage? stage,
    String? code,
    bool failure = false,
    bool newAttempt = false,
  }) {
    final diagnostics = _state.diagnostics.record(
      pairing: _mode == 'pair',
      stage: stage,
      code: code,
      failure: failure,
      newAttempt: newAttempt,
    );
    _setState(
      _state.copyWith(
        diagnostics: diagnostics,
        notice: failure
            ? '连接诊断：${stageLabel(diagnostics.stage)} · ${safeConnectionCode(code)}'
            : null,
        localizedNotice: failure
            ? UiNotice(Msg.mobileConnectionDiagnosticsValueValue, {
                'p0': productNotice(stageLabel(diagnostics.stage)),
                'p1': safeConnectionCode(code),
              })
            : null,
      ),
    );
    // Only locally constructed enum labels/counters and allowlisted codes.
    debugPrint('joi.remote ${diagnostics.history.last}');
  }

  String _requestId(String prefix) {
    final randomPart = List<int>.generate(12, (_) => _random.nextInt(256));
    return '$prefix-${_base64UrlNoPadding(randomPart)}';
  }

  RemoteConnectionPath _pathFromName(String? path) => switch (path) {
    'direct' => RemoteConnectionPath.direct,
    'relay' => RemoteConnectionPath.relay,
    _ => RemoteConnectionPath.mixed,
  };

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    for (final pending in _pending.values) {
      if (!pending.isCompleted) {
        pending.completeError(StateError('joi_remote_disconnected'));
      }
    }
    _pending.clear();
    _reconnectTimer?.cancel();
    _refreshTimer?.cancel();
    _handshakeTimer?.cancel();
    _pairingTimer?.cancel();
    unawaited(_subscription.cancel());
    unawaited(_transport.close());
    super.dispose();
  }
}
