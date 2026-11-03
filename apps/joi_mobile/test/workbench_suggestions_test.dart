import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/workbench_suggestions.dart';

/// Same cases as tests/unit/workbench-suggestions.test.ts — the two implementations have to agree.
const _travelInput =
    '民宿周边有皖南川藏线，落羽红杉林，青龙湾度假区，山门洞，储家滩，西津野渡，双河漂流，皖南飞瀑漂流，'
    '储家滩全地形越野车，惠云禅寺，青龙湾水上乐园，卡丁船。河沥溪古镇。根据以上信息，只分析最近一周'
    '（2026 中秋国庆假期信息）小红书和点评携程等信息，分析哪些是最值得去的景点，备注是否需要购票';

const _stock = WorkbenchMatchSource(
  workbenchId: 'w1',
  name: 'A股技术面与走势分析环境',
  scopeSummary: '基于可验证的历史行情与当前市场指标，分析A股沪指的技术走势、周期信号和风险情景。',
);
const _travel = WorkbenchMatchSource(
  workbenchId: 'w2',
  name: '西双版纳深度游行程规划环境',
  scopeSummary: '旅行行程规划助手：基于网络搜索与口碑评价，为用户定制节奏从容、以深度体验为主的目的地行程，并围绕固定住宿点安排。',
);
const _news = WorkbenchMatchSource(
  workbenchId: 'w3',
  name: '中文AI技术资讯与开源生态调研环境',
  scopeSummary: '负责中文AI资讯网站、GitHub及相关技术站点的趋势调研、来源交叉验证与技术价值分析。',
);
const _lark = WorkbenchMatchSource(
  workbenchId: 'w4',
  name: '飞书项目待办分析环境',
  scopeSummary: '熟悉飞书项目（Lark Project）数据结构与任务管理流程的分析助理，擅长梳理待办事项、识别变更、评估优先级',
);

void main() {
  test(
    'prepares one automatic suggestion from the persisted proposal or best reusable scope',
    () {
      final options = workbenchCreationSuggestions(
        seed: '维护工程文档',
        proposalName: 'joi 工程工坊',
        proposalProjectLabel: 'joi',
        proposalScopeSummary: '工程开发与源码调试。',
      );
      expect(options.map((option) => option.name), ['joi 工程工坊']);
      expect(
        options.every(
          (option) =>
              !option.reusesExisting && option.personaSummary.isNotEmpty,
        ),
        isTrue,
      );
      expect(
        workbenchCreationSuggestions(
          seed: '',
          proposalName: '工程开发与调试工坊',
          proposalProjectLabel: 'joi',
          proposalScopeSummary: '工程开发与源码调试。',
        ).map((option) => option.name),
        ['工程开发与调试工坊'],
      );
      expect(
        workbenchCreationSuggestions(seed: '行程与出行规划，路线与时间安排').first.name,
        '行程与出行规划工坊',
      );
      expect(workbenchCreationSuggestions(seed: ''), hasLength(1));
    },
  );
  group('workbench text comparison', () {
    test('folds punctuation and case so the same phrase compares equal', () {
      expect(
        compactWorkbenchText('宁国·皖南川藏线'),
        compactWorkbenchText('宁国 皖南川藏线'),
      );
      expect(compactWorkbenchText('A股 SDK'), compactWorkbenchText('a股 sdk'));
    });

    test('keeps a mixed-script run as one term', () {
      expect(workbenchMatchTerms('A股分析'), contains('a股'));
    });

    test('overlaps reordered Chinese without a segmenter', () {
      expect(workbenchMatchTerms('行程规划'), contains('行程'));
      expect(workbenchMatchTerms('行程规划'), contains('规划'));
    });
  });

  group('workbenchMatchScore', () {
    test('scores a same-project reword far above an unrelated workbench', () {
      const input = '根据近期A股市场数据，分析整体趋势和重要板块的趋势，给出明确的投资建议';
      expect(
        workbenchMatchScore(input, _stock),
        greaterThan(workbenchMatchScore(input, _travel) * 2),
      );
    });

    test('scores zero when the input shares nothing with the workbench', () {
      expect(workbenchMatchScore('帮我写一首关于秋天的诗', _stock), 0);
    });

    test('does not match on a single shared term', () {
      expect(workbenchMatchScore('帮我研究一下这个名字该怎么起', _stock), 0);
    });

    test('ranks best first', () {
      final ranked = rankWorkbenchMatches('本周中文 AI 技术资讯和开源项目趋势', [
        _stock,
        _travel,
        _news,
        _lark,
      ]);
      expect(ranked.first.workbenchId, 'w3');
    });

    test('takes a clear winner above the confidence bar', () {
      const input = '根据近期A股市场数据，分析整体趋势和重要板块的趋势';
      expect(
        workbenchMatchScore(input, _stock),
        greaterThanOrEqualTo(workbenchMatchConfidentScore),
      );
    });

    test('leaves an input that belongs nowhere below the confidence bar', () {
      expect(
        rankWorkbenchMatches('帮我写一首关于秋天的诗', [_stock, _travel, _news]).first,
        isNotNull,
      );
      expect(
        workbenchMatchScore('帮我写一首关于秋天的诗', _stock),
        lessThan(workbenchMatchConfidentScore),
      );
    });
  });

  group('echoedWorkbenchSpan', () {
    test('catches the truncate-and-append name that was actually created', () {
      expect(
        echoedWorkbenchSpan('民宿周边有皖南川藏线，落羽红杉林，青… 工作台', _travelInput),
        isNotNull,
      );
    });

    test('catches a name built from a shorter verbatim slice of the input', () {
      expect(
        echoedWorkbenchSpan('民宿周边有皖南川藏线，落羽红杉林 工坊', _travelInput),
        isNotNull,
      );
    });

    test('accepts a name that abstracts the same work into a cluster', () {
      expect(echoedWorkbenchSpan('皖南川藏线民宿周边景点调研工坊', _travelInput), isNull);
      expect(echoedWorkbenchSpan('旅行行程规划工坊', _travelInput), isNull);
      expect(echoedWorkbenchSpan('周边民宿与景点分析工作台', _travelInput), isNull);
    });

    test('does not fire on short or empty candidates', () {
      expect(echoedWorkbenchSpan('', _travelInput), isNull);
      expect(echoedWorkbenchSpan('工坊', _travelInput), isNull);
      expect(echoedWorkbenchSpan('调研与分析工坊', ''), isNull);
    });
  });

  group('workbenchSuggestions', () {
    test('offers abstract clusters when nothing existing fits', () {
      final suggestions = workbenchSuggestions(
        seed: _travelInput,
        workbenches: const [],
      );
      expect(suggestions, hasLength(workbenchSuggestionLimit));
      expect(suggestions.every((item) => item.kind == 'template'), isTrue);
      for (final suggestion in suggestions) {
        expect(echoedWorkbenchSpan(suggestion.name, _travelInput), isNull);
        expect(
          echoedWorkbenchSpan(suggestion.scopeSummary, _travelInput),
          isNull,
        );
        expect(suggestion.name, isNot(contains('…')));
      }
    });

    test('puts an existing workbench that already carries this work first', () {
      final suggestions = workbenchSuggestions(
        seed: '西双版纳适合带小孩去吗，行程怎么安排比较好',
        workbenches: const [_stock, _travel],
      );
      expect(suggestions.first.kind, 'existing');
      expect(suggestions.first.workbenchId, 'w2');
      expect(suggestions.first.reusesExisting, isTrue);
      expect(suggestions, hasLength(workbenchSuggestionLimit));
    });

    test(
      'never offers an existing workbench whose name restates the input',
      () {
        final suggestions = workbenchSuggestions(
          seed: _travelInput,
          workbenches: const [
            WorkbenchMatchSource(
              workbenchId: 'e1',
              name: '民宿周边有皖南川藏线，落羽红杉林，青… 工作台',
              scopeSummary: '围绕这条输入的目标、资料与执行过程。',
            ),
          ],
        );
        expect(suggestions.any((item) => item.workbenchId == 'e1'), isFalse);
      },
    );

    test('honours a smaller limit', () {
      expect(
        workbenchSuggestions(seed: '随便', workbenches: const [], limit: 1),
        hasLength(1),
      );
    });
  });
}
