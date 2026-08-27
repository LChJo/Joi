import 'package:flutter/foundation.dart';

enum RemoteConnectionState {
  unpaired,
  connecting,
  connected,
  reconnecting,
  offline,
}

enum RemoteConnectionPath { none, direct, relay, mixed }

class RemoteGoalCard {
  const RemoteGoalCard({
    required this.activeWork,
    required this.completedWork,
    required this.status,
    required this.title,
    required this.totalWork,
  });

  final int activeWork;
  final int completedWork;
  final String status;
  final String title;
  final int totalWork;
}

class RemoteViewState {
  const RemoteViewState({
    this.connection = RemoteConnectionState.unpaired,
    this.goals = const [],
    this.path = RemoteConnectionPath.none,
    this.sending = false,
  });

  final RemoteConnectionState connection;
  final List<RemoteGoalCard> goals;
  final RemoteConnectionPath path;
  final bool sending;
}

abstract interface class RemoteController implements Listenable {
  RemoteViewState get state;

  Future<void> connectFromQr(String payload);

  Future<void> refresh();

  Future<void> sendMessage(String text);
}

class PlaceholderRemoteController extends ChangeNotifier
    implements RemoteController {
  RemoteViewState _state = const RemoteViewState();

  @override
  RemoteViewState get state => _state;

  @override
  Future<void> connectFromQr(String payload) async {
    if (payload.trim().isEmpty) return;
    _state = const RemoteViewState(
      connection: RemoteConnectionState.connecting,
    );
    notifyListeners();
  }

  @override
  Future<void> refresh() async {}

  @override
  Future<void> sendMessage(String text) async {}
}
