import 'package:flutter/material.dart';

import 'remote_controller.dart';
import 'pairing_scanner.dart';

class JoiMobileApp extends StatelessWidget {
  const JoiMobileApp({super.key, required this.controller});

  final RemoteController controller;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'joi',
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          brightness: Brightness.dark,
          seedColor: const Color(0xff79c99e),
          surface: const Color(0xff111a15),
        ),
        scaffoldBackgroundColor: const Color(0xff0d1511),
        useMaterial3: true,
      ),
      home: AnimatedBuilder(
        animation: controller,
        builder: (context, _) {
          final state = controller.state;
          if (state.connection == RemoteConnectionState.unpaired) {
            return _PairingScreen(controller: controller);
          }
          return _HomeScreen(controller: controller, state: state);
        },
      ),
    );
  }
}

class _PairingScreen extends StatelessWidget {
  const _PairingScreen({required this.controller});

  final RemoteController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              const Text(
                'joi',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Color(0xffb8e3c7),
                  fontSize: 42,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -2,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                '把正在电脑上运行的 Joi 带到手机上',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: const Color(0xff94a79b),
                ),
              ),
              const SizedBox(height: 34),
              FilledButton.icon(
                onPressed: () => _scan(context),
                icon: const Icon(Icons.qr_code_scanner_rounded),
                label: const Text('扫描二维码绑定 Joi'),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 17),
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: () => _showManualPairing(context),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 15),
                ),
                child: const Text('输入连接码'),
              ),
              const Spacer(),
              const Text(
                '同一台 Joi 可以安全绑定多台手机',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xff728278), fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showManualPairing(BuildContext context) async {
    final input = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('输入连接码'),
        content: TextField(
          controller: input,
          autofocus: true,
          decoration: const InputDecoration(hintText: '粘贴 joi://pair 链接'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, input.text),
            child: const Text('连接'),
          ),
        ],
      ),
    );
    input.dispose();
    if (value != null && context.mounted) await _connect(context, value);
  }

  Future<void> _scan(BuildContext context) async {
    final value = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const PairingScannerPage()),
    );
    if (value != null && context.mounted) await _connect(context, value);
  }

  Future<void> _connect(BuildContext context, String value) async {
    try {
      await controller.connectFromQr(value);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('二维码无效或已经过期。')));
      }
    }
  }
}

class _HomeScreen extends StatefulWidget {
  const _HomeScreen({required this.controller, required this.state});

  final RemoteController controller;
  final RemoteViewState state;

  @override
  State<_HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<_HomeScreen> {
  final _composer = TextEditingController();

  @override
  void dispose() {
    _composer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
              child: Row(
                children: [
                  const Text(
                    'joi',
                    style: TextStyle(
                      color: Color(0xffb8e3c7),
                      fontSize: 26,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const Spacer(),
                  _ConnectionBadge(state: widget.state),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0x1fffffff)),
            Expanded(
              child: RefreshIndicator(
                onRefresh: widget.controller.refresh,
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Text(
                      '正在进行',
                      style: TextStyle(color: Color(0xff94a79b), fontSize: 12),
                    ),
                    const SizedBox(height: 10),
                    if (widget.state.goals.isEmpty)
                      const _EmptyCard()
                    else
                      for (final goal in widget.state.goals) ...[
                        _GoalCard(goal: goal),
                        const SizedBox(height: 12),
                      ],
                  ],
                ),
              ),
            ),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
              decoration: const BoxDecoration(
                color: Color(0xee0d1511),
                border: Border(top: BorderSide(color: Color(0x1fffffff))),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _composer,
                      minLines: 1,
                      maxLines: 5,
                      decoration: const InputDecoration(
                        hintText: '和 Joi 说点什么…',
                        filled: true,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.all(Radius.circular(18)),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  IconButton.filled(
                    onPressed: widget.state.sending ? null : _send,
                    icon: const Icon(Icons.arrow_upward_rounded),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty) return;
    await widget.controller.sendMessage(text);
    if (mounted) _composer.clear();
  }
}

class _ConnectionBadge extends StatelessWidget {
  const _ConnectionBadge({required this.state});

  final RemoteViewState state;

  @override
  Widget build(BuildContext context) {
    final label = switch (state.connection) {
      RemoteConnectionState.connected => switch (state.path) {
        RemoteConnectionPath.direct => '直连',
        RemoteConnectionPath.relay => '中继',
        RemoteConnectionPath.mixed => '智能链路',
        RemoteConnectionPath.none => '已连接',
      },
      RemoteConnectionState.connecting => '连接中',
      RemoteConnectionState.reconnecting => '重连中',
      _ => '离线',
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xff1b2820),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0x3379c99e)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.lock_rounded, size: 13, color: Color(0xff79c99e)),
            const SizedBox(width: 5),
            Text(
              label,
              style: const TextStyle(fontSize: 12, color: Color(0xffb8e3c7)),
            ),
          ],
        ),
      ),
    );
  }
}

class _GoalCard extends StatelessWidget {
  const _GoalCard({required this.goal});

  final RemoteGoalCard goal;

  @override
  Widget build(BuildContext context) {
    final progress = goal.totalWork == 0
        ? 0.0
        : goal.completedWork / goal.totalWork;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: const Color(0xff1b2820),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0x1fffffff)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            goal.status,
            style: const TextStyle(
              color: Color(0xff79c99e),
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            goal.title,
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 16),
          LinearProgressIndicator(
            value: progress,
            minHeight: 5,
            borderRadius: BorderRadius.circular(5),
          ),
          const SizedBox(height: 9),
          Text(
            '${goal.completedWork}/${goal.totalWork} 已完成 · ${goal.activeWork} 正在执行',
            style: const TextStyle(color: Color(0xff94a79b), fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _EmptyCard extends StatelessWidget {
  const _EmptyCard();

  @override
  Widget build(BuildContext context) {
    return const Card(
      child: Padding(
        padding: EdgeInsets.all(22),
        child: Text('暂时没有进行中的任务', style: TextStyle(color: Color(0xff94a79b))),
      ),
    );
  }
}
