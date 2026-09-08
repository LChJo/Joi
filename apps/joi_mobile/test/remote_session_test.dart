import 'dart:async';
import 'dart:convert';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/iroh_ffi_transport.dart';
import 'package:joi_mobile/native_remote_controller.dart';
import 'package:joi_mobile/remote_controller.dart';

const credential = PairingCredential(
  deviceId: 'device',
  hostId: 'host',
  secret: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  ticket: {
    'endpointId': 'ep',
    'directAddresses': <String>[],
    'relayUrls': <String>[],
    'version': 1,
  },
);

class MemoryCredentials implements RemoteCredentialStore {
  String? written;
  @override
  Future<String?> read() async => credential.toStoredJson();
  @override
  Future<void> write(String value) async {
    written = value;
  }
}

class Peer implements NativeTransport {
  final hellos = <Map<String, dynamic>>[];
  bool failFirstConnect = false;
  bool losePairReady = false;
  bool registered = false;
  bool enforcePairing = false;
  bool losePairHello = false;
  bool silent = false;
  final bus = StreamController<NativeTransportEvent>.broadcast();
  final commands = <Map<String, dynamic>>[];
  final sequences = <int>[];
  bool modern = true;
  bool failSend = false;
  bool failFeed = false;
  SecretKey? key;
  int sequence = 0;
  String tail = '';
  @override
  Stream<NativeTransportEvent> get events => bus.stream;
  @override
  Future<void> close() async {}
  @override
  Future<void> connect({
    required String connectionId,
    required Map<String, Object?> ticket,
  }) async {
    sequence = 0;
    if (silent) return;
    if (failFirstConnect) {
      failFirstConnect = false;
      bus.add(const NativeTransportEvent(type: 'disconnected'));
      return;
    }
    bus.add(const NativeTransportEvent(type: 'connected', path: 'direct'));
  }

  @override
  Future<void> send(Object value) async {
    final frame = Map<String, dynamic>.from(value as Map);
    if (frame['kind'] == 'handshake.hello') {
      hellos.add(frame);
      final clientBody =
          'joi-remote-v1\n${frame['mode']}\nhost\ndevice\n${frame['mode'] == 'pair' ? frame['pairingId'] : ''}\n${frame['clientNonce']}';
      final clientProof = await Hmac.sha256().calculateMac(
        utf8.encode(clientBody),
        secretKey: SecretKey(
          base64Url.decode(base64Url.normalize(credential.secret)),
        ),
      );
      expect(
        frame['proof'],
        base64Url.encode(clientProof.bytes).replaceAll('=', ''),
      );
      if (losePairHello && frame['mode'] == 'pair') {
        losePairHello = false;
        bus.add(const NativeTransportEvent(type: 'disconnected'));
        return;
      }
      if (enforcePairing &&
          ((frame['mode'] == 'resume' && !registered) ||
              (frame['mode'] == 'pair' && registered))) {
        bus.add(const NativeTransportEvent(type: 'disconnected'));
        return;
      }
      if (frame['mode'] == 'pair') registered = true;
      if (losePairReady && frame['mode'] == 'pair') {
        losePairReady = false;
        bus.add(const NativeTransportEvent(type: 'disconnected'));
        return;
      }
      final nonce = base64Url.encode(List.filled(24, 4)).replaceAll('=', '');
      final proofBody =
          'joi-remote-v1\n${frame['mode']}\nhost\ndevice\n${frame['pairingId'] ?? ''}\n${frame['clientNonce']}\n$nonce\nready';
      final proof = await Hmac.sha256().calculateMac(
        utf8.encode(proofBody),
        secretKey: SecretKey(
          base64Url.decode(base64Url.normalize(credential.secret)),
        ),
      );
      key = await RemoteSessionCrypto.deriveKey(
        credential,
        frame['clientNonce'] as String,
        nonce,
      );
      bus.add(
        NativeTransportEvent(
          type: 'frame',
          frame: <String, dynamic>{
            'kind': 'handshake.ready',
            'version': 1,
            'hostNonce': nonce,
            'proof': base64Url.encode(proof.bytes).replaceAll('=', ''),
            if (modern) 'capabilities': ['home.v2'],
          },
        ),
      );
      return;
    }
    sequences.add(frame['seq'] as int);
    final command =
        await RemoteSessionCrypto.decrypt(key!, frame, credential.deviceId)
            as Map<String, dynamic>;
    commands.add(command);
    if (command['kind'] == 'message.send' && failSend) {
      failSend = false;
      throw StateError('receipt lost');
    }
    Object result = {'goals': [], 'thinking': [], 'unassignedActions': []};
    if (command['kind'] == 'catalog.get') {
      result = {
        'workbenches': [
          {'workbenchId': 'b', 'name': 'Research'},
        ],
        'partners': [],
      };
    }
    if (command['kind'] == 'message.send') {
      result = {'inputId': 'goal', 'status': 'PENDING'};
    }
    if (command['kind'] == 'goal.get') {
      final text = jsonEncode({'text': '中文😀' * 10000});
      tail = text.substring(10000);
      result = {
        'encoding': 'json',
        'chunk': text.substring(0, 10000),
        'nextCursor': 'next',
      };
    }
    if (command['kind'] == 'read.next') {
      result = {'encoding': 'json', 'chunk': tail};
    }
    final response = {
      'requestId': command['requestId'],
      'kind': 'response',
      if (command['kind'] == 'feed.get' && failFeed)
        'error': {'code': 'failed'}
      else
        'result': result,
    };
    final encrypted = await RemoteSessionCrypto.encrypt(
      key!,
      ++sequence,
      response,
      credential.deviceId,
    );
    bus.add(
      NativeTransportEvent(
        type: 'frame',
        frame: Map<String, dynamic>.from(encrypted),
      ),
    );
  }
}

Future<void> settleUntil(bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(ready(), isTrue);
}

void main() {
  test(
    'native failures retain stage, unknown errors never reach diagnostics',
    () async {
      final peer = Peer()..silent = true;
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        peer.bus.add(
          const NativeTransportEvent(type: 'diagnostic', stage: 'endpointDial'),
        );
        peer.bus.add(
          const NativeTransportEvent(type: 'error', code: 'secret=private'),
        );
        await settleUntil(
          () =>
              controller.state.connection == RemoteConnectionState.reconnecting,
        );
        expect(controller.state.diagnostics.summary, contains('endpointDial'));
        expect(
          controller.state.diagnostics.summary,
          contains('unknownFailure'),
        );
        expect(
          controller.state.diagnostics.summary,
          isNot(contains('private')),
        );
        expect(controller.state.notice, contains('unknownFailure'));
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );
  testWidgets('silent native connection retains a useful timeout diagnostic', (
    tester,
  ) async {
    final peer = Peer()..silent = true;
    final controller = NativeRemoteController(
      credentials: MemoryCredentials(),
      transport: peer,
    );
    await controller.initialize();
    await tester.pump(const Duration(seconds: 15));
    expect(controller.state.notice, contains('nativeConnectTimeout'));
    await tester.pump(const Duration(seconds: 2));
    expect(controller.state.notice, contains('nativeConnectTimeout'));
    controller.dispose();
    await peer.bus.close();
  });
  String pairingUri() => Uri(
    scheme: 'joi',
    host: 'pair',
    queryParameters: {
      'v': '1',
      'host': 'host',
      'device': 'device',
      'pairing': 'offer',
      'secret': credential.secret,
      'ticket': base64Url.encode(utf8.encode(jsonEncode(credential.ticket))),
    },
  ).toString();

  test(
    'first network failure retries pairing before attempting resume',
    () async {
      final peer = Peer()
        ..enforcePairing = true
        ..failFirstConnect = true;
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.connectFromQr(pairingUri());
        await Future<void>.delayed(const Duration(milliseconds: 2200));
        await settleUntil(() => peer.hellos.isNotEmpty);
        expect(peer.hellos.first['mode'], 'pair');
        await settleUntil(
          () => controller.state.connection == RemoteConnectionState.connected,
        );
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );

  test(
    'lost pair receipt resumes without reusing the pairing context',
    () async {
      final peer = Peer()
        ..enforcePairing = true
        ..losePairReady = true;
      final store = MemoryCredentials();
      final controller = NativeRemoteController(
        credentials: store,
        transport: peer,
      );
      try {
        await controller.connectFromQr(pairingUri());
        await Future<void>.delayed(const Duration(milliseconds: 2200));
        await settleUntil(() => peer.hellos.length >= 2);
        expect(peer.hellos[1]['mode'], 'resume');
        expect(peer.hellos[1].containsKey('pairingId'), isFalse);
        await settleUntil(
          () => controller.state.connection == RemoteConnectionState.connected,
        );
        expect(store.written, isNotNull);
        expect(jsonDecode(store.written!).containsKey('pairingId'), isFalse);
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );
  test(
    'lost pair hello falls back to pairing after resume is rejected',
    () async {
      final peer = Peer()
        ..enforcePairing = true
        ..losePairHello = true;
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.connectFromQr(pairingUri());
        await Future<void>.delayed(const Duration(milliseconds: 4400));
        await settleUntil(
          () => controller.state.connection == RemoteConnectionState.connected,
        );
        expect(peer.hellos.map((h) => h['mode']), ['pair', 'resume', 'pair']);
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );

  testWidgets(
    'unreachable first pairing returns to scanner after two minutes',
    (tester) async {
      final peer = Peer()..silent = true;
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      await controller.connectFromQr(pairingUri());
      await tester.pump(const Duration(minutes: 2));
      expect(controller.state.connection, RemoteConnectionState.unpaired);
      expect(controller.state.notice, isNotNull);
      controller.dispose();
      await peer.bus.close();
    },
  );
  test(
    'encrypted retries keep the original key; successful send is independent of refresh',
    () async {
      final peer = Peer();
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        await settleUntil(() => controller.state.workbenches.isNotEmpty);
        peer.failSend = true;
        await expectLater(
          controller.sendMessage('hello', workbenchId: 'b'),
          throwsStateError,
        );
        peer.failFeed = true;
        await controller.sendMessage('hello', workbenchId: 'b');
        await settleUntil(() => controller.state.notice != null);
        final sends = peer.commands
            .where((c) => c['kind'] == 'message.send')
            .toList();
        expect(sends, hasLength(2));
        expect(sends[0]['idempotencyKey'], sends[1]['idempotencyKey']);
        expect(sends[1]['workbenchId'], 'b');
        expect(controller.state.sending, isFalse);
        expect(controller.state.connection, RemoteConnectionState.connected);
        await controller.sendMessage('new message');
        expect(
          peer.commands.lastWhere(
            (c) => c['kind'] == 'message.send',
          )['idempotencyKey'],
          isNot(sends[0]['idempotencyKey']),
        );
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );

  test(
    'reads complete paged text and serializes concurrent encrypted requests',
    () async {
      final peer = Peer();
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        await settleUntil(() => controller.state.supportsHome);
        final results = await Future.wait([
          controller.read('goal.get', goalId: 'g'),
          controller.read('catalog.get'),
        ]);
        expect(results.first['text'], '中文😀' * 10000);
        expect(
          peer.sequences,
          List.generate(peer.sequences.length, (index) => index + 1),
        );
        controller.setForeground(false);
        final count = peer.commands.length;
        await controller.refresh();
        expect(peer.commands.length, count);
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );

  test(
    'older hosts retain feed and plain sending without unsupported commands',
    () async {
      final peer = Peer()..modern = false;
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        await settleUntil(
          () => controller.state.connection == RemoteConnectionState.connected,
        );
        await controller.sendMessage('hello');
        expect(controller.state.supportsHome, isFalse);
        expect(peer.commands.any((c) => c['kind'] == 'catalog.get'), isFalse);
        await expectLater(
          controller.sendMessage('hello', workbenchId: 'b'),
          throwsStateError,
        );
        await expectLater(
          controller.read('goal.get', goalId: 'g'),
          throwsStateError,
        );
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );
}
