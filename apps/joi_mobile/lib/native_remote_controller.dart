import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'iroh_ffi_transport.dart';
import 'remote_controller.dart';

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
    credential.pairingId ?? '',
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
      unawaited(_onTransportEvent(event).catchError((_) => _handleDisconnect()));
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
  Timer? _refreshTimer;
  bool _refreshing = false;
  RemoteViewState _state = const RemoteViewState();

  @override
  RemoteViewState get state => _state;

  Future<void> initialize() async {
    final saved = await _credentials.read();
    if (saved == null) return;
    try {
      await _connect(PairingCredential.fromStoredJson(saved), mode: 'resume');
    } catch (_) {
      _setState(
        const RemoteViewState(connection: RemoteConnectionState.offline),
      );
    }
  }

  @override
  Future<void> connectFromQr(String payload) =>
      _connect(PairingCredential.parse(payload), mode: 'pair');

  Future<void> _connect(
    PairingCredential credential, {
    required String mode,
  }) async {
    _reconnectTimer?.cancel();
    _credential = credential;
    _mode = mode;
    _key = null;
    _clientNonce = null;
    _inboundSequence = 0;
    _outboundSequence = 0;
    _setState(
      RemoteViewState(
        connection: RemoteConnectionState.connecting,
        goals: _state.goals,
      ),
    );
    await _transport.connect(
      connectionId: credential.deviceId,
      ticket: credential.ticket,
    );
  }

  @override
  Future<void> refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final response = await _sendCommand({
        'kind': 'feed.get',
        'requestId': _requestId('feed'),
      });
      final result = response['result'];
      if (result is! Map<String, dynamic>) {
        throw const FormatException('joi_feed_invalid');
      }
      final goals = result['goals'];
      final cards = <RemoteGoalCard>[];
      if (goals is List) {
        for (final item in goals) {
          if (item is! Map<String, dynamic> ||
              item['title'] is! String ||
              item['status'] is! String) {
            continue;
          }
          final work = item['work'];
          cards.add(
            RemoteGoalCard(
              activeWork: work is Map<String, dynamic> && work['active'] is int
                  ? work['active'] as int
                  : 0,
              completedWork:
                  work is Map<String, dynamic> && work['completed'] is int
                  ? work['completed'] as int
                  : 0,
              status: item['status'] as String,
              title: item['title'] as String,
              totalWork: work is Map<String, dynamic> && work['total'] is int
                  ? work['total'] as int
                  : 0,
            ),
          );
        }
      }
      _setState(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          goals: cards,
          path: _state.path,
        ),
      );
    } finally {
      _refreshing = false;
    }
  }

  @override
  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    _setState(
      RemoteViewState(
        connection: _state.connection,
        goals: _state.goals,
        path: _state.path,
        sending: true,
      ),
    );
    try {
      await _sendCommand({
        'idempotencyKey': 'mobile:${_requestId('message')}',
        'kind': 'message.send',
        'requestId': _requestId('send'),
        'text': trimmed,
      });
      await refresh();
    } finally {
      _setState(
        RemoteViewState(
          connection: _state.connection,
          goals: _state.goals,
          path: _state.path,
        ),
      );
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
    _outboundSequence += 1;
    try {
      await _transport.send(
        await RemoteSessionCrypto.encrypt(
          key,
          _outboundSequence,
          command,
          credential.deviceId,
        ),
      );
      return await completer.future.timeout(const Duration(seconds: 20));
    } finally {
      _pending.remove(requestId);
    }
  }

  Future<void> _onTransportEvent(NativeTransportEvent event) async {
    if (event.type == 'connected') {
      final credential = _credential;
      if (credential == null) return;
      final nonce = Uint8List.fromList(
        List<int>.generate(24, (_) => _random.nextInt(256)),
      );
      _clientNonce = _base64UrlNoPadding(nonce);
      final path = _pathFromName(event.path);
      _setState(
        RemoteViewState(
          connection: RemoteConnectionState.connecting,
          goals: _state.goals,
          path: path,
        ),
      );
      await _transport.send({
        'clientNonce': _clientNonce,
        'deviceId': credential.deviceId,
        'deviceName': 'Joi Android',
        'hostId': credential.hostId,
        'kind': 'handshake.hello',
        'mode': _mode,
        if (credential.pairingId != null) 'pairingId': credential.pairingId,
        'proof': await RemoteSessionCrypto.handshakeProof(
          credential,
          _clientNonce!,
          mode: _mode,
        ),
        'version': 1,
      });
      return;
    }
    if (event.type == 'path') {
      _setState(
        RemoteViewState(
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
      _handleDisconnect();
    }
  }

  void _handleDisconnect() {
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
      RemoteViewState(
        connection: RemoteConnectionState.reconnecting,
        goals: _state.goals,
      ),
    );
    _scheduleReconnect();
  }

  Future<void> _onFrame(Object? value) async {
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
      _key = await RemoteSessionCrypto.deriveKey(
        credential,
        clientNonce,
        value['hostNonce'] as String,
      );
      if (_mode == 'pair') {
        final resumable = PairingCredential(
          deviceId: credential.deviceId,
          hostId: credential.hostId,
          secret: credential.secret,
          ticket: credential.ticket,
        );
        _credential = resumable;
        await _credentials.write(resumable.toStoredJson());
      }
      _setState(
        RemoteViewState(
          connection: RemoteConnectionState.connected,
          goals: _state.goals,
          path: _state.path,
        ),
      );
      _refreshTimer?.cancel();
      _refreshTimer = Timer.periodic(const Duration(seconds: 2), (_) {
        if (_state.connection == RemoteConnectionState.connected &&
            !_state.sending) {
          unawaited(refresh().catchError((_) {}));
        }
      });
      unawaited(refresh().catchError((_) {}));
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
    _inboundSequence = sequence;
    if (response is! Map<String, dynamic> || response['requestId'] is! String) {
      return;
    }
    final completer = _pending[response['requestId'] as String];
    if (response['error'] != null) {
      completer?.completeError(StateError('joi_remote_command_failed'));
    } else {
      completer?.complete(response);
    }
  }

  void _scheduleReconnect() {
    if (_credential == null || _reconnectTimer != null) return;
    _reconnectTimer = Timer(const Duration(seconds: 2), () {
      _reconnectTimer = null;
      final credential = _credential;
      if (credential != null) unawaited(_connect(credential, mode: 'resume'));
    });
  }

  void _setState(RemoteViewState value) {
    _state = value;
    notifyListeners();
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
    _reconnectTimer?.cancel();
    _refreshTimer?.cancel();
    unawaited(_subscription.cancel());
    unawaited(_transport.close());
    super.dispose();
  }
}
