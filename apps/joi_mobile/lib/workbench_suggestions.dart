/// Hand-pick candidates for a workbench clarification.
///
/// Mirror of `src/shared/workbench-suggestions.ts`, which the desktop and the runtime use. The
/// phone cannot import TypeScript, so the two are kept in step by the same test cases on both
/// sides. The rule that matters most is negative: a candidate must never restate the input. A
/// candidate named after the request reads as a workbench but behaves as a one-off folder — it
/// cannot be reused, and the next similar request mints another one beside it.
library;

class WorkbenchMatchSource {
  const WorkbenchMatchSource({
    required this.name,
    required this.scopeSummary,
    required this.workbenchId,
  });

  final String name;
  final String scopeSummary;
  final String workbenchId;
}

class WorkbenchSuggestion {
  const WorkbenchSuggestion({
    required this.description,
    required this.kind,
    required this.name,
    required this.personaSummary,
    required this.projectLabel,
    required this.scopeSummary,
    this.workbenchId,
  });

  final String description;

  /// `existing` reuses the workbench; `template` asks joi to create the described cluster.
  final String kind;
  final String name;
  final String personaSummary;
  final String projectLabel;
  final String scopeSummary;

  /// Set for `existing` only — reuse this workbench instead of creating a new one.
  final String? workbenchId;

  bool get reusesExisting => workbenchId != null;
}

const int workbenchSuggestionLimit = 3;

/// Kept numerically identical to the TypeScript constants; see that file for the calibration.
const double workbenchMatchConfidentScore = 0.10;
const double workbenchMatchCandidateScore = 0.08;
const double workbenchMatchAmbiguousMargin = 0.03;
const int workbenchEchoSpan = 12;
const int workbenchEchoStem = 6;
const int _minSharedTerms = 2;
const int _echoScanLimit = 4000;

final RegExp _cjkChar = RegExp(
  r'[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]',
  unicode: true,
);
final RegExp _latinRun = RegExp(r'[a-z0-9]+');
final RegExp _noise = RegExp(r'[\s\p{P}\p{S}]', unicode: true);

/// Comparison form: case-folded and stripped of punctuation and whitespace.
///
/// The TypeScript side additionally applies NFKC; Dart has no built-in normalizer, so full-width
/// forms compare as written here. That only loosens a suggestion list, never a stored decision.
String compactWorkbenchText(String text) =>
    text.toLowerCase().replaceAll(_noise, '');

/// Overlapping bigrams plus latin/digit words, kept only when one side is CJK.
Set<String> workbenchMatchTerms(String text) {
  final terms = <String>{};
  for (final run in _latinRun.allMatches(text.toLowerCase())) {
    final word = run.group(0)!;
    if (word.length >= 2) terms.add(word);
  }
  final compacted = compactWorkbenchText(text);
  final runes = compacted.runes.toList();
  for (var index = 0; index + 2 <= runes.length; index += 1) {
    final window = String.fromCharCodes(runes.sublist(index, index + 2));
    if (_cjkChar.hasMatch(window)) terms.add(window);
  }
  return terms;
}

int _sharedTerms(Set<String> left, Set<String> right) {
  if (left.isEmpty || right.isEmpty) return 0;
  var shared = 0;
  for (final term in left) {
    if (right.contains(term)) shared += 1;
  }
  return shared >= _minSharedTerms ? shared : 0;
}

/// How much of a workbench the input covers, from 0 to 1. Coverage, not Jaccard, so a verbose
/// scope blurb is not scored worse than a terse one.
double workbenchMatchScore(String input, WorkbenchMatchSource workbench) {
  final inputTerms = workbenchMatchTerms(input);
  if (inputTerms.isEmpty) return 0;
  double coverage(String field) {
    final fieldTerms = workbenchMatchTerms(field);
    if (fieldTerms.isEmpty) return 0;
    final smaller = inputTerms.length < fieldTerms.length
        ? inputTerms.length
        : fieldTerms.length;
    return _sharedTerms(inputTerms, fieldTerms) / smaller;
  }

  return (coverage(workbench.name) * 2 + coverage(workbench.scopeSummary)) / 3;
}

/// Best first. Ties break on workbenchId so the ranking is stable.
List<WorkbenchMatchSource> rankWorkbenchMatches(
  String input,
  List<WorkbenchMatchSource> workbenches,
) {
  final scored = workbenches.toList()
    ..sort((left, right) {
      final byScore = workbenchMatchScore(
        input,
        right,
      ).compareTo(workbenchMatchScore(input, left));
      return byScore != 0
          ? byScore
          : left.workbenchId.compareTo(right.workbenchId);
    });
  return scored;
}

/// Does [candidate] carry a verbatim run of [input]?
///
/// Such a name describes this one request rather than a durable work cluster, so every similar
/// request would mint another workbench.
String? echoedWorkbenchSpan(
  String candidate,
  String input, {
  int span = workbenchEchoSpan,
}) {
  final compactCandidate = compactWorkbenchText(candidate);
  final compactInput = compactWorkbenchText(input);
  final scanned = compactInput.length > _echoScanLimit
      ? compactInput.substring(0, _echoScanLimit)
      : compactInput;
  if (compactCandidate.isEmpty || scanned.isEmpty) return null;
  if (compactCandidate.length >= workbenchEchoStem &&
      scanned.contains(compactCandidate)) {
    return compactCandidate;
  }
  if (compactCandidate.length < span || scanned.length < span) return null;
  final runes = scanned.runes.toList();
  for (var index = 0; index + span <= runes.length; index += 1) {
    final window = String.fromCharCodes(runes.sublist(index, index + span));
    if (compactCandidate.contains(window)) return window;
  }
  return null;
}

class _WorkbenchTemplate {
  const _WorkbenchTemplate({
    required this.name,
    required this.personaSummary,
    required this.projectLabel,
    required this.scopeSummary,
  });

  final String name;
  final String personaSummary;
  final String projectLabel;
  final String scopeSummary;
}

/// Abstract work clusters offered when nothing existing fits. Constant on purpose: a template
/// cannot restate the input, and a cluster that suits one trip also suits the next.
const List<_WorkbenchTemplate> _templates = [
  _WorkbenchTemplate(
    name: '调研与分析工坊',
    personaSummary: '先建立可验证的事实，再做推断；结论必须能追溯到来源，猜测不当结论。',
    projectLabel: '调研与分析',
    scopeSummary: '跨来源的资料收集、事实核对、对比分析与结论沉淀。',
  ),
  _WorkbenchTemplate(
    name: '工程开发与调试工坊',
    personaSummary: '围绕代码、构建与运行证据推进，改动要可复现、可验证。',
    projectLabel: '工程开发与调试',
    scopeSummary: '代码阅读与修改、构建与运行、故障排查与回归验证。',
  ),
  _WorkbenchTemplate(
    name: '行程与出行规划工坊',
    personaSummary: '先确认时间、地点与约束，再比较方案；不把未经核实的信息当既定事实。',
    projectLabel: '行程与出行规划',
    scopeSummary: '目的地资料整理、路线与时间安排、票务与口碑信息的比较。',
  ),
  _WorkbenchTemplate(
    name: '内容整理与写作工坊',
    personaSummary: '把散乱材料整理成结构清晰、可直接使用的成稿，保留出处。',
    projectLabel: '内容整理与写作',
    scopeSummary: '素材汇总、提纲设计、长文撰写与排版定稿。',
  ),
];

/// Prepares one automatic suggestion; creation still requires an explicit user choice.
List<WorkbenchSuggestion> workbenchCreationSuggestions({
  required String seed,
  String? proposalName,
  String? proposalProjectLabel,
  String? proposalScopeSummary,
}) {
  if (proposalName != null &&
      proposalProjectLabel != null &&
      proposalScopeSummary != null) {
    return [
      WorkbenchSuggestion(
        description: '',
        kind: 'template',
        name: proposalName,
        projectLabel: proposalProjectLabel,
        scopeSummary: proposalScopeSummary,
        personaSummary: '围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。',
      ),
    ];
  }
  double score(_WorkbenchTemplate template) => workbenchMatchScore(
    seed,
    WorkbenchMatchSource(
      name: template.name,
      scopeSummary: template.scopeSummary,
      workbenchId: 'template',
    ),
  );
  final best = _templates.reduce(
    (best, candidate) => score(candidate) > score(best) ? candidate : best,
  );
  return [
    WorkbenchSuggestion(
      description: '',
      kind: 'template',
      name: best.name,
      personaSummary: best.personaSummary,
      projectLabel: best.projectLabel,
      scopeSummary: best.scopeSummary,
    ),
  ];
}

/// Candidates for the hand-pick list: existing workbenches that already carry this kind of work
/// first — reuse is almost always what the user wants — then abstract clusters to fill the list.
List<WorkbenchSuggestion> workbenchSuggestions({
  required String seed,
  required List<WorkbenchMatchSource> workbenches,
  int limit = workbenchSuggestionLimit,
}) {
  final suggestions = <WorkbenchSuggestion>[];
  for (final workbench in rankWorkbenchMatches(seed, workbenches)) {
    if (suggestions.length >= limit - 1) break;
    if (workbenchMatchScore(seed, workbench) < workbenchMatchCandidateScore) {
      break;
    }
    if (echoedWorkbenchSpan(workbench.name, seed) != null) continue;
    suggestions.add(
      WorkbenchSuggestion(
        description: '复用这个已有工作台，这条输入会接着它的上下文走。',
        kind: 'existing',
        name: workbench.name,
        personaSummary: '沿用「${workbench.name}」已有的职责与范围。',
        projectLabel: workbench.name,
        scopeSummary: workbench.scopeSummary,
        workbenchId: workbench.workbenchId,
      ),
    );
  }
  for (final template in _templates) {
    if (suggestions.length >= limit) break;
    suggestions.add(
      WorkbenchSuggestion(
        description: '新建「${template.name}」，同类工作以后都会归到这里。',
        kind: 'template',
        name: template.name,
        personaSummary: template.personaSummary,
        projectLabel: template.projectLabel,
        scopeSummary: template.scopeSummary,
      ),
    );
  }
  return suggestions;
}
