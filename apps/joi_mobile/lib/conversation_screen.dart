import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'goal_detail.dart' show MessageBody;
import 'i18n.dart';
import 'remote_controller.dart';

typedef _Json = Map<String, dynamic>;

List<_Json> _items(Object? value) => value is List
    ? value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList()
    : [];
String _text(Object? value) => value is String ? value : '';
String _turnStatus(Object? value) => tr(switch (value) {
  'QUEUED' => Msg.chatQueued,
  'RUNNING' => Msg.chatRunning,
  'COMPLETED' => Msg.chatCompleted,
  'STOPPED' => Msg.chatStopped,
  'INTERRUPTED' => Msg.chatInterrupted,
  _ => Msg.chatFailed,
});
String _identity() =>
    'chat-${List.generate(16, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({super.key, required this.controller});
  final ConversationRemoteController controller;
  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen>
    with WidgetsBindingObserver {
  final _draft = TextEditingController();
  final _search = TextEditingController();
  final _scroll = ScrollController();
  final _scaffold = GlobalKey<ScaffoldState>();
  List<_Json> _workbenches = [],
      _networks = [],
      _partners = [],
      _history = [],
      _skills = [];
  _Json? _chat;
  String _id = _identity(),
      _workbench = '',
      _network = '',
      _partner = 'joi-chat';
  Set<String> _selectedSkills = {}, _extensions = {};
  bool _subagents = true,
      _loading = true,
      _sending = false,
      _archived = false,
      _reading = false;
  bool _foreground = true, _historyLoading = false, _selecting = false;
  int _epoch = 0, _failures = 0;
  String? _notice;
  Map<String, Object?>? _pending;
  Timer? _timer;

  List<_Json> get _turns => _items(_chat?['turns']);
  bool get _busy =>
      _turns.any((turn) => ['QUEUED', 'RUNNING'].contains(turn['status']));
  String get _engine => _text(
    _partners.where((p) => p['partnerId'] == _partner).firstOrNull?['engine'],
  );
  bool get _native => _engine.isNotEmpty && _engine != 'pi-core';
  bool get _readOnly => _chat?['archivedAt'] != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void dispose() {
    _epoch++;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _draft.dispose();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _timer?.cancel();
    if (_foreground) _schedule();
  }

  Future<_Json> _request(
    String operation, [
    Map<String, Object?> parameters = const {},
  ]) => widget.controller.conversation(operation, parameters: parameters);

  Future<void> _load() async {
    try {
      final catalog = await _request('catalog');
      final history = await _request('list', {'archived': _archived});
      if (!mounted) return;
      setState(() {
        _workbenches = _items(catalog['workbenches']);
        _networks = _items(catalog['networks']);
        _partners = _items(catalog['partners']);
        if (_workbench.isEmpty) {
          _workbench = _text(_workbenches.firstOrNull?['workbenchId']);
        }
        if (_network.isEmpty) {
          _network = _text(
            _networks
                .where((n) => n['status'] == 'READY')
                .firstOrNull?['sourceId'],
          );
        }
        _history = _items(history['items']);
        _loading = false;
        _notice = null;
      });
      await _loadSkills();
    } catch (_) {
      if (mounted) {
        setState(() {
          _notice = tr(Msg.chatError);
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadSkills() async {
    final engine = _native ? _engine : 'pi-core';
    try {
      final result = await _request('skills', {'engine': engine});
      if (mounted && engine == (_native ? _engine : 'pi-core')) {
        setState(() => _skills = _items(result['items']));
      }
    } catch (_) {
      if (mounted) setState(() => _notice = tr(Msg.chatError));
    }
  }

  void _schedule() {
    _timer?.cancel();
    if (!mounted || !_foreground || !_busy || _sending || _selecting) return;
    final delay = _failures == 0
        ? 500
        : min(15000, 1000 * (1 << min(_failures, 4)));
    _timer = Timer(Duration(milliseconds: delay), () => unawaited(_refresh()));
  }

  Future<void> _refresh() async {
    if (_reading || _chat == null) return;
    _reading = true;
    final epoch = _epoch, id = _id;
    final nearBottom =
        !_scroll.hasClients || _scroll.position.extentAfter < 100;
    try {
      final cursor = _chat?['eventCursor'];
      if (cursor is String) {
        final events = await _request('events', {
          'conversationId': id,
          'cursor': cursor,
        });
        if (!mounted || epoch != _epoch || id != _id) return;
        if (_items(events['items']).isEmpty) {
          setState(() {
            _chat?['eventCursor'] = events['cursor'];
            _failures = 0;
            _notice = null;
          });
          return;
        }
      }
      final chat = await _request('get', {'conversationId': id});
      if (!mounted || epoch != _epoch || id != _id) return;
      setState(() {
        _merge(chat);
        _failures = 0;
        _notice = null;
      });
      if (nearBottom) _toBottom();
    } catch (_) {
      if (mounted && epoch == _epoch && id == _id) {
        setState(() {
          _failures++;
          _notice = tr(Msg.chatReadRecovering);
        });
      }
    } finally {
      _reading = false;
      if (mounted) _schedule();
    }
  }

  void _merge(_Json next) {
    final turns = _items(next['turns']),
        ids = _items(next['turns']).map((t) => t['turnId']).toSet();
    final cursor = _chat?['historyCursor'];
    final restoring = _chat == null;
    _chat = {
      ...next,
      'historyCursor': ?cursor,
      'turns': [..._turns.where((t) => !ids.contains(t['turnId'])), ...turns],
    };
    if (!restoring) {
      _chat?.remove('historyCursor');
      if (cursor != null) {
        _chat?['historyCursor'] = cursor;
      }
    }
  }

  Future<void> _select(_Json item) async {
    final epoch = ++_epoch;
    _selecting = true;
    _timer?.cancel();
    try {
      final chat = await _request('get', {
        'conversationId': item['conversationId'],
      });
      if (!mounted || epoch != _epoch) return;
      final config = _items(chat['turns']).lastOrNull?['config'];
      setState(() {
        _chat = chat;
        _id = _text(chat['conversationId']);
        _workbench = _text(chat['workbenchId']);
        if (config is Map) {
          _partner = _text(config['partnerId']);
          _network = _text(config['networkId']);
          _selectedSkills = Set<String>.from(config['skills'] as List? ?? []);
          _subagents = config['subagentsEnabled'] != false;
          _extensions = Set<String>.from(config['piExtensions'] as List? ?? []);
        }
        _draft.clear();
        _pending = null;
        _notice = null;
        _failures = 0;
      });
      _scaffold.currentState?.closeDrawer();
      _toBottom();
      _schedule();
      unawaited(_loadSkills());
    } catch (_) {
      if (mounted && epoch == _epoch) {
        setState(() => _notice = tr(Msg.chatError));
      }
    } finally {
      if (mounted && epoch == _epoch) {
        _selecting = false;
        _schedule();
      }
    }
  }

  void _new() {
    _selecting = false;
    _epoch++;
    _timer?.cancel();
    setState(() {
      _id = _identity();
      _chat = null;
      _draft.clear();
      _pending = null;
      _notice = null;
    });
  }

  Future<void> _send() async {
    if (_sending ||
        _busy ||
        _readOnly ||
        _workbench.isEmpty ||
        _draft.text.trim().isEmpty) {
      return;
    }
    final epoch = _epoch;
    _pending ??= {
      'conversationId': _id,
      'workbenchId': _workbench,
      'text': _draft.text,
      'partnerId': _partner,
      'networkId': _network,
      'skills': _selectedSkills.toList(),
      'attachmentIds': <String>[],
      'subagentsEnabled': _subagents,
      'piExtensions': _native ? <String>[] : _extensions.toList(),
      'requestId': _identity(),
    };
    setState(() {
      _sending = true;
      _notice = null;
    });
    try {
      final chat = await _request('send', {'input': _pending});
      if (!mounted || epoch != _epoch) return;
      setState(() {
        _merge(chat);
        _draft.clear();
        _pending = null;
        _failures = 0;
      });
      _toBottom();
      unawaited(_historyRefresh());
    } catch (_) {
      if (mounted && epoch == _epoch) {
        setState(() => _notice = tr(Msg.chatError));
      }
    } finally {
      if (mounted && epoch == _epoch) {
        setState(() => _sending = false);
        _schedule();
      }
    }
  }

  Future<void> _stop() async {
    final epoch = _epoch, id = _id;
    try {
      await _request('stop', {'conversationId': id});
      if (!mounted || epoch != _epoch || id != _id) return;
      await _refresh();
    } catch (_) {
      if (mounted && epoch == _epoch && id == _id) {
        setState(() => _notice = tr(Msg.chatError));
      }
    }
  }

  Future<void> _historyRefresh() async {
    final archived = _archived;
    try {
      final value = await _request('list', {'archived': archived});
      if (mounted && archived == _archived) {
        setState(() => _history = _items(value['items']));
      }
    } catch (_) {
      if (mounted) setState(() => _notice = tr(Msg.chatError));
    }
  }

  Future<void> _earlier() async {
    final cursor = _chat?['historyCursor'];
    if (cursor is! String || _historyLoading) return;
    final epoch = _epoch;
    setState(() => _historyLoading = true);
    try {
      final page = await _request('history', {
        'conversationId': _id,
        'cursor': cursor,
      });
      if (!mounted || epoch != _epoch) return;
      setState(() {
        final ids = _turns.map((t) => t['turnId']).toSet();
        _chat = {
          ...?_chat,
          'turns': [
            ..._items(page['items']).where((t) => !ids.contains(t['turnId'])),
            ..._turns,
          ],
        };
        _chat?.remove('historyCursor');
        if (page['nextCursor'] != null) {
          _chat?['historyCursor'] = page['nextCursor'];
        }
      });
    } catch (_) {
      if (mounted && epoch == _epoch) {
        setState(() => _notice = tr(Msg.chatError));
      }
    } finally {
      if (mounted) setState(() => _historyLoading = false);
    }
  }

  Future<void> _rename(_Json item) async {
    var title = _text(item['title']), saving = false;
    String? error;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, update) => PopScope(
          canPop: !saving,
          child: AlertDialog(
            title: Text(tr(Msg.chatRenameTitle)),
            content: TextFormField(
              initialValue: title,
              autofocus: true,
              maxLength: 80,
              enabled: !saving,
              onChanged: (value) => update(() => title = value),
              decoration: InputDecoration(
                labelText: tr(Msg.chatTitleLabel),
                errorText: error,
              ),
            ),
            actions: [
              TextButton(
                onPressed: saving ? null : () => Navigator.pop(dialogContext),
                child: Text(tr(Msg.commonCancel)),
              ),
              FilledButton(
                onPressed:
                    saving || title.trim().isEmpty || title.trim().length > 80
                    ? null
                    : () async {
                        update(() {
                          saving = true;
                          error = null;
                        });
                        try {
                          final result = await _request('rename', {
                            'conversationId': item['conversationId'],
                            'title': title.trim(),
                          });
                          if (!mounted || !dialogContext.mounted) return;
                          if (_id == item['conversationId']) {
                            setState(() => _chat?['title'] = result['title']);
                          }
                          Navigator.pop(dialogContext);
                          unawaited(_historyRefresh());
                        } catch (_) {
                          if (dialogContext.mounted) {
                            update(() {
                              saving = false;
                              error = tr(Msg.chatError);
                            });
                          }
                        }
                      },
                child: Text(tr(Msg.commonSave)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _action(_Json item, String action) async {
    if (action == 'rename') {
      await _rename(item);
      return;
    }
    if (!mounted) return;
    if (action == 'delete') {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(tr(Msg.chatDeleteTitle)),
          content: Text(tr(Msg.chatDeleteHint)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(tr(Msg.commonCancel)),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(tr(Msg.commonDelete)),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    try {
      await _request(action, {'conversationId': item['conversationId']});
      if (!mounted) return;
      if (_id == item['conversationId']) {
        if (action == 'restore') {
          setState(() => _chat?.remove('archivedAt'));
        } else {
          _new();
        }
      }
      await _historyRefresh();
    } catch (_) {
      if (mounted) setState(() => _notice = tr(Msg.chatError));
    }
  }

  void _toBottom() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted && _scroll.hasClients) {
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    }
  });

  Widget _choice(
    String label,
    IconData icon,
    List<_Json> items,
    String key,
    String value,
    ValueChanged<String> change, {
    bool disabled = false,
  }) {
    final selected = items.where((item) => item[key] == value).firstOrNull;
    return PopupMenuButton<String>(
      tooltip: label,
      enabled: !disabled,
      onSelected: change,
      itemBuilder: (_) => items
          .map(
            (item) => PopupMenuItem(
              value: _text(item[key]),
              enabled: key != 'sourceId' || item['status'] == 'READY',
              child: Text(_text(item['name'] ?? item['displayName'])),
            ),
          )
          .toList(),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 18),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                _text(selected?['name'] ?? selected?['displayName']).isEmpty
                    ? label
                    : _text(selected?['name'] ?? selected?['displayName']),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _historyDrawer() => Drawer(
    child: SafeArea(
      child: Column(
        children: [
          ListTile(
            title: Text(tr(Msg.chatTitle)),
            trailing: IconButton(
              tooltip: tr(Msg.chatNewChat),
              icon: const Icon(Icons.add),
              onPressed: _sending
                  ? null
                  : () {
                      _new();
                      Navigator.pop(context);
                    },
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: TextField(
              controller: _search,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: tr(Msg.chatSearch),
                prefixIcon: const Icon(Icons.search),
              ),
            ),
          ),
          SwitchListTile(
            title: Text(tr(Msg.chatArchivedConversations)),
            value: _archived,
            onChanged: (value) {
              setState(() {
                _archived = value;
                _history = [];
              });
              unawaited(_historyRefresh());
            },
          ),
          Expanded(
            child: ListView(
              children: _history
                  .where(
                    (item) => _text(
                      item['title'],
                    ).toLowerCase().contains(_search.text.toLowerCase()),
                  )
                  .map(
                    (item) => ListTile(
                      selected: item['conversationId'] == _id,
                      title: Text(
                        _text(item['title']),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        _text(
                          _workbenches
                              .where(
                                (wb) =>
                                    wb['workbenchId'] == item['workbenchId'],
                              )
                              .firstOrNull?['name'],
                        ),
                      ),
                      onTap: _sending ? null : () => _select(item),
                      trailing: PopupMenuButton<String>(
                        onSelected: (action) => _action(item, action),
                        itemBuilder: (_) => [
                          PopupMenuItem(
                            value: 'rename',
                            child: Text(tr(Msg.chatRename)),
                          ),
                          PopupMenuItem(
                            value: _archived ? 'restore' : 'archive',
                            enabled: _archived || item['canArchive'] == true,
                            child: Text(
                              tr(
                                _archived
                                    ? Msg.commonUnarchive
                                    : Msg.commonArchive,
                              ),
                            ),
                          ),
                          PopupMenuItem(
                            value: 'delete',
                            enabled: _archived || item['canArchive'] != false,
                            child: Text(tr(Msg.commonDelete)),
                          ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
            ),
          ),
        ],
      ),
    ),
  );

  Future<void> _skillPicker() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => SafeArea(
          child: SizedBox(
            height: MediaQuery.sizeOf(context).height * .6,
            child: ListView(
              children: [
                ListTile(title: Text(tr(Msg.chatSkills))),
                if (_skills.isEmpty)
                  ListTile(title: Text(tr(Msg.chatNoSkills))),
                ..._skills.map(
                  (skill) => CheckboxListTile(
                    title: Text(_text(skill['displayName'])),
                    value: _selectedSkills.contains(skill['id']),
                    onChanged: (value) {
                      setState(() {
                        _pending = null;
                        if (value == true) {
                          _selectedSkills.add(_text(skill['id']));
                        } else {
                          _selectedSkills.remove(skill['id']);
                        }
                      });
                      update(() {});
                    },
                  ),
                ),
                if (!_native) ...[
                  SwitchListTile(
                    title: Text(tr(Msg.chatSubagents)),
                    value: _subagents,
                    onChanged: (value) {
                      setState(() {
                        _pending = null;
                        _subagents = value;
                      });
                      update(() {});
                    },
                  ),
                  for (final entry in {
                    'agent-browser': 'Agent Browser',
                    'cc-safety-net': 'CC Safety Net',
                  }.entries)
                    SwitchListTile(
                      title: Text(entry.value),
                      value: _extensions.contains(entry.key),
                      onChanged: (value) {
                        setState(() {
                          _pending = null;
                          if (value) {
                            _extensions.add(entry.key);
                          } else {
                            _extensions.remove(entry.key);
                          }
                        });
                        update(() {});
                      },
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _turn(_Json turn) {
    final config = turn['config'] as Map? ?? {};
    final entries = _items(turn['entries']);
    final output = entries
        .where(
          (entry) => entry['kind'] == 'MARKDOWN' && entry['role'] == 'AGENT',
        )
        .map((entry) => _text(entry['text']))
        .join('\n\n');
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: Container(
              margin: const EdgeInsets.only(left: 24),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: SelectableText(_text(turn['text'])),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            _text(config['partnerName']).isEmpty
                ? 'joi'
                : _text(config['partnerName']),
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 8),
          for (final entry in entries)
            if (entry['kind'] == 'MARKDOWN' && entry['role'] == 'AGENT')
              MessageBody(_text(entry['text']))
            else if (entry['kind'] == 'TOOL_CALL')
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(
                  _text(entry['toolName']),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                children: [SelectableText(_text(entry['text']))],
              ),
          Row(
            children: [
              Expanded(
                child: Text(
                  _turnStatus(turn['status']),
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
              IconButton(
                tooltip: tr(Msg.chatCopy),
                onPressed: output.isEmpty
                    ? null
                    : () async {
                        await Clipboard.setData(ClipboardData(text: output));
                      },
                icon: const Icon(Icons.copy_outlined, size: 18),
              ),
            ],
          ),
          if (turn['errorCode'] != null || turn['failure'] != null)
            Text(
              tr(Msg.chatFailed),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    return Scaffold(
      key: _scaffold,
      appBar: AppBar(
        title: Text(
          _text(_chat?['title']).isEmpty
              ? tr(Msg.chatNewChat)
              : _text(_chat?['title']),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          IconButton(
            tooltip: tr(Msg.chatNewChat),
            onPressed: _sending ? null : _new,
            icon: const Icon(Icons.add_comment_outlined),
          ),
        ],
      ),
      drawer: _historyDrawer(),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_notice != null)
              MaterialBanner(
                content: Text(_notice!),
                actions: [
                  TextButton(
                    onPressed: () => _chat == null ? _load() : _refresh(),
                    child: Text(tr(Msg.onboardingTryAgain)),
                  ),
                ],
              ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _chat == null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          tr(Msg.chatEmptyTitle),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    )
                  : ListView(
                      controller: _scroll,
                      padding: const EdgeInsets.all(16),
                      children: [
                        if (_chat?['historyCursor'] != null)
                          TextButton(
                            onPressed: _historyLoading ? null : _earlier,
                            child: Text(tr(Msg.chatLoadEarlier)),
                          ),
                        ..._turns.map(_turn),
                      ],
                    ),
            ),
            if (_readOnly)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(tr(Msg.chatRestoreFirst)),
              )
            else
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        if (_chat == null)
                          Expanded(
                            child: _choice(
                              tr(Msg.chatWorkbench),
                              Icons.folder_outlined,
                              _workbenches,
                              'workbenchId',
                              _workbench,
                              (v) => setState(() {
                                _workbench = v;
                                _pending = null;
                              }),
                              disabled: _sending,
                            ),
                          ),
                        Expanded(
                          child: _choice(
                            tr(Msg.chatNetwork),
                            Icons.hub_outlined,
                            _networks,
                            'sourceId',
                            _network,
                            (v) => setState(() {
                              _network = v;
                              _pending = null;
                            }),
                            disabled: _native || _sending,
                          ),
                        ),
                        Expanded(
                          child: _choice(
                            tr(Msg.chatPartner),
                            Icons.smart_toy_outlined,
                            [
                              {'partnerId': 'joi-chat', 'displayName': 'joi'},
                              ..._partners,
                            ],
                            'partnerId',
                            _partner,
                            (v) {
                              setState(() {
                                _partner = v;
                                _selectedSkills = {};
                                _pending = null;
                              });
                              unawaited(_loadSkills());
                            },
                            disabled: _sending,
                          ),
                        ),
                        IconButton(
                          tooltip: tr(Msg.chatSkills),
                          onPressed: _sending ? null : _skillPicker,
                          icon: const Icon(Icons.extension_outlined),
                        ),
                      ],
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _draft,
                            enabled: !_sending,
                            minLines: 1,
                            maxLines: 5,
                            maxLength: 64000,
                            onChanged: (_) => setState(() => _pending = null),
                            decoration: InputDecoration(
                              labelText: tr(Msg.chatMessage),
                              hintText: tr(Msg.chatPlaceholder),
                              counterText: '',
                              border: const OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        IconButton.filled(
                          tooltip: tr(_busy ? Msg.chatStop : Msg.chatSend),
                          onPressed: _sending
                              ? null
                              : _busy
                              ? _stop
                              : _workbench.isEmpty ||
                                    (!_native && _network.isEmpty) ||
                                    _draft.text.trim().isEmpty
                              ? null
                              : _send,
                          icon: Icon(
                            _busy
                                ? Icons.stop_rounded
                                : Icons.arrow_upward_rounded,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
