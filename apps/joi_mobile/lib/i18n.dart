import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'i18n_messages.dart';
import 'l10n/app_localizations.dart';

export 'i18n_messages.dart' show Msg;

String resolveUiLocale(String preference, List<Locale> systemLocales) {
  if (uiLanguageNames.containsKey(preference)) return preference;
  final primary = systemLocales.isEmpty
      ? 'en'
      : systemLocales.first.toLanguageTag();
  for (final code in uiLanguageNames.keys) {
    if (code.toLowerCase() == primary.toLowerCase()) return code;
  }
  for (final code in uiLanguageNames.keys) {
    if (code.split('-').first == primary.split('-').first) return code;
  }
  return 'en';
}

class UiLocaleController extends ChangeNotifier with WidgetsBindingObserver {
  String _preference = 'system';
  Directory? _directory;
  Future<void> _writes = Future.value();
  int _revision = 0;
  bool persistenceFailed = false;
  String get preference => _preference;
  String get code => resolveUiLocale(
    _preference,
    WidgetsBinding.instance.platformDispatcher.locales,
  );
  Locale get locale => AppLocalizations.supportedLocales.firstWhere(
    (locale) => locale.toLanguageTag().toLowerCase() == code.toLowerCase(),
  );

  Future<void> initialize(Directory directory) async {
    _directory = directory;
    try {
      final data = jsonDecode(
        await File('${directory.path}/ui-preferences.json').readAsString(),
      );
      final value = data is Map ? data['uiLocale'] : null;
      _preference =
          value is String &&
              (value == 'system' || uiLanguageNames.containsKey(value))
          ? value
          : 'system';
    } on FileSystemException {
      _preference = 'system';
    } on FormatException {
      _preference = 'system';
    }
    WidgetsBinding.instance.addObserver(this);
    notifyListeners();
  }

  Future<void> setPreference(String value) async {
    if (value != 'system' && !uiLanguageNames.containsKey(value)) return;
    final revision = ++_revision;
    _preference = value;
    persistenceFailed = false;
    notifyListeners();
    final directory = _directory;
    if (directory == null) return;
    _writes = _writes.then((_) async {
      try {
        await directory.create(recursive: true);
        final temporary = File('${directory.path}/ui-preferences.json.tmp');
        await temporary.writeAsString(
          jsonEncode({'uiLocale': value}),
          flush: true,
        );
        await temporary.rename('${directory.path}/ui-preferences.json');
      } on FileSystemException {
        if (revision == _revision) {
          persistenceFailed = true;
          notifyListeners();
        }
      }
    });
    await _writes;
  }

  @visibleForTesting
  void setForTest(String value) {
    _preference = value;
    persistenceFailed = false;
    notifyListeners();
  }

  @override
  void didChangeLocales(List<Locale>? locales) {
    if (_preference == 'system') notifyListeners();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

final uiLocale = UiLocaleController();
final _localizedCatalogs = <String, AppLocalizations>{};
AppLocalizations get _messages => _localizedCatalogs.putIfAbsent(
  uiLocale.code,
  () => lookupAppLocalizations(uiLocale.locale),
);
String tr(Msg key, [Map<String, Object> parameters = const {}]) =>
    formatUiMessage(
      _messages,
      key,
      parameters.map(
        (name, value) =>
            MapEntry(name, value is UiNotice ? noticeText(value) : value),
      ),
    );

class UiNotice {
  const UiNotice(this.key, [this.parameters = const {}]);
  final Msg key;
  final Map<String, Object> parameters;
}

Object productNotice(String source) {
  final key = sourceMessageKeys[source];
  return key == null ? source : UiNotice(key);
}

/// Only product-origin notices and fixed catalog labels pass through this adapter.
String noticeText(Object value) {
  if (value is UiNotice) return tr(value.key, value.parameters);
  final text = value.toString();
  final key = sourceMessageKeys[text];
  return key == null ? text : tr(key);
}

String formatUiDate(DateTime value) => DateFormat.yMd(
  uiLocale.code.replaceAll('-', '_'),
).add_Hm().format(value.toLocal());
String formatUiNumber(num value) => NumberFormat.decimalPattern(
  uiLocale.code.replaceAll('-', '_'),
).format(value);

void dependOnUiLocale(BuildContext context) {
  Localizations.maybeLocaleOf(context);
}

class LocalizedView extends StatelessWidget {
  const LocalizedView({super.key, required this.builder});
  final WidgetBuilder builder;
  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    return builder(context);
  }
}

class UiLanguageButton extends StatelessWidget {
  const UiLanguageButton({super.key});
  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    return PopupMenuButton<String>(
      tooltip: tr(Msg.commonLanguage),
      icon: const Icon(Icons.language),
      onSelected: (value) async {
        await uiLocale.setPreference(value);
        if (context.mounted && uiLocale.persistenceFailed) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: LocalizedView(
                builder: (context) => Text(tr(Msg.commonLanguageSaveFailed)),
              ),
            ),
          );
        }
      },
      itemBuilder: (context) => [
        CheckedPopupMenuItem(
          value: 'system',
          checked: uiLocale.preference == 'system',
          child: Text(tr(Msg.commonSystem)),
        ),
        for (final language in uiLanguageNames.entries)
          CheckedPopupMenuItem(
            value: language.key,
            checked: uiLocale.preference == language.key,
            child: Text(language.value),
          ),
      ],
    );
  }
}
