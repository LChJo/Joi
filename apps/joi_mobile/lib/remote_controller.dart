import 'package:flutter/foundation.dart';
import 'i18n.dart' show UiNotice;
import 'connection_diagnostics.dart';

enum RemoteConnectionState {
  unpaired,
  connecting,
  connected,
  reconnecting,
  offline,
}

enum RemoteConnectionPath { none, direct, relay, mixed }

/// A refusal from the host, carrying the reason code it answered with.
///
/// The host does not drop the session when it refuses an operation — it answers with an error
/// envelope, and the code in it is the only thing that says *why*. Collapsing that into a generic
/// failure is what made a refused action look like a button that does nothing: the draft cleared,
/// the form collapsed, the card unchanged. The code travels as far as the screen so the sentence
/// can differ, and so a bug report carries the one detail worth having.
class RemoteActionFailure implements Exception {
  const RemoteActionFailure(this.code, [this.detail = '']);

  /// The host's own reason code, e.g. `joi_clarification_unavailable`.
  final String code;

  /// The host's message for the refusal, when it sent one.
  final String detail;

  @override
  String toString() => 'RemoteActionFailure($code)';
}

/// The refusal a response carries, or a generic one when the host named no reason.
///
/// The host does not drop the session when it refuses an operation — it answers with an error
/// envelope, and the code inside is the only thing that says *why*. Reporting every refusal as one
/// anonymous failure is what made a dead button indistinguishable from a phone that was never
/// paired: the screen had a single sentence, so every cause got that sentence.
RemoteActionFailure remoteFailureOf(Map<String, dynamic> response) {
  final error = response['error'];
  if (error is Map<String, dynamic>) {
    return RemoteActionFailure(
      error['code'] as String? ?? 'remote_command_failed',
      error['message'] as String? ?? '',
    );
  }
  return const RemoteActionFailure('remote_command_failed');
}

class RemoteWorkbenchProposal {
  const RemoteWorkbenchProposal({
    required this.name,
    required this.projectLabel,
    required this.scopeSummary,
  });
  final String name;
  final String projectLabel;
  final String scopeSummary;
  static RemoteWorkbenchProposal? fromJson(dynamic value) {
    if (value is! Map) return null;
    final name = value['name'];
    final project = value['projectLabel'];
    final scope = value['scopeSummary'];
    if (name is! String ||
        name.trim().isEmpty ||
        name.length > 80 ||
        project is! String ||
        project.trim().isEmpty ||
        project.length > 120 ||
        scope is! String ||
        scope.trim().isEmpty ||
        scope.length > 1000) {
      return null;
    }
    return RemoteWorkbenchProposal(
      name: name,
      projectLabel: project,
      scopeSummary: scope,
    );
  }
}

class RemoteGoalCard {
  const RemoteGoalCard({
    required this.activeWork,
    required this.completedWork,
    required this.status,
    required this.title,
    required this.totalWork,
    this.goalId = '',
    this.workbenchId = '',
    this.workbenchName = '',
    this.canArchive = false,
    this.canDelete = false,
    this.archivedAt,
    this.summary,
    this.resultId,
    this.prompt,
    this.reasonCode,
    this.questionId,
    this.questionVersion,
    this.workbenchProposal,
    this.agentCount = 0,
    this.failedWork = 0,
    this.stage,
    this.executingWork,
    this.resourceWaitingWork,
    this.waitingReasons = const [],
  });

  final int activeWork;
  final int completedWork;
  final String status;
  final String title;
  final int totalWork;
  final int? executingWork;
  final int? resourceWaitingWork;
  final List<String> waitingReasons;
  final String goalId;
  final String workbenchId;
  final String workbenchName;
  final bool canDelete;

  /// Whether the host will file this card away. Removal is stricter than archiving — a failed goal
  /// that never reached a finalized outcome can be archived but not removed — so the host decides.
  final bool canArchive;

  /// Set while the card sits in the archive instead of the home feed.
  final String? archivedAt;
  bool get archived => archivedAt != null;

  /// The same card, filed away or restored.
  ///
  /// The host answers an archive request before the next 2-second feed poll can, and a card that
  /// stayed on screen that long reads as a button that did nothing.
  RemoteGoalCard withArchivedAt(String? value) => RemoteGoalCard(
    activeWork: activeWork,
    completedWork: completedWork,
    status: status,
    title: title,
    totalWork: totalWork,
    goalId: goalId,
    workbenchId: workbenchId,
    workbenchName: workbenchName,
    canArchive: canArchive,
    canDelete: canDelete,
    archivedAt: value,
    summary: summary,
    resultId: resultId,
    prompt: prompt,
    reasonCode: reasonCode,
    questionId: questionId,
    questionVersion: questionVersion,
    workbenchProposal: workbenchProposal,
    agentCount: agentCount,
    failedWork: failedWork,
    stage: stage,
    executingWork: executingWork,
    resourceWaitingWork: resourceWaitingWork,
    waitingReasons: waitingReasons,
  );
  final String? summary;
  final String? resultId;
  final String? prompt;
  final String? reasonCode;

  /// The question this card advertises. The server refuses to resolve a clarification whose
  /// question does not match, so the answer has to travel back with it.
  final String? questionId;
  final int? questionVersion;
  final RemoteWorkbenchProposal? workbenchProposal;
  bool get needsWorkbenchChoice =>
      status == 'NEEDS_ATTENTION' &&
      const [
        'workbench_selection_invalid',
        'workbench_creation_unavailable',
        'workbench_not_found',
      ].contains(reasonCode);
  final String? stage;
  final int agentCount;
  final int failedWork;
  bool get needsContinuationDecision =>
      status == 'NEEDS_ATTENTION' && reasonCode == 'goal_continuation_required';
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
      title: json['title'] as String? ?? json['textPreview'] as String? ?? '',
      status: json['status'] == 'CLARIFICATION_REQUIRED'
          ? 'NEEDS_ATTENTION'
          : json['status'] as String? ?? 'ARRANGING',
      workbenchId:
          bench['workbenchId'] as String? ??
          json['workbenchId'] as String? ??
          '',
      workbenchName: bench['name'] as String? ?? '',
      activeWork: work['active'] as int? ?? 0,
      completedWork: work['completed'] as int? ?? 0,
      totalWork: work['total'] as int? ?? 0,
      failedWork: work['failed'] as int? ?? 0,
      executingWork: work['executing'] as int?,
      resourceWaitingWork: work['resourceWaiting'] as int?,
      waitingReasons: List<String>.unmodifiable(
        (work['waitingReasons'] as List? ?? const [])
            .whereType<String>()
            .toSet(),
      ),
      agentCount: json['agentCount'] as int? ?? 0,
      canArchive: json['canArchive'] == true,
      canDelete: json['canDelete'] == true,
      archivedAt: json['archivedAt'] as String?,
      summary: json['completionSummary'] as String?,
      resultId: json['resultId'] as String?,
      prompt:
          question['prompt'] as String? ??
          json['clarificationPrompt'] as String?,
      reasonCode:
          question['reasonCode'] as String? ??
          json['clarificationReasonCode'] as String?,
      // Goal cards nest these under `clarification`; the flat unassigned-action shape puts them
      // at the top level. Reading only the nested one left the phone unable to answer a card the
      // server would then refuse, so both shapes are read here.
      questionId:
          question['questionId'] as String? ?? json['questionId'] as String?,
      questionVersion:
          question['questionVersion'] as int? ??
          json['questionVersion'] as int?,
      stage: stage,
      workbenchProposal: RemoteWorkbenchProposal.fromJson(
        json['workbenchProposal'],
      ),
    );
  }
}

class RemoteChoice {
  const RemoteChoice(this.id, this.name, [this.description = '']);
  final String id;
  final String name;
  final String description;
}

/// The outcome of creating a workbench from a clarification card.
///
/// [bound] says whether the same request also moved the input onto it. The host does both in one
/// call, so `bound: false` means the input was no longer waiting for a workbench — the workbench
/// exists, and the user is told to pick it instead of being told the card is stale.
class RemoteWorkbenchCreation {
  const RemoteWorkbenchCreation(this.id, this.name, {required this.bound});
  final String id;
  final String name;
  final bool bound;
}

class RemoteViewState {
  const RemoteViewState({
    this.connection = RemoteConnectionState.unpaired,
    this.goals = const [],
    this.archivedGoals = const [],
    this.path = RemoteConnectionPath.none,
    this.sending = false,
    this.supportsHome = false,
    this.supportsWorkbenchCreation = false,
    this.supportsWorkbenchChoice = false,
    this.supportsResultHistory = false,
    this.workbenches = const [],
    this.partners = const [],
    this.busyGoals = const {},
    this.notice,
    this.localizedNotice,
    this.diagnostics = const ConnectionDiagnostics(),
  });

  final RemoteConnectionState connection;
  final List<RemoteGoalCard> goals;

  /// Cards the host has filed away. The feed carries them in the same list, marked with
  /// `archivedAt`; they are split here so the home screen never has to think about archiving.
  final List<RemoteGoalCard> archivedGoals;
  final RemoteConnectionPath path;
  final bool sending;
  final bool supportsHome;
  final bool supportsWorkbenchCreation;
  final bool supportsWorkbenchChoice;
  final bool supportsResultHistory;
  final List<RemoteChoice> workbenches;
  final List<RemoteChoice> partners;
  final Set<String> busyGoals;
  final String? notice;
  final UiNotice? localizedNotice;
  final ConnectionDiagnostics diagnostics;
  RemoteViewState copyWith({
    RemoteConnectionState? connection,
    List<RemoteGoalCard>? goals,
    List<RemoteGoalCard>? archivedGoals,
    RemoteConnectionPath? path,
    bool? sending,
    bool? supportsHome,
    bool? supportsWorkbenchCreation,
    bool? supportsWorkbenchChoice,
    bool? supportsResultHistory,
    List<RemoteChoice>? workbenches,
    List<RemoteChoice>? partners,
    Set<String>? busyGoals,
    String? notice,
    UiNotice? localizedNotice,
    bool clearNotice = false,
    ConnectionDiagnostics? diagnostics,
  }) => RemoteViewState(
    connection: connection ?? this.connection,
    goals: goals ?? this.goals,
    archivedGoals: archivedGoals ?? this.archivedGoals,
    path: path ?? this.path,
    sending: sending ?? this.sending,
    supportsHome: supportsHome ?? this.supportsHome,
    supportsWorkbenchCreation:
        supportsWorkbenchCreation ?? this.supportsWorkbenchCreation,
    supportsWorkbenchChoice:
        supportsWorkbenchChoice ?? this.supportsWorkbenchChoice,
    supportsResultHistory: supportsResultHistory ?? this.supportsResultHistory,
    workbenches: workbenches ?? this.workbenches,
    partners: partners ?? this.partners,
    busyGoals: busyGoals ?? this.busyGoals,
    notice: clearNotice ? null : notice ?? this.notice,
    localizedNotice: clearNotice
        ? null
        : localizedNotice ?? (notice != null ? null : this.localizedNotice),
    diagnostics: diagnostics ?? this.diagnostics,
  );
}

abstract interface class RemoteController implements Listenable {
  RemoteViewState get state;

  Future<void> connectFromQr(String payload);

  Future<void> refresh();

  Future<void> sendMessage(String text, {String? workbenchId});

  /// Creates the workbench and binds [inputId] to it, in one request.
  ///
  /// One request, not two: the previous create-then-clarify pair could leave a workbench that
  /// nothing was bound to and a card that then refused every further attempt.
  Future<RemoteWorkbenchCreation> createWorkbench({
    required String inputId,
    required String name,
    required String personaSummary,
    required String projectLabel,
    required String scopeSummary,
    String? questionId,
    int? questionVersion,
    String? idempotencyKey,
  });
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
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
    String? questionId,
    int? questionVersion,
  });
  void setForeground(bool value);
}

abstract interface class ConversationRemoteController implements Listenable {
  bool get supportsConversations;
  Future<Map<String, dynamic>> conversation(
    String operation, {
    Map<String, Object?> parameters = const {},
  });
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
  Future<RemoteWorkbenchCreation> createWorkbench({
    required String inputId,
    required String name,
    required String personaSummary,
    required String projectLabel,
    required String scopeSummary,
    String? questionId,
    int? questionVersion,
    String? idempotencyKey,
  }) async => RemoteWorkbenchCreation('', name, bound: false);
  @override
  Future<Map<String, dynamic>> read(
    String kind, {
    String? goalId,
    String? resultId,
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
    String? questionId,
    int? questionVersion,
  }) async {}
  @override
  void setForeground(bool value) {}
}
