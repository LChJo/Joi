import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/home_screen.dart';
import 'package:joi_mobile/i18n.dart';

void main() {
  test('retained unverified output has an insufficient label', () {
    expect(
      executionStatusLabel(status: 'FAILED', resultAssessment: 'INSUFFICIENT'),
      tr(Msg.homeInsufficient),
    );
    expect(executionStatusLabel(status: 'FAILED'), statusLabel('FAILED'));
  });
}
