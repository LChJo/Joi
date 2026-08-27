import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/native_remote_controller.dart';

void main() {
  test('parses a Joi native pairing URI without using a web origin', () {
    final ticket = base64Url
        .encode(
          utf8.encode(
            jsonEncode({
              'directAddresses': ['192.0.2.10:49152'],
              'endpointId': 'endpoint-1',
              'relayUrls': ['https://cudex.joilab.top/'],
              'version': 1,
            }),
          ),
        )
        .replaceAll('=', '');
    final credential = PairingCredential.parse(
      'joi://pair?v=1&host=host-1&device=device-1&pairing=pair-1&secret=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc&ticket=$ticket',
    );

    expect(credential.hostId, 'host-1');
    expect(credential.deviceId, 'device-1');
    expect(credential.pairingId, 'pair-1');
    expect(credential.ticket['endpointId'], 'endpoint-1');
    expect(credential.ticket['relayUrls'], ['https://cudex.joilab.top/']);
  });

  test(
    'creates a handshake proof interoperable with the Joi desktop',
    () async {
      const credential = PairingCredential(
        deviceId: 'device-1',
        hostId: 'host-1',
        pairingId: 'pair-1',
        secret: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
        ticket: {
          'directAddresses': <String>[],
          'endpointId': 'endpoint-1',
          'relayUrls': <String>[],
          'version': 1,
        },
      );
      final proof = await RemoteSessionCrypto.handshakeProof(
        credential,
        'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD',
        mode: 'pair',
      );
      expect(proof, 'Fi2XYP7EAO6HgWTQ3FlVuqSvhU846X-afFNvP9m3fQg');
    },
  );
}
