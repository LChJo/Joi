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
  bool silentHandshake = false;
  final bus = StreamController<NativeTransportEvent>.broadcast();
  final commands = <Map<String, dynamic>>[];
  final sequences = <int>[];
  bool modern = true;
  bool failSend = false;
  bool failFeed = false;

  /// Set to make every command come back refused, the way the host answers an operation it will
  /// not perform: an error envelope on the same session, never a dropped connection.
  String? refuseWith;
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
      if (silentHandshake) return;
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
            if (modern)
              'capabilities': [
                'home.v2',
                'workbench.create',
                'workbench.choice.v1',
              ],
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
    if (command['kind'] == 'workbench.create') {
      result = {
        'workbenchId': 'workbench-new',
        'name': command['name'],
        'scopeSummary': command['scopeSummary'],
        'updatedAt': '2026-09-30T00:00:00.000Z',
      };
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
    final refusal =
        refuseWith ??
        (command['kind'] == 'feed.get' && failFeed ? 'failed' : null);
    final response = {
      'requestId': command['requestId'],
      'kind': 'response',
      if (refusal != null) 'error': {'code': refusal} else 'result': result,
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
    expect(
      controller.state.notice ?? '',
      isNot(contains('nativeConnectTimeout')),
    );
    await tester.pump(const Duration(seconds: 30));
    expect(controller.state.notice, contains('nativeConnectTimeout'));
    await tester.pump(const Duration(seconds: 2));
    expect(controller.state.notice, contains('nativeConnectTimeout'));
    controller.dispose();
    await peer.bus.close();
  });
  testWidgets('late native success gets a separate handshake budget', (
    tester,
  ) async {
    final peer = Peer()
      ..silent = true
      ..silentHandshake = true;
    final controller = NativeRemoteController(
      credentials: MemoryCredentials(),
      transport: peer,
    );
    await controller.initialize();
    await tester.pump(const Duration(seconds: 40));
    peer.bus.add(const NativeTransportEvent(type: 'connected', path: 'relay'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(controller.state.notice ?? '', isNot(contains('Timeout')));
    await tester.pump(const Duration(seconds: 5));
    expect(controller.state.notice, contains('handshakeTimeout'));
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
    'a refused action carries the host reason instead of looking like it worked',
    () async {
      final peer = Peer();
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        await settleUntil(() => controller.state.workbenches.isNotEmpty);
        // The host answers a refused operation with an error envelope on the same session. A client
        // that reads only `result` takes that for success: the draft clears, the form collapses,
        // and the card never moves — the same shape for every cause.
        peer.refuseWith = 'joi_clarification_unavailable';
        await expectLater(
          controller.act('goal', 'clarify', actionChoice: 'CONTINUE'),
          throwsA(
            isA<RemoteActionFailure>().having(
              (failure) => failure.code,
              'code',
              'joi_clarification_unavailable',
            ),
          ),
        );
        // A refusal is not a disconnect: the session stays up for the next attempt.
        expect(controller.state.connection, RemoteConnectionState.connected);
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
    },
  );

  test(
    'creates a workbench through the encrypted allowlisted command',
    () async {
      final peer = Peer();
      final controller = NativeRemoteController(
        credentials: MemoryCredentials(),
        transport: peer,
      );
      try {
        await controller.initialize();
        await settleUntil(() => controller.state.supportsWorkbenchCreation);
        final created = await controller.createWorkbench(
          inputId: 'goal',
          questionId: 'q1',
          questionVersion: 2,
          idempotencyKey: 'stable-creation',
          name: '移动端工作台',
          personaSummary: '保持移动端创建的上下文连续。',
          projectLabel: '移动端',
          scopeSummary: '移动端发起的工作。',
        );
        expect(created.id, 'workbench-new');
        expect(controller.state.supportsWorkbenchChoice, isTrue);
        final command = peer.commands.lastWhere(
          (command) => command['kind'] == 'workbench.create',
        );
        expect(command, containsPair('questionId', 'q1'));
        expect(command, containsPair('questionVersion', 2));
        expect(command, containsPair('idempotencyKey', 'stable-creation'));
        expect(command, containsPair('bindInputId', 'goal'));
        expect(
          controller.state.workbenches.map((item) => item.id),
          contains('workbench-new'),
        );
        expect(
          peer.commands.lastWhere(
            (command) => command['kind'] == 'workbench.create',
          ),
          containsPair('projectLabel', '移动端'),
        );
      } finally {
        controller.dispose();
        await peer.bus.close();
      }
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
