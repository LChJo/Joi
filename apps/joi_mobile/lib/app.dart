import 'package:flutter/material.dart';
import 'i18n.dart';
import 'l10n/app_localizations.dart';

import 'remote_controller.dart';
import 'pairing_scanner.dart';
import 'home_screen.dart';
import 'connection_diagnostics_view.dart';
import 'joi_brand.dart';

class JoiMobileApp extends StatelessWidget {
  const JoiMobileApp({super.key, required this.controller});

  final RemoteController controller;

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    return ListenableBuilder(
      listenable: uiLocale,
      builder: (context, _) => MaterialApp(
        locale: uiLocale.locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
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
            dependOnUiLocale(context);
            final state = controller.state;
            if (state.connection == RemoteConnectionState.unpaired) {
              return _PairingScreen(controller: controller);
            }
            return HomeScreen(controller: controller, state: state);
          },
        ),
      ),
    );
  }
}

class _PairingScreen extends StatelessWidget {
  const _PairingScreen({required this.controller});

  final RemoteController controller;

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    return Scaffold(
      appBar: AppBar(
        actions: [
          const UiLanguageButton(),
          ConnectionDiagnosticsButton(controller: controller),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              const Center(child: JoiBrand(large: true)),
              const SizedBox(height: 12),
              Text(
                tr(Msg.mobileBringTheJoiRunningOnYourComputerToYour),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: const Color(0xff94a79b),
                ),
              ),
              const SizedBox(height: 34),
              if (controller.state.localizedNotice ?? controller.state.notice
                  case final Object notice)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(noticeText(notice), textAlign: TextAlign.center),
                ),
              FilledButton.icon(
                onPressed: () => _scan(context),
                icon: const Icon(Icons.qr_code_scanner_rounded),
                label: Text(tr(Msg.mobileScanAQrCodeToPairWithJoi)),
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
                child: Text(tr(Msg.mobileEnterConnectionCode)),
              ),
              const Spacer(),
              Text(
                tr(Msg.mobilePairMultiplePhonesSecurelyWithTheSameJoi),
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
        title: Text(tr(Msg.mobileEnterConnectionCode)),
        content: TextField(
          controller: input,
          autofocus: true,
          decoration: InputDecoration(
            hintText: tr(Msg.mobilePasteAJoiPairLink),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(tr(Msg.commonCancel)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, input.text),
            child: Text(tr(Msg.homeConnect)),
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
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(tr(Msg.mobileTheQrCodeIsInvalidOrExpired))),
        );
      }
    }
  }
}
