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
  @override
  Future<String?> read() async => credential.toStoredJson();
  @override
  Future<void> write(String value) async {}
}

class Peer implements NativeTransport {
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
    bus.add(const NativeTransportEvent(type: 'connected', path: 'direct'));
  }

  @override
  Future<void> send(Object value) async {
    final frame = Map<String, dynamic>.from(value as Map);
    if (frame['kind'] == 'handshake.hello') {
      final nonce = base64Url.encode(List.filled(24, 4)).replaceAll('=', '');
      final proofBody =
          'joi-remote-v1\nresume\nhost\ndevice\n\n${frame['clientNonce']}\n$nonce\nready';
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
