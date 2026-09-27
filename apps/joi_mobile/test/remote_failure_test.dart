import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/goal_detail.dart';
import 'package:joi_mobile/remote_controller.dart';

void main() {
  test('a refusal keeps the reason the host gave', () {
    // The host answers a refused command with an error envelope on the same session. Reporting
    // that as one anonymous failure is what made every cause read the same on screen; the code is
    // the only part that says which one it was.
    final failure = remoteFailureOf({
      'error': {
        'code': 'joi_clarification_unavailable',
        'message': 'This input is not awaiting clarification.',
      },
      'kind': 'response',
      'requestId': 'r',
    });
    expect(failure.code, 'joi_clarification_unavailable');
    expect(failure.detail, 'This input is not awaiting clarification.');
    // A host that refuses without naming a reason is still refusing.
    expect(
      remoteFailureOf({
        'error': <String, dynamic>{},
        'kind': 'response',
        'requestId': 'r',
      }).code,
      'remote_command_failed',
    );
  });

  test('every way an action can fail says something different', () {
    // One sentence for every cause is what made a dead button indistinguishable from a phone that
    // was never paired.
    final notices = <Object>[
      const RemoteActionFailure('joi_clarification_unavailable'),
      const RemoteActionFailure('joi_retry_unavailable'),
      const RemoteActionFailure('joi_partner_selection_invalid'),
      const RemoteActionFailure('remote_operation_forbidden'),
      const RemoteActionFailure('remote_read_busy'),
      TimeoutException('no answer'),
      StateError('remote_upgrade_required'),
      StateError('joi_remote_not_ready'),
      StateError('joi_remote_disconnected'),
    ].map(actFailureNotice).toList();
    expect(notices.toSet(), hasLength(notices.length));
    // The host's own code reaches the screen: it is the one detail a bug report can use, and the
    // only way to tell a cause this build knows about from one it does not.
    expect(
      actFailureNotice(const RemoteActionFailure('something_new')),
      contains('something_new'),
    );
  });
}
