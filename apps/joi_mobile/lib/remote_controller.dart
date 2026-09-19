import 'package:flutter/foundation.dart';
import 'connection_diagnostics.dart';

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
    this.goalId = '',
    this.workbenchId = '',
    this.workbenchName = '等待归属',
    this.canDelete = false,
    this.summary,
    this.prompt,
    this.reasonCode,
    this.agentCount = 0,
    this.failedWork = 0,
    this.stage,
  });

  final int activeWork;
  final int completedWork;
  final String status;
  final String title;
  final int totalWork;
  final String goalId;
  final String workbenchId;
  final String workbenchName;
  final bool canDelete;
  final String? summary;
  final String? prompt;
  final String? reasonCode;
  final String? stage;
  final int agentCount;
  final int failedWork;
  bool get terminal => const [
    'COMPLETED',
    'COMPLETED_WITH_GAPS',
    'FAILED',
    'CANCELED',
  ].contains(status);
  bool get canCancel => !terminal;

  factory RemoteGoalCard.fromJson(Map<String, dynamic> json, {String? stage}) {
    final work = json['work'] as Map<String, dynamic>? ?? {};
    final bench = json['workbench'] as Map<String, dynamic>? ?? {};
    final question = json['clarification'] as Map<String, dynamic>? ?? {};
    return RemoteGoalCard(
      goalId: json['goalId'] as String? ?? json['inputId'] as String? ?? '',
      title:
          json['title'] as String? ??
          json['textPreview'] as String? ??
          '待确认的输入',
      status: json['status'] == 'CLARIFICATION_REQUIRED'
          ? 'NEEDS_ATTENTION'
          : json['status'] as String? ?? 'ARRANGING',
      workbenchId:
          bench['workbenchId'] as String? ??
          json['workbenchId'] as String? ??
          '',
      workbenchName: bench['name'] as String? ?? '等待归属',
      activeWork: work['active'] as int? ?? 0,
      completedWork: work['completed'] as int? ?? 0,
      totalWork: work['total'] as int? ?? 0,
      failedWork: work['failed'] as int? ?? 0,
      agentCount: json['agentCount'] as int? ?? 0,
      canDelete: json['canDelete'] == true,
      summary: json['completionSummary'] as String?,
      prompt:
          question['prompt'] as String? ??
          json['clarificationPrompt'] as String?,
      reasonCode:
          question['reasonCode'] as String? ??
          json['clarificationReasonCode'] as String?,
      stage: stage,
    );
  }
}

class RemoteChoice {
  const RemoteChoice(this.id, this.name, [this.description = '']);
  final String id;
  final String name;
  final String description;
}

class RemoteViewState {
  const RemoteViewState({
    this.connection = RemoteConnectionState.unpaired,
    this.goals = const [],
    this.path = RemoteConnectionPath.none,
    this.sending = false,
    this.supportsHome = false,
    this.workbenches = const [],
    this.partners = const [],
    this.busyGoals = const {},
    this.notice,
    this.diagnostics = const ConnectionDiagnostics(),
  });

  final RemoteConnectionState connection;
  final List<RemoteGoalCard> goals;
  final RemoteConnectionPath path;
  final bool sending;
  final bool supportsHome;
  final List<RemoteChoice> workbenches;
  final List<RemoteChoice> partners;
  final Set<String> busyGoals;
  final String? notice;
  final ConnectionDiagnostics diagnostics;
  RemoteViewState copyWith({
    RemoteConnectionState? connection,
    List<RemoteGoalCard>? goals,
    RemoteConnectionPath? path,
    bool? sending,
    bool? supportsHome,
    List<RemoteChoice>? workbenches,
    List<RemoteChoice>? partners,
    Set<String>? busyGoals,
    String? notice,
    bool clearNotice = false,
    ConnectionDiagnostics? diagnostics,
  }) => RemoteViewState(
    connection: connection ?? this.connection,
    goals: goals ?? this.goals,
    path: path ?? this.path,
    sending: sending ?? this.sending,
    supportsHome: supportsHome ?? this.supportsHome,
    workbenches: workbenches ?? this.workbenches,
    partners: partners ?? this.partners,
    busyGoals: busyGoals ?? this.busyGoals,
    notice: clearNotice ? null : notice ?? this.notice,
    diagnostics: diagnostics ?? this.diagnostics,
  );
}

abstract interface class RemoteController implements Listenable {
  RemoteViewState get state;

  Future<void> connectFromQr(String payload);

  Future<void> refresh();

  Future<void> sendMessage(String text, {String? workbenchId});
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  });
  Future<void> act(
    String inputId,
    String action, {
    String? text,
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
  });
  void setForeground(bool value);
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
  Future<void> sendMessage(String text, {String? workbenchId}) async {}
  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? agentId,
    String? cursor,
  }) async => {};
  @override
  Future<void> act(
    String inputId,
    String action, {
    String? text,
    String? workbenchId,
    String? partnerId,
    String? actionChoice,
  }) async {}
  @override
  void setForeground(bool value) {}
}
